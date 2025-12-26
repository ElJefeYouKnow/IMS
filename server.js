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
const { Parser } = require('json2csv');

// Simple in-memory session store (replace with Redis/DB for production)
const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
const SESSION_COOKIE = 'sid';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'; // set true in production with HTTPS
const loginAttempts = new Map(); // email -> {count, lockUntil}
const AUDIT_ACTIONS = ['auth.login', 'auth.register', 'inventory.in', 'inventory.out', 'inventory.reserve', 'inventory.return', 'inventory.order', 'items.create', 'items.update', 'items.delete'];
const CHECKOUT_RETURN_WINDOW_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const DEV_EMAIL = normalizeEmail(process.env.DEV_DEFAULT_EMAIL || 'Dev@ManageX.com');
const DEV_PASSWORD = process.env.DEV_DEFAULT_PASSWORD || 'Dev123!';
const DEV_TENANT_CODE = process.env.DEV_TENANT_CODE || 'dev';
const DEV_TENANT_ID = process.env.DEV_TENANT_ID || DEV_TENANT_CODE;
const DEV_RESET_TOKEN = process.env.DEV_RESET_TOKEN || 'reset-all-data-now';

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

// Protect all API routes (except auth and tenant creation) with session auth
app.use((req, res, next) => {
  if (req.path.startsWith('/api/auth')) return next();
  if (req.path.startsWith('/api/tenants')) return next();
  if (req.path.startsWith('/api/dev')) {
    const devToken = req.headers['x-dev-token'] || req.headers['x-dev-reset'];
    if (devToken && devToken === DEV_RESET_TOKEN) return next();
  }
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
function normalizeTenantCode(code) {
  return (code || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'default';
}
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}
async function logAudit({ tenantId: tid, userId, action, details }) {
  const tenantId = tid || 'default';
  if (!AUDIT_ACTIONS.includes(action)) return;
  const entry = { id: newId(), tenantId, userId: userId || null, action, details: details || {}, ts: Date.now() };
  try { await runAsync('INSERT INTO audit_events(id,tenantId,userId,action,details,ts) VALUES($1,$2,$3,$4,$5,$6)', [entry.id, entry.tenantId, entry.userId, entry.action, entry.details, entry.ts]); }
  catch (e) { console.warn('audit log failed', e.message); }
}
async function enforceCheckoutAging(tenantIdVal) {
  const cutoff = Date.now() - CHECKOUT_RETURN_WINDOW_MS;
  await runAsync("UPDATE inventory SET status='used' WHERE tenantId=$1 AND type='out' AND status!='used' AND ts < $2", [tenantIdVal, cutoff]);
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
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
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
function currentUserId(req) {
  return (req.user && (req.user.id || req.user.userid)) || null;
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
  // Ensure default tenant exists before applying FK defaults
  const defaultTenantId = 'default';
  await runAsync(`INSERT INTO tenants(id,code,name,createdAt)
    VALUES($1,$2,$3,$4)
    ON CONFLICT (id) DO NOTHING`, [defaultTenantId, 'default', 'Default Tenant', Date.now()]);
  await runAsync(`INSERT INTO tenants(id,code,name,createdAt)
    VALUES($1,$2,$3,$4)
    ON CONFLICT (code) DO NOTHING`, [defaultTenantId, 'default', 'Default Tenant', Date.now()]);
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
  await runAsync(`CREATE TABLE IF NOT EXISTS audit_events(
    id TEXT PRIMARY KEY,
    tenantId TEXT REFERENCES tenants(id),
    userId TEXT,
    action TEXT,
    details JSONB,
    ts BIGINT
  )`);
  await runAsync('CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_events(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts)');
  // Multi-tenant safety: unique per tenant and FKs
  await runAsync('CREATE UNIQUE INDEX IF NOT EXISTS uq_items_code_tenant ON items(code, tenantId)');
  await runAsync('CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_code_tenant ON jobs(code, tenantId)');
  await runAsync('CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_tenant ON users(email, tenantId)');
  // Clean any legacy duplicate items per tenant before enforcing composite PK
  await runAsync(`
    WITH dup AS (
      SELECT ctid FROM (
        SELECT ctid, code, tenantId, ROW_NUMBER() OVER (PARTITION BY code, tenantId ORDER BY ctid) AS rn
        FROM items
      ) t WHERE rn > 1
    )
    DELETE FROM items WHERE ctid IN (SELECT ctid FROM dup)
  `);
  await runAsync('ALTER TABLE items DROP CONSTRAINT IF EXISTS items_pkey');
  await runAsync('ALTER TABLE items ADD CONSTRAINT items_pkey PRIMARY KEY (code, tenantId)');
  // Backfill missing items per tenant for existing inventory rows to satisfy FK
  await runAsync(`
    INSERT INTO items(code,name,category,description,tenantId)
    SELECT DISTINCT i.code, COALESCE(i.name, i.code), '', '', i.tenantId
    FROM inventory i
    LEFT JOIN items it ON it.code = i.code AND it.tenantId = i.tenantId
    WHERE it.code IS NULL
    ON CONFLICT (code, tenantId) DO NOTHING
  `);
  // Normalize empty jobId to NULL to satisfy FK checks
  await runAsync(`UPDATE inventory SET jobId = NULL WHERE jobId IS NULL OR jobId = ''`);
  // Backfill any jobs referenced by inventory rows
  await runAsync(`
    INSERT INTO jobs(code,name,scheduleDate,tenantId)
    SELECT DISTINCT inv.jobId, inv.jobId, NULL, inv.tenantId
    FROM inventory inv
    WHERE inv.jobId IS NOT NULL AND inv.jobId <> ''
    ON CONFLICT (code, tenantId) DO NOTHING
  `);
  await runAsync('ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_code_fkey');
  await runAsync(`DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_code_fk') THEN
      ALTER TABLE inventory ADD CONSTRAINT inventory_code_fk FOREIGN KEY (code, tenantId) REFERENCES items(code, tenantId);
    END IF;
  END$$;`);
  await runAsync('ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_jobid_fkey');
  await runAsync(`DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_jobid_fk') THEN
      ALTER TABLE inventory ADD CONSTRAINT inventory_jobid_fk FOREIGN KEY (jobId, tenantId) REFERENCES jobs(code, tenantId) ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;
  END$$;`);

  const row = await getAsync('SELECT COUNT(*) as c FROM users');
  if (row?.c === 0) {
    const tenantId = 'default';
    const pwd = 'ChangeMe123!';
    const { salt, hash } = await hashPassword(pwd);
    const user = { id: newId(), email: 'admin@example.com', name: 'Admin', role: 'admin', salt, hash, createdAt: Date.now(), tenantId };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.tenantId]);
    console.log('Seeded default tenant + admin: admin@example.com / ChangeMe123! (change after login).');
  }
  await ensureDevAccount();
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
  if (type === 'consume') return 'consumed';
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
        WHEN type='consume' THEN -qty
        ELSE 0 END
    ),0) AS available
    FROM inventory WHERE code = $1 AND tenantId=$2
  `, [code, tenantIdVal]);
  return row?.available || 0;
}
async function calcAvailabilityTx(client, code, tenantIdVal) {
  const rows = await client.query(
    `SELECT id,type,qty FROM inventory WHERE code = $1 AND tenantId=$2 FOR UPDATE`,
    [code, tenantIdVal]
  );
  return (rows.rows || []).reduce((sum,r)=>{
    const t = r.type;
    const q = Number(r.qty)||0;
    if(t==='in' || t==='return') return sum + q;
    if(t==='reserve' || t==='out' || t==='consume') return sum - q;
    return sum;
  },0);
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
async function calcOutstandingCheckoutTx(client, code, jobId, tenantIdVal) {
  const params = [code, tenantIdVal];
  let jobClause = '';
  if (jobId) {
    jobClause = 'AND jobId = $3';
    params.push(jobId);
  } else {
    jobClause = "AND (jobId IS NULL OR jobId = '')";
  }
  const rows = await client.query(
    `SELECT id,type,qty FROM inventory WHERE code=$1 AND tenantId=$2 ${jobClause} FOR UPDATE`,
    params
  );
  const outstanding = (rows.rows || []).reduce((sum,r)=>{
    const q = Number(r.qty)||0;
    if(r.type==='out') return sum + q;
    if(r.type==='return') return sum - q;
    return sum;
  },0);
  return Math.max(0, outstanding);
}

function requireRole(role) {
  return (req, res, next) => {
    const userRole = (req.user && req.user.role || '').toLowerCase();
    const userEmail = (req.user && req.user.email || '').toLowerCase();
    const isDev = userRole === 'dev' || userEmail === DEV_EMAIL.toLowerCase();
    if (!isDev && userRole !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}
function isDevUser(user) {
  const role = (user?.role || '').toLowerCase();
  const email = normalizeEmail(user?.email || '');
  const tenant = normalizeTenantCode(user?.tenantid || user?.tenantId || '');
  return role === 'dev' || email === DEV_EMAIL.toLowerCase() || tenant === normalizeTenantCode(DEV_TENANT_CODE);
}
function requireDev(req, res, next) {
  const token = req.headers['x-dev-token'] || req.headers['x-dev-reset'];
  if (token && token === DEV_RESET_TOKEN) return next();
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (!isDevUser(req.user)) return res.status(403).json({ error: 'forbidden' });
  next();
}
function tenantId(req) {
  return (req.user && (req.user.tenantid || req.user.tenantId)) || 'default';
}
async function loadItem(client, code, tenantIdVal) {
  const row = await client.query('SELECT * FROM items WHERE code=$1 AND tenantId=$2', [code, tenantIdVal]);
  return row.rows[0];
}

async function ensureItem(client, { code, name, category, unitPrice, tenantIdVal }) {
  let item = await loadItem(client, code, tenantIdVal);
  if (item) return item;
  if (!name) throw new Error('unknown item code; include a name to add it');
  const price = unitPrice === undefined || unitPrice === null || Number.isNaN(Number(unitPrice)) ? null : Number(unitPrice);
  await client.query(`INSERT INTO items(code,name,category,unitPrice,tenantId)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (code) DO NOTHING`, [code, name, category || null, price, tenantIdVal]);
  item = await loadItem(client, code, tenantIdVal);
  return item;
}

async function getLastCheckoutTs(client, code, jobId, tenantIdVal) {
  const params = [code, tenantIdVal];
  let jobClause = '';
  if (jobId) {
    jobClause = 'AND jobId=$3';
    params.push(jobId);
  } else {
    jobClause = "AND (jobId IS NULL OR jobId='')";
  }
  const row = await client.query(`SELECT MAX(ts) as last FROM inventory WHERE code=$1 AND tenantId=$2 AND type='out' ${jobClause}`, params);
  return row.rows[0]?.last || null;
}

async function ensureDevAccount() {
  // Upsert the dev account into the dev tenant, resetting password and role each start for consistency.
  const code = normalizeTenantCode(DEV_TENANT_CODE);
  const tenantId = DEV_TENANT_ID || code;
  await runAsync(`INSERT INTO tenants(id,code,name,createdAt)
    VALUES($1,$2,$3,$4)
    ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code, name=EXCLUDED.name`,
    [tenantId, code, 'Dev Tenant', Date.now()]);
  const { salt, hash } = await hashPassword(DEV_PASSWORD);
  await runAsync(`INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (email, tenantId) DO UPDATE SET role='dev', salt=EXCLUDED.salt, hash=EXCLUDED.hash, name=EXCLUDED.name`,
    [newId(), normalizeEmail(DEV_EMAIL), 'Dev', 'dev', salt, hash, Date.now(), tenantId]);
}

async function processInventoryEvent(client, { type, code, name, category, unitPrice, qty, location, jobId, notes, reason, ts, returnDate, userEmail, userName, tenantIdVal, requireRecentReturn }) {
  const qtyNum = Number(qty);
  if (!code || !qtyNum || qtyNum <= 0) throw new Error('code and positive qty required');
  const item = await ensureItem(client, { code, name, category, unitPrice, tenantIdVal });
  const nowTs = ts || Date.now();
  let status = statusForType(type);

  if (type === 'reserve') {
    const avail = await calcAvailabilityTx(client, code, tenantIdVal);
    if (qtyNum > avail) throw new Error('insufficient stock to reserve');
  }
  if (type === 'out') {
    await enforceCheckoutAging(tenantIdVal);
    const avail = await calcAvailabilityTx(client, code, tenantIdVal);
    if (qtyNum > avail) throw new Error('insufficient stock to checkout');
  }
  if (type === 'return') {
    const outstanding = await calcOutstandingCheckoutTx(client, code, jobId, tenantIdVal);
    if (outstanding <= 0) throw new Error('no matching checkout to return');
    if (qtyNum > outstanding) throw new Error('return exceeds outstanding checkout');
    if (requireRecentReturn) {
      const last = await getLastCheckoutTs(client, code, jobId, tenantIdVal);
      if (!last || (nowTs - last) > CHECKOUT_RETURN_WINDOW_MS) throw new Error('return window exceeded (5 days)');
    }
  }
  if (type === 'consume') {
    if (!reason) throw new Error('reason required for consumption');
    status = reason.toLowerCase().includes('lost') ? 'lost' : (reason.toLowerCase().includes('damage') ? 'damaged' : 'consumed');
    const avail = await calcAvailabilityTx(client, code, tenantIdVal);
    if (qtyNum > avail) throw new Error('insufficient stock to consume');
  }

  const entry = {
    id: newId(),
    code,
    name: item?.name || name,
    qty: qtyNum,
    location,
    jobId,
    notes,
    reason,
    returnDate,
    ts: nowTs,
    type,
    status,
    userEmail,
    userName,
    tenantId: tenantIdVal
  };
  await client.query(`INSERT INTO inventory(id,code,name,qty,location,jobId,notes,reason,returnDate,ts,type,status,userEmail,userName,tenantId)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [entry.id, entry.code, entry.name, entry.qty, entry.location, entry.jobId, entry.notes, entry.reason, entry.returnDate, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName, entry.tenantId]);
  return entry;
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
    const t = tenantId(req);
    const entry = await withTransaction(async (client) => {
      return processInventoryEvent(client, { type: 'in', code, name, category, unitPrice, qty, location, jobId, notes, ts, userEmail: req.body.userEmail, userName: req.body.userName, tenantIdVal: t });
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.in', details: { code, qty, jobId, location } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

app.post('/api/inventory-checkout', async (req, res) => {
  try {
    const { code, jobId, qty, reason, notes, ts } = req.body;
    const t = tenantId(req);
    const entry = await withTransaction(async (client) => {
      const tsNow = ts || Date.now();
      const due = tsNow + CHECKOUT_RETURN_WINDOW_MS;
      return processInventoryEvent(client, { type: 'out', code, jobId, qty, reason, notes, ts: tsNow, returnDate: new Date(due).toISOString(), userEmail: req.body.userEmail, userName: req.body.userName, tenantIdVal: t });
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.out', details: { code, qty, jobId } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
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
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const t = tenantId(req);
    const entry = await withTransaction(async (client) => {
      return processInventoryEvent(client, { type: 'reserve', code, jobId, qty, returnDate, notes, ts, userEmail: req.body.userEmail, userName: req.body.userName, tenantIdVal: t });
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.reserve', details: { code, qty, jobId, returnDate } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
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
    const t = tenantId(req);
    const entry = await withTransaction(async (client) => {
      return processInventoryEvent(client, { type: 'return', code, jobId, qty, reason, location, notes, ts, userEmail: req.body.userEmail, userName: req.body.userName, tenantIdVal: t, requireRecentReturn: true });
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.return', details: { code, qty, jobId, reason } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

app.delete('/api/inventory-return', async (req, res) => {
  try {
    await runAsync("DELETE FROM inventory WHERE type='return' AND tenantId=$1", [tenantId(req)]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// CONSUME / LOST / DAMAGED (admin-only)
app.post('/api/inventory-consume', requireRole('admin'), async (req, res) => {
  try {
    const { code, qty, reason, notes, ts } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const t = tenantId(req);
    const entry = await withTransaction(async (client) => {
      return processInventoryEvent(client, { type: 'consume', code, qty, reason, notes, ts, userEmail: req.body.userEmail, userName: req.body.userName, tenantIdVal: t });
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.out', details: { code, qty, reason } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

// ITEMS
app.get('/api/items', async (req, res) => {
  try {
    const rows = await readItems(tenantId(req));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/items', requireRole('admin'), async (req, res) => {
  try {
    const { code, oldCode, name, category, unitPrice, description } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const t = tenantId(req);
    const exists = await itemExists(code, t);
    const price = unitPrice === undefined || unitPrice === null || Number.isNaN(Number(unitPrice)) ? null : Number(unitPrice);
    if (oldCode && oldCode !== code) await runAsync('DELETE FROM items WHERE code=$1 AND tenantId=$2', [oldCode, t]);
    await runAsync(`INSERT INTO items(code,name,category,unitPrice,description,tenantId)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(code,tenantId) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, unitPrice=EXCLUDED.unitPrice, description=EXCLUDED.description, tenantId=EXCLUDED.tenantId`,
      [code, name, category, price, description, t]);
    await logAudit({ tenantId: t, userId: currentUserId(req), action: exists ? 'items.update' : 'items.create', details: { code } });
    res.status(201).json({ code, name, category, unitPrice: price, description, tenantId: t });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/items/:code', requireRole('admin'), async (req, res) => {
  try {
    await runAsync('DELETE FROM items WHERE code=$1 AND tenantId=$2', [req.params.code, tenantId(req)]);
    await logAudit({ tenantId: tenantId(req), userId: currentUserId(req), action: 'items.delete', details: { code: req.params.code } });
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// AUTH + USERS
app.post('/api/tenants', async (req, res) => {
  try {
  const { code, name, adminEmail, adminPassword, adminName } = req.body;
  if (!code || !name || !adminEmail || !adminPassword) return res.status(400).json({ error: 'code, name, adminEmail, adminPassword required' });
  if (adminPassword.length < 10) return res.status(400).json({ error: 'admin password too weak' });
  const normCode = normalizeTenantCode(code);
  if (!normCode) return res.status(400).json({ error: 'invalid code' });
  const exists = await getAsync('SELECT id FROM tenants WHERE code=$1', [normCode]);
  if (exists) return res.status(400).json({ error: 'tenant already exists' });
  const tenantId = newId();
  await runAsync('INSERT INTO tenants(id,code,name,createdAt) VALUES($1,$2,$3,$4)', [tenantId, normCode, name, Date.now()]);
  const { salt, hash } = await hashPassword(adminPassword);
  const adminEmailNorm = normalizeEmail(adminEmail);
  const user = { id: newId(), email: adminEmailNorm, name: adminName || name || 'Admin', role: 'admin', salt, hash, createdAt: Date.now(), tenantId };
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
    const emailNorm = normalizeEmail(email);
    if (!emailNorm || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 10) return res.status(400).json({ error: 'password too weak' });
    const tenant = await getAsync('SELECT * FROM tenants WHERE code=$1', [normalizeTenantCode(tenantCode)]);
    if (!tenant) return res.status(400).json({ error: 'invalid tenant' });
    const existing = await getAsync('SELECT id FROM users WHERE email=$1 AND tenantId=$2', [emailNorm, tenant.id]);
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
    const user = { id: newId(), email: emailNorm, name, role, salt, hash, createdAt: Date.now(), tenantId: tenant.id };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.tenantId]);
    const token = createSession(user.id);
    setSessionCookie(res, token);
    await logAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.register', details: { email } });
    res.status(201).json(safeUser(user));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, tenantCode } = req.body;
    const emailNorm = normalizeEmail(email);
    if (!emailNorm || !password) return res.status(400).json({ error: 'email and password required' });
    const normalizedTenant = normalizeTenantCode(tenantCode);
    const isDevEmail = emailNorm === DEV_EMAIL.toLowerCase();
    const attemptKey = `${emailNorm}:${normalizedTenant}`;
    const attempt = loginAttempts.get(attemptKey) || { count: 0, lockUntil: 0 };
    if (!isDevEmail && attempt.lockUntil > Date.now()) return res.status(429).json({ error: 'account locked, try later' });

    const tenant = await getAsync('SELECT * FROM tenants WHERE code=$1', [normalizedTenant]);
    if (!tenant) return res.status(400).json({ error: 'Business code not found' });

    const user = await getAsync('SELECT * FROM users WHERE LOWER(email)=LOWER($1) AND tenantId=$2', [emailNorm, tenant.id]);
    if (!user) {
      if (!isDevEmail) {
        attempt.count += 1;
        if (attempt.count >= MAX_ATTEMPTS) {
          attempt.lockUntil = Date.now() + LOCK_MS;
          attempt.count = 0;
        }
        loginAttempts.set(attemptKey, attempt);
      }
      return res.status(401).json({ error: 'Email not found for this business' });
    }
    if (!verifyPassword(password, user.salt, user.hash)) {
      if (!isDevEmail) {
        attempt.count += 1;
        if (attempt.count >= MAX_ATTEMPTS) {
          attempt.lockUntil = Date.now() + LOCK_MS;
          attempt.count = 0;
        }
        loginAttempts.set(attemptKey, attempt);
      }
      return res.status(401).json({ error: 'Incorrect password' });
    }
    loginAttempts.delete(attemptKey);
    const token = createSession(user.id);
    setSessionCookie(res, token);
    await logAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.login', details: { email: emailNorm } });
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
    const emailNorm = normalizeEmail(email);
    if (!emailNorm || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 10) return res.status(400).json({ error: 'password too weak' });
    const t = tenantId(req);
    const exists = await getAsync('SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND tenantId=$2', [emailNorm, t]);
    if (exists) return res.status(400).json({ error: 'email already exists' });
    const { salt, hash } = await hashPassword(password);
    const user = { id: newId(), email: emailNorm, name, role, salt, hash, createdAt: Date.now(), tenantId: t };
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
    let emailNorm = email ? normalizeEmail(email) : user.email;
    if (email) {
      const dup = await getAsync('SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2 AND tenantId=$3', [emailNorm, id, t]);
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
      [emailNorm, name ?? user.name, role || user.role, salt, hash, id, t]);
    const updated = await getAsync('SELECT * FROM users WHERE id=$1 AND tenantId=$2', [id, t]);
    res.json(safeUser(updated));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    await runAsync('DELETE FROM users WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    res.status(204).end();
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
    await runAsync(`INSERT INTO jobs(code,name,scheduleDate,tenantId) VALUES($1,$2,$3,$4)
      ON CONFLICT(code,tenantId) DO UPDATE SET name=EXCLUDED.name, scheduleDate=EXCLUDED.scheduleDate`, [code, name || '', scheduleDate || null, t]);
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
    const { code, name, qty, eta, notes, ts, jobId } = req.body;
    const qtyNum = Number(qty);
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const t = tenantId(req);
    const entry = await withTransaction(async (client) => {
      await ensureItem(client, { code, name: name || code, category: '', unitPrice: null, tenantIdVal: t });
      const ev = { id: newId(), code, name: name || code, qty: qtyNum, eta, notes, jobId, ts: ts || Date.now(), type: 'ordered', status: statusForType('ordered'), userEmail: req.body.userEmail, userName: req.body.userName, tenantId: t };
      await client.query(`INSERT INTO inventory(id,code,name,qty,eta,notes,jobId,ts,type,status,userEmail,userName,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [ev.id, ev.code, ev.name, ev.qty, ev.eta, ev.notes, ev.jobId, ev.ts, ev.type, ev.status, ev.userEmail, ev.userName, ev.tenantId]);
      return ev;
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.order', details: { code, qty: qtyNum, jobId, eta } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

// DEV RESET (destructive, dev-only)
app.post('/api/dev/reset', requireDev, async (req, res) => {
  try {
    const token = req.headers['x-dev-reset'];
    if (!token || token !== DEV_RESET_TOKEN) return res.status(401).json({ error: 'invalid token' });

    await withTransaction(async (client) => {
      await client.query('TRUNCATE inventory');
      await client.query('TRUNCATE audit_events');
      await client.query('TRUNCATE items');
      await client.query('TRUNCATE jobs');
      await client.query('TRUNCATE users');
      await client.query("DELETE FROM tenants WHERE id <> 'default'");
      await client.query(`INSERT INTO tenants(id,code,name,createdAt) VALUES('default','default','Default Tenant',$1)
        ON CONFLICT (id) DO NOTHING`, [Date.now()]);
      const adminPwd = 'ChangeMe123!';
      const adminHash = await hashPassword(adminPwd);
      const devHash = await hashPassword(DEV_PASSWORD);
      await client.query('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [newId(), 'admin@example.com', 'Admin', 'admin', adminHash.salt, adminHash.hash, Date.now(), 'default']);
      await client.query('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [newId(), DEV_EMAIL, 'Dev', 'admin', devHash.salt, devHash.hash, Date.now(), 'default']);
    });
    sessions.clear();
    res.json({ status: 'ok', message: 'Database truncated. Default admin and dev users reseeded.' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'reset failed' });
  }
});

// DEV: delete a specific user within a tenant
app.post('/api/dev/delete-user', requireDev, async (req, res) => {
  try {
    const { tenantCode, email } = req.body || {};
    const tCode = normalizeTenantCode(tenantCode);
    const emailNorm = normalizeEmail(email);
    if (!tCode || !emailNorm) return res.status(400).json({ error: 'tenantCode and email required' });
    const tenant = await getAsync('SELECT * FROM tenants WHERE code=$1', [tCode]);
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });
    const user = await getAsync('SELECT * FROM users WHERE tenantId=$1 AND LOWER(email)=LOWER($2)', [tenant.id, emailNorm]);
    if (!user) return res.status(404).json({ error: 'user not found' });
    await withTransaction(async (client) => {
      await client.query('DELETE FROM inventory WHERE tenantId=$1 AND LOWER(userEmail)=LOWER($2)', [tenant.id, emailNorm]);
      await client.query('DELETE FROM audit_events WHERE tenantId=$1 AND userId=$2', [tenant.id, user.id]);
      await client.query('DELETE FROM users WHERE tenantId=$1 AND id=$2', [tenant.id, user.id]);
    });
    res.json({ status: 'ok', deletedUser: user.email, tenant: tenant.code });
  } catch (e) {
    res.status(500).json({ error: e.message || 'delete failed' });
  }
});

// DEV: delete an entire tenant and all related data
app.post('/api/dev/delete-tenant', requireDev, async (req, res) => {
  try {
    const { tenantCode } = req.body || {};
    const tCode = normalizeTenantCode(tenantCode);
    if (!tCode) return res.status(400).json({ error: 'tenantCode required' });
    const protectedTenants = new Set(['default', normalizeTenantCode(DEV_TENANT_CODE)]);
    if (protectedTenants.has(tCode)) return res.status(400).json({ error: 'cannot delete protected tenant' });
    const tenant = await getAsync('SELECT * FROM tenants WHERE code=$1', [tCode]);
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });
    await withTransaction(async (client) => {
      await client.query('DELETE FROM inventory WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM audit_events WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM items WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM jobs WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM users WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
    });
    res.json({ status: 'ok', deletedTenant: tenant.code });
  } catch (e) {
    res.status(500).json({ error: e.message || 'delete failed' });
  }
});

// DEV: list tenants
app.get('/api/dev/tenants', requireDev, async (req, res) => {
  try {
    const rows = await allAsync('SELECT id, code, name, createdAt FROM tenants ORDER BY code ASC', []);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

// DEV: list users for a tenant
app.get('/api/dev/users', requireDev, async (req, res) => {
  try {
    const tCode = normalizeTenantCode(req.query.tenantCode || '');
    if (!tCode) return res.status(400).json({ error: 'tenantCode required' });
    const tenant = await getAsync('SELECT * FROM tenants WHERE code=$1', [tCode]);
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });
    const rows = await allAsync('SELECT id,email,name,role,tenantId,createdAt FROM users WHERE tenantId=$1 ORDER BY email ASC', [tenant.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
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

app.get('/api/export/inventory', async (req, res) => {
  try {
    const t = tenantId(req);
    const type = req.query.type;
    const rows = type ? await allAsync('SELECT * FROM inventory WHERE tenantId=$1 AND type=$2 ORDER BY ts DESC', [t, type]) : await allAsync('SELECT * FROM inventory WHERE tenantId=$1 ORDER BY ts DESC', [t]);
    if (!rows.length) return res.status(400).json({ error: 'no data' });
    const parser = new Parser();
    const csv = parser.parse(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-${type || 'all'}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/notifications', async (req, res) => {
  try {
    const t = tenantId(req);
    const rows = await allAsync('SELECT * FROM audit_events WHERE tenantId=$1 ORDER BY ts DESC LIMIT 20', [t]);
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
