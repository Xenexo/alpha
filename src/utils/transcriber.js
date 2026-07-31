// Shared speech-to-text pipeline (24kHz PCM → resample → VAD → Whisper).
// Used by the Local AI and Claude providers; only one provider is active at a time.
//
// Audio arrives on two independent SOURCES that must never be mixed:
//   'speaker' — system audio (the interviewer / the other side of the call)
//   'mic'     — the local microphone (the user themselves)
// Each source gets its own VAD, resampler remainder, and utterance buffers —
// interleaving two speakers' frames into one VAD would splice their sentences
// together and make end-of-utterance detection meaningless. The Whisper model
// and the inference queue stay shared and strictly serialized: there is one
// model in memory and running two inferences at once would only contend.
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
// FIFO of audio segments awaiting transcription, across all sources. Split
// segments of one long utterance are all parts of the same question, so they
// must queue rather than replace each other; the cap only sheds load when
// inference falls hopelessly behind.
let pendingAudioJobs = [];
// Two sources share this queue, so allow a little more depth than the
// single-stream original before shedding.
const MAX_PENDING_AUDIO_JOBS = 6;
let transcriptionGeneration = 0;

const DEFAULT_SOURCE = 'speaker';

// Circular buffer of the last N frames before VAD confirms speech.
// Prepended when speech starts so Whisper sees audio context before the first word
// rather than a cold start mid-utterance (which triggers hallucinations in tiny model).
const PRE_SPEECH_FRAMES = 12;

// Per-source pipeline state. Everything here is inherently about one talker's
// utterance in progress, so it cannot be shared between sources.
function createStream(source) {
    return {
        source,
        // VAD state
        isSpeaking: false,
        speechBuffers: [],
        silenceFrameCount: 0,
        speechFrameCount: 0,
        preSpeechBuffer: [],
        lastInterimFrameCount: 0,
        // Audio resampling remainder (24kHz → 16kHz leftover samples)
        resampleRemainder: Buffer.alloc(0),
    };
}

const streams = new Map();

function getStream(source) {
    const key = source || DEFAULT_SOURCE;
    let stream = streams.get(key);
    if (!stream) {
        stream = createStream(key);
        streams.set(key, stream);
    }
    return stream;
}

// Only the interviewer's stream drives the shared status line. Narrating the
// user's own speech there ("Listening... (speech detected)") would fight with
// the answer-progress messages for the same one-line strip.
function sourceStatus(source, message) {
    if (source === DEFAULT_SOURCE) sendToRenderer('update-status', message);
}

function streamStatus(stream, message) {
    sourceStatus(stream.source, message);
}

// Streaming partial transcription. While the user is still speaking, transcribe
// the audio accumulated so far every ~0.8s and emit it as an interim result so
// the UI can show the words live instead of waiting for the end-of-utterance
// silence plus a whole-utterance inference pass. Each frame is ~0.1s. This is
// a floor, not a schedule: runInterim only advances the counter when it
// actually starts an inference, so on a slow backend the effective cadence
// degrades gracefully to max(interval, inference time).
const INTERIM_INTERVAL_FRAMES = 8;
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
// Whisper pads every input to a 30s window (encoder cost is constant), but
// decode time scales with the spoken tokens in the tail, so a shorter tail
// means snappier captions and a shorter worst-case wait for a final that
// queues behind an in-flight interim.
const INTERIM_MAX_FRAMES = 80; // ~8s

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
    BALANCED: { energyThreshold: 0.012, speechFramesRequired: 2, silenceFramesRequired: 5 },
};
let vadConfig = VAD_MODES.BALANCED;

// ── Audio Resampling (24kHz → 16kHz) ──

function resample24kTo16k(inputBuffer, stream) {
    // Combine with any leftover samples from previous call
    const combined = stream.resampleRemainder.length > 0 ? Buffer.concat([stream.resampleRemainder, inputBuffer]) : inputBuffer;
    const inputSamples = Math.floor(combined.length / 2); // 16-bit = 2 bytes per sample
    // Ratio: 16000/24000 = 2/3, so for every 3 input samples we produce 2 output samples
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.allocUnsafe(outputSamples * 2);

    const inView = new Int16Array(combined.buffer, combined.byteOffset, inputSamples);
    const outView = new Int16Array(outputBuffer.buffer, outputBuffer.byteOffset, outputSamples);

    for (let i = 0; i < outputSamples; i++) {
        // Map output sample index to input position
        const srcPos = (i * 3) / 2;
        const srcIndex = Math.floor(srcPos);
        const frac = srcPos - srcIndex;

        const s0 = inView[srcIndex];
        const s1 = srcIndex + 1 < inputSamples ? inView[srcIndex + 1] : s0;
        const interpolated = Math.round(s0 + frac * (s1 - s0));
        outView[i] = Math.max(-32768, Math.min(32767, interpolated));
    }

    // Store remainder for next call
    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    stream.resampleRemainder = remainderStart < combined.length ? combined.subarray(remainderStart) : Buffer.alloc(0);

    return outputBuffer;
}

// ── VAD (Voice Activity Detection) ──

function calculateRMS(pcm16Buffer) {
    const samples = Math.floor(pcm16Buffer.length / 2);
    if (samples === 0) return 0;
    const view = new Int16Array(pcm16Buffer.buffer, pcm16Buffer.byteOffset, samples);
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = view[i] / 32768;
        sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / samples);
}

function processVAD(pcm16kBuffer, stream) {
    const rms = calculateRMS(pcm16kBuffer);
    const isVoice = rms > vadConfig.energyThreshold;

    if (isVoice) {
        stream.speechFrameCount++;
        stream.silenceFrameCount = 0;

        if (!stream.isSpeaking && stream.speechFrameCount >= vadConfig.speechFramesRequired) {
            stream.isSpeaking = true;
            // preSpeechBuffer already contains recent silence + the confirmation frames
            stream.speechBuffers = stream.preSpeechBuffer.map(b => Buffer.from(b));
            stream.preSpeechBuffer = [];
            // Don't fire the first interim until a full interval of new speech.
            stream.lastInterimFrameCount = stream.speechBuffers.length;
            console.log(
                `[Transcriber] Speech started on ${stream.source} (RMS:`,
                rms.toFixed(4),
                ', pre-speech frames:',
                stream.speechBuffers.length,
                ')'
            );
            streamStatus(stream, 'Listening... (speech detected)');
        }

        // Buffer voice frames during the confirmation window too — once confirmed
        // they're already in speechBuffers via the seed above, so only buffer while
        // isSpeaking is still false.
        if (!stream.isSpeaking) {
            stream.preSpeechBuffer.push(Buffer.from(pcm16kBuffer));
            if (stream.preSpeechBuffer.length > PRE_SPEECH_FRAMES) {
                stream.preSpeechBuffer.shift();
            }
        }
    } else {
        // While not speaking, maintain a rolling window of recent audio
        if (!stream.isSpeaking) {
            stream.preSpeechBuffer.push(Buffer.from(pcm16kBuffer));
            if (stream.preSpeechBuffer.length > PRE_SPEECH_FRAMES) {
                stream.preSpeechBuffer.shift();
            }
        }

        stream.silenceFrameCount++;
        stream.speechFrameCount = 0;

        if (stream.isSpeaking && stream.silenceFrameCount >= vadConfig.silenceFramesRequired) {
            stream.isSpeaking = false;
            console.log(`[Transcriber] Speech ended on ${stream.source}, accumulated`, stream.speechBuffers.length, 'chunks');
            streamStatus(stream, 'Transcribing...');

            // Trigger transcription with accumulated audio
            const audioData = Buffer.concat(stream.speechBuffers);
            stream.speechBuffers = [];
            queueTranscription(audioData, stream);
            return;
        }
    }

    // Accumulate audio during speech
    if (stream.isSpeaking) {
        stream.speechBuffers.push(Buffer.from(pcm16kBuffer));

        // Bound the utterance: split long continuous speech into segments so
        // transcription (and the answer) starts while the speaker is still
        // going, instead of one giant slow inference at the very end.
        if (stream.speechBuffers.length >= HARD_SPLIT_FRAMES || (stream.speechBuffers.length >= SOFT_SPLIT_FRAMES && !isVoice)) {
            console.log(`[Transcriber] Long utterance on ${stream.source} — splitting segment at`, stream.speechBuffers.length, 'chunks');
            const audioData = Buffer.concat(stream.speechBuffers);
            const segmentRMS = calculateRMS(audioData);
            if (segmentRMS < vadConfig.energyThreshold * 1.2) {
                console.log(`[Transcriber] Low-energy noise segment (RMS: ${segmentRMS.toFixed(4)}) on ${stream.source} — discarding`);
                stream.isSpeaking = false;
                stream.speechBuffers = [];
                streamStatus(stream, 'Listening...');
                return;
            }
            const overlap = stream.speechBuffers.slice(-SPLIT_OVERLAP_FRAMES);
            stream.speechBuffers = overlap.map(b => Buffer.from(b));
            stream.lastInterimFrameCount = stream.speechBuffers.length;
            queueTranscription(audioData, stream);
            return;
        }

        // Emit a live partial transcript roughly every INTERIM_INTERVAL_FRAMES.
        // runInterim advances the counter only when it actually starts, so a
        // busy-pipeline skip is retried on the very next frame (~0.1s) and the
        // caption fires the moment inference frees up, instead of stalling a
        // whole interval. Never launch on a silence frame: an interim started
        // during the end-of-utterance run-out would make the imminent final
        // transcript queue behind a disposable caption job.
        if (isVoice && stream.speechBuffers.length - stream.lastInterimFrameCount >= INTERIM_INTERVAL_FRAMES) {
            runInterim(stream);
        }
    }
}

// Transcribe the speech buffered so far and emit it as an interim result.
// Fire-and-forget: shares the single `isTranscribing` pipeline lock with final
// transcription so the two never run overlapping inference, and skips entirely
// when the pipeline is busy (interim results are disposable). A final segment
// queued while this runs is drained in the finally, exactly as queueTranscription does.
async function runInterim(stream) {
    if (isTranscribing || !stream.isSpeaking || stream.speechBuffers.length === 0) return;

    // Consume the interval only now that inference is actually starting (the
    // guard above and this line run synchronously, so no second interim can
    // slip in between them).
    stream.lastInterimFrameCount = stream.speechBuffers.length;
    isTranscribing = true;
    const generation = transcriptionGeneration;
    const snapshot = Buffer.concat(stream.speechBuffers.slice(-INTERIM_MAX_FRAMES));

    try {
        const text = await transcribeAudio(snapshot);
        // Drop if the session reset, speech already ended (the final pass will
        // supersede it), or there's nothing usable.
        if (generation === transcriptionGeneration && stream.isSpeaking && text && text.trim().length >= 2) {
            sendToRenderer('interim-transcript', { text: text.trim(), source: stream.source });
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
        // The model remains resident between sessions for fast startup. That
        // must not make the model picker a no-op: a user who upgrades from
        // Tiny/Base to Large v3 Turbo expects the next session to use it.
        if (loadedModelName !== modelName) {
            console.log(`[Transcriber] Switching Whisper model from "${loadedModelName}" to "${modelName}"`);

            if (backend === 'ane' && whisperkitSidecar.isAvailable()) {
                await whisperkitSidecar.loadModel(modelName, whisperLanguage, whisperContextPrompt);
                loadedModelName = modelName;
                return loadedHandle();
            }

            if (backend === 'webgpu') {
                await whisperWindow.loadModel(modelName);
                loadedModelName = modelName;
                return loadedHandle();
            }

            // CPU pipelines cannot swap their model in place. Release the
            // old reference and fall through to the normal loader below.
            whisperPipeline = null;
            backend = null;
            loadedModelName = null;
        }

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

function filterHallucinations(text) {
    if (!text) return '';
    const trimmed = text.trim();
    // Known Whisper decoder hallucination patterns on silence or quiet background noise
    const hallucinationPatterns = [
        /^thank you(\s+very\s+much)?[\.!]?$/i,
        /^thank you for watching[\.!]?$/i,
        /^subtitles by.*$/i,
        /^amara\.org.*$/i,
        /^subscribe to my channel[\.!]?$/i,
        /^bye[\.!]?$/i,
        /^goodbye[\.!]?$/i,
        /^\s*you\s*[\.!]?$/i,
        /^\s*mbc\s*[\.!]?$/i,
        /^[.\s,!?-]+$/,
        // Hindi / Devanagari noise hallucinations on background static
        /^झाल[ंअा]*$/i,
        /^छाल[ंअा]*$/i,
        /^अ[ं०-९]?$/i,
        /^आ[ं]?$/i,
        /^हम्म[ं]?$/i,
        /^सब्सक्राइब.*$/i,
        /^[ऀ-ॿ\s]{1,3}$/,
    ];
    for (const pattern of hallucinationPatterns) {
        if (pattern.test(trimmed)) {
            return '';
        }
    }
    return trimmed;
}

function pcm16ToFloat32(pcm16Buffer) {
    const samples = Math.floor(pcm16Buffer.length / 2);
    const view = new Int16Array(pcm16Buffer.buffer, pcm16Buffer.byteOffset, samples);
    const float32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
        float32[i] = view[i] / 32768;
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
                condition_on_previous_text: false,
            });
            text = result.text?.trim();
        }

        text = collapseRepetitions(text);
        text = filterHallucinations(text);
        console.log(`[Transcriber] Completed in ${Date.now() - startedAt}ms (${backend}):`, text);
        return text;
    } catch (error) {
        console.error(`[Transcriber] Transcription error (backend: ${backend}, model: ${loadedModelName}):`, error);
        return null;
    }
}

// ── Speech End Handler ──

async function handleSpeechEnd(audioData, generation, source) {
    if (!onTranscript) return;

    // Minimum audio length check (~0.5 seconds at 16kHz, 16-bit)
    if (audioData.length < 16000) {
        console.log(`[Transcriber] Audio too short on ${source}, skipping`);
        sourceStatus(source, 'Listening...');
        return;
    }

    const transcription = await transcribeAudio(audioData);

    // The session may have been reset while Whisper was running.
    if (generation !== transcriptionGeneration) return;

    if (!transcription || transcription.trim() === '' || transcription.trim().length < 2) {
        console.log(`[Transcriber] Empty transcription on ${source}, skipping`);
        sourceStatus(source, 'Listening...');
        return;
    }

    if (onTranscript) {
        await onTranscript(transcription, { source });
    }
}

function queueTranscription(audioData, stream, asSource = null) {
    pendingAudioJobs.push({ audioData, generation: transcriptionGeneration, source: asSource || stream.source });
    // Whisper inference is expensive; if it falls hopelessly behind, shed a
    // segment rather than building an ever-staler backlog. Prefer shedding the
    // user's own speech: it is only background context for a later answer,
    // whereas dropping interviewer audio loses part of the actual question.
    if (pendingAudioJobs.length > MAX_PENDING_AUDIO_JOBS) {
        const victim = pendingAudioJobs.findIndex(job => job.source !== DEFAULT_SOURCE);
        const dropped = pendingAudioJobs.splice(victim === -1 ? 0 : victim, 1)[0];
        console.warn(`[Transcriber] Transcription backlog full — dropping oldest ${dropped.source} segment`);
    }
    drainTranscriptionQueue();
}

// Never run overlapping inference jobs: one model, one drainer. Jobs from both
// sources share this queue and are processed strictly in arrival order, and
// whoever finishes an inference (final or interim) re-kicks it.
async function drainTranscriptionQueue() {
    if (isTranscribing || pendingAudioJobs.length === 0) return;

    isTranscribing = true;
    try {
        while (pendingAudioJobs.length > 0) {
            const job = pendingAudioJobs.shift();
            if (job.generation !== transcriptionGeneration) continue;
            await handleSpeechEnd(job.audioData, job.generation, job.source);
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
    // tiny/base are trained overwhelmingly on English; on Hindi they garble the
    // audio or silently translate it. Surface it rather than letting the user
    // conclude Hindi transcription is broken.
    if (whisperLanguage !== 'en' && /whisper-(tiny|base)$/i.test(modelName)) {
        console.warn(
            `[Transcriber] Model "${modelName}" is weak for language "${whisperLanguage}" — recommend whisper-large-v3-turbo or whisper-small`
        );
        sendToRenderer('update-status', `${modelName.split('/').pop()} is inaccurate for non-English — switch to Large v3 Turbo in settings`);
    }
    return await loadWhisperPipeline(modelName);
}

function setOnTranscript(callback) {
    onTranscript = callback;
}

// source: 'speaker' (system audio / the interviewer) or 'mic' (the user).
// Defaults to 'speaker' so existing single-stream callers are unaffected.
function processAudio24k(monoChunk24k, source = DEFAULT_SOURCE) {
    const stream = getStream(source);
    // Resample from 24kHz to 16kHz
    const pcm16k = resample24kTo16k(monoChunk24k, stream);
    if (pcm16k.length > 0) {
        processVAD(pcm16k, stream);
    }
}

// Force-transcribe whatever speech has been buffered on one source, even if the
// VAD has not yet seen the trailing end-of-utterance silence. Used by
// push-to-talk so the final words are sent the instant the user stops holding
// the key — hence the 'mic' default.
//
// `asSource` re-labels the resulting transcript without touching which buffer is
// drained. Push-to-talk needs this: the audio is physically mic audio, but it is
// the user deliberately asking Claude something, which is the opposite of the
// mic's normal context-only role. Carrying the intent on the job — rather than
// having the caller hold a flag until the transcript arrives — keeps it correct
// no matter how long inference queues behind other work.
function flush(source = 'mic', { asSource = null } = {}) {
    const stream = getStream(source);
    if (stream.speechBuffers.length === 0) {
        stream.isSpeaking = false;
        stream.silenceFrameCount = 0;
        stream.speechFrameCount = 0;
        return false;
    }
    const audioData = Buffer.concat(stream.speechBuffers);
    stream.speechBuffers = [];
    stream.isSpeaking = false;
    stream.silenceFrameCount = 0;
    stream.speechFrameCount = 0;
    stream.lastInterimFrameCount = 0;
    queueTranscription(audioData, stream, asSource);
    return true;
}

// True while more transcript text is imminent: a VAD still hears speech, or an
// utterance is being (or waiting to be) transcribed. Lets the consumer hold off
// sending a "complete" question to the AI while the speaker is mid-turn. Pass a
// source to ask about just that stream; omit it to ask about any.
function isPipelineBusy(source = null) {
    if (isTranscribing) return true;
    if (source) {
        return getStream(source).isSpeaking || pendingAudioJobs.some(job => job.source === source);
    }
    if (pendingAudioJobs.length > 0) return true;
    for (const stream of streams.values()) {
        if (stream.isSpeaking) return true;
    }
    return false;
}

function resetTranscriber() {
    transcriptionGeneration++;
    streams.clear();
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
