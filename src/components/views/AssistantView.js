import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class AssistantView extends LitElement {
    static styles = css`
        :host {
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        * {
            font-family: var(--font);
            cursor: default;
        }

        /* ── Answer area (the hero — gets all available space) ── */

        .answer-area {
            position: relative;
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
        }

        .response-container {
            flex: 1;
            overflow-y: auto;
            font-size: var(--response-font-size, 15px);
            line-height: var(--line-height-relaxed);
            background: var(--bg-app);
            padding: var(--space-md) var(--space-lg);
            scroll-behavior: smooth;
            user-select: text;
            cursor: text;
            color: var(--text-primary);
        }

        .response-container * {
            user-select: text;
            cursor: text;
        }

        .response-container a {
            cursor: pointer;
        }

        /* ── Empty state (before the first answer) ── */

        .empty-state {
            height: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: var(--space-sm);
            text-align: center;
            user-select: none;
            cursor: default;
        }

        .empty-state * {
            user-select: none;
            cursor: default;
        }

        .empty-title {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            font-size: var(--font-size-md);
            color: var(--text-secondary);
            font-weight: var(--font-weight-medium);
        }

        .empty-title .live-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: var(--success);
            animation: gen-pulse 1.6s ease-in-out infinite;
        }

        .empty-hint {
            font-size: var(--font-size-sm);
            color: var(--text-muted);
            max-width: 340px;
            line-height: var(--line-height-compact);
        }

        /* ── Floating response navigation (overlays the answer, top-right) ── */

        .float-nav {
            position: absolute;
            top: var(--space-sm);
            right: var(--space-md);
            z-index: 2;
            display: flex;
            align-items: center;
            gap: 2px;
            background: rgba(25, 25, 25, 0.85);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            border: 1px solid var(--border);
            border-radius: 100px;
            padding: 2px 4px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
            opacity: 0.6;
            transition: opacity var(--transition);
        }

        .float-nav:hover,
        .float-nav.not-latest {
            opacity: 1;
        }

        .nav-btn {
            background: none;
            border: none;
            color: var(--text-muted);
            cursor: pointer;
            padding: var(--space-xs);
            border-radius: 100px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition:
                color var(--transition),
                background var(--transition);
        }

        .nav-btn:hover:not(:disabled) {
            color: var(--text-primary);
            background: var(--bg-hover);
        }

        .nav-btn:disabled {
            opacity: 0.25;
            cursor: default;
        }

        .nav-btn svg {
            width: 13px;
            height: 13px;
        }

        .response-counter {
            font-size: var(--font-size-xs);
            color: var(--text-secondary);
            font-family: var(--font-mono);
            min-width: 34px;
            text-align: center;
            padding: 0 2px;
        }

        /* Jump back to the newest answer after paging into history. Pulses
           while a newer answer is still streaming in. */
        .latest-btn {
            display: flex;
            align-items: center;
            gap: 5px;
            background: none;
            border: none;
            border-left: 1px solid var(--border);
            border-radius: 0 100px 100px 0;
            color: var(--accent);
            font-size: var(--font-size-xs);
            font-family: var(--font-mono);
            white-space: nowrap;
            padding: 2px var(--space-sm) 2px var(--space-sm);
            margin-left: 2px;
            cursor: pointer;
            transition: background var(--transition);
        }

        .latest-btn:hover {
            background: var(--bg-hover);
        }

        .latest-btn .live-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--accent);
            animation: gen-pulse 1.2s ease-in-out infinite;
        }

        /* ── Generating indicator (shown while a response streams in) ── */

        .generating {
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--text-muted);
            font-size: var(--response-font-size, 15px);
        }

        .generating .dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--text-muted);
            animation: gen-pulse 1.2s ease-in-out infinite;
        }

        .generating .dot:nth-child(2) {
            animation-delay: 0.2s;
        }
        .generating .dot:nth-child(3) {
            animation-delay: 0.4s;
        }

        @keyframes gen-pulse {
            0%,
            100% {
                opacity: 0.25;
            }
            50% {
                opacity: 1;
            }
        }

        /* ── Markdown ── */

        .response-container h1,
        .response-container h2,
        .response-container h3,
        .response-container h4,
        .response-container h5,
        .response-container h6 {
            margin: 1em 0 0.5em 0;
            color: var(--text-primary);
            font-weight: var(--font-weight-semibold);
            line-height: var(--line-height-tight);
            letter-spacing: var(--tracking-tight);
        }

        .response-container h1 {
            font-size: 1.5em;
        }
        .response-container h2 {
            font-size: 1.3em;
        }
        .response-container h3 {
            font-size: 1.15em;
        }
        .response-container h4 {
            font-size: 1.05em;
        }
        .response-container h5,
        .response-container h6 {
            font-size: 1em;
        }

        .response-container p {
            margin: 0.6em 0;
            color: var(--text-primary);
        }

        .response-container > :first-child {
            margin-top: 0;
        }

        .response-container > :last-child {
            margin-bottom: 0;
        }

        .response-container ul,
        .response-container ol {
            margin: 0.6em 0;
            padding-left: 1.5em;
            color: var(--text-primary);
        }

        .response-container li {
            margin: 0.3em 0;
        }

        .response-container blockquote {
            margin: 0.8em 0;
            padding: 0.5em 1em;
            border-left: 2px solid var(--border-strong);
            background: var(--bg-surface);
            border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        }

        .response-container code {
            background: var(--bg-elevated);
            padding: 0.15em 0.4em;
            border-radius: var(--radius-sm);
            font-family: var(--font-mono);
            font-size: 0.85em;
            line-height: var(--line-height-compact);
        }

        .response-container pre {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-md);
            padding: var(--space-md);
            overflow-x: auto;
            margin: 0.8em 0;
        }

        .response-container pre code {
            background: none;
            padding: 0;
        }

        .response-container a {
            color: var(--accent);
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .response-container strong,
        .response-container b {
            font-weight: var(--font-weight-semibold);
        }

        .response-container hr {
            border: none;
            border-top: 1px solid var(--border);
            margin: 1.5em 0;
        }

        .response-container table {
            border-collapse: collapse;
            width: 100%;
            margin: 0.8em 0;
        }

        .response-container th,
        .response-container td {
            border: 1px solid var(--border);
            padding: var(--space-sm);
            text-align: left;
        }

        .response-container th {
            background: var(--bg-surface);
            font-weight: var(--font-weight-semibold);
        }

        .response-container::-webkit-scrollbar,
        .transcript-history::-webkit-scrollbar {
            width: 6px;
        }

        .response-container::-webkit-scrollbar-track,
        .transcript-history::-webkit-scrollbar-track {
            background: transparent;
        }

        .response-container::-webkit-scrollbar-thumb,
        .transcript-history::-webkit-scrollbar-thumb {
            background: var(--border-strong);
            border-radius: 3px;
        }

        .response-container::-webkit-scrollbar-thumb:hover {
            background: #444444;
        }

        /* ── Transcript strip (what was heard — compact, above the input) ── */

        .transcript-strip {
            flex-shrink: 0;
            border-top: 1px solid var(--border);
            background: var(--bg-surface);
        }

        .transcript-row {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            padding: var(--space-xs) var(--space-md);
            cursor: pointer;
            user-select: none;
        }

        .transcript-row * {
            cursor: pointer;
        }

        .transcript-label {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            font-family: var(--font-mono);
            text-transform: uppercase;
            letter-spacing: var(--tracking-wide);
            flex-shrink: 0;
        }

        .transcript-label svg {
            width: 11px;
            height: 11px;
        }

        .transcript-current {
            flex: 1;
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-size: var(--font-size-sm);
            color: var(--text-secondary);
            line-height: var(--line-height-compact);
        }

        .transcript-current.interim {
            color: var(--text-muted);
            font-style: italic;
        }

        .transcript-current.interim::after {
            content: '…';
        }

        .transcript-toggle {
            flex-shrink: 0;
            display: flex;
            align-items: center;
            color: var(--text-muted);
            transition:
                transform var(--transition),
                color var(--transition);
        }

        .transcript-row:hover .transcript-toggle {
            color: var(--text-secondary);
        }

        .transcript-toggle svg {
            width: 12px;
            height: 12px;
        }

        .transcript-strip.expanded .transcript-toggle {
            transform: rotate(180deg);
        }

        .transcript-history {
            max-height: 132px;
            overflow-y: auto;
            padding: 0 var(--space-md) var(--space-sm);
        }

        .transcript-item {
            font-size: var(--font-size-sm);
            color: var(--text-secondary);
            line-height: var(--line-height-compact);
            margin: 2px 0;
            user-select: text;
            cursor: text;
        }

        .transcript-item.latest {
            color: var(--text-primary);
        }

        /* Live partial transcript — distinct from finalized "Heard" entries. */
        .transcript-item.interim {
            color: var(--text-muted);
            font-style: italic;
        }

        .transcript-item.interim::after {
            content: '…';
        }

        /* The user's own speech. Captured as context for the next question and
           never answered on its own, so it is de-emphasised relative to the
           other person's lines — which are the ones that produce answers. */
        .transcript-item.from-you {
            color: var(--text-muted);
        }

        .speaker-tag {
            display: inline-block;
            margin-right: 6px;
            padding: 0 5px;
            border-radius: var(--radius-sm);
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            color: var(--text-secondary);
            font-size: var(--font-size-xs);
            font-weight: var(--font-weight-medium);
            letter-spacing: var(--tracking-wide);
            vertical-align: baseline;
            user-select: none;
        }

        /* ── Bottom input bar ── */

        .input-bar {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            padding: var(--space-sm) var(--space-md);
            background: var(--bg-app);
            border-top: 1px solid var(--border);
        }

        .input-bar-inner {
            display: flex;
            align-items: center;
            flex: 1;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: 100px;
            padding: 0 var(--space-md);
            height: 32px;
            transition:
                border-color var(--transition),
                box-shadow var(--transition);
        }

        .input-bar-inner:focus-within {
            border-color: var(--accent);
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
        }

        .input-bar-inner input {
            flex: 1;
            background: none;
            color: var(--text-primary);
            border: none;
            padding: 0;
            font-size: var(--font-size-sm);
            font-family: var(--font);
            line-height: var(--line-height-compact);
            height: 100%;
            outline: none;
            cursor: text;
        }

        .input-bar-inner input::placeholder {
            color: var(--text-muted);
        }

        .analyze-btn {
            position: relative;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            color: var(--text-primary);
            cursor: pointer;
            font-size: var(--font-size-xs);
            font-family: var(--font-mono);
            white-space: nowrap;
            padding: var(--space-xs) var(--space-md);
            border-radius: 100px;
            height: 32px;
            display: flex;
            align-items: center;
            gap: 4px;
            transition:
                border-color 0.4s ease,
                background var(--transition);
            flex-shrink: 0;
            overflow: hidden;
        }

        .details-btn {
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            color: var(--text-primary);
            cursor: pointer;
            font-size: var(--font-size-xs);
            font-family: var(--font-mono);
            white-space: nowrap;
            padding: var(--space-xs) var(--space-md);
            border-radius: 100px;
            height: 32px;
            display: flex;
            align-items: center;
            gap: 4px;
            transition:
                border-color 0.4s ease,
                background var(--transition);
            flex-shrink: 0;
        }

        .details-btn:hover:not(:disabled) {
            border-color: var(--accent);
            background: var(--bg-surface);
        }

        .details-btn:disabled {
            opacity: 0.4;
            cursor: default;
        }

        .analyze-btn:hover:not(.analyzing) {
            border-color: var(--accent);
            background: var(--bg-surface);
        }

        .analyze-btn.analyzing {
            cursor: default;
            border-color: transparent;
        }

        .analyze-btn-content {
            display: flex;
            align-items: center;
            gap: 4px;
            transition: opacity 0.4s ease;
            z-index: 1;
            position: relative;
        }

        .analyze-btn.analyzing .analyze-btn-content {
            opacity: 0;
        }

        .analyze-canvas {
            position: absolute;
            inset: -1px;
            width: calc(100% + 2px);
            height: calc(100% + 2px);
            pointer-events: none;
        }

        /* ── Push-to-talk button ── */

        .talk-btn {
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            color: var(--text-primary);
            cursor: pointer;
            font-size: var(--font-size-xs);
            font-family: var(--font-mono);
            white-space: nowrap;
            padding: var(--space-xs) var(--space-md);
            border-radius: 100px;
            height: 32px;
            display: flex;
            align-items: center;
            gap: 4px;
            transition:
                border-color var(--transition),
                background var(--transition),
                color var(--transition);
            flex-shrink: 0;
        }

        .talk-btn:hover:not(.listening) {
            border-color: var(--accent);
            background: var(--bg-surface);
        }

        .talk-btn.listening {
            border-color: var(--danger);
            color: var(--danger);
            background: var(--bg-surface);
        }

        .talk-btn.listening svg {
            animation: talk-pulse 1.2s ease-in-out infinite;
        }

        @keyframes talk-pulse {
            0%,
            100% {
                opacity: 0.4;
            }
            50% {
                opacity: 1;
            }
        }
    `;

    static properties = {
        responses: { type: Array },
        transcripts: { type: Array },
        interimTranscript: { type: String },
        interimTranscriptSource: { type: String },
        currentResponseIndex: { type: Number },
        selectedProfile: { type: String },
        onSendText: { type: Function },
        shouldAnimateResponse: { type: Boolean },
        isStreaming: { type: Boolean },
        isAnalyzing: { type: Boolean, state: true },
        isListening: { type: Boolean, state: true },
        transcriptsExpanded: { type: Boolean, state: true },
    };

    constructor() {
        super();
        this.responses = [];
        this.transcripts = [];
        this.interimTranscript = '';
        this.interimTranscriptSource = 'speaker';
        this.currentResponseIndex = -1;
        this.selectedProfile = 'interview';
        this.onSendText = () => {};
        this.isStreaming = false;
        this.isAnalyzing = false;
        this.isListening = false;
        this.transcriptsExpanded = false;
        this._animFrame = null;
    }

    getProfileNames() {
        return {
            interview: 'Job Interview',
            sales: 'Sales Call',
            meeting: 'Business Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
            exam: 'Exam Assistant',
            relationship: 'Relationship',
        };
    }

    getCurrentResponse() {
        const profileNames = this.getProfileNames();
        return this.responses.length > 0 && this.currentResponseIndex >= 0
            ? this.responses[this.currentResponseIndex]
            : `Listening to your ${profileNames[this.selectedProfile] || 'session'}...`;
    }

    renderMarkdown(content) {
        if (typeof window !== 'undefined' && window.marked) {
            try {
                window.marked.setOptions({
                    breaks: true,
                    gfm: true,
                    sanitize: false,
                });
                return window.marked.parse(content);
            } catch (error) {
                console.warn('Error parsing markdown:', error);
                return content;
            }
        }
        return content;
    }

    navigateToPreviousResponse() {
        if (this.currentResponseIndex > 0) {
            this.currentResponseIndex--;
            this.dispatchEvent(
                new CustomEvent('response-index-changed', {
                    detail: { index: this.currentResponseIndex },
                })
            );
            this.requestUpdate();
        }
    }

    navigateToNextResponse() {
        if (this.currentResponseIndex < this.responses.length - 1) {
            this.currentResponseIndex++;
            this.dispatchEvent(
                new CustomEvent('response-index-changed', {
                    detail: { index: this.currentResponseIndex },
                })
            );
            this.requestUpdate();
        }
    }

    navigateToLatestResponse() {
        if (this.responses.length === 0) return;
        this.currentResponseIndex = this.responses.length - 1;
        this.dispatchEvent(
            new CustomEvent('response-index-changed', {
                detail: { index: this.currentResponseIndex },
            })
        );
        this.requestUpdate();
    }

    scrollResponseUp() {
        const container = this.shadowRoot.querySelector('.response-container');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3;
            container.scrollTop = Math.max(0, container.scrollTop - scrollAmount);
        }
    }

    scrollResponseDown() {
        const container = this.shadowRoot.querySelector('.response-container');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3;
            container.scrollTop = Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + scrollAmount);
        }
    }

    connectedCallback() {
        super.connectedCallback();

        if (window.require) {
            const { ipcRenderer } = window.require('electron');

            this.handlePreviousResponse = () => this.navigateToPreviousResponse();
            this.handleNextResponse = () => this.navigateToNextResponse();
            this.handleScrollUp = () => this.scrollResponseUp();
            this.handleScrollDown = () => this.scrollResponseDown();

            ipcRenderer.on('navigate-previous-response', this.handlePreviousResponse);
            ipcRenderer.on('navigate-next-response', this.handleNextResponse);
            ipcRenderer.on('scroll-response-up', this.handleScrollUp);
            ipcRenderer.on('scroll-response-down', this.handleScrollDown);
        }

        // Keep the talk button in sync with push-to-talk state, whether toggled
        // by this button or by the global keyboard shortcut.
        this.handlePushToTalkChanged = e => {
            this.isListening = !!(e.detail && e.detail.active);
        };
        window.addEventListener('push-to-talk-changed', this.handlePushToTalkChanged);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopWaveformAnimation();

        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            if (this.handlePreviousResponse) ipcRenderer.removeListener('navigate-previous-response', this.handlePreviousResponse);
            if (this.handleNextResponse) ipcRenderer.removeListener('navigate-next-response', this.handleNextResponse);
            if (this.handleScrollUp) ipcRenderer.removeListener('scroll-response-up', this.handleScrollUp);
            if (this.handleScrollDown) ipcRenderer.removeListener('scroll-response-down', this.handleScrollDown);
        }

        if (this.handlePushToTalkChanged) {
            window.removeEventListener('push-to-talk-changed', this.handlePushToTalkChanged);
        }
    }

    handleTalkClick() {
        if (window.cheatingDaddy && window.cheatingDaddy.togglePushToTalk) {
            window.cheatingDaddy.togglePushToTalk();
        }
    }

    toggleTranscripts() {
        this.transcriptsExpanded = !this.transcriptsExpanded;
    }

    async handleSendText() {
        const textInput = this.shadowRoot.querySelector('#textInput');
        if (textInput && textInput.value.trim()) {
            const message = textInput.value.trim();
            textInput.value = '';
            await this.onSendText(message);
        }
    }

    handleTextKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.handleSendText();
        }
    }

    async handleScreenAnswer() {
        if (this.isAnalyzing) return;
        if (window.captureManualScreenshot) {
            this.isAnalyzing = true;
            this._responseCountWhenStarted = this.responses.length;
            window.captureManualScreenshot();
        }
    }

    _startWaveformAnimation() {
        const canvas = this.shadowRoot.querySelector('.analyze-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;

        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const dangerColor = getComputedStyle(this).getPropertyValue('--danger').trim() || '#EF4444';
        const startTime = performance.now();
        const FADE_IN = 0.5; // seconds
        const PARTICLE_SPREAD = 4; // px inward from border
        const PARTICLE_COUNT = 250;

        // Pill perimeter helpers
        const w = rect.width;
        const h = rect.height;
        const r = h / 2; // pill radius = half height
        const straightLen = w - 2 * r;
        const arcLen = Math.PI * r;
        const perimeter = 2 * straightLen + 2 * arcLen;

        // Given a distance along the perimeter, return {x, y, nx, ny} (position + inward normal)
        const pointOnPerimeter = d => {
            d = ((d % perimeter) + perimeter) % perimeter;
            // Top straight: left to right
            if (d < straightLen) {
                return { x: r + d, y: 0, nx: 0, ny: 1 };
            }
            d -= straightLen;
            // Right arc
            if (d < arcLen) {
                const angle = -Math.PI / 2 + (d / arcLen) * Math.PI;
                return {
                    x: w - r + Math.cos(angle) * r,
                    y: r + Math.sin(angle) * r,
                    nx: -Math.cos(angle),
                    ny: -Math.sin(angle),
                };
            }
            d -= arcLen;
            // Bottom straight: right to left
            if (d < straightLen) {
                return { x: w - r - d, y: h, nx: 0, ny: -1 };
            }
            d -= straightLen;
            // Left arc
            const angle = Math.PI / 2 + (d / arcLen) * Math.PI;
            return {
                x: r + Math.cos(angle) * r,
                y: r + Math.sin(angle) * r,
                nx: -Math.cos(angle),
                ny: -Math.sin(angle),
            };
        };

        // Pre-seed random offsets for stable particles
        const seeds = [];
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            seeds.push({ pos: Math.random(), drift: Math.random(), depthSeed: Math.random() });
        }

        const draw = now => {
            const elapsed = (now - startTime) / 1000;
            const fade = Math.min(1, elapsed / FADE_IN);

            ctx.clearRect(0, 0, w, h);

            // ── Particle border ──
            ctx.fillStyle = dangerColor;
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                const s = seeds[i];
                const along = (s.pos + s.drift * elapsed * 0.03) * perimeter;
                const depth = s.depthSeed * PARTICLE_SPREAD;
                const density = 1 - depth / PARTICLE_SPREAD;

                if (Math.random() > density) continue;

                const p = pointOnPerimeter(along);
                const px = p.x + p.nx * depth;
                const py = p.y + p.ny * depth;
                const size = 0.8 + density * 0.6;

                ctx.globalAlpha = fade * density * 0.85;
                ctx.beginPath();
                ctx.arc(px, py, size, 0, Math.PI * 2);
                ctx.fill();
            }

            // ── Waveform ──
            const midY = h / 2;
            const waves = [
                { freq: 3, amp: 0.35, speed: 2.5, opacity: 0.9, width: 1.8 },
                { freq: 5, amp: 0.2, speed: 3.5, opacity: 0.5, width: 1.2 },
                { freq: 7, amp: 0.12, speed: 5, opacity: 0.3, width: 0.8 },
            ];

            for (const wave of waves) {
                ctx.beginPath();
                ctx.strokeStyle = dangerColor;
                ctx.globalAlpha = wave.opacity * fade;
                ctx.lineWidth = wave.width;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                for (let x = 0; x <= w; x++) {
                    const norm = x / w;
                    const envelope = Math.sin(norm * Math.PI);
                    const y = midY + Math.sin(norm * Math.PI * 2 * wave.freq + elapsed * wave.speed) * (midY * wave.amp) * envelope;
                    if (x === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }

            ctx.globalAlpha = 1;
            this._animFrame = requestAnimationFrame(draw);
        };

        this._animFrame = requestAnimationFrame(draw);
    }

    _stopWaveformAnimation() {
        if (this._animFrame) {
            cancelAnimationFrame(this._animFrame);
            this._animFrame = null;
        }
        const canvas = this.shadowRoot.querySelector('.analyze-canvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    scrollToBottom() {
        setTimeout(() => {
            const container = this.shadowRoot.querySelector('.response-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }, 0);
    }

    firstUpdated() {
        super.firstUpdated();
        this.updateResponseContent();
    }

    updated(changedProperties) {
        super.updated(changedProperties);
        if (changedProperties.has('responses') || changedProperties.has('currentResponseIndex') || changedProperties.has('isStreaming')) {
            this.updateResponseContent();
        }

        if (changedProperties.has('transcripts') || changedProperties.has('interimTranscript') || changedProperties.has('transcriptsExpanded')) {
            const history = this.shadowRoot.querySelector('#transcriptHistory');
            if (history) history.scrollTop = history.scrollHeight;
        }

        if (changedProperties.has('isAnalyzing')) {
            if (this.isAnalyzing) {
                this._startWaveformAnimation();
            } else {
                this._stopWaveformAnimation();
            }
        }

        if (changedProperties.has('responses') && this.isAnalyzing) {
            if (this.responses.length > this._responseCountWhenStarted) {
                this.isAnalyzing = false;
            }
        }
    }

    updateResponseContent() {
        const container = this.shadowRoot.querySelector('#responseContainer');
        if (!container) return;

        // No answers yet — show a calm empty state instead of a bare sentence.
        if (this.responses.length === 0 || this.currentResponseIndex < 0) {
            const profileNames = this.getProfileNames();
            const profile = profileNames[this.selectedProfile] || 'session';
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-title"><span class="live-dot"></span>Listening to your ${profile}</div>
                    <div class="empty-hint">Answers will appear here. Type a question below, use Talk, or Analyze Screen.</div>
                </div>`;
            return;
        }

        // Render the answer as it streams in. The main process already
        // throttles update-response events, so re-parsing markdown per update
        // is cheap and lets the user read the reply as it arrives. Show the
        // "Generating" indicator only before any text has landed.
        const currentResponse = this.getCurrentResponse();
        const isLatest = this.currentResponseIndex === this.responses.length - 1;
        if (this.isStreaming && isLatest && !currentResponse) {
            container.innerHTML =
                '<div class="generating">Generating response<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
            return;
        }

        container.innerHTML = this.renderMarkdown(currentResponse);
        // Keep the newest text in view while it streams in.
        if (this.isStreaming && isLatest) {
            container.scrollTop = container.scrollHeight;
        }
        if (this.shouldAnimateResponse) {
            this.dispatchEvent(new CustomEvent('response-animation-complete', { bubbles: true, composed: true }));
        }
    }

    render() {
        const hasMultipleResponses = this.responses.length > 1;
        const isOnLatest = this.currentResponseIndex >= this.responses.length - 1;
        const hasTranscripts = (this.transcripts && this.transcripts.length > 0) || this.interimTranscript;
        // Entries are { text, source }, where source is 'speaker' (the other
        // person, which is what gets answered) or 'user' (the user's own voice,
        // captured as context only). Tolerate bare strings defensively.
        const entryText = t => (typeof t === 'string' ? t : t?.text || '');
        const entrySource = t => (typeof t === 'string' ? 'speaker' : t?.source || 'speaker');
        const lastEntry = this.transcripts && this.transcripts.length > 0 ? this.transcripts[this.transcripts.length - 1] : null;
        const latestHeard = this.interimTranscript ? this.interimTranscript : lastEntry ? entryText(lastEntry) : '';
        const latestSource = this.interimTranscript ? this.interimTranscriptSource || 'speaker' : lastEntry ? entrySource(lastEntry) : 'speaker';

        return html`
            <div class="answer-area">
                <div class="response-container" id="responseContainer"></div>

                ${
                    hasMultipleResponses
                        ? html`
                              <div class="float-nav ${!isOnLatest ? 'not-latest' : ''}">
                                  <button
                                      class="nav-btn"
                                      @click=${this.navigateToPreviousResponse}
                                      ?disabled=${this.currentResponseIndex <= 0}
                                      title="Previous response"
                                  >
                                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                                          <path
                                              fill-rule="evenodd"
                                              d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"
                                              clip-rule="evenodd"
                                          />
                                      </svg>
                                  </button>
                                  <span class="response-counter">${this.currentResponseIndex + 1}/${this.responses.length}</span>
                                  <button
                                      class="nav-btn"
                                      @click=${this.navigateToNextResponse}
                                      ?disabled=${this.currentResponseIndex >= this.responses.length - 1}
                                      title="Next response"
                                  >
                                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                                          <path
                                              fill-rule="evenodd"
                                              d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z"
                                              clip-rule="evenodd"
                                          />
                                      </svg>
                                  </button>
                                  ${
                                      !isOnLatest
                                          ? html`
                                                <button class="latest-btn" @click=${this.navigateToLatestResponse} title="Jump to the newest answer">
                                                    ${this.isStreaming ? html`<span class="live-dot"></span>` : ''} Latest
                                                </button>
                                            `
                                          : ''
                                  }
                              </div>
                          `
                        : ''
                }
            </div>

            ${
                hasTranscripts
                    ? html`
                          <div class="transcript-strip ${this.transcriptsExpanded ? 'expanded' : ''}">
                              <div
                                  class="transcript-row"
                                  @click=${this.toggleTranscripts}
                                  title="${this.transcriptsExpanded ? 'Collapse' : 'Show'} everything heard so far"
                              >
                                  <span class="transcript-label">
                                      <svg
                                          xmlns="http://www.w3.org/2000/svg"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          stroke-width="2"
                                          stroke-linecap="round"
                                          stroke-linejoin="round"
                                      >
                                          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                                          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                          <line x1="12" y1="19" x2="12" y2="23" />
                                      </svg>
                                      Heard
                                  </span>
                                  ${
                                      !this.transcriptsExpanded
                                          ? html`
                                                <span class="transcript-current ${this.interimTranscript ? 'interim' : ''}">
                                                    ${latestSource === 'user' ? html`<span class="speaker-tag you">You</span>` : ''}${latestHeard}
                                                </span>
                                            `
                                          : html`<span class="transcript-current"></span>`
                                  }
                                  <span class="transcript-toggle">
                                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                                          <path
                                              fill-rule="evenodd"
                                              d="M14.77 12.79a.75.75 0 0 1-1.06-.02L10 8.832 6.29 12.77a.75.75 0 1 1-1.08-1.04l4.25-4.5a.75.75 0 0 1 1.08 0l4.25 4.5a.75.75 0 0 1-.02 1.06Z"
                                              clip-rule="evenodd"
                                          />
                                      </svg>
                                  </span>
                              </div>
                              ${
                                  this.transcriptsExpanded
                                      ? html`
                                            <div class="transcript-history" id="transcriptHistory">
                                                ${this.transcripts.map(
                                                    (t, i) => html`
                                                        <div
                                                            class="transcript-item ${entrySource(t) === 'user' ? 'from-you' : ''} ${
                                                                i === this.transcripts.length - 1 && !this.interimTranscript ? 'latest' : ''
                                                            }"
                                                        >
                                                            ${entrySource(t) === 'user' ? html`<span class="speaker-tag you">You</span>` : ''}${entryText(t)}
                                                        </div>
                                                    `
                                                )}
                                                ${
                                                    this.interimTranscript
                                                        ? html`
                                                              <div class="transcript-item interim ${latestSource === 'user' ? 'from-you' : ''}">
                                                                  ${latestSource === 'user' ? html`<span class="speaker-tag you">You</span>` : ''}${this.interimTranscript}
                                                              </div>
                                                          `
                                                        : ''
                                                }
                                            </div>
                                        `
                                      : ''
                              }
                          </div>
                      `
                    : ''
            }

            <div class="input-bar">
                <div class="input-bar-inner">
                    <input type="text" id="textInput" placeholder="Type a message..." @keydown=${this.handleTextKeydown} />
                </div>
                <button
                    class="talk-btn ${this.isListening ? 'listening' : ''}"
                    @click=${this.handleTalkClick}
                    title="Push to talk — click to start, click again to send"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="23" />
                    </svg>
                    ${this.isListening ? 'Listening… tap to send' : 'Talk'}
                </button>
                <button
                    class="details-btn"
                    @click=${this.handleExpandAnswer}
                    ?disabled=${this.isStreaming || this.responses.length === 0}
                    title="Show the full detailed answer (${this._shortcutLabel('Shift+D')})"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <line x1="8" y1="6" x2="21" y2="6" />
                        <line x1="8" y1="12" x2="21" y2="12" />
                        <line x1="8" y1="18" x2="21" y2="18" />
                        <line x1="3" y1="6" x2="3.01" y2="6" />
                        <line x1="3" y1="12" x2="3.01" y2="12" />
                        <line x1="3" y1="18" x2="3.01" y2="18" />
                    </svg>
                    Details
                </button>
                <button class="analyze-btn ${this.isAnalyzing ? 'analyzing' : ''}" @click=${this.handleScreenAnswer}>
                    <canvas class="analyze-canvas"></canvas>
                    <span class="analyze-btn-content">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
                            <path
                                fill="none"
                                stroke="currentColor"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M13 3v7h6l-8 11v-7H5z"
                            />
                        </svg>
                        Analyze Screen
                    </span>
                </button>
            </div>
        `;
    }

    _shortcutLabel(combo) {
        const isMac = !window.cheatingDaddy || window.cheatingDaddy.isMacOS !== false;
        return (isMac ? 'Cmd+' : 'Ctrl+') + combo;
    }

    handleExpandAnswer() {
        if (this.isStreaming) return;
        if (window.cheatingDaddy && window.cheatingDaddy.expandAnswer) {
            window.cheatingDaddy.expandAnswer();
        }
    }
}

customElements.define('assistant-view', AssistantView);
