// Tests for the transcriber's interim (live caption) scheduling: interims must
// start promptly (~0.8s of speech), never launch on a silence frame (the
// imminent final would queue behind them), and retry on the next frame after a
// busy-pipeline skip instead of stalling a whole interval.
//
// Plus per-source stream isolation: speaker (the other person) and mic (the
// user) audio share one Whisper model but must never share VAD state.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('module');

// ── Mocks for the electron-touching modules transcriber.js requires ──

const sentEvents = []; // every sendToRenderer(channel, payload) call
let transcribeCalls = 0;
let transcribeImpl = async () => 'hello world';

const fakeSidecar = {
    isAvailable: () => true,
    loadModel: async () => true,
    transcribe: audio => {
        transcribeCalls++;
        return transcribeImpl(audio);
    },
    destroy() {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === './gemini') return { sendToRenderer: (channel, payload) => sentEvents.push({ channel, payload }) };
    if (request === './whisperkitSidecar') return fakeSidecar;
    if (request === './whisperWindow')
        return { isWebGPUAvailable: async () => false, loadModel: async () => {}, transcribe: async () => '', isAlive: () => false, destroy() {} };
    if (request === '../storage') return { getPreferences: () => ({}) };
    return originalLoad.call(this, request, parent, isMain);
};

const transcriber = require(path.join(__dirname, '..', 'src', 'utils', 'transcriber.js'));

test.after(() => {
    Module._load = originalLoad;
});

// One 0.1s frame of 24kHz 16-bit mono PCM (2400 samples). A constant non-zero
// value gives an RMS far above the VAD threshold; zeros are silence.
function frame(value) {
    const buf = Buffer.alloc(4800);
    if (value) {
        for (let i = 0; i < 2400; i++) buf.writeInt16LE(value, i * 2);
    }
    return buf;
}
const voice = () => frame(8000);
const silence = () => frame(0);

function feed(frames, source) {
    for (const f of frames) transcriber.processAudio24k(f, source);
}
const repeat = (make, n) => Array.from({ length: n }, make);

// Flush the fire-and-forget interim/final async chains (fake inference resolves
// in microtasks; setImmediate drains them all).
async function tick() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

const interimEvents = () => sentEvents.filter(e => e.channel === 'interim-transcript');
// Interim payloads are { text, source } so the UI can label whose speech it is.
const interimTexts = () => interimEvents().map(e => e.payload.text);

// Backend loads once ('ane' via the fake sidecar) and persists across tests.
const ready = transcriber.initWhisper('onnx-community/whisper-large-v3-turbo');

// Each test starts a fresh utterance: 3 silence frames (pre-speech context),
// then voice. Speech is confirmed on the 2nd voice frame; the interim baseline
// is seeded there, so the first interim may fire 8 frames later.
async function startSpeech() {
    transcriber.resetTranscriber();
    sentEvents.length = 0;
    transcribeCalls = 0;
    feed([...repeat(silence, 3), ...repeat(voice, 2)]);
    await tick();
}

test('first interim fires after ~0.8s of speech, not 1.5s', async () => {
    await ready;
    transcribeImpl = async () => 'hello world';
    await startSpeech();

    // 6 frames past confirmation: still below the 8-frame interval.
    feed(repeat(voice, 6));
    await tick();
    assert.equal(transcribeCalls, 0, 'interim must not fire before the interval');

    // 7th frame crosses the interval (8 frames buffered since the baseline).
    feed(repeat(voice, 1));
    await tick();
    assert.equal(transcribeCalls, 1, 'interim fires as soon as the interval is reached');
    assert.deepEqual(interimTexts(), ['hello world']);
    assert.equal(interimEvents()[0].payload.source, 'speaker');
});

test('silence frames never launch an interim, and the final still goes through', async () => {
    await ready;
    transcribeImpl = async () => 'hello world';
    await startSpeech();

    // Stay just below the interval with voice, then cross it with silence
    // frames (a mid-utterance pause shorter than the end-of-speech threshold):
    // the interval condition is met but no interim may start on silence.
    feed(repeat(voice, 5));
    await tick();
    feed(repeat(silence, 4));
    await tick();
    assert.equal(transcribeCalls, 0, 'silence frames must not start an interim inference');

    // Voice resumes — now it fires.
    feed(repeat(voice, 1));
    await tick();
    assert.equal(transcribeCalls, 1);

    // End the utterance; the final transcription must reach onTranscript.
    let resolveFinal;
    const finalText = new Promise(resolve => (resolveFinal = resolve));
    transcriber.setOnTranscript(async text => resolveFinal(text));
    feed(repeat(silence, 5));
    await tick();
    assert.equal(await finalText, 'hello world');
    assert.equal(transcribeCalls, 2, 'exactly one interim + one final inference');
});

test('a busy-pipeline skip retries on the next frame instead of waiting out a new interval', async () => {
    await ready;
    let release;
    transcribeImpl = () => new Promise(resolve => (release = () => resolve('partial one')));
    await startSpeech();

    // Cross the interval to start the first interim, which hangs.
    feed(repeat(voice, 7));
    await tick();
    assert.equal(transcribeCalls, 1);

    // Plenty more speech arrives while inference is busy: attempts are skipped
    // by the single-flight lock, never queued.
    feed(repeat(voice, 12));
    await tick();
    assert.equal(transcribeCalls, 1, 'no overlapping interim while one is in flight');

    // The moment inference frees up, the very next voice frame starts the next
    // interim — the skips must not have consumed the interval.
    transcribeImpl = async () => 'partial two';
    release();
    await tick();
    feed(repeat(voice, 1));
    await tick();
    assert.equal(transcribeCalls, 2, 'next frame after unblock fires the next interim');
    assert.deepEqual(interimTexts(), ['partial one', 'partial two']);
});

// ── Per-source streams ──
//
// Speaker (the other person) and mic (the user) audio arrive interleaved and
// must be kept in separate VAD/utterance state. Sharing it would splice two
// people's sentences into one transcript and break end-of-utterance detection.

// Silence long enough for the VAD to end an utterance (BALANCED needs 5).
const END_OF_UTTERANCE = 8;

function collectTranscripts() {
    const got = [];
    transcriber.setOnTranscript((text, meta = {}) => {
        got.push({ text, source: meta.source });
    });
    return got;
}

test('interleaved speaker and mic frames produce separate, labelled transcripts', async () => {
    transcriber.resetTranscriber();
    sentEvents.length = 0;
    transcribeCalls = 0;
    const got = collectTranscripts();
    transcribeImpl = async () => 'hello world';

    // Both talk at once, frame-interleaved — the worst case for shared VAD state.
    for (let i = 0; i < 12; i++) {
        transcriber.processAudio24k(voice(), 'speaker');
        transcriber.processAudio24k(voice(), 'mic');
    }
    for (let i = 0; i < END_OF_UTTERANCE; i++) {
        transcriber.processAudio24k(silence(), 'speaker');
        transcriber.processAudio24k(silence(), 'mic');
    }
    await tick();
    await tick();

    assert.deepEqual(got.map(t => t.source).sort(), ['mic', 'speaker'], 'each source must yield exactly one transcript, tagged with its own source');
});

test('a source with no audio never produces a transcript', async () => {
    transcriber.resetTranscriber();
    transcribeCalls = 0;
    const got = collectTranscripts();
    transcribeImpl = async () => 'only the speaker talked';

    feed([...repeat(silence, 3), ...repeat(voice, 12), ...repeat(silence, END_OF_UTTERANCE)], 'speaker');
    await tick();
    await tick();

    assert.equal(got.length, 1);
    assert.equal(got[0].source, 'speaker');
});

test('processAudio24k defaults to the speaker source', async () => {
    transcriber.resetTranscriber();
    transcribeCalls = 0;
    const got = collectTranscripts();
    transcribeImpl = async () => 'unlabelled caller';

    // No source argument — the pre-existing single-stream call shape.
    feed([...repeat(silence, 3), ...repeat(voice, 12), ...repeat(silence, END_OF_UTTERANCE)]);
    await tick();
    await tick();

    assert.equal(got.length, 1);
    assert.equal(got[0].source, 'speaker', 'legacy callers must keep behaving as the interviewer stream');
});

test('flush({ asSource }) relabels the flushed mic audio without touching the speaker stream', async () => {
    transcriber.resetTranscriber();
    transcribeCalls = 0;
    const got = collectTranscripts();
    transcribeImpl = async () => 'my question for claude';

    // Push-to-talk: the user speaks into the mic and releases before the VAD
    // has seen end-of-utterance silence.
    feed([...repeat(silence, 3), ...repeat(voice, 12)], 'mic');
    const hadSpeech = transcriber.flush('mic', { asSource: 'mic-ask' });
    await tick();
    await tick();

    assert.equal(hadSpeech, true);
    assert.equal(got.length, 1);
    assert.equal(got[0].source, 'mic-ask', 'push-to-talk audio must be answerable, not filed as context');
});

test('flush on an idle source reports no speech and queues nothing', async () => {
    transcriber.resetTranscriber();
    transcribeCalls = 0;
    collectTranscripts();

    assert.equal(transcriber.flush('mic'), false);
    await tick();
    assert.equal(transcribeCalls, 0);
});

test('isPipelineBusy can be scoped to one source', async () => {
    transcriber.resetTranscriber();
    transcribeCalls = 0;
    collectTranscripts();

    // Only the mic is mid-utterance.
    feed([...repeat(silence, 3), ...repeat(voice, 4)], 'mic');

    assert.equal(transcriber.isPipelineBusy('mic'), true);
    assert.equal(transcriber.isPipelineBusy('speaker'), false, 'the other person is not talking');
    assert.equal(transcriber.isPipelineBusy(), true, 'unscoped means "any source"');
});
