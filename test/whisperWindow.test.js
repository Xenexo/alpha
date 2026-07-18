// Tests for the hidden Whisper window lifecycle: non-sticky initialization
// failures, pending-work rejection on renderer crash, timeout cleanup with
// distinct load/transcribe messages, and exactly-once IPC registration.
// Electron is stubbed via Module._load, so this runs in plain Node.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('module');

class FakeWebContents extends EventEmitter {
    constructor() {
        super();
        this.sent = [];
    }
    send(channel, payload) {
        this.sent.push({ channel, payload });
    }
}

class FakeBrowserWindow extends EventEmitter {
    constructor(opts) {
        super();
        this.opts = opts;
        this.webContents = new FakeWebContents();
        this._destroyed = false;
        FakeBrowserWindow.instances.push(this);
    }
    isDestroyed() {
        return this._destroyed;
    }
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.emit('closed');
    }
    loadFile(p) {
        this.loadedFile = p;
    }
}
FakeBrowserWindow.instances = [];

const ipcMain = new EventEmitter();
ipcMain.setMaxListeners(50);

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow: FakeBrowserWindow, ipcMain };
    return originalLoad.call(this, request, parent, isMain);
};

const ww = require(path.join(__dirname, '..', 'src', 'utils', 'whisperWindow.js'));

const tick = () => new Promise(r => setImmediate(r));
const lastWindow = () => FakeBrowserWindow.instances.at(-1);

// Drive a loadModel() call to the point where the window is ready and the
// load reply has arrived, mirroring a healthy worker.
async function loadModelOk(modelName = 'test-model') {
    const p = ww.loadModel(modelName);
    ipcMain.emit('whisper:worker-ready');
    await tick();
    const msg = lastWindow().webContents.sent.at(-1);
    assert.equal(msg.channel, 'whisper:load');
    ipcMain.emit('whisper:loaded', {}, { id: msg.payload.id });
    await p;
    return lastWindow();
}

test('failed window load is not sticky: a later attempt recreates the worker', async () => {
    ww.destroy();
    const before = FakeBrowserWindow.instances.length;

    const p1 = ww.loadModel('test-model');
    lastWindow().webContents.emit('did-fail-load', {}, -3, 'ERR_FAILED');
    await assert.rejects(p1, /load failed/i);
    assert.equal(FakeBrowserWindow.instances.length, before + 1);
    assert.equal(lastWindow().isDestroyed(), true, 'the dead window must be torn down');

    // Retry must create a brand-new window and succeed
    const win = await loadModelOk();
    assert.equal(FakeBrowserWindow.instances.length, before + 2);
    assert.equal(win.isDestroyed(), false);
});

test('IPC handlers are registered exactly once across window recreations', async () => {
    // Previous test created two windows; a third for good measure.
    ww.destroy();
    await loadModelOk();
    for (const channel of ['whisper:loaded', 'whisper:result', 'whisper:probe-result', 'whisper:error']) {
        assert.equal(ipcMain.listenerCount(channel), 1, `${channel} must have exactly one handler`);
    }
    // The one-shot ready listener must not leak after use
    assert.equal(ipcMain.listenerCount('whisper:worker-ready'), 0);
});

test('renderer crash rejects pending work and allows recreation', async () => {
    ww.destroy();
    const win = await loadModelOk();

    const pTranscribe = ww.transcribe(new Float32Array(16000));
    await tick();
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await assert.rejects(pTranscribe, /crashed/);

    // The dead window is gone: transcribe fails fast instead of hanging…
    await assert.rejects(() => ww.transcribe(new Float32Array(16000)), /not initialized/);
    // …and a reload creates a fresh worker.
    const count = FakeBrowserWindow.instances.length;
    await loadModelOk();
    assert.equal(FakeBrowserWindow.instances.length, count + 1);
});

test('transcription timeout: pending entry cleaned up, distinct message, worker still usable', async t => {
    ww.destroy();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const win = await loadModelOk();

    const pHung = ww.transcribe(new Float32Array(16000));
    const hungMsg = win.webContents.sent.at(-1);
    t.mock.timers.tick(60 * 1000 + 1);
    await assert.rejects(pHung, /transcription timed out/i);

    // A late reply for the timed-out id must be a harmless no-op
    ipcMain.emit('whisper:result', {}, { id: hungMsg.payload.id, text: 'too late' });

    // The worker itself is still alive and serves the next request
    const pNext = ww.transcribe(new Float32Array(16000));
    const nextMsg = win.webContents.sent.at(-1);
    assert.notEqual(nextMsg.payload.id, hungMsg.payload.id);
    ipcMain.emit('whisper:result', {}, { id: nextMsg.payload.id, text: 'on time' });
    assert.equal(await pNext, 'on time');
});

test('model load timeout carries the model name, distinct from transcription timeout', async t => {
    ww.destroy();
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const p = ww.loadModel('whisper-large-v3-turbo');
    ipcMain.emit('whisper:worker-ready');
    await tick();
    t.mock.timers.tick(10 * 60 * 1000 + 1);
    await assert.rejects(p, /whisper-large-v3-turbo.*download\/load timed out/i);
});
