const { Ollama } = require('ollama');
const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn } = require('./gemini');
const transcriber = require('./transcriber');

// ── State ──

let ollamaClient = null;
let ollamaModel = null;
let localConversationHistory = [];
let currentSystemPrompt = null;
let isLocalActive = false;
let isAudioMuted = false;
let muteStateBeforePushToTalk = false;

// Speech from the 'mic' source is the user talking, not a question for the
// model. It never triggers a reply — it accumulates here and is attached as
// labelled context to the next question from the other person, so the answer
// continues from what the user already said. Mirrors claude.js; see the longer
// rationale there.
let unsentUserSpeech = [];
const USER_SPEECH_MAX = 12;
const USER_SPEECH_CONTEXT_CHARS = 1200;
// Push-to-talk audio: physically the mic, but deliberately addressed to the
// model, so it is answered instead of recorded as context.
const MIC_ASK_SOURCE = 'mic-ask';

function recordUserSpeech(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    unsentUserSpeech.push(trimmed);
    if (unsentUserSpeech.length > USER_SPEECH_MAX) {
        unsentUserSpeech = unsentUserSpeech.slice(-USER_SPEECH_MAX);
    }
    console.log('[LocalAI] Recorded your speech as context (not answering):', trimmed.substring(0, 80));
    sendToRenderer('user-transcript', trimmed);
}

// Consumed as the question is built: Ollama keeps localConversationHistory, so
// the block only needs to be stated once.
function takeUserSpeechContext() {
    if (unsentUserSpeech.length === 0) return '';
    const speech = unsentUserSpeech.join(' ').replace(/\s+/g, ' ').trim();
    unsentUserSpeech = [];
    if (!speech) return '';
    return speech.length > USER_SPEECH_CONTEXT_CHARS ? '…' + speech.slice(-USER_SPEECH_CONTEXT_CHARS) : speech;
}

// ── Ollama Chat ──

async function sendToOllama(transcription) {
    if (!ollamaClient || !ollamaModel) {
        console.error('[LocalAI] Ollama not configured');
        return;
    }

    console.log('[LocalAI] Sending to Ollama:', transcription.substring(0, 100) + '...');

    // Attach whatever the user said out loud since the last turn, labelled so
    // the model answers only the incoming question but continues from where the
    // user left off instead of repeating them.
    const userSpeech = takeUserSpeechContext();
    const content = userSpeech
        ? `[WHAT I ALREADY SAID OUT LOUD — CONTEXT ONLY, DO NOT ANSWER OR REPLY TO THIS]\n"${userSpeech}"\n\n` +
          `[THE OTHER PERSON JUST ASKED — ANSWER ONLY THIS]\n${transcription.trim()}`
        : transcription.trim();

    localConversationHistory.push({
        role: 'user',
        content,
    });

    // Keep history manageable
    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    try {
        const messages = [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...localConversationHistory];

        const response = await ollamaClient.chat({
            model: ollamaModel,
            messages,
            stream: true,
        });

        let fullText = '';
        let isFirst = true;

        for await (const part of response) {
            const token = part.message?.content || '';
            if (token) {
                fullText += token;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        if (fullText.trim()) {
            localConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });

            saveConversationTurn(transcription, fullText);
        }

        console.log('[LocalAI] Ollama response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[LocalAI] Ollama error:', error);
        sendToRenderer('update-status', 'Ollama error: ' + error.message);
    }
}

// ── Public API ──

async function initializeLocalSession(ollamaHost, model, whisperModel, profile, customPrompt) {
    console.log('[LocalAI] Initializing local session:', { ollamaHost, model, whisperModel, profile });

    sendToRenderer('session-initializing', true);

    try {
        // Setup system prompt
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);

        // Initialize Ollama client
        ollamaClient = new Ollama({ host: ollamaHost });
        ollamaModel = model;

        // Test Ollama connection
        try {
            await ollamaClient.list();
            console.log('[LocalAI] Ollama connection verified');
        } catch (error) {
            console.error('[LocalAI] Cannot connect to Ollama at', ollamaHost, ':', error.message);
            sendToRenderer('session-initializing', false);
            sendToRenderer('update-status', 'Cannot connect to Ollama at ' + ollamaHost);
            return false;
        }

        // Load Whisper model
        const pipeline = await transcriber.initWhisper(whisperModel);
        if (!pipeline) {
            sendToRenderer('session-initializing', false);
            return false;
        }

        // Reset transcriber state and route transcripts to Ollama
        transcriber.resetTranscriber();
        transcriber.setOnTranscript(async (transcription, { source } = {}) => {
            if (!isLocalActive) return;
            // The user's own voice is context, not a question — it rides along
            // with the next question instead of triggering its own answer.
            // Push-to-talk audio arrives tagged MIC_ASK_SOURCE and is answered.
            if (source === 'mic') {
                recordUserSpeech(transcription);
                return;
            }
            sendToRenderer('update-status', 'Generating response...');
            await sendToOllama(transcription);
        });

        localConversationHistory = [];
        unsentUserSpeech = [];

        // Initialize conversation session
        initializeNewSession(profile, customPrompt);

        isLocalActive = true;
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Local AI ready - Listening...');

        console.log('[LocalAI] Session initialized successfully');
        return true;
    } catch (error) {
        console.error('[LocalAI] Initialization error:', error);
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Local AI error: ' + error.message);
        return false;
    }
}

// source: 'speaker' (system audio / the other person) or 'mic' (the user).
function processLocalAudio(monoChunk24k, source = 'speaker') {
    if (!isLocalActive) return;
    if (isAudioMuted) return; // listening paused — drop the frame, keep capture alive
    transcriber.processAudio24k(monoChunk24k, source);
}

// Push-to-talk: open the mic gate while listening, then on release
// force-transcribe the buffered speech and restore the prior mute state.
function setPushToTalk(active) {
    if (!isLocalActive) return false;
    if (active) {
        muteStateBeforePushToTalk = isAudioMuted;
        isAudioMuted = false;
        sendToRenderer('update-status', '🎤 Listening — speak your question, then press the key again');
    } else {
        // Drains the mic buffer but labels the result as an intentional
        // question, so it is answered rather than filed as context.
        const hadSpeech = transcriber.flush('mic', { asSource: MIC_ASK_SOURCE });
        isAudioMuted = muteStateBeforePushToTalk;
        sendToRenderer('audio-muted-toggled', isAudioMuted);
        sendToRenderer('update-status', hadSpeech ? 'Transcribing your question...' : 'No speech detected — speak louder or closer to the mic');
    }
    return true;
}

function closeLocalSession() {
    console.log('[LocalAI] Closing local session');
    isLocalActive = false;
    isAudioMuted = false;
    transcriber.resetTranscriber();
    localConversationHistory = [];
    unsentUserSpeech = [];
    ollamaClient = null;
    ollamaModel = null;
    currentSystemPrompt = null;
}

function isLocalSessionActive() {
    return isLocalActive;
}

// ── Send text directly to Ollama (for manual text input) ──

async function sendLocalText(text) {
    if (!isLocalActive || !ollamaClient) {
        return { success: false, error: 'No active local session' };
    }

    try {
        await sendToOllama(text);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function sendLocalImage(base64Data, prompt) {
    if (!isLocalActive || !ollamaClient) {
        return { success: false, error: 'No active local session' };
    }

    try {
        console.log('[LocalAI] Sending image to Ollama');
        sendToRenderer('update-status', 'Analyzing image...');

        const userMessage = {
            role: 'user',
            content: prompt,
            images: [base64Data],
        };

        // Store text-only version in history
        localConversationHistory.push({ role: 'user', content: prompt });

        if (localConversationHistory.length > 20) {
            localConversationHistory = localConversationHistory.slice(-20);
        }

        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...localConversationHistory.slice(0, -1),
            userMessage,
        ];

        const response = await ollamaClient.chat({
            model: ollamaModel,
            messages,
            stream: true,
        });

        let fullText = '';
        let isFirst = true;

        for await (const part of response) {
            const token = part.message?.content || '';
            if (token) {
                fullText += token;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        if (fullText.trim()) {
            localConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(prompt, fullText);
        }

        console.log('[LocalAI] Image response completed');
        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: ollamaModel };
    } catch (error) {
        console.error('[LocalAI] Image error:', error);
        sendToRenderer('update-status', 'Ollama error: ' + error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeLocalSession,
    processLocalAudio,
    setPushToTalk,
    closeLocalSession,
    isLocalSessionActive,
    sendLocalText,
    sendLocalImage,
};
