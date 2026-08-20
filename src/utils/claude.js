let _Anthropic = null;
function getAnthropic() {
    if (!_Anthropic) _Anthropic = require('@anthropic-ai/sdk');
    return _Anthropic;
}
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getSystemPrompt, profilePrompts } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn, saveScreenAnalysis } = require('./gemini');
const transcriber = require('./transcriber');
const storage = require('../storage');

// ── State ──

let claudeMode = 'cli'; // 'cli' | 'api'
let anthropicClient = null;
let claudeModel = 'claude-haiku-4-5-20251001';
let claudeConversationHistory = [];
let currentSystemPrompt = null;
let isClaudeActive = false;
// When true, captured audio is dropped before transcription so listening pauses.
// Audio capture stays alive, so toggling back resumes instantly. All audio routes
// (macOS SystemAudioDump, send-audio-content, send-mic-audio-content) funnel through
// processClaudeAudio, so this single gate covers every platform and source.
let isAudioMuted = false;
let isTranscriptResponseInFlight = false;
let pendingTranscripts = [];
let transcriptDebounceTimer = null;
// Supersede state: when the interviewer keeps talking after an auto-answer has
// already been fired (feedback → pause → real question), the stale in-flight
// request is aborted and re-sent combined with the new speech, instead of
// making the real question wait behind a useless answer.
let lastSentTranscriptTurn = null; // text of the in-flight auto request, for recombination
let inFlightIsSupersedable = false; // only flushPendingTranscripts-initiated requests
let pendingFirstQueuedAt = 0; // when the oldest pending fragment arrived
// A finalized transcript dispatches immediately after the merge debounce —
// never held back because the transcription pipeline looks busy. Speech that
// arrives after dispatch supersedes the in-flight answer instead (see below),
// which costs one cancelled request but keeps time-to-first-answer low.
// During continuous speech a new transcript lands every few seconds — if each
// one were allowed to abort the in-flight answer, no answer would ever finish
// (the exact "listening but never answering" failure). Cap how many times one
// answer chain can be superseded; after that the answer runs to completion and
// the newer speech is flushed as the next turn.
let supersedeCount = 0;
const MAX_SUPERSEDES = 2;
// When the answer request started, for stall detection. The runClaudeQuery
// watchdog should always unwind a hung request; if that ever fails, a stuck
// isTranscriptResponseInFlight would silently block every future answer, so
// force-clear it after the watchdog deadline plus slack.
let inFlightStartedAt = 0;
const IN_FLIGHT_STALL_MS = 135000;

function clearStalledInFlight() {
    if (!isTranscriptResponseInFlight || !inFlightStartedAt) return;
    const age = Date.now() - inFlightStartedAt;
    if (age <= IN_FLIGHT_STALL_MS) return;
    console.error(`[Claude] In-flight response stalled for ${age}ms — force-clearing so answers resume`);
    isTranscriptResponseInFlight = false;
    inFlightIsSupersedable = false;
    lastSentTranscriptTurn = null;
    inFlightStartedAt = 0;
    if (activeCliAbort) activeCliAbort.abort();
}
// Rolling window of everything recently heard — including fragments suppressed
// by isMeaningfulTranscript — so the user can manually ask Claude to answer
// speech that was heard but not auto-answered (see answerWithContext).
let recentHeardTranscripts = [];
const RECENT_HEARD_MAX = 8;
// The clean text of the most recent question that was actually answered. Answers
// default to a short 3-5 line paragraph; expandLastAnswer() re-asks Claude for
// the in-depth version of THIS question on demand (button / shortcut).
let lastAnsweredQuestion = null;

// ── The user's own speech (mic) ──
//
// Speech from the 'mic' source is the user answering out loud, not a question
// for Claude. It NEVER triggers a response and never supersedes an in-flight
// one — it accumulates here and rides along as context on the next interviewer
// question, so the answer builds on what the user already said instead of
// repeating it or contradicting their framing.
//
// Only speech not yet handed to Claude is kept: both transports retain
// conversation history (the persistent CLI session, or claudeConversationHistory
// in api mode), so re-sending an already-sent block would waste tokens and
// re-assert stale context.
let unsentUserSpeech = [];
const USER_SPEECH_MAX = 12;
// Source label for push-to-talk audio: physically the mic, but intentionally
// addressed to Claude, so it is answered rather than recorded as context.
const MIC_ASK_SOURCE = 'mic-ask';
// A whole answer's worth of the user's speech is legitimately long; cap the
// injected block so one rambling answer can't crowd out the actual question.
const USER_SPEECH_CONTEXT_CHARS = 1200;

// Rolling window of recent interviewer speech, kept purely to detect echo (see
// looksLikeEcho). Unlike recentHeardTranscripts this is NOT cleared when a
// question is answered — the echo of a question can arrive on the mic after the
// answer has already started.
let recentSpeakerSpeech = [];
let recentSpeakerSpeechSets = [];
const RECENT_SPEAKER_MAX = 6;
// The last answer Claude produced. In speaker (audio-only) mode the app reads
// answers aloud, so the mic hears them; without this they would be recorded as
// the user's own speech and fed back as context.
let lastAnswerText = '';
let lastAnswerSet = null;

function setLastAnswerText(text) {
    lastAnswerText = text || '';
    if (!lastAnswerText.trim()) {
        lastAnswerSet = null;
    } else {
        const words = echoTokens(lastAnswerText);
        lastAnswerSet = words.length > 0 ? new Set(words) : null;
    }
}

// Unless headphones are in use, the mic also picks up the interviewer coming out
// of the laptop speakers (and, in speaker mode, the app's own spoken answer).
// Re-labelling that as "the user said it" would poison the context, so drop mic
// transcripts that substantially repeat something we just heard or just said.
const ECHO_OVERLAP_RATIO = 0.7;

function echoTokens(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function looksLikeEcho(text) {
    const words = echoTokens(text);
    // Under a few words the overlap ratio is noise — "yeah okay right" would
    // match almost any reference. Short mic fragments are cheap to keep.
    if (words.length < 4) return false;
    const len = words.length;
    const targets = lastAnswerSet ? [...recentSpeakerSpeechSets, lastAnswerSet] : recentSpeakerSpeechSets;
    for (let t = 0; t < targets.length; t++) {
        const referenceWords = targets[t];
        if (!referenceWords || referenceWords.size === 0) continue;
        let hits = 0;
        for (let i = 0; i < len; i++) {
            if (referenceWords.has(words[i])) hits++;
        }
        if (hits / len >= ECHO_OVERLAP_RATIO) return true;
    }
    return false;
}

// Record interviewer speech for later echo comparison.
function rememberSpeakerSpeech(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    recentSpeakerSpeech.push(trimmed);
    const words = echoTokens(trimmed);
    recentSpeakerSpeechSets.push(words.length > 0 ? new Set(words) : null);
    if (recentSpeakerSpeech.length > RECENT_SPEAKER_MAX) {
        recentSpeakerSpeech = recentSpeakerSpeech.slice(-RECENT_SPEAKER_MAX);
        recentSpeakerSpeechSets = recentSpeakerSpeechSets.slice(-RECENT_SPEAKER_MAX);
    }
}

// The user spoke. Remember it as context and tell the UI — but do not answer it.
function recordUserSpeech(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;

    if (looksLikeEcho(trimmed)) {
        console.log('[Claude] Mic transcript looks like speaker/answer echo — ignoring:', trimmed.substring(0, 60));
        return;
    }

    unsentUserSpeech.push(trimmed);
    if (unsentUserSpeech.length > USER_SPEECH_MAX) {
        unsentUserSpeech = unsentUserSpeech.slice(-USER_SPEECH_MAX);
    }
    console.log('[Claude] Recorded your speech as context (not answering):', trimmed.substring(0, 80));
    // Shown in the transcript strip labelled "You" — the user asked to see
    // their own speech even though it produces no answer.
    sendToRenderer('user-transcript', trimmed);
}

// The context block for the next interviewer question, or '' when the user has
// not said anything new. Does NOT consume the buffer — a superseded or failed
// request is resent, and the context has to survive to ride along with it.
// clearUserSpeechContext() is called only once an answer actually lands.
function peekUserSpeechContext() {
    if (unsentUserSpeech.length === 0) return '';
    const speech = unsentUserSpeech.join(' ').replace(/\s+/g, ' ').trim();
    if (!speech) return '';
    // Keep the tail — the most recent thing the user said is the most relevant
    // to the question that just followed it.
    return speech.length > USER_SPEECH_CONTEXT_CHARS ? '…' + speech.slice(-USER_SPEECH_CONTEXT_CHARS) : speech;
}

function clearUserSpeechContext() {
    unsentUserSpeech = [];
}

// Wrap an interviewer question with whatever the user has said since the last
// turn. The labels are explicit because the model must answer exactly one of
// the two blocks — the failure mode to avoid is it responding to the user's own
// words as if they were the question.
function withUserSpeechContext(question) {
    const userSpeech = peekUserSpeechContext();
    if (!userSpeech) return question;
    console.log('[Claude] Attaching', userSpeech.length, 'chars of your speech as context');
    return (
        `[WHAT I ALREADY SAID OUT LOUD — CONTEXT ONLY, DO NOT ANSWER OR REPLY TO THIS]\n` +
        `"${userSpeech}"\n\n` +
        `[THE OTHER PERSON JUST ASKED — ANSWER ONLY THIS]\n` +
        `${question}`
    );
}

// The VAD already waits ~1s of end-of-utterance silence before a transcript is
// produced, so this debounce only needs to catch transcripts split across that
// boundary — not re-wait for the user to finish. Keep it short so Claude is
// contacted promptly; raising it adds pure latency before every response.
const TRANSCRIPT_DEBOUNCE_MS = 100;
// Whisper reliably punctuates, so a fragment that ends mid-sentence (no
// terminal punctuation) almost always means the speaker is still building the
// question — long system-design prompts arrive as several such fragments.
// Waiting a bit longer merges them into ONE request instead of firing early
// and burning the supersede budget (every supersede aborts and restarts the
// answer, which costs far more than this extra debounce). Fragments that end
// like a finished sentence keep the fast path.
const TRANSCRIPT_CONTINUATION_DEBOUNCE_MS = 650;
const SENTENCE_FINAL_RE = /[.?!][)"'\]]*$/;
const RESPONSE_UPDATE_INTERVAL_MS = 50;

function nextFlushDelay() {
    const tail = pendingTranscripts.length ? pendingTranscripts[pendingTranscripts.length - 1].trim() : '';
    if (!tail) return TRANSCRIPT_DEBOUNCE_MS;
    return SENTENCE_FINAL_RE.test(tail) ? TRANSCRIPT_DEBOUNCE_MS : TRANSCRIPT_CONTINUATION_DEBOUNCE_MS;
}

function scheduleFlush(delay = nextFlushDelay()) {
    if (transcriptDebounceTimer) clearTimeout(transcriptDebounceTimer);
    transcriptDebounceTimer = setTimeout(flushPendingTranscripts, delay);
}

// Claude Code CLI state. The installed `claude` binary is the primary
// transport for all text requests — normally through one long-lived
// stream-json process (see the persistent session block below) so each
// question costs API latency, not a fresh CLI boot. The SDK is kept only as a
// one-shot fallback (see sendClaudeText), because the bundled SDK version can
// lag the installed CLI and its child process has been observed exiting with
// code 1 while the binary itself works.
let cliPath = null; // resolved and validated once per app run
let cliEnv = null;
let cliUnavailable = false; // no working binary found — go straight to the SDK
let cliResolutionPromise = null; // de-dupes concurrent resolution attempts
let cliSessionId = null; // session_id from --resume, keeps conversation context
let activeCliProc = null; // in-flight CLI subprocess handle
let activeCliAbort = null; // AbortController for the in-flight request (CLI or SDK)
const CLI_TIMEOUT_MS = 120000;
// Watchdog for SDK queries. A hung request would otherwise keep
// isTranscriptResponseInFlight true forever and silently stop all answers.
const QUERY_TIMEOUT_MS = 120000;
const WARMUP_TIMEOUT_MS = 15000;
// Session activation no longer waits for the Claude warm-up: audio starts as
// soon as Whisper is ready, and transcripts queue behind this flag until the
// transport has been prepared (or the warm-up gave up). The warm-up is
// bounded by WARMUP_TIMEOUT_MS, so the wait always ends; the cap below is a
// safety net so a lost ready signal can never hold a question forever.
let isTransportReady = false;
const TRANSPORT_WAIT_MAX_MS = 20000;
// Incremented on every session init/close so background work from a previous
// session (warm-up completion callbacks) can detect it is stale and do nothing.
let sessionGeneration = 0;

// Lazy-loaded @anthropic-ai/claude-code query function
let _queryFn = null;
async function getQueryFn() {
    if (!_queryFn) {
        const sdk = await import('@anthropic-ai/claude-code');
        _queryFn = sdk.query;
    }
    return _queryFn;
}

const API_MAX_TOKENS = 2048;
// Structured system-design answers and on-demand expansions legitimately run
// long — give them headroom without slowing every ordinary reply.
const API_MAX_TOKENS_DETAILED = 4096;
const API_MAX_TOKENS_SPOKEN = 400;
const CLAUDE_CONCISE_RESPONSE_PROMPT = `

**CLAUDE REAL-TIME RESPONSE RULES — HIGHEST PRIORITY:**
- NEVER ask the candidate clarifying questions or request more details. They are mid-interview and cannot relay your questions back to the interviewer — asking is useless and breaks the flow. This rule has NO exceptions.
- When a question is open-ended or under-specified (e.g. "design a RAG system", "how would you build X", "design a rate limiter"), do NOT ask which language, database, framework, or scale to assume. State your assumptions in one short line (e.g. "Assuming Python + pgvector on Postgres:") and immediately give a complete, confident answer the candidate can speak. Choosing reasonable assumptions and defending them IS what "design X" questions are testing.
- For system design questions specifically, do NOT try to hit every textbook criterion (requirements, estimation, HLD, DB, API, scaling, bottlenecks, failure handling, trade-offs) in one short answer — that reads as shallow, not thorough. Instead pick the 2-3 points the question is actually probing (infer from its wording — "scale to millions" means capacity/sharding, "financial data" means consistency/correctness) and go one level deeper on those, explicitly naming the trade-off/why. It is fine and expected to leave other angles unmentioned in the short answer.
- Start with the direct answer. Do not add an introduction or restate the question.
- RESPONSE STRUCTURE FOR INTERVIEW QUESTIONS: Format every answer into two distinct sections:
  ⚡ **Quick Summary (1-2 Lines Max):** (1-2 direct, punchy sentences the candidate can speak out loud immediately)
  📋 **Detailed Breakdown:** (Structured bullet points, STAR method details, architecture trade-offs, or code snippet)
- Structure: section 1 is the 1-2 line spoken summary; section 2 gives the 2-3 key technical points, trade-offs, or concrete code/steps.
- For code questions, give the approach in one sentence followed by the necessary code (code does not count toward the line cap).
- If asked to demonstrate, share a demo, implement live, or do hands-on coding, ignore the normal length limit. Give: (1) a one-line approach, (2) ordered implementation steps, (3) complete runnable code, and (4) exact commands to run or verify it.
- During demos and hands-on coding, keep commentary minimal and prioritize executable instructions and code.
- Within the 3-5 line budget, prefer substance (the single most useful technique or a concrete example) over caveats, summaries, or offers to help. Never add follow-up or clarifying questions — there are no exceptions to this.
- Never continue past 5 lines once the question is answered (unless code is required or a detailed expansion was explicitly requested).
- The input is a live speech transcript. An upstream filter has ALREADY removed pure filler and bare acknowledgements, so treat whatever reaches you as a genuine attempt to ask something and ALWAYS produce a substantive answer.
- Speech-to-text frequently mangles technical terms and acronyms, especially with accented speech. FIRST reconstruct the most plausible intended words from the sound and the conversation context, THEN answer the intended question. Examples: "X? is a tag", "excess attack", or "six seasons" in a security context mean "XSS attack"; "front and" means "frontend"; "sea sharp" means "C#"; "no js" means "Node.js". Strip a leading wake-word or name ("Bane", "Claude", "hey"), collapse duplicated words, and drop hallucinated trailing fragments.
- ALWAYS ANSWER — never reply with nothing. If the intended question is unclear even after reconstruction, pick the single most likely question from the topic anchors present, state it in one short line ("Assuming you're asking …:"), and answer it. A best-effort answer is always better than silence.
- NO META-COMMENTARY about the transcript. Never say "too garbled", "I can't understand", "sounds like noise/background", "broken transcript", or otherwise describe or apologize for the input. Either answer directly, or state your one-line assumption and answer.
- Worked example — input: "Bane, explain quickly, quickly, how a CDN Works, you know what I some disadvantage is advantage is of having a sitting on. I'm sure I love" → reconstruct to "Explain how a CDN works, plus the advantages and disadvantages of using one" (drop "Bane", the "quickly, quickly" repeat, and the "I'm sure I love" tail; "sitting on" ≈ CDN) → answer with the 3-7 line CDN explanation and its pros/cons. Do NOT respond that it is garbled.
- Never respond with pleasantries such as "You're welcome", "No problem", or "Glad to help" — these are not answers.
- Some turns arrive with a block labelled "[WHAT I ALREADY SAID OUT LOUD — CONTEXT ONLY, DO NOT ANSWER OR REPLY TO THIS]". That is the candidate's OWN speech, captured from their microphone. NEVER answer it, comment on it, grade it, or treat it as a question. Answer only the block labelled "[THE OTHER PERSON JUST ASKED — ANSWER ONLY THIS]".
- Use that context block to make the answer continue from where the candidate left off: do NOT repeat points they already made, keep the assumptions, stack, and framing they already committed to out loud (if they said "I'd use Postgres", do not switch to MongoDB), and pick up the specific thread the new question probes. If they stated something wrong and the new question exposes it, correct it in one short line and move on — never lecture them about it.
`;

// Conversational profiles (relationship) need proactive suggestions on
// statements and stories — the exact behavior the concise ruleset suppresses —
// so they get this variant instead. Noise/garble handling stays identical.
const CLAUDE_CONVERSATIONAL_RESPONSE_PROMPT = `

**CLAUDE REAL-TIME RESPONSE RULES — HIGHEST PRIORITY:**
- You MUST provide BOTH: (1) The exact words/answer to say back, AND (2) Topic suggestions for what to talk about next.
- Structure every response strictly into two concise sections:

💬 **What to say:**
[1-2 warm, natural spoken sentences to reply out loud]

💡 **Next Topic Suggestions:**
• 🔥 **Latest:** [Region-specific trend: viral regional reels/memes, new OTT/movie releases, sports, or local weekend plans]
• ⏳ **Old / Nostalgic:** [Shared memory, childhood story, or deep question]

- 💬 **What to say** is spoken aloud verbatim by the user on a live call. It may contain ONLY words a person would say to their partner. NEVER mention searching, tools, permissions, what you can or cannot do, or anything about yourself — if you lack information, just say something natural and human instead, or ask her a normal question.
- Reply in the same language/mix as the transcript (Hinglish stays Hinglish, English stays English).
- In Hindi/Hinglish, use “tum” by default and never “tu.” Mirror “aap” only if she is already using it.
- Keep the overall response short, clear, and easy to scan at a single glance during a live call.
`;

const CLAUDE_CONVERSATIONAL_SEARCH_RULE = `- Use web search for the 🔥 **Latest** suggestion so it is genuinely current and regionally relevant (e.g. India / regional trends when Hindi/Hinglish is spoken). If a search does not return in time, fall back to a plausible suggestion and never mention the search.
`;

function conversationalResponseRules() {
    return webSearchEnabled ? CLAUDE_CONVERSATIONAL_RESPONSE_PROMPT + CLAUDE_CONVERSATIONAL_SEARCH_RULE : CLAUDE_CONVERSATIONAL_RESPONSE_PROMPT;
}

const CLAUDE_MEETING_RESPONSE_PROMPT = `

**CLAUDE REAL-TIME RESPONSE RULES FOR BUSINESS MEETINGS — HIGHEST PRIORITY:**
- You MUST provide BOTH: (1) What to say back in the meeting, AND (2) A live meeting summary with key discussion points and action items.
- Structure every response strictly into two concise sections:

💬 **What to say:**
[1-2 clear, professional spoken sentences to reply or contribute directly out loud]

📌 **Meeting Summary & Key Points:**
• 📝 **Discussion:** [1-2 bullet points summarizing the core topic discussed so far]
• ✅ **Decisions / Action Items:** [Key decisions made or assigned next steps with owners]

- Always keep the meeting summary updated based on the conversation history and latest speaker turn.
- Keep the overall response short, clear, and easy to scan at a single glance during a live meeting.
`;

// A question is treated as a system-design prompt when it asks to design/
// architect/build a system or names a canonical design-interview target.
// Detection only gates the per-turn instruction block below — a false
// negative just falls back to the normal concise answer, so the patterns
// favor precision over recall.
const SYSTEM_DESIGN_QUESTION_RE = new RegExp(
    [
        'system design|high[ -]?level design|low[ -]?level design|\\bhld\\b|\\blld\\b',
        '\\bdesign (an? |the )?(architecture|schema|data model)\\b',
        '\\b(design|architect)\\b[^.?!]{0,50}\\b(system|service|platform|application|app|api|backend|infrastructure|pipeline)\\b',
        '\\bhow (would|will|do|should|can) (you|we|i) (design|architect|scale|build)\\b',
        "\\blet'?s design\\b",
        '\\b(design|build|architect|create)\\b[^.?!]{0,50}\\b(scalable|distributed|real[ -]?time|fault[ -]?tolerant|highly available)\\b',
        '\\b(design|build)\\b[^.?!]{0,60}\\b(url shortener|tiny ?url|rate limiter|news ?feed|notification (system|service)|chat (app|application|system|service)|whatsapp|messenger|telegram|instagram|twitter|facebook|linkedin|youtube|netflix|spotify|uber|lyft|ola|airbnb|booking\\.com|ticket ?(master|ing|booking)|dropbox|google (drive|docs|maps)|typeahead|autocomplete|web crawler|search engine|leaderboard|parking lot|elevator|vending machine|splitwise|payment (system|gateway)|digital wallet|stock (exchange|trading|broker)|food delivery|swiggy|zomato|doordash|e-?commerce|flipkart|key[ -]?value store|message (queue|broker)|pub[ -]?sub|job scheduler|task scheduler|distributed (cache|lock|queue|file system)|object storage|logging system|ad click|live (stream|video)|video streaming)\\b',
    ].join('|'),
    'i'
);

function isSystemDesignQuestion(text) {
    if (!text) return false;
    // Behavioral questions about past design work ("tell me about a time you
    // designed...") want a STAR answer, not an architecture walkthrough.
    if (/tell me about a time|describe a time|walk me through a (project|time)/i.test(text)) return false;
    return SYSTEM_DESIGN_QUESTION_RE.test(text);
}

// Injected ahead of a detected system-design question for that turn only.
// The default 3-5 line cap reads as shallow on a design prompt; this replaces
// it with the interview framework (clarify → estimate → architect → deep-dive
// → trade-offs), still formatted to be read aloud. Trade-offs are mandatory —
// design interviews score trade-off reasoning above raw component coverage.
const SYSTEM_DESIGN_TURN_RULES = `[SYSTEM DESIGN QUESTION — STRUCTURED ANSWER MODE, THIS TURN ONLY]
The 3-5 line cap does NOT apply to this turn. Pick the shape that fits and answer in it:

1) FULL HLD (asks to design/architect a whole system) — give a speakable walkthrough with these bold section names, 1-3 tight lines each, in this order:
- **Scope**: one line restating the goal + the 2-3 core features you'll design for; one line of assumed scale (DAU, peak QPS, read/write ratio, data size). Pick round, defensible numbers — never ask.
- **Requirements**: 2-3 functional; the 2-3 non-functional ones that actually constrain this design (latency target, availability, consistency).
- **Capacity**: quick arithmetic from your assumptions — QPS, storage, cache size. One line each, show the math.
- **Architecture**: the request path in order (client → CDN/LB → gateway → services → cache → DB → queue → workers → storage/search), one line per component on WHY it exists. Include only what this system needs.
- **Data model**: key tables/collections with primary key + shard/partition key + the critical index. Name the DB and why (SQL vs NoSQL in one line).
- **API**: 2-4 core endpoints, one line each. Mention idempotency/pagination only where it matters.
- **Deep dive**: the 2-3 areas THIS question is really probing (infer from wording — "millions of users" → sharding/caching, "real-time" → WebSockets/fan-out, "financial" → consistency/idempotency). Go one level deeper only here.
- **Trade-offs**: the 2-3 decisions an interviewer will challenge (SQL vs NoSQL, cache-aside vs write-through, push vs pull, strong vs eventual consistency). State your pick + one-line why. NEVER skip this section.
- **Scale & failure**: one line on the first bottleneck at 10x and its fix; one line on the worst failure (DB/region down) and the mitigation.

2) LLD / object design (classes for a parking lot, elevator, chess...): **Entities** (core classes + responsibilities) → **Relationships** (is-a / has-a) → sketch of the 2-3 central classes (key attributes/methods) → **Patterns** used and why (Strategy/Factory/Observer/State...) → **Concurrency** (what needs locking or atomicity) → one **Extensibility** line.

3) FOLLOW-UP PROBE (one component/concern of a design already under discussion — "how would you shard this", "what if the cache dies", "why Kafka here"): no template. Answer that point directly in 3-6 lines, one level deeper than the obvious answer, and END with the governing trade-off in one line.

All shapes: bold section names, short bullets, round numbers, no intro, no closing summary, no questions back.`;

// Whisper conditions its decoder on preceding text, so seeding it with domain
// vocabulary steers ambiguous audio toward the terms actually being spoken —
// this is what turns accented "XSS attack" into "XSS attack" instead of
// "X? is a tag" or "six seasons". Passed to the WhisperKit sidecar as its
// --prompt for the interview profile; every other profile skips it so speech
// that isn't software engineering isn't dragged toward tech jargon. Keep it
// well under Whisper's 224-token prompt window.
const WHISPER_TECH_CONTEXT_PROMPT =
    'Software engineering interview covering: XSS, CSRF, SQL injection, OAuth, JWT, REST API, GraphQL, gRPC, frontend, backend, full-stack, ' +
    'React, Node.js, TypeScript, Python, Kubernetes, Docker, CI/CD, microservices, caching, Redis, Kafka, rate limiting, load balancer, ' +
    'system design, HLD, LLD, sharding, consistent hashing, replication, partitioning, CAP theorem, eventual consistency, quorum, leader election, ' +
    'CDN, WebSocket, long polling, pub/sub, fan-out, message queue, idempotency, backpressure, QPS, DAU, p99 latency, throughput, ' +
    'PostgreSQL, DynamoDB, Cassandra, MongoDB, S3, Elasticsearch, API gateway, circuit breaker, bloom filter, LRU cache, TTL, ' +
    'data structures, algorithms, Big O, hash map, binary tree, heap, linked list, SQL, NoSQL, concurrency, mutex, deadlock, design patterns.';

// Whisper's prompt sets the *script and style* it expects to emit, not just the
// vocabulary. Conditioning a Hindi session on the all-Latin English prompt
// above drags the decoder toward English output — it romanizes or mistranslates
// Hindi speech instead of writing Devanagari. The Hindi prompt is therefore
// written in Devanagari, but keeps the technical terms in Latin script: Indian
// interviews are spoken in Hinglish, where the jargon stays English even when
// the sentence around it is Hindi, and that is exactly the mix we want back.
const WHISPER_TECH_CONTEXT_PROMPT_HI =
    'सॉफ्टवेयर इंजीनियरिंग इंटरव्यू की बातचीत। विषय: XSS, CSRF, SQL injection, OAuth, JWT, REST API, GraphQL, gRPC, frontend, backend, ' +
    'React, Node.js, TypeScript, Python, Kubernetes, Docker, CI/CD, microservices, caching, Redis, Kafka, rate limiting, load balancer, ' +
    'system design, HLD, LLD, sharding, consistent hashing, replication, partitioning, CAP theorem, eventual consistency, ' +
    'CDN, WebSocket, pub/sub, message queue, idempotency, QPS, p99 latency, throughput, PostgreSQL, DynamoDB, Cassandra, MongoDB, S3, ' +
    'Elasticsearch, API gateway, LRU cache, TTL, data structures, algorithms, Big O, hash map, binary tree, heap, linked list, SQL, NoSQL, ' +
    'concurrency, mutex, deadlock, design patterns. उम्मीदवार हिंदी और अंग्रेज़ी मिलाकर बोलता है।';

// Relationship calls often switch between Hindi and English word-by-word.
// A small, conversational bias helps Whisper preserve Devanagari Hindi rather
// than translating it or drifting into unrelated English subtitle text.
const WHISPER_RELATIONSHIP_CONTEXT_PROMPT_HI =
    'यह एक स्वाभाविक हिंदी और हिंग्लिश बातचीत है। आम शब्द: तुम, आप, क्या, क्यों, कैसे, कहाँ, कब, आज, कल, यार, ना, ' +
    'बताना, सुनाओ, ऑफिस, काम, घर, खाना, फिल्म, गाना, रील, weekend, message, call, funny, really, okay.';

const WHISPER_GENERAL_CONTEXT_PROMPT_HI =
    'यह एक स्वाभाविक हिंदी और हिंग्लिश बातचीत है। आम शब्द: तुम, आप, क्या, क्यों, कैसे, कहाँ, कब, आज, कल, यार, ना, ' +
    'बताना, सुनाओ, काम, घर, बात, फोन, शॉपिंग, मार्केट, फिल्म, गाना, रील, weekend, message, call, okay, right.';

let webSearchEnabled = true;

function readWebSearchPreference() {
    try {
        return storage.getPreferences().googleSearchEnabled === true;
    } catch (error) {
        console.warn('[Claude] Could not read googleSearchEnabled preference, defaulting to off:', error.message);
        return false;
    }
}

const CLAUDE_SPOKEN_TURN_RULES = `[SPEAKER-ONLY MODE — THIS ANSWER IS SPOKEN ALOUD, NEVER READ]
Your reply is passed straight to a text-to-speech voice in the user's ear while they are mid-conversation. Nobody sees it. These rules override every formatting and length rule above.
- Plain spoken prose only: no markdown, no headings, no section labels, no bullets, no numbering, no emoji, no code fences, no URLs, no parentheses, no slashes, no abbreviations like "e.g." or "i.e.".
- One or two sentences. 30 words maximum. Answer only what was asked and stop.
- Put the answer in the first few words. No preamble, no restating the question, no closing offer.
- Write it the way a person says it out loud: short words, spelled-out symbols and units, numbers a voice can read.
- For code, say the approach in one sentence instead of dictating syntax.
- If a list is unavoidable, name at most three things joined by "then".
`;

function readSpeakerModePreference() {
    try {
        return storage.getPreferences().speakerMode === true;
    } catch (error) {
        console.warn('[Claude] Could not read speakerMode preference, defaulting to off:', error.message);
        return false;
    }
}

let autoAnswerEnabled = true;

function readAutoAnswerPreference() {
    try {
        return storage.getPreferences().autoAnswer !== false;
    } catch (error) {
        console.warn('[Claude] Could not read autoAnswer preference, defaulting to on:', error.message);
        return true;
    }
}

function cliAllowedTools() {
    return webSearchEnabled ? ['Read', 'WebSearch', 'WebFetch'] : ['Read'];
}

// Profiles whose speech is software engineering. exam and mcq are
// subject-agnostic, so this vocabulary would drag a biology or finance question
// toward Kafka and mutexes. Unknown profiles resolve to interview, as in
// getSystemPrompt.
const TECHNICAL_PROFILES = new Set(['interview']);

function whisperContextPromptForProfile(profile, language = 'en') {
    const resolved = profilePrompts[profile] ? profile : 'interview';
    if (resolved === 'relationship') {
        return language === 'hi' ? WHISPER_RELATIONSHIP_CONTEXT_PROMPT_HI : '';
    }
    if (TECHNICAL_PROFILES.has(resolved)) {
        return language === 'hi' ? WHISPER_TECH_CONTEXT_PROMPT_HI : WHISPER_TECH_CONTEXT_PROMPT;
    }
    return language === 'hi' ? WHISPER_GENERAL_CONTEXT_PROMPT_HI : '';
}

// Whisper hallucinates stock phrases on silence/noise (subtitle artifacts) and
// the speaker emits acknowledgements ("thanks", "okay", "got it") that are not
// questions. Answering these produces the out-of-context, "thank you"-style
// replies users complain about, so drop them before they ever reach Claude.
const TRANSCRIPT_NOISE_PATTERNS = [
    /^thank(s| you)?( (so|very) much)?( for watching| for listening)?$/,
    /^thanks for watching!?$/,
    /^thank you( very much)?\.?$/,
    /^(please )?(don'?t forget to )?(subscribe|like and subscribe)( to my channel)?!?$/,
    /^bye(-?bye)?\.?$/,
    /^you'?re welcome\.?$/,
    /^(o?k(ay)?|alright|right|sure|yeah|yep|yes|no|nope|uh|um|hmm|mhm|cool|nice|great|got it|i see|of course|no problem)\.?$/,
    // Conversational lead-ins ("Okay, so", "right, so", "well, um") — the
    // speaker is winding up to say something, but nothing has been asked yet.
    // These are short multi-word fragments, so the single-word gate below
    // misses them. Genuine short questions end with "?" and never match.
    /^(o?k(ay)?|alright|all right|right|so|well|now|anyway|and|but|then|yeah|you know|i mean|let'?s see)((,| )+(so|then|well|yeah|now|right|o?kay?|um+|uh+|anyway|you know|i mean))*[,.!…]*$/,
    // Punctuation / symbols only. Must be Unicode-aware: bare `\W` is
    // [^A-Za-z0-9_], so every Devanagari character counts as punctuation and a
    // whole Hindi utterance would be discarded as noise.
    /^[^\p{L}\p{N}]*$/u,
];

// Hindi filler and acknowledgements, the Devanagari counterparts of the English
// list above. Whisper also hallucinates Hindi subtitle boilerplate on silence
// ("नमस्कार", channel sign-offs), so those go here too.
const TRANSCRIPT_NOISE_PATTERNS_HI = [
    /^(ठीक|ठीक है|अच्छा|हाँ|हां|जी|जी हाँ|नहीं|हम्म|अरे|ओके|ओहो|बस|सही|बिल्कुल|शुक्रिया|धन्यवाद|नमस्ते|नमस्कार|अलविदा)[।.!,…]*$/,
    /^(देखने के लिए धन्यवाद|सब्सक्राइब कर(ें|िए)|चैनल को सब्सक्राइब कर(ें|िए))[।.!]*$/,
    // Lead-ins: "तो", "अच्छा तो", "हाँ जी तो" — winding up, nothing asked yet.
    /^(तो|अच्छा|ठीक|हाँ|हां|जी|अब|फिर|और|लेकिन|मतलब|यानी)((,| )+(तो|अच्छा|ठीक|हाँ|हां|जी|अब|फिर|और|लेकिन|मतलब|यानी|ओके))*[।.!,…]*$/,
];

const DEVANAGARI_RE = /[ऀ-ॿ]/;
const ALL_TRANSCRIPT_NOISE_PATTERNS = [...TRANSCRIPT_NOISE_PATTERNS, ...TRANSCRIPT_NOISE_PATTERNS_HI];

// A meaningful turn for a real-time answer assistant is one Claude should
// actually respond to: not pure filler, not a bare acknowledgement, and long
// enough to carry intent. Whisper noise is usually a single short token.
function isMeaningfulTranscript(text) {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized) return false;
    const hasDevanagari = DEVANAGARI_RE.test(normalized);
    const patterns = hasDevanagari ? ALL_TRANSCRIPT_NOISE_PATTERNS : TRANSCRIPT_NOISE_PATTERNS;
    for (let i = 0; i < patterns.length; i++) {
        if (patterns[i].test(normalized)) return false;
    }
    // Single-word, non-question fragments are almost always filler or noise.
    // Hindi output rarely carries a "?" (Whisper ends the sentence with "।"),
    // so an interrogative word counts as a question marker there instead.
    const isQuestion =
        /\?[।.!…\s]*$/.test(normalized) ||
        (hasDevanagari && /(क्या|क्यों|कैसे|कब|कहाँ|कहां|कौन|कितना|कितने|कितनी|बताओ|बताइए|समझाओ|समझाइए)/.test(normalized));
    const wordCount = normalized.split(' ').length;
    if (wordCount < 2 && !isQuestion) return false;
    return true;
}

async function flushPendingTranscripts() {
    transcriptDebounceTimer = null;
    clearStalledInFlight();
    if (!isClaudeActive || isTranscriptResponseInFlight || pendingTranscripts.length === 0) {
        if (pendingTranscripts.length > 0) {
            console.log('[Claude] Flush deferred —', !isClaudeActive ? 'session not active' : 'response already in flight');
        }
        return;
    }

    // Claude transport still warming up — keep the transcript queued instead
    // of racing the warm-up or dropping the user's first question. Bounded:
    // the warm-up itself times out, and past the cap we just send anyway.
    if (!isTransportReady && Date.now() - pendingFirstQueuedAt < TRANSPORT_WAIT_MAX_MS) {
        sendToRenderer('update-status', 'Claude preparing — your question is queued...');
        transcriptDebounceTimer = setTimeout(flushPendingTranscripts, 250);
        return;
    }

    const transcription = pendingTranscripts.join(' ').trim();
    pendingTranscripts = [];
    if (!transcription) return;
    // Guard the merged turn too: several filler fragments can debounce together.
    if (!isMeaningfulTranscript(transcription)) {
        console.log('[Claude] Merged transcript filtered as noise/filler:', transcription);
        return;
    }

    // Stage timing: how long the transcript waited between Whisper finishing
    // and the Claude request being dispatched (debounce + any transport hold).
    console.log(`[Claude] Dispatching transcript ${Date.now() - pendingFirstQueuedAt}ms after it was queued`);
    console.log('[Claude] Flushing transcript to Claude:', transcription.substring(0, 80));
    isTranscriptResponseInFlight = true;
    inFlightStartedAt = Date.now();
    lastSentTranscriptTurn = transcription;
    inFlightIsSupersedable = true;
    // Surface what was heard so the live view can show which question each
    // answer is responding to.
    sendToRenderer('new-transcript', transcription);
    sendToRenderer('update-status', 'Generating response...');

    try {
        // Anything the user said out loud since the last turn rides along as
        // labelled context so the answer continues from where they left off.
        // recordAsQuestion stays the clean interviewer text so "expand" and the
        // saved history target the real question, not the wrapper.
        const result = await sendClaudeText(withUserSpeechContext(transcription), { recordAsQuestion: transcription });
        if (result.success) {
            // This speech has been answered; don't let a later manual trigger
            // re-answer it. Keep only fragments heard after this turn started.
            recentHeardTranscripts = [];
            // The user's speech is now in the transport's conversation history —
            // only clear it here, so a superseded or failed request still resends it.
            clearUserSpeechContext();
            supersedeCount = 0;
        } else if (result.error !== 'Cancelled') {
            // The chain ended (not superseded) — next answer starts fresh.
            supersedeCount = 0;
            if (/no response/i.test(result.error || '')) {
                // Claude followed the "reply with nothing for garbled speech"
                // rule. Tell the user instead of leaving "Generating response..."
                // stuck, and point at the manual override.
                sendToRenderer(
                    'update-status',
                    `No answer — speech may be unclear. Press ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+G to force an answer`
                );
            }
        }
    } finally {
        isTranscriptResponseInFlight = false;
        inFlightIsSupersedable = false;
        lastSentTranscriptTurn = null;
        inFlightStartedAt = 0;
        if (isClaudeActive && pendingTranscripts.length > 0) {
            scheduleFlush();
        }
    }
}

function queueTranscript(transcription) {
    if (!isClaudeActive) {
        console.log('[Claude] Transcript dropped — session not active yet:', transcription.substring(0, 60));
        return;
    }
    // Remember everything heard (even suppressed fragments) so the user can
    // later force an answer on out-of-context speech via answerWithContext.
    const heard = transcription.trim();
    if (heard) {
        rememberSpeakerSpeech(heard);
        recentHeardTranscripts.push(heard);
        if (recentHeardTranscripts.length > RECENT_HEARD_MAX) {
            recentHeardTranscripts = recentHeardTranscripts.slice(-RECENT_HEARD_MAX);
        }
    }
    // Drop hallucinated/filler fragments so they neither show as a "question"
    // nor trigger a response. Real fragments still merge via the debounce.
    if (!isMeaningfulTranscript(transcription)) {
        console.log('[Claude] Transcript filtered as noise/filler:', heard.substring(0, 60));
        if (heard)
            sendToRenderer(
                'update-status',
                `Heard: "${heard.length > 40 ? heard.slice(0, 40) + '…' : heard}" — say more or use Answer With Context (${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+G)`
            );
        return;
    }
    if (!autoAnswerEnabled) {
        console.log('[Claude] Auto answer off — transcript kept as context only:', heard.substring(0, 60));
        sendToRenderer('new-transcript', heard);
        sendToRenderer('update-status', `Auto answer off — press ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+G to answer`);
        return;
    }

    pendingTranscripts.push(transcription);
    if (pendingTranscripts.length === 1) pendingFirstQueuedAt = Date.now();

    // Merge phrases separated by short VAD pauses. If an auto-answer is already
    // in flight, it's now stale (the speaker kept going — e.g. feedback followed
    // by the real question): abort it and let the finally-re-flush resend the
    // already-sent text combined with the new speech as one prompt. Manual
    // answers (answerWithContext) are never aborted.
    clearStalledInFlight();
    if (isTranscriptResponseInFlight) {
        console.log(
            `[Claude] Response in flight (${Math.round((Date.now() - inFlightStartedAt) / 1000)}s, ` +
                `supersedes ${supersedeCount}/${MAX_SUPERSEDES}) — new transcript ${
                    inFlightIsSupersedable && supersedeCount < MAX_SUPERSEDES ? 'supersedes it' : 'will flush after'
                }`
        );
        if (inFlightIsSupersedable && supersedeCount < MAX_SUPERSEDES) {
            supersedeCount++;
            if (lastSentTranscriptTurn) {
                pendingTranscripts.unshift(lastSentTranscriptTurn);
                lastSentTranscriptTurn = null; // no double-prepend on rapid supersedes
            }
            if (activeCliAbort) activeCliAbort.abort();
            // Let the UI replace the now-stale partial answer/transcript with
            // the combined resend instead of stacking a junk card per supersede.
            sendToRenderer('response-superseded');
            sendToRenderer('update-status', 'Heard more — updating answer...');
        }
        return; // the in-flight finally re-flushes after the debounce
    }
    scheduleFlush();
}

// Every finished transcript enters here. The source decides whether it is a
// question to answer or context to remember — the whole point of running two
// audio streams. 'mic' is the user talking (context only); 'speaker' is the
// other person (answered); MIC_ASK_SOURCE is push-to-talk, which is mic audio
// the user deliberately addressed to Claude, so it is answered.
function routeTranscript(transcription, { source } = {}) {
    if (source === 'mic') {
        recordUserSpeech(transcription);
        return;
    }
    queueTranscript(transcription);
}

// Manual override: the speaker said something that was heard but not
// auto-answered (filtered as out-of-context, or just not phrased as a clear
// question). Instead of waiting, the user triggers this to make Claude go
// ahead and answer the recent speech using the full conversation context.
async function answerWithContext() {
    if (!isClaudeActive) {
        return { success: false, error: 'No active Claude session' };
    }
    if (isTranscriptResponseInFlight) {
        return { success: false, error: 'Already responding' };
    }

    // Prefer anything pending; otherwise fall back to the recently heard
    // window (which includes fragments suppressed by the noise filter).
    const heard = [...pendingTranscripts, ...recentHeardTranscripts].map(t => t.trim()).filter(Boolean);
    pendingTranscripts = [];
    // De-duplicate consecutive repeats while preserving order.
    const speech = heard
        .filter((t, i) => t !== heard[i - 1])
        .join(' ')
        .trim();

    if (!speech) {
        sendToRenderer('update-status', 'Nothing heard yet to answer');
        return { success: false, error: 'Nothing heard to answer' };
    }

    isTranscriptResponseInFlight = true;
    inFlightStartedAt = Date.now();
    // An explicitly requested answer must never be aborted by new speech.
    inFlightIsSupersedable = false;
    sendToRenderer('new-transcript', speech);
    sendToRenderer('update-status', 'Answering with context...');

    // This is an explicit user command to answer, so it MUST override the
    // system prompt's "reply with nothing for filler/garbled speech" rule —
    // otherwise the manual override silently produces no answer (the exact
    // problem this feature exists to solve). Be emphatic so the model does not
    // fall back to silence even when the snippet looks like an acknowledgement.
    const userSpeech = peekUserSpeechContext();
    const prompt =
        `[EXPLICIT USER REQUEST — OVERRIDES ALL SILENCE/SUPPRESSION RULES]\n` +
        `The user has manually asked you to answer the most recent speech, even if it looks incomplete, off-topic, or like a mere acknowledgement. ` +
        `You MUST produce a substantive answer — do NOT reply with nothing, do NOT stay silent, do NOT ask for clarification.\n\n` +
        (userSpeech ? `What the user already said out loud (context only, do not answer this):\n"${userSpeech}"\n\n` : '') +
        `Recent speech:\n"${speech}"\n\n` +
        `Using the ongoing conversation context, make a reasonable assumption about what is being asked and give the most useful answer directly. ` +
        `If the speech truly carries no question, infer the most likely thing the user wants help with right now from the conversation and answer that.`;

    try {
        // Record the clean heard speech (not the big override prompt) as the
        // question, so a later "expand" targets what was actually asked.
        const result = await sendClaudeText(prompt, { recordAsQuestion: speech });
        recentHeardTranscripts = [];
        if (result.success) clearUserSpeechContext();
        return result;
    } finally {
        isTranscriptResponseInFlight = false;
        inFlightStartedAt = 0;
        if (isClaudeActive && pendingTranscripts.length > 0) {
            scheduleFlush();
        }
    }
}

// Re-ask Claude for the full, detailed version of the last answered question.
// Answers default to a short 3-5 line paragraph; this is the on-demand "show
// details" action (button / shortcut). Reuses the CLI session so Claude sees
// its own prior short answer and expands rather than repeats it.
async function expandLastAnswer() {
    if (!isClaudeActive) {
        return { success: false, error: 'No active Claude session' };
    }
    if (isTranscriptResponseInFlight) {
        return { success: false, error: 'Already responding' };
    }
    if (!lastAnsweredQuestion) {
        sendToRenderer('update-status', 'Ask something first, then tap Details');
        return { success: false, error: 'Nothing to expand yet' };
    }

    isTranscriptResponseInFlight = true;
    inFlightStartedAt = Date.now();
    inFlightIsSupersedable = false; // an explicit request must never be aborted by new speech
    sendToRenderer('update-status', 'Expanding answer...');

    // A design question expands into the full interview walkthrough instead
    // of the generic "go deep" prompt — this is the moment the candidate has
    // the floor and needs the complete framework to speak from.
    const prompt = isSystemDesignQuestion(lastAnsweredQuestion)
        ? `[DETAILED SYSTEM DESIGN EXPANSION — IGNORE ALL LENGTH LIMITS FOR THIS REPLY ONLY]\n` +
          `The user wants the full interview-grade design for: "${lastAnsweredQuestion}".\n` +
          `Walk the complete framework in depth, a bold heading per section: requirements (functional + non-functional), capacity estimation with the arithmetic shown, ` +
          `architecture with every component justified, data model (schema, primary/shard keys, indexes), API design (endpoints with params, idempotency, pagination), ` +
          `the 2-3 deep dives that matter most for THIS system, scaling story (what changes at 10x and 100x), failure handling (what breaks first, mitigation, multi-region), ` +
          `and a closing trade-offs section covering every major decision — for each, name the alternative you rejected and the one-line reason it lost. ` +
          `Use short bullets so it stays speakable. Do not restate the question, and do not ask anything back.`
        : `[DETAILED EXPANSION — IGNORE THE SHORT 3-5 LINE ANSWER LIMIT FOR THIS REPLY ONLY]\n` +
          `The user wants the in-depth version of your previous answer to: "${lastAnsweredQuestion}".\n` +
          `Go deep now: explain the key concepts, how it works step by step, the main trade-offs and edge cases, and give a concrete example or short code snippet where useful. ` +
          `Use short headings or bullets so it stays easy to read aloud. Do not restate the question, and do not ask anything back.`;

    try {
        // recordAsQuestion:null — keep the original question so repeated
        // expansions always target it, not this internal prompt.
        return await sendClaudeText(prompt, { recordAsQuestion: null, detailed: true });
    } finally {
        isTranscriptResponseInFlight = false;
        inFlightStartedAt = 0;
        if (isClaudeActive && pendingTranscripts.length > 0) {
            scheduleFlush();
        }
    }
}

// ── Claude Code CLI detection ──

function buildAugmentedEnv() {
    // Electron GUI apps on macOS inherit a minimal PATH that misses the
    // common CLI install locations and NVM node paths, so add them explicitly.
    const home = os.homedir();
    const extraPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        path.join(home, '.claude', 'local'),
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'),
        path.join(home, '.yarn', 'bin'),
        path.join(home, '.nvm', 'current', 'bin'),
        path.join(home, '.fnm', 'current', 'bin'),
        path.join(home, '.volta', 'bin'),
        path.join(home, '.asdf', 'shims'),
        path.dirname(process.execPath),
    ];

    // Dynamically discover NVM node versions if present
    const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmVersionsDir)) {
        try {
            const versions = fs.readdirSync(nvmVersionsDir);
            for (const v of versions) {
                const binPath = path.join(nvmVersionsDir, v, 'bin');
                if (fs.existsSync(binPath)) {
                    extraPaths.push(binPath);
                }
            }
        } catch (e) {
            // Non-fatal
        }
    }

    const sep = process.platform === 'win32' ? ';' : ':';
    const augmentedPath = [...extraPaths, process.env.PATH || ''].filter(Boolean).join(sep);

    return {
        ...process.env,
        PATH: augmentedPath,
        // Skip update checks/telemetry on CLI boot — measurable spawn-time
        // savings on the one-shot and respawn paths.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        // Disable extended thinking (verified: suppresses the thinking phase
        // entirely), so the first answer token isn't delayed by reasoning the
        // real-time assistant doesn't want. Mirrors maxThinkingTokens: 0 on
        // the SDK path.
        MAX_THINKING_TOKENS: '0',
    };
}

function checkCliCandidate(candidate, env) {
    return new Promise(resolve => {
        execFile(candidate, ['--version'], { env, timeout: 5000 }, error => {
            resolve(!error);
        });
    });
}

async function resolveClaudeCli() {
    const env = buildAugmentedEnv();
    const home = os.homedir();

    const nvmCandidates = [];
    const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmVersionsDir)) {
        try {
            const versions = fs.readdirSync(nvmVersionsDir);
            for (const v of versions) {
                nvmCandidates.push(path.join(nvmVersionsDir, v, 'bin', 'claude'));
            }
        } catch (e) {
            // Non-fatal
        }
    }

    const absoluteCandidates = [
        path.join(home, '.claude', 'local', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.npm-global', 'bin', 'claude'),
        path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin', 'claude'),
        ...nvmCandidates,
    ];

    const candidates = ['claude', ...absoluteCandidates.filter(p => fs.existsSync(p))];

    for (const candidate of candidates) {
        if (await checkCliCandidate(candidate, env)) {
            console.log('[Claude] Found Claude CLI at:', candidate);
            return { path: candidate, env };
        }
    }

    return null;
}

// Resolve and validate the CLI once, cache its path/env for every later
// invocation, and remember a definitive miss so text requests can go straight
// to the SDK instead of re-probing the filesystem per question.
async function ensureCliResolved() {
    if (cliPath) return { path: cliPath, env: cliEnv };
    if (cliUnavailable) return null;
    if (cliResolutionPromise) return cliResolutionPromise;
    cliResolutionPromise = (async () => {
        const startedAt = Date.now();
        const cli = await resolveClaudeCli();
        if (cli) {
            cliPath = cli.path;
            cliEnv = cli.env;
            cliUnavailable = false;
            console.log(`[Claude] CLI resolved in ${Date.now() - startedAt}ms`);
        } else {
            cliUnavailable = true;
            console.warn(`[Claude] No working Claude CLI found (${Date.now() - startedAt}ms) — the SDK will handle requests`);
        }
        return cli;
    })().finally(() => {
        cliResolutionPromise = null;
    });
    return cliResolutionPromise;
}

// First meaningful stderr/error line, ANSI-stripped and bounded, so statuses
// and logs show the actual CLI diagnostic without dumping a stack trace or
// anything sensitive-looking into the UI. Never includes the prompt.
function sanitizeDiagnostic(text) {
    if (!text) return '';
    const line =
        String(text)
            .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
            .split('\n')
            .map(l => l.trim())
            .find(Boolean) || '';
    return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

// Map a failed CLI invocation to a stable error string (for fallback logic)
// and an actionable renderer status. Each failure class keeps a distinct
// message instead of collapsing into a generic "no reply".
function classifyCliFailure({ stderrText = '', message = '' } = {}) {
    const haystack = `${stderrText}\n${message}`;
    const diag = sanitizeDiagnostic(stderrText) || sanitizeDiagnostic(message);
    if (/No conversation found with session ID/i.test(haystack)) {
        return {
            kind: 'resume',
            error: 'No conversation found with session ID — resume failed',
            status: 'Claude session expired — retrying with a fresh conversation',
        };
    }
    if (/not logged in|log ?in|authenticate|unauthorized|401|invalid api key|oauth|credentials/i.test(haystack)) {
        return {
            kind: 'auth',
            error: 'Claude CLI not logged in' + (diag ? ': ' + diag : ''),
            status: 'Claude CLI not logged in — run "claude" in a terminal and sign in',
        };
    }
    if (/invalid model|unknown model|not a valid model|model not (found|supported|available)/i.test(haystack)) {
        return {
            kind: 'model',
            error: `Invalid Claude model: ${claudeModel}` + (diag ? ' — ' + diag : ''),
            status: `Claude model "${claudeModel}" not available — pick another model in settings`,
        };
    }
    const error = diag ? 'Claude CLI failed: ' + diag : 'Claude CLI failed';
    return { kind: 'unknown', error, status: error };
}

// ── Claude Code CLI invocation ──

// Per-turn accumulator for stream-json events, shared by the one-shot and
// persistent CLI transports. Tracks committed assistant messages vs the
// streaming delta, sends throttled new-response/update-response events (so a
// long streamed answer doesn't flood IPC and per-update markdown re-renders),
// and captures the turn's result event and session id.
function createTurnStream({ quiet = false } = {}) {
    let committedText = ''; // text from completed assistant turns
    let currentDelta = ''; // streaming text of the in-flight turn
    let fullText = '';
    let finalText = '';
    let isFirst = true;
    let lastSentText = '';
    let lastEmitAt = 0;
    let emitTimer = null;

    const sendUpdate = force => {
        if (quiet || !fullText || fullText === lastSentText) return;
        const elapsed = Date.now() - lastEmitAt;
        if (!force && elapsed < RESPONSE_UPDATE_INTERVAL_MS) {
            if (!emitTimer) {
                emitTimer = setTimeout(() => {
                    emitTimer = null;
                    sendUpdate(true);
                }, RESPONSE_UPDATE_INTERVAL_MS - elapsed);
            }
            return;
        }
        if (emitTimer) {
            clearTimeout(emitTimer);
            emitTimer = null;
        }
        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
        isFirst = false;
        lastSentText = fullText;
        lastEmitAt = Date.now();
    };

    const emit = (force = false) => {
        fullText = committedText + (committedText && currentDelta ? '\n' : '') + currentDelta;
        sendUpdate(force);
    };

    const stream = {
        // Only committed after a confirmed successful run, so a failed/aborted
        // invocation can never poison the next --resume.
        sessionId: null,
        resultEvent: null,
        text: () => finalText || fullText,
        handleEvent(event) {
            if (event.session_id) stream.sessionId = event.session_id;
            if (event.type === 'stream_event') {
                // Token-level streaming from --include-partial-messages
                const delta = event.event?.delta;
                if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
                    currentDelta += delta.text;
                    emit();
                }
            } else if (event.type === 'assistant' && event.message?.content) {
                // Complete assistant message — authoritative text for this turn
                const text = event.message.content
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text)
                    .join('');
                if (text) {
                    committedText = committedText ? committedText + '\n' + text : text;
                }
                currentDelta = '';
                emit(true);
            } else if (event.type === 'result') {
                stream.resultEvent = event;
                const failed = event.is_error || (event.subtype && event.subtype !== 'success');
                if (!failed) {
                    finalText = event.result || fullText;
                    fullText = finalText || fullText;
                    sendUpdate(true); // flush the trailing partial / authoritative final text
                }
                return 'result';
            }
            return null;
        },
        dispose() {
            if (emitTimer) {
                clearTimeout(emitTimer);
                emitTimer = null;
            }
        },
    };
    return stream;
}

// One-shot transport: spawn → answer → exit. Used for the warm-up fallback
// and whenever the installed CLI can't run the persistent stream-json session
// (see below). quiet suppresses renderer/status events (warm-up);
// adoptSession controls whether a successful run's session id becomes the
// conversation's resume id — the warm-up must never donate its throwaway
// session.
async function runClaudeCli(prompt, { allowedTools, quiet = false, timeoutMs = CLI_TIMEOUT_MS, adoptSession = true } = {}) {
    const cli = await ensureCliResolved();
    if (!cli) {
        if (!quiet) sendToRenderer('update-status', 'Claude CLI not found — install Claude Code or switch to API key mode');
        return { success: false, error: 'Claude CLI not found' };
    }

    const requestStartedAt = Date.now();

    return new Promise(resolve => {
        const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', claudeModel];
        // Replace Claude Code's large coding-agent prompt. This app needs a
        // focused assistant prompt, and processing both prompts adds latency.
        if (currentSystemPrompt) {
            args.push('--system-prompt', currentSystemPrompt);
        }
        if (cliSessionId) {
            args.push('--resume', cliSessionId);
        }
        if (allowedTools && allowedTools.length) {
            args.push('--allowedTools', ...(Array.isArray(allowedTools) ? allowedTools : [allowedTools]));
        }

        console.log('[Claude] Spawning one-shot CLI', cliSessionId ? '(resume session)' : '(new session)');

        let proc;
        try {
            // Claude Code stores conversations per project directory (keyed by
            // cwd), so every invocation must use the same cwd or --resume fails
            // with "No conversation found with session ID".
            proc = spawn(cliPath, args, { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
        } catch (error) {
            resolve({ success: false, error: 'Failed to start Claude CLI: ' + error.message });
            return;
        }

        activeCliProc = proc;
        // Supersede/close paths abort the in-flight request through this
        // controller regardless of transport, so wire it to the subprocess.
        const controller = new AbortController();
        activeCliAbort = controller;

        const turn = createTurnStream({ quiet });
        let lineBuffer = '';
        let stderrText = '';
        let settled = false;
        let firstOutputLogged = false;
        let sawValidEvent = false; // any parseable stream-json line
        let sawAnyStdout = false;

        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            turn.dispose();
            if (activeCliProc === proc) activeCliProc = null;
            if (activeCliAbort === controller) activeCliAbort = null;
            if (result.success && adoptSession && turn.sessionId) {
                cliSessionId = turn.sessionId;
            }
            resolve(result);
        };

        controller.signal.addEventListener('abort', () => {
            try {
                proc.kill('SIGTERM');
            } catch (killError) {
                // Process already exited
            }
            finish({ success: false, error: 'Cancelled' });
        });

        const timeout = setTimeout(() => {
            console.error(`[Claude] CLI timed out after ${timeoutMs}ms, killing process`);
            try {
                proc.kill('SIGTERM');
            } catch (killError) {
                // Process already exited
            }
            if (!quiet) sendToRenderer('update-status', 'Claude CLI timed out — listening again');
            finish({ success: false, error: 'Claude CLI timed out' });
        }, timeoutMs);

        proc.stdout.on('data', data => {
            sawAnyStdout = true;
            lineBuffer += data.toString();
            let nlIdx;
            while ((nlIdx = lineBuffer.indexOf('\n')) !== -1) {
                const line = lineBuffer.slice(0, nlIdx);
                lineBuffer = lineBuffer.slice(nlIdx + 1);
                if (!line.trim()) continue;
                let event;
                try {
                    event = JSON.parse(line);
                } catch (parseError) {
                    continue; // skip invalid JSON lines
                }
                sawValidEvent = true;
                if (!firstOutputLogged) {
                    firstOutputLogged = true;
                    console.log(`[Claude] CLI first output in ${Date.now() - requestStartedAt}ms`);
                }
                if (turn.handleEvent(event) === 'result') {
                    const ev = turn.resultEvent;
                    if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
                        const { error, status } = classifyCliFailure({ stderrText, message: ev.result || 'Claude CLI error' });
                        console.error('[Claude] CLI result error:', error);
                        if (!quiet) sendToRenderer('update-status', status);
                        finish({ success: false, error });
                    }
                    // On success keep waiting for the clean exit (close) below.
                }
            }
        });

        proc.stderr.on('data', data => {
            stderrText += data.toString();
        });

        proc.on('error', err => {
            console.error('[Claude] CLI spawn error:', err);
            const message = err.code === 'ENOENT' ? 'Claude CLI not found' : 'Claude CLI error: ' + err.message;
            if (!quiet) sendToRenderer('update-status', message);
            finish({ success: false, error: message });
        });

        proc.on('close', code => {
            if (settled) return;
            const elapsed = Date.now() - requestStartedAt;
            if (code !== 0) {
                const { error, status } = classifyCliFailure({ stderrText });
                console.error(`[Claude] CLI exited with code ${code} after ${elapsed}ms:`, sanitizeDiagnostic(stderrText) || '(no stderr)');
                if (!quiet) sendToRenderer('update-status', status);
                finish({ success: false, error });
                return;
            }
            const text = turn.text();
            if (!text) {
                if (sawAnyStdout && !sawValidEvent) {
                    console.error(`[Claude] CLI produced no parseable stream events after ${elapsed}ms`);
                    if (!quiet) sendToRenderer('update-status', 'Claude CLI returned malformed output');
                    finish({ success: false, error: 'Claude CLI returned malformed output' });
                } else {
                    if (!quiet) sendToRenderer('update-status', 'Claude returned no response');
                    finish({ success: false, error: 'Claude CLI returned no response' });
                }
                return;
            }
            console.log(`[Claude] CLI response completed in ${elapsed}ms`);
            if (!quiet) sendToRenderer('update-status', 'Listening...');
            finish({ success: true, text });
        });
    });
}

// ── Persistent Claude CLI session ──
// One long-lived `claude -p --input-format stream-json` process serves every
// turn: the CLI's ~1-3s boot + session reload is paid once per session
// instead of once per question, so answers start streaming at raw API
// latency. Each question is a user message written to stdin; each turn ends
// with its own result event and the process stays alive for the next one.
// A supersede interrupts the in-flight turn over stdin (control_request) —
// verified to abort within milliseconds — and reuses the same warm process
// for the combined resend. If the process dies (crash, or kill after an
// ignored interrupt), the next turn respawns it with --resume so the
// conversation context survives.
let persistentProc = null; // non-null ⇒ believed alive (close/error/stop null it)
let persistentStderr = '';
let persistentTurnHandler = null; // routes stream events / close to the active turn
let persistentEverCompletedTurn = false;
let persistentDisabled = false; // CLI rejected stream-json input — use one-shot spawns
let persistentTurnChain = Promise.resolve(); // serializes turns (text and image sends can overlap)
let interruptCounter = 0;

const INTERRUPT_GRACE_MS = 2000;
const PERSISTENT_STDERR_MAX = 4096;

function stopPersistentProc(reason) {
    const proc = persistentProc;
    if (!proc) return;
    persistentProc = null;
    if (reason) console.log('[Claude] Stopping persistent CLI:', reason);
    try {
        proc.kill('SIGTERM');
    } catch (killError) {
        // Process already exited
    }
}

function writePersistentMessage(obj) {
    const proc = persistentProc;
    if (!proc || proc.killed) return false;
    try {
        proc.stdin.write(JSON.stringify(obj) + '\n');
        return true;
    } catch (writeError) {
        return false;
    }
}

function spawnPersistentProc() {
    const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--model',
        claudeModel,
    ];
    // Replace Claude Code's large coding-agent prompt (latency + focus), and
    // pre-allow Read so screenshot analysis can run through this session too.
    if (currentSystemPrompt) {
        args.push('--system-prompt', currentSystemPrompt);
    }
    args.push('--allowedTools', ...cliAllowedTools());
    if (cliSessionId) {
        args.push('--resume', cliSessionId);
    }

    console.log('[Claude] Spawning persistent CLI', cliSessionId ? '(resume session)' : '(new session)');
    // Same-cwd rule as the one-shot path: the conversation store is keyed by
    // cwd, so --resume only works if every invocation shares it.
    const proc = spawn(cliPath, args, { env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() });
    persistentProc = proc;
    persistentStderr = '';

    let lineBuffer = ''; // per-process: a dying process must not corrupt its successor's buffer
    proc.stdout.on('data', data => {
        lineBuffer += data.toString();
        let nlIdx;
        while ((nlIdx = lineBuffer.indexOf('\n')) !== -1) {
            const line = lineBuffer.slice(0, nlIdx);
            lineBuffer = lineBuffer.slice(nlIdx + 1);
            if (!line.trim()) continue;
            let event;
            try {
                event = JSON.parse(line);
            } catch (parseError) {
                continue;
            }
            if (persistentTurnHandler && persistentTurnHandler.proc === proc) {
                persistentTurnHandler.onEvent(event);
            }
        }
    });
    proc.stderr.on('data', data => {
        if (persistentProc !== proc) return;
        persistentStderr = (persistentStderr + data.toString()).slice(-PERSISTENT_STDERR_MAX);
    });
    proc.on('error', err => {
        console.error('[Claude] Persistent CLI spawn error:', err);
        if (persistentProc === proc) persistentProc = null;
        if (persistentTurnHandler && persistentTurnHandler.proc === proc) {
            persistentTurnHandler.onError(err.code === 'ENOENT' ? 'Claude CLI not found' : 'Claude CLI error: ' + err.message);
        }
    });
    proc.on('close', code => {
        if (persistentProc === proc) persistentProc = null;
        // A CLI build too old for stream-json input exits immediately with a
        // usage error — permanently fall back to one-shot spawns this run.
        if (!persistentEverCompletedTurn && code !== 0 && code !== null && /unknown|unrecognized|invalid|usage:/i.test(persistentStderr)) {
            persistentDisabled = true;
            console.warn('[Claude] CLI rejected persistent stream-json input — using one-shot invocations:', sanitizeDiagnostic(persistentStderr));
        }
        if (persistentTurnHandler && persistentTurnHandler.proc === proc) {
            persistentTurnHandler.onClose(code);
        } else if (code !== 0 && code !== null) {
            console.warn(`[Claude] Persistent CLI exited between turns with code ${code}:`, sanitizeDiagnostic(persistentStderr) || '(no stderr)');
        }
    });
    return proc;
}

function execPersistentTurn(prompt, { quiet = false, timeoutMs = CLI_TIMEOUT_MS, adoptSession = true } = {}) {
    return new Promise(resolve => {
        let proc = persistentProc;
        let freshSpawn = false;
        if (!proc) {
            try {
                proc = spawnPersistentProc();
                freshSpawn = true;
            } catch (error) {
                resolve({ success: false, error: 'Failed to start Claude CLI: ' + error.message });
                return;
            }
        }

        const requestStartedAt = Date.now();
        const turn = createTurnStream({ quiet });
        const controller = new AbortController();
        activeCliAbort = controller;
        let settled = false;
        let aborted = false;
        let timedOut = false;
        let firstOutputLogged = false;
        let graceTimer = null;

        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(watchdog);
            if (graceTimer) clearTimeout(graceTimer);
            turn.dispose();
            if (persistentTurnHandler === handler) persistentTurnHandler = null;
            if (activeCliAbort === controller) activeCliAbort = null;
            if (result.success) {
                persistentEverCompletedTurn = true;
                if (adoptSession && turn.sessionId) cliSessionId = turn.sessionId;
            }
            resolve(result);
        };

        const handler = {
            proc,
            onEvent(event) {
                if (!firstOutputLogged) {
                    firstOutputLogged = true;
                    console.log(`[Claude] CLI first output in ${Date.now() - requestStartedAt}ms${freshSpawn ? '' : ' (warm process)'}`);
                }
                if (turn.handleEvent(event) !== 'result') return;
                const ev = turn.resultEvent;
                if (aborted) {
                    finish({ success: false, error: 'Cancelled' });
                    return;
                }
                if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
                    const { error, status } = classifyCliFailure({ stderrText: persistentStderr, message: ev.result || 'Claude CLI error' });
                    console.error('[Claude] CLI result error:', error);
                    if (!quiet) sendToRenderer('update-status', status);
                    finish({ success: false, error });
                    return;
                }
                const text = turn.text();
                if (!text) {
                    if (!quiet) sendToRenderer('update-status', 'Claude returned no response');
                    finish({ success: false, error: 'Claude CLI returned no response' });
                    return;
                }
                console.log(`[Claude] CLI response completed in ${Date.now() - requestStartedAt}ms`);
                if (!quiet) sendToRenderer('update-status', 'Listening...');
                finish({ success: true, text });
            },
            onError(message) {
                if (!quiet) sendToRenderer('update-status', message);
                finish({ success: false, error: message });
            },
            onClose(code) {
                if (settled) return;
                if (aborted) {
                    finish({ success: false, error: 'Cancelled' });
                    return;
                }
                if (timedOut) {
                    if (!quiet) sendToRenderer('update-status', 'Claude CLI timed out — listening again');
                    finish({ success: false, error: 'Claude CLI timed out' });
                    return;
                }
                const { error, status } = classifyCliFailure({ stderrText: persistentStderr });
                console.error(`[Claude] Persistent CLI exited mid-turn (code ${code}):`, sanitizeDiagnostic(persistentStderr) || '(no stderr)');
                if (!quiet) sendToRenderer('update-status', status);
                finish({ success: false, error });
            },
        };
        persistentTurnHandler = handler;

        controller.signal.addEventListener('abort', () => {
            if (settled) return;
            aborted = true;
            // Interrupt the turn over stdin — the warm process survives for
            // the resend. The CLI answers with an error result for this turn,
            // which resolves it as Cancelled; if the interrupt is ignored,
            // kill the process after a grace period and let the next turn
            // respawn with --resume.
            const sent = writePersistentMessage({
                type: 'control_request',
                request_id: `interrupt-${++interruptCounter}`,
                request: { subtype: 'interrupt' },
            });
            if (!sent) {
                stopPersistentProc('interrupt write failed');
                return;
            }
            graceTimer = setTimeout(() => {
                if (!settled) stopPersistentProc('interrupt ignored');
            }, INTERRUPT_GRACE_MS);
        });

        const watchdog = setTimeout(() => {
            timedOut = true;
            console.error(`[Claude] CLI turn timed out after ${timeoutMs}ms — killing persistent process`);
            stopPersistentProc('turn timeout'); // close event resolves the turn
        }, timeoutMs);

        if (!writePersistentMessage({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })) {
            stopPersistentProc('stdin write failed');
            finish({ success: false, error: 'Claude CLI failed: could not write to persistent session' });
        }
    });
}

// Turns are serialized: the persistent process answers one turn at a time, so
// a screenshot analysis requested mid-answer queues instead of interleaving.
function runClaudePersistentTurn(prompt, opts = {}) {
    const run = persistentTurnChain.then(() => execPersistentTurn(prompt, opts));
    persistentTurnChain = run.catch(() => {}); // a failed turn must not wedge the chain
    return run;
}

// Primary CLI entry point for a turn: the warm persistent session when
// available, one-shot spawns when this CLI build can't do stream-json input.
// allowedTools only matters for the one-shot path — the persistent process is
// spawned with Read already allowed for screenshot analysis.
function runCliTransport(prompt, opts = {}) {
    if (persistentDisabled) return runClaudeCli(prompt, opts);
    return runClaudePersistentTurn(prompt, opts);
}

// ── Claude Code SDK (SSE, no subprocess) ──
// Uses the same auth as `claude login`. Eliminates per-request spawn overhead.

// quiet: suppress all renderer/status events. Used by the init warm-up so it
// primes the agent runtime without flickering the UI or showing a response.
// adoptSession: as in runClaudeCli — the warm-up's session id is throwaway.
async function runClaudeQuery(prompt, { quiet = false, timeoutMs = QUERY_TIMEOUT_MS, adoptSession = true } = {}) {
    const requestStartedAt = Date.now();
    let firstTokenLogged = false;
    let query;
    try {
        query = await getQueryFn();
    } catch (importErr) {
        console.error('[Claude] SDK import failed:', importErr.message);
        return { success: false, error: 'Failed to load Claude SDK' };
    }

    const controller = new AbortController();
    activeCliAbort = controller;
    // A query that never yields (network stall, SDK hang) would otherwise pin
    // isTranscriptResponseInFlight forever and no answer would ever appear again.
    let timedOut = false;
    const watchdog = setTimeout(() => {
        timedOut = true;
        console.error(`[Claude] Query timed out after ${timeoutMs}ms — aborting`);
        controller.abort();
    }, timeoutMs);

    let committed = '';
    let delta = '';
    let fullText = '';
    let isFirst = true;
    let responseUpdateTimer = null;
    let lastResponseUpdateAt = 0;

    const emitResponse = (force = false) => {
        if (quiet) return;
        if (!fullText) return;
        const elapsed = Date.now() - lastResponseUpdateAt;

        if (!force && elapsed < RESPONSE_UPDATE_INTERVAL_MS) {
            if (!responseUpdateTimer) {
                responseUpdateTimer = setTimeout(() => {
                    responseUpdateTimer = null;
                    emitResponse(true);
                }, RESPONSE_UPDATE_INTERVAL_MS - elapsed);
            }
            return;
        }

        if (responseUpdateTimer) {
            clearTimeout(responseUpdateTimer);
            responseUpdateTimer = null;
        }
        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
        isFirst = false;
        lastResponseUpdateAt = Date.now();
    };

    try {
        const opts = {
            maxTurns: 1,
            abortController: controller,
            model: claudeModel,
            includePartialMessages: true,
            // Favor immediate answers over extended reasoning in the real-time
            // assistant. Users can still select a more capable model.
            maxThinkingTokens: 1000,
            // Plain text answers need no tools beyond the web search the user
            // opted into, and no user MCP servers. Skipping their discovery
            // reduces request startup work.
            allowedTools: webSearchEnabled ? ['WebSearch', 'WebFetch'] : [],
            mcpServers: {},
            strictMcpConfig: true,
            // Pin a clean working directory so Claude Code doesn't scan the
            // app's launch dir for CLAUDE.md/.claude project context on every
            // query — that would silently add tokens and startup latency to a
            // conversational request that needs no filesystem context.
            cwd: os.tmpdir(),
        };
        // Avoid processing Claude Code's full coding-agent prompt for every
        // conversational request.
        if (currentSystemPrompt) opts.customSystemPrompt = currentSystemPrompt;
        if (cliSessionId) opts.resume = cliSessionId;

        for await (const msg of query({ prompt, options: opts })) {
            if (controller.signal.aborted) break;

            if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
                if (adoptSession) cliSessionId = msg.session_id;
            } else if (msg.type === 'stream_event') {
                const ev = msg.event;
                if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
                    if (!firstTokenLogged) {
                        firstTokenLogged = true;
                        console.log(`[Claude] First token in ${Date.now() - requestStartedAt}ms`);
                    }
                    delta += ev.delta.text;
                    fullText = committed + (committed && delta ? '\n' : '') + delta;
                    emitResponse();
                }
            } else if (msg.type === 'assistant') {
                if (!firstTokenLogged) {
                    firstTokenLogged = true;
                    console.log(`[Claude] First response in ${Date.now() - requestStartedAt}ms`);
                }
                const text = (msg.message?.content || [])
                    .filter(b => b.type === 'text' && b.text)
                    .map(b => b.text)
                    .join('');
                if (text) committed = committed ? committed + '\n' + text : text;
                delta = '';
                fullText = committed;
                emitResponse(true);
            } else if (msg.type === 'result') {
                if (msg.session_id && adoptSession) cliSessionId = msg.session_id;
                if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
                    const errMsg = msg.result || 'Claude error';
                    if (!quiet) sendToRenderer('update-status', 'Claude error: ' + errMsg);
                    return { success: false, error: errMsg };
                }
                const final = msg.result || fullText;
                if (final && final !== fullText) {
                    fullText = final;
                }
                emitResponse(true);
            }
        }
    } catch (err) {
        if (controller.signal.aborted) {
            if (timedOut && !quiet) sendToRenderer('update-status', 'Claude timed out — listening again');
            return { success: false, error: timedOut ? 'Claude timed out' : 'Cancelled' };
        }
        console.error('[Claude] SDK query error:', err);
        let message = 'Claude error: ' + err.message;
        if (/login|auth|unauthorized|401|credentials/i.test(err.message)) {
            message = 'Claude not logged in — run "claude" in a terminal and sign in';
        }
        if (!quiet) sendToRenderer('update-status', message);
        return { success: false, error: message };
    } finally {
        clearTimeout(watchdog);
        if (responseUpdateTimer) clearTimeout(responseUpdateTimer);
        if (activeCliAbort === controller) activeCliAbort = null;
    }

    // An abort can land between stream messages and exit the loop via `break`
    // with partial text — don't let that be saved/rendered as a success.
    if (controller.signal.aborted) {
        if (timedOut && !quiet) sendToRenderer('update-status', 'Claude timed out — listening again');
        return { success: false, error: timedOut ? 'Claude timed out' : 'Cancelled' };
    }
    if (!fullText) return { success: false, error: 'Claude returned no response' };
    console.log(`[Claude] Response completed in ${Date.now() - requestStartedAt}ms`);
    if (!quiet) sendToRenderer('update-status', 'Listening...');
    return { success: true, text: fullText };
}

// Pay the transport's cold-start cost (binary resolution, auth handshake,
// first-token warmup) in the background during session setup instead of on
// the candidate's first real question mid-interview. Runs through the same
// direct CLI path that real requests use, so a broken CLI surfaces here (in
// logs and status) before it can hurt a live answer. adoptSession:false keeps
// the throwaway warm-up exchange out of the real conversation.
async function warmUpClaude() {
    if (claudeMode !== 'cli') return;
    const startedAt = Date.now();
    try {
        const cli = await ensureCliResolved();
        let result;
        if (cli && !persistentDisabled) {
            // Boot the long-lived session and push one tiny turn through it:
            // this pays the CLI boot + auth + first-token cost now and leaves
            // a warm process (with the system prompt already cached) for the
            // first real question. The exchange joins the real conversation —
            // two one-word messages of context noise in exchange for
            // validating the whole path end-to-end before it matters.
            result = await runClaudePersistentTurn('Reply with the single word: ready', { quiet: true, timeoutMs: WARMUP_TIMEOUT_MS });
            if (!result.success && persistentDisabled) {
                // The CLI turned out not to support stream-json input — warm
                // the one-shot path instead so auth problems still surface.
                result = await runClaudeCli('Reply with the single word: ready', { quiet: true, timeoutMs: WARMUP_TIMEOUT_MS, adoptSession: false });
            }
        } else if (cli) {
            result = await runClaudeCli('Reply with the single word: ready', { quiet: true, timeoutMs: WARMUP_TIMEOUT_MS, adoptSession: false });
        } else {
            result = await runClaudeQuery('Reply with the single word: ready', { quiet: true, timeoutMs: WARMUP_TIMEOUT_MS, adoptSession: false });
        }
        if (result.success) {
            console.log(
                `[Claude] Warm-up completed in ${Date.now() - startedAt}ms via ${cli ? (persistentDisabled ? 'one-shot CLI' : 'persistent CLI') : 'SDK'}`
            );
        } else {
            console.warn('[Claude] Warm-up did not succeed (non-fatal):', result.error);
        }
    } catch (error) {
        console.warn('[Claude] Warm-up failed (non-fatal):', error.message);
    }
}

// ── Anthropic API streaming ──

async function streamAnthropicMessages(messages, { maxTokens = API_MAX_TOKENS } = {}) {
    // claude-opus-4-8 rejects temperature/top_p/top_k — never send sampling params
    const stream = anthropicClient.messages.stream({
        model: claudeModel,
        // Keep normal assistant replies bounded. An 8k-token ceiling makes full
        // responses unnecessarily slow and is excessive for this real-time UI.
        max_tokens: maxTokens,
        system: currentSystemPrompt || 'You are a helpful assistant.',
        messages,
    });

    let fullText = '';
    let isFirst = true;
    let lastSentText = '';
    let lastEmitAt = 0;
    let emitTimer = null;

    const emitUpdate = force => {
        if (!fullText || fullText === lastSentText) return;
        const elapsed = Date.now() - lastEmitAt;
        if (!force && elapsed < RESPONSE_UPDATE_INTERVAL_MS) {
            if (!emitTimer) {
                emitTimer = setTimeout(() => {
                    emitTimer = null;
                    emitUpdate(true);
                }, RESPONSE_UPDATE_INTERVAL_MS - elapsed);
            }
            return;
        }
        if (emitTimer) {
            clearTimeout(emitTimer);
            emitTimer = null;
        }
        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
        isFirst = false;
        lastSentText = fullText;
        lastEmitAt = Date.now();
    };

    try {
        stream.on('text', delta => {
            fullText += delta;
            emitUpdate(false);
        });

        await stream.finalMessage();
        emitUpdate(true);
    } finally {
        if (emitTimer) {
            clearTimeout(emitTimer);
            emitTimer = null;
        }
    }
    return fullText;
}

function anthropicErrorMessage(error) {
    const Anthropic = getAnthropic();
    if (error instanceof Anthropic.AuthenticationError) {
        return 'Invalid Anthropic API key';
    }
    if (error instanceof Anthropic.RateLimitError) {
        return 'Anthropic rate limited — retry shortly';
    }
    if (error instanceof Anthropic.APIError) {
        return 'Claude error: ' + error.message;
    }
    return 'Claude error: ' + error.message;
}

// ── Public API ──

async function initializeClaudeSession(mode, { anthropicApiKey, model, whisperModel, profile, customPrompt }) {
    console.log('[Claude] Initializing Claude session:', { mode, model, whisperModel, profile });

    sendToRenderer('session-initializing', true);

    const generation = ++sessionGeneration;
    const initStartedAt = Date.now();
    try {
        claudeMode = mode === 'api' ? 'api' : 'cli';
        webSearchEnabled = readWebSearchPreference();
        const realtimeRules =
            profile === 'relationship'
                ? conversationalResponseRules()
                : profile === 'meeting'
                  ? CLAUDE_MEETING_RESPONSE_PROMPT
                  : CLAUDE_CONCISE_RESPONSE_PROMPT;
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, webSearchEnabled) + realtimeRules;
        claudeConversationHistory = [];
        unsentUserSpeech = [];
        recentSpeakerSpeech = [];
        recentSpeakerSpeechSets = [];
        setLastAnswerText('');
        cliSessionId = null;
        isTransportReady = false;
        // A leftover process carries the previous session's model/system
        // prompt (they're spawn args) — never reuse it across sessions.
        stopPersistentProc('new session');

        claudeModel = model || 'claude-haiku-4-5-20251001';

        if (claudeMode === 'cli') {
            // Resolve/validate the CLI and warm the transport entirely in the
            // background. Session activation only waits for Whisper — a slow
            // Claude cold-start must never keep the session listening-but-mute,
            // and the first transcript queues behind isTransportReady instead
            // of being dropped or racing the warm-up.
            warmUpClaude()
                .catch(error => {
                    console.warn('[Claude] Warm-up failed (non-fatal):', error.message);
                })
                .finally(() => {
                    if (generation !== sessionGeneration) return; // session closed/replaced meanwhile
                    isTransportReady = true;
                    console.log(`[Claude] Transport ready ${Date.now() - initStartedAt}ms after init start`);
                    if (!isClaudeActive) return; // still initializing — activation sets the status
                    if (pendingTranscripts.length > 0) {
                        scheduleFlush(0);
                    } else if (!isTranscriptResponseInFlight) {
                        sendToRenderer('update-status', 'Claude ready - Listening...');
                    }
                });
        } else {
            if (!anthropicApiKey || !anthropicApiKey.trim()) {
                sendToRenderer('session-initializing', false);
                sendToRenderer('update-status', 'Anthropic API key required');
                return false;
            }
            const Anthropic = getAnthropic();
            anthropicClient = new Anthropic({ apiKey: anthropicApiKey.trim() });
            isTransportReady = true; // direct API needs no warm-up
        }

        // Load Whisper for speech-to-text (audio → transcript → Claude)
        const whisperStartedAt = Date.now();
        // The bias prompt must be in the same script Whisper is asked to emit,
        // so it depends on the transcription language, not just the profile.
        let whisperLanguage = 'en';
        try {
            whisperLanguage = storage.getPreferences().whisperLanguage || 'en';
        } catch (error) {
            console.warn('[Claude] Could not read whisperLanguage preference, defaulting to en:', error.message);
        }
        const pipeline = await transcriber.initWhisper(whisperModel, {
            contextPrompt: whisperContextPromptForProfile(profile, whisperLanguage),
        });
        if (!pipeline) {
            sendToRenderer('session-initializing', false);
            return false;
        }
        console.log(`[Claude] Whisper ready in ${Date.now() - whisperStartedAt}ms`);

        transcriber.resetTranscriber();
        transcriber.setOnTranscript(routeTranscript);

        initializeNewSession(profile, customPrompt);

        // Go live now — the Claude warm-up keeps running in the background and
        // any speech heard before it finishes queues until the transport is ready.
        isClaudeActive = true;
        isAudioMuted = false;
        autoAnswerEnabled = readAutoAnswerPreference();
        sendToRenderer('auto-answer-toggled', autoAnswerEnabled);
        sendToRenderer('session-initializing', false);
        sendToRenderer(
            'update-status',
            !autoAnswerEnabled
                ? `Auto answer off — press ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+G to answer`
                : isTransportReady
                  ? 'Claude ready - Listening...'
                  : 'Listening... (Claude preparing)'
        );

        console.log(`[Claude] Session initialized in ${claudeMode} mode in ${Date.now() - initStartedAt}ms (transport ready: ${isTransportReady})`);
        return true;
    } catch (error) {
        console.error('[Claude] Initialization error:', error);
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Claude error: ' + error.message);
        return false;
    }
}

// source: 'speaker' (system audio / the other person) or 'mic' (the user).
function processClaudeAudio(monoChunk24k, source = 'speaker') {
    if (!isClaudeActive) return;
    if (isAudioMuted) return; // listening paused — drop the frame, keep capture alive
    transcriber.processAudio24k(monoChunk24k, source);
}

// Pause/resume listening without tearing down audio capture. Returns the new state.
function toggleAudioMute() {
    isAudioMuted = !isAudioMuted;
    console.log('[Claude] Audio mute toggled:', isAudioMuted);
    sendToRenderer('audio-muted-toggled', isAudioMuted);
    sendToRenderer('update-status', isAudioMuted ? 'Muted — not listening' : 'Listening...');
    return isAudioMuted;
}

function isAudioMutedState() {
    return isAudioMuted;
}

function toggleAutoAnswer() {
    autoAnswerEnabled = !autoAnswerEnabled;
    console.log('[Claude] Auto answer toggled:', autoAnswerEnabled);
    try {
        storage.updatePreference('autoAnswer', autoAnswerEnabled);
    } catch (error) {
        console.warn('[Claude] Could not persist autoAnswer preference:', error.message);
    }
    sendToRenderer('auto-answer-toggled', autoAnswerEnabled);
    if (autoAnswerEnabled) {
        if (isClaudeActive && pendingTranscripts.length > 0) scheduleFlush();
        sendToRenderer('update-status', 'Auto answer on — Listening...');
    } else {
        sendToRenderer('update-status', `Auto answer off — press ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+G to answer`);
    }
    return autoAnswerEnabled;
}

function isAutoAnswerEnabled() {
    return autoAnswerEnabled;
}

// Push-to-talk: open the mic gate while the user is holding/toggling the
// shortcut, then on release force-transcribe the buffered speech and restore
// the prior mute state so listening stops again until the next push-to-talk.
let muteStateBeforePushToTalk = false;
function setPushToTalk(active) {
    if (!isClaudeActive) return false;
    if (active) {
        muteStateBeforePushToTalk = isAudioMuted;
        isAudioMuted = false;
        console.log('[Claude] Push-to-talk: listening');
        sendToRenderer('audio-muted-toggled', false);
        sendToRenderer('update-status', '🎤 Listening — speak your question, then press the key again');
    } else {
        console.log('[Claude] Push-to-talk: sending question');
        // Drains the mic buffer but labels the result MIC_ASK_SOURCE, so this
        // one utterance is asked as a question instead of filed as the user's
        // own speech. The intent travels with the job, so it holds however long
        // transcription takes.
        const hadSpeech = transcriber.flush('mic', { asSource: MIC_ASK_SOURCE });
        isAudioMuted = muteStateBeforePushToTalk;
        sendToRenderer('audio-muted-toggled', isAudioMuted);
        sendToRenderer('update-status', hadSpeech ? 'Transcribing your question...' : 'No speech detected — speak louder or closer to the mic');
    }
    return true;
}

// The CLI's per-project conversation store can lose a session we still hold
// an id for (transcript cleanup, store moved). When resume fails that way,
// drop the id so the caller can retry once on a fresh conversation — losing
// context beats failing the request outright.
function retryWithFreshSession(result) {
    if (result.success || !/No conversation found with session ID/i.test(result.error || '')) {
        return false;
    }
    console.warn('[Claude] Session id no longer resumable — retrying with a fresh conversation');
    cliSessionId = null;
    return true;
}

// recordAsQuestion: the clean question text to remember for a later detailed
// expansion (defaults to the sent text). Internal prompts that are not the
// user's question — the expand prompt itself — pass null to keep the original.
// detailed: lift the API-mode token cap (expansions, structured design turns).
async function sendClaudeText(text, { recordAsQuestion = text, detailed = false } = {}) {
    if (!isClaudeActive && claudeMode !== 'cli') {
        return { success: false, error: 'No active Claude session' };
    }

    const trimmed = text.trim();
    if (!trimmed) {
        return { success: false, error: 'Empty message' };
    }

    console.log('[Claude] Sending text:', trimmed.substring(0, 100) + '...');

    // A detected system-design question gets the structured framework for
    // this turn only. Detection runs on the clean question (recordAsQuestion
    // for wrapped prompts like answerWithContext); the injected rules are
    // never saved or recorded — they are instructions, not conversation.
    const questionText = recordAsQuestion === null ? null : recordAsQuestion || trimmed;
    const spokenTurn = !detailed && readSpeakerModePreference();
    const isDesignTurn = !spokenTurn && !!(questionText && isSystemDesignQuestion(questionText));
    if (isDesignTurn) console.log('[Claude] System design question detected — structured answer mode');
    if (spokenTurn) console.log('[Claude] Speaker-only mode — spoken-brevity answer requested');
    const outgoing = spokenTurn ? CLAUDE_SPOKEN_TURN_RULES + '\n\n' + trimmed : isDesignTurn ? SYSTEM_DESIGN_TURN_RULES + '\n\n' + trimmed : trimmed;

    if (claudeMode === 'cli') {
        // The installed CLI is authoritative for text requests. On a lost
        // resume session, retry once without --resume; on any other failure
        // (startup, auth, malformed stream, timeout, empty response) fall back
        // to the SDK exactly once. A supersede/close abort ('Cancelled') is
        // intentional and must not trigger the fallback.
        let result;
        if (cliUnavailable) {
            result = { success: false, error: 'Claude CLI not found' };
        } else {
            result = await runCliTransport(outgoing, { allowedTools: cliAllowedTools() });
            if (retryWithFreshSession(result)) {
                result = await runCliTransport(outgoing, { allowedTools: cliAllowedTools() });
            }
        }
        if (!result.success && result.error !== 'Cancelled') {
            console.warn(`[Claude] Direct CLI failed (${result.error}) — falling back to the SDK for this request`);
            sendToRenderer('update-status', 'Claude CLI failed — retrying via SDK...');
            result = await runClaudeQuery(outgoing);
            if (retryWithFreshSession(result)) {
                result = await runClaudeQuery(outgoing);
            }
        }
        if (result.success && result.text) {
            // Persist the clean question, never the wrapper. `trimmed` may carry
            // the user's-own-speech context block or a manual-override preamble;
            // the saved history and the History view want what was actually asked.
            saveConversationTurn(questionText || trimmed, result.text);
            setLastAnswerText(result.text);
            if (recordAsQuestion && recordAsQuestion.trim()) lastAnsweredQuestion = recordAsQuestion.trim();
        }
        sendToRenderer('response-complete'); // reveal the finished answer in the UI
        return result;
    }

    claudeConversationHistory.push({ role: 'user', content: outgoing });
    if (claudeConversationHistory.length > 20) {
        claudeConversationHistory = claudeConversationHistory.slice(-20);
    }

    try {
        const fullText = await streamAnthropicMessages(claudeConversationHistory, {
            maxTokens: detailed || isDesignTurn ? API_MAX_TOKENS_DETAILED : spokenTurn ? API_MAX_TOKENS_SPOKEN : API_MAX_TOKENS,
        });

        // Keep the clean question in history — the injected framework rules
        // are per-turn instructions and would bloat every later request.
        if (isDesignTurn) {
            claudeConversationHistory[claudeConversationHistory.length - 1] = { role: 'user', content: trimmed };
        }

        if (fullText.trim()) {
            claudeConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(questionText || trimmed, fullText);
            setLastAnswerText(fullText.trim());
            if (recordAsQuestion && recordAsQuestion.trim()) lastAnsweredQuestion = recordAsQuestion.trim();
        }

        console.log('[Claude] Response completed');
        sendToRenderer('update-status', 'Listening...');
        sendToRenderer('response-complete');
        return { success: true };
    } catch (error) {
        console.error('[Claude] API error:', error);
        const message = anthropicErrorMessage(error);
        sendToRenderer('update-status', message);
        sendToRenderer('response-complete');
        return { success: false, error: message };
    }
}

async function sendClaudeImage(base64Data, prompt) {
    if (!isClaudeActive) {
        return { success: false, error: 'No active Claude session' };
    }

    sendToRenderer('update-status', 'Analyzing image...');

    if (claudeMode === 'cli') {
        // The CLI can't take inline images, but it can Read image files. The
        // persistent session is spawned with Read allowed, so this rides the
        // warm process too; the one-shot fallback passes allowedTools itself.
        const tmpPath = path.join(os.tmpdir(), `cd-screen-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
        try {
            await fs.promises.writeFile(tmpPath, Buffer.from(base64Data, 'base64'));
            let result = await runCliTransport(`Read and analyze the image at ${tmpPath}. ${prompt}`, {
                allowedTools: ['Read'],
            });
            if (retryWithFreshSession(result)) {
                result = await runCliTransport(`Read and analyze the image at ${tmpPath}. ${prompt}`, {
                    allowedTools: ['Read'],
                });
            }
            if (result.success && result.text) {
                saveScreenAnalysis(prompt, result.text, 'claude-cli');
                return { success: true, text: result.text, model: 'claude-cli' };
            }
            return result;
        } finally {
            try {
                await fs.promises.unlink(tmpPath);
            } catch (cleanupError) {
                // Temp file already gone
            }
            sendToRenderer('response-complete'); // reveal the finished answer in the UI
        }
    }

    claudeConversationHistory.push({
        role: 'user',
        content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Data } },
            { type: 'text', text: prompt },
        ],
    });
    if (claudeConversationHistory.length > 20) {
        claudeConversationHistory = claudeConversationHistory.slice(-20);
    }

    try {
        const fullText = await streamAnthropicMessages(claudeConversationHistory);

        // Replace the image turn with text-only so base64 blobs don't compound
        // into every subsequent request
        claudeConversationHistory[claudeConversationHistory.length - 1] = { role: 'user', content: prompt };

        if (fullText.trim()) {
            claudeConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveScreenAnalysis(prompt, fullText, claudeModel);
        }

        console.log('[Claude] Image response completed');
        sendToRenderer('update-status', 'Listening...');
        sendToRenderer('response-complete');
        return { success: true, text: fullText, model: claudeModel };
    } catch (error) {
        console.error('[Claude] Image error:', error);
        // Drop the failed image turn from history
        claudeConversationHistory.pop();
        const message = anthropicErrorMessage(error);
        sendToRenderer('update-status', message);
        sendToRenderer('response-complete');
        return { success: false, error: message };
    }
}

function closeClaudeSession() {
    console.log('[Claude] Closing Claude session');
    sessionGeneration++; // invalidate any in-flight warm-up completion callback
    isClaudeActive = false;
    isTransportReady = false;
    isAudioMuted = false;
    if (transcriptDebounceTimer) {
        clearTimeout(transcriptDebounceTimer);
        transcriptDebounceTimer = null;
    }
    pendingTranscripts = [];
    recentHeardTranscripts = [];
    unsentUserSpeech = [];
    recentSpeakerSpeech = [];
    recentSpeakerSpeechSets = [];
    setLastAnswerText('');
    lastAnsweredQuestion = null;
    isTranscriptResponseInFlight = false;
    lastSentTranscriptTurn = null;
    inFlightIsSupersedable = false;
    pendingFirstQueuedAt = 0;
    supersedeCount = 0;
    inFlightStartedAt = 0;
    if (activeCliAbort) {
        activeCliAbort.abort();
        activeCliAbort = null;
    }
    if (activeCliProc) {
        try {
            activeCliProc.kill('SIGTERM');
        } catch (killError) {
            // Process already exited
        }
        activeCliProc = null;
    }
    // The abort above marks any in-flight persistent turn as cancelled; kill
    // the process immediately rather than waiting out the interrupt grace.
    stopPersistentProc('session closed');
    transcriber.resetTranscriber();
    claudeConversationHistory = [];
    anthropicClient = null;
    cliSessionId = null;
    currentSystemPrompt = null;
}

function isClaudeSessionActive() {
    return isClaudeActive;
}

module.exports = {
    initializeClaudeSession,
    processClaudeAudio,
    toggleAudioMute,
    isAudioMutedState,
    toggleAutoAnswer,
    isAutoAnswerEnabled,
    setPushToTalk,
    sendClaudeText,
    sendClaudeImage,
    answerWithContext,
    expandLastAnswer,
    closeClaudeSession,
    isClaudeSessionActive,
    isClaudeActiveState: isClaudeSessionActive,
};

// Test seam. The transports cross process/SDK boundaries that unit tests must
// stub (spawned CLI processes, the dynamically imported Claude Code SDK), and
// the module keeps its state in closures — this gives tests a controlled way
// in without touching production behavior.
module.exports._testing = {
    cliAllowedTools,
    readWebSearchPreference,
    setWebSearchEnabledForTests(enabled) {
        webSearchEnabled = enabled;
    },
    readAutoAnswerPreference,
    readSpeakerModePreference,
    CLAUDE_SPOKEN_TURN_RULES,
    toggleAutoAnswer,
    isAutoAnswerEnabled,
    setAutoAnswerForTests(enabled) {
        autoAnswerEnabled = enabled;
    },
    isMeaningfulTranscript,
    isSystemDesignQuestion,
    nextFlushDelay,
    whisperContextPromptForProfile,
    routeTranscript,
    recordUserSpeech,
    rememberSpeakerSpeech,
    looksLikeEcho,
    peekUserSpeechContext,
    clearUserSpeechContext,
    withUserSpeechContext,
    MIC_ASK_SOURCE,
    runClaudeCli,
    classifyCliFailure,
    queueTranscript,
    CLAUDE_CONCISE_RESPONSE_PROMPT,
    CLAUDE_CONVERSATIONAL_RESPONSE_PROMPT,
    SYSTEM_DESIGN_TURN_RULES,
    setQueryFnForTests(fn) {
        _queryFn = fn;
    },
    setStateForTests({ active, transportReady, sessionId, mode, model } = {}) {
        if (active !== undefined) isClaudeActive = active;
        if (transportReady !== undefined) isTransportReady = transportReady;
        if (sessionId !== undefined) cliSessionId = sessionId;
        if (mode !== undefined) claudeMode = mode;
        if (model !== undefined) claudeModel = model;
    },
    getStateForTests() {
        return {
            cliSessionId,
            cliPath,
            cliUnavailable,
            isTransportReady,
            isTranscriptResponseInFlight,
            pendingCount: pendingTranscripts.length,
            unsentUserSpeechCount: unsentUserSpeech.length,
            persistentAlive: !!persistentProc,
            persistentDisabled,
        };
    },
    resetForTests() {
        closeClaudeSession();
        cliPath = null;
        cliEnv = null;
        cliUnavailable = false;
        cliResolutionPromise = null;
        isTransportReady = false;
        autoAnswerEnabled = true;
        claudeMode = 'cli';
        _queryFn = null;
        persistentDisabled = false;
        persistentEverCompletedTurn = false;
        persistentStderr = '';
        persistentTurnHandler = null;
        persistentTurnChain = Promise.resolve();
    },
};
