// Sidecar bridge to WhisperKit (`whisperkit-cli serve`): runs Whisper inference
// on the Apple Neural Engine via Core ML — both encoder and decoder — so
// transcription is faster and cooler than the WebGPU path and never contends
// with the UI for the GPU. The CLI is spawned once in local-server mode (the
// model stays warm in the sidecar process) and each utterance is POSTed to its
// OpenAI-compatible /v1/audio/transcriptions endpoint as a 16kHz mono WAV.
// Mirrors the whisperWindow.js surface so transcriber.js treats it as just
// another backend.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { sendToRenderer } = require('./gemini');

// Bind explicitly to IPv4: with the default `--host localhost` the Swift
// server binds ::1 only, and Node's resolver may pick 127.0.0.1 first.
const HOST = '127.0.0.1';
// Non-default port so a user-launched `whisperkit-cli serve` (default 50060)
// never collides with ours.
const PORT = 50861;

// First run downloads the Core ML model (~1.6GB for large-v3-turbo) and the
// ANE service compiles it. Slow connections need well over whisperWindow's
// 10-minute window for a download this size; the download resumes across
// attempts, so a timeout here only delays ANE to a later session (the load
// falls through to WebGPU), but avoid churning users through that state.
const LOAD_TIMEOUT_MS = 30 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 60 * 1000;
const HEALTH_POLL_INTERVAL_MS = 1000;

// HF ONNX model ids (used by the WebGPU/CPU backends) → variant names in
// argmaxinc/whisperkit-coreml (the CLI prepends "openai_whisper-").
// "large-v3-v20240930" IS OpenAI's whisper-large-v3-turbo — the dated name of
// its September 2024 release — not to be confused with "large-v3_turbo",
// which is WhisperKit's own compressed variant of the older large-v3.
const MODEL_MAP = {
    'onnx-community/whisper-large-v3-turbo': 'large-v3-v20240930',
    'Xenova/whisper-tiny': 'tiny',
    'Xenova/whisper-base': 'base',
    'Xenova/whisper-small': 'small',
    'Xenova/whisper-medium': 'medium',
};

let cliPath = undefined; // undefined = not probed yet, null = not found
let child = null;
let serverReady = false;
let servedModel = null; // WhisperKit model name loaded in the sidecar
let servedLanguage = 'en'; // language the sidecar was started with
let restartPromise = null;

function findCli() {
    if (cliPath !== undefined) return cliPath;
    // The app inherits a minimal PATH when launched from Finder, so check the
    // Homebrew locations explicitly rather than relying on PATH alone.
    const candidates = [
        '/opt/homebrew/bin/whisperkit-cli',
        '/usr/local/bin/whisperkit-cli',
        ...(process.env.PATH || '').split(':').map(dir => path.join(dir, 'whisperkit-cli')),
    ];
    cliPath = candidates.find(p => {
        try {
            fs.accessSync(p, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }) || null;
    return cliPath;
}

// ANE inference requires Apple Silicon; the sidecar is skipped everywhere else.
function isAvailable() {
    return process.platform === 'darwin' && process.arch === 'arm64' && !!findCli();
}

function healthCheck() {
    return new Promise(resolve => {
        const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: 2000 }, res => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

// Spawn `whisperkit-cli serve` and wait until /health responds, which the
// server only does after the model has finished downloading and loading.
function startServer(wkModel, language = 'en') {
    return new Promise((resolve, reject) => {
        const cli = findCli();
        // The per-request `language` form field is logged by the server but not
        // applied to decoding, so without this flag Whisper auto-detects the
        // language per utterance (random Icelandic/Urdu output on Hindi audio).
        child = spawn(cli, ['serve', '--model', wkModel, '--language', language, '--port', String(PORT), '--host', HOST], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const proc = child;
        serverReady = false;

        proc.stdout.on('data', d => console.log('[WhisperKit]', String(d).trim()));
        proc.stderr.on('data', d => console.log('[WhisperKit]', String(d).trim()));
        proc.on('exit', (code, signal) => {
            console.warn(`[WhisperKit] Sidecar exited (code ${code}, signal ${signal})`);
            if (child === proc) {
                child = null;
                serverReady = false;
            }
        });
        proc.on('error', err => {
            console.error('[WhisperKit] Failed to spawn sidecar:', err.message);
            if (child === proc) {
                child = null;
                serverReady = false;
            }
        });

        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        const poll = async () => {
            // A bind failure or crash during model download exits the process;
            // fail fast instead of polling out the full timeout.
            if (child !== proc) return reject(new Error('WhisperKit sidecar exited during startup'));
            if (await healthCheck()) {
                serverReady = true;
                return resolve();
            }
            if (Date.now() > deadline) {
                proc.kill();
                return reject(new Error('WhisperKit sidecar failed to become ready in time'));
            }
            setTimeout(poll, HEALTH_POLL_INTERVAL_MS);
        };
        poll();
    });
}

function encodeWav(float32Audio, sampleRate) {
    const dataLength = float32Audio.length * 2;
    const buffer = Buffer.alloc(44 + dataLength);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32); // block align
    buffer.writeUInt16LE(16, 34); // bits per sample
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);
    for (let i = 0; i < float32Audio.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Audio[i]));
        buffer.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
    }
    return buffer;
}

function postTranscription(wavBuffer, language = 'en') {
    return new Promise((resolve, reject) => {
        const boundary = '----WhisperKitSidecar' + Math.random().toString(36).slice(2);
        const part = name => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`;
        const body = Buffer.concat([
            Buffer.from(part('model') + servedModel + '\r\n'),
            Buffer.from(part('language') + language + '\r\n'),
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
                    'Content-Type: audio/wav\r\n\r\n'
            ),
            wavBuffer,
            Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);

        const req = http.request(
            {
                host: HOST,
                port: PORT,
                path: '/v1/audio/transcriptions',
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length,
                },
                timeout: TRANSCRIBE_TIMEOUT_MS,
            },
            res => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        return reject(new Error(`WhisperKit server returned ${res.statusCode}: ${data.slice(0, 200)}`));
                    }
                    try {
                        resolve(JSON.parse(data).text?.trim() ?? '');
                    } catch (error) {
                        reject(new Error('WhisperKit server returned invalid JSON: ' + error.message));
                    }
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('WhisperKit transcription timed out'));
        });
        req.end(body);
    });
}

async function loadModel(modelName, language = 'en') {
    const wkModel = MODEL_MAP[modelName];
    if (!wkModel) throw new Error(`No WhisperKit mapping for model ${modelName}`);
    if (serverReady && servedModel === wkModel && servedLanguage === language) return true;
    // A sidecar serving a different model or language holds the port — replace it.
    if (child) destroy();

    sendToRenderer('update-status', 'Loading Whisper model on Neural Engine (first time may take a while)...');
    await startServer(wkModel, language);
    servedModel = wkModel;
    servedLanguage = language;

    // Same rationale as the CPU backend's warmup in transcriber.js: the first
    // inference pays one-time ANE graph compilation, so spend it on silence
    // instead of the user's first utterance.
    try {
        const warmStart = Date.now();
        await postTranscription(encodeWav(new Float32Array(16000), 16000));
        console.log(`[WhisperKit] Warmup completed in ${Date.now() - warmStart}ms`);
    } catch (warmupError) {
        console.warn('[WhisperKit] Warmup inference failed (non-fatal):', warmupError.message);
    }

    return true;
}

// audio: Float32Array of 16kHz mono samples.
async function transcribe(float32Audio, samplingRate = 16000, language = 'en') {
    // If the sidecar crashed mid-session, respawn it once per outage instead of
    // failing every utterance until the session restarts. The model is cached
    // on disk, so recovery is seconds, not a re-download. transcriber.js
    // serializes transcriptions, but interim + final can still race here —
    // share one restart promise so they never spawn two sidecars.
    if (!serverReady) {
        if (!servedModel) throw new Error('WhisperKit sidecar not initialized');
        if (!restartPromise) {
            console.warn('[WhisperKit] Sidecar not running — restarting...');
            restartPromise = startServer(servedModel, servedLanguage).finally(() => {
                restartPromise = null;
            });
        }
        await restartPromise;
    }
    return postTranscription(encodeWav(float32Audio, samplingRate), language);
}

function destroy() {
    if (child) {
        child.kill();
        child = null;
    }
    serverReady = false;
    servedModel = null;
}

module.exports = { isAvailable, loadModel, transcribe, destroy };
