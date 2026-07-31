// Tests for the Claude transport: persistent stream-json CLI session as
// primary (one warm process, questions over stdin, interrupt-based
// supersedes), one-shot CLI spawns as the compatibility path, SDK as one-shot
// fallback, failure classification, system-design answer mode, and transcript
// noise filtering. child_process and the Electron-dependent modules are
// stubbed via Module._load so no real process is spawned and no Electron
// import happens.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('module');

// ── Module interception (must be installed before claude.js is required) ──

const rendererEvents = [];
const statusMessages = [];
const savedTurns = [];
const geminiStub = {
    sendToRenderer(channel, data) {
        rendererEvents.push({ channel, data });
        if (channel === 'update-status') statusMessages.push(String(data));
    },
    initializeNewSession() {},
    saveConversationTurn(...args) {
        savedTurns.push(args);
    },
    saveScreenAnalysis() {},
};
let pipelineBusy = false;
const transcriberStub = {
    initWhisper: async () => true,
    setOnTranscript() {},
    processAudio24k() {},
    flush() {
        return false;
    },
    isPipelineBusy() {
        return pipelineBusy;
    },
    resetTranscriber() {},
};
const promptsStub = { getSystemPrompt: () => 'TEST SYSTEM PROMPT' };

class FakeStdin {
    constructor(proc) {
        this.proc = proc;
        this.writes = [];
    }
    write(chunk) {
        this.writes.push(String(chunk));
        for (const line of String(chunk).split('\n')) {
            if (!line.trim()) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            if (msg.type === 'user') {
                const text = (msg.message?.content || [])
                    .filter(b => b.type === 'text' && b.text)
                    .map(b => b.text)
                    .join('');
                this.proc.userMessages.push(text);
                if (this.proc.onUserMessage) this.proc.onUserMessage(text);
            } else if (msg.type === 'control_request') {
                this.proc.controlRequests.push(msg);
                if (this.proc.onControlRequest) this.proc.onControlRequest(msg);
            }
        }
        return true;
    }
    end() {}
}

class FakeProc extends EventEmitter {
    constructor() {
        super();
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.stdin = new FakeStdin(this);
        this.userMessages = []; // parsed text of stream-json user turns
        this.controlRequests = []; // parsed control_request messages
        this.killed = false;
        this.closed = false;
        this.on('close', () => {
            this.closed = true;
        });
    }
    kill() {
        this.killed = true;
        // Mirror a real child process: SIGTERM produces an async 'close'.
        if (!this.closed) {
            this.closed = true;
            setImmediate(() => this.emit('close', null));
        }
    }
}

let spawnQueue = [];
const spawnCalls = [];
const childProcessStub = {
    spawn(cmd, args, opts) {
        const proc = new FakeProc();
        spawnCalls.push({ cmd, args, opts, proc });
        const behavior = spawnQueue.shift();
        if (behavior) setImmediate(() => behavior(proc, args));
        return proc;
    },
    // CLI --version validation: every candidate succeeds instantly.
    execFile(cmd, args, opts, cb) {
        setImmediate(() => cb(null));
    },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'child_process') return childProcessStub;
    if (request === './gemini') return geminiStub;
    if (request === './transcriber') return transcriberStub;
    if (request === './prompts') return promptsStub;
    return originalLoad.call(this, request, parent, isMain);
};

const claude = require(path.join(__dirname, '..', 'src', 'utils', 'claude.js'));
const seam = claude._testing;

// ── Helpers ──

function emitEvents(proc, events) {
    for (const e of events) proc.stdout.emit('data', JSON.stringify(e) + '\n');
}

// One-shot process script: emits a full success stream then exits (the
// pre-persistent protocol, still used by runClaudeCli and its tests).
function scriptSuccess({ sessionId = 'sess-1', text = 'the answer' } = {}) {
    return proc => {
        emitEvents(proc, [
            { type: 'system', subtype: 'init', session_id: sessionId },
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
            { type: 'assistant', message: { content: [{ type: 'text', text }] } },
            { type: 'result', subtype: 'success', result: text, session_id: sessionId },
        ]);
        proc.emit('close', 0);
    };
}

// Scripted persistent-session process: answers each stdin user turn with the
// next queued response and resolves an interrupt control_request with the
// error result the real CLI emits — the process itself stays alive.
// Response shapes: {text} full answer; {text, partialOnly} starts streaming
// and never finishes; {silent} swallows the turn entirely.
function persistentScript(responses, { sessionId = 'sess-1' } = {}) {
    return proc => {
        const respond = () => {
            const r = responses.shift();
            if (!r) return;
            const sid = r.sessionId || sessionId;
            emitEvents(proc, [{ type: 'system', subtype: 'init', session_id: sid }]);
            if (r.silent) return;
            if (r.partialOnly) {
                emitEvents(proc, [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: r.text } } }]);
                return;
            }
            emitEvents(proc, [
                { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: r.text } } },
                { type: 'assistant', message: { content: [{ type: 'text', text: r.text }] } },
                { type: 'result', subtype: 'success', result: r.text, session_id: sid },
            ]);
        };
        proc.onUserMessage = respond;
        proc.onControlRequest = msg => {
            if (msg.request?.subtype !== 'interrupt') return;
            emitEvents(proc, [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sessionId }]);
        };
        // The first user turn is written synchronously at spawn time, before
        // this behavior installs (spawn behaviors run on setImmediate) —
        // replay anything already received.
        for (let i = 0; i < proc.userMessages.length; i++) respond();
    };
}

function waitFor(cond, { timeout = 3000, interval = 10 } = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
            if (cond()) return resolve();
            if (Date.now() - startedAt > timeout) return reject(new Error('waitFor timed out'));
            setTimeout(check, interval);
        };
        check();
    });
}

function resetAll() {
    seam.resetForTests();
    spawnQueue = [];
    spawnCalls.length = 0;
    rendererEvents.length = 0;
    statusMessages.length = 0;
    savedTurns.length = 0;
    pipelineBusy = false;
    seam.setStateForTests({ active: true, transportReady: true, mode: 'cli', model: 'claude-haiku-4-5-20251001' });
}

// ── Prompt behavior guards (static — the live behavior needs a real model) ──

const CDN_TRANSCRIPT =
    "Bane, explain quickly, quickly, how a CDN Works, you know what I some disadvantage is advantage is of having a sitting on. I'm sure I love";

test('interview prompt commits to always-answering and forbids garble meta-commentary', () => {
    const p = seam.CLAUDE_CONCISE_RESPONSE_PROMPT;
    // The silence escape-hatch is gone; the only mention of "reply with nothing"
    // is the prohibition ("never reply with nothing").
    assert.ok(!/nothing rather than guessing/i.test(p), 'the silence escape-hatch must be gone');
    assert.match(p, /never reply with nothing/i);
    assert.match(p, /ALWAYS ANSWER/);
    assert.match(p, /Assuming you're asking/i);
    assert.match(p, /too garbled/i); // present only inside the "never say ..." prohibition
    assert.match(p, /NO META-COMMENTARY/);
    assert.match(p, /Quick Summary/i); // structured answer mode with 1-2 line quick summary
    assert.match(p, /CDN/); // the worked example is included
});

test('conversational prompt no longer tells the model to stay silent on fuzzy speech', () => {
    const p = seam.CLAUDE_CONVERSATIONAL_RESPONSE_PROMPT;
    assert.ok(!/rather than guessing/i.test(p), 'the silence escape-hatch must be gone');
    assert.match(p, /What to say/i);
});

test('the recoverable CDN transcript passes the noise filter (reaches Claude)', () => {
    assert.equal(seam.isMeaningfulTranscript(CDN_TRANSCRIPT), true);
});

// ── Noise filter ──

test('noise filter: conversational lead-ins are suppressed, real questions pass', () => {
    const meaningful = seam.isMeaningfulTranscript;
    for (const noise of ['Okay, so', 'okay so', 'so', 'So.', 'Right, so', 'Alright, so', 'well, um', 'you know', 'Okay, so, um']) {
        assert.equal(meaningful(noise), false, `expected "${noise}" to be filtered`);
    }
    for (const real of ['Why?', 'What is a binary tree', 'So what is a mutex?', 'Okay, so how does TCP work?']) {
        assert.equal(meaningful(real), true, `expected "${real}" to pass`);
    }
    // Existing behavior stays intact
    assert.equal(meaningful('thank you'), false);
    assert.equal(meaningful('thanks for watching'), false);
});

test('noise filter: Devanagari speech survives (bare \\W treated every Hindi char as punctuation)', () => {
    const meaningful = seam.isMeaningfulTranscript;
    for (const real of [
        'मुझे एक सवाल है',
        'क्या आप system design समझा सकते हैं',
        'क्यों', // single interrogative word, no "?" — Hindi output ends with "।"
        'बताइए कि load balancer कैसे काम करता है।',
    ]) {
        assert.equal(meaningful(real), true, `expected "${real}" to pass`);
    }
    for (const noise of ['ठीक है', 'हाँ', 'अच्छा तो', 'तो अच्छा', 'नमस्ते', 'देखने के लिए धन्यवाद', 'सब्सक्राइब करें']) {
        assert.equal(meaningful(noise), false, `expected "${noise}" to be filtered`);
    }
});

// ── Whisper bias prompt ──

test('whisper bias prompt matches the transcription script: Devanagari for hi, Latin for en', () => {
    const hi = seam.whisperContextPromptForProfile('interview', 'hi');
    const en = seam.whisperContextPromptForProfile('interview', 'en');
    assert.match(hi, /[ऀ-ॿ]/, 'the Hindi prompt must be in Devanagari or it drags decoding into English');
    assert.ok(!/[ऀ-ॿ]/.test(en), 'the English prompt must stay Latin-only');
    // Tech jargon stays in Latin in both — Indian interviews are spoken Hinglish.
    for (const term of ['XSS', 'Kubernetes', 'CAP theorem']) {
        assert.ok(hi.includes(term), `expected the Hindi prompt to keep "${term}" in Latin script`);
    }
    // Defaults and non-technical profiles are unchanged.
    assert.equal(seam.whisperContextPromptForProfile('interview'), en);
    const relationshipHindi = seam.whisperContextPromptForProfile('relationship', 'hi');
    assert.match(relationshipHindi, /[ऀ-ॿ]/, 'Hindi relationship calls should bias Whisper toward conversational Hindi');
    assert.match(relationshipHindi, /weekend/, 'Hinglish vocabulary should remain in Latin script');
});

// ── System design detection ──

test('system design detection: design prompts match, concept/behavioral questions do not', () => {
    const design = [
        'Design a URL shortener like TinyURL.',
        'How would you design WhatsApp?',
        "Let's design Instagram for millions of users",
        'Can you design a rate limiter for our API?',
        'Design a notification service that handles a billion events.',
        'How would you scale this to a billion users?',
        'Walk me through the high level design of a news feed.',
        'Now the low level design: design the classes for a parking lot system.',
    ];
    for (const q of design) {
        assert.equal(seam.isSystemDesignQuestion(q), true, `expected design: "${q}"`);
    }
    const notDesign = [
        'What is a mutex?',
        'How does TCP work?',
        'What design patterns do you know?',
        'Tell me about a time you designed a system for your team.',
        'Explain consistent hashing',
        'What is the difference between SQL and NoSQL?',
    ];
    for (const q of notDesign) {
        assert.equal(seam.isSystemDesignQuestion(q), false, `expected NOT design: "${q}"`);
    }
});

test('whisper context prompt covers system-design vocabulary for technical profiles only', () => {
    const p = seam.whisperContextPromptForProfile('interview');
    for (const term of ['consistent hashing', 'CAP theorem', 'sharding', 'idempotency', 'p99 latency', 'fan-out']) {
        assert.ok(p.includes(term), `vocabulary must include "${term}"`);
    }
    assert.equal(seam.whisperContextPromptForProfile('relationship'), '');
});

// ── Direct one-shot CLI invocation (compatibility path) ──

test('CLI streaming success: streams partials, returns text, adopts session id', async () => {
    resetAll();
    spawnQueue.push(scriptSuccess({ sessionId: 'sess-42', text: 'hello world' }));

    const result = await seam.runClaudeCli('what is up');
    assert.equal(result.success, true);
    assert.equal(result.text, 'hello world');
    assert.equal(seam.getStateForTests().cliSessionId, 'sess-42');
    assert.ok(rendererEvents.some(e => e.channel === 'new-response' && e.data.includes('hello world')));
    assert.ok(spawnCalls[0].args.includes('--output-format'));
});

test('CLI auth failure: stderr diagnostic classified into an actionable status', async () => {
    resetAll();
    spawnQueue.push(proc => {
        proc.stderr.emit('data', 'Error: Invalid API key · Please run /login\n');
        proc.emit('close', 1);
    });

    const result = await seam.runClaudeCli('question');
    assert.equal(result.success, false);
    assert.match(result.error, /not logged in/i);
    assert.ok(statusMessages.some(s => /sign in/i.test(s)));
    // A failed run must never adopt a session id
    assert.equal(seam.getStateForTests().cliSessionId, null);
});

test('CLI invalid model: distinct error and status naming the model', async () => {
    resetAll();
    seam.setStateForTests({ model: 'bogus-model' });
    spawnQueue.push(proc => {
        emitEvents(proc, [{ type: 'result', subtype: 'error', is_error: true, result: 'Invalid model name: bogus-model' }]);
        proc.emit('close', 1);
    });

    const result = await seam.runClaudeCli('question');
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid Claude model: bogus-model/);
    assert.ok(statusMessages.some(s => s.includes('bogus-model')));
});

test('CLI timeout: process killed, distinct timeout error', async () => {
    resetAll();
    spawnQueue.push(() => {
        /* never responds */
    });

    const result = await seam.runClaudeCli('question', { timeoutMs: 50 });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Claude CLI timed out');
    assert.equal(spawnCalls[0].proc.killed, true);
});

test('CLI malformed stream: non-JSON stdout on clean exit is reported as malformed', async () => {
    resetAll();
    spawnQueue.push(proc => {
        proc.stdout.emit('data', 'this is not stream-json\n');
        proc.emit('close', 0);
    });

    const result = await seam.runClaudeCli('question');
    assert.equal(result.success, false);
    assert.match(result.error, /malformed/i);
});

test('CLI empty output: clean exit with no events is reported as no response', async () => {
    resetAll();
    spawnQueue.push(proc => proc.emit('close', 0));

    const result = await seam.runClaudeCli('question');
    assert.equal(result.success, false);
    assert.match(result.error, /no response/i);
});

// ── Persistent session transport ──

test('persistent session: consecutive questions reuse one warm process', async () => {
    resetAll();
    spawnQueue.push(persistentScript([{ text: 'answer one' }, { text: 'answer two', sessionId: 'sess-live' }]));

    const r1 = await claude.sendClaudeText('What is a semaphore?');
    const r2 = await claude.sendClaudeText('What is a monitor?');
    assert.equal(r1.success, true);
    assert.equal(r1.text, 'answer one');
    assert.equal(r2.text, 'answer two');
    assert.equal(spawnCalls.length, 1, 'the second question must reuse the warm process');
    assert.ok(spawnCalls[0].args.includes('--input-format'), 'persistent spawn must use stream-json input');
    assert.deepEqual(spawnCalls[0].proc.userMessages, ['What is a semaphore?', 'What is a monitor?']);
    assert.equal(seam.getStateForTests().persistentAlive, true, 'the process must stay alive between turns');
    assert.equal(seam.getStateForTests().cliSessionId, 'sess-live');
    assert.equal(savedTurns.length, 2);
});

test('persistent crash mid-turn falls back to the SDK; the next question respawns the session', async () => {
    resetAll();
    spawnQueue.push(proc => {
        proc.stderr.emit('data', 'boom: unexpected crash\n');
        proc.emit('close', 1);
    });
    seam.setQueryFnForTests(() =>
        (async function* () {
            yield { type: 'assistant', message: { content: [{ type: 'text', text: 'sdk answer' }] } };
            yield { type: 'result', subtype: 'success', result: 'sdk answer', session_id: 'sdk-sess' };
        })()
    );

    const r1 = await claude.sendClaudeText('first question');
    assert.equal(r1.success, true);
    assert.equal(r1.text, 'sdk answer');
    assert.ok(statusMessages.some(s => /retrying via SDK/i.test(s)));

    spawnQueue.push(persistentScript([{ text: 'back on the CLI' }]));
    const r2 = await claude.sendClaudeText('second question');
    assert.equal(r2.text, 'back on the CLI');
    assert.equal(spawnCalls.length, 2, 'the next question must respawn the persistent session');
});

test('CLI that rejects stream-json input permanently falls back to one-shot spawns', async () => {
    resetAll();
    spawnQueue.push(proc => {
        proc.stderr.emit('data', "error: unknown option '--input-format'\n");
        proc.emit('close', 1);
    });
    seam.setQueryFnForTests(() =>
        (async function* () {
            yield { type: 'result', subtype: 'success', result: 'sdk answer', session_id: 'sdk-sess' };
        })()
    );

    await claude.sendClaudeText('first question');
    assert.equal(seam.getStateForTests().persistentDisabled, true, 'a usage error must disable persistent mode');

    spawnQueue.push(scriptSuccess({ text: 'one-shot answer' }));
    const r2 = await claude.sendClaudeText('second question');
    assert.equal(r2.text, 'one-shot answer');
    assert.equal(spawnCalls[1].args[0], '-p');
    assert.equal(spawnCalls[1].args[1], 'second question', 'one-shot mode passes the prompt as argv');
});

// ── sendClaudeText orchestration ──

test('resume failure: retries once without --resume, then succeeds', async () => {
    resetAll();
    seam.setStateForTests({ sessionId: 'stale-session' });
    spawnQueue.push(proc => {
        proc.stderr.emit('data', 'No conversation found with session ID: stale-session\n');
        proc.emit('close', 1);
    });
    spawnQueue.push(persistentScript([{ text: 'fresh answer', sessionId: 'fresh-session' }]));

    const result = await claude.sendClaudeText('what is a mutex?');
    assert.equal(result.success, true);
    assert.equal(result.text, 'fresh answer');
    assert.equal(spawnCalls.length, 2);
    assert.ok(spawnCalls[0].args.includes('--resume'), 'first attempt should resume');
    assert.ok(!spawnCalls[1].args.includes('--resume'), 'retry must drop --resume');
    assert.equal(seam.getStateForTests().cliSessionId, 'fresh-session');
    assert.equal(savedTurns.length, 1);
});

test('SDK fallback: a non-resume CLI failure falls back to the SDK exactly once', async () => {
    resetAll();
    spawnQueue.push(proc => {
        proc.stderr.emit('data', 'boom: unexpected crash\n');
        proc.emit('close', 1);
    });
    const queryCalls = [];
    seam.setQueryFnForTests(({ prompt }) => {
        queryCalls.push(prompt);
        return (async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'sdk-sess' };
            yield { type: 'assistant', message: { content: [{ type: 'text', text: 'sdk answer' }] } };
            yield { type: 'result', subtype: 'success', result: 'sdk answer', session_id: 'sdk-sess' };
        })();
    });

    const result = await claude.sendClaudeText('question two');
    assert.equal(result.success, true);
    assert.equal(result.text, 'sdk answer');
    assert.equal(spawnCalls.length, 1, 'generic CLI failure must not retry the CLI');
    assert.equal(queryCalls.length, 1, 'SDK fallback must run exactly once');
    assert.ok(statusMessages.some(s => /retrying via SDK/i.test(s)));
    assert.equal(savedTurns.length, 1);
});

test('cancelled CLI request does not trigger the SDK fallback', async () => {
    resetAll();
    spawnQueue.push(() => {
        /* stays in flight until aborted */
    });
    const queryCalls = [];
    seam.setQueryFnForTests(() => {
        queryCalls.push(1);
        return (async function* () {})();
    });

    const resultPromise = claude.sendClaudeText('will be cancelled');
    await waitFor(() => spawnCalls.length === 1);
    claude.closeClaudeSession(); // aborts the in-flight request

    const result = await resultPromise;
    assert.equal(result.success, false);
    assert.equal(result.error, 'Cancelled');
    assert.equal(queryCalls.length, 0, 'a cancel must not reach the SDK');
});

// ── System design answer mode ──

test('design question gets the structured framework injected; the clean question is saved', async () => {
    resetAll();
    spawnQueue.push(persistentScript([{ text: 'design answer' }]));

    const result = await claude.sendClaudeText('How would you design WhatsApp?');
    assert.equal(result.success, true);
    const sent = spawnCalls[0].proc.userMessages[0];
    assert.match(sent, /SYSTEM DESIGN QUESTION — STRUCTURED ANSWER MODE/);
    assert.match(sent, /\*\*Trade-offs\*\*/);
    assert.match(sent, /\*\*Capacity\*\*/);
    assert.ok(sent.endsWith('How would you design WhatsApp?'), 'the raw question must close the prompt');
    assert.equal(savedTurns[0][0], 'How would you design WhatsApp?', 'saved history must not contain the injected rules');
});

test('non-design question is sent verbatim', async () => {
    resetAll();
    spawnQueue.push(persistentScript([{ text: 'plain answer' }]));

    await claude.sendClaudeText('What is a deadlock?');
    assert.equal(spawnCalls[0].proc.userMessages[0], 'What is a deadlock?');
});

// ── Dispatch latency ──

test('finalized transcript dispatches immediately even when the pipeline reports busy', async () => {
    resetAll();
    pipelineBusy = true; // must NOT hold the flush (the old 3s MAX_FLUSH_HOLD_MS behavior)
    spawnQueue.push(persistentScript([{ text: 'quick answer' }]));

    const queuedAt = Date.now();
    seam.queueTranscript('What is idempotency?');
    await waitFor(() => spawnCalls.length === 1 && spawnCalls[0].proc.userMessages.length === 1, { timeout: 1000 });
    const dispatchDelay = Date.now() - queuedAt;
    assert.ok(dispatchDelay < 500, `dispatch took ${dispatchDelay}ms — busy-pipeline hold has crept back in`);
    await waitFor(() => rendererEvents.some(e => e.channel === 'response-complete'));
});

test('fragments within the merge debounce are sent as one request', async () => {
    resetAll();
    spawnQueue.push(persistentScript([{ text: 'merged answer' }]));

    seam.queueTranscript('What is');
    await new Promise(r => setTimeout(r, 30));
    seam.queueTranscript('a race condition?');

    await waitFor(() => rendererEvents.some(e => e.channel === 'response-complete'));
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].proc.userMessages, ['What is a race condition?'], 'both fragments must merge into a single request');
});

test('mid-sentence fragment waits for its continuation before dispatch', async () => {
    resetAll();
    spawnQueue.push(persistentScript([{ text: 'merged design answer' }]));

    // No terminal punctuation → the speaker is still building the question.
    seam.queueTranscript('Okay so I want you to design');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(spawnCalls.length, 0, 'an incomplete fragment must not dispatch at the fast debounce');

    seam.queueTranscript('a chat system like WhatsApp?');
    await waitFor(() => rendererEvents.some(e => e.channel === 'response-complete'));
    assert.equal(spawnCalls[0].proc.userMessages.length, 1, 'both fragments must merge into one request');
    assert.match(spawnCalls[0].proc.userMessages[0], /design a chat system like WhatsApp\?$/);
});

test('speech after dispatch interrupts the in-flight answer and resends combined on the warm process', async () => {
    resetAll();
    spawnQueue.push(
        persistentScript([
            { text: 'partial…', partialOnly: true }, // first request streams but never finishes
            { text: 'combined answer', sessionId: 'sess-2' },
        ])
    );

    seam.queueTranscript('What is Kubernetes?');
    await waitFor(() => spawnCalls.length === 1 && spawnCalls[0].proc.userMessages.length === 1);

    seam.queueTranscript('And how does it differ from Docker?');

    await waitFor(() => spawnCalls[0].proc.userMessages.length === 2);
    await waitFor(() => rendererEvents.some(e => e.channel === 'new-response' && e.data.includes('combined answer')));
    const proc = spawnCalls[0].proc;
    assert.equal(spawnCalls.length, 1, 'the supersede must reuse the warm process, not respawn');
    assert.equal(proc.killed, false, 'the persistent process must survive the supersede');
    assert.equal(proc.controlRequests.length, 1, 'the stale turn must be interrupted over stdin');
    assert.equal(proc.controlRequests[0].request.subtype, 'interrupt');
    assert.equal(proc.userMessages[1], 'What is Kubernetes? And how does it differ from Docker?');
    assert.ok(rendererEvents.some(e => e.channel === 'response-superseded'));
});

// ── Transport-ready gating ──

test('transcript heard during Claude warm-up is queued, then answered once ready', async () => {
    resetAll();
    seam.setStateForTests({ transportReady: false });

    seam.queueTranscript('What is a binary tree?');
    // Debounce (100ms) + at least one transport-hold recheck (250ms)
    await new Promise(r => setTimeout(r, 200));
    assert.equal(spawnCalls.length, 0, 'no request may fire while the transport is warming up');
    assert.ok(statusMessages.some(s => /Claude preparing/i.test(s)));
    assert.equal(seam.getStateForTests().pendingCount, 1, 'the transcript must stay queued, not dropped');

    spawnQueue.push(persistentScript([{ text: 'a binary tree is…' }]));
    seam.setStateForTests({ transportReady: true });

    await waitFor(() => rendererEvents.some(e => e.channel === 'response-complete'));
    assert.equal(spawnCalls.length, 1);
    assert.ok(rendererEvents.some(e => e.channel === 'new-transcript' && e.data === 'What is a binary tree?'));
    assert.ok(rendererEvents.some(e => e.channel === 'new-response' && e.data.includes('binary tree')));
    assert.equal(seam.getStateForTests().isTranscriptResponseInFlight, false, 'in-flight flag must clear after the answer');
});

// ── Detailed-answer expansion ──

test('expand before any answer declines with a helpful message', async () => {
    resetAll();
    const result = await claude.expandLastAnswer();
    assert.equal(result.success, false);
    assert.match(result.error, /nothing to expand/i);
});

test('expand re-asks in depth for the last question and preserves it across repeats', async () => {
    resetAll();
    spawnQueue.push(persistentScript([{ text: 'a short 3-line answer' }, { text: 'the detailed version' }, { text: 'even more detail' }]));

    // Answer a short question first so the question is recorded.
    await claude.sendClaudeText('How does TCP work?');

    const r1 = await claude.expandLastAnswer();
    assert.equal(r1.success, true);
    const proc = spawnCalls[0].proc;
    const expandPrompt = proc.userMessages[1];
    assert.match(expandPrompt, /How does TCP work\?/, 'expansion must reference the original question');
    assert.match(expandPrompt, /IGNORE THE SHORT/i, 'expansion must lift the short-answer length limit');

    // A second expansion still targets the ORIGINAL question, not the expand prompt.
    const r2 = await claude.expandLastAnswer();
    assert.equal(r2.success, true);
    assert.match(proc.userMessages[2], /How does TCP work\?/);
    assert.equal(seam.getStateForTests().isTranscriptResponseInFlight, false);
});

test('expanding a design answer uses the full-framework design expansion prompt', async () => {
    resetAll();
    spawnQueue.push(persistentScript([{ text: 'short design answer' }, { text: 'the full design' }]));

    await claude.sendClaudeText('Design a news feed for millions of users.');
    const r = await claude.expandLastAnswer();
    assert.equal(r.success, true);
    const expandPrompt = spawnCalls[0].proc.userMessages[1];
    assert.match(expandPrompt, /SYSTEM DESIGN EXPANSION/);
    assert.match(expandPrompt, /capacity estimation/i);
    assert.match(expandPrompt, /trade-offs/i);
    assert.match(expandPrompt, /Design a news feed for millions of users\./);
});

// ── The user's own speech (mic) as context, never as a question ──

test('mic speech is recorded as context and never dispatched as a question', async () => {
    resetAll();
    seam.recordUserSpeech("I'd use a token bucket in Redis for this.");

    // Nothing was sent to Claude, and nothing is queued to be sent.
    assert.equal(spawnCalls.length, 0);
    assert.equal(seam.getStateForTests().pendingCount, 0);
    assert.equal(seam.getStateForTests().unsentUserSpeechCount, 1);
    // The UI is told, so the user can see their own speech was heard.
    assert.ok(rendererEvents.some(e => e.channel === 'user-transcript' && /token bucket/.test(e.data)));
});

test("the user's speech rides along with the next question, labelled as context only", async () => {
    resetAll();
    spawnQueue.push(persistentScript([{ text: 'shard by user id' }]));

    seam.recordUserSpeech("I'd use a token bucket in Redis.");
    seam.queueTranscript('How would you shard that?');
    await new Promise(resolve => setTimeout(resolve, 250));

    const sent = spawnCalls[0].proc.userMessages[0];
    // Both blocks present, and the roles are unambiguous.
    assert.match(sent, /token bucket in Redis/);
    assert.match(sent, /How would you shard that\?/);
    assert.match(sent, /DO NOT ANSWER OR REPLY TO THIS/);
    assert.match(sent, /ANSWER ONLY THIS/);
    // The context block precedes the question it is context for.
    assert.ok(sent.indexOf('token bucket in Redis') < sent.indexOf('How would you shard that?'));
    // Saved history and the "expand" target are the clean question, not the wrapper.
    assert.equal(savedTurns[0][0], 'How would you shard that?');
});

test('context is consumed once an answer lands, so it is not re-sent every turn', async () => {
    resetAll();
    spawnQueue.push(persistentScript([{ text: 'first' }, { text: 'second' }]));

    seam.recordUserSpeech('I already mentioned Postgres.');
    seam.queueTranscript('Why that database?');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(seam.getStateForTests().unsentUserSpeechCount, 0);

    seam.queueTranscript('And how do you back it up?');
    await new Promise(resolve => setTimeout(resolve, 250));
    const second = spawnCalls[0].proc.userMessages[1];
    assert.doesNotMatch(second, /I already mentioned Postgres/);
    assert.doesNotMatch(second, /DO NOT ANSWER OR REPLY TO THIS/);
});

test('a failed request keeps the context so the resend still carries it', async () => {
    resetAll();
    // The persistent transport produces nothing, so the turn fails.
    spawnQueue.push(persistentScript([{ silent: true }]));

    seam.recordUserSpeech('I said I would use Kafka.');
    seam.queueTranscript('Why a queue there?');
    await new Promise(resolve => setTimeout(resolve, 250));

    // Context survived the failure — it was never answered, so it is still owed.
    assert.equal(seam.getStateForTests().unsentUserSpeechCount, 1);
});

test('mic audio that merely echoes the interviewer is not recorded as the user speaking', async () => {
    resetAll();
    seam.rememberSpeakerSpeech('So tell me how you would design a distributed rate limiter for our API.');

    // Laptop speakers bleeding into the mic: same words, slightly mis-heard.
    seam.recordUserSpeech('so tell me how you would design a distributed rate limiter for our api');
    assert.equal(seam.getStateForTests().unsentUserSpeechCount, 0);

    // A genuine answer on the same topic is still kept — overlap alone is not echo.
    seam.recordUserSpeech('Sure, I would start with a token bucket per API key and keep counters in Redis.');
    assert.equal(seam.getStateForTests().unsentUserSpeechCount, 1);
});

test('short mic fragments are kept — the echo ratio is meaningless on a few words', () => {
    resetAll();
    seam.rememberSpeakerSpeech('okay right yes sure');
    assert.equal(seam.looksLikeEcho('okay right'), false);
});

test('withUserSpeechContext is a no-op when the user has not spoken', () => {
    resetAll();
    assert.equal(seam.withUserSpeechContext('Explain CAP theorem.'), 'Explain CAP theorem.');
});

test('a long stretch of user speech is truncated from the front, keeping the recent tail', () => {
    resetAll();
    seam.recordUserSpeech('EARLIEST ' + 'padding '.repeat(400) + 'MOST RECENT');
    const context = seam.peekUserSpeechContext();
    assert.ok(context.startsWith('…'));
    assert.match(context, /MOST RECENT$/);
    assert.doesNotMatch(context, /EARLIEST/);
});

test('push-to-talk flushes the mic stream tagged as an intentional question', () => {
    resetAll();
    const flushes = [];
    transcriberStub.flush = (source, opts) => {
        flushes.push({ source, opts });
        return true;
    };
    claude.setPushToTalk(true);
    claude.setPushToTalk(false);
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0].source, 'mic');
    // Relabelled, so the transcript is answered instead of filed as context.
    assert.equal(flushes[0].opts.asSource, seam.MIC_ASK_SOURCE);
    assert.notEqual(seam.MIC_ASK_SOURCE, 'mic');
});
