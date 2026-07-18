// Shared speech-to-text pipeline (24kHz PCM → resample → VAD → Whisper).
// Used by the Local AI and Claude providers; only one provider is active at a time.
const { sendToRenderer } = require('./gemini');
const whisperWindow = require('./whisperWindow');
const whisperkitSidecar = require('./whisperkitSidecar');
const storage = require('../storage');

// ── State ──

let whisperPipeline = null; // CPU-backend pipeline (only set when backend==='cpu')
let backend = null; // 'ane' | 'webgpu' | 'cpu' — null until a model is loaded
let loadedModelName = null; // for error messages and WebGPU worker recovery
let whisperLanguage = 'en'; // 'en' | 'hi' — from the whisperLanguage preference, read at init
let whisperContextPrompt = ''; // domain vocabulary to bias decoding (ANE backend), from initWhisper
let isWhisperLoading = false;
let onTranscript = null;
let isTranscribing = false;
// FIFO of audio segments awaiting transcription. Split segments of one long
// utterance are all parts of the same question, so they must queue rather
// than replace each other; the cap only sheds load when inference falls
// hopelessly behind.
let pendingAudioJobs = [];
const MAX_PENDING_AUDIO_JOBS = 4;
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

// Streaming partial transcription. While the user is still speaking, transcribe
// the audio accumulated so far every ~1.5s and emit it as an interim result so
// the UI can show the words live instead of waiting for the end-of-utterance
// silence plus a whole-utterance inference pass. Each frame is ~0.1s.
const INTERIM_INTERVAL_FRAMES = 15;
let lastInterimFrameCount = 0;

// Continuous speech with no VAD-length pause (a video, a monologue) would
// otherwise accumulate without bound — inference time grows with audio length,
// so interims were observed taking 20s+ on ~50s buffers and the final answer
// couldn't even start until the speaker stopped. Split the utterance into
// bounded segments instead: prefer splitting at a sub-threshold frame (a
// micro-pause) once past the soft cap, force a split at the hard cap. Whisper
// quality also degrades past ~30s, so the cap helps accuracy too.
const SOFT_SPLIT_FRAMES = 120; // ~12s: split at the next quiet frame
const HARD_SPLIT_FRAMES = 180; // ~18s: split unconditionally
// Carry a little trailing audio into the next segment so it doesn't start
// cold mid-word (hallucination risk, same reason as preSpeechBuffer).
const SPLIT_OVERLAP_FRAMES = 5;
// Interims are disposable live captions — transcribing the whole buffer makes
// each one slower than the last for no benefit. Only the recent tail matters.
const INTERIM_MAX_FRAMES = 100; // ~10s

// VAD configuration
const VAD_MODES = {
    NORMAL: { energyThreshold: 0.01, speechFramesRequired: 3, silenceFramesRequired: 30 },
    LOW_BITRATE: { energyThreshold: 0.008, speechFramesRequired: 4, silenceFramesRequired: 35 },
    AGGRESSIVE: { energyThreshold: 0.015, speechFramesRequired: 2, silenceFramesRequired: 20 },
    VERY_AGGRESSIVE: { energyThreshold: 0.02, speechFramesRequired: 2, silenceFramesRequired: 3 },
    // Each VAD frame is ~0.1s. A ~0.5s end-of-utterance silence balances
    // dispatch latency against fragmentation: short enough that an answer
    // starts promptly after a natural pause, long enough that ordinary
    // mid-sentence breaths don't chop the question. A question split across a
    // longer pause still merges downstream (100ms flush debounce), and if an
    // answer already started, the supersede path cancels and resends the
    // combined transcript — so a too-early turn-end costs little.
    BALANCED: { energyThreshold: 0.007, speechFramesRequired: 2, silenceFramesRequired: 5 },
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
            // Don't fire the first interim until a full interval of new speech.
            lastInterimFrameCount = speechBuffers.length;
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

        // Bound the utterance: split long continuous speech into segments so
        // transcription (and the answer) starts while the speaker is still
        // going, instead of one giant slow inference at the very end.
        if (speechBuffers.length >= HARD_SPLIT_FRAMES || (speechBuffers.length >= SOFT_SPLIT_FRAMES && !isVoice)) {
            console.log('[Transcriber] Long utterance — splitting segment at', speechBuffers.length, 'chunks');
            const audioData = Buffer.concat(speechBuffers);
            const overlap = speechBuffers.slice(-SPLIT_OVERLAP_FRAMES);
            speechBuffers = overlap.map(b => Buffer.from(b));
            lastInterimFrameCount = speechBuffers.length;
            queueTranscription(audioData);
            return;
        }

        // Emit a live partial transcript roughly every INTERIM_INTERVAL_FRAMES.
        // runInterim self-throttles if the pipeline is still busy, so advancing
        // the counter here (even when an interim is skipped) just means the next
        // attempt happens one interval later — never a backlog of interim jobs.
        if (speechBuffers.length - lastInterimFrameCount >= INTERIM_INTERVAL_FRAMES) {
            lastInterimFrameCount = speechBuffers.length;
            runInterim();
        }
    }
}

// Transcribe the speech buffered so far and emit it as an interim result.
// Fire-and-forget: shares the single `isTranscribing` pipeline lock with final
// transcription so the two never run overlapping inference, and skips entirely
// when the pipeline is busy (interim results are disposable). A final segment
// queued while this runs is drained in the finally, exactly as queueTranscription does.
async function runInterim() {
    if (isTranscribing || !isSpeaking || speechBuffers.length === 0) return;

    isTranscribing = true;
    const generation = transcriptionGeneration;
    const snapshot = Buffer.concat(speechBuffers.slice(-INTERIM_MAX_FRAMES));

    try {
        const text = await transcribeAudio(snapshot);
        // Drop if the session reset, speech already ended (the final pass will
        // supersede it), or there's nothing usable.
        if (generation === transcriptionGeneration && isSpeaking && text && text.trim().length >= 2) {
            sendToRenderer('interim-transcript', text.trim());
        }
    } finally {
        isTranscribing = false;
        drainTranscriptionQueue();
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

// Sentinel returned to callers that only check truthiness for "loaded".
// On ANE/WebGPU the pipeline lives outside this process (sidecar / hidden
// window), so there is no in-process object to return — `true` signals
// success without exposing the remote handle.
function loadedHandle() {
    return backend === 'cpu' ? whisperPipeline : backend ? true : null;
}

async function loadWhisperPipeline(modelName) {
    if (backend) {
        // The pipeline outlives sessions, but the ANE sidecar's language and
        // vocabulary prompt are fixed at server start — reconcile them for the
        // new session (no-op when unchanged, quick restart when they differ).
        if (backend === 'ane' && whisperkitSidecar.isAvailable()) {
            try {
                await whisperkitSidecar.loadModel(modelName, whisperLanguage, whisperContextPrompt);
            } catch (error) {
                console.warn('[Transcriber] ANE sidecar reconcile failed (keeping existing pipeline):', error.message);
            }
        }
        return loadedHandle();
    }
    if (isWhisperLoading) return null;

    isWhisperLoading = true;
    console.log('[Transcriber] Loading Whisper model:', modelName);
    sendToRenderer('whisper-downloading', true);
    sendToRenderer('update-status', 'Loading Whisper model (first time may take a while)...');

    // Backend preference: ANE (WhisperKit sidecar, Apple Silicon + brew-installed
    // CLI only) > WebGPU (hidden window on the Apple GPU) > in-process CPU.
    // Each tier falls through to the next on unavailability or load failure.
    try {
        if (whisperkitSidecar.isAvailable()) {
            console.log('[Transcriber] Loading Whisper on the Neural Engine (WhisperKit):', modelName);
            const aneStartedAt = Date.now();
            await whisperkitSidecar.loadModel(modelName, whisperLanguage, whisperContextPrompt);
            backend = 'ane';
            loadedModelName = modelName;
            console.log(`[Transcriber] Whisper model loaded on the Neural Engine in ${Date.now() - aneStartedAt}ms`);
            sendToRenderer('whisper-downloading', false);
            isWhisperLoading = false;
            return loadedHandle();
        }
        console.log('[Transcriber] WhisperKit sidecar unavailable — trying WebGPU');
    } catch (error) {
        console.error(`[Transcriber] WhisperKit load failed for "${modelName}" — falling back to WebGPU:`, error);
    }

    try {
        if (await whisperWindow.isWebGPUAvailable()) {
            console.log('[Transcriber] Loading Whisper on WebGPU:', modelName);
            const webgpuStartedAt = Date.now();
            await whisperWindow.loadModel(modelName);
            backend = 'webgpu';
            loadedModelName = modelName;
            console.log(`[Transcriber] Whisper model loaded on WebGPU in ${Date.now() - webgpuStartedAt}ms`);
            sendToRenderer('whisper-downloading', false);
            isWhisperLoading = false;
            return loadedHandle();
        }
        console.warn('[Transcriber] WebGPU unavailable — falling back to CPU');
    } catch (error) {
        console.error(`[Transcriber] WebGPU load failed for "${modelName}" — falling back to CPU:`, error);
    }

    try {
        // Dynamic import for ESM module
        const { pipeline, env } = await import('@huggingface/transformers');
        // Cache models outside the asar archive so ONNX runtime can load them
        const { app } = require('electron');
        const path = require('path');
        env.cacheDir = path.join(app.getPath('userData'), 'whisper-models');
        const cpuStartedAt = Date.now();
        whisperPipeline = await pipeline('automatic-speech-recognition', modelName, {
            device: 'cpu',
            dtype: getDtypeForModel(modelName),
        });
        console.log(`[Transcriber] Whisper model loaded on CPU in ${Date.now() - cpuStartedAt}ms`);

        // Warm up the ONNX graph with a throwaway inference. The first real
        // inference otherwise pays one-time kernel/graph allocation, making the
        // user's first question feel 2-5x slower than steady state. 1s of
        // silence is enough to compile the encoder/decoder path.
        try {
            const warmStart = Date.now();
            await whisperPipeline(new Float32Array(16000), { sampling_rate: 16000, language: whisperLanguage, task: 'transcribe' });
            console.log(`[Transcriber] Warmup completed in ${Date.now() - warmStart}ms`);
        } catch (warmupError) {
            console.warn('[Transcriber] Warmup inference failed (non-fatal):', warmupError.message);
        }

        backend = 'cpu';
        loadedModelName = modelName;
        sendToRenderer('whisper-downloading', false);
        isWhisperLoading = false;
        return whisperPipeline;
    } catch (error) {
        console.error(`[Transcriber] Failed to load Whisper model "${modelName}":`, error);
        sendToRenderer('whisper-downloading', false);
        sendToRenderer('update-status', `Failed to load Whisper model "${modelName}": ` + error.message);
        isWhisperLoading = false;
        return null;
    }
}

// Whisper's decoder sometimes falls into a repetition loop and emits the same
// word or phrase over and over ("this is this is this is…"), especially on
// short, partial, or silence-padded audio. `no_repeat_ngram_size` in the
// generation config prevents most of it; this collapses any consecutive
// repeats that still slip through. Works from the longest repeated phrase down
// to single words so "this is this is" collapses to "this is" before a stray
// single-word pass could mangle it.
function collapseRepetitions(text) {
    if (!text) return text;
    let words = text.trim().split(/\s+/);
    for (let n = 6; n >= 1; n--) {
        const out = [];
        let i = 0;
        while (i < words.length) {
            const gram = words.slice(i, i + n);
            if (gram.length < n) {
                out.push(words[i]);
                i++;
                continue;
            }
            const key = gram.join(' ').toLowerCase();
            let reps = 1;
            let j = i + n;
            while (
                j + n <= words.length &&
                words
                    .slice(j, j + n)
                    .join(' ')
                    .toLowerCase() === key
            ) {
                reps++;
                j += n;
            }
            // A single word must repeat 3+ times to count as a loop (genuine
            // doubles like "very very" are fine); phrases collapse at 2+.
            if (reps >= (n === 1 ? 3 : 2)) {
                out.push(...gram);
                i = j;
            } else {
                out.push(words[i]);
                i++;
            }
        }
        words = out;
    }
    return words.join(' ');
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
    if (!backend) {
        console.error('[Transcriber] Whisper pipeline not loaded');
        return null;
    }

    try {
        const startedAt = Date.now();
        const float32Audio = pcm16ToFloat32(pcm16kBuffer);

        let text;
        if (backend === 'ane') {
            // Inference runs on the Apple Neural Engine in the WhisperKit sidecar.
            text = await whisperkitSidecar.transcribe(float32Audio, 16000, whisperLanguage);
        } else if (backend === 'webgpu') {
            // Inference runs on the Apple GPU in the hidden Whisper window.
            try {
                text = await whisperWindow.transcribe(float32Audio, 16000, whisperLanguage);
            } catch (webgpuError) {
                // The hidden window may have crashed and been torn down; the
                // model files are cached, so recreate the worker once and
                // retry rather than failing every transcription until restart.
                if (whisperWindow.isAlive()) throw webgpuError;
                console.warn('[Transcriber] WebGPU worker gone — recreating once:', webgpuError.message);
                await whisperWindow.loadModel(loadedModelName);
                text = await whisperWindow.transcribe(float32Audio, 16000, whisperLanguage);
            }
        } else {
            // Whisper expects audio at 16kHz which is what we have
            const result = await whisperPipeline(float32Audio, {
                sampling_rate: 16000,
                language: whisperLanguage,
                task: 'transcribe',
                // Block the decoder from repeating any 3-gram — the primary guard
                // against "this is this is this is…" loops.
                no_repeat_ngram_size: 3,
            });
            text = result.text?.trim();
        }

        text = collapseRepetitions(text);
        console.log(`[Transcriber] Completed in ${Date.now() - startedAt}ms (${backend}):`, text);
        return text;
    } catch (error) {
        console.error(`[Transcriber] Transcription error (backend: ${backend}, model: ${loadedModelName}):`, error);
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

function queueTranscription(audioData) {
    pendingAudioJobs.push({ audioData, generation: transcriptionGeneration });
    // Whisper inference is expensive; if it falls hopelessly behind, shed the
    // oldest segment rather than building an ever-staler backlog.
    if (pendingAudioJobs.length > MAX_PENDING_AUDIO_JOBS) {
        console.warn('[Transcriber] Transcription backlog full — dropping oldest segment');
        pendingAudioJobs.shift();
    }
    drainTranscriptionQueue();
}

// Never run overlapping inference jobs: a single drainer processes the queue
// in order, and whoever finishes an inference (final or interim) re-kicks it.
async function drainTranscriptionQueue() {
    if (isTranscribing || pendingAudioJobs.length === 0) return;

    isTranscribing = true;
    try {
        while (pendingAudioJobs.length > 0) {
            const job = pendingAudioJobs.shift();
            if (job.generation !== transcriptionGeneration) continue;
            await handleSpeechEnd(job.audioData, job.generation);
        }
    } finally {
        isTranscribing = false;
        if (pendingAudioJobs.length > 0) drainTranscriptionQueue();
    }
}

// ── Public API ──

async function initWhisper(modelName, { contextPrompt = '' } = {}) {
    try {
        whisperLanguage = storage.getPreferences().whisperLanguage || 'en';
    } catch (error) {
        console.warn('[Transcriber] Could not read whisperLanguage preference, defaulting to en:', error.message);
        whisperLanguage = 'en';
    }
    whisperContextPrompt = contextPrompt;
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
    lastInterimFrameCount = 0;
    queueTranscription(audioData);
    return true;
}

// True while more transcript text is imminent: the VAD still hears speech, or
// an utterance is being (or waiting to be) transcribed. Lets the consumer hold
// off sending a "complete" question to the AI while the speaker is mid-turn.
function isPipelineBusy() {
    return isSpeaking || isTranscribing || pendingAudioJobs.length > 0;
}

function resetTranscriber() {
    transcriptionGeneration++;
    isSpeaking = false;
    speechBuffers = [];
    preSpeechBuffer = [];
    silenceFrameCount = 0;
    speechFrameCount = 0;
    lastInterimFrameCount = 0;
    resampleRemainder = Buffer.alloc(0);
    pendingAudioJobs = [];
    onTranscript = null;
    // Note: whisperPipeline is kept loaded to avoid reloading on next session
}

module.exports = {
    initWhisper,
    setOnTranscript,
    processAudio24k,
    flush,
    isPipelineBusy,
    resetTranscriber,
};
