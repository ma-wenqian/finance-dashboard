#!/usr/bin/env node
/*
 * 个人资金看板 —— 服务端
 *
 * 零 npm 依赖，只用 Node 内置模块。需要 Node 18+（用到全局 fetch）。
 * 数据：每个用户一个 JSON 文件，原子写入（临时文件 + rename），并保留一份 .bak。
 * 认证：三种模式，见 config.example.json
 *   - "proxy"  信任前置反代（Authentik / Authelia forward-auth）注入的身份请求头
 *   - "oidc"   自己走 OpenID Connect 授权码 + PKCE 流程
 *   - "none"   不认证，单用户，仅用于本机调试
 *
 * 启动：node server/server.js [配置文件路径]
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.argv[2] || path.join(__dirname, 'config.json');

/* ---------------- 配置 ---------------- */
const DEFAULTS = {
  port: 8788,
  host: '127.0.0.1',
  staticDir: path.join(__dirname, "public"),
  dataDir: path.join(__dirname, 'data'),
  secureCookies: true,
  sessionTtlDays: 30,
  authMode: 'none',
  allowedEmails: [],
  proxy: {
    trustedIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
    // Authelia 的 forward_auth 发这三个（Caddy 的 copy_headers 里就是它们）；
    // Authentik outpost 发 X-authentik-* ，作为兜底
    idHeader: 'remote-user',
    emailHeader: 'remote-email',
    nameHeader: 'remote-name',
    fallbackIdHeader: 'x-authentik-uid',
    fallbackEmailHeader: 'x-authentik-email',
    fallbackNameHeader: 'x-authentik-name'
  },
  oidc: {
    issuer: '',
    clientId: '',
    clientSecret: '',
    redirectUri: '',
    scope: 'openid profile email'
  }
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}

let cfg = DEFAULTS;
let cfgSource = '内置默认值';
if (fs.existsSync(CONFIG_PATH)) {
  cfg = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  cfgSource = CONFIG_PATH;
}
// 环境变量可覆盖，方便 systemd。生效的项记下来一起打印 ——
// 不要在这之前就打印 authMode，否则日志会说 none 而实际跑的是 proxy。
const envUsed = [];
const fromEnv = (name, apply) => { if (process.env[name]) { apply(process.env[name]); envUsed.push(name); } };
fromEnv('PORT', v => cfg.port = +v);
fromEnv('HOST', v => cfg.host = v);
fromEnv('AUTH_MODE', v => cfg.authMode = v);
fromEnv('DATA_DIR', v => cfg.dataDir = v);
fromEnv('STATIC_DIR', v => cfg.staticDir = v);
fromEnv('OIDC_CLIENT_SECRET', v => cfg.oidc.clientSecret = v);
log('配置来源：' + cfgSource + (envUsed.length ? '，环境变量覆盖 ' + envUsed.join(' ') : ''));

const USERS_DIR = path.join(cfg.dataDir, 'users');
fs.mkdirSync(USERS_DIR, { recursive: true });

/* 会话签名密钥：没有就生成一个并存下来 */
const SECRET_FILE = path.join(cfg.dataDir, '.session-secret');
let SESSION_SECRET;
if (fs.existsSync(SECRET_FILE)) {
  SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} else {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SESSION_SECRET, { mode: 0o600 });
  log('已生成会话密钥 ' + SECRET_FILE);
}

function log(...a) { console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a); }

/* ---------------- 小工具 ---------------- */
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url');

function sign(payloadObj, ttlSec) {
  const body = { ...payloadObj, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const p = b64u(JSON.stringify(body));
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
  return p + '.' + mac;
}
function unsign(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [p, mac] = token.split('.');
  const want = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
  const a = Buffer.from(mac || '', 'utf8'), b = Buffer.from(want, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(unb64u(p).toString('utf8'));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const bits = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (cfg.secureCookies) bits.push('Secure');
  bits.push('Max-Age=' + (maxAgeSec == null ? 0 : maxAgeSec));
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', (prev ? (Array.isArray(prev) ? prev : [prev]) : []).concat(bits.join('; ')));
}
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------------- 用户数据存取 ---------------- */
function userFile(userId) {
  return path.join(USERS_DIR, crypto.createHash('sha256').update(userId).digest('hex').slice(0, 32) + '.json');
}
async function readUser(userId) {
  try { return JSON.parse(await fsp.readFile(userFile(userId), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    // 主文件坏了就用备份
    try { return JSON.parse(await fsp.readFile(userFile(userId) + '.bak', 'utf8')); } catch { throw e; }
  }
}
async function writeUser(userId, record) {
  const f = userFile(userId);
  const tmp = f + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
  try { await fsp.copyFile(f, f + '.bak'); } catch { /* 首次写入没有旧文件 */ }
  await fsp.rename(tmp, f);
}

/* ---------------- 认证 ---------------- */
function emailAllowed(email) {
  if (!cfg.allowedEmails || !cfg.allowedEmails.length) return true;
  return cfg.allowedEmails.some(e => e.toLowerCase() === String(email || '').toLowerCase());
}

function identityFromProxy(req) {
  const ip = req.socket.remoteAddress;
  if (cfg.proxy.trustedIps.length && !cfg.proxy.trustedIps.includes(ip)) {
    log('拒绝：请求来自非信任 IP ' + ip + '（proxy 模式下身份头只信任反代）');
    return null;
  }
  const h = req.headers;
  // HTTP 头只能放 Latin-1，反代传中文显示名时一般是百分号编码的，这里尽量还原
  const dec = v => { if (!v || v.indexOf('%') < 0) return v || ''; try { return decodeURIComponent(v); } catch { return v; } };
  const pick = (a, b) => dec(h[a] || h[b] || '');
  const id = pick(cfg.proxy.idHeader, cfg.proxy.fallbackIdHeader);
  const email = pick(cfg.proxy.emailHeader, cfg.proxy.fallbackEmailHeader);
  const name = pick(cfg.proxy.nameHeader, cfg.proxy.fallbackNameHeader);
  if (!id && !email) return null;
  return { id: 'proxy:' + (id || email), email, name: name || email || id };
}

/* --- OIDC --- */
let oidcMeta = null;
let jwksCache = { at: 0, keys: [] };
async function discover() {
  if (oidcMeta) return oidcMeta;
  const url = cfg.oidc.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const r = await fetch(url);
  if (!r.ok) throw new Error('OIDC discovery 失败 ' + r.status + ' @ ' + url);
  oidcMeta = await r.json();
  return oidcMeta;
}
async function getKey(kid) {
  if (Date.now() - jwksCache.at > 10 * 60 * 1000) {
    const meta = await discover();
    const r = await fetch(meta.jwks_uri);
    if (!r.ok) throw new Error('取 JWKS 失败 ' + r.status);
    jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  return jwksCache.keys.find(k => k.kid === kid) || jwksCache.keys[0];
}
const ALG = { RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512', ES256: 'sha256', PS256: 'RSA-SHA256' };
async function verifyIdToken(idToken, nonce) {
  const [h, p, s] = idToken.split('.');
  if (!s) throw new Error('id_token 格式不对');
  const header = JSON.parse(unb64u(h).toString('utf8'));
  const payload = JSON.parse(unb64u(p).toString('utf8'));
  const jwk = await getKey(header.kid);
  if (!jwk) throw new Error('JWKS 里找不到对应的密钥');
  const keyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const algo = ALG[header.alg];
  if (!algo) throw new Error('不支持的签名算法 ' + header.alg);
  const opts = header.alg.startsWith('PS') ? { key: keyObj, padding: crypto.constants.RSA_PKCS1_PSS_PADDING } : keyObj;
  const ok = crypto.createVerify(algo).update(h + '.' + p).verify(opts, unb64u(s));
  if (!ok) throw new Error('id_token 签名校验不通过');

  const meta = await discover();
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== meta.issuer) throw new Error('iss 不匹配');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.oidc.clientId)) throw new Error('aud 不匹配');
  if (payload.exp && payload.exp < now - 60) throw new Error('id_token 已过期');
  if (nonce && payload.nonce !== nonce) throw new Error('nonce 不匹配');
  return payload;
}

async function handleLogin(req, res, url) {
  const meta = await discover();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const next = url.searchParams.get('next') || '/';
  setCookie(res, 'pf_oidc', sign({ verifier, state, nonce, next: next.startsWith('/') ? next : '/' }, 600), 600);
  const a = new URL(meta.authorization_endpoint);
  a.searchParams.set('response_type', 'code');
  a.searchParams.set('client_id', cfg.oidc.clientId);
  a.searchParams.set('redirect_uri', cfg.oidc.redirectUri);
  a.searchParams.set('scope', cfg.oidc.scope);
  a.searchParams.set('state', state);
  a.searchParams.set('nonce', nonce);
  a.searchParams.set('code_challenge', challenge);
  a.searchParams.set('code_challenge_method', 'S256');
  res.writeHead(302, { Location: a.toString(), 'Cache-Control': 'no-store' });
  res.end();
}

async function handleCallback(req, res, url) {
  const tmp = unsign(parseCookies(req).pf_oidc);
  setCookie(res, 'pf_oidc', '', 0);
  if (!tmp) return json(res, 400, { error: '登录流程已过期，请重新登录' });
  if (url.searchParams.get('state') !== tmp.state) return json(res, 400, { error: 'state 不匹配' });
  const code = url.searchParams.get('code');
  if (!code) return json(res, 400, { error: url.searchParams.get('error') || '没有拿到授权码' });

  const meta = await discover();
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code,
    redirect_uri: cfg.oidc.redirectUri, client_id: cfg.oidc.clientId, code_verifier: tmp.verifier
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (cfg.oidc.clientSecret) headers.Authorization = 'Basic ' + Buffer.from(cfg.oidc.clientId + ':' + cfg.oidc.clientSecret).toString('base64');
  const tr = await fetch(meta.token_endpoint, { method: 'POST', headers, body });
  if (!tr.ok) return json(res, 502, { error: '换 token 失败：' + tr.status + ' ' + (await tr.text()).slice(0, 300) });
  const tok = await tr.json();
  if (!tok.id_token) return json(res, 502, { error: '响应里没有 id_token' });

  let claims;
  try { claims = await verifyIdToken(tok.id_token, tmp.nonce); }
  catch (e) { return json(res, 401, { error: 'id_token 校验失败：' + e.message }); }

  const email = claims.email || '';
  if (!emailAllowed(email)) {
    log('拒绝未授权用户 ' + email);
    return json(res, 403, { error: '这个账号未被允许使用（allowedEmails）' });
  }
  const user = { id: 'oidc:' + claims.iss + '|' + claims.sub, email, name: claims.name || claims.preferred_username || email };
  setCookie(res, 'pf_sess', sign(user, cfg.sessionTtlDays * 86400), cfg.sessionTtlDays * 86400);
  log('登录成功：' + (email || user.id));
  res.writeHead(302, { Location: tmp.next || '/', 'Cache-Control': 'no-store' });
  res.end();
}

/** 返回当前请求的用户；未登录返回 null */
function currentUser(req) {
  if (cfg.authMode === 'none') return { id: 'local:single', email: '', name: '本机用户' };
  if (cfg.authMode === 'proxy') {
    const u = identityFromProxy(req);
    if (u && !emailAllowed(u.email)) return null;
    return u;
  }
  const sess = unsign(parseCookies(req).pf_sess);
  return sess ? { id: sess.id, email: sess.email, name: sess.name } : null;
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};
async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(cfg.staticDir, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(path.resolve(cfg.staticDir))) { res.writeHead(403); return res.end('forbidden'); }
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) { res.writeHead(404); return res.end('not found'); }
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  try {
    if (p === '/auth/login') {
      if (cfg.authMode !== 'oidc') { res.writeHead(302, { Location: '/' }); return res.end(); }
      return await handleLogin(req, res, url);
    }
    if (p === '/auth/callback') {
      if (cfg.authMode !== 'oidc') { res.writeHead(302, { Location: '/' }); return res.end(); }
      return await handleCallback(req, res, url);
    }
    if (p === '/auth/logout') {
      setCookie(res, 'pf_sess', '', 0);
      if (req.method === 'POST') return json(res, 200, { ok: true });
      res.writeHead(302, { Location: '/' }); return res.end();
    }

    if (p.startsWith('/api/')) {
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: '未登录', loginUrl: cfg.authMode === 'oidc' ? '/auth/login' : null });

      if (p === '/api/me' && req.method === 'GET') {
        const rec = await readUser(user.id);
        return json(res, 200, {
          mode: cfg.authMode, user: { id: user.id, name: user.name, email: user.email },
          hasData: !!rec, rev: rec ? rec.rev : 0
        });
      }
      if (p === '/api/data' && req.method === 'GET') {
        const rec = await readUser(user.id);
        if (!rec) return json(res, 404, { error: '还没有数据', rev: 0 });
        return json(res, 200, { rev: rec.rev, updatedAt: rec.updatedAt, data: rec.data });
      }
      if (p === '/api/data' && req.method === 'PUT') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'JSON 解析失败' }); }
        if (!body || typeof body.data !== 'object' || !body.data) return json(res, 400, { error: '缺少 data' });
        const cur = await readUser(user.id);
        const curRev = cur ? cur.rev : 0;
        // 乐观锁：客户端带着自己看到的 rev；不匹配说明别处改过
        if (body.rev !== undefined && body.rev !== null && body.rev !== curRev && !body.force) {
          return json(res, 409, { error: '数据在别处被改过', rev: curRev, data: cur ? cur.data : null });
        }
        const rec = { rev: curRev + 1, updatedAt: new Date().toISOString(), data: body.data };
        await writeUser(user.id, rec);
        return json(res, 200, { rev: rec.rev, updatedAt: rec.updatedAt });
      }
      return json(res, 404, { error: '没有这个接口' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }

    // oidc 模式下，没登录就直接跳登录页
    if (cfg.authMode === 'oidc' && (p === '/' || p === '/index.html') && !currentUser(req)) {
      res.writeHead(302, { Location: '/auth/login?next=' + encodeURIComponent(p) });
      return res.end();
    }
    return await serveStatic(req, res, p);
  } catch (e) {
    log('未处理的错误', e);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

server.listen(cfg.port, cfg.host, () => {
  log('资金看板已启动 http://' + cfg.host + ':' + cfg.port + '  认证模式=' + cfg.authMode);
  log('数据目录 ' + USERS_DIR);
  if (cfg.authMode === 'none') log('⚠  authMode=none：任何能访问这个端口的人都是同一个用户，只应绑在 127.0.0.1 上调试');
  if (cfg.authMode === 'oidc') discover().then(m => log('OIDC 发现成功，issuer=' + m.issuer)).catch(e => log('⚠  OIDC discovery 失败：' + e.message));
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('收到 ' + sig + '，退出'); server.close(() => process.exit(0)); });
