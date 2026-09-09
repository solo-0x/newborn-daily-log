import { neon } from "@neondatabase/serverless";

const SESSION_COOKIE = 'nb_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const LOGIN_MAX_FAILS = 5;
const LOGIN_BLOCK_SECONDS = 10 * 60;

export async function handleRequest(request) {
  try {
    const env = { DB: getDb(), INITIAL_ADMIN_PASSWORD: process.env.INITIAL_ADMIN_PASSWORD };
    if (['POST','PATCH','DELETE'].includes(request.method) && request.headers.get('sec-fetch-site') === 'cross-site') return json({message:'不允许跨站请求'},403);
    if (['POST','PATCH'].includes(request.method) && request.body && !String(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return json({message:'请使用 JSON 请求'},415);
    await ensureSchema(env.DB);
    return await handleApi(request, env, new URL(request.url));
  } catch (err) {
    console.error('Request failed', err);
    return json({message:err.status ? err.message : '服务暂时不可用，请稍后重试'},err.status || 500);
  }
}


let databaseClient;
let schemaPromise;
function placeholders(text) { let i=0; return text.replace(/\?/g, () => `$${++i}`); }
function getDb() {
  if (!databaseClient) {
    const url=process.env.DATABASE_URL;
    if (!url) throw Object.assign(new Error('数据库尚未配置'),{status:503});
    const sql=neon(url);
    databaseClient={
      prepare(statement){
        const query=placeholders(statement);
        const bound=(params=[])=>({
        bind(...values){return bound(values)},
        async first(){const rows=await sql.query(query,params);return rows[0]||null},
        async all(){return {results:await sql.query(query,params)}},
        async run(){return {results:await sql.query(query,params)}}
        });
        return bound();
      },
      async batch(statements){
        const results=[];
        for(const statement of statements) results.push(await statement.run());
        return results;
      }
    };
  }
  return databaseClient;
}
async function ensureSchema(db) {
  if (!schemaPromise) schemaPromise=db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,username TEXT NOT NULL,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (attempt_key TEXT PRIMARY KEY,fail_count INTEGER NOT NULL DEFAULT 0,blocked_until INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY,record_date TEXT NOT NULL,record_time TEXT NOT NULL,type TEXT NOT NULL,data_json TEXT NOT NULL DEFAULT '{}',note TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,updated_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_records_date_time ON records(record_date,record_time)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (setting_key TEXT PRIMARY KEY,setting_value TEXT NOT NULL,updated_by TEXT,updated_at TEXT NOT NULL)`)
  ]).catch(e=>{schemaPromise=null;throw e});
  await schemaPromise;
}

async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true, storage: 'neon-postgres' });
  }

  if (url.pathname === '/api/settings/public' && request.method === 'GET') {
    const settings = await readSettings(env);
    return json({ appTitle: settings.appTitle });
  }

  if (url.pathname === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
  if (url.pathname === '/api/auth/session' && request.method === 'GET') {
    const auth = await getAuth(request, env);
    return auth ? json({ authenticated: true, user: publicUser(auth.user) }) : json({ authenticated: false }, 401);
  }

  const auth = await getAuth(request, env);
  if (!auth) return json({ error: 'unauthorized', message: '请先登录' }, 401);

  if (url.pathname === '/api/settings' && request.method === 'GET') return json({ settings: await readSettings(env) });
  if (url.pathname === '/api/settings' && request.method === 'PATCH') return updateSettings(request, env, auth.user);
  if (url.pathname === '/api/profile/password' && request.method === 'PATCH') return changeOwnPassword(request, env, auth.user);

  if (url.pathname === '/api/records' && request.method === 'GET') return listRecords(env, url);
  if (url.pathname === '/api/records' && request.method === 'POST') return saveRecord(request, env, auth.user);
  if (url.pathname === '/api/records/latest' && request.method === 'GET') return latestRecords(env);
  if (url.pathname === '/api/records/export' && request.method === 'GET') return exportRecords(env, auth.user);
  if (url.pathname === '/api/records/import' && request.method === 'POST') return importRecords(request, env, auth.user);

  const recordMatch = url.pathname.match(/^\/api\/records\/([A-Za-z0-9._:-]{1,100})$/);
  if (recordMatch && request.method === 'DELETE') return deleteRecord(env, recordMatch[1]);

  if (url.pathname === '/api/users' && request.method === 'GET') return listUsers(env, auth.user);
  if (url.pathname === '/api/users' && request.method === 'POST') return createUser(request, env, auth.user);
  const userMatch = url.pathname.match(/^\/api\/users\/([A-Za-z0-9-]{1,100})$/);
  if (userMatch && request.method === 'PATCH') return updateUser(request, env, auth.user, userMatch[1]);

  return json({ error: 'not_found', message: '接口不存在' }, 404);
}

const DEFAULT_SETTINGS = Object.freeze({
  appTitle: '新生儿日常记录', babyName: '', birthDate: '', timezone: 'Asia/Shanghai',
  defaultFeedMode: '奶粉/瓶喂', quickAmounts: [30, 60, 90, 120, 150], inheritLastRecord: true,
  formulaReferenceMode: 'system', customFormulaMin: 60, customFormulaMax: 90
});

async function readSettings(env) {
  const row = await env.DB.prepare("SELECT setting_value FROM app_settings WHERE setting_key='main'").first();
  if (!row) return { ...DEFAULT_SETTINGS };
  try { return sanitizeSettings(JSON.parse(row.setting_value), false); }
  catch { return { ...DEFAULT_SETTINGS }; }
}

async function updateSettings(request, env, actor) {
  if (actor.role !== 'admin') return json({ message: '仅管理员可修改管理设置' }, 403);
  const body = await safeJson(request);
  const settings = sanitizeSettings(body, true);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO app_settings(setting_key,setting_value,updated_by,updated_at) VALUES('main',?,?,?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .bind(JSON.stringify(settings), actor.id, now).run();
  return json({ settings });
}

function sanitizeSettings(raw, strict) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const appTitle = String(source.appTitle ?? DEFAULT_SETTINGS.appTitle).trim().slice(0, 30);
  const babyName = String(source.babyName ?? '').trim().slice(0, 20);
  const birthDate = String(source.birthDate ?? '');
  const timezone = String(source.timezone ?? DEFAULT_SETTINGS.timezone);
  const defaultFeedMode = String(source.defaultFeedMode ?? DEFAULT_SETTINGS.defaultFeedMode);
  const inheritLastRecord = source.inheritLastRecord !== false;
  const formulaReferenceMode = String(source.formulaReferenceMode ?? DEFAULT_SETTINGS.formulaReferenceMode);
  const customFormulaMin = clampNumber(source.customFormulaMin ?? DEFAULT_SETTINGS.customFormulaMin, 5, 500);
  const customFormulaMax = clampNumber(source.customFormulaMax ?? DEFAULT_SETTINGS.customFormulaMax, 5, 500);
  const quickAmountsRaw = Array.isArray(source.quickAmounts) ? source.quickAmounts : DEFAULT_SETTINGS.quickAmounts;
  const quickAmounts = [...new Set(quickAmountsRaw.map(Number).filter(n => Number.isInteger(n) && n >= 5 && n <= 500))].slice(0, 8).sort((a,b)=>a-b);
  if (strict && !appTitle) throw Object.assign(new Error('应用名称不能为空'), { status: 400 });
  if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) throw Object.assign(new Error('出生日期格式不正确'), { status: 400 });
  if (!['Asia/Shanghai','Etc/UTC','America/Los_Angeles','America/New_York'].includes(timezone)) throw Object.assign(new Error('家庭时区不受支持'), { status: 400 });
  if (!['奶粉/瓶喂','母乳瓶喂','亲喂'].includes(defaultFeedMode)) throw Object.assign(new Error('默认喂养方式不正确'), { status: 400 });
  if (!['system','custom'].includes(formulaReferenceMode)) throw Object.assign(new Error('奶量参考方式不正确'), { status: 400 });
  if (formulaReferenceMode === 'custom' && customFormulaMin > customFormulaMax) throw Object.assign(new Error('建议奶量下限不能大于上限'), { status: 400 });
  if (!quickAmounts.length) throw Object.assign(new Error('请至少设置一个快捷奶量'), { status: 400 });
  return { appTitle: appTitle || DEFAULT_SETTINGS.appTitle, babyName, birthDate, timezone, defaultFeedMode, quickAmounts,
    inheritLastRecord, formulaReferenceMode, customFormulaMin, customFormulaMax };
}

async function changeOwnPassword(request, env, actor) {
  const body = await safeJson(request);
  const currentPassword = String(body?.currentPassword || '');
  const newPassword = String(body?.newPassword || '');
  if (newPassword.length < 6 || newPassword.length > 128) return json({ message: '新密码至少 6 位' }, 400);
  const current = await env.DB.prepare('SELECT password_hash,password_salt FROM users WHERE id=?').bind(actor.id).first();
  if (!current || !(await verifyPassword(currentPassword, current.password_salt, current.password_hash))) return json({ message: '当前密码不正确' }, 400);
  const { hash, salt } = await hashPassword(newPassword);
  await env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?')
    .bind(hash, salt, new Date().toISOString(), actor.id).run();
  return json({ ok: true });
}

async function login(request, env) {
  const body = await safeJson(request);
  const username = normalizeUsername(body?.username);
  const password = String(body?.password || '');
  if (!username || password.length < 1 || password.length > 128) return json({ message: '用户名或密码不正确' }, 401);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const attemptKey = await sha256Hex(`${ip}|${username.toLowerCase()}`);
  const nowSec = Math.floor(Date.now() / 1000);
  const attempt = await env.DB.prepare('SELECT fail_count, blocked_until FROM login_attempts WHERE attempt_key = ?').bind(attemptKey).first();
  if (attempt && Number(attempt.blocked_until) > nowSec) {
    const retry = Number(attempt.blocked_until) - nowSec;
    return json({ message: `尝试次数过多，请 ${Math.ceil(retry / 60)} 分钟后再试`, retryAfter: retry }, 429, { 'Retry-After': String(retry) });
  }

  let user = await env.DB.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').bind(username).first();
  const userCount = Number((await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first())?.c || 0);

  // First-login bootstrap: secret exists only in the Worker environment, never in browser assets.
  if (!user && userCount === 0 && username.toLowerCase() === 'admin' && env.INITIAL_ADMIN_PASSWORD) {
    if (await safeEqual(password, String(env.INITIAL_ADMIN_PASSWORD))) {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const { hash, salt } = await hashPassword(password);
      await env.DB.prepare(`INSERT INTO users(id,username,display_name,password_hash,password_salt,role,active,created_at,updated_at)
        VALUES(?,?,?,?,?,'admin',1,?,?) ON CONFLICT DO NOTHING`).bind(id, 'admin', '管理员', hash, salt, now, now).run();
      user = await env.DB.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').bind('admin').first();
    }
  }

  const ok = user && Number(user.active) === 1 && await verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) {
    const updated = await env.DB.prepare(`INSERT INTO login_attempts(attempt_key,fail_count,blocked_until,updated_at) VALUES(?,1,0,?)
      ON CONFLICT(attempt_key) DO UPDATE SET
      fail_count=CASE WHEN login_attempts.updated_at < ? THEN 1 ELSE login_attempts.fail_count+1 END,
      blocked_until=CASE WHEN login_attempts.updated_at < ? THEN 0 WHEN login_attempts.fail_count+1 >= ? THEN ? ELSE 0 END,
      updated_at=excluded.updated_at RETURNING fail_count,blocked_until`)
      .bind(attemptKey,nowSec,nowSec-LOGIN_BLOCK_SECONDS,nowSec-LOGIN_BLOCK_SECONDS,LOGIN_MAX_FAILS,nowSec+LOGIN_BLOCK_SECONDS).first();
    const blockedUntil = Number(updated.blocked_until);

    return json({ message: blockedUntil ? '尝试次数过多，请 10 分钟后再试' : '用户名或密码不正确' }, blockedUntil ? 429 : 401,
      blockedUntil ? { 'Retry-After': String(LOGIN_BLOCK_SECONDS) } : undefined);
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE attempt_key = ?').bind(attemptKey).run();
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowSec).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)')
    .bind(tokenHash, user.id, nowSec + SESSION_SECONDS, now, now).run();
  return json({ authenticated: true, user: publicUser(user) }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`
  });
}

async function logout(request, env) {
  const token = cookieValue(request.headers.get('Cookie') || '', SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
}

async function getAuth(request, env) {
  const token = cookieValue(request.headers.get('Cookie') || '', SESSION_COOKIE);
  if (!token) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`SELECT s.token_hash,s.expires_at,u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).bind(await sha256Hex(token), nowSec).first();
  if (!row) return null;
  // Lightweight sliding activity marker; expiry itself stays fixed at 30 days.
  if (Math.random() < 0.1) await env.DB.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').bind(new Date().toISOString(), row.token_hash).run();
  return { user: row };
}

async function listRecords(env, url) {
  const date = String(url.searchParams.get('date') || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ message: '日期格式不正确' }, 400);
  const result = await env.DB.prepare(`SELECT r.*,cu.display_name AS created_by_name,uu.display_name AS updated_by_name
    FROM records r LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users uu ON uu.id=r.updated_by
    WHERE r.record_date=? ORDER BY r.record_time DESC,r.updated_at DESC`).bind(date).all();
  return json({ records: (result.results || []).map(dbRecordToClient) });
}

async function latestRecords(env) {
  const result = await env.DB.prepare(`SELECT DISTINCT ON (r.type) r.*,cu.display_name AS created_by_name,uu.display_name AS updated_by_name
    FROM records r LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users uu ON uu.id=r.updated_by
    WHERE r.type IN ('feed','elimination') ORDER BY r.type,r.record_date DESC,r.record_time DESC,r.updated_at DESC`).all();
  const latest = {};
  for (const row of result.results || []) latest[row.type] = dbRecordToClient(row);
  return json({ latest });
}

async function saveRecord(request, env, user) {
  const body = await safeJson(request);
  const rec = sanitizeRecord(body);
  if (!rec) return json({ message: '记录内容不完整或格式不正确' }, 400);
  const now = new Date().toISOString();
  const exists = await env.DB.prepare('SELECT id,created_by,created_at FROM records WHERE id=?').bind(rec.id).first();
  const createdBy = exists?.created_by || user.id;
  const createdAt = exists?.created_at || now;
  await env.DB.prepare(`INSERT INTO records(id,record_date,record_time,type,data_json,note,created_by,updated_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_date=excluded.record_date,record_time=excluded.record_time,
    type=excluded.type,data_json=excluded.data_json,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .bind(rec.id, rec.date, rec.time, rec.type, JSON.stringify(rec.data), rec.note, createdBy, user.id, createdAt, now).run();
  const saved = await env.DB.prepare(`SELECT r.*,cu.display_name AS created_by_name,uu.display_name AS updated_by_name FROM records r
    LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users uu ON uu.id=r.updated_by WHERE r.id=?`).bind(rec.id).first();
  return json({ record: dbRecordToClient(saved) });
}

async function deleteRecord(env, id) {
  await env.DB.prepare('DELETE FROM records WHERE id=?').bind(id).run();
  return json({ ok: true });
}

async function exportRecords(env, user) {
  const result = await env.DB.prepare(`SELECT r.*,cu.display_name AS created_by_name,uu.display_name AS updated_by_name
    FROM records r LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users uu ON uu.id=r.updated_by ORDER BY r.record_date,r.record_time`).all();
  return json({ version: 4, storage: 'neon-postgres', exportedAt: new Date().toISOString(), exportedBy: user.display_name,
    settings: await readSettings(env), records: (result.results || []).map(dbRecordToClient) });
}

async function importRecords(request, env, user) {
  if (user.role !== 'admin') return json({ message: '仅管理员可导入备份' }, 403);
  const body = await safeJson(request);
  if (!Array.isArray(body?.records) || body.records.length > 200) return json({ message: '备份文件格式不正确' }, 400);
  const now = new Date().toISOString();
  let imported = 0; const statements=[];
  for (const raw of body.records) {
    const rec = sanitizeRecord(raw);
    if (!rec) continue;
    statements.push(env.DB.prepare(`INSERT INTO records(id,record_date,record_time,type,data_json,note,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_date=excluded.record_date,record_time=excluded.record_time,
      type=excluded.type,data_json=excluded.data_json,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(rec.id, rec.date, rec.time, rec.type, JSON.stringify(rec.data), rec.note, user.id, user.id, now, now));
    imported++;
  }
  for(let i=0;i<statements.length;i+=40) await env.DB.batch(statements.slice(i,i+40));
  return json({ ok: true, imported });
}

async function listUsers(env, actor) {
  if (actor.role !== 'admin') return json({ message: '仅管理员可管理用户' }, 403);
  const result = await env.DB.prepare('SELECT id,username,display_name,role,active,created_at,updated_at FROM users ORDER BY created_at').all();
  return json({ users: (result.results || []).map(publicUser) });
}

async function createUser(request, env, actor) {
  if (actor.role !== 'admin') return json({ message: '仅管理员可新增用户' }, 403);
  const body = await safeJson(request);
  const username = normalizeUsername(body?.username);
  const displayName = String(body?.displayName || '').trim().slice(0, 30);
  const password = String(body?.password || '');
  const role = body?.role === 'admin' ? 'admin' : 'user';
  if (!validUsername(username)) return json({ message: '用户名需为 2–32 位文字、数字、点、下划线或短横线' }, 400);
  if (!displayName) return json({ message: '请输入显示名称' }, 400);
  if (password.length < 6 || password.length > 128) return json({ message: '密码至少 6 位' }, 400);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?)').bind(username).first();
  if (exists) return json({ message: '用户名已存在' }, 409);
  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString(), id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO users(id,username,display_name,password_hash,password_salt,role,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,1,?,?)`).bind(id, username, displayName, hash, salt, role, now, now).run();
  const created = await env.DB.prepare('SELECT id,username,display_name,role,active,created_at,updated_at FROM users WHERE id=?').bind(id).first();
  return json({ user: publicUser(created) }, 201);
}

async function updateUser(request, env, actor, id) {
  if (actor.role !== 'admin') return json({ message: '仅管理员可管理用户' }, 403);
  const target = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  if (!target) return json({ message: '用户不存在' }, 404);
  const body = await safeJson(request);
  const now = new Date().toISOString();

  if (typeof body?.displayName === 'string') {
    const displayName = body.displayName.trim().slice(0, 30);
    if (!displayName) return json({ message: '显示名称不能为空' }, 400);
    await env.DB.prepare('UPDATE users SET display_name=?,updated_at=? WHERE id=?').bind(displayName, now, id).run();
  }
  if (typeof body?.active === 'boolean') {
    if (id === actor.id && body.active === false) return json({ message: '不能停用当前登录用户' }, 400);
    await env.DB.prepare('UPDATE users SET active=?,updated_at=? WHERE id=?').bind(body.active ? 1 : 0, now, id).run();
    if (!body.active) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
  }
  if (typeof body?.password === 'string' && body.password.length) {
    if (body.password.length < 6 || body.password.length > 128) return json({ message: '密码至少 6 位' }, 400);
    const { hash, salt } = await hashPassword(body.password);
    await env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').bind(hash, salt, now, id).run();
    if (id !== actor.id) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
  }
  const updated = await env.DB.prepare('SELECT id,username,display_name,role,active,created_at,updated_at FROM users WHERE id=?').bind(id).first();
  return json({ user: publicUser(updated) });
}

function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || crypto.randomUUID()).slice(0, 100);
  const date = String(raw.date || '');
  const time = String(raw.time || '');
  let type = String(raw.type || '');
  if (type === 'urine' || type === 'stool') type = 'elimination';
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !['feed','elimination','abnormal','other'].includes(type)) return null;
  const parsedDate = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0,10) !== date || Number(time.slice(0,2)) > 23 || Number(time.slice(3)) > 59) return null;
  const note = String(raw.note || '').trim().slice(0, 1000);
  const data = {};
  if (type === 'feed') {
    data.feedMode = ['奶粉/瓶喂','母乳瓶喂','亲喂'].includes(raw.feedMode) ? raw.feedMode : '奶粉/瓶喂';
    if (data.feedMode === '亲喂') data.duration = clampNumber(raw.duration, 0, 180);
    else data.amount = clampNumber(raw.amount, 0, 500);
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
  } else {
    data.otherTitle = String(raw.otherTitle || '其它记录').trim().slice(0, 80) || '其它记录';
  }
  return { id, date, time, type, note, data };
}

function dbRecordToClient(row) {
  let data = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch {}
  return {
    id: row.id, date: row.record_date, time: row.record_time, type: row.type, note: row.note || '', ...data,
    createdByName: row.created_by_name || '', updatedByName: row.updated_by_name || '', createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, active: Number(row.active) === 1, createdAt: row.created_at };
}

function normalizeUsername(v) { return String(v || '').trim().slice(0, 32); }
function validUsername(v) { return /^[\p{L}\p{N}_.-]{2,32}$/u.test(v); }
function clampNumber(v, min, max) { const n = Number(v || 0); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0; }
async function safeJson(request) {
  if (!request.body) return null;
  const reader=request.body.getReader(), chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>2*1024*1024){await reader.cancel();throw Object.assign(new Error('请求内容过大'),{status:413});}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw Object.assign(new Error('JSON 格式不正确'),{status:400});}
}

function cookieValue(cookie, name) {
  const part = cookie.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

function randomToken(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a); return bytesToBase64Url(a);
}
function bytesToBase64Url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64UrlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const raw = atob(s); return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: bytesToBase64Url(new Uint8Array(bits)), salt: bytesToBase64Url(salt) };
}
async function verifyPassword(password, salt, expected) {
  const actual = (await hashPassword(password, base64UrlToBytes(salt))).hash;
  return safeEqual(actual, expected);
}
async function safeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a)), bb = new TextEncoder().encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0; for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i]; return diff === 0;
}

function json(data, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return withSecurityHeaders(new Response(JSON.stringify(data), { status, headers }), true);
}
function withSecurityHeaders(response, api) {
  const h = new Headers(response.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Frame-Options', 'DENY');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!api && (h.get('Content-Type') || '').includes('text/html')) {
    h.set('Cache-Control', 'no-cache');
    h.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}
