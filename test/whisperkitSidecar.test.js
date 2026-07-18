// Tests for the WhisperKit sidecar serve invocation — specifically that the
// vocabulary-bias prompt is passed through to the CLI only when set.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === './gemini') return { sendToRenderer() {} };
    return originalLoad.call(this, request, parent, isMain);
};

const sidecar = require(path.join(__dirname, '..', 'src', 'utils', 'whisperkitSidecar.js'));
const { buildServeArgs } = sidecar._testing;

test('serve args without a context prompt omit --prompt', () => {
    const args = buildServeArgs('large-v3-v20240930', 'en', '');
    assert.ok(!args.includes('--prompt'));
    assert.deepEqual(args.slice(0, 3), ['serve', '--model', 'large-v3-v20240930']);
    assert.ok(args.includes('--language'));
});

test('serve args with a context prompt append --prompt <vocabulary>', () => {
    const vocab = 'Software engineering interview covering: XSS, CSRF, frontend, backend.';
    const args = buildServeArgs('large-v3-v20240930', 'en', vocab);
    const i = args.indexOf('--prompt');
    assert.notEqual(i, -1);
    assert.equal(args[i + 1], vocab);
});
