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

// A checkpoint that declares is_multilingual:false makes transformers.js throw
// on language/task rather than ignore them — and that is not only the .en
// builds, single-language fine-tunes like whisper-hindi-small declare it too.
// But those fine-tunes are whisper-small underneath and still carry the whole
// language token table, so the flag is what is wrong, not the capability.
// Dropping the language instead makes the decoder auto-detect, which on Hindi
// audio picks English and returns nothing usable. Force the flag when the
// tokens exist; only a genuinely English-only build has no table to check.
function languageOptions(language) {
    const generationConfig = whisperPipeline && whisperPipeline.model && whisperPipeline.model.generation_config;
    const base = { language: language || 'en', task: 'transcribe' };
    if (!generationConfig) return base;
    const langToId = generationConfig.lang_to_id;
    if (langToId && Number.isInteger(langToId[`<|${base.language}|>`])) {
        return { ...base, is_multilingual: true };
    }
    return generationConfig.is_multilingual === false ? null : base;
}

let activeModelName = null;

async function loadModel(modelName) {
    const { pipeline } = await getTransformers();
    log('Loading model on WebGPU:', modelName);
    try {
        whisperPipeline = await pipeline('automatic-speech-recognition', modelName, {
            device: 'webgpu',
            dtype: getDtypeForModel(modelName),
        });
    } catch (fp16Error) {
        log('fp16 load failed, retrying on q8:', fp16Error.message);
        whisperPipeline = await pipeline('automatic-speech-recognition', modelName, {
            device: 'webgpu',
            dtype: 'q8',
        });
    }
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
    Object.assign(options, languageOptions(language));
    try {
        const result = await whisperPipeline(audio, options);
        return result.text?.trim() || '';
    } catch (error) {
        if (!/Cannot specify.*(task|language)/i.test(error.message || '')) throw error;
        log('Model rejected the language options — retrying without them:', error.message);
        delete options.language;
        delete options.task;
        delete options.is_multilingual;
        const result = await whisperPipeline(audio, options);
        return result.text?.trim() || '';
    }
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
