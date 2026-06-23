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
let claudeModel = 'claude-opus-4-8';
let claudeConversationHistory = [];
let currentSystemPrompt = null;
let isClaudeActive = false;

// Claude Code CLI state
let cliPath = null;
let cliEnv = null;
let cliSessionId = null; // for --resume, keeps conversation context across invocations
let activeCliProc = null;

const CLI_TIMEOUT_MS = 120000;

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
        const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
        // --append-system-prompt is per-invocation; --resume does not persist it
        if (currentSystemPrompt) {
            args.push('--append-system-prompt', currentSystemPrompt);
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

// ── Anthropic API streaming ──

async function streamAnthropicMessages(messages) {
    // claude-opus-4-8 rejects temperature/top_p/top_k — never send sampling params
    const stream = anthropicClient.messages.stream({
        model: claudeModel,
        max_tokens: 8192,
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
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
        claudeConversationHistory = [];
        cliSessionId = null;

        if (claudeMode === 'cli') {
            const cli = await resolveClaudeCli();
            if (!cli) {
                sendToRenderer('session-initializing', false);
                sendToRenderer('update-status', 'Claude CLI not found — install Claude Code or switch to API key mode');
                return false;
            }
            cliPath = cli.path;
            cliEnv = cli.env;
        } else {
            if (!anthropicApiKey || !anthropicApiKey.trim()) {
                sendToRenderer('session-initializing', false);
                sendToRenderer('update-status', 'Anthropic API key required');
                return false;
            }
            anthropicClient = new Anthropic({ apiKey: anthropicApiKey.trim() });
            claudeModel = model || 'claude-opus-4-8';
        }

        // Load Whisper for speech-to-text (audio → transcript → Claude)
        const pipeline = await transcriber.initWhisper(whisperModel);
        if (!pipeline) {
            sendToRenderer('session-initializing', false);
            return false;
        }

        transcriber.resetTranscriber();
        transcriber.setOnTranscript(async transcription => {
            if (!isClaudeActive) return;
            sendToRenderer('update-status', 'Generating response...');
            await sendClaudeText(transcription);
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
        const result = await runClaudeCli(trimmed);
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
