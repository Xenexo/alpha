// Preload for the hidden Whisper window. The window runs with nodeIntegration
// OFF so its page is a pure browser context — that is what lets
// @huggingface/transformers register the WebGPU backend (with Node globals
// present it falls back to CPU-only onnxruntime-node). This preload keeps Node
// access (sandbox is off) and hands the page two things it cannot obtain on its
// own: the file:// URLs of the local transformers bundle + ORT wasm assets, and
// a minimal IPC bridge to the main process.
const { ipcRenderer } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const distDir = path.dirname(require.resolve('@huggingface/transformers'));

window.__whisperEnv = {
    // Self-contained browser bundle (ORT inlined, no external bare imports).
    transformersUrl: pathToFileURL(path.join(distDir, 'transformers.min.js')).href,
    // Trailing slash required — ORT joins the wasm filename onto this base.
    // Points ORT at the local jsep wasm instead of fetching it from a CDN.
    wasmDir: pathToFileURL(distDir).href + '/',
};

window.__whisperIpc = {
    send: (channel, payload) => ipcRenderer.send(channel, payload),
    on: (channel, cb) => ipcRenderer.on(channel, (_event, data) => cb(data)),
};
