import { html, css, nothing, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { MainView } from '../views/MainView.js';
import { CustomizeView } from '../views/CustomizeView.js';
import { HelpView } from '../views/HelpView.js';
import { HistoryView } from '../views/HistoryView.js';
import { AssistantView } from '../views/AssistantView.js';
import { OnboardingView } from '../views/OnboardingView.js';
import { AICustomizeView } from '../views/AICustomizeView.js';
import { FeedbackView } from '../views/FeedbackView.js';

export class CheatingDaddyApp extends LitElement {
    static styles = css`
        * {
            box-sizing: border-box;
            font-family: var(--font);
            margin: 0;
            padding: 0;
            cursor: default;
            user-select: none;
        }

        :host {
            --shell-veil: rgba(9, 9, 11, 0.72);
            --shell-veil-strong: rgba(9, 9, 11, 0.86);
            --shell-hairline: rgba(255, 255, 255, 0.07);
            --shell-hairline-strong: rgba(255, 255, 255, 0.16);
            --shell-ink: #ededed;
            --shell-ink-dim: #9a9a9a;
            --shell-ink-faint: #7c7c7c;
            --shell-signal: #7aa2f7;
            --shell-signal-warm: #d98a5f;

            --shell-space-1: 4px;
            --shell-space-2: 8px;
            --shell-space-3: 12px;
            --shell-space-4: 16px;
            --shell-space-5: 24px;
            --shell-space-6: 40px;

            --shell-micro: 11px;
            --shell-label: 13px;
            --shell-body: 15px;
            --shell-display: 24px;

            --shell-hud-h: 32px;
            --shell-hud-h-slim: 14px;
            --shell-rail: 2px;
            --shell-motion: 180ms cubic-bezier(0.2, 0, 0, 1);

            display: block;
            width: 100%;
            height: 100vh;
            /* Transparent: the single background tint is painted by <body> so the
               backgroundTransparency alpha isn't compounded across stacked layers. */
            background: transparent;
            color: var(--text-primary);
        }

        /* ── Full app shell: top bar + sidebar/content ── */

        .app-shell {
            display: flex;
            height: 100vh;
            overflow: hidden;
        }

        .top-drag-bar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 9999;
            display: flex;
            align-items: center;
            height: 38px;
            background: transparent;
        }

        .drag-region {
            flex: 1;
            height: 100%;
            -webkit-app-region: drag;
        }

        .top-drag-bar.hidden {
            display: none;
        }

        .traffic-lights {
            display: flex;
            align-items: center;
            gap: var(--shell-space-2);
            padding: 0 var(--shell-space-4);
            height: 100%;
            -webkit-app-region: no-drag;
        }

        .traffic-light {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            border: none;
            cursor: pointer;
            padding: 0;
            transition: opacity var(--shell-motion);
        }

        .traffic-light:hover {
            opacity: 0.8;
        }

        .traffic-light:focus-visible {
            outline: var(--shell-rail) solid var(--shell-signal);
            outline-offset: var(--shell-space-1);
        }

        .traffic-light.close {
            background: #ff5f57;
        }

        .traffic-light.minimize {
            background: #febc2e;
        }

        .traffic-light.maximize {
            background: #28c840;
        }

        .sidebar {
            width: var(--sidebar-width);
            min-width: var(--sidebar-width);
            background: var(--shell-veil);
            backdrop-filter: var(--blur-backdrop);
            border-right: 1px solid var(--shell-hairline);
            display: flex;
            flex-direction: column;
            padding: var(--shell-space-6) 0 var(--shell-space-4) 0;
            transition:
                width var(--shell-motion),
                min-width var(--shell-motion),
                opacity var(--shell-motion);
        }

        .sidebar.hidden {
            width: 0;
            min-width: 0;
            padding: 0;
            overflow: hidden;
            border-right: none;
            opacity: 0;
        }

        .sidebar-brand {
            display: flex;
            align-items: center;
            gap: var(--shell-space-3);
            padding: var(--shell-space-2) var(--shell-space-5);
            margin-bottom: var(--shell-space-5);
        }

        .sidebar-brand::before {
            content: '';
            width: var(--shell-rail);
            height: var(--shell-display);
            background: var(--shell-signal);
            border-radius: 1px;
        }

        .sidebar-brand h1 {
            font-size: var(--shell-display);
            font-weight: var(--font-weight-semibold);
            letter-spacing: var(--tracking-tight);
            color: var(--shell-ink);
            line-height: var(--line-height-tight);
        }

        .sidebar-nav {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: var(--shell-space-1);
            padding: 0 var(--shell-space-2);
            -webkit-app-region: no-drag;
        }

        .nav-item {
            position: relative;
            display: flex;
            align-items: center;
            gap: var(--shell-space-3);
            padding: var(--shell-space-2) var(--shell-space-3);
            border-radius: var(--radius-sm);
            color: var(--shell-ink-dim);
            font-size: var(--shell-label);
            font-weight: var(--font-weight-medium);
            cursor: pointer;
            transition:
                color var(--shell-motion),
                background var(--shell-motion);
            border: none;
            background: none;
            width: 100%;
            text-align: left;
        }

        .nav-item::before {
            content: '';
            position: absolute;
            left: 0;
            top: 50%;
            width: var(--shell-rail);
            height: 0;
            background: var(--shell-signal);
            border-radius: 1px;
            transform: translateY(-50%);
            transition: height var(--shell-motion);
        }

        .nav-item:hover {
            color: var(--shell-ink);
            background: var(--shell-hairline);
        }

        .nav-item:focus-visible {
            outline: 1px solid var(--shell-signal);
            outline-offset: -1px;
            color: var(--shell-ink);
        }

        .nav-item.active {
            color: var(--shell-ink);
            background: var(--shell-hairline);
        }

        .nav-item.active::before {
            height: 60%;
        }

        .nav-item svg {
            width: 18px;
            height: 18px;
            flex-shrink: 0;
        }

        .sidebar-footer {
            padding: var(--shell-space-2);
            margin-top: var(--shell-space-2);
            -webkit-app-region: no-drag;
        }

        .update-btn {
            display: flex;
            align-items: center;
            gap: var(--shell-space-2);
            width: 100%;
            padding: var(--shell-space-2) var(--shell-space-3);
            border-radius: var(--radius-sm);
            border: 1px solid var(--shell-hairline-strong);
            background: none;
            color: var(--shell-ink-dim);
            font-size: var(--shell-label);
            font-weight: var(--font-weight-medium);
            cursor: pointer;
            text-align: left;
            transition:
                color var(--shell-motion),
                border-color var(--shell-motion);
        }

        .update-btn:hover,
        .update-btn:focus-visible {
            color: var(--shell-ink);
            border-color: var(--shell-signal);
            outline: none;
        }

        .update-btn svg {
            width: 16px;
            height: 16px;
            flex-shrink: 0;
        }

        .version-text {
            font-family: var(--font-mono);
            font-size: var(--shell-micro);
            color: var(--shell-ink-faint);
            padding: var(--shell-space-1) var(--shell-space-3);
        }

        /* ── Main content area ── */

        .content {
            flex: 1;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: url('data:image/svg+xml;utf8,<svg width="20" height="20" xmlns="http://www.w3.org/2000/svg"><circle cx="2" cy="2" r="1" fill="rgba(255,255,255,0.03)"/></svg>');
            /* No solid fill here — <body> provides the single tinted layer so the
               transparency slider maps linearly instead of being cubed away. */
            background-color: transparent;
        }

        .hud {
            display: flex;
            align-items: center;
            gap: var(--shell-space-3);
            height: var(--shell-hud-h);
            padding: 0 var(--shell-space-3);
            background: var(--shell-veil);
            backdrop-filter: var(--blur-backdrop);
            border-bottom: 1px solid var(--shell-hairline);
            overflow: hidden;
            -webkit-app-region: drag;
            transition: height var(--shell-motion);
        }

        .hud-lead {
            display: flex;
            align-items: center;
            gap: var(--shell-space-2);
            flex-shrink: 0;
            -webkit-app-region: no-drag;
        }

        .hud-back {
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--shell-ink-faint);
            cursor: pointer;
            background: none;
            border: none;
            padding: var(--shell-space-1);
            border-radius: var(--radius-sm);
            transition: color var(--shell-motion);
        }

        .hud-back:hover {
            color: var(--shell-ink);
        }

        .hud-back:focus-visible {
            outline: 1px solid var(--shell-signal);
            color: var(--shell-ink);
        }

        .hud-back svg {
            width: 14px;
            height: 14px;
        }

        .hud-state {
            display: flex;
            align-items: center;
            gap: var(--shell-space-2);
            font-family: var(--font-mono);
            font-size: var(--shell-micro);
            letter-spacing: var(--tracking-wide);
            text-transform: uppercase;
            color: var(--shell-ink-dim);
            white-space: nowrap;
        }

        .hud-state::before {
            content: '';
            width: var(--shell-rail);
            height: var(--shell-space-4);
            background: var(--shell-signal);
            border-radius: 1px;
        }

        .hud-state[data-state='paused']::before,
        .hud-state[data-state='manual']::before {
            background: var(--shell-signal-warm);
        }

        .hud-meta {
            display: flex;
            align-items: baseline;
            gap: var(--shell-space-3);
            flex: 1;
            min-width: 0;
            font-family: var(--font-mono);
            font-size: var(--shell-micro);
            color: var(--shell-ink-faint);
        }

        .hud-status {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--shell-ink-dim);
        }

        .hud-clock {
            flex-shrink: 0;
            font-variant-numeric: tabular-nums;
        }

        .hud-tools {
            display: flex;
            align-items: center;
            gap: var(--shell-space-1);
            flex-shrink: 0;
            -webkit-app-region: no-drag;
        }

        .chip {
            display: flex;
            align-items: center;
            gap: var(--shell-space-1);
            padding: var(--shell-space-1) var(--shell-space-2);
            border: 1px solid transparent;
            border-radius: var(--radius-sm);
            background: none;
            color: var(--shell-ink-faint);
            font-family: var(--font-mono);
            font-size: var(--shell-micro);
            letter-spacing: var(--tracking-wide);
            text-transform: uppercase;
            white-space: nowrap;
            cursor: pointer;
            transition:
                color var(--shell-motion),
                border-color var(--shell-motion),
                background var(--shell-motion);
        }

        .chip svg {
            width: 13px;
            height: 13px;
            flex-shrink: 0;
        }

        .chip:hover {
            color: var(--shell-ink);
            background: var(--shell-hairline);
            border-color: var(--shell-hairline-strong);
        }

        .chip:focus-visible {
            outline: none;
            color: var(--shell-ink);
            border-color: var(--shell-signal);
        }

        .chip[data-alert] {
            color: var(--shell-signal-warm);
        }

        .chip[data-alert]:hover {
            color: var(--shell-signal-warm);
            background: var(--shell-hairline);
        }

        :host([stealth]) {
            --line-height-relaxed: 1.7;
        }

        :host([stealth]) .hud {
            height: var(--shell-hud-h-slim);
            padding: 0 var(--shell-space-2);
            border-bottom-color: transparent;
            background: transparent;
        }

        :host([stealth]) .hud-back,
        :host([stealth]) .hud-tools,
        :host([stealth]) .hud-status {
            opacity: 0;
            pointer-events: none;
        }

        :host([stealth]) .hud:hover,
        :host([stealth]) .hud:focus-within {
            height: var(--shell-hud-h);
            padding: 0 var(--shell-space-3);
            background: var(--shell-veil-strong);
            border-bottom-color: var(--shell-hairline);
        }

        :host([stealth]) .hud:hover .hud-back,
        :host([stealth]) .hud:hover .hud-tools,
        :host([stealth]) .hud:hover .hud-status,
        :host([stealth]) .hud:focus-within .hud-back,
        :host([stealth]) .hud:focus-within .hud-tools,
        :host([stealth]) .hud:focus-within .hud-status {
            opacity: 1;
            pointer-events: auto;
        }

        :host([stealth]) .content {
            background-image: none;
        }

        :host([stealth]) .hud-state {
            font-size: 0;
            gap: 0;
        }

        :host([stealth]) .hud:hover .hud-state,
        :host([stealth]) .hud:focus-within .hud-state {
            font-size: var(--shell-micro);
            gap: var(--shell-space-2);
        }

        @media (max-width: 460px) {
            .hud-status {
                display: none;
            }

            .chip-label {
                display: none;
            }
        }

        @media (max-width: 360px) {
            .hud-state {
                font-size: 0;
                gap: 0;
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .hud,
            .chip,
            .nav-item,
            .nav-item::before,
            .sidebar,
            .update-btn {
                transition: none;
            }
        }

        /* Content inner */
        .content-inner {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
        }

        .content-inner.live {
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        /* Onboarding fills everything */
        .fullscreen {
            position: fixed;
            inset: 0;
            z-index: 100;
            background: var(--bg-app);
        }

        ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }

        ::-webkit-scrollbar-track {
            background: transparent;
        }

        ::-webkit-scrollbar-thumb {
            background: var(--shell-hairline-strong);
            border-radius: 3px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--shell-ink-faint);
        }
    `;

    static properties = {
        currentView: { type: String },
        statusText: { type: String },
        startTime: { type: Number },
        isRecording: { type: Boolean },
        sessionActive: { type: Boolean },
        selectedProfile: { type: String },
        selectedLanguage: { type: String },
        responses: { type: Array },
        transcripts: { type: Array },
        interimTranscript: { type: String },
        interimTranscriptSource: { type: String },
        currentResponseIndex: { type: Number },
        selectedScreenshotInterval: { type: String },
        selectedImageQuality: { type: String },
        layoutMode: { type: String },
        _viewInstances: { type: Object, state: true },
        _isClickThrough: { state: true },
        _isAudioMuted: { state: true },
        _autoAnswer: { state: true },
        _isResponseStreaming: { state: true },
        _awaitingNewResponse: { state: true },
        shouldAnimateResponse: { type: Boolean },
        _storageLoaded: { state: true },
        _updateAvailable: { state: true },
        _whisperDownloading: { state: true },
        _speakerMode: { state: true },
        stealthMode: { type: Boolean, reflect: true, attribute: 'stealth' },
    };

    constructor() {
        super();
        this.currentView = 'main';
        this.statusText = '';
        this.startTime = null;
        this.isRecording = false;
        this.sessionActive = false;
        this.selectedProfile = 'interview';
        this.selectedLanguage = 'en-US';
        this.selectedScreenshotInterval = '5';
        this.selectedImageQuality = 'medium';
        this.layoutMode = 'normal';
        this.responses = [];
        this.transcripts = [];
        this.interimTranscript = '';
        this.interimTranscriptSource = 'speaker';
        this._interimClearTimer = null;
        this.currentResponseIndex = -1;
        this._viewInstances = new Map();
        this._isClickThrough = false;
        this._isAudioMuted = false;
        this._autoAnswer = true;
        this._isResponseStreaming = false;
        this._awaitingNewResponse = false;
        this._currentResponseIsComplete = true;
        this._responseWasSuperseded = false;
        this._transcriptWasSuperseded = false;
        this.shouldAnimateResponse = false;
        this._storageLoaded = false;
        this._timerInterval = null;
        this._updateAvailable = false;
        this._whisperDownloading = false;
        this._localVersion = '';
        this.stealthMode = false;

        // Speaker (audio-only) mode: window hidden, answers spoken aloud.
        this._speakerMode = false;
        this._ttsDebounceTimer = null;
        this._lastSpokenText = null;
        this._cachedVoice = null;
        this._voiceCacheKey = null;

        this._loadFromStorage();
        this._checkForUpdates();
    }

    async _checkForUpdates() {
        try {
            this._localVersion = await cheatingDaddy.getVersion();
            this.requestUpdate();

            const res = await fetch('https://raw.githubusercontent.com/sohzm/help-guru/refs/heads/master/package.json');
            if (!res.ok) return;
            const remote = await res.json();
            const remoteVersion = remote.version;

            const toNum = v => v.split('.').map(Number);
            const [rMaj, rMin, rPatch] = toNum(remoteVersion);
            const [lMaj, lMin, lPatch] = toNum(this._localVersion);

            if (rMaj > lMaj || (rMaj === lMaj && rMin > lMin) || (rMaj === lMaj && rMin === lMin && rPatch > lPatch)) {
                this._updateAvailable = true;
                this.requestUpdate();
            }
        } catch (e) {
            // silently ignore
        }
    }

    async _loadFromStorage() {
        try {
            const [config, prefs] = await Promise.all([cheatingDaddy.storage.getConfig(), cheatingDaddy.storage.getPreferences()]);

            this.currentView = config.onboarded ? 'main' : 'onboarding';
            this.selectedProfile = prefs.selectedProfile || 'interview';
            this.selectedLanguage = prefs.selectedLanguage || 'en-US';
            this.selectedScreenshotInterval = prefs.selectedScreenshotInterval || '5';
            this.selectedImageQuality = prefs.selectedImageQuality || 'medium';
            this.layoutMode = config.layout || 'normal';
            this._speakerMode = prefs.speakerMode ?? false;
            this._autoAnswer = prefs.autoAnswer ?? true;
            this.stealthMode = prefs.stealthMode ?? false;

            this._storageLoaded = true;
            this.requestUpdate();
        } catch (error) {
            console.error('Error loading from storage:', error);
            this._storageLoaded = true;
            this.requestUpdate();
        }
    }

    connectedCallback() {
        super.connectedCallback();

        if (window.speechSynthesis) {
            window.speechSynthesis.getVoices();
            window.speechSynthesis.onvoiceschanged = () => {
                this._cachedVoice = null;
                this._voiceCacheKey = null;
            };
        }

        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.on('new-response', (_, response) => {
                const replaceStalePartial = this._responseWasSuperseded;
                this._responseWasSuperseded = false;
                this._isResponseStreaming = true;
                // A fresh answer is starting — stop reading the previous one aloud
                // and let the debounce below re-arm for this one.
                if (this._speakerMode) {
                    this._stopSpeaking();
                    this._lastSpokenText = null;
                }
                this.addNewResponse(response, replaceStalePartial);
                this._scheduleSpeak();
            });
            ipcRenderer.on('update-response', (_, response) => {
                this.updateCurrentResponse(response);
                this._scheduleSpeak();
            });
            ipcRenderer.on('response-complete', () => {
                this._isResponseStreaming = false;
                // Claude fires this; other providers don't, which is why the
                // update-debounce fallback also speaks. Both funnel through
                // _speakLatest(), which de-dupes on the spoken text.
                this._speakLatest();
            });
            // The in-flight auto-answer was aborted because the speaker kept
            // going; the combined resend replaces the stale partial card and
            // "Heard" entry instead of stacking junk pages per supersede.
            ipcRenderer.on('response-superseded', () => {
                this._responseWasSuperseded = this._responseWasSuperseded || this._isResponseStreaming;
                this._transcriptWasSuperseded = true;
                // The in-flight answer was aborted — don't speak the stale partial.
                if (this._speakerMode) this._stopSpeaking();
            });
            ipcRenderer.on('new-transcript', (_, transcript) => {
                const entry = { text: transcript, source: 'speaker' };
                // Only a speaker entry can be superseded — the combined resend
                // replaces it. A "you" entry in between must not be clobbered.
                const last = this.transcripts[this.transcripts.length - 1];
                if (this._transcriptWasSuperseded && last && last.source === 'speaker') {
                    // The combined transcript contains the superseded one.
                    this.transcripts = [...this.transcripts.slice(0, -1), entry];
                } else {
                    this.transcripts = [...this.transcripts, entry];
                }
                this._transcriptWasSuperseded = false;
                this._clearInterim();
                this.requestUpdate();
            });
            // The user's own speech (mic). Shown in the transcript strip labelled
            // "You" so they can see it was heard, but it produces no answer — it
            // is context for the next question the other person asks.
            ipcRenderer.on('user-transcript', (_, transcript) => {
                if (!transcript) return;
                this.transcripts = [...this.transcripts, { text: transcript, source: 'user' }];
                // A finalized "you" line replaces the live caption that produced it.
                this._clearInterim();
                this.requestUpdate();
            });
            // Live partial transcript while someone is still speaking. Replaced
            // by the finalized entry when 'new-transcript'/'user-transcript'
            // lands; cleared on a safety timeout in case the utterance was
            // filtered as filler and no final transcript ever arrives.
            ipcRenderer.on('interim-transcript', (_, payload) => {
                // Payload is { text, source }; tolerate a bare string in case an
                // older provider path still sends one.
                const { text, source } = typeof payload === 'string' ? { text: payload, source: 'speaker' } : payload || {};
                this.interimTranscript = text || '';
                this.interimTranscriptSource = source === 'mic' ? 'user' : 'speaker';
                if (this._interimClearTimer) clearTimeout(this._interimClearTimer);
                this._interimClearTimer = setTimeout(() => this._clearInterim(), 5000);
                this.requestUpdate();
            });
            ipcRenderer.on('update-status', (_, status) => this.setStatus(status));
            ipcRenderer.on('click-through-toggled', (_, isEnabled) => {
                this._isClickThrough = isEnabled;
            });
            ipcRenderer.on('audio-muted-toggled', (_, muted) => {
                this._isAudioMuted = muted;
            });
            ipcRenderer.on('auto-answer-toggled', (_, enabled) => {
                this._autoAnswer = enabled;
            });
            ipcRenderer.on('audio-mute-shortcut', () => this.handleToggleAudio());
            ipcRenderer.on('toggle-auto-answer-shortcut', () => this.handleToggleAutoAnswer());
            ipcRenderer.on('toggle-speaker-mode-shortcut', () => this.toggleSpeakerMode());
            ipcRenderer.on('reconnect-failed', (_, data) => this.addNewResponse(data.message));
            ipcRenderer.on('whisper-downloading', (_, downloading) => {
                this._whisperDownloading = downloading;
            });
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopTimer();
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.removeAllListeners('new-response');
            ipcRenderer.removeAllListeners('update-response');
            ipcRenderer.removeAllListeners('response-complete');
            ipcRenderer.removeAllListeners('response-superseded');
            ipcRenderer.removeAllListeners('new-transcript');
            ipcRenderer.removeAllListeners('user-transcript');
            ipcRenderer.removeAllListeners('interim-transcript');
            ipcRenderer.removeAllListeners('update-status');
            ipcRenderer.removeAllListeners('click-through-toggled');
            ipcRenderer.removeAllListeners('audio-muted-toggled');
            ipcRenderer.removeAllListeners('auto-answer-toggled');
            ipcRenderer.removeAllListeners('audio-mute-shortcut');
            ipcRenderer.removeAllListeners('toggle-auto-answer-shortcut');
            ipcRenderer.removeAllListeners('reconnect-failed');
            ipcRenderer.removeAllListeners('whisper-downloading');
        }
    }

    // ── Timer ──

    _startTimer() {
        this._stopTimer();
        if (this.startTime) {
            this._timerInterval = setInterval(() => this.requestUpdate(), 1000);
        }
    }

    _stopTimer() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
            this._timerInterval = null;
        }
    }

    getElapsedTime() {
        if (!this.startTime) return '0:00';
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;
        const pad = n => String(n).padStart(2, '0');
        if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
        return `${m}:${pad(s)}`;
    }

    // ── Status & Responses ──

    setStatus(text) {
        this.statusText = text;
        if (text.includes('Ready') || text.includes('Listening') || text.includes('Error')) {
            this._currentResponseIsComplete = true;
        }
    }

    _clearInterim() {
        if (this._interimClearTimer) {
            clearTimeout(this._interimClearTimer);
            this._interimClearTimer = null;
        }
        if (this.interimTranscript) {
            this.interimTranscript = '';
            this.interimTranscriptSource = 'speaker';
            this.requestUpdate();
        }
    }

    addNewResponse(response, replaceLast = false) {
        const wasOnLatest = this.currentResponseIndex === this.responses.length - 1;
        this.responses = replaceLast && this.responses.length > 0 ? [...this.responses.slice(0, -1), response] : [...this.responses, response];
        if (wasOnLatest || this.currentResponseIndex === -1) {
            this.currentResponseIndex = this.responses.length - 1;
        }
        // The index must always point at a real page, whatever path got us here.
        this.currentResponseIndex = Math.max(0, Math.min(this.currentResponseIndex, this.responses.length - 1));
        this._awaitingNewResponse = false;
        this.requestUpdate();
    }

    updateCurrentResponse(response) {
        if (this.responses.length > 0) {
            this.responses = [...this.responses.slice(0, -1), response];
        } else {
            this.addNewResponse(response);
        }
        this.requestUpdate();
    }

    // ── Navigation ──

    navigate(view) {
        this.currentView = view;
        this.requestUpdate();
    }

    async handleClose() {
        if (this.currentView === 'assistant') {
            // Ending the session — stop any speech and make sure the window is
            // visible again so speaker mode never strands the user with no screen.
            this._stopSpeaking();
            if (this._speakerMode) await this._setWindowVisible(true);
            cheatingDaddy.stopCapture();
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                await ipcRenderer.invoke('close-session');
            }
            this.sessionActive = false;
            this._syncSpeakerModeToMain();
            this._stopTimer();
            this.currentView = 'main';
        } else {
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                await ipcRenderer.invoke('quit-application');
            }
        }
    }

    async _handleMinimize() {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('window-minimize');
        }
    }

    async handleHideToggle() {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('toggle-window-visibility');
        }
    }

    async handleToggleAudio() {
        if (!this.sessionActive || !window.require) return;
        const { ipcRenderer } = window.require('electron');
        // Main process flips the flag and broadcasts 'audio-muted-toggled',
        // which updates this._isAudioMuted — single source of truth.
        await ipcRenderer.invoke('toggle-audio-mute');
    }

    async handleToggleAutoAnswer() {
        if (!window.require) return;
        if (!this.sessionActive) {
            this._autoAnswer = !this._autoAnswer;
            await cheatingDaddy.storage.updatePreference('autoAnswer', this._autoAnswer);
            cheatingDaddy.refreshPreferencesCache();
            this.setStatus(this._autoAnswer ? 'Auto answer on' : 'Auto answer off');
            return;
        }
        const { ipcRenderer } = window.require('electron');
        const result = await ipcRenderer.invoke('toggle-auto-answer');
        if (result && result.success) {
            this._autoAnswer = result.enabled;
            cheatingDaddy.refreshPreferencesCache();
            if (this._speakerMode) {
                this._stopSpeaking();
                this._speak(this._autoAnswer ? 'Auto answer on.' : 'Auto answer off.');
            }
        } else if (result && result.error) {
            this.setStatus(result.error);
        }
    }

    async toggleStealth() {
        this.stealthMode = !this.stealthMode;
        await cheatingDaddy.storage.updatePreference('stealthMode', this.stealthMode);
        this.requestUpdate();
    }

    async handleAnswerNow() {
        if (!this.sessionActive || !window.require) return;
        const { ipcRenderer } = window.require('electron');
        const result = await ipcRenderer.invoke('answer-with-context');
        if (result && !result.success && result.error) {
            this.setStatus(result.error);
        }
    }

    // ── Speaker (audio-only) mode ──
    // When on, the window is hidden during a session and each answer is spoken
    // aloud through the speaker instead of shown on screen. Operate via the
    // global shortcuts (push-to-talk, answer-with-context, toggle-visibility).

    async toggleSpeakerMode() {
        this._speakerMode = !this._speakerMode;
        await cheatingDaddy.storage.updatePreference('speakerMode', this._speakerMode);
        cheatingDaddy.refreshPreferencesCache();

        if (this._speakerMode) {
            // Announce it out loud so the user knows even once the window is gone.
            this._speak('Speaker mode on.');
            this.setStatus('Speaker mode on — answers will be spoken');
            if (this.sessionActive) await this._setWindowVisible(false);
        } else {
            this._stopSpeaking();
            this.setStatus('Speaker mode off');
            await this._setWindowVisible(true);
        }
        this._syncSpeakerModeToMain();
        this.requestUpdate();
    }

    async _setWindowVisible(visible) {
        if (!window.require) return;
        try {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('set-window-visibility', visible);
        } catch (err) {
            console.error('Error setting window visibility:', err);
        }
    }

    // Tell the main process whether the window must stay hidden for speaker mode,
    // so global shortcuts (push-to-talk, etc.) don't reveal it. Only enforced
    // while a session is active — outside a session the window shows normally.
    _syncSpeakerModeToMain() {
        if (!window.require) return;
        try {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.send('set-speaker-mode', this._speakerMode && this.sessionActive);
        } catch (err) {
            console.error('Error syncing speaker mode:', err);
        }
    }

    // Debounced speak: fires after streaming settles. Covers providers that
    // never send 'response-complete' (Gemini, local, cloud). De-duped by
    // _speakLatest so it never double-reads an answer that 'response-complete'
    // already spoke.
    _scheduleSpeak() {
        if (!this._speakerMode) return;
        if (this._ttsDebounceTimer) clearTimeout(this._ttsDebounceTimer);
        this._ttsDebounceTimer = setTimeout(() => this._speakLatest(), 1200);
    }

    _speakLatest() {
        if (this._ttsDebounceTimer) {
            clearTimeout(this._ttsDebounceTimer);
            this._ttsDebounceTimer = null;
        }
        if (!this._speakerMode || this.responses.length === 0) return;
        const text = this.responses[this.responses.length - 1];
        if (!text || text === this._lastSpokenText) return;
        this._lastSpokenText = text;
        this._speak(text);
    }

    _speak(text) {
        try {
            const synth = window.speechSynthesis;
            if (!synth) return;
            const plain = this._toPlainSpeech(text);
            if (!plain) return;
            synth.cancel(); // stop anything mid-sentence before the new answer
            const voice = this._pickVoice();
            for (const sentence of this._toSpokenChunks(plain)) {
                const utter = new SpeechSynthesisUtterance(sentence);
                if (voice) utter.voice = voice;
                utter.lang = (voice && voice.lang) || this.selectedLanguage || 'en-US';
                utter.rate = 1.25;
                utter.pitch = 1.0;
                utter.volume = 1.0;
                synth.speak(utter);
            }
        } catch (err) {
            console.error('TTS error:', err);
        }
    }

    _pickVoice() {
        try {
            const synth = window.speechSynthesis;
            if (!synth) return null;
            const cacheKey = this.selectedLanguage || 'en-US';
            if (this._voiceCacheKey === cacheKey && this._cachedVoice) return this._cachedVoice;
            const voices = synth.getVoices() || [];
            if (voices.length === 0) return null;
            const lang = (this.selectedLanguage || 'en-US').toLowerCase();
            const base = lang.split('-')[0];
            const preferred = ['daniel', 'samantha', 'ava', 'allison', 'serena', 'zoe', 'evan', 'nathan', 'aria', 'jenny', 'google us english'];
            const usable = voices.filter(v => {
                const vl = (v.lang || '').toLowerCase().replace('_', '-');
                return vl === lang || vl.startsWith(base + '-') || vl === base;
            });
            const pool = usable.length > 0 ? usable : voices;
            const natural = pool.filter(
                v =>
                    !/albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|fred|ralph|kathy/i.test(
                        v.name
                    )
            );
            const candidates = natural.length > 0 ? natural : pool;
            const rank = v => (/\((?:enhanced|premium)\)|enhanced|premium/i.test(v.name) ? 0 : 1);
            for (const name of preferred) {
                const matches = candidates.filter(v => v.name.toLowerCase().includes(name)).sort((a, b) => rank(a) - rank(b));
                const hit = matches[0];
                if (hit) {
                    this._voiceCacheKey = cacheKey;
                    this._cachedVoice = hit;
                    return hit;
                }
            }
            const chosen = candidates.find(v => v.localService) || candidates[0] || null;
            this._voiceCacheKey = cacheKey;
            this._cachedVoice = chosen;
            return chosen;
        } catch (err) {
            return null;
        }
    }

    _toSpokenChunks(text) {
        const parts = text
            .split(/(?<=[.!?…])\s+/)
            .map(t => t.trim())
            .filter(Boolean);
        if (parts.length === 0) return [];
        const chunks = [];
        for (const part of parts) {
            const last = chunks[chunks.length - 1];
            if (last && last.length < 24) {
                chunks[chunks.length - 1] = `${last} ${part}`;
            } else if (part.length > 240) {
                for (const piece of part.split(/(?<=,|;|:)\s+/)) chunks.push(piece.trim());
            } else {
                chunks.push(part);
            }
        }
        return chunks.filter(Boolean);
    }

    _stopSpeaking() {
        try {
            if (window.speechSynthesis) window.speechSynthesis.cancel();
        } catch (err) {
            console.error('Error stopping speech:', err);
        }
    }

    // Markdown → readable plain text. Render with the bundled marked parser then
    // take the text content, so headings/lists/code read cleanly without the
    // markup symbols. Falls back to the raw string if marked isn't available.
    _toPlainSpeech(md) {
        let text = this._spokenSection(md || '');
        text = text.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1');
        try {
            if (window.marked) {
                const div = document.createElement('div');
                div.innerHTML = window.marked.parse(text);
                text = div.textContent || div.innerText || '';
            }
        } catch (err) {
            /* fall back to raw text */
        }
        return text
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu, ' ')
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(/^\s*[-*•]\s+/gm, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _spokenSection(md) {
        const spokenHeading = /(?:⚡|💬)?\s*\*{0,2}(?:quick summary[^:\n]*|what to say[^:\n]*)\*{0,2}\s*:?/i;
        const nextHeading = /\n\s*(?:📋|💡|🧠|✅|📝)|\n\s*\*{2}[^*\n]+\*{2}\s*:?\s*\n|\n#{1,6}\s/;
        const start = md.search(spokenHeading);
        if (start === -1) return md;
        const afterHeading = md.slice(start).replace(spokenHeading, '');
        const cut = afterHeading.search(nextHeading);
        const spoken = (cut === -1 ? afterHeading : afterHeading.slice(0, cut)).replace(/^[\s*:>#-]+/, '').trim();
        return spoken || md;
    }

    // ── Session start ──

    async handleStart() {
        const prefs = await cheatingDaddy.storage.getPreferences();
        // Pick up any speaker-mode change made in Settings since the app loaded.
        this._speakerMode = prefs.speakerMode ?? false;
        this._autoAnswer = prefs.autoAnswer ?? true;
        this.stealthMode = prefs.stealthMode ?? false;
        const providerMode = prefs.providerMode === 'cloud' ? 'byok' : prefs.providerMode || 'byok';

        if (providerMode === 'cloud') {
            const creds = await cheatingDaddy.storage.getCredentials();
            if (!creds.cloudToken || creds.cloudToken.trim() === '') {
                const mainView = this.shadowRoot.querySelector('main-view');
                if (mainView && mainView.triggerApiKeyError) {
                    mainView.triggerApiKeyError();
                }
                return;
            }

            const success = await cheatingDaddy.initializeCloud(this.selectedProfile);
            if (!success) {
                const mainView = this.shadowRoot.querySelector('main-view');
                if (mainView && mainView.triggerApiKeyError) {
                    mainView.triggerApiKeyError();
                }
                return;
            }
        } else if (providerMode === 'local') {
            const success = await cheatingDaddy.initializeLocal(this.selectedProfile);
            if (!success) {
                const mainView = this.shadowRoot.querySelector('main-view');
                if (mainView && mainView.triggerApiKeyError) {
                    mainView.triggerApiKeyError();
                }
                return;
            }
        } else if (providerMode === 'claude') {
            const success = await cheatingDaddy.initializeClaude(this.selectedProfile);
            if (!success) {
                const mainView = this.shadowRoot.querySelector('main-view');
                if (mainView && mainView.triggerApiKeyError) {
                    mainView.triggerApiKeyError();
                }
                return;
            }
        } else {
            const apiKey = await cheatingDaddy.storage.getApiKey();
            if (!apiKey || apiKey === '') {
                const mainView = this.shadowRoot.querySelector('main-view');
                if (mainView && mainView.triggerApiKeyError) {
                    mainView.triggerApiKeyError();
                }
                return;
            }

            await cheatingDaddy.initializeGemini(this.selectedProfile, this.selectedLanguage);
        }

        cheatingDaddy.startCapture(this.selectedScreenshotInterval, this.selectedImageQuality);
        this.responses = [];
        this.transcripts = [];
        this._clearInterim();
        this.currentResponseIndex = -1;
        this._isAudioMuted = false;
        this._isResponseStreaming = false;
        this._responseWasSuperseded = false;
        this._transcriptWasSuperseded = false;
        this.startTime = Date.now();
        this.sessionActive = true;
        this.currentView = 'assistant';
        this._startTimer();
        this._lastSpokenText = null;

        // In speaker mode the screen stays clear — hide the window and let
        // answers come through the speaker. Give it a beat so the session is
        // fully up before the window disappears.
        if (this._speakerMode) {
            this.setStatus('Speaker mode — answers will be spoken. Use shortcuts to control.');
            setTimeout(() => this._setWindowVisible(false), 400);
        }
        this._syncSpeakerModeToMain();
    }

    async handleAPIKeyHelp() {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('open-external', 'https://cheatingdaddy.com/help/api-key');
        }
    }

    async handleGroqAPIKeyHelp() {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('open-external', 'https://console.groq.com/keys');
        }
    }

    // ── Settings handlers ──

    async handleProfileChange(profile) {
        this.selectedProfile = profile;
        await cheatingDaddy.storage.updatePreference('selectedProfile', profile);
    }

    async handleLanguageChange(language) {
        this.selectedLanguage = language;
        await cheatingDaddy.storage.updatePreference('selectedLanguage', language);
    }

    async handleScreenshotIntervalChange(interval) {
        this.selectedScreenshotInterval = interval;
        await cheatingDaddy.storage.updatePreference('selectedScreenshotInterval', interval);
    }

    async handleImageQualityChange(quality) {
        this.selectedImageQuality = quality;
        await cheatingDaddy.storage.updatePreference('selectedImageQuality', quality);
    }

    async handleLayoutModeChange(layoutMode) {
        this.layoutMode = layoutMode;
        await cheatingDaddy.storage.updateConfig('layout', layoutMode);
        this.requestUpdate();
    }

    async handleExternalLinkClick(url) {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('open-external', url);
        }
    }

    async handleSendText(message) {
        const result = await window.cheatingDaddy.sendTextMessage(message);
        if (!result.success) {
            this.setStatus('Error sending message: ' + result.error);
        } else {
            this.setStatus('Message sent...');
            this._awaitingNewResponse = true;
        }
    }

    handleResponseIndexChanged(e) {
        this.currentResponseIndex = e.detail.index;
        this.shouldAnimateResponse = false;
        this.requestUpdate();
    }

    handleOnboardingComplete() {
        this.currentView = 'main';
    }

    updated(changedProperties) {
        super.updated(changedProperties);

        if (changedProperties.has('currentView') && window.require) {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.send('view-changed', this.currentView);
        }
    }

    // ── Helpers ──

    _isLiveMode() {
        return this.currentView === 'assistant';
    }

    // ── Render ──

    renderCurrentView() {
        switch (this.currentView) {
            case 'onboarding':
                return html`
                    <onboarding-view .onComplete=${() => this.handleOnboardingComplete()} .onClose=${() => this.handleClose()}></onboarding-view>
                `;

            case 'main':
                return html`
                    <main-view
                        .selectedProfile=${this.selectedProfile}
                        .onProfileChange=${p => this.handleProfileChange(p)}
                        .onStart=${() => this.handleStart()}
                        .onExternalLink=${url => this.handleExternalLinkClick(url)}
                        .whisperDownloading=${this._whisperDownloading}
                    ></main-view>
                `;

            case 'ai-customize':
                return html`
                    <ai-customize-view
                        .selectedProfile=${this.selectedProfile}
                        .onProfileChange=${p => this.handleProfileChange(p)}
                    ></ai-customize-view>
                `;

            case 'customize':
                return html`
                    <customize-view
                        .selectedProfile=${this.selectedProfile}
                        .selectedLanguage=${this.selectedLanguage}
                        .selectedScreenshotInterval=${this.selectedScreenshotInterval}
                        .selectedImageQuality=${this.selectedImageQuality}
                        .layoutMode=${this.layoutMode}
                        .onProfileChange=${p => this.handleProfileChange(p)}
                        .onLanguageChange=${l => this.handleLanguageChange(l)}
                        .onScreenshotIntervalChange=${i => this.handleScreenshotIntervalChange(i)}
                        .onImageQualityChange=${q => this.handleImageQualityChange(q)}
                        .onLayoutModeChange=${lm => this.handleLayoutModeChange(lm)}
                    ></customize-view>
                `;

            case 'feedback':
                return html`<feedback-view></feedback-view>`;

            case 'help':
                return html`<help-view .onExternalLinkClick=${url => this.handleExternalLinkClick(url)}></help-view>`;

            case 'history':
                return html`<history-view></history-view>`;

            case 'assistant':
                return html`
                    <assistant-view
                        .responses=${this.responses}
                        .transcripts=${this.transcripts}
                        .interimTranscript=${this.interimTranscript}
                        .interimTranscriptSource=${this.interimTranscriptSource}
                        .currentResponseIndex=${this.currentResponseIndex}
                        .selectedProfile=${this.selectedProfile}
                        .onSendText=${msg => this.handleSendText(msg)}
                        .shouldAnimateResponse=${this.shouldAnimateResponse}
                        .isStreaming=${this._isResponseStreaming}
                        @response-index-changed=${this.handleResponseIndexChanged}
                        @response-animation-complete=${() => {
                            this.shouldAnimateResponse = false;
                            this._currentResponseIsComplete = true;
                            this.requestUpdate();
                        }}
                    ></assistant-view>
                `;

            default:
                return html`<div>Unknown view: ${this.currentView}</div>`;
        }
    }

    renderSidebar() {
        const items = [
            {
                id: 'main',
                label: 'Home',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path
                            d="m19 8.71l-5.333-4.148a2.666 2.666 0 0 0-3.274 0L5.059 8.71a2.67 2.67 0 0 0-1.029 2.105v7.2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.2c0-.823-.38-1.6-1.03-2.105"
                        />
                        <path d="M16 15c-2.21 1.333-5.792 1.333-8 0" />
                    </g>
                </svg>`,
            },
            {
                id: 'ai-customize',
                label: 'AI Customization',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <path
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M13 3v7h6l-8 11v-7H5z"
                    />
                </svg>`,
            },
            {
                id: 'history',
                label: 'History',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path
                            d="M10 20.777a9 9 0 0 1-2.48-.969M14 3.223a9.003 9.003 0 0 1 0 17.554m-9.421-3.684a9 9 0 0 1-1.227-2.592M3.124 10.5c.16-.95.468-1.85.9-2.675l.169-.305m2.714-2.941A9 9 0 0 1 10 3.223"
                        />
                        <path d="M12 8v4l3 3" />
                    </g>
                </svg>`,
            },
            {
                id: 'customize',
                label: 'Settings',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path
                            d="M19.875 6.27A2.23 2.23 0 0 1 21 8.218v7.284c0 .809-.443 1.555-1.158 1.948l-6.75 4.27a2.27 2.27 0 0 1-2.184 0l-6.75-4.27A2.23 2.23 0 0 1 3 15.502V8.217c0-.809.443-1.554 1.158-1.947l6.75-3.98a2.33 2.33 0 0 1 2.25 0l6.75 3.98z"
                        />
                        <path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0" />
                    </g>
                </svg>`,
            },
            {
                id: 'feedback',
                label: 'Feedback',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM9.5 9h.01m4.99 0h.01" />
                        <path d="M9.5 13a3.5 3.5 0 0 0 5 0" />
                    </g>
                </svg>`,
            },
            {
                id: 'help',
                label: 'Help',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path d="M12 3c7.2 0 9 1.8 9 9s-1.8 9-9 9s-9-1.8-9-9s1.8-9 9-9m0 13v.01" />
                        <path d="M12 13a2 2 0 0 0 .914-3.782a1.98 1.98 0 0 0-2.414.483" />
                    </g>
                </svg>`,
            },
        ];

        return html`
            <div class="sidebar ${this._isLiveMode() ? 'hidden' : ''}">
                <div class="sidebar-brand">
                    <h1>alpha</h1>
                </div>
                <nav class="sidebar-nav">
                    ${items.map(
                        item => html`
                            <button
                                class="nav-item ${this.currentView === item.id ? 'active' : ''}"
                                @click=${() => this.navigate(item.id)}
                                title=${item.label}
                            >
                                ${item.icon} ${item.label}
                            </button>
                        `
                    )}
                </nav>
                <div class="sidebar-footer">
                    ${
                        this._updateAvailable
                            ? html`
                                  <button class="update-btn" @click=${() => this.handleExternalLinkClick('https://cheatingdaddy.com/download')}>
                                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                          <path
                                              fill="none"
                                              stroke="currentColor"
                                              stroke-linecap="round"
                                              stroke-linejoin="round"
                                              stroke-width="2"
                                              d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5 5l5-5m-5-7v12"
                                          />
                                      </svg>
                                      Update available
                                  </button>
                              `
                            : html` <div class="version-text">v${this._localVersion}</div> `
                    }
                </div>
            </div>
        `;
    }

    renderHud() {
        if (!this._isLiveMode()) return '';

        const profileLabels = {
            interview: 'Interview',
            sales: 'Sales Call',
            meeting: 'Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
            exam: 'Exam',
            mcq: 'MCQ',
            relationship: 'Relationship',
        };
        const mod = cheatingDaddy.isMacOS ? 'Cmd' : 'Ctrl';
        const state = this._isAudioMuted ? 'paused' : this._autoAnswer ? 'listening' : 'manual';
        const stateLabel = { paused: 'Paused', listening: 'Listening', manual: 'Manual' }[state];

        return html`
            <header class="hud">
                <div class="hud-lead">
                    <button class="hud-back" @click=${() => this.handleClose()} title="End session" aria-label="End session">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                            <path
                                fill-rule="evenodd"
                                d="M12.79 5.23a.75.75 0 0 1-.02 1.06L8.832 10l3.938 3.71a.75.75 0 1 1-1.04 1.08l-4.5-4.25a.75.75 0 0 1 0-1.08l4.5-4.25a.75.75 0 0 1 1.06.02Z"
                                clip-rule="evenodd"
                            />
                        </svg>
                    </button>
                    <span class="hud-state" data-state=${state}>${stateLabel}</span>
                </div>
                <div class="hud-meta">
                    <span class="hud-status" aria-live="polite"
                        >${this.statusText || profileLabels[this.selectedProfile] || 'Session'}${this._isClickThrough ? ' · click through' : ''}</span
                    >
                    <span class="hud-clock">${this.getElapsedTime()}</span>
                </div>
                <div class="hud-tools">
                    <button
                        class="chip"
                        data-alert=${this._isAudioMuted ? '' : nothing}
                        aria-pressed=${this._isAudioMuted ? 'true' : 'false'}
                        title=${`${mod}+Shift+M — ${this._isAudioMuted ? 'resume listening' : 'pause listening'}`}
                        @click=${() => this.handleToggleAudio()}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                            <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                                ${
                                    this._isAudioMuted
                                        ? html`<path d="M3 3l18 18M9 5a3 3 0 0 1 6 0v5m-6 1v-1M5 10a7 7 0 0 0 10.7 6M19 10v1M12 19v3" />`
                                        : html`<path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5 10v1a7 7 0 0 0 14 0v-1M12 19v3" />`
                                }
                            </g>
                        </svg>
                        <span class="chip-label">${this._isAudioMuted ? 'Muted' : 'Mic'}</span>
                    </button>
                    <button
                        class="chip"
                        data-alert=${this._autoAnswer ? nothing : ''}
                        aria-pressed=${this._autoAnswer ? 'true' : 'false'}
                        title=${
                            this._autoAnswer
                                ? `${mod}+Shift+U — auto answer is on; heard questions are answered automatically. Click to turn off.`
                                : `${mod}+Shift+U — auto answer is off; speech is only transcribed. Click to turn on.`
                        }
                        @click=${() => this.handleToggleAutoAnswer()}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                            <path
                                fill="none"
                                stroke="currentColor"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M13 3v7h6l-8 11v-7H5z"
                            />
                        </svg>
                        <span class="chip-label">${this._autoAnswer ? 'Auto' : 'Auto off'}</span>
                    </button>
                    <button class="chip" title=${`${mod}+Shift+G — answer the last heard question now`} @click=${() => this.handleAnswerNow()}>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                            <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                                <path d="M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18M9 12h6m-2.5-2.5L15 12l-2.5 2.5" />
                            </g>
                        </svg>
                        <span class="chip-label">Answer</span>
                    </button>
                    <button
                        class="chip"
                        aria-pressed=${this.stealthMode ? 'true' : 'false'}
                        title=${
                            this.stealthMode
                                ? 'Stealth on — controls hide until you hover the strip. Click for the full HUD.'
                                : 'Stealth — shrink the HUD to a hairline so only the answer text shows'
                        }
                        @click=${() => this.toggleStealth()}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                            <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                                <path d="M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18" />
                                ${this.stealthMode ? html`<path d="M12 3v18" />` : ''}
                            </g>
                        </svg>
                        <span class="chip-label">Stealth</span>
                    </button>
                    <button class="chip" title="Hide the window" @click=${() => this.handleHideToggle()}>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                            <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                                <path
                                    d="M3 3l18 18M10.6 5.2A9.6 9.6 0 0 1 12 5c5 0 9 4.5 9 7c0 .8-.5 1.8-1.3 2.8M6.6 6.7C4.5 8.1 3 10.2 3 12c0 2.5 4 7 9 7c1.6 0 3-.5 4.3-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2"
                                />
                            </g>
                        </svg>
                        <span class="chip-label">Hide</span>
                    </button>
                </div>
            </header>
        `;
    }

    render() {
        // Onboarding is fullscreen, no sidebar
        if (this.currentView === 'onboarding') {
            return html` <div class="fullscreen">${this.renderCurrentView()}</div> `;
        }

        const isLive = this._isLiveMode();

        return html`
            <div class="app-shell">
                <div class="top-drag-bar ${isLive ? 'hidden' : ''}">
                    <div class="traffic-lights">
                        <button class="traffic-light close" @click=${() => this.handleClose()} title="Close"></button>
                        <button class="traffic-light minimize" @click=${() => this._handleMinimize()} title="Minimize"></button>
                        <button class="traffic-light maximize" title="Maximize"></button>
                    </div>
                    <div class="drag-region"></div>
                </div>
                ${this.renderSidebar()}
                <div class="content">
                    ${isLive ? this.renderHud() : ''}
                    <div class="content-inner ${isLive ? 'live' : ''}">${this.renderCurrentView()}</div>
                </div>
            </div>
        `;
    }
}

customElements.define('help-guru-app', CheatingDaddyApp);
