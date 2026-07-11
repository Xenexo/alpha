// Main-process bridge to the hidden Whisper window. WebGPU only exists in a
// renderer, so the heavy Whisper inference is offloaded there (onto the Apple
// GPU) instead of running on the CPU in the main process. This module owns the
// hidden window's lifecycle and exposes promise-based loadModel()/transcribe()
// that round-trip over request-id-matched IPC.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

let whisperWindow = null;
let readyPromise = null;
let requestSeq = 0;
const pending = new Map(); // id → { resolve, reject, timer }

// Long enough for a first-run model download + load on a slow connection.
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 60 * 1000;

function settle(id, fn, value) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    fn === 'resolve' ? entry.resolve(value) : entry.reject(value);
}

function registerIpcHandlers() {
    ipcMain.on('whisper:loaded', (_e, { id }) => settle(id, 'resolve', true));
    ipcMain.on('whisper:result', (_e, { id, text }) => settle(id, 'resolve', text));
    ipcMain.on('whisper:probe-result', (_e, { id, available }) => settle(id, 'resolve', available));
    ipcMain.on('whisper:error', (_e, { id, message }) => settle(id, 'reject', new Error(message)));
}

// Create the hidden window once, lazily (after the main window already exists).
// UI events must never reach this window: sendToRenderer() identifies it by its
// whisper-worker.html URL and excludes it, rather than relying on
// getAllWindows() ordering, which is not guaranteed.
function ensureWindow() {
    if (readyPromise) return readyPromise;

    registerIpcHandlers();

    whisperWindow = new BrowserWindow({
        show: false,
        webPreferences: {
            // Page must be a pure browser context (no Node globals) so
            // transformers.js registers the WebGPU backend instead of CPU-only
            // onnxruntime-node. The preload (sandbox off) supplies file:// URLs
            // and the IPC bridge the page cannot get on its own.
            nodeIntegration: false,
            contextIsolation: false,
            sandbox: false,
            backgroundThrottling: false, // keep GPU work full-speed while hidden
            preload: path.join(__dirname, '../whisper/whisperPreload.js'),
        },
    });

    // The window is invisible and has no devtools; forward its console to the
    // main process so Whisper load/inference logs are visible.
    whisperWindow.webContents.on('console-message', (_e, _level, message) => {
        console.log('[WhisperWindow]', message);
    });

    readyPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Whisper window failed to load in time')), 30000);
        ipcMain.once('whisper:worker-ready', () => {
            clearTimeout(timer);
            resolve();
        });
        whisperWindow.webContents.once('did-fail-load', (_e, code, desc) => {
            clearTimeout(timer);
            reject(new Error(`Whisper window load failed: ${desc} (${code})`));
        });
    });

    whisperWindow.loadFile(path.join(__dirname, '../whisper-worker.html'));
    return readyPromise;
}

function send(channel, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
        const id = ++requestSeq;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Whisper ${channel} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        whisperWindow.webContents.send(channel, { id, ...payload });
    });
}

// Returns true if the hidden window reports WebGPU is available.
async function isWebGPUAvailable() {
    try {
        await ensureWindow();
        return await send('whisper:probe', {}, 10000);
    } catch (error) {
        console.warn('[WhisperWindow] WebGPU probe failed:', error.message);
        return false;
    }
}

async function loadModel(modelName) {
    await ensureWindow();
    // The web build caches model files via the browser's Cache Storage (in this
    // window's persistent session), so the ~1GB download only happens once.
    return send('whisper:load', { modelName }, LOAD_TIMEOUT_MS);
}

// audio: Float32Array of 16kHz mono samples.
async function transcribe(audio, samplingRate = 16000, language = 'en') {
    if (!whisperWindow) throw new Error('Whisper window not initialized');
    return send('whisper:transcribe', { audio, samplingRate, language }, TRANSCRIBE_TIMEOUT_MS);
}

function destroy() {
    for (const [id] of pending) settle(id, 'reject', new Error('Whisper window destroyed'));
    if (whisperWindow && !whisperWindow.isDestroyed()) whisperWindow.destroy();
    whisperWindow = null;
    readyPromise = null;
}

module.exports = { isWebGPUAvailable, loadModel, transcribe, destroy };
