import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

export class HistoryView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            .unified-page {
                overflow-y: hidden;
            }

            .unified-wrap {
                height: 100%;
            }

            .search-wrap {
                position: relative;
                max-width: 280px;
            }

            .search-icon {
                position: absolute;
                left: 10px;
                top: 50%;
                transform: translateY(-50%);
                width: 14px;
                height: 14px;
                color: var(--text-muted);
                pointer-events: none;
            }

            .search-wrap .control {
                padding-left: 30px;
            }

            .list-shell {
                border: 1px solid var(--border);
                border-radius: var(--radius-md);
                background: var(--bg-surface);
                overflow: hidden;
                flex: 1;
                display: flex;
                flex-direction: column;
                min-height: 0;
            }

            .sessions-list {
                overflow-y: auto;
                flex: 1;
            }

            .session-card {
                width: 100%;
                border: none;
                border-bottom: 1px solid var(--border);
                background: transparent;
                text-align: left;
                padding: var(--space-sm) var(--space-md);
                cursor: pointer;
                transition: background var(--transition);
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-sm);
            }

            .session-card:hover {
                background: var(--bg-hover);
            }

            .session-left {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .session-profile {
                color: var(--text-primary);
                font-size: var(--font-size-sm);
            }

            .session-date {
                color: var(--text-muted);
                font-size: var(--font-size-xs);
            }

            .session-badge {
                color: var(--text-secondary);
                font-size: var(--font-size-xs);
                background: var(--bg-elevated);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 2px 8px;
                white-space: nowrap;
            }

            .detail-top {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
            }

            .back-btn {
                border: none;
                background: none;
                color: var(--text-muted);
                padding: 0;
                font-size: var(--font-size-sm);
                cursor: pointer;
                display: flex;
                align-items: center;
            }

            .back-btn svg {
                cursor: pointer;
            }

            .back-btn:hover {
                color: var(--text-primary);
            }

            .detail-info {
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
            }

            .tab-row {
                display: flex;
                gap: 6px;
            }

            .tab-btn {
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: transparent;
                color: var(--text-muted);
                padding: 6px 10px;
                cursor: pointer;
                font-size: var(--font-size-xs);
            }

            .tab-btn:hover {
                color: var(--text-secondary);
            }

            .tab-btn.active {
                color: var(--text-primary);
                border-color: var(--text-secondary);
            }

            .details-scroll {
                overflow-y: auto;
                flex: 1;
                min-height: 0;
                display: flex;
                flex-direction: column;
                gap: var(--space-sm);
                padding: var(--space-sm) 0;
            }

            .message-row {
                display: flex;
            }

            .message-row.user {
                justify-content: flex-end;
            }

            .message-row.ai,
            .message-row.screen {
                justify-content: flex-start;
            }

            .message {
                max-width: 75%;
                border-radius: 16px;
                padding: 8px 12px;
                word-break: break-word;
                user-select: text;
                cursor: text;
                font-size: var(--font-size-sm);
                line-height: 1.45;
            }

            .message-body {
                white-space: pre-wrap;
            }

            .message-meta {
                font-size: 10px;
                margin-top: 4px;
                opacity: 0.5;
            }

            .message-row.user .message {
                background: var(--accent);
                color: var(--bg-app);
                border-bottom-right-radius: 4px;
            }

            .message-row.user .message-meta {
                text-align: right;
            }

            .message-row.ai .message {
                background: var(--bg-elevated);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-bottom-left-radius: 4px;
            }

            .message-row.screen .message {
                background: var(--bg-elevated);
                color: var(--text-primary);
                border: 1px solid var(--border);
                border-bottom-left-radius: 4px;
            }

            .context-row {
                display: flex;
                align-items: flex-start;
                gap: var(--space-sm);
                padding: var(--space-sm);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
            }

            .context-key {
                width: 84px;
                color: var(--text-muted);
                font-size: var(--font-size-xs);
                text-transform: uppercase;
                letter-spacing: 0.4px;
                flex-shrink: 0;
            }

            .context-value {
                color: var(--text-primary);
                font-size: var(--font-size-sm);
                line-height: 1.45;
                white-space: pre-wrap;
                word-break: break-word;
                user-select: text;
                cursor: text;
            }

            .empty {
                color: var(--text-muted);
                font-size: var(--font-size-sm);
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 120px;
                border: 1px dashed var(--border);
                border-radius: var(--radius-sm);
            }

            .history-header-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-sm);
                width: 100%;
            }

            .summary-action-btn {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(168, 85, 247, 0.2));
                border: 1px solid rgba(168, 85, 247, 0.4);
                color: var(--text-primary);
                padding: 6px 12px;
                border-radius: var(--radius-sm);
                font-size: var(--font-size-xs);
                font-weight: 500;
                cursor: pointer;
                transition: all var(--transition);
                white-space: nowrap;
            }

            .summary-action-btn:hover {
                background: linear-gradient(135deg, rgba(99, 102, 241, 0.35), rgba(168, 85, 247, 0.35));
                border-color: rgba(168, 85, 247, 0.6);
                transform: translateY(-1px);
            }

            .summary-action-btn[disabled] {
                opacity: 0.5;
                cursor: not-allowed;
                transform: none;
            }

            .summary-card {
                background: var(--bg-surface);
                border: 1px solid rgba(168, 85, 247, 0.35);
                border-radius: var(--radius-md);
                padding: var(--space-md);
                display: flex;
                flex-direction: column;
                gap: var(--space-xs);
                margin-bottom: var(--space-sm);
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
            }

            .summary-card-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                border-bottom: 1px solid var(--border);
                padding-bottom: 6px;
                margin-bottom: 4px;
            }

            .summary-card-title {
                font-size: var(--font-size-sm);
                font-weight: 600;
                color: var(--text-primary);
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .summary-card-actions {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .summary-mini-btn {
                border: 1px solid var(--border);
                background: var(--bg-elevated);
                color: var(--text-secondary);
                padding: 3px 8px;
                border-radius: var(--radius-sm);
                font-size: 11px;
                cursor: pointer;
                transition: all var(--transition);
            }

            .summary-mini-btn:hover {
                color: var(--text-primary);
                border-color: var(--text-muted);
            }

            .summary-card-body {
                font-size: var(--font-size-sm);
                color: var(--text-primary);
                line-height: 1.5;
                white-space: pre-wrap;
                word-break: break-word;
                user-select: text;
                cursor: text;
            }
        `,
    ];

    static properties = {
        sessions: { type: Array },
        selectedSession: { type: Object },
        selectedSessionId: { type: String },
        loading: { type: Boolean },
        activeTab: { type: String },
        searchQuery: { type: String },
        summaryText: { type: String },
        isSummarizing: { type: Boolean },
        summaryError: { type: String },
        copiedSummary: { type: Boolean },
    };

    constructor() {
        super();
        this.sessions = [];
        this.selectedSession = null;
        this.selectedSessionId = null;
        this.loading = true;
        this.activeTab = 'conversation';
        this.searchQuery = '';
        this.summaryText = '';
        this.isSummarizing = false;
        this.summaryError = '';
        this.copiedSummary = false;
        this.loadSessions();
    }

    async loadSessions() {
        try {
            this.loading = true;
            this.sessions = await cheatingDaddy.storage.getAllSessions();
        } catch (error) {
            console.error('Error loading sessions:', error);
            this.sessions = [];
        } finally {
            this.loading = false;
            this.requestUpdate();
        }
    }

    async openSession(sessionId) {
        try {
            const session = await cheatingDaddy.storage.getSession(sessionId);
            if (session) {
                this.selectedSession = session;
                this.selectedSessionId = sessionId;
                this.activeTab = 'conversation';
                this.summaryText = '';
                this.summaryError = '';
                this.requestUpdate();
            }
        } catch (error) {
            console.error('Error loading session:', error);
        }
    }

    closeSession() {
        this.selectedSession = null;
        this.selectedSessionId = null;
        this.activeTab = 'conversation';
        this.summaryText = '';
        this.summaryError = '';
    }

    handleSearchInput(e) {
        this.searchQuery = e.target.value;
    }

    async generateSummary(session = this.selectedSession) {
        if (this.isSummarizing) return;

        let targetSession = session;
        if (!targetSession && this.sessions.length > 0) {
            targetSession = this.sessions[0];
        }
        if (!targetSession) {
            this.summaryError = 'No session available to summarize.';
            return;
        }

        this.isSummarizing = true;
        this.summaryError = '';
        this.summaryText = '';
        this.requestUpdate();

        try {
            const { ipcRenderer } = window.require('electron');
            const result = await ipcRenderer.invoke('summarize-session', targetSession);
            if (result && result.success && result.text) {
                this.summaryText = result.text.trim();
            } else if (result && result.text) {
                this.summaryText = result.text.trim();
            } else {
                this.summaryError = result?.error || 'Failed to generate summary.';
            }
        } catch (err) {
            console.error('Error generating session summary:', err);
            this.summaryError = err.message || 'Error generating summary.';
        } finally {
            this.isSummarizing = false;
            this.requestUpdate();
        }
    }

    copySummary() {
        if (!this.summaryText) return;
        navigator.clipboard.writeText(this.summaryText);
        this.copiedSummary = true;
        this.requestUpdate();
        setTimeout(() => {
            this.copiedSummary = false;
            this.requestUpdate();
        }, 2000);
    }

    clearSummary() {
        this.summaryText = '';
        this.summaryError = '';
    }

    formatDate(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }

    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

    _getProfileLabel(session) {
        if (session.profile) {
            const names = this.getProfileNames();
            return names[session.profile] || session.profile;
        }
        return 'Session';
    }

    getSessionPreview(session) {
        const parts = [];
        if (session.messageCount > 0) parts.push(`${session.messageCount} messages`);
        if (session.screenAnalysisCount > 0) parts.push(`${session.screenAnalysisCount} screen`);
        if (session.profile) {
            const profileNames = this.getProfileNames();
            parts.push(profileNames[session.profile] || session.profile);
        }
        return parts.length > 0 ? parts.join(' · ') : 'Empty session';
    }

    getFilteredSessions() {
        if (!this.searchQuery.trim()) return this.sessions;
        const q = this.searchQuery.toLowerCase();
        return this.sessions.filter(session => {
            const preview = this.getSessionPreview(session).toLowerCase();
            const date = this.formatDate(session.createdAt).toLowerCase();
            return preview.includes(q) || date.includes(q);
        });
    }

    collectConversation(session) {
        const messages = [];
        const history = session.conversationHistory || [];
        history.forEach(turn => {
            if (turn.transcription) messages.push({ type: 'user', content: turn.transcription, timestamp: turn.timestamp });
            if (turn.ai_response) messages.push({ type: 'ai', content: turn.ai_response, timestamp: turn.timestamp });
        });
        return messages;
    }

    renderSummaryCard() {
        if (this.isSummarizing) {
            return html`
                <div class="summary-card">
                    <div class="summary-card-header">
                        <span class="summary-card-title">✨ Generating AI History Summary...</span>
                    </div>
                    <div class="summary-card-body" style="color: var(--text-muted);">
                        Analyzing session transcript and extracting key discussion highlights...
                    </div>
                </div>
            `;
        }

        if (this.summaryError) {
            return html`
                <div class="summary-card" style="border-color: rgba(255, 80, 80, 0.4);">
                    <div class="summary-card-header">
                        <span class="summary-card-title" style="color: #ff6b6b;">⚠️ Summary Generation Failed</span>
                        <button class="summary-mini-btn" @click=${() => this.clearSummary()}>Dismiss</button>
                    </div>
                    <div class="summary-card-body" style="color: var(--text-secondary);">${this.summaryError}</div>
                </div>
            `;
        }

        if (!this.summaryText) return '';

        return html`
            <div class="summary-card">
                <div class="summary-card-header">
                    <span class="summary-card-title">✨ AI History Summary</span>
                    <div class="summary-card-actions">
                        <button class="summary-mini-btn" @click=${() => this.copySummary()}>
                            ${this.copiedSummary ? '✓ Copied!' : 'Copy Summary'}
                        </button>
                        <button class="summary-mini-btn" @click=${() => this.clearSummary()}>Close</button>
                    </div>
                </div>
                <div class="summary-card-body">${this.summaryText}</div>
            </div>
        `;
    }

    renderTabContent() {
        if (!this.selectedSession) return html`<div class="empty">Select a session.</div>`;

        if (this.activeTab === 'conversation') {
            const messages = this.collectConversation(this.selectedSession);
            if (!messages.length) return html`<div class="empty">No conversation data.</div>`;
            return messages.map(
                msg => html`
                    <div class="message-row ${msg.type}">
                        <div class="message">
                            <div class="message-body">${msg.content}</div>
                            <div class="message-meta">${this.formatTime(msg.timestamp)}</div>
                        </div>
                    </div>
                `
            );
        }

        if (this.activeTab === 'screen') {
            const screen = this.selectedSession.screenAnalysisHistory || [];
            if (!screen.length) return html`<div class="empty">No screen analysis data.</div>`;
            return screen.map(
                entry => html`
                    <div class="message-row screen">
                        <div class="message">
                            <div class="message-body">${entry.response || ''}</div>
                            <div class="message-meta">${this.formatTime(entry.timestamp)}</div>
                        </div>
                    </div>
                `
            );
        }

        const profile = this.selectedSession.profile;
        const prompt = this.selectedSession.customPrompt;
        if (!profile && !prompt) return html`<div class="empty">No context saved for this session.</div>`;

        return html`
            ${
                profile
                    ? html`
                          <div class="context-row">
                              <span class="context-key">Profile</span>
                              <span class="context-value">${this.getProfileNames()[profile] || profile}</span>
                          </div>
                      `
                    : ''
            }
            ${
                prompt
                    ? html`
                          <div class="context-row">
                              <span class="context-key">Prompt</span>
                              <span class="context-value">${prompt}</span>
                          </div>
                      `
                    : ''
            }
        `;
    }

    renderListView() {
        const filteredSessions = this.getFilteredSessions();
        return html`
            <div class="history-header-row">
                <div class="page-title">History</div>
                <button
                    class="summary-action-btn"
                    ?disabled=${this.isSummarizing || this.sessions.length === 0}
                    @click=${() => this.generateSummary()}
                >
                    ✨ ${this.isSummarizing ? 'Summarizing...' : 'Summarize History'}
                </button>
            </div>

            <div class="search-wrap">
                <svg
                    class="search-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input class="control" type="text" placeholder="Search sessions..." .value=${this.searchQuery} @input=${this.handleSearchInput} />
            </div>

            ${this.renderSummaryCard()}

            <section class="list-shell">
                <div class="sessions-list">
                    ${this.loading ? html`<div class="empty" style="margin:var(--space-md);">Loading sessions...</div>` : ''}
                    ${!this.loading && filteredSessions.length === 0 ? html`<div class="empty" style="margin:var(--space-md);">No matching sessions.</div>` : ''}
                    ${
                        !this.loading
                            ? filteredSessions.map(
                                  session => html`
                                      <button class="session-card" @click=${() => this.openSession(session.sessionId)}>
                                          <div class="session-left">
                                              <span class="session-profile">${this._getProfileLabel(session)}</span>
                                              <span class="session-date"
                                                  >${this.formatDate(session.createdAt)} · ${this.formatTime(session.createdAt)}</span
                                              >
                                          </div>
                                          ${session.messageCount > 0 ? html`<span class="session-badge">${session.messageCount}</span>` : ''}
                                      </button>
                                  `
                              )
                            : ''
                    }
                </div>
            </section>
        `;
    }

    renderDetailView() {
        const conversationCount = this.collectConversation(this.selectedSession).length;
        const screenCount = this.selectedSession?.screenAnalysisHistory?.length || 0;

        return html`
            <div class="history-header-row">
                <div class="page-title">Session Detail</div>
                <button class="summary-action-btn" ?disabled=${this.isSummarizing} @click=${() => this.generateSummary(this.selectedSession)}>
                    ✨ ${this.isSummarizing ? 'Summarizing...' : 'Summarize Session'}
                </button>
            </div>
            <div class="detail-top">
                <button class="back-btn" @click=${this.closeSession}>
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                </button>
                <span class="detail-info"
                    >${this._getProfileLabel(this.selectedSession)} · ${this.formatDate(this.selectedSession.createdAt)} ·
                    ${this.formatTime(this.selectedSession.createdAt)}</span
                >
            </div>
            ${this.renderSummaryCard()}
            <div class="tab-row">
                <button
                    class="tab-btn ${this.activeTab === 'conversation' ? 'active' : ''}"
                    @click=${() => {
                        this.activeTab = 'conversation';
                    }}
                >
                    Conversation (${conversationCount})
                </button>
                <button
                    class="tab-btn ${this.activeTab === 'screen' ? 'active' : ''}"
                    @click=${() => {
                        this.activeTab = 'screen';
                    }}
                >
                    Screen (${screenCount})
                </button>
                <button
                    class="tab-btn ${this.activeTab === 'context' ? 'active' : ''}"
                    @click=${() => {
                        this.activeTab = 'context';
                    }}
                >
                    Context
                </button>
            </div>
            <section class="details-scroll">${this.renderTabContent()}</section>
        `;
    }

    render() {
        return html`
            <div class="unified-page">
                <div class="unified-wrap">${this.selectedSession ? this.renderDetailView() : this.renderListView()}</div>
            </div>
        `;
    }
}

customElements.define('history-view', HistoryView);
