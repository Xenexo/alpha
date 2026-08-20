# Background Desktop Meeting Assistant: Architecture & Specification

## 1. Executive Summary & Value Proposition

This document specifies the architecture, data pipelines, and product strategy for a **bot-free, background desktop meeting transcription and summarization assistant** built for **macOS** and **Windows** using **Electron**, **React/Shadcn**, and **native audio capture helpers**.

### Core Value Proposition

- **No Meeting Bots**: Runs entirely in the background on the user's desktop, capturing both sides of any call (Zoom, Microsoft Teams, Google Meet, Slack Huddles, Webex) without sending a recording bot into the meeting.
- **Physical "You" vs Remote Speaker Separation**: Automatically labels microphone input as **"You"** (the user) and separates remote participants into **"Speaker 1, Speaker 2..."** via acoustic clustering.
- **Privacy-First & Zero-Cloud Option**: Audio is captured and transcribed 100% locally via Whisper; meetings can be summarized locally or through state-of-the-art cloud LLMs (Claude 3.5 Sonnet / GPT-4o).
- **Ultra-Low Resource Footprint**: Optimized C++/Swift native helpers and zero-copy 16 kHz DSP ring buffers consume $<2–3\%$ CPU and minimal memory.

---

## 2. Market Landscape & Pricing Strategy

### Competitive Comparison

| Product          | Architecture & Capture                          | Platforms          | Diarization / Features                 | Pricing                               |
| :--------------- | :---------------------------------------------- | :----------------- | :------------------------------------- | :------------------------------------ |
| **Granola**      | Desktop native audio capture (bot-free)         | macOS, Windows     | System audio + mic notes, AI templates | **$14/mo** (Business); Free basic     |
| **Krisp AI**     | Native background audio filter + meeting notes  | macOS, Windows     | On-device noise cancellation + notes   | **$8–$16/mo** (Billed annual/monthly) |
| **Superwhisper** | Native local AI dictation & transcription       | macOS, iOS         | Local Whisper models, dictation focus  | **$8.49/mo** or **$249 lifetime**     |
| **Limitless**    | Desktop background timeline listener            | macOS, Web, Device | Cross-meeting context, calendar sync   | **$19–$29/mo**                        |
| **MacWhisper**   | Desktop local Whisper file / live transcription | macOS              | On-device STT, speaker diarization     | **$6.99/mo** or **$69 one-time**      |

### Recommended Pricing Tiers

1. **Free Starter (Viral Hook & Local Utility)**:
    - Up to 10 meetings / month (~300 minutes).
    - On-device Whisper transcription (`tiny` / `base` / `small`).
    - Basic summary and action items.
2. **Pro Plan ($12 / month or $99 / year) — Primary Commercial Tier**:
    - Unlimited meetings & unlimited transcription hours.
    - High-accuracy Whisper (`large-v3-turbo`) + Speaker Diarization ("You" vs "Speaker 1, 2, ...").
    - Claude 3.5 Sonnet / GPT-4o meeting intelligence (Executive Summary, Key Decisions, Action Items with Owners, Follow-up Email Generator).
    - Instant full-text search across all meeting history.
    - Integrations: Export to Notion, Slack, Google Docs, CRM.
3. **Lifetime / BYOK Tier ($69 one-time)**:
    - Bring Your Own API Key (Anthropic / OpenAI) or local Ollama.
    - Zero recurring server cost to provider; ideal for privacy-sensitive corporate and developer users.

### Unit Economics (Pro Tier)

- **Local Transcription Cost**: **$0.00** (runs on-device via Apple Neural Engine / CPU DirectML).
- **Cloud LLM Summarization (Claude 3.5 Sonnet)**:
    - Average meeting: 4,000 prompt tokens + 600 completion tokens $\approx \$0.021$ per meeting.
    - Active user (40 meetings / month) $\approx \mathbf{\$0.84 / \text{month}}$.
- **Gross Margin**: **$>92\%$** at $12/month.

---

## 3. High-Level System Architecture

```
                         ┌─────────────────────────────┐
                         │      Electron Renderer      │
                         │    React / Shadcn / Vite    │
                         │                             │
                         │ UI / Meeting Controls       │
                         │ Live / Past Transcript View │
                         │ Summary & Action Item Editor│
                         └──────────────┬──────────────┘
                                        │ IPC
                         ┌──────────────▼──────────────┐
                         │     Electron Main Process   │
                         │                             │
                         │ Session & Meeting Lifecycle │
                         │ Native Helper Child Manager │
                         │ SQLite Transcript Store     │
                         └───────┬───────────┬─────────┘
                                 │           │
                    Control IPC  │           │  Control IPC
                                 │           │
              ┌──────────────────▼─┐       ┌─▼──────────────────┐
              │    macOS Helper    │       │   Windows Helper   │
              │                    │       │                    │
              │ Swift (ScreenCaptureKit)   │ C++ / Rust (WASAPI)│
              │ Mic + System Audio │       │ Mic + System Audio │
              └──────────┬─────────┘       └──────────┬─────────┘
                         │                            │
                         └────────────┬───────────────┘
                                      │
                              Raw Binary PCM Pipe
                                      │
                         ┌────────────▼────────────┐
                         │     Audio Ingestion     │
                         │                         │
                         │ Channel 0: Microphone   │
                         │ Channel 1: System Audio │
                         │ Resampling → 16 kHz Mono│
                         │ Monotonic Timestamping  │
                         └────────────┬────────────┘
                                      │
                         ┌────────────▼────────────┐
                         │   Real-Time Pipeline    │
                         │                         │
                         │ Dual Ring Buffers       │
                         │ VAD (Voice Activity)    │
                         │ Software Echo Filter    │
                         │ Pre-roll / Post-roll    │
                         └────────────┬────────────┘
                                      │
                         ┌────────────▼────────────┐
                         │     Speech Segments     │
                         │                         │
                         │ { stream, start_ms,     │
                         │   end_ms, pcm_data }    │
                         └────────────┬────────────┘
                                      │
                         ┌────────────▼────────────┐
                         │      STT Engine         │
                         │                         │
                         │ WhisperKit (macOS ANE)  │
                         │ whisper.cpp / ONNX (Win)│
                         │ Speaker Diarization     │
                         └────────────┬────────────┘
                                      │
                                      ▼
                         ┌─────────────────────────┐
                         │  SQLite Transcript DB   │
                         │                         │
                         │ FTS5 Full Text Search   │
                         │ Speaker Timeline Store  │
                         └────────────┬────────────┘
                                      │
                    ┌─────────────────┴────────────────┐
                    │                                  │
                    ▼                                  ▼
          ┌──────────────────────┐          ┌──────────────────────┐
          │ Local AI Processing  │          │ Cloud AI Coordinator │
          │                      │          │                      │
          │ Local Ollama / Llama │          │ Claude 3.5 Sonnet    │
          │ Offline Summary      │          │ Structured Summary   │
          │ Keyword Search       │          │ Action Items & Email │
          └──────────────────────┘          └──────────────────────┘
```

---

## 4. Audio Ingestion & Native Capture Subsystem

### A. macOS Native Helper (Swift + ScreenCaptureKit)

- **Framework**: `ScreenCaptureKit` (macOS 12.3+) for capturing clean system audio directly from the audio server without kernel extensions or virtual audio drivers (no Soundflower/BlackHole required).
- **Microphone**: `AVAudioEngine` or CoreAudio input tap.
- **Entitlements**:
    - `NSScreenCaptureUsageDescription` (System Audio capture permission).
    - `NSMicrophoneUsageDescription` (Microphone access).

### B. Windows Native Helper (C++ / Rust + WASAPI Loopback)

- **Framework**: `IAudioClient` with `AUDCLNT_STREAMFLAGS_LOOPBACK` on the default render endpoint to capture system/meeting audio.
- **Microphone**: Standard WASAPI capture endpoint on default input device.
- **Device Invalidation**: Implements `IMMNotificationClient` to listen for audio device switches (e.g. user plugging in/unplugging headphones) and cleanly re-initializes endpoints without terminating recording.

### C. Binary IPC Stream Protocol

The helper process streams audio chunks to Electron Main over `stdout` using a low-overhead 16-byte header:

```
┌─────────────────┬───────────────────┬──────────────────┬────────────────────┐
│  Stream ID (4B) │ Timestamp ms (8B) │ Payload Len (4B) │ PCM16 Data (N B)   │
│  0=Mic, 1=Sys   │ Monotonic Epoch   │ Little Endian    │ 16kHz Little-Endian│
└─────────────────┴───────────────────┴──────────────────┴────────────────────┘
```

---

## 5. DSP & Voice Activity Detection (VAD)

1. **Downsampling to 16 kHz Mono**: All incoming audio is converted immediately to 16,000 Hz 16-bit Linear PCM Little-Endian.
2. **Scratch Buffer Allocation**: Employs reusable TypedArray scratch buffers and alignment-safe views (`Int16Array`) to avoid garbage collection pressure during continuous audio streams.
3. **Voice Activity Detection**:
    - Calculates integer sum-of-squares RMS energy.
    - Evaluates frame energy against speech threshold (`RMS > 0.008`).
    - Maintains a 4-frame pre-speech buffer (0.4s pre-roll) to preserve the onset consonants of spoken words.
    - Triggers speech-end after 10 consecutive silence frames (~1.0s silence).
4. **Echo Suppression**:
    - Compares mic speech fragments against recent speaker audio and previous output tokens.
    - Discards acoustic echo turns when the speaker output bleeds into the laptop microphone.

---

## 6. Speaker Diarization & Timeline Interleaving

```
   [Mic Channel]        ──► ALWAYS "You" (User)
   [System Channel]     ──► Acoustic Embedding (ECAPA-TDNN) ──► Cluster ──► "Speaker 1", "Speaker 2"...
```

### Diarization Workflow

1. **Channel 0 (Microphone)**: Assigned directly as **"You"** (User).
2. **Channel 1 (System Audio)**:
    - Voice segments from the system stream are passed through a lightweight ONNX acoustic speaker embedding model (~15MB, e.g. ECAPA-TDNN / Sherpa-ONNX).
    - Generates 192-dimensional speaker embeddings per utterance.
    - Runs Agglomerative Hierarchical Clustering (AHC) with a cosine similarity threshold of `0.75` to partition voices into `Speaker 1`, `Speaker 2`, etc.
3. **Post-Processing Name Enrichment**:
    - The LLM parses the transcript for vocative address patterns (_"Thanks for explaining that, Alex"_, _"Dave, what do you think?"_) and updates speaker labels to actual participant names.

---

## 7. Storage & Full-Text Search Schema

The Electron Main process manages a local SQLite database (`better-sqlite3`) equipped with SQLite's `FTS5` extension.

```sql
-- Core Meeting Records
CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_seconds INTEGER,
    summary_markdown TEXT,
    action_items_json TEXT,
    key_decisions_json TEXT,
    created_at INTEGER NOT NULL
);

-- Chronological Transcript Turns
CREATE TABLE transcript_turns (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,          -- 'mic' | 'system'
    speaker TEXT NOT NULL,          -- 'You' | 'Speaker 1' | 'Sarah'
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL
);

-- Full-Text Search Virtual Index
CREATE VIRTUAL TABLE transcripts_fts USING fts5(
    meeting_id UNINDEXED,
    speaker,
    text,
    content='transcript_turns',
    content_rowid='rowid'
);
```

---

## 8. AI Summarization & Note Generation

### Output Structure

The post-meeting LLM generation produces structured, action-oriented meeting artifacts:

1. **Executive Summary**: 2–3 sentence overview of the meeting's purpose and outcomes.
2. **Key Decisions Made**: Bulleted list of agreed decisions.
3. **Action Items & Owners**: Table of tasks, assigned owners, and deadlines.
4. **Follow-Up Email Draft**: Ready-to-send email summarizing next steps for all attendees.
5. **Full Chronological Transcript**: Speaker-diarized transcript with timestamps.

---

## 9. Implementation Roadmap

### Phase 1: Dual-Stream Audio Capture Foundation

- [ ] Build macOS Swift helper utilizing `ScreenCaptureKit` + CoreAudio microphone capture.
- [ ] Build Windows C++ helper using WASAPI Loopback + microphone capture.
- [ ] Implement binary IPC streaming protocol with 16-byte header over `stdout`.
- [ ] Connect streams to the optimized 16 kHz resampler and zero-copy VAD pipeline.

### Phase 2: Local Whisper Transcription & UI

- [ ] Integrate on-device Whisper (WhisperKit on Apple Silicon, `whisper.cpp` on Windows/Intel).
- [ ] Set up local SQLite database with `FTS5` full-text search.
- [ ] Build Electron Renderer meeting UI (React, Vite, Shadcn UI) with live transcript strip and past meeting explorer.

### Phase 3: Speaker Diarization

- [ ] Tag mic stream as "You".
- [ ] Integrate ONNX speaker embedding model (`sherpa-onnx` / ECAPA-TDNN) for system audio clustering.
- [ ] Implement timeline interleave and LLM name-inference pass.

### Phase 4: Summaries & Subscription Monetization

- [ ] Implement Claude 3.5 Sonnet / OpenAI structured summarization pipeline.
- [ ] Add export integrations (Notion, Markdown, Clipboard, Slack).
- [ ] Integrate payment gateway (Stripe / LemonSqueezy) for Pro subscription licensing.
