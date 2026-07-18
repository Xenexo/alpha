// Tests for the Claude transport: direct CLI as primary, SDK as one-shot
// fallback, failure classification, and transcript noise filtering.
// child_process and the Electron-dependent modules are stubbed via
// Module._load so no real process is spawned and no Electron import happens.
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

class FakeProc extends EventEmitter {
    constructor() {
        super();
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.killed = false;
    }
    kill() {
        this.killed = true;
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
    assert.match(p, /3 to 5 lines/i); // default is a short paragraph; details are on-demand
    assert.match(p, /CDN/); // the worked example is included
});

test('conversational prompt no longer tells the model to stay silent on fuzzy speech', () => {
    const p = seam.CLAUDE_CONVERSATIONAL_RESPONSE_PROMPT;
    assert.ok(!/rather than guessing/i.test(p), 'the silence escape-hatch must be gone');
    assert.match(p, /never reply with nothing/i);
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

// ── Direct CLI invocation ──

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

// ── sendClaudeText orchestration ──

test('resume failure: retries once without --resume, then succeeds', async () => {
    resetAll();
    seam.setStateForTests({ sessionId: 'stale-session' });
    spawnQueue.push(proc => {
        proc.stderr.emit('data', 'No conversation found with session ID: stale-session\n');
        proc.emit('close', 1);
    });
    spawnQueue.push(scriptSuccess({ sessionId: 'fresh-session', text: 'fresh answer' }));

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

// ── Dispatch latency ──

test('finalized transcript dispatches immediately even when the pipeline reports busy', async () => {
    resetAll();
    pipelineBusy = true; // must NOT hold the flush (the old 3s MAX_FLUSH_HOLD_MS behavior)
    spawnQueue.push(scriptSuccess({ text: 'quick answer' }));

    const queuedAt = Date.now();
    seam.queueTranscript('What is idempotency?');
    await waitFor(() => spawnCalls.length === 1, { timeout: 1000 });
    const dispatchDelay = Date.now() - queuedAt;
    assert.ok(dispatchDelay < 500, `dispatch took ${dispatchDelay}ms — busy-pipeline hold has crept back in`);
    await waitFor(() => rendererEvents.some(e => e.channel === 'response-complete'));
});

test('fragments within the merge debounce are sent as one request', async () => {
    resetAll();
    spawnQueue.push(scriptSuccess({ text: 'merged answer' }));

    seam.queueTranscript('What is');
    await new Promise(r => setTimeout(r, 30));
    seam.queueTranscript('a race condition?');

    await waitFor(() => rendererEvents.some(e => e.channel === 'response-complete'));
    assert.equal(spawnCalls.length, 1, 'both fragments must merge into a single request');
    assert.equal(spawnCalls[0].args[1], 'What is a race condition?');
});

test('speech after dispatch supersedes the in-flight answer with the merged transcript', async () => {
    resetAll();
    spawnQueue.push(proc => {
        // First request starts streaming but never finishes — it will be superseded
        emitEvents(proc, [
            { type: 'system', subtype: 'init', session_id: 'stale' },
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial…' } } },
        ]);
    });

    seam.queueTranscript('What is Kubernetes');
    await waitFor(() => spawnCalls.length === 1);

    spawnQueue.push(scriptSuccess({ text: 'combined answer' }));
    seam.queueTranscript('and how does it differ from Docker?');

    // The cancelled first request also emits response-complete (the renderer
    // only uses it to stop the streaming indicator), so wait for the resend.
    await waitFor(() => spawnCalls.length === 2);
    await waitFor(() => rendererEvents.some(e => e.channel === 'new-response' && e.data.includes('combined answer')));
    assert.equal(spawnCalls[0].proc.killed, true, 'the stale request must be cancelled');
    assert.equal(spawnCalls[1].args[1], 'What is Kubernetes and how does it differ from Docker?');
    assert.ok(rendererEvents.some(e => e.channel === 'response-superseded'));
    assert.ok(rendererEvents.some(e => e.channel === 'new-response' && e.data.includes('combined answer')));
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

    spawnQueue.push(scriptSuccess({ text: 'a binary tree is…' }));
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
    // Answer a short question first so the question is recorded.
    spawnQueue.push(scriptSuccess({ text: 'a short 3-line answer' }));
    await claude.sendClaudeText('How does TCP work?');

    // First expansion.
    spawnQueue.push(scriptSuccess({ text: 'the detailed version' }));
    const r1 = await claude.expandLastAnswer();
    assert.equal(r1.success, true);
    const expandPrompt = spawnCalls[1].args[1]; // ['-p', <prompt>, ...]
    assert.match(expandPrompt, /How does TCP work\?/, 'expansion must reference the original question');
    assert.match(expandPrompt, /IGNORE THE SHORT/i, 'expansion must lift the short-answer length limit');

    // A second expansion still targets the ORIGINAL question, not the expand prompt.
    spawnQueue.push(scriptSuccess({ text: 'even more detail' }));
    const r2 = await claude.expandLastAnswer();
    assert.equal(r2.success, true);
    assert.match(spawnCalls[2].args[1], /How does TCP work\?/);
    assert.equal(seam.getStateForTests().isTranscriptResponseInFlight, false);
});
