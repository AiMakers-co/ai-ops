#!/usr/bin/env node
// Claude Code session dashboard — local server.
// Scans ~/.claude/projects/*/*.jsonl, builds a cached index, serves a
// browsable/searchable dashboard with full-transcript view + resume.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFile, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'sessions-index.json');
const PORT = 8934;

const execFileP = promisify(execFile);
const execP = promisify(execCb);

const CREDS_PATH = path.join(HOME, '.claude', 'credentials.json');
const ACCOUNTS_REGISTRY_PATH = path.join(HOME, '.claude', 'accounts.json');
const ACTIVE_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ACCOUNT = os.userInfo().username;

// ---------- Codex (ChatGPT) provider ----------
// Codex creds live in a FILE, not Keychain: ~/.codex/auth.json (mode 0600).
// Additional (stashed) accounts live as files under ~/.codex/accounts/<8hex>.json,
// with a separate registry at ~/.codex/accounts-registry.json mapping
// <8hex> -> { label }. The Codex registry is kept fully separate from the Claude
// one to avoid coupling the two providers.
const CODEX_DIR = path.join(HOME, '.codex');
const CODEX_AUTH_PATH = path.join(CODEX_DIR, 'auth.json');
const CODEX_ACCOUNTS_DIR = path.join(CODEX_DIR, 'accounts');
const CODEX_REGISTRY_PATH = path.join(CODEX_DIR, 'accounts-registry.json');
// OpenAI OAuth (Codex CLI client). client_id is the `aud` of the codex id_token.
// All params below are VERIFIED from the open-source Codex CLI Rust login server
// (codex-rs/login/src/server.rs + pkce.rs) — do not change without re-checking source.
//   - issuer/authorize:  https://auth.openai.com/oauth/authorize   (DEFAULT_ISSUER)
//   - token:             https://auth.openai.com/oauth/token
//   - loopback port:     1455 (DEFAULT_PORT), fallback 1457 (FALLBACK_PORT)
//   - redirect_uri:      http://localhost:<port>/auth/callback
//   - PKCE:              verifier = 64 random bytes URL-safe-base64 no-pad;
//                        challenge = base64url(sha256(verifier)); method S256
//                        (identical to Claude's makePkce — reused directly)
const CODEX_OAUTH = {
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
  loopbackPort: 1455,
  fallbackPort: 1457,
  callbackPath: '/auth/callback',
  originator: 'codex_cli_rs',
};
// OpenAI's auth-claims namespace inside a Codex JWT (id_token / access_token).
const CODEX_AUTH_CLAIM = 'https://api.openai.com/auth';

// ---------- indexing ----------

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

async function parseSessionFile(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let sessionId = null;
  let cwd = null;
  let gitBranch = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let aiTitle = null;
  let lastPrompt = null;
  let firstUserText = null;
  let userCount = 0;
  let assistantCount = 0;
  let lineCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    lineCount++;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!sessionId && d.sessionId) sessionId = d.sessionId;
    if (d.cwd) cwd = d.cwd;
    if (d.gitBranch) gitBranch = d.gitBranch;
    if (d.timestamp) {
      if (!firstTimestamp) firstTimestamp = d.timestamp;
      lastTimestamp = d.timestamp;
    }
    if (d.type === 'ai-title' && d.aiTitle) aiTitle = d.aiTitle;
    if (d.type === 'last-prompt' && d.lastPrompt) lastPrompt = d.lastPrompt;
    if (d.type === 'user') {
      userCount++;
      if (!firstUserText) {
        const t = extractText(d.message?.content);
        if (t) firstUserText = t;
      }
    }
    if (d.type === 'assistant') assistantCount++;
  }

  const title =
    (aiTitle && aiTitle.trim()) ||
    (lastPrompt && lastPrompt.trim().slice(0, 100)) ||
    (firstUserText && firstUserText.trim().slice(0, 100)) ||
    '(untitled session)';

  return {
    id: sessionId || path.basename(filePath, '.jsonl'),
    file: filePath,
    cwd,
    gitBranch,
    title,
    lastPrompt: lastPrompt || firstUserText || '',
    firstTimestamp,
    lastTimestamp,
    userCount,
    assistantCount,
    lineCount,
  };
}

async function listSessionFiles() {
  const files = [];
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, entry.name);
    let children;
    try {
      children = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const c of children) {
      if (c.isFile() && c.name.endsWith('.jsonl')) {
        files.push(path.join(dir, c.name));
      }
    }
  }
  return files;
}

async function loadCache() {
  try {
    const raw = await fsp.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await fsp.writeFile(CACHE_FILE, JSON.stringify(cache));
}

let building = null;

async function buildIndex() {
  if (building) return building;
  building = (async () => {
    const cache = await loadCache();
    const files = await listSessionFiles();
    const nextCache = {};
    const results = [];

    for (const filePath of files) {
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        continue;
      }
      const cached = cache[filePath];
      let data;
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        data = cached.data;
      } else {
        try {
          data = await parseSessionFile(filePath);
        } catch (e) {
          continue;
        }
      }
      nextCache[filePath] = { mtimeMs: stat.mtimeMs, size: stat.size, data };
      results.push({ ...data, size: stat.size, mtimeMs: stat.mtimeMs });
    }

    await saveCache(nextCache);
    results.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
    return results;
  })();
  try {
    return await building;
  } finally {
    building = null;
  }
}

// ---------- transcript rendering ----------

const TRUNCATE_AT = 6000;
function truncate(text) {
  if (typeof text !== 'string') return text;
  if (text.length <= TRUNCATE_AT) return text;
  return text.slice(0, TRUNCATE_AT) + `\n… [truncated, ${text.length - TRUNCATE_AT} more chars]`;
}

async function getTranscript(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const turns = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }

    if (d.type === 'user') {
      const content = d.message?.content;
      if (typeof content === 'string') {
        if (content.trim()) turns.push({ role: 'user', kind: 'text', text: truncate(content), ts: d.timestamp });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'text' && b.text?.trim()) {
            turns.push({ role: 'user', kind: 'text', text: truncate(b.text), ts: d.timestamp });
          } else if (b.type === 'tool_result') {
            const t = extractText(b.content) || (typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
            turns.push({ role: 'user', kind: 'tool_result', text: truncate(t || ''), ts: d.timestamp });
          }
        }
      }
    } else if (d.type === 'assistant') {
      const content = d.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'text' && b.text?.trim()) {
            turns.push({ role: 'assistant', kind: 'text', text: truncate(b.text), ts: d.timestamp });
          } else if (b.type === 'tool_use') {
            turns.push({
              role: 'assistant',
              kind: 'tool_use',
              name: b.name,
              input: truncate(JSON.stringify(b.input, null, 2) || ''),
              ts: d.timestamp,
            });
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        turns.push({ role: 'assistant', kind: 'text', text: truncate(content), ts: d.timestamp });
      }
    }
  }

  return turns;
}

// ---------- resume ----------

function escapeAppleScriptString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function resumeSession(cwd, sessionId) {
  const dir = cwd || HOME;
  const script = `tell application "Terminal"
    activate
    do script "cd \\"${escapeAppleScriptString(dir)}\\" && claude --resume ${escapeAppleScriptString(sessionId)}"
  end tell`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------- OAuth loopback login (in-app "Add account") ----------
//
// Replaces the old `claude /login` Terminal dance with a real OAuth
// authorization-code + PKCE flow. The browser opens straight to the Claude
// login page, approves, and redirects back to THIS server's /callback route,
// which exchanges the code for tokens and stashes the account.
//
// All params below are VERIFIED from the real Claude CLI — do not change.
const OAUTH = {
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  redirectUri: `http://localhost:${PORT}/callback`,
  scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
};

// Single-flight in-memory login state. Holds secrets (code_verifier, state) —
// never logged, never persisted to disk.
let pendingLogin = null; // { code_verifier, state, createdAt, status, email, error }

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PKCE: verifier = 64 random bytes base64url; challenge = base64url(sha256(verifier)).
function makePkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// Build the authorize URL. encodeURIComponent renders spaces in scope as %20
// (not '+'), which the auth server accepts. NOTE: deliberately no `code=true`
// (that triggers the manual code-paste page; we want a loopback redirect).
function buildAuthorizeUrl({ challenge, state, email }) {
  const pairs = [
    ['response_type', 'code'],
    ['client_id', OAUTH.clientId],
    ['redirect_uri', OAUTH.redirectUri],
    ['scope', OAUTH.scope],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['state', state],
  ];
  if (email) pairs.push(['login_hint', email]);
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${OAUTH.authorizeUrl}?${qs}`;
}

// Exchange the authorization code for tokens. Tries JSON first; on a 4xx that
// looks like a format error, retries once as form-encoded. Never logs tokens.
async function exchangeCodeForTokens(code, verifier, state) {
  const fields = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: OAUTH.redirectUri,
    client_id: OAUTH.clientId,
    code_verifier: verifier,
    state,
  };

  let res = await fetch(OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  });

  if (res.ok) {
    console.log('[login] token exchange ok via json');
    return res.json();
  }

  // JSON attempt failed — capture the error body (OAuth error JSON, not a
  // secret) so we can see WHY (e.g. invalid_grant / redirect_uri_mismatch).
  const jsonBody = await res.text().catch(() => '');
  console.log(`[login] token exchange JSON failed ${res.status}: ${jsonBody.slice(0, 400)}`);

  // Retry once form-encoded.
  const res2 = await fetch(OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  if (res2.ok) {
    console.log('[login] token exchange ok via form-encoded');
    return res2.json();
  }
  const formBody = await res2.text().catch(() => '');
  console.log(`[login] token exchange FORM failed ${res2.status}: ${formBody.slice(0, 400)}`);

  const err = new Error(`token exchange failed (json:${res.status} form:${res2.status})`);
  err.status = res.status;
  throw err;
}

// Pull the fields we need to build the stored blob from the profile endpoint.
async function fetchProfileForBlob(accessToken) {
  try {
    const headers = { authorization: `Bearer ${accessToken}`, ...ANTHROPIC_HEADERS_BASE };
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', { headers });
    if (!res.ok) return { email: null, rateLimitTier: null, subscriptionType: null };
    const profile = await res.json();
    const rateLimitTier = profile.organization?.rate_limit_tier || null;
    const orgType = profile.organization?.organization_type || null;
    const hasMax = !!profile.account?.has_claude_max;
    const hasPro = !!profile.account?.has_claude_pro;
    let subscriptionType = null;
    if (hasMax) subscriptionType = 'max';
    else if (hasPro) subscriptionType = 'pro';
    else if (orgType) subscriptionType = orgType;
    return { email: profile.account?.email || null, rateLimitTier, subscriptionType };
  } catch {
    return { email: null, rateLimitTier: null, subscriptionType: null };
  }
}

// Given a raw token response, build the stored blob in the existing shape,
// stash it under a keychain service (dedupe by email), register it, and make
// it the active account (matches `claude` behavior). Never logs the blob.
async function completeLoginFromTokens(tokenResp) {
  const accessToken = tokenResp.access_token;
  if (!accessToken) throw new Error('token response missing access_token');
  const refreshToken = tokenResp.refresh_token || null;

  let expiresAt;
  if (typeof tokenResp.expires_in === 'number') expiresAt = Date.now() + tokenResp.expires_in * 1000;
  else if (typeof tokenResp.expires_at === 'number') expiresAt = tokenResp.expires_at;
  else expiresAt = Date.now() + 3600 * 1000;

  const prof = await fetchProfileForBlob(accessToken);
  const email = prof.email;

  const blob = {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes: OAUTH.scope.split(' '),
      subscriptionType: prof.subscriptionType,
      rateLimitTier: prof.rateLimitTier,
    },
  };
  const raw = JSON.stringify(blob);

  // Dedupe by email: reuse the existing service if this email is registered.
  const registry = await loadAccountsRegistry();
  let service = null;
  if (email) {
    for (const [svc, meta] of Object.entries(registry)) {
      if (meta && meta.label === email && svc !== ACTIVE_SERVICE) { service = svc; break; }
    }
  }
  if (!service) service = stashServiceName(accessToken);

  await writeKeychainService(service, raw);
  if (email) await registerLabel(service, email);

  // Do NOT auto-activate the newly-added account. Adding an account only
  // stores it; the current active account stays untouched (so adding never
  // switches you onto a fresh/maxed account by surprise). The user switches
  // deliberately via the switcher, which has its own confirmation.
  accountCache.clear();
  return { service, email };
}

function escapeHtmlServer(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal self-contained page shown in the browser after redirect.
function callbackPage(message, ok) {
  const accent = ok ? '#7fbf7f' : '#d4685a';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Sessions</title>
<style>
  body{margin:0;background:#0e0f11;color:#e7e8ea;
    font:15px/1.6 -apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#16181c;border:1px solid #2a2d33;border-radius:12px;
    padding:32px 40px;text-align:center;max-width:440px}
  .dot{color:${accent};font-size:34px;line-height:1;margin-bottom:12px}
  h1{font-size:16px;font-weight:600;margin:0 0 8px}
  p{color:#9a9ea6;font-size:13px;margin:0}
</style></head>
<body><div class="card"><div class="dot">${ok ? '&#10003;' : '&#33;'}</div>
<h1>${message}</h1>
<p>${ok ? 'This tab will close automatically.' : 'You can close this tab and try again from the dashboard.'}</p>
</div>${ok ? '<script>setTimeout(function(){window.close()},2000)</script>' : ''}</body></html>`;
}

// ---------- accounts: keychain + Claude usage ----------

// NOTE ON SECRETS: never log accessToken/refreshToken. Only service names,
// emails, and status make it into console.log or server.log.

async function readKeychainService(service) {
  try {
    const { stdout } = await execFileP('security', ['find-generic-password', '-s', service, '-w']);
    return stdout.replace(/\n$/, '');
  } catch {
    return null; // not found / access denied
  }
}

async function writeKeychainService(service, jsonString) {
  await execFileP('security', [
    'add-generic-password', '-U',
    '-s', service,
    '-a', KEYCHAIN_ACCOUNT,
    '-w', jsonString,
  ]);
}

// Discover keychain services that might hold Claude account credentials.
// `security dump-keychain` (no -w) only prints attributes, never secret
// data, so this is safe to run via a shell pipe.
async function discoverServiceNames() {
  const names = new Set([ACTIVE_SERVICE]);
  try {
    const { stdout } = await execP(
      `security dump-keychain 2>/dev/null | grep -oE '"Claude Code-credentials(-[a-f0-9]+)?"' | tr -d '"' | sort -u`
    );
    for (const line of stdout.split('\n')) {
      const s = line.trim();
      if (s) names.add(s);
    }
  } catch {
    // grep returns non-zero if nothing matches; ignore
  }
  return [...names];
}

// Normalize a raw keychain blob into { accessToken, refreshToken, expiresAt,
// scopes, subscriptionType, rateLimitTier }. Returns null if the blob isn't
// a recognizable Claude credential (e.g. an mcpOAuth plugin-auth blob).
function normalizeBlob(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  let oauth = parsed.claudeAiOauth;
  if (typeof oauth === 'string') {
    try {
      oauth = JSON.parse(oauth);
    } catch {
      oauth = null;
    }
  }

  if (oauth && typeof oauth === 'object' && oauth.accessToken) {
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken || null,
      expiresAt: oauth.expiresAt ?? null,
      scopes: oauth.scopes || null,
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null,
    };
  }

  // Flat shape, e.g. some third-party tools: { access_token, refresh_token, expires_at }
  if (typeof parsed.access_token === 'string') {
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token || null,
      expiresAt: parsed.expires_at ?? null,
      scopes: parsed.scopes || null,
      subscriptionType: parsed.subscriptionType || null,
      rateLimitTier: parsed.rateLimitTier || null,
    };
  }

  return null; // not a Claude credential blob (e.g. mcpOAuth plugin auth)
}

function planLabel(rateLimitTier) {
  if (!rateLimitTier) return null;
  if (rateLimitTier === 'default_claude_max_20x') return 'Max 20x';
  if (rateLimitTier === 'default_claude_max_5x') return 'Max 5x';
  if (rateLimitTier.includes('pro')) return 'Pro';
  return rateLimitTier;
}

const ANTHROPIC_HEADERS_BASE = {
  'anthropic-beta': 'oauth-2025-04-20',
};

// Fetch /usage with one retry on 429. IMPORTANT: a 429 here means the usage
// ENDPOINT throttled our request (too many rapid calls) — it does NOT mean the
// account is at its usage limit. A genuinely maxed account returns 200 with
// percent=100 bars. So 429 => "usage temporarily unavailable", never "at limit".
async function fetchUsageWithRetry(headers) {
  // The /usage endpoint throttles intermittently under load (the active account
  // 429s often but 200s if you retry). Up to 3 attempts with increasing backoff.
  const backoffs = [700, 1500];
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/api/oauth/usage', { headers });
    } catch {
      return { ok: false, status: 0 };
    }
    if (res.ok) return { ok: true, json: await res.json() };
    if (res.status === 429 && attempt < backoffs.length) {
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
      continue;
    }
    return { ok: false, status: res.status };
  }
  return { ok: false, status: 429 };
}

// Last successfully-fetched usage per account (keyed by stable email). When a
// fresh /usage fetch fails (429 throttle), we fall back to this so the account —
// especially the ACTIVE one under load — shows its last-known bars with a
// "stale" marker instead of blanking to "Usage unavailable".
const lastGoodUsage = new Map(); // email -> { usage, ts }
const USAGE_CACHE_FILE = path.join(CACHE_DIR, 'usage-cache.json');

// Persist last-good usage to disk so a heavily-throttled account (esp. the
// active one) still shows its last-known bars immediately after a restart,
// rather than blanking until it wins a race with the throttled /usage endpoint.
function saveUsageCache() {
  fsp.mkdir(CACHE_DIR, { recursive: true })
    .then(() => fsp.writeFile(USAGE_CACHE_FILE, JSON.stringify([...lastGoodUsage])))
    .catch(() => {}); // fire-and-forget; not critical
}
async function loadUsageCache() {
  try {
    const raw = await fsp.readFile(USAGE_CACHE_FILE, 'utf8');
    for (const [email, v] of JSON.parse(raw)) {
      if (email && v && v.usage) lastGoodUsage.set(email, v);
    }
  } catch { /* no cache yet */ }
}

async function fetchProfileAndUsage(accessToken) {
  const headers = { authorization: `Bearer ${accessToken}`, ...ANTHROPIC_HEADERS_BASE };
  // Token validity is determined by the PROFILE call only.
  let profileRes;
  try {
    profileRes = await fetch('https://api.anthropic.com/api/oauth/profile', { headers });
  } catch {
    return { status: 'error', error: 'network error' };
  }
  if (profileRes.status === 401 || profileRes.status === 403) {
    return { status: 'needs_refresh' };
  }
  if (!profileRes.ok) {
    return { status: 'error', error: `profile:${profileRes.status}` };
  }

  const profile = await profileRes.json();

  // Usage is best-effort with a retry. If we still can't fetch it, degrade
  // (status stays 'ok') and mark usageUnavailable — NOT "at limit".
  const email = profile.account?.email || null;
  const usageResult = await fetchUsageWithRetry(headers);
  let usage = null;
  let usageError = null;
  let usageStale = false;
  let usageAsOf = null;
  if (usageResult.ok) {
    const u = usageResult.json;
    const limits = (u.limits || []).map((l) => {
      let label = l.kind;
      if (l.kind === 'session') label = 'Current session';
      else if (l.kind === 'weekly_all') label = 'All models';
      else if (l.kind === 'weekly_scoped') label = l.scope?.model?.display_name || l.kind;
      return { ...l, label };
    });
    usage = { limits, five_hour: u.five_hour || null, seven_day: u.seven_day || null };
    if (email) { lastGoodUsage.set(email, { usage, ts: Date.now() }); saveUsageCache(); }
  } else {
    // Endpoint threw/throttled — fall back to the last-known usage so the
    // account still shows its bars (marked stale), NOT a blank "unavailable".
    const cached = email ? lastGoodUsage.get(email) : null;
    if (cached) {
      usage = cached.usage;
      usageStale = true;
      usageAsOf = cached.ts;
    } else {
      usageError = String(usageResult.status);
    }
  }

  return {
    status: 'ok',
    email,
    fullName: profile.account?.full_name || null,
    hasMax: !!profile.account?.has_claude_max,
    hasPro: !!profile.account?.has_claude_pro,
    plan: planLabel(profile.organization?.rate_limit_tier),
    usage,
    usageError,
    usageStale,
    usageAsOf,
  };
}

// service -> { data, ts } — keyed by service+tokenHash so a rotated token
// (e.g. after `claude` refreshes it, or after activate) auto-invalidates.
const accountCache = new Map();
const ACCOUNT_CACHE_TTL_MS = 60_000;

async function getAccountInfoCached(service, accessToken) {
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 12);
  const key = `${service}:${tokenHash}`;
  const cached = accountCache.get(key);
  if (cached && Date.now() - cached.ts < ACCOUNT_CACHE_TTL_MS) {
    return cached.data;
  }
  let data;
  try {
    data = await fetchProfileAndUsage(accessToken);
  } catch (e) {
    data = { status: 'error', error: 'network error' };
  }
  accountCache.set(key, { data, ts: Date.now() });
  return data;
}

async function loadAccountsRegistry() {
  try {
    const raw = await fsp.readFile(ACCOUNTS_REGISTRY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeSecretFile(filePath, contents) {
  const tmp = filePath + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, contents, { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, filePath);
  await fsp.chmod(filePath, 0o600);
}

// Ensure the on-disk credentials mirror is never world/group readable,
// independent of whether we're about to rewrite it.
async function tightenCredsPerms() {
  try {
    await fsp.chmod(CREDS_PATH, 0o600);
  } catch {
    // file may not exist yet; fine
  }
}

// Use a stored refresh token to mint a fresh access token, and persist the
// rotated pair back to Keychain in the blob's original shape. Refresh tokens
// are single-use — if we don't save the new one, the account bricks. Returns
// the updated normalized blob, or null if refresh is impossible/failed. Never
// logs tokens.
async function refreshServiceToken(service) {
  const raw = await readKeychainService(service);
  const norm = normalizeBlob(raw);
  if (!norm || !norm.refreshToken) return null;

  let resp;
  try {
    resp = await fetch(OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: norm.refreshToken,
        client_id: OAUTH.clientId,
      }),
    });
  } catch {
    return null; // network error
  }
  if (!resp.ok) {
    console.log(`[refresh] ${service}: refresh grant failed ${resp.status}`);
    return null; // e.g. invalid_grant → refresh token truly dead; leave as-is
  }
  let tok;
  try { tok = await resp.json(); } catch { return null; }
  if (!tok.access_token) return null;

  const newExpiresAt = typeof tok.expires_in === 'number'
    ? Date.now() + tok.expires_in * 1000
    : (typeof tok.expires_at === 'number' ? tok.expires_at : Date.now() + 3600 * 1000);

  // Rewrite the blob preserving its original shape — only rotate the token trio.
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (parsed && parsed.claudeAiOauth) {
    let o = parsed.claudeAiOauth;
    const wasString = typeof o === 'string';
    if (wasString) { try { o = JSON.parse(o); } catch { o = {}; } }
    o.accessToken = tok.access_token;
    o.refreshToken = tok.refresh_token || norm.refreshToken;
    o.expiresAt = newExpiresAt;
    parsed.claudeAiOauth = wasString ? JSON.stringify(o) : o;
  } else if (parsed && parsed.access_token) {
    parsed.access_token = tok.access_token;
    parsed.refresh_token = tok.refresh_token || norm.refreshToken;
    parsed.expires_at = newExpiresAt;
  } else {
    parsed = {
      claudeAiOauth: {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token || norm.refreshToken,
        expiresAt: newExpiresAt,
        scopes: norm.scopes,
        subscriptionType: norm.subscriptionType,
        rateLimitTier: norm.rateLimitTier,
      },
    };
  }

  const newRaw = JSON.stringify(parsed);
  try {
    await writeKeychainService(service, newRaw);
  } catch {
    console.log(`[refresh] ${service}: keychain write-back failed`);
    return null;
  }
  console.log(`[refresh] ${service}: access token refreshed`);
  return normalizeBlob(newRaw);
}

async function buildAccountsList() {
  await tightenCredsPerms();

  const serviceNames = await discoverServiceNames();

  // Read + normalize every service first (cheap, local).
  const entries = [];
  for (const service of serviceNames) {
    const raw = await readKeychainService(service);
    const norm = normalizeBlob(raw);
    if (!norm) continue; // not a Claude credential (e.g. mcpOAuth plugin blob) — skip
    entries.push({ service, norm });
  }

  const registry = await loadAccountsRegistry();

  // Fetch profile+usage for all entries concurrently (cache dedupes
  // repeated tokens automatically).
  const results = await Promise.all(
    entries.map(async ({ service, norm }) => {
      // Proactive: if the access token is expired (or within 60s of it), mint a
      // fresh one from the refresh token so stored accounts don't go stale.
      if (norm.refreshToken && norm.expiresAt && norm.expiresAt <= Date.now() + 60_000) {
        const refreshed = await refreshServiceToken(service);
        if (refreshed) norm = refreshed;
      }
      let info = await getAccountInfoCached(service, norm.accessToken);
      // Reactive: token looked valid but the API rejected it (401/403) — try one
      // refresh and re-fetch before giving up and showing "needs refresh".
      if (info.status === 'needs_refresh' && norm.refreshToken) {
        const refreshed = await refreshServiceToken(service);
        if (refreshed) {
          norm = refreshed;
          info = await getAccountInfoCached(service, norm.accessToken);
        }
      }
      return { service, norm, info };
    })
  );

  // Active account is identified by EMAIL, not access token — `claude`
  // refreshes the active token in place, so token-equality would go stale
  // the moment it rotates.
  const activeEntry = results.find((r) => r.service === ACTIVE_SERVICE);
  const activeEmail = activeEntry?.info?.status === 'ok' ? activeEntry.info.email : null;

  return results.map(({ service, info }) => {
    const label = registry[service]?.label;
    const base = {
      service,
      isActive: !!(activeEmail && info.status === 'ok' && info.email === activeEmail),
      email: label || info.email || null,
      plan: info.plan || null,
      status: info.status,
    };
    if (info.status === 'ok') {
      base.usage = info.usage;               // may be last-known (stale) or null
      if (info.usageError) base.usageError = info.usageError;
      if (info.usageStale) { base.usageStale = true; base.usageAsOf = info.usageAsOf; }
    } else if (info.status === 'error') {
      base.error = info.error;
    }
    return base;
  });
}

function stashServiceName(accessToken) {
  const hex = crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hex}`;
}

async function activateAccount(targetService) {
  const targetRaw = await readKeychainService(targetService);
  if (!targetRaw) {
    const err = new Error('service not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const targetNorm = normalizeBlob(targetRaw);
  if (!targetNorm) {
    const err = new Error('service does not hold a Claude credential');
    err.code = 'INVALID';
    throw err;
  }

  const activeRaw = await readKeychainService(ACTIVE_SERVICE);
  const activeNorm = normalizeBlob(activeRaw);

  // Re-stash the currently-active account BEFORE overwriting it, every
  // switch (not just first run) — `claude` refreshes the active token in
  // place, so a previously-stashed copy can be stale.
  if (activeNorm && activeRaw) {
    const serviceNames = (await discoverServiceNames()).filter(
      (s) => s !== ACTIVE_SERVICE && s !== targetService
    );
    let matchedStash = null;
    for (const s of serviceNames) {
      const raw = await readKeychainService(s);
      const norm = normalizeBlob(raw);
      if (norm && norm.accessToken === activeNorm.accessToken) {
        matchedStash = s;
        break;
      }
    }
    const stashName = matchedStash || stashServiceName(activeNorm.accessToken);
    await writeKeychainService(stashName, activeRaw);
  }

  // Activate the target.
  await writeKeychainService(ACTIVE_SERVICE, targetRaw);

  // Mirror to disk, mode 600.
  await writeSecretFile(CREDS_PATH, targetRaw);

  // Invalidate cache so the next /api/accounts poll reflects reality.
  accountCache.clear();

  return { ok: true, activeService: targetService };
}

async function importAccount(jsonText, label) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const err = new Error('invalid JSON');
    err.code = 'INVALID';
    throw err;
  }

  // Accept either the full { claudeAiOauth: {...} } wrapper or the bare
  // inner object — store consistently in the wrapper shape.
  let toStore;
  if (parsed && parsed.claudeAiOauth) {
    toStore = parsed;
  } else if (parsed && parsed.accessToken) {
    toStore = { claudeAiOauth: parsed };
  } else {
    toStore = parsed; // may still normalize (e.g. flat access_token shape)
  }

  const raw = JSON.stringify(toStore);
  const norm = normalizeBlob(raw);
  if (!norm) {
    const err = new Error('does not look like a claudeAiOauth credential blob');
    err.code = 'INVALID';
    throw err;
  }

  const service = stashServiceName(norm.accessToken);
  await writeKeychainService(service, raw);

  if (label) {
    const registry = await loadAccountsRegistry();
    registry[service] = { label };
    await writeSecretFile(ACCOUNTS_REGISTRY_PATH, JSON.stringify(registry, null, 2));
  }

  const info = await getAccountInfoCached(service, norm.accessToken);
  return {
    service,
    isActive: false,
    email: label || info.email || null,
    plan: info.plan || null,
    status: info.status,
    usage: info.status === 'ok' ? info.usage : undefined,
    error: info.status === 'error' ? info.error : undefined,
  };
}

async function registerLabel(service, label) {
  if (!label) return;
  const registry = await loadAccountsRegistry();
  if (registry[service]?.label === label) return;
  registry[service] = { ...(registry[service] || {}), label };
  await writeSecretFile(ACCOUNTS_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

// Guarantee the currently-active account survives an upcoming `claude /login`
// (which will overwrite the active Keychain slot). If it's already stashed
// under some named service, leave it. Otherwise stash it now.
async function protectActiveAccount() {
  const activeRaw = await readKeychainService(ACTIVE_SERVICE);
  const activeNorm = normalizeBlob(activeRaw);
  if (!activeNorm || !activeRaw) return null; // nothing active to protect

  const serviceNames = (await discoverServiceNames()).filter((s) => s !== ACTIVE_SERVICE);
  for (const s of serviceNames) {
    const raw = await readKeychainService(s);
    const norm = normalizeBlob(raw);
    if (norm && norm.accessToken === activeNorm.accessToken) {
      return { service: s, alreadyStashed: true };
    }
  }

  const stashName = stashServiceName(activeNorm.accessToken);
  await writeKeychainService(stashName, activeRaw);

  // Best-effort label so the stash shows a real email once listed.
  try {
    const info = await getAccountInfoCached(stashName, activeNorm.accessToken);
    if (info.status === 'ok' && info.email) await registerLabel(stashName, info.email);
  } catch {
    // Non-fatal — the stash still exists, just unlabeled for now.
  }

  return { service: stashName, alreadyStashed: false };
}

// Reads whatever account `claude /login` just made active, stashes it under
// a named service (unless already registered), and returns it. Idempotent
// by email — calling twice for the same account doesn't create dupes.
async function saveCurrentAccount() {
  const activeRaw = await readKeychainService(ACTIVE_SERVICE);
  const activeNorm = normalizeBlob(activeRaw);
  if (!activeNorm || !activeRaw) {
    const err = new Error('no active credentials found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const info = await fetchProfileAndUsage(activeNorm.accessToken);
  if (info.status !== 'ok') {
    const err = new Error(`could not fetch profile for active account (${info.status}${info.error ? ': ' + info.error : ''})`);
    err.code = 'INVALID';
    throw err;
  }
  const email = info.email;

  const registry = await loadAccountsRegistry();

  // Already registered under this email? Return the existing stash — no dupe.
  for (const [service, meta] of Object.entries(registry)) {
    if (meta && meta.label === email) {
      accountCache.clear();
      return { service, email, plan: info.plan || null };
    }
  }

  // Token already stashed (e.g. by protectActiveAccount) but unlabeled/mislabeled?
  const serviceNames = (await discoverServiceNames()).filter((s) => s !== ACTIVE_SERVICE);
  for (const s of serviceNames) {
    const raw = await readKeychainService(s);
    const norm = normalizeBlob(raw);
    if (norm && norm.accessToken === activeNorm.accessToken) {
      await registerLabel(s, email);
      accountCache.clear();
      return { service: s, email, plan: info.plan || null };
    }
  }

  // New account — stash and register it.
  const service = stashServiceName(activeNorm.accessToken);
  await writeKeychainService(service, activeRaw);
  await registerLabel(service, email);

  accountCache.clear();
  return { service, email, plan: info.plan || null };
}

async function removeAccount(service) {
  if (!service || typeof service !== 'string') {
    const err = new Error('service is required');
    err.code = 'INVALID';
    throw err;
  }
  if (service === ACTIVE_SERVICE) {
    const err = new Error('cannot remove the active credentials slot');
    err.code = 'INVALID';
    throw err;
  }

  const registry = await loadAccountsRegistry();
  const hadEntry = !!registry[service];
  if (hadEntry) {
    delete registry[service];
    await writeSecretFile(ACCOUNTS_REGISTRY_PATH, JSON.stringify(registry, null, 2));
  }

  try {
    await execFileP('security', ['delete-generic-password', '-s', service]);
  } catch {
    // Not present in Keychain (already gone, or registry-only entry) — fine.
  }

  accountCache.clear();
  return { ok: true, removed: service, hadRegistryEntry: hadEntry };
}

// ---------- Codex (ChatGPT) account provider ----------
//
// SECRETS: never log id_token / access_token / refresh_token or their decoded
// JWT claims. PII claims (chatgpt_user_id, user_id, emails) are never logged and
// never sent to the browser. Only plan label, org title, an account-id HASH,
// status and (best-effort) usage leave this module.

// Decode the middle (payload) segment of a JWT. base64url -> JSON. Returns the
// claims object, or null if the token is malformed. Never logs the contents.
function decodeJwtClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(
      parts[1].replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Map ChatGPT's plan slug to a human label.
function codexPlanLabel(planType) {
  if (!planType) return null;
  const map = {
    free: 'Free',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
  };
  const k = String(planType).toLowerCase();
  if (map[k]) return map[k];
  // Fallback: title-case whatever slug we got.
  return k.charAt(0).toUpperCase() + k.slice(1);
}

async function readFileSafe(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

// Parse a raw auth.json string into the Codex blob shape. Returns the parsed
// object (with a valid tokens sub-object) or null. Accepts either the on-disk
// shape { auth_mode, OPENAI_API_KEY, tokens:{...}, last_refresh } or a bare
// tokens object.
function parseCodexBlob(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  // Bare tokens object?
  if (!parsed.tokens && (parsed.access_token || parsed.id_token || parsed.refresh_token)) {
    parsed = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: parsed, last_refresh: null };
  }
  const t = parsed.tokens;
  if (!t || typeof t !== 'object') return null;
  if (!t.access_token && !t.id_token) return null;
  return parsed;
}

// Stable 8-hex id for a Codex account, derived from its account_id (which is
// stable across token refreshes, unlike the access token). Used as the stash
// filename and the account's public `id`.
function codexStableId(parsed) {
  const accountId =
    parsed?.tokens?.account_id ||
    // Fall back to a claim if account_id is somehow absent.
    decodeJwtClaims(parsed?.tokens?.id_token || parsed?.tokens?.access_token)?.[
      'https://api.openai.com/auth'
    ]?.chatgpt_account_id ||
    '';
  return crypto.createHash('sha256').update(String(accountId)).digest('hex').slice(0, 8);
}

// A non-reversible hash of the account_id — safe to send to the browser as a
// stable identifier without leaking the real id.
function codexAccountIdHash(parsed) {
  const accountId = parsed?.tokens?.account_id || '';
  return crypto.createHash('sha256').update(String(accountId)).digest('hex').slice(0, 12);
}

// Derive account info purely from the JWT claims (the JWT *is* the profile for
// Codex — plan/org/subscription all live in claims). No network call.
//   status: 'ok'           access token present and not expired
//           'needs_refresh' access token expired (or about to be)
//           'error'         no decodable token
function codexDeriveInfo(parsed) {
  const accessClaims = decodeJwtClaims(parsed?.tokens?.access_token);
  const idClaims = decodeJwtClaims(parsed?.tokens?.id_token);
  if (!accessClaims && !idClaims) return { status: 'error', error: 'undecodable token' };

  // Prefer the id_token for org/subscription (richer), either for plan.
  const AUTH = 'https://api.openai.com/auth';
  const accessAuth = (accessClaims && accessClaims[AUTH]) || {};
  const idAuth = (idClaims && idClaims[AUTH]) || {};

  const planType = idAuth.chatgpt_plan_type || accessAuth.chatgpt_plan_type || null;
  const orgs = Array.isArray(idAuth.organizations) ? idAuth.organizations : [];
  const defaultOrg = orgs.find((o) => o && o.is_default) || orgs[0] || null;
  const orgTitle = defaultOrg?.title || null;
  const subscriptionUntil = idAuth.chatgpt_subscription_active_until || null;

  // Expiry is on the access token's standard `exp` (unix seconds). If we only
  // have an id_token, use its exp.
  const exp = (accessClaims && accessClaims.exp) || (idClaims && idClaims.exp) || null;
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = exp ? exp <= nowSec + 60 : false; // 60s skew, mirror Claude

  return {
    status: expired ? 'needs_refresh' : 'ok',
    plan: codexPlanLabel(planType),
    planType: planType || null,
    orgTitle,
    subscriptionUntil,
    accountIdHash: codexAccountIdHash(parsed),
    exp,
    expired,
  };
}

// Build the display label: prefer a user-set registry label, else plan + org,
// else a generic fallback. Never includes PII.
function codexLabel(info, registryLabel) {
  if (registryLabel) return registryLabel;
  const bits = [];
  if (info.plan) bits.push(info.plan);
  if (info.orgTitle) bits.push(info.orgTitle);
  if (bits.length) return bits.join(' · ') + ' (ChatGPT)';
  return 'ChatGPT account';
}

async function loadCodexRegistry() {
  try {
    const raw = await fsp.readFile(CODEX_REGISTRY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeCodexRegistry(registry) {
  await writeSecretFile(CODEX_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

// Persist a (possibly refreshed) Codex blob back to its source file, 0600.
async function persistCodexBlob(targetPath, parsed) {
  await writeSecretFile(targetPath, JSON.stringify(parsed, null, 2));
}

// Use the stored refresh token to mint a fresh token trio and persist the
// rotated tokens back to `targetPath`. Refresh tokens are SINGLE-USE — if we
// don't save the new one the account bricks. Mirrors Claude's refreshServiceToken.
// Returns the updated parsed blob, or null if refresh is impossible/failed.
// Never logs tokens.
async function refreshCodexToken(parsed, targetPath) {
  const refreshToken = parsed?.tokens?.refresh_token;
  if (!refreshToken) return null;

  let resp;
  try {
    resp = await fetch(CODEX_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH.clientId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null; // network error / timeout
  }
  if (!resp.ok) {
    // e.g. invalid_grant -> refresh token truly dead; leave the blob as-is.
    console.log(`[codex refresh] ${codexStableId(parsed)}: refresh grant failed ${resp.status}`);
    return null;
  }
  let tok;
  try { tok = await resp.json(); } catch { return null; }
  if (!tok.access_token && !tok.id_token) return null;

  const updated = {
    ...parsed,
    tokens: {
      ...parsed.tokens,
      id_token: tok.id_token || parsed.tokens.id_token,
      access_token: tok.access_token || parsed.tokens.access_token,
      refresh_token: tok.refresh_token || parsed.tokens.refresh_token,
    },
    last_refresh: new Date().toISOString(),
  };

  try {
    await persistCodexBlob(targetPath, updated);
  } catch {
    console.log(`[codex refresh] ${codexStableId(parsed)}: write-back failed`);
    return null;
  }
  console.log(`[codex refresh] ${codexStableId(parsed)}: token refreshed`);
  return updated;
}

// BEST-EFFORT Codex/ChatGPT usage fetch. This is UNCONFIRMED against a live,
// non-expired account — Mark's current token is expired (403s), so this path is
// not exercised in practice yet and MUST degrade gracefully.
//
// What was tried / documented for later validation:
//   Endpoint attempted: GET https://chatgpt.com/backend-api/codex/usage
//   Headers:            authorization: Bearer <access_token>
//                       chatgpt-account-id: <account_id>
//                       user-agent: <browser-ish UA>
//   Also read rate-limit hints from response headers (x-ratelimit-*).
// Real shape: UNCONFIRMED. On any non-2xx / parse failure / timeout we return
// { usage: null, usageError } and NEVER invent usage numbers. When a live
// account is connected, verify the true endpoint + JSON shape and map it into
// Claude's usage shape (usage.limits[] = {kind,label,percent,severity,resets_at}).
async function fetchCodexUsage(accessToken, accountId) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;

  let res;
  try {
    res = await fetch('https://chatgpt.com/backend-api/codex/usage', {
      headers,
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    return { usage: null, usageError: 'network' };
  }
  if (!res.ok) {
    return { usage: null, usageError: String(res.status) };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { usage: null, usageError: 'parse' };
  }

  // We got a 2xx JSON body but the shape is UNCONFIRMED. Try a defensive map
  // into Claude's usage shape; if we can't recognise it, degrade to plan-only
  // rather than invent numbers.
  try {
    const limits = [];
    // Heuristic candidates — adjust once the real shape is known.
    const buckets = [
      { src: body.primary || body.five_hour || body.session, kind: 'session', label: 'Current session (5h)' },
      { src: body.secondary || body.weekly || body.seven_day, kind: 'weekly_all', label: 'Weekly' },
    ];
    for (const b of buckets) {
      if (!b.src || typeof b.src !== 'object') continue;
      const used = b.src.used_percent ?? b.src.percent ?? null;
      if (used == null) continue;
      const percent = Math.max(0, Math.min(100, Number(used)));
      limits.push({
        kind: b.kind,
        label: b.label,
        percent,
        severity: percent >= 100 ? 'critical' : percent >= 80 ? 'warning' : 'ok',
        resets_at: b.src.resets_at || b.src.reset_at || null,
      });
    }
    if (limits.length) return { usage: { limits }, usageError: null };
    return { usage: null, usageError: 'unrecognized_shape' };
  } catch {
    return { usage: null, usageError: 'unrecognized_shape' };
  }
}

// Discover every Codex account: the active ~/.codex/auth.json (if present +
// parseable) plus every ~/.codex/accounts/<id>.json stash. Never throws if
// ~/.codex is absent. Dedupes a stash that duplicates the active account.
async function discoverCodexAccounts() {
  const found = [];
  const activeParsed = parseCodexBlob(await readFileSafe(CODEX_AUTH_PATH));
  let activeId = null;
  if (activeParsed) {
    activeId = codexStableId(activeParsed);
    found.push({ id: activeId, path: CODEX_AUTH_PATH, isActive: true, parsed: activeParsed });
  }

  let files = [];
  try {
    files = await fsp.readdir(CODEX_ACCOUNTS_DIR);
  } catch {
    files = [];
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace(/\.json$/, '');
    if (activeId && id === activeId) continue; // stash duplicates active -> hide
    const parsed = parseCodexBlob(await readFileSafe(path.join(CODEX_ACCOUNTS_DIR, f)));
    if (!parsed) continue;
    found.push({ id, path: path.join(CODEX_ACCOUNTS_DIR, f), isActive: false, parsed });
  }
  return found;
}

// Build the Codex slice of the unified accounts list. Each entry mirrors the
// Claude shape but carries provider:'codex'. NEVER includes tokens. Returns []
// (never throws) when ~/.codex is absent or has no parseable accounts.
async function buildCodexAccountsList() {
  let found;
  try {
    found = await discoverCodexAccounts();
  } catch {
    return [];
  }
  if (!found.length) return [];

  const registry = await loadCodexRegistry();

  return Promise.all(
    found.map(async ({ id, path: filePath, isActive, parsed }) => {
      let blob = parsed;
      let info = codexDeriveInfo(blob);

      // Proactive refresh: if the access token is expired, mint a fresh one from
      // the refresh token and persist the rotated tokens back to this file.
      if (info.expired && blob?.tokens?.refresh_token) {
        const refreshed = await refreshCodexToken(blob, filePath);
        if (refreshed) {
          blob = refreshed;
          info = codexDeriveInfo(blob);
        }
      }

      let usage = null;
      let usageError = null;
      if (info.status === 'ok') {
        const u = await fetchCodexUsage(blob.tokens.access_token, blob.tokens.account_id);
        usage = u.usage;
        usageError = u.usageError;
      } else {
        usageError = info.status === 'needs_refresh' ? 'token_expired' : (info.error || 'token_error');
      }

      const label = codexLabel(info, registry[id]?.label);
      return {
        provider: 'codex',
        id,
        service: id,        // parallel to Claude's `service` for UI compatibility
        label,
        email: null,        // Codex has no email in claims
        plan: info.plan || null,
        isActive,
        status: info.status,
        usage,
        usageError,
        orgTitle: info.orgTitle || null,
        accountIdHash: info.accountIdHash || null,
        subscriptionUntil: info.subscriptionUntil || null,
      };
    })
  );
}

// Set a Codex account active: back up the CURRENT ~/.codex/auth.json into a
// stash file first (so it is never lost), then write the chosen blob to
// ~/.codex/auth.json (0600, temp+rename). Mirrors Claude's activate safety.
async function activateCodexAccount(targetId) {
  if (!targetId || typeof targetId !== 'string') {
    const err = new Error('id is required'); err.code = 'INVALID'; throw err;
  }
  const stashPath = path.join(CODEX_ACCOUNTS_DIR, `${targetId}.json`);
  const targetParsed = parseCodexBlob(await readFileSafe(stashPath));
  if (!targetParsed) {
    const err = new Error('codex account not found'); err.code = 'NOT_FOUND'; throw err;
  }

  // Back up the current active account into a stash before overwriting it.
  const activeParsed = parseCodexBlob(await readFileSafe(CODEX_AUTH_PATH));
  if (activeParsed) {
    const activeId = codexStableId(activeParsed);
    if (activeId !== targetId) {
      await fsp.mkdir(CODEX_ACCOUNTS_DIR, { recursive: true });
      await persistCodexBlob(path.join(CODEX_ACCOUNTS_DIR, `${activeId}.json`), activeParsed);
    }
  }

  // Promote the chosen account to the live slot.
  await persistCodexBlob(CODEX_AUTH_PATH, targetParsed);
  return { ok: true, provider: 'codex', activeId: targetId };
}

// Remove a stashed Codex account (delete its stash file + registry entry).
// NEVER removes the live ~/.codex/auth.json active slot.
async function removeCodexAccount(id) {
  if (!id || typeof id !== 'string') {
    const err = new Error('id is required'); err.code = 'INVALID'; throw err;
  }
  // If this id is the currently-active Codex account, removing it means
  // DISCONNECT: back up ~/.codex/auth.json (so it's recoverable), then delete
  // the live slot. Unlike Claude's active Keychain slot (the live CLI cred we
  // protect), a Codex disconnect is a legitimate management action.
  const activeParsed = parseCodexBlob(await readFileSafe(CODEX_AUTH_PATH));
  if (activeParsed && codexStableId(activeParsed) === id) {
    try {
      const raw = await readFileSafe(CODEX_AUTH_PATH);
      if (raw) {
        await fsp.mkdir(CODEX_ACCOUNTS_DIR, { recursive: true });
        await writeSecretFile(path.join(CODEX_ACCOUNTS_DIR, `removed-${id}.json`), raw);
      }
    } catch { /* backup best-effort */ }
    await fsp.unlink(CODEX_AUTH_PATH).catch(() => {});
    const registry = await loadCodexRegistry();
    if (registry[id]) { delete registry[id]; await writeCodexRegistry(registry); }
    return { removed: id, disconnected: true };
  }

  const registry = await loadCodexRegistry();
  const hadEntry = !!registry[id];
  if (hadEntry) {
    delete registry[id];
    await writeCodexRegistry(registry);
  }

  let removedFile = false;
  try {
    await fsp.unlink(path.join(CODEX_ACCOUNTS_DIR, `${id}.json`));
    removedFile = true;
  } catch {
    // already gone / registry-only entry — fine
  }

  return { ok: true, provider: 'codex', removed: id, removedFile, hadRegistryEntry: hadEntry };
}

// Codex "add account" (import/stash only — NO browser OAuth login flow yet).
// Two modes:
//   { importActive: true, label? } — stash a copy of the current ~/.codex/auth.json
//   { json: <auth.json string|object>, label? } — stash a pasted blob
// Writes a stash file under ~/.codex/accounts/<id>.json (0600) and, if a label
// is given, records it in the Codex registry. Never overwrites the live slot.
async function importCodexAccount({ json, importActive, label }) {
  let parsed;
  if (importActive) {
    parsed = parseCodexBlob(await readFileSafe(CODEX_AUTH_PATH));
    if (!parsed) {
      const err = new Error('no active codex account to import'); err.code = 'NOT_FOUND'; throw err;
    }
  } else {
    if (!json) {
      const err = new Error('json or importActive is required'); err.code = 'INVALID'; throw err;
    }
    parsed = parseCodexBlob(json);
    if (!parsed) {
      const err = new Error('does not look like a codex auth.json blob'); err.code = 'INVALID'; throw err;
    }
  }

  const id = codexStableId(parsed);
  await fsp.mkdir(CODEX_ACCOUNTS_DIR, { recursive: true });
  await persistCodexBlob(path.join(CODEX_ACCOUNTS_DIR, `${id}.json`), parsed);

  if (label) {
    const registry = await loadCodexRegistry();
    registry[id] = { label };
    await writeCodexRegistry(registry);
  }

  const info = codexDeriveInfo(parsed);
  return {
    provider: 'codex',
    id,
    service: id,
    label: codexLabel(info, label),
    email: null,
    plan: info.plan || null,
    isActive: false,
    status: info.status,
    orgTitle: info.orgTitle || null,
    accountIdHash: info.accountIdHash || null,
    subscriptionUntil: info.subscriptionUntil || null,
  };
}

// ---------- Codex (ChatGPT) browser OAuth login (in-app "Add account") ----------
//
// A real authorization-code + PKCE loopback flow that mirrors Claude's, so ANY
// user can add their ChatGPT/Codex account from the browser. The Codex OAuth
// client registers a FIXED loopback redirect (http://localhost:1455/auth/callback,
// fallback :1457) — NOT this server's 8934 port — so we spin up a short-lived
// listener on that exact port, handle the one callback, then close it.
//
// SECRETS: never log id_token / access_token / refresh_token or decoded PII
// claims. Only status, a plan label, and an account-id HASH ever leave here.

// Single-flight in-memory login state. Holds secrets (code_verifier, state) and
// the live loopback server handle — never logged, never persisted to disk.
let pendingCodexLogin = null; // { code_verifier, state, port, server, createdAt, status, label, error, timer }

// Tear down any in-flight Codex login: close its loopback listener + clear timer.
// Safe to call repeatedly.
function endCodexLoopback() {
  if (!pendingCodexLogin) return;
  if (pendingCodexLogin.timer) { try { clearTimeout(pendingCodexLogin.timer); } catch {} }
  const srv = pendingCodexLogin.server;
  if (srv) { try { srv.close(); } catch {} }
  pendingCodexLogin.server = null;
}

// Build the OpenAI authorize URL. Param order + values mirror the Codex CLI
// (build_authorize_url in server.rs) exactly. encodeURIComponent renders spaces
// in `scope` as %20, which the auth server accepts.
function buildCodexAuthorizeUrl({ challenge, state, port }) {
  const redirectUri = `http://localhost:${port}${CODEX_OAUTH.callbackPath}`;
  const pairs = [
    ['response_type', 'code'],
    ['client_id', CODEX_OAUTH.clientId],
    ['redirect_uri', redirectUri],
    ['scope', CODEX_OAUTH.scope],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['id_token_add_organizations', 'true'],
    ['codex_cli_simplified_flow', 'true'],
    ['state', state],
    ['originator', CODEX_OAUTH.originator],
  ];
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${CODEX_OAUTH.authorizeUrl}?${qs}`;
}

// Exchange the authorization code for tokens. Codex uses form-encoded ONLY (no
// JSON fallback) and does NOT send `state` in the body. Response JSON carries
// { id_token, access_token, refresh_token }. Never logs tokens.
async function exchangeCodexCodeForTokens(code, verifier, port) {
  const redirectUri = `http://localhost:${port}${CODEX_OAUTH.callbackPath}`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CODEX_OAUTH.clientId,
    code_verifier: verifier,
  }).toString();

  let res;
  try {
    res = await fetch(CODEX_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`codex token exchange transport error: ${e.message}`);
  }
  if (!res.ok) {
    // Error body is OAuth error JSON (e.g. invalid_grant), not a secret.
    const errBody = await res.text().catch(() => '');
    console.log(`[codex login] token exchange failed ${res.status}: ${errBody.slice(0, 300)}`);
    const err = new Error(`codex token exchange failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Pull the chatgpt_account_id claim out of an id_token (lives under OpenAI's
// auth-claims namespace). Mirrors the CLI's persist logic. Returns null if absent.
function codexAccountIdFromIdToken(idToken) {
  const claims = decodeJwtClaims(idToken);
  const auth = claims && claims[CODEX_AUTH_CLAIM];
  const id = auth && auth.chatgpt_account_id;
  return typeof id === 'string' && id ? id : null;
}

// Given a raw token response, build the on-disk ~/.codex/auth.json blob shape and
// stash it as a Codex account. Does NOT clobber a live active account: if the user
// already has a ~/.codex/auth.json we stash the new one under ~/.codex/accounts/
// (inactive); only if they have NO active account do we make this the live slot.
// Derives label/plan from the JWT. Never logs tokens. Returns { id, label, isActive }.
async function completeCodexLoginFromTokens(tokenResp) {
  const idToken = tokenResp.id_token || null;
  const accessToken = tokenResp.access_token || null;
  const refreshToken = tokenResp.refresh_token || null;
  if (!idToken && !accessToken) throw new Error('codex token response missing tokens');

  const accountId = codexAccountIdFromIdToken(idToken);
  const parsed = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };

  // Sanity-check the blob normalizes + decodes before persisting.
  const norm = parseCodexBlob(parsed);
  if (!norm) throw new Error('constructed codex blob failed validation');
  const info = codexDeriveInfo(norm);
  const id = codexStableId(norm);
  const label = codexLabel(info, null);

  await fsp.mkdir(CODEX_DIR, { recursive: true });

  // Is there already a live active account? If NOT, make this one active.
  const existingActive = parseCodexBlob(await readFileSafe(CODEX_AUTH_PATH));
  if (!existingActive) {
    await persistCodexBlob(CODEX_AUTH_PATH, norm);
    return { id, label, isActive: true };
  }

  // Active account exists — stash the new one (inactive), never clobbering it.
  // If this account is ALREADY the active one (re-login of same account), just
  // refresh the live slot in place rather than creating a redundant stash.
  if (codexStableId(existingActive) === id) {
    await persistCodexBlob(CODEX_AUTH_PATH, norm);
    return { id, label, isActive: true };
  }
  await fsp.mkdir(CODEX_ACCOUNTS_DIR, { recursive: true });
  await persistCodexBlob(path.join(CODEX_ACCOUNTS_DIR, `${id}.json`), norm);
  return { id, label, isActive: false };
}

// Handle the single OAuth callback hitting the loopback listener. Validates
// state, exchanges the code, stashes the account, and writes the browser page.
// Mutates pendingCodexLogin.status. Always ends the loopback afterward.
async function handleCodexCallback(reqUrl, res) {
  const p = pendingCodexLogin;
  const code = reqUrl.searchParams.get('code');
  const state = reqUrl.searchParams.get('state');
  const oauthError = reqUrl.searchParams.get('error');
  const errorDesc = reqUrl.searchParams.get('error_description');

  const respond = (statusCode, message, ok) => {
    res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
    res.end(callbackPage(message, ok));
  };

  if (oauthError) {
    if (p) { p.status = 'error'; p.error = errorDesc || oauthError; }
    respond(400, `Login failed: ${escapeHtmlServer(errorDesc || oauthError)}`, false);
    endCodexLoopback();
    return;
  }
  if (!p || !state || state !== p.state) {
    respond(400, 'Login state mismatch. Please retry from the dashboard.', false);
    return; // don't tear down a valid pending login on a stray/foreign hit
  }
  if (!code) {
    p.status = 'error'; p.error = 'no authorization code';
    respond(400, 'No authorization code received.', false);
    endCodexLoopback();
    return;
  }

  try {
    const tokenResp = await exchangeCodexCodeForTokens(code, p.code_verifier, p.port);
    const { label, isActive } = await completeCodexLoginFromTokens(tokenResp);
    p.status = 'done';
    p.label = label || null;
    respond(200, `Signed in to ${escapeHtmlServer(label || 'your ChatGPT account')}${isActive ? '' : ' (added)'}. You can close this tab.`, true);
  } catch (e) {
    console.log(`[codex callback] failed: ${e.status || ''} ${e.message}`);
    p.status = 'error'; p.error = e.message;
    respond(500, 'Could not complete sign-in. Please retry from the dashboard.', false);
  } finally {
    endCodexLoopback();
  }
}

// Start the short-lived loopback listener on the Codex redirect port. Tries the
// fixed port 1455, then the registered fallback 1457 (mirrors the CLI's
// bind_server). Resolves { server, port }; rejects if neither port binds.
function startCodexLoopback() {
  return new Promise((resolve, reject) => {
    const tryPort = (port, isLast) => {
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url, `http://localhost:${port}`);
          if (req.method === 'GET' && reqUrl.pathname === CODEX_OAUTH.callbackPath) {
            await handleCodexCallback(reqUrl, res);
            return;
          }
          res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' });
          res.end('not found');
        } catch (e) {
          try {
            res.writeHead(500, { 'Content-Type': 'text/plain', Connection: 'close' });
            res.end('error');
          } catch {}
        }
      });
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && !isLast) {
          tryPort(CODEX_OAUTH.fallbackPort, true);
        } else {
          reject(err);
        }
      });
      // Bind to 127.0.0.1 exactly like the CLI; localhost resolves here.
      server.listen(port, '127.0.0.1', () => resolve({ server, port }));
    };
    tryPort(CODEX_OAUTH.loopbackPort, false);
  });
}

// ---------- Automations / MCP / Skills (read + control surfaces) ----------
//
// Three additional local surfaces. All READ paths are safe. The MUTATING
// automation paths (run / toggle) validate the target id against the live list
// first, back up the crontab before any edit, and only ever touch the exact
// matched line. NEVER return secrets — MCP env/args/headers are hard-excluded.

const CRON_BACKUP_DIR = path.join(HOME, '.claude', 'crontab-backups');
const LAUNCHD_LABEL_RX = /aimakers|nora|upwork|veo|claudesessions|x-growth|seo/i;
const UID = typeof process.getuid === 'function' ? process.getuid() : 501;
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n) { return String(n).padStart(2, '0'); }

// Expand one 5-field-cron field ("*", "1,2", "1-5", "*/5", "1-10/2", "5/10")
// into the sorted list of allowed integers within [min,max].
function expandCronField(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    let m;
    if (part === '*') { for (let v = min; v <= max; v++) out.add(v); }
    else if ((m = part.match(/^\*\/(\d+)$/))) { const s = +m[1]; if (s > 0) for (let v = min; v <= max; v += s) out.add(v); }
    else if ((m = part.match(/^(\d+)-(\d+)\/(\d+)$/))) { const a = +m[1], b = +m[2], s = +m[3]; if (s > 0) for (let v = a; v <= b; v += s) out.add(v); }
    else if ((m = part.match(/^(\d+)-(\d+)$/))) { const a = +m[1], b = +m[2]; for (let v = a; v <= b; v++) out.add(v); }
    else if ((m = part.match(/^(\d+)\/(\d+)$/))) { const a = +m[1], s = +m[2]; if (s > 0) for (let v = a; v <= max; v += s) out.add(v); }
    else if (/^\d+$/.test(part)) { out.add(+part); }
  }
  return [...out].filter((v) => v >= min && v <= max);
}

// Build allowed-value Sets from the 5 cron fields, plus dom/dow "restricted"
// flags (standard cron: if BOTH dom and dow are restricted, a day matches if
// EITHER matches; if only one is restricted, only that one gates the day).
function cronSets(min, hour, dom, mon, dow) {
  let dows = new Set(expandCronField(dow, 0, 7).map((v) => (v === 7 ? 0 : v)));
  return {
    minutes: new Set(expandCronField(min, 0, 59)),
    hours: new Set(expandCronField(hour, 0, 23)),
    doms: new Set(expandCronField(dom, 1, 31)),
    months: new Set(expandCronField(mon, 1, 12)),
    dows,
    domR: String(dom).trim() !== '*',
    dowR: String(dow).trim() !== '*',
  };
}

// Next fire time (ISO string, local) for a matcher-set, stepping minute by
// minute from `fromMs`. Bounded to 366 days so an impossible spec can't loop
// forever. Daily/weekly jobs resolve in a few thousand iterations.
function nextFireFromSets(sets, fromMs) {
  if (!sets || !sets.minutes.size || !sets.hours.size || !sets.months.size) return null;
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limitMs = fromMs + 366 * 24 * 3600 * 1000;
  while (d.getTime() <= limitMs) {
    const mo = d.getMonth() + 1, dom = d.getDate(), dow = d.getDay(), h = d.getHours(), mi = d.getMinutes();
    if (sets.months.has(mo)) {
      let dayOk;
      if (sets.domR && sets.dowR) dayOk = sets.doms.has(dom) || sets.dows.has(dow);
      else if (sets.domR) dayOk = sets.doms.has(dom);
      else if (sets.dowR) dayOk = sets.dows.has(dow);
      else dayOk = true;
      if (dayOk && sets.hours.has(h) && sets.minutes.has(mi)) return d.toISOString();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// Readable summary of a 5-field cron expression (falls back to the raw expr).
function humanCron(min, hour, dom, mon, dow) {
  const raw = `${min} ${hour} ${dom} ${mon} ${dow}`;
  const single = (f) => /^\d+$/.test(f);
  let m;
  if ((m = String(min).match(/^\*\/(\d+)$/)) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${m[1]} min`;
  if (min === '*' && hour === '*') return 'every minute';
  if (single(min) && single(hour)) {
    const t = `${pad2(+hour)}:${pad2(+min)}`;
    if (dom === '*' && mon === '*' && dow === '*') return `daily ${t}`;
    if (dom === '*' && mon === '*' && single(dow)) return `weekly ${DOW_NAMES[(+dow) % 7]} ${t}`;
    if (single(dom) && mon === '*' && dow === '*') return `monthly day ${dom} ${t}`;
    return `${t} (${raw})`;
  }
  return raw;
}

// Parse a single crontab command line into its 5 fields + command, or null if
// it isn't a schedule line (env assignment, prose comment, blank, etc.).
function parseCronLine(line) {
  const m = line.match(/^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
  if (!m) return null;
  const [, min, hour, dom, mon, dow, command] = m;
  const fieldRx = /^[\d*,\-/]+$/; // numeric cron fields only (no month/day names)
  if (![min, hour, dom, mon, dow].every((f) => fieldRx.test(f))) return null;
  return { min, hour, dom, mon, dow, command: command.trim() };
}

// Capture a `>> /path/log` (or `> /path/log`) redirect target from a command.
function extractLogPath(command) {
  const m = command.match(/>>?\s*("([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return null;
  const p = m[2] || m[3] || m[4];
  if (!p || p === '/dev/null') return null;
  return p;
}

// Basename-ish target from a shell command: prefer the first script-looking
// argument, else the leading token's basename.
function commandTarget(command) {
  const scriptM = command.match(/(\S+\.(?:sh|mjs|js|py|ts|rb|pl))\b/);
  if (scriptM) return path.basename(scriptM[1]);
  const first = command.trim().split(/\s+/)[0] || '';
  return path.basename(first) || first;
}

// Build the crontab slice of the automations list. Handles disabled
// (commented-out) schedule lines and prose "# name" annotations. Never throws.
async function buildCronAutomations() {
  let raw;
  try { const r = await execP('crontab -l 2>/dev/null'); raw = r.stdout; }
  catch { return []; }
  if (!raw || !raw.trim()) return [];

  const lines = raw.split('\n');
  const out = [];
  let pendingComment = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let enabled = true;
    let toParse = line;

    if (/^\s*#/.test(line)) {
      const inner = line.replace(/^\s*#+\s?/, '');
      if (parseCronLine(inner)) { toParse = inner; enabled = false; } // disabled schedule
      else { pendingComment = inner.trim() || pendingComment; continue; } // prose name
    }

    const parsed = parseCronLine(toParse);
    if (!parsed) continue;
    const { min, hour, dom, mon, dow, command } = parsed;

    const name = pendingComment || commandTarget(command);
    pendingComment = null;

    const logPath = extractLogPath(command);
    let lastRun = null;
    if (logPath) { try { const st = await fsp.stat(logPath); lastRun = new Date(st.mtimeMs).toISOString(); } catch {} }

    const scheduleStr = `${min} ${hour} ${dom} ${mon} ${dow}`;
    const id = 'cron:' + crypto.createHash('sha1').update(scheduleStr + '|' + command).digest('hex').slice(0, 10);

    out.push({
      id,
      kind: 'cron',
      name,
      schedule: humanCron(min, hour, dom, mon, dow),
      target: commandTarget(command),
      status: 'idle',
      enabled,
      lastExit: null,
      lastRun,
      nextRun: enabled ? nextFireFromSets(cronSets(min, hour, dom, mon, dow), Date.now()) : null,
      logPath,
      command,        // user's own crontab command — used by run-now
      rawLine: line,  // exact source line — used by toggle
    });
  }
  return out;
}

// Duration seconds -> short human string (for launchd StartInterval).
function humanDuration(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) { const h = s / 3600; return `${Number.isInteger(h) ? h : h.toFixed(1)} h`; }
  const d = s / 86400; return `${Number.isInteger(d) ? d : d.toFixed(1)} d`;
}

// Matcher-set from a StartCalendarInterval object (missing key = wildcard).
function calSets(c) {
  const one = (v, min, max) => {
    if (typeof v === 'number') return new Set([v]);
    const s = new Set(); for (let i = min; i <= max; i++) s.add(i); return s;
  };
  let dows = one(c.Weekday, 0, 7); dows = new Set([...dows].map((v) => (v === 7 ? 0 : v)));
  return {
    minutes: one(c.Minute, 0, 59),
    hours: one(c.Hour, 0, 23),
    doms: one(c.Day, 1, 31),
    months: one(c.Month, 1, 12),
    dows,
    domR: typeof c.Day === 'number',
    dowR: typeof c.Weekday === 'number',
  };
}

// Best-effort target basename from a launchd plist's ProgramArguments/Program,
// skipping known interpreters so we surface the actual script.
function launchdTarget(plist) {
  const interp = new Set(['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'npx', 'env', 'claude', 'ruby', 'perl']);
  const args = Array.isArray(plist.ProgramArguments)
    ? plist.ProgramArguments
    : (plist.Program ? [plist.Program] : []);
  const paths = args.filter((a) => typeof a === 'string' && a.startsWith('/'));
  for (let i = paths.length - 1; i >= 0; i--) {
    const b = path.basename(paths[i]);
    if (!interp.has(b)) return b;
  }
  if (paths.length) return path.basename(paths[0]);
  if (args.length) return path.basename(String(args[0]));
  return null;
}

// Human schedule + nextRun from a launchd plist.
function launchdSchedule(plist) {
  if (typeof plist.StartInterval === 'number') {
    return {
      human: `every ${humanDuration(plist.StartInterval)}`,
      nextRun: new Date(Date.now() + plist.StartInterval * 1000).toISOString(),
    };
  }
  const sci = plist.StartCalendarInterval;
  if (sci) {
    const arr = Array.isArray(sci) ? sci : [sci];
    let next = null;
    const times = [];
    for (const c of arr) {
      const nf = nextFireFromSets(calSets(c), Date.now());
      if (nf && (!next || nf < next)) next = nf;
      if (typeof c.Hour === 'number') times.push(`${pad2(c.Hour)}:${pad2(typeof c.Minute === 'number' ? c.Minute : 0)}`);
    }
    let human;
    if (arr.length > 1) {
      times.sort();
      human = times.length ? `${arr.length}x/day ${times[0]}–${times[times.length - 1]}` : `${arr.length}x/day`;
    } else {
      const c = arr[0];
      const t = typeof c.Hour === 'number' ? `${pad2(c.Hour)}:${pad2(typeof c.Minute === 'number' ? c.Minute : 0)}` : null;
      if (typeof c.Weekday === 'number') human = `weekly ${DOW_NAMES[c.Weekday % 7]}${t ? ' ' + t : ''}`;
      else if (typeof c.Day === 'number') human = `monthly day ${c.Day}${t ? ' ' + t : ''}`;
      else if (t) human = `daily ${t}`;
      else human = 'calendar';
    }
    return { human, nextRun: next };
  }
  if (plist.RunAtLoad) return { human: 'at load', nextRun: null };
  return { human: '(on demand)', nextRun: null };
}

// Build the launchd (user agent) slice of the automations list. Filters to the
// user's own labels; skips transient GUI-app registrations ("application.*").
async function buildLaunchdAutomations() {
  let listOut;
  try { const r = await execP('launchctl list 2>/dev/null'); listOut = r.stdout; }
  catch { return []; }

  const out = [];
  for (const line of listOut.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const [pidStr, exitStr, label] = cols;
    if (!label || !LAUNCHD_LABEL_RX.test(label)) continue;
    if (/^application\./.test(label)) continue; // transient GUI-app registration

    const plistPath = path.join(HOME, 'Library', 'LaunchAgents', `${label}.plist`);
    let plist = null;
    try {
      const { stdout } = await execFileP('plutil', ['-convert', 'json', '-o', '-', plistPath]);
      plist = JSON.parse(stdout);
    } catch { plist = null; } // plist missing/unreadable — degrade, don't crash

    const pid = (pidStr === '-' || pidStr === '') ? null : parseInt(pidStr, 10);
    const lastExit = (exitStr === '-' || exitStr === '') ? null : parseInt(exitStr, 10);
    let status;
    if (pid != null && !Number.isNaN(pid)) status = 'running';
    else if (lastExit && lastExit !== 0) status = 'error';
    else status = 'idle';

    let schedule = '(on demand)', nextRun = null, target = label, logPath = null;
    if (plist) {
      logPath = plist.StandardOutPath || plist.StandardErrorPath || null;
      target = launchdTarget(plist) || label;
      const s = launchdSchedule(plist);
      schedule = s.human; nextRun = s.nextRun;
    }
    let lastRun = null;
    if (logPath) { try { const st = await fsp.stat(logPath); lastRun = new Date(st.mtimeMs).toISOString(); } catch {} }

    out.push({
      id: 'launchd:' + label,
      kind: 'launchd',
      name: label,
      schedule,
      target,
      status,
      enabled: true,
      lastExit,
      lastRun,
      nextRun,
      logPath,
      label,
    });
  }
  return out;
}

// Unified automations list, sorted running-first then soonest nextRun.
async function buildAutomationsList() {
  const [cron, launchd] = await Promise.all([buildCronAutomations(), buildLaunchdAutomations()]);
  const all = [...cron, ...launchd];
  all.sort((a, b) => {
    const ar = a.status === 'running' ? 0 : 1;
    const br = b.status === 'running' ? 0 : 1;
    if (ar !== br) return ar - br;
    const an = a.nextRun || '9999', bn = b.nextRun || '9999';
    return an.localeCompare(bn);
  });
  return all;
}

async function findAutomation(id) {
  if (!id || typeof id !== 'string') return null;
  const list = await buildAutomationsList();
  return list.find((a) => a.id === id) || null;
}

// Run-now. cron -> fire the command detached (don't await); launchd -> kickstart.
async function runAutomation(id) {
  const a = await findAutomation(id);
  if (!a) { const e = new Error('unknown automation id'); e.code = 'NOT_FOUND'; throw e; }
  if (a.kind === 'cron') {
    execCb(a.command, { cwd: HOME }, () => {}); // detached fire-and-forget
    return { ok: true, started: true, id, kind: 'cron' };
  }
  await execFileP('launchctl', ['kickstart', '-k', `gui/${UID}/${a.label}`]);
  return { ok: true, started: true, id, kind: 'launchd' };
}

// Read the last ~maxLines of a file without loading the whole thing.
async function tailFile(fp, maxLines = 80, maxBytes = 200_000) {
  const st = await fsp.stat(fp);
  const start = Math.max(0, st.size - maxBytes);
  const fh = await fsp.open(fp, 'r');
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
    return text.split('\n').slice(-maxLines);
  } finally {
    await fh.close();
  }
}

async function automationLogs(id) {
  const a = await findAutomation(id);
  if (!a) { const e = new Error('unknown automation id'); e.code = 'NOT_FOUND'; throw e; }
  if (!a.logPath) return { id, logPath: null, lines: [], note: 'no log path known for this automation' };
  try {
    const lines = await tailFile(a.logPath, 80);
    return { id, logPath: a.logPath, lines };
  } catch {
    return { id, logPath: a.logPath, lines: [], note: 'log not readable' };
  }
}

// Toggle a cron line: back up the full crontab first, then comment/uncomment
// ONLY the exact matched line and reinstall via `crontab <file>`.
async function toggleCron(a, enabled) {
  if (a.enabled === enabled) return { ok: true, id: a.id, kind: 'cron', enabled, note: 'already in desired state' };

  const { stdout: raw } = await execP('crontab -l 2>/dev/null');
  const lines = raw.split('\n');
  const matches = lines.filter((l) => l === a.rawLine).length;
  if (matches === 0) { const e = new Error('could not locate the crontab line to toggle'); e.code = 'NOT_FOUND'; throw e; }
  if (matches !== 1) { const e = new Error('ambiguous crontab line — refusing to edit'); e.code = 'INVALID'; throw e; }
  const idx = lines.findIndex((l) => l === a.rawLine);
  const newLine = enabled ? a.rawLine.replace(/^\s*#+\s?/, '') : '# ' + a.rawLine;

  // Back up BEFORE writing.
  await fsp.mkdir(CRON_BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(CRON_BACKUP_DIR, `${ts}.txt`);
  await writeSecretFile(backupPath, raw);

  lines[idx] = newLine;
  const tmp = path.join(os.tmpdir(), `crontab-${process.pid}-${Date.now()}.txt`);
  await fsp.writeFile(tmp, lines.join('\n'), { mode: 0o600 });
  try { await execFileP('crontab', [tmp]); }
  finally { try { await fsp.unlink(tmp); } catch {} }

  return { ok: true, id: a.id, kind: 'cron', enabled, backup: backupPath };
}

async function toggleAutomation(id, enabled) {
  if (typeof enabled !== 'boolean') { const e = new Error('enabled must be boolean'); e.code = 'INVALID'; throw e; }
  const a = await findAutomation(id);
  if (!a) { const e = new Error('unknown automation id'); e.code = 'NOT_FOUND'; throw e; }
  if (a.kind === 'cron') return toggleCron(a, enabled);
  await execFileP('launchctl', [enabled ? 'enable' : 'disable', `gui/${UID}/${a.label}`]);
  return { ok: true, id, kind: 'launchd', enabled };
}

// ---------- MCP connections ----------

function mcpTransport(s) {
  if (s && typeof s.type === 'string') {
    const t = s.type.toLowerCase();
    if (t === 'stdio' || t === 'http' || t === 'sse') return t;
  }
  if (s && s.url) return /sse/i.test(s.url) ? 'sse' : 'http';
  if (s && s.command) return 'stdio';
  return 'unknown';
}

// Summary target: url -> host, stdio -> command basename.
function mcpTarget(s) {
  if (s && s.url) { try { return new URL(s.url).host; } catch { return '(url)'; } }
  if (s && s.command) return path.basename(String(s.command));
  return null;
}

// Read MCP servers from ~/.claude.json (+ ~/.mcp.json). This is a LOCAL,
// localhost-only management tool on the owner's own machine — it returns the
// FULL server config (command, args, env, url, headers — including API keys /
// tokens) so the user can view and manage their own connections. Not stripped.
async function buildMcpList() {
  const out = { counts: { user: 0, project: 0 }, user: [], project: [] };
  const readJson = async (fp) => { try { return JSON.parse(await fsp.readFile(fp, 'utf8')); } catch { return null; } };

  const entry = (name, scope, s, extra = {}) => ({
    name, scope,
    transport: mcpTransport(s),
    target: mcpTarget(s),
    command: s?.command ?? null,
    args: s?.args ?? null,
    env: s?.env ?? null,        // full env incl. secrets — owner's own machine
    url: s?.url ?? null,
    headers: s?.headers ?? null, // full headers incl. auth tokens
    type: s?.type ?? null,
    ...extra,
  });

  const merge = (src) => {
    if (!src || typeof src !== 'object') return;
    const us = src.mcpServers;
    if (us && typeof us === 'object') {
      for (const [name, s] of Object.entries(us)) {
        out.user.push(entry(name, 'user', s));
      }
    }
    const projs = src.projects;
    if (projs && typeof projs === 'object') {
      for (const [ppath, pv] of Object.entries(projs)) {
        const ps = pv && pv.mcpServers;
        if (ps && typeof ps === 'object') {
          for (const [name, s] of Object.entries(ps)) {
            out.project.push(entry(name, 'project', s, { project: path.basename(ppath) }));
          }
        }
      }
    }
  };

  merge(await readJson(path.join(HOME, '.claude.json')));
  merge(await readJson(path.join(HOME, '.mcp.json')));
  out.counts.user = out.user.length;
  out.counts.project = out.project.length;
  return out;
}

// ---------- Skills ----------

// Minimal YAML-ish frontmatter parser (handles folded multiline values).
function parseFrontmatter(text) {
  const m = text.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const obj = {};
  let curKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const km = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (km && !/^\s/.test(line)) { curKey = km[1]; obj[curKey] = km[2]; }
    else if (curKey && /^\s+\S/.test(line)) { obj[curKey] += ' ' + line.trim(); }
  }
  return obj;
}

// Enumerate SKILL.md-bearing subdirs under ~/.claude/skills and ~/.codex/skills.
async function buildSkillsList() {
  const roots = [
    { source: 'claude', dir: path.join(HOME, '.claude', 'skills') },
    { source: 'codex', dir: path.join(HOME, '.codex', 'skills') },
  ];
  const skills = [];
  const counts = { claude: 0, codex: 0 };

  for (const { source, dir } of roots) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      // Accept real dirs AND symlinks-to-dirs (codex skills are often symlinks
      // into ~/.claude/skills). isDirectory() is false for symlinks, so a plain
      // isDirectory() gate silently drops them.
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith('.')) continue;
      let text;
      try { text = await fsp.readFile(path.join(dir, e.name, 'SKILL.md'), 'utf8'); } catch { continue; }
      const fm = parseFrontmatter(text);
      let name = ((fm.name && fm.name.trim()) || e.name).replace(/^["']|["']$/g, '');
      let description = (fm.description || '').replace(/^["']|["']$/g, '').trim();
      if (description) {
        const sentence = description.match(/^(.*?[.!?])(\s|$)/);
        let d = sentence ? sentence[1] : description;
        if (d.length > 200) d = d.slice(0, 200).trim() + '…';
        description = d;
      }
      skills.push({ source, name, description, dir: e.name });
      counts[source]++;
    }
  }
  return { counts, skills };
}

// ---------- http server ----------

const DASHBOARD_HTML = path.join(__dirname, 'dashboard.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/' && req.method === 'GET') {
      const html = await fsp.readFile(DASHBOARD_HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const data = await buildIndex();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname.startsWith('/api/session/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/session/'.length));
      const index = await buildIndex();
      const session = index.find((s) => s.id === id);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const turns = await getTranscript(session.file);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session, turns }));
      return;
    }

    if (url.pathname.startsWith('/api/resume/') && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.slice('/api/resume/'.length));
      const index = await buildIndex();
      const session = index.find((s) => s.id === id);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      await resumeSession(session.cwd, session.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/api/accounts' && req.method === 'GET') {
      const all = await buildAccountsList();
      const registry = await loadAccountsRegistry();

      // Show accounts the user actually has: every REGISTERED account plus the
      // live active slot. Crucially, do NOT drop an account just because its
      // profile/usage fetch hiccupped (transient 401/429/network) — that was
      // making accounts "disappear" from the UI. A registered account with a
      // failed fetch is shown in a degraded state (status !== 'ok'), never
      // removed. Only unregistered/stray Keychain blobs (not added by the user)
      // stay hidden. `all` already excludes non-Claude blobs (normalizeBlob).
      const registered = new Set(Object.keys(registry));
      const visible = all.filter((a) => registered.has(a.service) || a.service === ACTIVE_SERVICE);

      // Dedupe by email — the re-stash logic can leave two Keychain services
      // holding the same account. Collapse to one card per email, preferring
      // the live active slot as canonical. Fall back to the registry LABEL when
      // the info fetch failed (email null) so a degraded account still dedupes
      // correctly instead of splitting into a phantom "unknown" card.
      const keyFor = (a) => (a.email || registry[a.service]?.label || a.service).toLowerCase();
      const byEmail = new Map();
      for (const a of visible) {
        const key = keyFor(a);
        const existing = byEmail.get(key);
        if (!existing) { byEmail.set(key, a); continue; }
        const aPref = a.service === ACTIVE_SERVICE || a.isActive;
        const ePref = existing.service === ACTIVE_SERVICE || existing.isActive;
        // Prefer the active slot; otherwise prefer the one whose fetch succeeded.
        if ((aPref && !ePref) || (existing.status !== 'ok' && a.status === 'ok')) {
          byEmail.set(key, a);
        }
      }
      // Tag every Claude account with provider + unified id/label fields
      // (keeping `service`/`email` for backward-compat with the existing UI).
      const claudeAccounts = [...byEmail.values()].map((a) => ({
        provider: 'claude',
        id: a.service,
        label: a.email || registry[a.service]?.label || null,
        ...a,
      }));

      // Append Codex accounts (provider:'codex'). Never crash if ~/.codex is
      // absent — buildCodexAccountsList returns [] and the UI shows a
      // "Connect Codex" prompt instead.
      let codexAccounts = [];
      try {
        codexAccounts = await buildCodexAccountsList();
      } catch (e) {
        console.log(`[accounts] codex build skipped: ${e.message}`);
      }

      const accounts = [...claudeAccounts, ...codexAccounts];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(accounts));
      return;
    }

    if (url.pathname === '/api/accounts/activate' && req.method === 'POST') {
      const body = await readJsonBody(req);

      // Codex switch (file-based). Body: { provider:'codex', id }.
      if (body && body.provider === 'codex') {
        if (!body.id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id is required' }));
          return;
        }
        try {
          const result = await activateCodexAccount(body.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ...result,
            note: 'Running codex sessions must be restarted to pick up the new account — new sessions read ~/.codex/auth.json fresh.',
          }));
        } catch (e) {
          console.log(`[accounts/activate codex] failed: ${e.code || ''} ${e.message}`);
          res.writeHead(e.code === 'NOT_FOUND' ? 404 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // Claude switch (keychain). Backward-compatible: no provider => claude.
      if (!body || !body.service) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'service is required' }));
        return;
      }
      try {
        const result = await activateAccount(body.service);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ...result,
          note: 'Running claude sessions must be restarted (exit + relaunch) to pick up the new account — new sessions read credentials fresh.',
        }));
      } catch (e) {
        console.log(`[accounts/activate] failed: ${e.code || ''} ${e.message}`);
        res.writeHead(e.code === 'NOT_FOUND' ? 404 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === '/api/accounts/import' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || !body.json) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'json is required' }));
        return;
      }
      try {
        const account = await importAccount(body.json, body.label);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(account));
      } catch (e) {
        console.log(`[accounts/import] failed: ${e.code || ''} ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === '/api/accounts/login-start' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const email = body && typeof body.email === 'string' && body.email.trim()
          ? body.email.trim() : null;

        // Re-stash the current active account so the new login can't lose it.
        await protectActiveAccount();

        const { verifier, challenge } = makePkce();
        const state = base64url(crypto.randomBytes(24));
        pendingLogin = {
          code_verifier: verifier,
          state,
          createdAt: Date.now(),
          status: 'pending',
          email: null,
          error: null,
        };

        const authorizeUrl = buildAuthorizeUrl({ challenge, state, email });

        // Open in the default browser server-side. Front-end may also open it
        // as a fallback (returned below).
        execFile('open', [authorizeUrl], () => {});

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, authorizeUrl }));
      } catch (e) {
        console.log(`[accounts/login-start] failed: ${e.code || ''} ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // OAuth redirect target. The browser lands here after the user approves.
    if (url.pathname === '/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error');

      if (oauthError) {
        if (pendingLogin) { pendingLogin.status = 'error'; pendingLogin.error = oauthError; }
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage(`Login failed: ${escapeHtmlServer(oauthError)}`, false));
        return;
      }
      if (!pendingLogin || !state || state !== pendingLogin.state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage('Login state mismatch. Please retry from the dashboard.', false));
        return;
      }
      if (!code) {
        pendingLogin.status = 'error';
        pendingLogin.error = 'no authorization code';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage('No authorization code received.', false));
        return;
      }

      try {
        const tokenResp = await exchangeCodeForTokens(code, pendingLogin.code_verifier, pendingLogin.state);
        const { email } = await completeLoginFromTokens(tokenResp);
        pendingLogin.status = 'done';
        pendingLogin.email = email || null;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage(`Signed in as ${escapeHtmlServer(email || 'your account')}. You can close this tab.`, true));
      } catch (e) {
        console.log(`[callback] failed: ${e.status || ''} ${e.message}`);
        if (pendingLogin) { pendingLogin.status = 'error'; pendingLogin.error = e.message; }
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackPage('Could not complete sign-in. Please retry from the dashboard.', false));
      }
      return;
    }

    if (url.pathname === '/api/accounts/login-status' && req.method === 'GET') {
      const p = pendingLogin;
      let out;
      if (!p) {
        out = { status: 'idle' };
      } else {
        out = { status: p.status };
        if (p.email) out.email = p.email;
        if (p.error) out.error = p.error;
      }
      // Reset after a terminal state is read once, so the next add starts clean.
      if (p && (p.status === 'done' || p.status === 'error')) pendingLogin = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    if (url.pathname === '/api/accounts/save-current' && req.method === 'POST') {
      try {
        const result = await saveCurrentAccount();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        console.log(`[accounts/save-current] failed: ${e.code || ''} ${e.message}`);
        res.writeHead(e.code === 'NOT_FOUND' ? 404 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === '/api/accounts/remove' && req.method === 'POST') {
      const body = await readJsonBody(req);

      // Codex remove (delete stash file + registry entry). Body: { provider:'codex', id }.
      if (body && body.provider === 'codex') {
        if (!body.id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id is required' }));
          return;
        }
        try {
          const result = await removeCodexAccount(body.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          console.log(`[accounts/remove codex] failed: ${e.code || ''} ${e.message}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // Claude remove (keychain). Backward-compatible.
      if (!body || !body.service) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'service is required' }));
        return;
      }
      try {
        const result = await removeAccount(body.service);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.log(`[accounts/remove] failed: ${e.code || ''} ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Codex "add account" (import/stash only — the browser OAuth login flow is
    // a LATER task and is intentionally NOT built here). Body:
    //   { importActive: true, label? }             stash the live ~/.codex/auth.json
    //   { json: <auth.json string|object>, label? } stash a pasted blob
    if (url.pathname === '/api/accounts/codex-import' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || (!body.json && !body.importActive)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'json or importActive is required' }));
        return;
      }
      try {
        const account = await importCodexAccount({
          json: body.json,
          importActive: !!body.importActive,
          label: body.label,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(account));
      } catch (e) {
        console.log(`[accounts/codex-import] failed: ${e.code || ''} ${e.message}`);
        res.writeHead(e.code === 'NOT_FOUND' ? 404 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Codex browser OAuth login — start. Spins up the fixed-port loopback
    // listener (1455/1457), builds + opens the OpenAI authorize URL, and stashes
    // pending PKCE state. The callback is served by that loopback listener (NOT
    // this server), so nothing else here handles /auth/callback. Returns the
    // authorizeUrl so the front-end can also open it as a fallback.
    if (url.pathname === '/api/accounts/codex-login-start' && req.method === 'POST') {
      try {
        // Cancel any in-flight login (close its listener) before starting fresh.
        endCodexLoopback();

        const { verifier, challenge } = makePkce(); // identical spec to Codex CLI
        const state = base64url(crypto.randomBytes(32));

        const { server, port } = await startCodexLoopback();

        pendingCodexLogin = {
          code_verifier: verifier,
          state,
          port,
          server,
          createdAt: Date.now(),
          status: 'pending',
          label: null,
          error: null,
          timer: null,
        };
        // Auto-expire the listener after 5 minutes so an abandoned login can't
        // leak an open port forever.
        pendingCodexLogin.timer = setTimeout(() => {
          if (pendingCodexLogin && pendingCodexLogin.status === 'pending') {
            pendingCodexLogin.status = 'error';
            pendingCodexLogin.error = 'login timed out';
          }
          endCodexLoopback();
        }, 5 * 60 * 1000);

        const authorizeUrl = buildCodexAuthorizeUrl({ challenge, state, port });

        // Open in the default browser server-side (front-end may also open it).
        execFile('open', [authorizeUrl], () => {});

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, authorizeUrl, port }));
      } catch (e) {
        console.log(`[accounts/codex-login-start] failed: ${e.code || ''} ${e.message}`);
        endCodexLoopback();
        pendingCodexLogin = null;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: e && e.code === 'EADDRINUSE'
            ? `Codex login port ${CODEX_OAUTH.loopbackPort}/${CODEX_OAUTH.fallbackPort} is in use — close any running "codex login" and retry.`
            : e.message,
        }));
      }
      return;
    }

    // Codex browser OAuth login — status poll. Mirrors Claude's login-status:
    // { status:'idle'|'pending'|'done'|'error', label?, error? }, reset after a
    // terminal state is read once so the next add starts clean.
    if (url.pathname === '/api/accounts/codex-login-status' && req.method === 'GET') {
      const p = pendingCodexLogin;
      let out;
      if (!p) {
        out = { status: 'idle' };
      } else {
        out = { status: p.status };
        if (p.label) out.label = p.label;
        if (p.error) out.error = p.error;
      }
      if (p && (p.status === 'done' || p.status === 'error')) {
        endCodexLoopback();
        pendingCodexLogin = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    // ---------- Automations ----------

    if (url.pathname === '/api/automations' && req.method === 'GET') {
      const list = await buildAutomationsList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    if (url.pathname === '/api/automations/run' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || !body.id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id is required' }));
        return;
      }
      try {
        const result = await runAutomation(body.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.log(`[automations/run] failed: ${e.code || ''} ${e.message}`);
        res.writeHead(e.code === 'NOT_FOUND' ? 400 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === '/api/automations/logs' && (req.method === 'POST' || req.method === 'GET')) {
      let id;
      if (req.method === 'GET') id = url.searchParams.get('id');
      else { const body = await readJsonBody(req); id = body && body.id; }
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id is required' }));
        return;
      }
      try {
        const result = await automationLogs(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(e.code === 'NOT_FOUND' ? 400 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === '/api/automations/toggle' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || !body.id || typeof body.enabled !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id and enabled (boolean) are required' }));
        return;
      }
      try {
        const result = await toggleAutomation(body.id, body.enabled);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.log(`[automations/toggle] failed: ${e.code || ''} ${e.message}`);
        res.writeHead(e.code === 'NOT_FOUND' || e.code === 'INVALID' ? 400 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ---------- MCP connections ----------

    if (url.pathname === '/api/mcp' && req.method === 'GET') {
      const result = await buildMcpList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ---------- Skills ----------

    if (url.pathname === '/api/skills' && req.method === 'GET') {
      const result = await buildSkillsList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
});

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve(null);
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

// Bind to localhost only — this server can rewrite Keychain credentials via
// /api/accounts/activate, so it must never be reachable off-box.
loadUsageCache(); // warm the last-good-usage cache from disk before serving
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Sessions dashboard running at http://localhost:${PORT}`);
});
