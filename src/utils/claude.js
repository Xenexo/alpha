const Anthropic = require('@anthropic-ai/sdk');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn, saveScreenAnalysis } = require('./gemini');
const transcriber = require('./transcriber');

// ── State ──

let claudeMode = 'cli'; // 'cli' | 'api'
let anthropicClient = null;
let claudeModel = 'claude-haiku-4-5-20251001';
let claudeConversationHistory = [];
let currentSystemPrompt = null;
let isClaudeActive = false;
let isTranscriptResponseInFlight = false;
let pendingTranscripts = [];
let transcriptDebounceTimer = null;

const TRANSCRIPT_DEBOUNCE_MS = 250;
const RESPONSE_UPDATE_INTERVAL_MS = 50;

// Claude Code CLI state
let cliPath = null;
let cliEnv = null;
let cliSessionId = null; // session_id from SDK / --resume, keeps conversation context
let activeCliProc = null;  // subprocess handle (image path only)
let activeCliAbort = null; // AbortController for in-flight SDK query (text path)

// Lazy-loaded @anthropic-ai/claude-code query function
let _queryFn = null;
async function getQueryFn() {
    if (!_queryFn) {
        const sdk = await import('@anthropic-ai/claude-code');
        _queryFn = sdk.query;
    }
    return _queryFn;
}

const CLI_TIMEOUT_MS = 120000;
const API_MAX_TOKENS = 2048;
const CLAUDE_CONCISE_RESPONSE_PROMPT = `

**CLAUDE REAL-TIME RESPONSE RULES — HIGHEST PRIORITY:**
- Start with the direct answer. Do not add an introduction or restate the question.
- For normal questions, respond in 1-3 short sentences and then stop.
- Add bullets only when the user explicitly asks for steps, options, or a list.
- For ordinary code questions, give the approach in one sentence followed by only the necessary code.
- If asked to demonstrate, share a demo, implement live, or do hands-on coding, ignore the normal length limit. Give: (1) a one-line approach, (2) ordered implementation steps, (3) complete runnable code, and (4) exact commands to run or verify it.
- During demos and hands-on coding, keep commentary minimal and prioritize executable instructions and code.
- Do not add background, examples, caveats, summaries, offers to help, or follow-up questions unless they are required for correctness.
- Never continue after the question has been fully answered.
`;

async function flushPendingTranscripts() {
    transcriptDebounceTimer = null;
    if (!isClaudeActive || isTranscriptResponseInFlight || pendingTranscripts.length === 0) return;

    const transcription = pendingTranscripts.join(' ').trim();
    pendingTranscripts = [];
    if (!transcription) return;

    isTranscriptResponseInFlight = true;
    sendToRenderer('update-status', 'Generating response...');

    try {
        await sendClaudeText(transcription);
    } finally {
        isTranscriptResponseInFlight = false;
        if (isClaudeActive && pendingTranscripts.length > 0) {
            transcriptDebounceTimer = setTimeout(flushPendingTranscripts, TRANSCRIPT_DEBOUNCE_MS);
        }
    }
}

function queueTranscript(transcription) {
    if (!isClaudeActive) return;
    pendingTranscripts.push(transcription);

    // Merge phrases separated by short VAD pauses. If Claude is already
    // responding, flush once it finishes instead of starting concurrently.
    if (isTranscriptResponseInFlight) return;
    if (transcriptDebounceTimer) clearTimeout(transcriptDebounceTimer);
    transcriptDebounceTimer = setTimeout(flushPendingTranscripts, TRANSCRIPT_DEBOUNCE_MS);
}

// ── Claude Code CLI detection ──

function buildAugmentedEnv() {
    // Electron GUI apps on macOS inherit a minimal PATH that misses the
    // common CLI install locations, so add them explicitly.
    const home = os.homedir();
    const extraPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(home, '.claude', 'local'),
        path.join(home, '.local', 'bin'),
    ];
    const sep = process.platform === 'win32' ? ';' : ':';
    return {
        ...process.env,
        PATH: [process.env.PATH || '', ...extraPaths].filter(Boolean).join(sep),
    };
}

function checkCliCandidate(candidate, env) {
    return new Promise(resolve => {
        execFile(candidate, ['--version'], { env, timeout: 5000 }, error => {
            resolve(!error);
        });
    });
}

async function resolveClaudeCli() {
    const env = buildAugmentedEnv();
    const home = os.homedir();

    const absoluteCandidates = [
        path.join(home, '.claude', 'local', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        path.join(home, '.local', 'bin', 'claude'),
    ];

    const candidates = ['claude', ...absoluteCandidates.filter(p => fs.existsSync(p))];

    for (const candidate of candidates) {
        if (await checkCliCandidate(candidate, env)) {
            console.log('[Claude] Found Claude CLI at:', candidate);
            return { path: candidate, env };
        }
    }

    return null;
}

// ── Claude Code CLI invocation ──

function runClaudeCli(prompt, { allowedTools } = {}) {
    return new Promise(resolve => {
        const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', claudeModel];
        // Replace Claude Code's large coding-agent prompt. This app needs a
        // focused assistant prompt, and processing both prompts adds latency.
        if (currentSystemPrompt) {
            args.push('--system-prompt', currentSystemPrompt);
        }
        if (cliSessionId) {
            args.push('--resume', cliSessionId);
        }
        if (allowedTools) {
            args.push('--allowedTools', allowedTools);
        }

        console.log('[Claude] Spawning CLI', cliSessionId ? `(resume ${cliSessionId})` : '(new session)');

        let proc;
        try {
            proc = spawn(cliPath, args, { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            resolve({ success: false, error: 'Failed to start Claude CLI: ' + error.message });
            return;
        }

        activeCliProc = proc;

        let lineBuffer = '';
        let stderrText = '';
        let committedText = ''; // text from completed assistant turns
        let currentDelta = ''; // streaming text of the in-flight turn
        let fullText = '';
        let finalText = '';
        let isFirst = true;
        let settled = false;

        const emit = () => {
            fullText = committedText + (committedText && currentDelta ? '\n' : '') + currentDelta;
            if (fullText) {
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        };

        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (activeCliProc === proc) activeCliProc = null;
            resolve(result);
        };

        const timeout = setTimeout(() => {
            console.error('[Claude] CLI timed out, killing process');
            proc.kill('SIGTERM');
            sendToRenderer('update-status', 'Claude CLI timed out');
            finish({ success: false, error: 'Claude CLI timed out' });
        }, CLI_TIMEOUT_MS);

        const handleEvent = event => {
            if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
                cliSessionId = event.session_id;
            } else if (event.type === 'stream_event') {
                // Token-level streaming from --include-partial-messages
                const delta = event.event?.delta;
                if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
                    currentDelta += delta.text;
                    emit();
                }
            } else if (event.type === 'assistant' && event.message?.content) {
                // Complete assistant message — authoritative text for this turn
                const text = event.message.content
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text)
                    .join('');
                if (text) {
                    committedText = committedText ? committedText + '\n' + text : text;
                }
                currentDelta = '';
                emit();
            } else if (event.type === 'result') {
                if (event.session_id) cliSessionId = event.session_id;
                if (event.is_error || (event.subtype && event.subtype !== 'success')) {
                    const message = event.result || 'Claude CLI error';
                    sendToRenderer('update-status', 'Claude error: ' + message);
                    finish({ success: false, error: message });
                } else {
                    finalText = event.result || fullText;
                    if (finalText && finalText !== fullText) {
                        sendToRenderer(isFirst ? 'new-response' : 'update-response', finalText);
                        isFirst = false;
                    }
                }
            }
        };

        proc.stdout.on('data', data => {
            lineBuffer += data.toString();
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop(); // keep trailing partial line
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    handleEvent(JSON.parse(line));
                } catch (parseError) {
                    // Skip invalid JSON lines
                }
            }
        });

        proc.stderr.on('data', data => {
            stderrText += data.toString();
        });

        proc.on('error', err => {
            console.error('[Claude] CLI spawn error:', err);
            const message = err.code === 'ENOENT' ? 'Claude CLI not found' : 'Claude CLI error: ' + err.message;
            sendToRenderer('update-status', message);
            finish({ success: false, error: message });
        });

        proc.on('close', code => {
            if (settled) return;
            if (code !== 0) {
                console.error('[Claude] CLI exited with code', code, stderrText);
                let message = 'Claude CLI failed';
                if (/login|logged in|authenticate|unauthorized|api key/i.test(stderrText)) {
                    message = 'Claude CLI not logged in — run "claude" in a terminal and sign in';
                } else if (stderrText.trim()) {
                    message = 'Claude CLI error: ' + stderrText.trim().split('\n')[0];
                }
                sendToRenderer('update-status', message);
                finish({ success: false, error: message });
                return;
            }
            const text = finalText || fullText;
            if (!text) {
                finish({ success: false, error: 'Claude CLI returned no response' });
                return;
            }
            sendToRenderer('update-status', 'Listening...');
            finish({ success: true, text });
        });
    });
}

// ── Claude Code SDK (SSE, no subprocess) ──
// Uses the same auth as `claude login`. Eliminates per-request spawn overhead.

async function runClaudeQuery(prompt) {
    const requestStartedAt = Date.now();
    let firstTokenLogged = false;
    let query;
    try {
        query = await getQueryFn();
    } catch (importErr) {
        console.warn('[Claude] SDK import failed, falling back to CLI:', importErr.message);
        return runClaudeCli(prompt);
    }

    const controller = new AbortController();
    activeCliAbort = controller;

    let committed = '';
    let delta = '';
    let fullText = '';
    let isFirst = true;
    let responseUpdateTimer = null;
    let lastResponseUpdateAt = 0;

    const emitResponse = (force = false) => {
        if (!fullText) return;
        const elapsed = Date.now() - lastResponseUpdateAt;

        if (!force && elapsed < RESPONSE_UPDATE_INTERVAL_MS) {
            if (!responseUpdateTimer) {
                responseUpdateTimer = setTimeout(() => {
                    responseUpdateTimer = null;
                    emitResponse(true);
                }, RESPONSE_UPDATE_INTERVAL_MS - elapsed);
            }
            return;
        }

        if (responseUpdateTimer) {
            clearTimeout(responseUpdateTimer);
            responseUpdateTimer = null;
        }
        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
        isFirst = false;
        lastResponseUpdateAt = Date.now();
    };

    try {
        const opts = {
            maxTurns: 1,
            abortController: controller,
            model: claudeModel,
            includePartialMessages: true,
            // Favor immediate answers over extended reasoning in the real-time
            // assistant. Users can still select a more capable model.
            maxThinkingTokens: 0,
            // Plain text answers do not need Claude Code's tools or user MCP
            // servers. Skipping their discovery reduces request startup work.
            allowedTools: [],
            mcpServers: {},
            strictMcpConfig: true,
        };
        // Avoid processing Claude Code's full coding-agent prompt for every
        // conversational request.
        if (currentSystemPrompt) opts.customSystemPrompt = currentSystemPrompt;
        if (cliSessionId) opts.resume = cliSessionId;

        for await (const msg of query({ prompt, options: opts })) {
            if (controller.signal.aborted) break;

            if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
                cliSessionId = msg.session_id;
            } else if (msg.type === 'stream_event') {
                const ev = msg.event;
                if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
                    if (!firstTokenLogged) {
                        firstTokenLogged = true;
                        console.log(`[Claude] First token in ${Date.now() - requestStartedAt}ms`);
                    }
                    delta += ev.delta.text;
                    fullText = committed + (committed && delta ? '\n' : '') + delta;
                    emitResponse();
                }
            } else if (msg.type === 'assistant') {
                if (!firstTokenLogged) {
                    firstTokenLogged = true;
                    console.log(`[Claude] First response in ${Date.now() - requestStartedAt}ms`);
                }
                const text = (msg.message?.content || [])
                    .filter(b => b.type === 'text' && b.text)
                    .map(b => b.text)
                    .join('');
                if (text) committed = committed ? committed + '\n' + text : text;
                delta = '';
                fullText = committed;
                emitResponse(true);
            } else if (msg.type === 'result') {
                if (msg.session_id) cliSessionId = msg.session_id;
                if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
                    const errMsg = msg.result || 'Claude error';
                    sendToRenderer('update-status', 'Claude error: ' + errMsg);
                    return { success: false, error: errMsg };
                }
                const final = msg.result || fullText;
                if (final && final !== fullText) {
                    fullText = final;
                }
                emitResponse(true);
            }
        }
    } catch (err) {
        if (controller.signal.aborted) return { success: false, error: 'Cancelled' };
        console.error('[Claude] SDK query error:', err);
        let message = 'Claude error: ' + err.message;
        if (/login|auth|unauthorized|401|credentials/i.test(err.message)) {
            message = 'Claude not logged in — run "claude" in a terminal and sign in';
        }
        sendToRenderer('update-status', message);
        return { success: false, error: message };
    } finally {
        if (responseUpdateTimer) clearTimeout(responseUpdateTimer);
        if (activeCliAbort === controller) activeCliAbort = null;
    }

    if (!fullText) return { success: false, error: 'Claude returned no response' };
    console.log(`[Claude] Response completed in ${Date.now() - requestStartedAt}ms`);
    sendToRenderer('update-status', 'Listening...');
    return { success: true, text: fullText };
}

// ── Anthropic API streaming ──

async function streamAnthropicMessages(messages) {
    // claude-opus-4-8 rejects temperature/top_p/top_k — never send sampling params
    const stream = anthropicClient.messages.stream({
        model: claudeModel,
        // Keep normal assistant replies bounded. An 8k-token ceiling makes full
        // responses unnecessarily slow and is excessive for this real-time UI.
        max_tokens: API_MAX_TOKENS,
        system: currentSystemPrompt || 'You are a helpful assistant.',
        messages,
    });

    let fullText = '';
    let isFirst = true;

    stream.on('text', delta => {
        fullText += delta;
        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
        isFirst = false;
    });

    await stream.finalMessage();
    return fullText;
}

function anthropicErrorMessage(error) {
    if (error instanceof Anthropic.AuthenticationError) {
        return 'Invalid Anthropic API key';
    }
    if (error instanceof Anthropic.RateLimitError) {
        return 'Anthropic rate limited — retry shortly';
    }
    if (error instanceof Anthropic.APIError) {
        return 'Claude error: ' + error.message;
    }
    return 'Claude error: ' + error.message;
}

// ── Public API ──

async function initializeClaudeSession(mode, { anthropicApiKey, model, whisperModel, profile, customPrompt }) {
    console.log('[Claude] Initializing Claude session:', { mode, model, whisperModel, profile });

    sendToRenderer('session-initializing', true);

    try {
        claudeMode = mode === 'api' ? 'api' : 'cli';
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false) + CLAUDE_CONCISE_RESPONSE_PROMPT;
        claudeConversationHistory = [];
        cliSessionId = null;

        claudeModel = model || 'claude-haiku-4-5-20251001';

        if (claudeMode === 'cli') {
            const cli = await resolveClaudeCli();
            if (!cli) {
                sendToRenderer('session-initializing', false);
                sendToRenderer('update-status', 'Claude CLI not found — install Claude Code or switch to API key mode');
                return false;
            }
            cliPath = cli.path;
            cliEnv = cli.env;

            // Import once during setup instead of adding module-load latency to
            // the first user request. Failure is harmless: runClaudeQuery falls
            // back to the subprocess implementation.
            await getQueryFn().catch(error => {
                console.warn('[Claude] SDK preload failed; CLI fallback will be used:', error.message);
            });
        } else {
            if (!anthropicApiKey || !anthropicApiKey.trim()) {
                sendToRenderer('session-initializing', false);
                sendToRenderer('update-status', 'Anthropic API key required');
                return false;
            }
            anthropicClient = new Anthropic({ apiKey: anthropicApiKey.trim() });
        }

        // Load Whisper for speech-to-text (audio → transcript → Claude)
        const pipeline = await transcriber.initWhisper(whisperModel);
        if (!pipeline) {
            sendToRenderer('session-initializing', false);
            return false;
        }

        transcriber.resetTranscriber();
        transcriber.setOnTranscript(transcription => {
            queueTranscript(transcription);
        });

        initializeNewSession(profile, customPrompt);

        isClaudeActive = true;
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Claude ready - Listening...');

        console.log('[Claude] Session initialized successfully in', claudeMode, 'mode');
        return true;
    } catch (error) {
        console.error('[Claude] Initialization error:', error);
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Claude error: ' + error.message);
        return false;
    }
}

function processClaudeAudio(monoChunk24k) {
    if (!isClaudeActive) return;
    transcriber.processAudio24k(monoChunk24k);
}

async function sendClaudeText(text) {
    if (!isClaudeActive) {
        return { success: false, error: 'No active Claude session' };
    }

    const trimmed = text.trim();
    if (!trimmed) {
        return { success: false, error: 'Empty message' };
    }

    console.log('[Claude] Sending text:', trimmed.substring(0, 100) + '...');

    if (claudeMode === 'cli') {
        // Use the preloaded SDK path so setup is paid during initialization,
        // while partial messages and the Claude login/session are preserved.
        const result = await runClaudeQuery(trimmed);
        if (result.success && result.text) {
            saveConversationTurn(trimmed, result.text);
        }
        return result;
    }

    claudeConversationHistory.push({ role: 'user', content: trimmed });
    if (claudeConversationHistory.length > 20) {
        claudeConversationHistory = claudeConversationHistory.slice(-20);
    }

    try {
        const fullText = await streamAnthropicMessages(claudeConversationHistory);

        if (fullText.trim()) {
            claudeConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(trimmed, fullText);
        }

        console.log('[Claude] Response completed');
        sendToRenderer('update-status', 'Listening...');
        return { success: true };
    } catch (error) {
        console.error('[Claude] API error:', error);
        const message = anthropicErrorMessage(error);
        sendToRenderer('update-status', message);
        return { success: false, error: message };
    }
}

async function sendClaudeImage(base64Data, prompt) {
    if (!isClaudeActive) {
        return { success: false, error: 'No active Claude session' };
    }

    sendToRenderer('update-status', 'Analyzing image...');

    if (claudeMode === 'cli') {
        // The CLI can't take inline images, but it can Read image files
        const tmpPath = path.join(os.tmpdir(), `cd-screen-${Date.now()}.jpg`);
        try {
            fs.writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'));
            const result = await runClaudeCli(`Read and analyze the image at ${tmpPath}. ${prompt}`, {
                allowedTools: 'Read',
            });
            if (result.success && result.text) {
                saveScreenAnalysis(prompt, result.text, 'claude-cli');
                return { success: true, text: result.text, model: 'claude-cli' };
            }
            return result;
        } finally {
            try {
                fs.unlinkSync(tmpPath);
            } catch (cleanupError) {
                // Temp file already gone
            }
        }
    }

    claudeConversationHistory.push({
        role: 'user',
        content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Data } },
            { type: 'text', text: prompt },
        ],
    });
    if (claudeConversationHistory.length > 20) {
        claudeConversationHistory = claudeConversationHistory.slice(-20);
    }

    try {
        const fullText = await streamAnthropicMessages(claudeConversationHistory);

        // Replace the image turn with text-only so base64 blobs don't compound
        // into every subsequent request
        claudeConversationHistory[claudeConversationHistory.length - 1] = { role: 'user', content: prompt };

        if (fullText.trim()) {
            claudeConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveScreenAnalysis(prompt, fullText, claudeModel);
        }

        console.log('[Claude] Image response completed');
        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: claudeModel };
    } catch (error) {
        console.error('[Claude] Image error:', error);
        // Drop the failed image turn from history
        claudeConversationHistory.pop();
        const message = anthropicErrorMessage(error);
        sendToRenderer('update-status', message);
        return { success: false, error: message };
    }
}

function closeClaudeSession() {
    console.log('[Claude] Closing Claude session');
    isClaudeActive = false;
    if (transcriptDebounceTimer) {
        clearTimeout(transcriptDebounceTimer);
        transcriptDebounceTimer = null;
    }
    pendingTranscripts = [];
    isTranscriptResponseInFlight = false;
    if (activeCliAbort) {
        activeCliAbort.abort();
        activeCliAbort = null;
    }
    if (activeCliProc) {
        try {
            activeCliProc.kill('SIGTERM');
        } catch (killError) {
            // Process already exited
        }
        activeCliProc = null;
    }
    transcriber.resetTranscriber();
    claudeConversationHistory = [];
    anthropicClient = null;
    cliSessionId = null;
    currentSystemPrompt = null;
}

function isClaudeSessionActive() {
    return isClaudeActive;
}

module.exports = {
    initializeClaudeSession,
    processClaudeAudio,
    sendClaudeText,
    sendClaudeImage,
    closeClaudeSession,
    isClaudeSessionActive,
};
