// Shared speech-to-text pipeline (24kHz PCM → resample → VAD → Whisper).
// Used by the Local AI and Claude providers; only one provider is active at a time.
const { sendToRenderer } = require('./gemini');

// ── State ──

let whisperPipeline = null;
let isWhisperLoading = false;
let onTranscript = null;
let isTranscribing = false;
let pendingAudioJob = null;
let transcriptionGeneration = 0;

// VAD state
let isSpeaking = false;
let speechBuffers = [];
let silenceFrameCount = 0;
let speechFrameCount = 0;

// Circular buffer of the last N frames before VAD confirms speech.
// Prepended when speech starts so Whisper sees audio context before the first word
// rather than a cold start mid-utterance (which triggers hallucinations in tiny model).
const PRE_SPEECH_FRAMES = 8;
let preSpeechBuffer = [];

// VAD configuration
const VAD_MODES = {
    NORMAL: { energyThreshold: 0.01, speechFramesRequired: 3, silenceFramesRequired: 30 },
    LOW_BITRATE: { energyThreshold: 0.008, speechFramesRequired: 4, silenceFramesRequired: 35 },
    AGGRESSIVE: { energyThreshold: 0.015, speechFramesRequired: 2, silenceFramesRequired: 20 },
    VERY_AGGRESSIVE: { energyThreshold: 0.02, speechFramesRequired: 2, silenceFramesRequired: 3 },
    // Each VAD frame is ~0.1s. A ~1.0s end-of-utterance silence lets a full
    // sentence accumulate before transcription instead of being chopped into
    // short fragments — Whisper (especially the tiny model) is far more
    // accurate with complete-utterance context.
    BALANCED: { energyThreshold: 0.01, speechFramesRequired: 2, silenceFramesRequired: 10 },
};
let vadConfig = VAD_MODES.BALANCED;

// Audio resampling buffer
let resampleRemainder = Buffer.alloc(0);

// ── Audio Resampling (24kHz → 16kHz) ──

function resample24kTo16k(inputBuffer) {
    // Combine with any leftover samples from previous call
    const combined = Buffer.concat([resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2); // 16-bit = 2 bytes per sample
    // Ratio: 16000/24000 = 2/3, so for every 3 input samples we produce 2 output samples
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        // Map output sample index to input position
        const srcPos = (i * 3) / 2;
        const srcIndex = Math.floor(srcPos);
        const frac = srcPos - srcIndex;

        const s0 = combined.readInt16LE(srcIndex * 2);
        const s1 = srcIndex + 1 < inputSamples ? combined.readInt16LE((srcIndex + 1) * 2) : s0;
        const interpolated = Math.round(s0 + frac * (s1 - s0));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    // Store remainder for next call
    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

    return outputBuffer;
}

// ── VAD (Voice Activity Detection) ──

function calculateRMS(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / samples);
}

function processVAD(pcm16kBuffer) {
    const rms = calculateRMS(pcm16kBuffer);
    const isVoice = rms > vadConfig.energyThreshold;

    if (isVoice) {
        speechFrameCount++;
        silenceFrameCount = 0;

        if (!isSpeaking && speechFrameCount >= vadConfig.speechFramesRequired) {
            isSpeaking = true;
            // preSpeechBuffer already contains recent silence + the confirmation frames
            speechBuffers = preSpeechBuffer.map(b => Buffer.from(b));
            preSpeechBuffer = [];
            console.log('[Transcriber] Speech started (RMS:', rms.toFixed(4), ', pre-speech frames:', speechBuffers.length, ')');
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }

        // Buffer voice frames during the confirmation window too — once confirmed
        // they're already in speechBuffers via the seed above, so only buffer while
        // isSpeaking is still false.
        if (!isSpeaking) {
            preSpeechBuffer.push(Buffer.from(pcm16kBuffer));
            if (preSpeechBuffer.length > PRE_SPEECH_FRAMES) {
                preSpeechBuffer.shift();
            }
        }
    } else {
        // While not speaking, maintain a rolling window of recent audio
        if (!isSpeaking) {
            preSpeechBuffer.push(Buffer.from(pcm16kBuffer));
            if (preSpeechBuffer.length > PRE_SPEECH_FRAMES) {
                preSpeechBuffer.shift();
            }
        }

        silenceFrameCount++;
        speechFrameCount = 0;

        if (isSpeaking && silenceFrameCount >= vadConfig.silenceFramesRequired) {
            isSpeaking = false;
            console.log('[Transcriber] Speech ended, accumulated', speechBuffers.length, 'chunks');
            sendToRenderer('update-status', 'Transcribing...');

            // Trigger transcription with accumulated audio
            const audioData = Buffer.concat(speechBuffers);
            speechBuffers = [];
            queueTranscription(audioData);
            return;
        }
    }

    // Accumulate audio during speech
    if (isSpeaking) {
        speechBuffers.push(Buffer.from(pcm16kBuffer));
    }
}

// ── Whisper Transcription ──

// The right dtype depends on the model. A flat q8 works for the small Xenova
// models, but the large-v3-turbo ONNX build ships separate encoder/decoder
// graphs that must be selected individually:
//   - encoder: fp32. The q8 encoder's quantized kernels (e.g. BiasGelu) crash
//     onnxruntime-node with a SIGTRAP from libmalloc mid-inference. fp32 is
//     HuggingFace's documented config for this model and is stable; at ~1.2GB
//     it's fine on any machine with a few GB of free RAM.
//   - decoder: q8. The q4 variant relies on MatMulNBits and ships as a fragile
//     320MB file that fails to parse if a download is interrupted; standard q8
//     quantization is well-tested and roughly halves the decoder's footprint.
function getDtypeForModel(modelName) {
    if (/whisper-large-v3-turbo/i.test(modelName)) {
        return { encoder_model: 'fp32', decoder_model_merged: 'q8' };
    }
    return 'q8';
}

async function loadWhisperPipeline(modelName) {
    if (whisperPipeline) return whisperPipeline;
    if (isWhisperLoading) return null;

    isWhisperLoading = true;
    console.log('[Transcriber] Loading Whisper model:', modelName);
    sendToRenderer('whisper-downloading', true);
    sendToRenderer('update-status', 'Loading Whisper model (first time may take a while)...');

    try {
        // Dynamic import for ESM module
        const { pipeline, env } = await import('@huggingface/transformers');
        // Cache models outside the asar archive so ONNX runtime can load them
        const { app } = require('electron');
        const path = require('path');
        env.cacheDir = path.join(app.getPath('userData'), 'whisper-models');
        whisperPipeline = await pipeline('automatic-speech-recognition', modelName, {
            device: 'cpu',
            dtype: getDtypeForModel(modelName),
        });
        console.log('[Transcriber] Whisper model loaded successfully');

        // Warm up the ONNX graph with a throwaway inference. The first real
        // inference otherwise pays one-time kernel/graph allocation, making the
        // user's first question feel 2-5x slower than steady state. 1s of
        // silence is enough to compile the encoder/decoder path.
        try {
            const warmStart = Date.now();
            await whisperPipeline(new Float32Array(16000), { sampling_rate: 16000, language: 'en', task: 'transcribe' });
            console.log(`[Transcriber] Warmup completed in ${Date.now() - warmStart}ms`);
        } catch (warmupError) {
            console.warn('[Transcriber] Warmup inference failed (non-fatal):', warmupError.message);
        }

        sendToRenderer('whisper-downloading', false);
        isWhisperLoading = false;
        return whisperPipeline;
    } catch (error) {
        console.error('[Transcriber] Failed to load Whisper model:', error);
        sendToRenderer('whisper-downloading', false);
        sendToRenderer('update-status', 'Failed to load Whisper model: ' + error.message);
        isWhisperLoading = false;
        return null;
    }
}

function pcm16ToFloat32(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    const float32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
        float32[i] = pcm16Buffer.readInt16LE(i * 2) / 32768;
    }
    return float32;
}

async function transcribeAudio(pcm16kBuffer) {
    if (!whisperPipeline) {
        console.error('[Transcriber] Whisper pipeline not loaded');
        return null;
    }

    try {
        const startedAt = Date.now();
        const float32Audio = pcm16ToFloat32(pcm16kBuffer);

        // Whisper expects audio at 16kHz which is what we have
        const result = await whisperPipeline(float32Audio, {
            sampling_rate: 16000,
            language: 'en',
            task: 'transcribe',
        });

        const text = result.text?.trim();
        console.log(`[Transcriber] Completed in ${Date.now() - startedAt}ms:`, text);
        return text;
    } catch (error) {
        console.error('[Transcriber] Transcription error:', error);
        return null;
    }
}

// ── Speech End Handler ──

async function handleSpeechEnd(audioData, generation) {
    if (!onTranscript) return;

    // Minimum audio length check (~0.5 seconds at 16kHz, 16-bit)
    if (audioData.length < 16000) {
        console.log('[Transcriber] Audio too short, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    const transcription = await transcribeAudio(audioData);

    // The session may have been reset while Whisper was running.
    if (generation !== transcriptionGeneration) return;

    if (!transcription || transcription.trim() === '' || transcription.trim().length < 2) {
        console.log('[Transcriber] Empty transcription, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    if (onTranscript) {
        await onTranscript(transcription);
    }
}

async function queueTranscription(audioData) {
    // Whisper inference is expensive. Never run overlapping inference jobs;
    // when speech arrives faster than it can be processed, retain only the
    // newest segment instead of building an increasingly stale backlog.
    if (isTranscribing) {
        pendingAudioJob = { audioData, generation: transcriptionGeneration };
        return;
    }

    isTranscribing = true;
    let job = { audioData, generation: transcriptionGeneration };

    try {
        while (job) {
            pendingAudioJob = null;
            if (job.generation === transcriptionGeneration) {
                await handleSpeechEnd(job.audioData, job.generation);
            }
            job = pendingAudioJob;
        }
    } finally {
        isTranscribing = false;
        const queuedJob = pendingAudioJob;
        pendingAudioJob = null;
        if (queuedJob && queuedJob.generation === transcriptionGeneration) {
            queueTranscription(queuedJob.audioData);
        }
    }
}

// ── Public API ──

async function initWhisper(modelName) {
    return await loadWhisperPipeline(modelName);
}

function setOnTranscript(callback) {
    onTranscript = callback;
}

function processAudio24k(monoChunk24k) {
    // Resample from 24kHz to 16kHz
    const pcm16k = resample24kTo16k(monoChunk24k);
    if (pcm16k.length > 0) {
        processVAD(pcm16k);
    }
}

// Force-transcribe whatever speech has been buffered, even if the VAD has not
// yet seen the trailing end-of-utterance silence. Used by push-to-talk so the
// final words are sent the instant the user stops listening.
function flush() {
    if (speechBuffers.length === 0) {
        isSpeaking = false;
        silenceFrameCount = 0;
        speechFrameCount = 0;
        return false;
    }
    const audioData = Buffer.concat(speechBuffers);
    speechBuffers = [];
    isSpeaking = false;
    silenceFrameCount = 0;
    speechFrameCount = 0;
    queueTranscription(audioData);
    return true;
}

function resetTranscriber() {
    transcriptionGeneration++;
    isSpeaking = false;
    speechBuffers = [];
    preSpeechBuffer = [];
    silenceFrameCount = 0;
    speechFrameCount = 0;
    resampleRemainder = Buffer.alloc(0);
    pendingAudioJob = null;
    onTranscript = null;
    // Note: whisperPipeline is kept loaded to avoid reloading on next session
}

module.exports = {
    initWhisper,
    setOnTranscript,
    processAudio24k,
    flush,
    resetTranscriber,
};
