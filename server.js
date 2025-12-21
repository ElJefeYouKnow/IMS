// Force Node to ignore self-signed cert errors (managed DBs often use custom CAs).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// Simple in-memory session store (replace with Redis/DB for production)
const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
const SESSION_COOKIE = 'sid';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'; // set true in production with HTTPS
const loginAttempts = new Map(); // email -> {count, lockUntil}

const app = express();
const PORT = process.env.PORT || 8000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ims';
// Force SSL with relaxed cert validation to avoid self-signed errors on managed DBs.
// Override by setting DATABASE_SSL_REJECT_UNAUTHORIZED=true if you want strict checking with a valid CA.
const sslRootCertPath = process.env.DATABASE_SSL_CA || process.env.PGSSLROOTCERT;
let ca;
if (sslRootCertPath) {
  try {
    ca = fs.readFileSync(path.resolve(sslRootCertPath)).toString();
  } catch (e) {
    console.warn('Could not read SSL CA file at', sslRootCertPath, e.message);
  }
}
const sslConfig = {
  // Always relax cert validation unless you remove or override this in code.
  rejectUnauthorized: false,
  ca,
};
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslConfig,
});

// Behind proxies (App Platform/Cloudflare), trust forwarded headers for rate limiting + IPs.
app.set('trust proxy', 1);

app.use(express.json());
// Disable etags and caching for HTML/CSS/JS so UI changes propagate immediately
app.disable('etag');
app.use((req, res, next) => {
  if (/\.(html|css|js|json)$/i.test(req.path)) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
// Serve static assets but avoid auto-serving empty index.html; we route "/" manually.
app.use(express.static(path.join(__dirname), { index: false, cacheControl: false, etag: false }));
app.use(helmet());

// Prevent browser caching of HTML so UI changes propagate immediately.
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
app.use(['/api/auth/login', '/api/auth/register'], authLimiter);

// Protect all API routes (except auth) with session auth
app.use((req, res, next) => {
  if (req.path.startsWith('/api/auth')) return next();
  if (req.path.startsWith('/api')) return requireAuth(req, res, next);
  next();
});

// Helpers
function newId() {
  return 'itm_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
}

async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(password, salt);
  // store bcrypt hash in hash column; keep salt column for backward compat marker
  return { salt: 'bcrypt', hash };
}

function verifyPassword(password, salt, hash) {
  // Support legacy HMAC hashes
  if (hash && hash.startsWith('$2')) {
    return bcrypt.compareSync(password, hash);
  }
  const h = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return h === hash;
}

function safeUser(u) {
  return { id: u.id, email: u.email, name: u.name || '', role: u.role || 'user', tenantId: u.tenantid || u.tenantId, createdAt: u.createdat || u.createdAt };
}

async function runAsync(sql, params = []) {
  return pool.query(sql, params);
}
async function allAsync(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}
async function getAsync(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0];
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const [k, v] = part.trim().split('=');
    acc[k] = decodeURIComponent(v || '');
    return acc;
  }, {});
}

function createSession(userId) {
  const token = crypto.createHmac('sha256', SESSION_SECRET).update(userId + Date.now().toString() + Math.random().toString()).digest('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { userId, expires });
  return token;
}

function getSession(token) {
  const sess = token && sessions.get(token);
  if (!sess) return null;
  if (sess.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return sess;
}

async function loadUserById(id) {
  return getAsync('SELECT * FROM users WHERE id=$1', [id]);
}

async function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  const sess = getSession(token);
  if (!sess) return res.status(401).json({ error: 'unauthorized' });
  const user = await loadUserById(sess.userId);
  if (!user) {
    sessions.delete(token);
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.user = user;
  next();
}
async function initDb() {
  await runAsync(`CREATE TABLE IF NOT EXISTS tenants(
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    createdAt BIGINT
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS items(
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    unitPrice NUMERIC,
    description TEXT,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS inventory(
    id TEXT PRIMARY KEY,
    code TEXT REFERENCES items(code),
    name TEXT,
    qty INTEGER NOT NULL,
    location TEXT,
    jobId TEXT,
    notes TEXT,
    ts BIGINT,
    type TEXT,
    status TEXT,
    reason TEXT,
    returnDate TEXT,
    eta TEXT,
    userEmail TEXT,
    userName TEXT,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS jobs(
    code TEXT PRIMARY KEY,
    name TEXT,
    scheduleDate TEXT,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    role TEXT NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    createdAt BIGINT,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'
  )`);
  // Backfill tenant columns if the DB was created earlier
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`UPDATE items SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE inventory SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE jobs SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE users SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_code ON inventory(code)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_job ON inventory(jobId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_items_tenant ON items(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_tenant ON inventory(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenantId)');

  const row = await getAsync('SELECT COUNT(*) as c FROM users');
  if (row?.c === 0) {
    const tenantId = 'default';
    await runAsync(`INSERT INTO tenants(id,code,name,createdAt) VALUES($1,$2,$3,$4)
      ON CONFLICT (id) DO NOTHING`, [tenantId, 'default', 'Default Tenant', Date.now()]);
    const pwd = 'ChangeMe123!';
    const { salt, hash } = await hashPassword(pwd);
    const user = { id: newId(), email: 'admin@example.com', name: 'Admin', role: 'admin', salt, hash, createdAt: Date.now(), tenantId };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.tenantId]);
    console.log('Seeded default tenant + admin: admin@example.com / ChangeMe123! (change after login).');
  }
}
initDb().catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});

function statusForType(type) {
  if (type === 'ordered') return 'ordered';
  if (type === 'in') return 'in-stock';
  if (type === 'out') return 'checked-out';
  if (type === 'reserve') return 'reserved';
  if (type === 'return') return 'returned';
  return 'unknown';
}

async function itemExists(code, tenantIdVal) {
  const row = await getAsync('SELECT 1 FROM items WHERE code=$1 AND tenantId=$2 LIMIT 1', [code, tenantIdVal]);
  return !!row;
}

async function calcAvailability(code, tenantIdVal) {
  const row = await getAsync(`
    SELECT COALESCE(SUM(
      CASE 
        WHEN type='in' THEN qty
        WHEN type='return' THEN qty
        WHEN type='reserve' THEN -qty
        WHEN type='out' THEN -qty
        ELSE 0 END
    ),0) AS available
    FROM inventory WHERE code = $1 AND tenantId=$2
  `, [code, tenantIdVal]);
  return row?.available || 0;
}

async function calcOutstandingCheckout(code, jobId, tenantIdVal) {
  const params = [code, tenantIdVal];
  let jobClause = '';
  if (jobId) {
    jobClause = 'AND jobId = $3';
    params.push(jobId);
  } else {
    jobClause = "AND (jobId IS NULL OR jobId = '')";
  }
  const row = await getAsync(`
    SELECT COALESCE(SUM(CASE WHEN type='out' THEN qty WHEN type='return' THEN -qty ELSE 0 END),0) as outstanding
    FROM inventory WHERE code=$1 AND tenantId=$2 ${jobClause}
  `, params);
  return Math.max(0, row?.outstanding || 0);
}

function requireRole(role) {
  return (req, res, next) => {
    const userRole = (req.user && req.user.role || '').toLowerCase();
    if (userRole !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}
function tenantId(req) {
  return (req.user && (req.user.tenantid || req.user.tenantId)) || 'default';
}

// INVENTORY
app.get('/api/inventory', async (req, res) => {
  try {
    const type = req.query.type;
    const t = tenantId(req);
    const rows = type ? await allAsync('SELECT * FROM inventory WHERE tenantId=$1 AND type = $2', [t, type]) : await allAsync('SELECT * FROM inventory WHERE tenantId=$1', [t]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/inventory', async (req, res) => {
  try {
    const { code, name, category, unitPrice, qty, location, jobId, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const t = tenantId(req);
    const exists = await itemExists(code, t);
    if (!exists) {
      if (!name) return res.status(400).json({ error: 'unknown item code; provide name to create' });
      const price = unitPrice === undefined || unitPrice === null || Number.isNaN(Number(unitPrice)) ? null : Number(unitPrice);
      await runAsync(`INSERT INTO items(code,name,category,unitPrice,tenantId)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (code) DO NOTHING`, [code, name, category || null, price, t]);
    }
    const entry = { id: newId(), code, name, qty: qtyNum, location, jobId, notes, ts: ts || Date.now(), type: 'in', status: statusForType('in'), userEmail: req.body.userEmail, userName: req.body.userName, tenantId: t };
    await runAsync(`INSERT INTO inventory(id,code,name,qty,location,jobId,notes,ts,type,status,userEmail,userName,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [entry.id, entry.code, entry.name, entry.qty, entry.location, entry.jobId, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName, t]);
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/inventory-checkout', async (req, res) => {
  try {
    const { code, jobId, qty, reason, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const t = tenantId(req);
    if (!(await itemExists(code, t))) return res.status(400).json({ error: 'unknown item code' });
    const available = await calcAvailability(code, t);
    if (qtyNum > available) return res.status(400).json({ error: 'insufficient stock', available });
    const entry = { id: newId(), code, jobId, qty: qtyNum, reason, notes, ts: ts || Date.now(), type: 'out', status: statusForType('out'), userEmail: req.body.userEmail, userName: req.body.userName, tenantId: t };
    await runAsync(`INSERT INTO inventory(id,code,jobId,qty,reason,notes,ts,type,status,userEmail,userName,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [entry.id, entry.code, entry.jobId, entry.qty, entry.reason, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName, t]);
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/inventory', async (req, res) => {
  try {
    const type = req.query.type;
    const t = tenantId(req);
    if (type) await runAsync('DELETE FROM inventory WHERE tenantId=$1 AND type = $2', [t, type]);
    else await runAsync('DELETE FROM inventory WHERE tenantId=$1', [t]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/inventory-checkout', async (req, res) => {
  try {
    await runAsync("DELETE FROM inventory WHERE type='out' AND tenantId=$1", [tenantId(req)]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/inventory-reserve', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM inventory WHERE type=$1 AND tenantId=$2', ['reserve', tenantId(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/inventory-reserve', async (req, res) => {
  try {
    const { code, jobId, qty, returnDate, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if (!code || !jobId || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code, jobId and positive qty required' });
    const t = tenantId(req);
    if (!(await itemExists(code, t))) return res.status(400).json({ error: 'unknown item code' });
    const available = await calcAvailability(code, t);
    if (qtyNum > available) return res.status(400).json({ error: 'insufficient stock', available });
    const entry = { id: newId(), code, jobId, qty: qtyNum, returnDate, notes, ts: ts || Date.now(), type: 'reserve', status: statusForType('reserve'), userEmail: req.body.userEmail, userName: req.body.userName, tenantId: t };
    await runAsync(`INSERT INTO inventory(id,code,jobId,qty,returnDate,notes,ts,type,status,userEmail,userName,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [entry.id, entry.code, entry.jobId, entry.qty, entry.returnDate, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName, t]);
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/inventory-reserve', async (req, res) => {
  try {
    await runAsync("DELETE FROM inventory WHERE type='reserve' AND tenantId=$1", [tenantId(req)]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/inventory-return', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM inventory WHERE type=$1', ['return']);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/inventory-return', async (req, res) => {
  try {
    const { code, jobId, qty, reason, location, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const t = tenantId(req);
    if (!(await itemExists(code, t))) return res.status(400).json({ error: 'unknown item code' });
    const outstanding = await calcOutstandingCheckout(code, jobId, t);
    if (outstanding <= 0) return res.status(400).json({ error: 'no matching checkout to return' });
    if (qtyNum > outstanding) return res.status(400).json({ error: 'return exceeds outstanding checkout', outstanding });
    const entry = { id: newId(), code, jobId, qty: qtyNum, reason, location, notes, ts: ts || Date.now(), type: 'return', status: statusForType('return'), userEmail: req.body.userEmail, userName: req.body.userName, tenantId: t };
    await runAsync(`INSERT INTO inventory(id,code,jobId,qty,reason,location,notes,ts,type,status,userEmail,userName,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [entry.id, entry.code, entry.jobId, entry.qty, entry.reason, entry.location, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName, t]);
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/inventory-return', async (req, res) => {
  try {
    await runAsync("DELETE FROM inventory WHERE type='return' AND tenantId=$1", [tenantId(req)]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ITEMS
app.get('/api/items', async (req, res) => {
  try {
    const rows = await readItems(tenantId(req));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/items', async (req, res) => {
  try {
    const { code, oldCode, name, category, unitPrice, description } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const userRole = (req.user?.role || '').toLowerCase();
    const t = tenantId(req);
    const exists = await itemExists(code, t);
    if (oldCode && oldCode !== code && userRole !== 'admin') return res.status(403).json({ error: 'only admin can rename items' });
    if (exists && userRole !== 'admin' && (!oldCode || oldCode === code)) return res.status(403).json({ error: 'only admin can update existing items' });
    const price = unitPrice === undefined || unitPrice === null || Number.isNaN(Number(unitPrice)) ? null : Number(unitPrice);
    if (oldCode && oldCode !== code) await runAsync('DELETE FROM items WHERE code=$1 AND tenantId=$2', [oldCode, t]);
    await runAsync(`INSERT INTO items(code,name,category,unitPrice,description)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, unitPrice=EXCLUDED.unitPrice, description=EXCLUDED.description, tenantId=EXCLUDED.tenantId`,
      [code, name, category, price, description, t]);
    res.status(201).json({ code, name, category, unitPrice: price, description, tenantId: t });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/items/:code', requireRole('admin'), async (req, res) => {
  try {
    await runAsync('DELETE FROM items WHERE code=$1 AND tenantId=$2', [req.params.code, tenantId(req)]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// AUTH + USERS
app.post('/api/tenants', async (req, res) => {
  try {
    const { code, name, adminEmail, adminPassword, adminName } = req.body;
    if (!code || !name || !adminEmail || !adminPassword) return res.status(400).json({ error: 'code, name, adminEmail, adminPassword required' });
    if (adminPassword.length < 10) return res.status(400).json({ error: 'admin password too weak' });
    const normCode = code.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!normCode) return res.status(400).json({ error: 'invalid code' });
    const exists = await getAsync('SELECT id FROM tenants WHERE code=$1', [normCode]);
    if (exists) return res.status(400).json({ error: 'tenant already exists' });
    const tenantId = newId();
    await runAsync('INSERT INTO tenants(id,code,name,createdAt) VALUES($1,$2,$3,$4)', [tenantId, normCode, name, Date.now()]);
    const { salt, hash } = await hashPassword(adminPassword);
    const user = { id: newId(), email: adminEmail, name: adminName || name || 'Admin', role: 'admin', salt, hash, createdAt: Date.now(), tenantId };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.tenantId]);
    const token = createSession(user.id);
    setSessionCookie(res, token);
    res.status(201).json({ tenant: { id: tenantId, code: normCode, name }, admin: safeUser(user) });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, role: requestedRole, adminKey, tenantCode } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 10) return res.status(400).json({ error: 'password too weak' });
    const tenant = await getAsync('SELECT * FROM tenants WHERE code=$1', [tenantCode || 'default']);
    if (!tenant) return res.status(400).json({ error: 'invalid tenant' });
    const existing = await getAsync('SELECT id FROM users WHERE email=$1 AND tenantId=$2', [email, tenant.id]);
    if (existing) return res.status(400).json({ error: 'email already exists' });
    const totalCount = (await getAsync('SELECT COUNT(*) as c FROM users WHERE tenantId=$1', [tenant.id])).c;
    let role = totalCount === 0 ? 'admin' : 'user';
    const adminSecret = process.env.ADMIN_SIGNUP_SECRET;
    if (requestedRole === 'admin') {
      if (!adminSecret) return res.status(400).json({ error: 'admin signups disabled (missing ADMIN_SIGNUP_SECRET)' });
      const key = adminKey || req.headers['x-admin-signup'];
      if (key !== adminSecret) return res.status(403).json({ error: 'invalid admin signup key' });
      role = 'admin';
    }
    const { salt, hash } = await hashPassword(password);
    const user = { id: newId(), email, name, role, salt, hash, createdAt: Date.now(), tenantId: tenant.id };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.tenantId]);
    const token = createSession(user.id);
    setSessionCookie(res, token);
    res.status(201).json(safeUser(user));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, tenantCode } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const attemptKey = `${email}:${tenantCode || 'default'}`;
    const attempt = loginAttempts.get(attemptKey) || { count: 0, lockUntil: 0 };
    if (attempt.lockUntil > Date.now()) return res.status(429).json({ error: 'account locked, try later' });

    const user = await getAsync('SELECT * FROM users WHERE email=$1 AND tenantId=(SELECT id FROM tenants WHERE code=$2)', [email, tenantCode || 'default']);
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      attempt.count += 1;
      if (attempt.count >= MAX_ATTEMPTS) {
        attempt.lockUntil = Date.now() + LOCK_MS;
        attempt.count = 0;
      }
      loginAttempts.set(attemptKey, attempt);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    loginAttempts.delete(attemptKey);
    const token = createSession(user.id);
    setSessionCookie(res, token);
    res.json(safeUser(user));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(safeUser(req.user));
});

app.get('/api/users', requireRole('admin'), async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM users WHERE tenantId=$1', [tenantId(req)]);
    res.json(rows.map(safeUser));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  try {
    const { email, password, name, role = 'user' } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 10) return res.status(400).json({ error: 'password too weak' });
    const t = tenantId(req);
    const exists = await getAsync('SELECT id FROM users WHERE email=$1 AND tenantId=$2', [email, t]);
    if (exists) return res.status(400).json({ error: 'email already exists' });
    const { salt, hash } = await hashPassword(password);
    const user = { id: newId(), email, name, role, salt, hash, createdAt: Date.now(), tenantId: t };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.tenantId]);
    res.status(201).json(safeUser(user));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.put('/api/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { email, name, role, password } = req.body;
    const t = tenantId(req);
    const user = await getAsync('SELECT * FROM users WHERE id=$1 AND tenantId=$2', [id, t]);
    if (!user) return res.status(404).json({ error: 'not found' });
    if (email) {
      const dup = await getAsync('SELECT id FROM users WHERE email=$1 AND id<>$2 AND tenantId=$3', [email, id, t]);
      if (dup) return res.status(400).json({ error: 'email already exists' });
    }
    let salt = user.salt;
    let hash = user.hash;
    if (password) {
      if (password.length < 10) return res.status(400).json({ error: 'password too weak' });
      const hashed = await hashPassword(password);
      salt = hashed.salt;
      hash = hashed.hash;
    }
    await runAsync('UPDATE users SET email=$1, name=$2, role=$3, salt=$4, hash=$5 WHERE id=$6 AND tenantId=$7',
      [email || user.email, name ?? user.name, role || user.role, salt, hash, id, t]);
    const updated = await getAsync('SELECT * FROM users WHERE id=$1 AND tenantId=$2', [id, t]);
    res.json(safeUser(updated));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// JOBS
app.get('/api/jobs', async (req, res) => {
  try {
    const rows = await readJobs(tenantId(req));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/jobs', requireRole('admin'), async (req, res) => {
  try {
    const { code, name, scheduleDate } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const t = tenantId(req);
    await runAsync(`INSERT INTO jobs(code,name,scheduleDate) VALUES($1,$2,$3)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, scheduleDate=EXCLUDED.scheduleDate`, [code, name || '', scheduleDate || null]);
    await runAsync('UPDATE jobs SET tenantId=$1 WHERE code=$2', [t, code]);
    res.status(201).json({ code, name: name || '', scheduleDate: scheduleDate || null, tenantId: t });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/jobs/:code', requireRole('admin'), async (req, res) => {
  try {
    await runAsync('DELETE FROM jobs WHERE code=$1 AND tenantId=$2', [req.params.code, tenantId(req)]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ADMIN ORDERS
app.post('/api/inventory-order', requireRole('admin'), async (req, res) => {
  try {
    const { code, name, qty, eta, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const t = tenantId(req);
    const exists = await itemExists(code, t);
    if (!exists) {
      await runAsync('INSERT INTO items(code,name,category,unitPrice,description,tenantId) VALUES($1,$2,$3,$4,$5,$6)', [code, name || code, '', null, '', t]);
    }
    const entry = { id: newId(), code, name, qty: qtyNum, eta, notes, ts: ts || Date.now(), type: 'ordered', status: statusForType('ordered'), userEmail: req.body.userEmail, userName: req.body.userName, tenantId: t };
    await runAsync(`INSERT INTO inventory(id,code,name,qty,eta,notes,ts,type,status,userEmail,userName,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [entry.id, entry.code, entry.name, entry.qty, entry.eta, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName, entry.tenantId]);
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// METRICS
app.get('/api/metrics', async (req, res) => {
  try {
    const now = Date.now();
    const row = await getAsync(`
      SELECT 
        COALESCE(SUM(CASE WHEN type='in' THEN qty WHEN type='return' THEN qty WHEN type='out' THEN -qty WHEN type='reserve' THEN -qty ELSE 0 END),0) as availableunits,
        COALESCE(SUM(CASE WHEN type='reserve' THEN qty ELSE 0 END),0) as reservedunits,
        COALESCE(COUNT(DISTINCT CASE WHEN jobId IS NOT NULL AND jobId != '' THEN jobId END),0) as activejobs,
        COALESCE(SUM(CASE WHEN ts >= $1 THEN 1 ELSE 0 END),0) as txlast7
      FROM inventory
    `, [now - 7 * 24 * 60 * 60 * 1000]);
    const lowRows = await allAsync(`
      SELECT i.code, i.name,
        COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) as available,
        COALESCE(SUM(CASE WHEN inv.type='reserve' THEN inv.qty ELSE 0 END),0) as reserve
      FROM items i
      LEFT JOIN inventory inv ON inv.code = i.code
      GROUP BY i.code, i.name
      HAVING COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) > 0
        AND COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) <= 5
      ORDER BY available ASC
      LIMIT 20
    `);
    res.json({ ...row, lowStockCount: lowRows.length });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/low-stock', async (req, res) => {
  try {
    const rows = await allAsync(`
      SELECT i.code, i.name,
        COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) as available,
        COALESCE(SUM(CASE WHEN inv.type='reserve' THEN inv.qty ELSE 0 END),0) as reserve
      FROM items i
      LEFT JOIN inventory inv ON inv.code = i.code
      GROUP BY i.code, i.name
      HAVING COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) > 0
        AND COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) <= 5
      ORDER BY available ASC
      LIMIT 20
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/recent-activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10) || 10, 50);
    const rows = await allAsync('SELECT * FROM inventory WHERE tenantId=$1 ORDER BY ts DESC LIMIT $2', [tenantId(req), limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));

// Helpers to read common lists
async function readItems(tenantIdVal) {
  return allAsync('SELECT * FROM items WHERE tenantId=$1 ORDER BY name ASC', [tenantIdVal]);
}
async function readJobs(tenantIdVal) {
  return allAsync('SELECT * FROM jobs WHERE tenantId=$1 ORDER BY code ASC', [tenantIdVal]);
}
function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE });
}
