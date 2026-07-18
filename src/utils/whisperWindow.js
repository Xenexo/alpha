// Main-process bridge to the hidden Whisper window. WebGPU only exists in a
// renderer, so the heavy Whisper inference is offloaded there (onto the Apple
// GPU) instead of running on the CPU in the main process. This module owns the
// hidden window's lifecycle and exposes promise-based loadModel()/transcribe()
// that round-trip over request-id-matched IPC.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

let whisperWindow = null;
let readyPromise = null;
let handlersRegistered = false;
let requestSeq = 0;
const pending = new Map(); // id → { resolve, reject, timer }

// Long enough for a first-run model download + load on a slow connection.
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 60 * 1000;
const WINDOW_READY_TIMEOUT_MS = 30000;

function settle(id, fn, value) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    fn === 'resolve' ? entry.resolve(value) : entry.reject(value);
}

function rejectAllPending(reason) {
    for (const id of [...pending.keys()]) settle(id, 'reject', new Error(reason));
}

// Tear down a dead/failed window so the next ensureWindow() call recreates it
// from scratch. Without this, a failed readyPromise (or a crashed renderer)
// would be cached forever and every later attempt — including the WebGPU
// fallback of a future session — would fail instantly ("poisoned" state).
function cleanupWindow(reason) {
    rejectAllPending(reason);
    const win = whisperWindow;
    whisperWindow = null;
    readyPromise = null;
    if (win && !win.isDestroyed()) win.destroy();
}

// ipcMain handlers are global, so guard registration — a window recreated
// after a crash/failure must not stack a second set of handlers (each reply
// would settle twice, and listener leaks accumulate per retry).
function registerIpcHandlers() {
    if (handlersRegistered) return;
    handlersRegistered = true;
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
    const createdAt = Date.now();

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
    const win = whisperWindow;

    // The window is invisible and has no devtools; forward its console to the
    // main process so Whisper load/inference logs are visible.
    win.webContents.on('console-message', (_e, _level, message) => {
        console.log('[WhisperWindow]', message);
    });

    // A crashed GPU process / OOM-killed renderer silently loses every
    // in-flight request — reject them so callers can react, and reset state so
    // the next attempt recreates the worker instead of talking to a corpse.
    win.webContents.on('render-process-gone', (_e, details) => {
        const reason = details?.reason || 'unknown';
        console.error('[WhisperWindow] Renderer process gone:', reason);
        if (whisperWindow === win) cleanupWindow(`Whisper window crashed (${reason})`);
    });

    win.on('closed', () => {
        if (whisperWindow === win) {
            whisperWindow = null;
            readyPromise = null;
            rejectAllPending('Whisper window closed');
        }
    });

    readyPromise = new Promise((resolve, reject) => {
        const onReady = () => {
            clearTimeout(timer);
            console.log(`[WhisperWindow] Worker ready in ${Date.now() - createdAt}ms`);
            resolve();
        };
        const timer = setTimeout(() => {
            ipcMain.removeListener('whisper:worker-ready', onReady);
            reject(new Error('Whisper window failed to load in time'));
        }, WINDOW_READY_TIMEOUT_MS);
        ipcMain.once('whisper:worker-ready', onReady);
        win.webContents.once('did-fail-load', (_e, code, desc) => {
            clearTimeout(timer);
            ipcMain.removeListener('whisper:worker-ready', onReady);
            reject(new Error(`Whisper window load failed: ${desc} (${code})`));
        });
    });

    // A failed initialization must be non-sticky: drop the rejected promise and
    // the dead window so a later loadModel()/probe can retry from scratch.
    readyPromise.catch(error => {
        console.error('[WhisperWindow] Initialization failed:', error.message);
        if (whisperWindow === win) cleanupWindow('Whisper window failed to initialize: ' + error.message);
    });

    win.loadFile(path.join(__dirname, '../whisper-worker.html'));
    return readyPromise;
}

// timeoutMessage distinguishes the failure classes: a model download/load
// hitting its (10-minute) ceiling is a very different problem from a single
// transcription hanging, and the status shown to the user should say which.
function send(channel, payload, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
        if (!whisperWindow || whisperWindow.isDestroyed()) {
            reject(new Error('Whisper window not available'));
            return;
        }
        const id = ++requestSeq;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(timeoutMessage || `Whisper ${channel} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        whisperWindow.webContents.send(channel, { id, ...payload });
    });
}

// Returns true if the hidden window reports WebGPU is available.
async function isWebGPUAvailable() {
    const startedAt = Date.now();
    try {
        await ensureWindow();
        const available = await send('whisper:probe', {}, 10000, 'WebGPU probe timed out');
        console.log(`[WhisperWindow] WebGPU probe: ${available} (${Date.now() - startedAt}ms)`);
        return available;
    } catch (error) {
        console.warn('[WhisperWindow] WebGPU probe failed:', error.message);
        return false;
    }
}

async function loadModel(modelName) {
    await ensureWindow();
    // The web build caches model files via the browser's Cache Storage (in this
    // window's persistent session), so the ~1GB download only happens once.
    return send('whisper:load', { modelName }, LOAD_TIMEOUT_MS, `Whisper model "${modelName}" download/load timed out`);
}

// audio: Float32Array of 16kHz mono samples.
async function transcribe(audio, samplingRate = 16000, language = 'en') {
    if (!whisperWindow || whisperWindow.isDestroyed()) throw new Error('Whisper window not initialized');
    return send('whisper:transcribe', { audio, samplingRate, language }, TRANSCRIBE_TIMEOUT_MS, 'Whisper transcription timed out (webgpu)');
}

// True when the worker window is alive — used by callers to decide whether a
// failed transcription needs a reload before retrying.
function isAlive() {
    return !!whisperWindow && !whisperWindow.isDestroyed();
}

function destroy() {
    cleanupWindow('Whisper window destroyed');
}

module.exports = { isWebGPUAvailable, loadModel, transcribe, isAlive, destroy };
