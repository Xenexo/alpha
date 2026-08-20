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
    supportsModel: () => true,
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

test.beforeEach(() => {
    transcriber._testing.setInterimMinGapMs(transcriber._testing.INTERIM_MIN_GAP_MS);
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
    feed(repeat(silence, 8));
    await tick();
    assert.equal(await finalText, 'hello world');
    assert.equal(transcribeCalls, 2, 'exactly one interim + one final inference');
});

test('interims are paced by a wall-clock gap so captions cannot grind back-to-back', async () => {
    await ready;
    transcriber._testing.setInterimMinGapMs(transcriber._testing.INTERIM_MIN_GAP_MS);
    transcribeImpl = async () => 'caption';
    await startSpeech();

    feed(repeat(voice, 7));
    await tick();
    assert.equal(transcribeCalls, 1, 'the first caption of an utterance is still prompt');

    // Far past the frame interval, but inside the gap: on a slow backend the
    // buffer always satisfies the interval by the time inference returns.
    feed(repeat(voice, 40));
    await tick();
    assert.equal(transcribeCalls, 1, 'the frame interval alone would have fired several more here');

    transcriber._testing.setInterimMinGapMs(0);
    feed(repeat(voice, 1));
    await tick();
    assert.equal(transcribeCalls, 2, 'once the gap elapses the next caption goes');
});

test('a busy-pipeline skip retries on the next frame instead of waiting out a new interval', async () => {
    await ready;
    transcriber._testing.setInterimMinGapMs(0);
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

// Silence long enough for the VAD to end an utterance (BALANCED needs 8).
const END_OF_UTTERANCE = 10;

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

// ── DSP & Helper Unit Tests ──

test('calculateRMS correctly computes RMS on aligned and unaligned buffers', () => {
    const { calculateRMS } = transcriber._testing;
    const empty = Buffer.alloc(0);
    assert.equal(calculateRMS(empty), 0);

    // Constant 8000 PCM
    const buf = Buffer.alloc(4800);
    for (let i = 0; i < 2400; i++) buf.writeInt16LE(8000, i * 2);
    const expected = 8000 / 32768;
    const actual = calculateRMS(buf);
    assert.ok(Math.abs(actual - expected) < 1e-6, `Expected ~${expected}, got ${actual}`);

    // Unaligned byte offset (odd byteOffset)
    const container = Buffer.alloc(5000);
    for (let i = 0; i < 2400; i++) container.writeInt16LE(8000, 1 + i * 2);
    const unalignedSlice = container.subarray(1, 1 + 4800);
    assert.equal(unalignedSlice.byteOffset % 2, 1);
    const unalignedRMS = calculateRMS(unalignedSlice);
    assert.ok(Math.abs(unalignedRMS - expected) < 1e-6, `Unaligned RMS: expected ~${expected}, got ${unalignedRMS}`);
});

test('pcm16ToFloat32 converts int16 samples accurately', () => {
    const { pcm16ToFloat32 } = transcriber._testing;
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(16384, 2);
    buf.writeInt16LE(32767, 4);
    buf.writeInt16LE(-32768, 6);

    const f32 = pcm16ToFloat32(buf);
    assert.equal(f32.length, 4);
    assert.equal(f32[0], 0);
    assert.ok(Math.abs(f32[1] - 0.5) < 1e-4);
    assert.ok(Math.abs(f32[2] - 32767 / 32768) < 1e-5);
    assert.equal(f32[3], -1.0);
});

test('collapseRepetitions correctly removes repetition loops', () => {
    const { collapseRepetitions } = transcriber._testing;
    assert.equal(collapseRepetitions(''), '');
    assert.equal(collapseRepetitions('hello'), 'hello');
    // Single word: 2 repeats is allowed, 3 repeats collapses to 1, 4 repeats (2 pairs of 2-gram) collapses to 2
    assert.equal(collapseRepetitions('very very good'), 'very very good');
    assert.equal(collapseRepetitions('very very very good'), 'very good');
    assert.equal(collapseRepetitions('very very very very good'), 'very very good');
    assert.equal(collapseRepetitions('very very very very very good'), 'very good');
    // Multi-word phrase: 2+ repeats collapses
    assert.equal(collapseRepetitions('this is this is a test'), 'this is a test');
    assert.equal(collapseRepetitions('how to design how to design how to design a cache'), 'how to design a cache');
});

test('filterHallucinations detects and removes stock hallucination patterns', () => {
    const { filterHallucinations } = transcriber._testing;
    assert.equal(filterHallucinations('Thank you for watching.'), '');
    assert.equal(filterHallucinations('Subscribe to my channel!'), '');
    assert.equal(filterHallucinations('Subtitles by amara.org'), '');
    assert.equal(filterHallucinations('नमस्ते'), 'नमस्ते'); // meaningful Hindi greeting
    assert.equal(filterHallucinations('जी'), 'जी');
    assert.equal(filterHallucinations('हाँ'), 'हाँ');
    assert.equal(filterHallucinations('तो'), 'तो');
    assert.equal(filterHallucinations('कब'), 'कब');
    assert.equal(filterHallucinations('सब'), 'सब');
    assert.equal(filterHallucinations('दो'), 'दो');
    assert.equal(filterHallucinations('अ'), ''); // isolated vowel noise
    assert.equal(filterHallucinations('ं'), ''); // isolated anusvara noise
    assert.equal(filterHallucinations('सब्सक्राइब करें'), ''); // Hindi subscribe hallucination
    assert.equal(filterHallucinations('How do I scale Redis?'), 'How do I scale Redis?');
});

const quietVoice = () => frame(200);
const background = () => frame(131);
const clearVoice = () => frame(655);
const dip = () => frame(262);

test('a quiet source (well under the old fixed gate) still produces a transcript', async () => {
    await ready;
    transcriber.resetTranscriber();
    transcribeCalls = 0;
    const got = collectTranscripts();
    transcribeImpl = async () => 'quiet but real';

    feed([...repeat(silence, 12), ...repeat(quietVoice, 15), ...repeat(silence, END_OF_UTTERANCE)], 'speaker');
    await tick();
    await tick();

    assert.equal(got.length, 1, 'system audio off a phone call sits near 0.006 RMS and must not be gated out');
    assert.equal(got[0].source, 'speaker');
});

test('a dip below the entry gate does not chop one utterance into fragments', async () => {
    await ready;
    transcriber.resetTranscriber();
    transcribeCalls = 0;
    const got = collectTranscripts();
    transcribeImpl = async () => 'one whole sentence';

    feed(repeat(background, 15), 'speaker');
    feed([...repeat(clearVoice, 6), ...repeat(dip, 10), ...repeat(clearVoice, 6)], 'speaker');
    feed(repeat(background, END_OF_UTTERANCE), 'speaker');
    await tick();
    await tick();

    assert.equal(got.length, 1, 'a 1s inter-syllable dip is not an end of turn');
});

const loudVoice = () => frame(3277);
const betweenSentences = () => frame(230);

test('a pause well below the talker own level ends the turn instead of running on', async () => {
    await ready;
    transcriber.resetTranscriber();
    transcribeCalls = 0;
    const got = collectTranscripts();
    transcribeImpl = async () => 'one turn';

    feed(repeat(background, 15), 'speaker');
    feed([...repeat(loudVoice, 15), ...repeat(betweenSentences, END_OF_UTTERANCE), ...repeat(loudVoice, 15)], 'speaker');
    feed(repeat(background, END_OF_UTTERANCE), 'speaker');
    await tick();
    await tick();

    assert.equal(got.length, 2, 'a gap 22dB under the speech level is a turn boundary, not a syllable dip');
});

test('a segment holding almost no voiced audio is discarded instead of transcribed', async () => {
    await ready;
    transcriber.resetTranscriber();
    transcribeCalls = 0;
    const got = collectTranscripts();
    transcribeImpl = async () => 'Saffið talaði.';

    feed(repeat(background, 15), 'speaker');
    feed([...repeat(clearVoice, 2), ...repeat(background, END_OF_UTTERANCE)], 'speaker');
    await tick();
    await tick();

    assert.equal(transcribeCalls, 0, '0.2s of speech padded with silence is what Whisper hallucinates on');
    assert.equal(got.length, 0);
});

test('trimSegment keeps the speech plus a short roll and counts voiced frames', () => {
    const { trimSegment } = transcriber._testing;
    const pcm16k = value => {
        const buf = Buffer.alloc(3200);
        for (let i = 0; i < 1600; i++) buf.writeInt16LE(value, i * 2);
        return buf;
    };
    const frames = [...repeat(() => pcm16k(0), 10), ...repeat(() => pcm16k(8000), 5), ...repeat(() => pcm16k(0), 10)];

    const trimmed = trimSegment(frames, 0.01);
    assert.equal(trimmed.voiced, 5);
    assert.equal(trimmed.frames.length, 13);

    const allSilent = trimSegment(
        repeat(() => pcm16k(0), 12),
        0.01
    );
    assert.equal(allSilent.voiced, 0);
    assert.equal(allSilent.frames.length, 0);
});

test('speechThresholds starts at the configured gate, then adapts down for a quiet source', () => {
    const { speechThresholds, updateNoiseFloor } = transcriber._testing;
    const stream = { noiseFloor: 0.012 / 3 };
    assert.ok(Math.abs(speechThresholds(stream).start - 0.012) < 1e-9, 'an unadapted stream behaves exactly like the old fixed threshold');

    for (let i = 0; i < 20; i++) updateNoiseFloor(stream, 0);
    const adapted = speechThresholds(stream);
    assert.ok(adapted.start < 0.012 && adapted.start >= 0.003 - 1e-9);
    assert.ok(adapted.sustain < adapted.start, 'staying in an utterance must be easier than entering one');

    const loud = { noiseFloor: 0.004 };
    for (let i = 0; i < 200; i++) updateNoiseFloor(loud, 0.25);
    assert.ok(loud.noiseFloor <= 0.012 + 1e-9, 'the tracked floor is clamped so speech cannot lift the gate without bound');
    assert.ok(speechThresholds(loud).start <= 0.03 + 1e-9);
});

test('normalizeLevel lifts quiet audio toward the target without touching loud audio', () => {
    const { normalizeLevel } = transcriber._testing;
    const rmsOf = a => Math.sqrt(a.reduce((sum, v) => sum + v * v, 0) / a.length);

    const quiet = new Float32Array(100).fill(0.005);
    assert.ok(Math.abs(rmsOf(normalizeLevel(quiet)) - 0.06) < 1e-4);

    const loud = new Float32Array(100).fill(0.5);
    assert.equal(rmsOf(normalizeLevel(loud)), 0.5);

    const spiky = new Float32Array(100000).fill(0.001);
    spiky[0] = 0.9;
    const normalized = normalizeLevel(spiky);
    assert.ok(normalized[0] <= 0.971, 'gain is capped so a transient cannot be pushed into clipping');
    assert.ok(normalized[0] > 0.9);

    assert.equal(normalizeLevel(new Float32Array(0)).length, 0);
    assert.equal(rmsOf(normalizeLevel(new Float32Array(10))), 0);
});

const LEAKED_PROMPT =
    'यह एक स्वाभाविक हिंदी और हिंग्लिश बातचीत है। आम शब्द: तुम, आप, क्या, क्यों, कैसे, कहाँ, कब, आज, कल, यार, ना, ' +
    'बताना, सुनाओ, ऑफिस, काम, घर, खाना, फिल्म, गाना, रील, weekend, message, call, funny, really, okay.';

test('stripPromptLeak recovers the real speech when Whisper reads the bias prompt back', () => {
    const { stripPromptLeak } = transcriber._testing;

    assert.equal(stripPromptLeak(`${LEAKED_PROMPT} ये सब चीजे, सोचो फेर`, LEAKED_PROMPT), 'ये सब चीजे, सोचो फेर');
    assert.equal(
        stripPromptLeak(`${LEAKED_PROMPT} वे, ${LEAKED_PROMPT} झाल`, LEAKED_PROMPT),
        'वे, झाल',
        'the prompt is read back repeatedly, so every occurrence must go'
    );
    assert.equal(stripPromptLeak(LEAKED_PROMPT, LEAKED_PROMPT), '', 'a transcript that is only the prompt has no speech in it');

    const partial = LEAKED_PROMPT.slice(0, 60) + ' झाल';
    assert.equal(stripPromptLeak(partial, LEAKED_PROMPT), '', 'a partial read-back is still contamination, not a transcript');

    const clean = 'तुम पता है, अकाउंटिंग के भी सॉफ्टवेयर होते हैं।';
    assert.equal(stripPromptLeak(clean, LEAKED_PROMPT), clean, 'real speech is untouched');
    assert.equal(stripPromptLeak(clean, ''), clean, 'no prompt configured means nothing to strip');
    assert.equal(stripPromptLeak('', LEAKED_PROMPT), '');
});

test('languageOptions forces the language token rather than letting a Hindi model auto-detect', () => {
    const { languageOptions } = transcriber._testing;
    const pipe = generation_config => ({ model: { generation_config } });
    const LANGS = { '<|en|>': 50259, '<|hi|>': 50276 };

    assert.deepEqual(
        languageOptions(pipe({ is_multilingual: false, lang_to_id: LANGS }), 'hi'),
        { language: 'hi', task: 'transcribe', is_multilingual: true },
        'a fine-tune with a language table is multilingual underneath; auto-detect picks English on Hindi audio'
    );
    assert.deepEqual(languageOptions(pipe({ is_multilingual: true, lang_to_id: LANGS }), 'hi'), {
        language: 'hi',
        task: 'transcribe',
        is_multilingual: true,
    });
    assert.equal(languageOptions(pipe({ is_multilingual: false }), 'en'), null, 'a genuine .en build has no table and rejects the options');
    assert.deepEqual(
        languageOptions(pipe({}), 'hi'),
        { language: 'hi', task: 'transcribe' },
        'a config that states neither keeps the previous behaviour'
    );
    assert.deepEqual(languageOptions(null, 'hi'), { language: 'hi', task: 'transcribe' });
});

test('filterLanguageMismatch drops the Icelandic/English text Whisper hallucinates in a Hindi session', () => {
    const { filterLanguageMismatch } = transcriber._testing;

    for (const hallucination of ['Eki af honum.', 'Görðu, hvaðu?', 'Mér þykir að písa.', 'Já.', 'Okay, maybe I know it out.', 'Saffið talaði.']) {
        assert.equal(filterLanguageMismatch(hallucination, 'hi'), '', `expected "${hallucination}" to be dropped`);
    }

    for (const mixed of ['Vigalekar, kominu meðan bræðinni, hér ekki. कि यह लोग्वा', 'हुslungið hún þigbað að vera leikin hóðaðast.']) {
        assert.equal(filterLanguageMismatch(mixed, 'hi'), '', 'a Devanagari fragment glued onto Icelandic must not smuggle it through');
    }

    for (const real of [
        'तुम पता है, अकाउंटिंग के भी सॉफ्टवेयर होते हैं।',
        'UK, US, Indian, तिनो अलग अकाउंटेंट्स बहुत डिफरेंट आ जाता है',
        'हो गाई थी 945 मेन देखाला',
    ]) {
        assert.equal(filterLanguageMismatch(real, 'hi'), real, 'Hinglish keeps Latin words alongside Devanagari and must survive');
    }

    assert.equal(filterLanguageMismatch('How do I scale Redis?', 'en'), 'How do I scale Redis?', 'English sessions are unaffected');
    assert.equal(filterLanguageMismatch('', 'hi'), '');
    assert.equal(filterLanguageMismatch(null, 'hi'), null);
});

test('lowpass24k and resample24kTo16k maintain state and downsample accurately', () => {
    const { lowpass24k, resample24kTo16k } = transcriber._testing;
    const stream = {
        antiAliasHistory: new Float32Array(94),
        resampleRemainder: Buffer.alloc(0),
        antiAliasScratch: null,
    };

    // 2400 samples at 24kHz -> 1600 samples at 16kHz
    const input = Buffer.alloc(4800);
    for (let i = 0; i < 2400; i++) input.writeInt16LE(4000, i * 2);

    const filtered = lowpass24k(input, stream);
    assert.equal(filtered.length, 4800);

    const resampled = resample24kTo16k(filtered, stream);
    assert.equal(resampled.length, 3200); // 1600 samples * 2 bytes
});
