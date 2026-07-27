# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`help-guru` / "alpha" — an Electron desktop app (fork of [sohzm/help-guru](https://github.com/sohzm/help-guru)) that
captures screen + audio in real time and feeds them to an AI for contextual answers (interview/meeting assistant).
Plain JavaScript, CommonJS in the main process, ES modules + [Lit](https://lit.dev) web components in the renderer.
No TypeScript, no bundler, no build step for app code — Electron loads `src/index.html` directly.

## Commands

```bash
npm install
npm start                 # electron-forge start (dev)
node --test "test/*.js"   # run the test suite (quote the glob; `node --test test/` fails)
npx prettier --write .    # run before committing — 4-space indent, width 150, single quotes
npm run make              # package installers (dmg / squirrel / appimage)
```

There is no linter (`npm run lint` is a stub) and no `npm test` script. Tests are `node:test` +
`node:assert`, stubbing Electron and `child_process` via `Module._load` interception so nothing real
is spawned.

## Architecture

### Processes

1. **Main** (`src/index.js`) — creates the window via `utils/window.js`, registers every `ipcMain`
   handler (`storage:*`, general, plus provider handlers from `utils/gemini.js`), tears down the
   transcription backends on `before-quit`.
2. **Renderer** — `src/index.html` loads Lit components plus `src/utils/renderer.js`. The window runs
   with `nodeIntegration: true` and `contextIsolation: false` (see the TODO in `utils/window.js`), so
   the renderer `require()`s `electron` directly; `src/preload.js` is an empty stub. All design tokens
   are CSS variables declared in `index.html`'s `:root`.
3. **Hidden Whisper window** (`src/whisper-worker.html` + `src/whisper/whisperWorker.js`) — a
   pure-browser context used only to reach WebGPU for Whisper inference. `whisperPreload.js` bridges
   IPC into it. Anything that enumerates windows must exclude this one (it has no UI, and
   `BrowserWindow.getAllWindows()` order is not guaranteed) — `sendToRenderer` filters on the
   `whisper-worker` URL.

### AI providers

`utils/gemini.js` is the hub despite its name: it owns provider state (`currentProviderMode`:
`'byok' | 'cloud' | 'local' | 'claude'`), session/history bookkeeping, macOS `SystemAudioDump`
capture, and `sendToRenderer`. Every audio/text/image entry point branches on the mode and delegates:

| mode    | module                 | transport                                              |
| ------- | ---------------------- | ------------------------------------------------------ |
| `byok`  | `utils/gemini.js`      | Google GenAI live session with the user's key          |
| `cloud` | `utils/cloud.js`       | WebSocket to `api.cheatingdaddy.com`                   |
| `local` | `utils/localai.js`     | Ollama                                                 |
| `claude`| `utils/claude.js`      | Claude Code CLI (persistent), CLI one-shot, SDK, or API |

`claude.js` and `localai.js` import from `gemini.js` and `gemini.js` lazily `require()`s them back —
the getter functions (`getClaude()`, `getLocalAi()`) exist to break that cycle. Keep new
providers on the same pattern. Heavy SDKs (`@anthropic-ai/sdk`, `@google/genai`) are also lazily
required so app startup stays fast.

`utils/claude.js` is the most intricate module: a warm `claude` CLI process in stream-json mode is the
primary transport (questions over stdin, interrupt-based supersede), with one-shot CLI spawns, the
Claude Code SDK, and the Anthropic API as progressively degraded fallbacks. It exports
`module.exports._testing` as a deliberate seam for tests — extend it rather than exporting internals
publicly.

### Transcription pipeline

`utils/transcriber.js` is shared by the `local` and `claude` providers (only one is active at a time):
24 kHz PCM from the renderer → resample to 16 kHz → VAD → Whisper. It picks a backend once per session
in this order and treats them as interchangeable:

1. **ANE** — `utils/whisperkitSidecar.js`, spawns `whisperkit-cli serve` on `127.0.0.1:50861` and POSTs
   16 kHz mono WAVs to its OpenAI-compatible endpoint. Preferred: Core ML on the Neural Engine.
2. **WebGPU** — `utils/whisperWindow.js`, promise-based `loadModel()`/`transcribe()` over request-id-matched
   IPC to the hidden window.
3. **CPU** — `@huggingface/transformers` in the main process.

Stay on the Whisper family — it handles Indian accents better than the alternatives tried here.
`whisperkitSidecar.js` mirrors `whisperWindow.js`'s surface on purpose; preserve that when editing either.
The pipeline emits streaming interim transcripts while speech is ongoing and queues split segments FIFO
(a long utterance's parts belong to one question, so they must not replace each other).

### Storage

`src/storage.js` — plain JSON files under `~/Library/Application Support/help-guru-config` (macOS;
`%APPDATA%/help-guru-config` on Windows, `~/.config/help-guru-config` on Linux), split into
`config.json`, `credentials.json`, `preferences.json`, `keybinds.json`, `limits.json`, and a
per-session history directory. `CONFIG_VERSION` bumps reset the config. The renderer never touches
these files — it goes through the `storage:*` IPC wrappers exposed as `storage` in `utils/renderer.js`.

### UI

`src/components/app/CheatingDaddyApp.js` (custom element `<help-guru-app>`) is the shell and router;
views live in `src/components/views/`. Note that `src/components/index.js` is stale — it exports
`AdvancedView`, which no longer exists, and views are imported directly by path rather than through it.
`src/index.html` also still references a non-existent `script.js`. Global shortcuts are registered in
`utils/window.js` from stored keybinds.

## Conventions

- Four-space indent, single quotes, semicolons, 150-column width — enforced only by Prettier.
- Comments in this codebase explain *why*, often at length, especially around timing, fallback order,
  and Electron/OS quirks. Match that: if a constant or ordering is load-bearing, say why it is.
- Modules keep state in file-level closures and export a small `// ── Public API ──` block at the bottom.
- IPC channels are namespaced with a colon (`storage:get-config`, `whisper:transcribe`).
- Prefer editing the existing provider/backend modules over adding parallel ones; the branch-on-mode
  dispatch in `gemini.js` is the single place new providers get wired in.
- `AGENTS.md` documents the project's aspirations (TypeScript, React, shadcn/ui, Jest). None of that
  has landed — the code is Lit + plain JS with `node:test`. Read it for intent, not for current state.
