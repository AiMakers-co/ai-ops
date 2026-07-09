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
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/api/oauth/usage', { headers });
    } catch {
      return { ok: false, status: 0 };
    }
    if (res.ok) return { ok: true, json: await res.json() };
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1200)); // brief backoff, then retry
      continue;
    }
    return { ok: false, status: res.status };
  }
  return { ok: false, status: 429 };
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
  const usageResult = await fetchUsageWithRetry(headers);
  let usage = null;
  let usageError = null;
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
  } else {
    // Endpoint threw/throttled — usage unknown, NOT at limit.
    usageError = String(usageResult.status);
  }

  return {
    status: 'ok',
    email: profile.account?.email || null,
    fullName: profile.account?.full_name || null,
    hasMax: !!profile.account?.has_claude_max,
    hasPro: !!profile.account?.has_claude_pro,
    plan: planLabel(profile.organization?.rate_limit_tier),
    usage,
    usageError,
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
      base.usage = info.usage;               // may be null when usage was rate-limited
      if (info.usageError) base.usageError = info.usageError; // e.g. "429" = at limit
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
      const accounts = [...byEmail.values()];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(accounts));
      return;
    }

    if (url.pathname === '/api/accounts/activate' && req.method === 'POST') {
      const body = await readJsonBody(req);
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
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Sessions dashboard running at http://localhost:${PORT}`);
});
