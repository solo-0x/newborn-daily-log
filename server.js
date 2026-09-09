'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_COOKIE = 'nb_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_BLOCK_MS = 10 * 60 * 1000;
const loginAttempts = new Map();
let writeQueue = Promise.resolve();
let apiQueue = Promise.resolve();

function nowIso() { return new Date().toISOString(); }
function uid() { return crypto.randomUUID(); }
function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function htmlEscape(v) { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('base64url');
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(String(password), salt, 32);
  const exp = Buffer.from(String(expected), 'base64url');
  return actual.length === exp.length && crypto.timingSafeEqual(actual, exp);
}

function emptyDb() { return { version: 1, users: [], sessions: [], records: [] }; }
function normalizeDb(db) {
  const out = db && typeof db === 'object' ? db : emptyDb();
  out.version = 1;
  out.users = Array.isArray(out.users) ? out.users : [];
  out.sessions = Array.isArray(out.sessions) ? out.sessions : [];
  out.records = Array.isArray(out.records) ? out.records : [];
  return out;
}
function readDb() {
  try { return normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (e) {
    if (e.code === 'ENOENT') return emptyDb();
    throw e;
  }
}
function writeDb(db) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, DB_FILE);
  });
  return writeQueue;
}

async function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let db = readDb();
  if (!db.users.length) {
    const configured = process.env.ADMIN_PASSWORD;
    const password = configured || randomToken(7).replace(/[-_]/g, 'A').slice(0, 10);
    const hp = hashPassword(password);
    const t = nowIso();
    db.users.push({ id: uid(), username: 'admin', displayName: '管理员', passwordHash: hp.hash, passwordSalt: hp.salt, role: 'admin', active: true, createdAt: t, updatedAt: t });
    await writeDb(db);
    console.log('');
    console.log('首次启动已创建管理员：');
    console.log('  用户名: admin');
    if (!configured) console.log('  临时密码: ' + password);
    if (!configured) console.log('  请登录后尽快在“用户管理”中修改密码。');
    console.log('');
  }
}

function send(res, status, body, headers = {}) {
  const base = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': 'no-store',
    ...headers
  };
  res.writeHead(status, base);
  res.end(body);
}
function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}
function serveIndex(res) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  try {
    const body = fs.readFileSync(file);
    send(res, 200, body, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
  } catch { send(res, 500, 'index.html missing', { 'Content-Type': 'text/plain; charset=utf-8' }); }
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function clientIp(req) { return String((TRUST_PROXY && req.headers['x-forwarded-for']) || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function secureCookie(req) {
  return req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https');
}
function sessionCookie(req, token, maxAge) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie(req) ? '; Secure' : ''}`;
}
async function bodyJson(req, maxBytes = 2 * 1024 * 1024) {
  if (Object.hasOwn(req, 'parsedBody')) return req.parsedBody;
  return new Promise((resolve, reject) => {
    let total = 0, chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) { reject(Object.assign(new Error('请求内容过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON 格式不正确'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function publicUser(u) { return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, active: !!u.active, createdAt: u.createdAt }; }
function getAuth(req, db) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const h = sha256(token), now = Date.now();
  db.sessions = db.sessions.filter(s => Number(s.expiresAt) > now);
  const s = db.sessions.find(x => x.tokenHash === h);
  if (!s) return null;
  const user = db.users.find(u => u.id === s.userId && u.active);
  return user ? { user, session: s } : null;
}
function normalizeUsername(v) { return String(v || '').trim().slice(0, 32); }
function validUsername(v) { return /^[\p{L}\p{N}_.-]{2,32}$/u.test(v); }
function clampNumber(v, min, max) { const n = Number(v || 0); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0; }
function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || uid()).slice(0, 100);
  const date = String(raw.date || ''), time = String(raw.time || '');
  let type = String(raw.type || '');
  if (type === 'urine' || type === 'stool') type = 'elimination';
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !['feed','elimination','abnormal','other'].includes(type)) return null;
  const note = String(raw.note || '').trim().slice(0, 1000);
  const data = {};
  if (type === 'feed') {
    data.feedMode = ['奶粉/瓶喂','母乳瓶喂','亲喂'].includes(raw.feedMode) ? raw.feedMode : '奶粉/瓶喂';
    if (data.feedMode === '亲喂') data.duration = clampNumber(raw.duration, 0, 180); else data.amount = clampNumber(raw.amount, 0, 500);
  } else if (type === 'elimination') {
    const legacyKind = raw.type === 'stool' ? 'stool' : raw.type === 'urine' ? 'urine' : raw.eliminationKind;
    data.eliminationKind = ['urine','stool','both'].includes(legacyKind) ? legacyKind : 'urine';
    if (data.eliminationKind !== 'stool') data.urineStatus = ['正常','偏少','偏黄','异常'].includes(raw.urineStatus || raw.status) ? (raw.urineStatus || raw.status) : '正常';
    if (data.eliminationKind !== 'urine') {
      data.stoolColor = ['黄色','黄绿色','绿色','黑色/异常'].includes(raw.stoolColor) ? raw.stoolColor : '黄色';
      data.stoolForm = ['正常糊状','偏稀','水样','偏干','有血丝/异常'].includes(raw.stoolForm) ? raw.stoolForm : '正常糊状';
    }
  } else if (type === 'abnormal') {
    data.abnormalType = ['吐奶/溢奶','体温','皮肤/黄疸','哭闹/精神','呼吸','其它异常'].includes(raw.abnormalType) ? raw.abnormalType : '其它异常';
    data.severity = ['轻微','需关注','明显异常'].includes(raw.severity) ? raw.severity : '轻微';
  } else data.otherTitle = String(raw.otherTitle || '其它记录').trim().slice(0, 80) || '其它记录';
  return { id, date, time, type, note, data };
}
function toClient(r, db) {
  const cu = db.users.find(u => u.id === r.createdBy), uu = db.users.find(u => u.id === r.updatedBy);
  return { id:r.id, date:r.date, time:r.time, type:r.type, note:r.note || '', ...(r.data || {}), createdByName:cu?.displayName || '', updatedByName:uu?.displayName || '', createdAt:r.createdAt, updatedAt:r.updatedAt };
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, storage: 'file-json', file: 'data/db.json' });
  let db = readDb();

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await bodyJson(req);
    const username = normalizeUsername(body?.username), password = String(body?.password || '');
    const key = sha256(`${clientIp(req)}|${username.toLowerCase()}`), now = Date.now();
    const attempt = loginAttempts.get(key);
    if (attempt?.blockedUntil > now) return json(res, 429, { message:`尝试次数过多，请 ${Math.ceil((attempt.blockedUntil-now)/60000)} 分钟后再试` }, { 'Retry-After': String(Math.ceil((attempt.blockedUntil-now)/1000)) });
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    const ok = user && user.active && verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!ok) {
      const fails = (attempt?.fails || 0) + 1;
      loginAttempts.set(key, { fails, blockedUntil: fails >= LOGIN_MAX_FAILS ? now + LOGIN_BLOCK_MS : 0 });
      return json(res, fails >= LOGIN_MAX_FAILS ? 429 : 401, { message: fails >= LOGIN_MAX_FAILS ? '尝试次数过多，请 10 分钟后再试' : '用户名或密码不正确' });
    }
    loginAttempts.delete(key);
    const token = randomToken(), t = nowIso();
    db.sessions = db.sessions.filter(s => Number(s.expiresAt) > now);
    db.sessions.push({ tokenHash: sha256(token), userId: user.id, expiresAt: now + SESSION_MS, createdAt: t });
    await writeDb(db);
    return json(res, 200, { authenticated:true, user:publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, Math.floor(SESSION_MS/1000)) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) { db.sessions = db.sessions.filter(s => s.tokenHash !== sha256(token)); await writeDb(db); }
    return json(res, 200, { ok:true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  const auth = getAuth(req, db);
  if (req.method === 'GET' && url.pathname === '/api/auth/session') {
    if (!auth) return json(res, 401, { authenticated:false, message:'请先登录' });
    return json(res, 200, { authenticated:true, user:publicUser(auth.user) });
  }
  if (!auth) return json(res, 401, { message:'请先登录' });

  if (req.method === 'GET' && url.pathname === '/api/records') {
    const date = String(url.searchParams.get('date') || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { message:'日期格式不正确' });
    const records = db.records.filter(r => r.date === date).sort((a,b) => b.time.localeCompare(a.time) || b.updatedAt.localeCompare(a.updatedAt)).map(r => toClient(r, db));
    return json(res, 200, { records });
  }
  if (req.method === 'POST' && url.pathname === '/api/records') {
    const rec = sanitizeRecord(await bodyJson(req));
    if (!rec) return json(res, 400, { message:'记录内容不完整或格式不正确' });
    const t = nowIso(), idx = db.records.findIndex(r => r.id === rec.id), old = idx >= 0 ? db.records[idx] : null;
    const saved = { ...rec, createdBy: old?.createdBy || auth.user.id, updatedBy: auth.user.id, createdAt: old?.createdAt || t, updatedAt:t };
    if (idx >= 0) db.records[idx] = saved; else db.records.push(saved);
    await writeDb(db);
    return json(res, 200, { record:toClient(saved, db) });
  }
  if (req.method === 'DELETE' && /^\/api\/records\/[A-Za-z0-9._:-]{1,100}$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    db.records = db.records.filter(r => r.id !== id);
    await writeDb(db); return json(res, 200, { ok:true });
  }
  if (req.method === 'GET' && url.pathname === '/api/records/export') {
    return json(res, 200, { version:4, storage:'file-json', exportedAt:nowIso(), exportedBy:auth.user.displayName, records:db.records.map(r => toClient(r, db)) });
  }
  if (req.method === 'POST' && url.pathname === '/api/records/import') {
    if (auth.user.role !== 'admin') return json(res, 403, { message:'仅管理员可导入备份' });
    const body = await bodyJson(req, 10 * 1024 * 1024);
    if (!Array.isArray(body?.records) || body.records.length > 10000) return json(res, 400, { message:'备份文件格式不正确' });
    let imported = 0; const t = nowIso();
    for (const raw of body.records) {
      const rec = sanitizeRecord(raw); if (!rec) continue;
      const idx = db.records.findIndex(r => r.id === rec.id), old = idx >= 0 ? db.records[idx] : null;
      const saved = { ...rec, createdBy:old?.createdBy || auth.user.id, updatedBy:auth.user.id, createdAt:old?.createdAt || t, updatedAt:t };
      if (idx >= 0) db.records[idx] = saved; else db.records.push(saved); imported++;
    }
    await writeDb(db); return json(res, 200, { ok:true, imported });
  }

  if (req.method === 'GET' && url.pathname === '/api/users') {
    if (auth.user.role !== 'admin') return json(res, 403, { message:'仅管理员可管理用户' });
    return json(res, 200, { users:db.users.map(publicUser) });
  }
  if (req.method === 'POST' && url.pathname === '/api/users') {
    if (auth.user.role !== 'admin') return json(res, 403, { message:'仅管理员可新增用户' });
    const body = await bodyJson(req), username = normalizeUsername(body?.username), displayName = String(body?.displayName || '').trim().slice(0,30), password = String(body?.password || ''), role = body?.role === 'admin' ? 'admin' : 'user';
    if (!validUsername(username)) return json(res, 400, { message:'用户名需为 2–32 位文字、数字、点、下划线或短横线' });
    if (!displayName) return json(res, 400, { message:'请输入显示名称' });
    if (password.length < 6 || password.length > 128) return json(res, 400, { message:'密码至少 6 位' });
    if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return json(res, 409, { message:'用户名已存在' });
    const hp = hashPassword(password), t = nowIso();
    const user = { id:uid(), username, displayName, passwordHash:hp.hash, passwordSalt:hp.salt, role, active:true, createdAt:t, updatedAt:t };
    db.users.push(user); await writeDb(db); return json(res, 201, { user:publicUser(user) });
  }
  const userMatch = url.pathname.match(/^\/api\/users\/([A-Za-z0-9-]{1,100})$/);
  if (req.method === 'PATCH' && userMatch) {
    if (auth.user.role !== 'admin') return json(res, 403, { message:'仅管理员可管理用户' });
    const target = db.users.find(u => u.id === userMatch[1]); if (!target) return json(res, 404, { message:'用户不存在' });
    const body = await bodyJson(req), t = nowIso();
    if (typeof body?.displayName === 'string') { const n = body.displayName.trim().slice(0,30); if (!n) return json(res,400,{message:'显示名称不能为空'}); target.displayName=n; }
    if (typeof body?.active === 'boolean') { if (target.id === auth.user.id && !body.active) return json(res,400,{message:'不能停用当前登录用户'}); target.active=body.active; if (!body.active) db.sessions=db.sessions.filter(s=>s.userId!==target.id); }
    if (typeof body?.password === 'string' && body.password.length) { if (body.password.length < 6 || body.password.length > 128) return json(res,400,{message:'密码至少 6 位'}); const hp=hashPassword(body.password); target.passwordHash=hp.hash; target.passwordSalt=hp.salt; if (target.id !== auth.user.id) db.sessions=db.sessions.filter(s=>s.userId!==target.id); }
    target.updatedAt=t; await writeDb(db); return json(res,200,{user:publicUser(target)});
  }
  return json(res, 404, { message:'接口不存在' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { message: '不允许跨站请求' });
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { message: '请使用 JSON 请求' });
        req.parsedBody = await bodyJson(req, url.pathname === '/api/records/import' ? 10 * 1024 * 1024 : 2 * 1024 * 1024);
      }
      // Serialize the complete read/modify/write operation, after consuming the body.
      const task = apiQueue.then(() => api(req, res, url));
      apiQueue = task.catch(() => {});
      return await task;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveIndex(res);
    return send(res, 404, 'Not Found', { 'Content-Type':'text/plain; charset=utf-8' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { message: err.status ? err.message : '服务器处理失败' }); else res.end();
  }
});

initDb().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`新生儿日常记录已启动: http://localhost:${PORT}`);
    console.log(`数据文件: ${DB_FILE}`);
  });
}).catch(err => { console.error('启动失败:', err); process.exit(1); });
