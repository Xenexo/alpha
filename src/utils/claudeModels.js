// Fetches the live Claude model catalog for the settings model picker, so new
// models (e.g. Fable 5) appear without shipping a code change.
//
// Two auth paths:
//   - API-key mode: the user's Anthropic API key (x-api-key).
//   - CLI mode: reuse the installed Claude Code login. Its OAuth token lives in
//     the macOS Keychain (service "Claude Code-credentials") or, on other
//     platforms, in ~/.claude/.credentials.json. That subscription token
//     authorizes GET /v1/models when sent as a Bearer token with the oauth
//     beta header — the same credential the CLI itself uses.
//
// Best-effort: any failure (no token, expired, offline, unsupported platform)
// resolves to null so the caller can fall back to a built-in list. Read-only;
// never writes credentials and never logs the token.
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const OAUTH_BETA = 'oauth-2025-04-20';
const ANTHROPIC_VERSION = '2023-06-01';

function readKeychainToken() {
    return new Promise(resolve => {
        if (process.platform !== 'darwin') return resolve(null);
        execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, stdout) => {
            if (err) return resolve(null);
            try {
                resolve(JSON.parse(stdout)?.claudeAiOauth?.accessToken || null);
            } catch {
                resolve(null);
            }
        });
    });
}

function readFileToken() {
    try {
        const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
        return JSON.parse(raw)?.claudeAiOauth?.accessToken || null;
    } catch {
        return null;
    }
}

async function readOAuthToken() {
    return (await readKeychainToken()) || readFileToken();
}

// GET /v1/models with the given auth headers; resolves to [{id,name}] newest
// first (the API's own order), or null on any non-200 / parse / transport error.
function fetchModels(headers) {
    return new Promise(resolve => {
        const req = https.request({ host: 'api.anthropic.com', path: '/v1/models?limit=100', method: 'GET', headers, timeout: 8000 }, res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve(null);
                try {
                    const parsed = JSON.parse(data);
                    const models = (parsed.data || [])
                        .filter(m => typeof m.id === 'string' && m.id.startsWith('claude-'))
                        .map(m => ({ id: m.id, name: m.display_name || m.id }));
                    resolve(models.length ? models : null);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
        req.end();
    });
}

// apiKey present → API-key auth (API-key mode). Otherwise → CLI OAuth token.
async function listClaudeModels({ apiKey } = {}) {
    if (apiKey && apiKey.trim()) {
        return fetchModels({ 'x-api-key': apiKey.trim(), 'anthropic-version': ANTHROPIC_VERSION });
    }
    const token = await readOAuthToken();
    if (!token) return null;
    return fetchModels({ authorization: `Bearer ${token}`, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': OAUTH_BETA });
}

module.exports = { listClaudeModels, readOAuthToken };
