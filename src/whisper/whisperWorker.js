// Runs as a module in the hidden Whisper window's pure-browser context (no Node
// globals — see whisperPreload.js for why). Loads @huggingface/transformers and
// runs Whisper inference on the Apple GPU via device:'webgpu', so the heavy
// model never saturates the CPU in the main process.
//
// Protocol (request/response over IPC, matched by id; bridge from preload):
//   main → here:  whisper:load      { id, modelName }
//                 whisper:transcribe{ id, audio: Float32Array, samplingRate }
//                 whisper:probe     { id }
//   here → main:  whisper:loaded {id} | whisper:result {id,text} | whisper:error {id,message}
//                 whisper:probe-result { id, available }
const env = window.__whisperEnv;
const ipc = window.__whisperIpc;

let whisperPipeline = null;
let transformers = null;

function log(...args) {
    console.log('[WhisperWorker]', ...args);
}

async function getTransformers() {
    if (transformers) return transformers;
    transformers = await import(env.transformersUrl);
    // Load the ORT WebGPU wasm from disk rather than the jsdelivr CDN (which is
    // blocked by CSP and unavailable offline).
    transformers.env.backends.onnx.wasm.wasmPaths = env.wasmDir;
    transformers.env.allowRemoteModels = true;
    return transformers;
}

// WebGPU favours fp16 (half the bandwidth/memory of fp32, well supported on
// Apple GPUs). large-v3-turbo ships separate encoder/decoder graphs.
function getDtypeForModel(modelName) {
    if (/whisper-large-v3-turbo/i.test(modelName)) {
        return { encoder_model: 'fp16', decoder_model_merged: 'fp16' };
    }
    return 'fp16';
}

// English-only (.en) checkpoints reject language/task; the multilingual ones
// require them for consistent English output.
function isEnglishOnly(modelName) {
    return /\.en$/i.test(modelName) || /\.en[-/]/i.test(modelName);
}

let activeModelName = null;

async function loadModel(modelName) {
    const { pipeline } = await getTransformers();
    log('Loading model on WebGPU:', modelName);
    whisperPipeline = await pipeline('automatic-speech-recognition', modelName, {
        device: 'webgpu',
        dtype: getDtypeForModel(modelName),
    });
    activeModelName = modelName;

    // Warm up the graph with 1s of silence so the first real utterance does not
    // pay one-time shader/graph compilation latency.
    try {
        await transcribe(new Float32Array(16000), 16000);
        log('Warmup complete');
    } catch (warmupError) {
        log('Warmup failed (non-fatal):', warmupError.message);
    }
}

async function transcribe(audio, samplingRate, language) {
    if (!whisperPipeline) throw new Error('Whisper pipeline not loaded');
    // no_repeat_ngram_size matches the CPU path: it is the primary guard against
    // the decoder falling into a "this is this is this is…" loop, which shows up
    // most on short/silence-padded audio and on non-English speech.
    const options = {
        sampling_rate: samplingRate || 16000,
        no_repeat_ngram_size: 3,
        condition_on_previous_text: false,
    };
    if (!isEnglishOnly(activeModelName)) {
        options.language = language || 'en';
        options.task = 'transcribe';
    }
    const result = await whisperPipeline(audio, options);
    return result.text?.trim() || '';
}

ipc.on('whisper:load', async ({ id, modelName }) => {
    try {
        await loadModel(modelName);
        ipc.send('whisper:loaded', { id });
    } catch (error) {
        log('Load error:', error);
        ipc.send('whisper:error', { id, message: error.message });
    }
});

ipc.on('whisper:transcribe', async ({ id, audio, samplingRate, language }) => {
    try {
        const text = await transcribe(audio, samplingRate, language);
        ipc.send('whisper:result', { id, text });
    } catch (error) {
        log('Transcribe error:', error);
        ipc.send('whisper:error', { id, message: error.message });
    }
});

ipc.on('whisper:probe', ({ id }) => {
    ipc.send('whisper:probe-result', { id, available: !!(navigator && navigator.gpu) });
});

log('Ready, WebGPU available:', !!(navigator && navigator.gpu));
ipc.send('whisper:worker-ready', {});
