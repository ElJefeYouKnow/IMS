// Force Node to ignore self-signed cert errors (managed DBs often use custom CAs).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

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
// Serve static assets but avoid auto-serving empty index.html; we route "/" manually.
app.use(express.static(path.join(__dirname), { index: false }));
app.use(helmet());
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
app.use(['/api/auth/login', '/api/auth/register'], authLimiter);

// Helpers
function newId() {
  return 'itm_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', s).update(password).digest('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  const h = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return h === hash;
}

function safeUser(u) {
  return { id: u.id, email: u.email, name: u.name || '', role: u.role || 'user', createdAt: u.createdat || u.createdAt };
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

async function initDb() {
  await runAsync(`CREATE TABLE IF NOT EXISTS items(
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    unitPrice NUMERIC,
    description TEXT
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
    userName TEXT
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS jobs(
    code TEXT PRIMARY KEY,
    name TEXT,
    scheduleDate TEXT
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    role TEXT NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    createdAt BIGINT
  )`);
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_code ON inventory(code)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_job ON inventory(jobId)');

  const row = await getAsync('SELECT COUNT(*) as c FROM users');
  if (row?.c === 0) {
    const pwd = 'ChangeMe123!';
    const { salt, hash } = hashPassword(pwd);
    const user = { id: newId(), email: 'admin@example.com', name: 'Admin', role: 'admin', salt, hash, createdAt: Date.now() };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt]);
    console.log('Seeded default admin: admin@example.com / ChangeMe123! (change after login).');
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

async function itemExists(code) {
  const row = await getAsync('SELECT 1 FROM items WHERE code=$1 LIMIT 1', [code]);
  return !!row;
}

async function calcAvailability(code) {
  const row = await getAsync(`
    SELECT COALESCE(SUM(
      CASE 
        WHEN type='in' THEN qty
        WHEN type='return' THEN qty
        WHEN type='reserve' THEN -qty
        WHEN type='out' THEN -qty
        ELSE 0 END
    ),0) AS available
    FROM inventory WHERE code = $1
  `, [code]);
  return row?.available || 0;
}

async function calcOutstandingCheckout(code, jobId) {
  const params = [code];
  let jobClause = '';
  if (jobId) {
    jobClause = 'AND jobId = $2';
    params.push(jobId);
  } else {
    jobClause = "AND (jobId IS NULL OR jobId = '')";
  }
  const row = await getAsync(`
    SELECT COALESCE(SUM(CASE WHEN type='out' THEN qty WHEN type='return' THEN -qty ELSE 0 END),0) as outstanding
    FROM inventory WHERE code=$1 ${jobClause}
  `, params);
  return Math.max(0, row?.outstanding || 0);
}

function requireRole(role) {
  return (req, res, next) => {
    const r = (req.headers['x-user-role'] || req.headers['x-admin-role'] || '').toLowerCase();
    if (r !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// INVENTORY
app.get('/api/inventory', async (req, res) => {
  try {
    const type = req.query.type;
    const rows = type ? await allAsync('SELECT * FROM inventory WHERE type = $1', [type]) : await allAsync('SELECT * FROM inventory');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/inventory', requireRole('admin'), async (req, res) => {
  try {
    const { code, name, qty, location, jobId, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    if (!(await itemExists(code))) return res.status(400).json({ error: 'unknown item code' });
    const entry = { id: newId(), code, name, qty: qtyNum, location, jobId, notes, ts: ts || Date.now(), type: 'in', status: statusForType('in'), userEmail: req.body.userEmail, userName: req.body.userName };
    await runAsync(`INSERT INTO inventory(id,code,name,qty,location,jobId,notes,ts,type,status,userEmail,userName) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [entry.id, entry.code, entry.name, entry.qty, entry.location, entry.jobId, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName]);
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/inventory-checkout', async (req, res) => {
  try {
    const { code, jobId, qty, reason, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    if (!(await itemExists(code))) return res.status(400).json({ error: 'unknown item code' });
    const available = await calcAvailability(code);
    if (qtyNum > available) return res.status(400).json({ error: 'insufficient stock', available });
    const entry = { id: newId(), code, jobId, qty: qtyNum, reason, notes, ts: ts || Date.now(), type: 'out', status: statusForType('out'), userEmail: req.body.userEmail, userName: req.body.userName };
    await runAsync(`INSERT INTO inventory(id,code,jobId,qty,reason,notes,ts,type,status,userEmail,userName) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [entry.id, entry.code, entry.jobId, entry.qty, entry.reason, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName]);
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/inventory', async (req, res) => {
  try {
    const type = req.query.type;
    if (type) await runAsync('DELETE FROM inventory WHERE type = $1', [type]);
    else await runAsync('DELETE FROM inventory');
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/inventory-checkout', async (req, res) => {
  try {
    await runAsync("DELETE FROM inventory WHERE type='out'");
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/inventory-reserve', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM inventory WHERE type=$1', ['reserve']);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/inventory-reserve', async (req, res) => {
  try {
    const { code, jobId, qty, returnDate, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if (!code || !jobId || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code, jobId and positive qty required' });
    if (!(await itemExists(code))) return res.status(400).json({ error: 'unknown item code' });
    const available = await calcAvailability(code);
    if (qtyNum > available) return res.status(400).json({ error: 'insufficient stock', available });
    const entry = { id: newId(), code, jobId, qty: qtyNum, returnDate, notes, ts: ts || Date.now(), type: 'reserve', status: statusForType('reserve'), userEmail: req.body.userEmail, userName: req.body.userName };
    await runAsync(`INSERT INTO inventory(id,code,jobId,qty,returnDate,notes,ts,type,status,userEmail,userName) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [entry.id, entry.code, entry.jobId, entry.qty, entry.returnDate, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName]);
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/inventory-reserve', async (req, res) => {
  try {
    await runAsync("DELETE FROM inventory WHERE type='reserve'");
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
    if (!(await itemExists(code))) return res.status(400).json({ error: 'unknown item code' });
    const outstanding = await calcOutstandingCheckout(code, jobId);
    if (outstanding <= 0) return res.status(400).json({ error: 'no matching checkout to return' });
    if (qtyNum > outstanding) return res.status(400).json({ error: 'return exceeds outstanding checkout', outstanding });
    const entry = { id: newId(), code, jobId, qty: qtyNum, reason, location, notes, ts: ts || Date.now(), type: 'return', status: statusForType('return'), userEmail: req.body.userEmail, userName: req.body.userName };
    await runAsync(`INSERT INTO inventory(id,code,jobId,qty,reason,location,notes,ts,type,status,userEmail,userName) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [entry.id, entry.code, entry.jobId, entry.qty, entry.reason, entry.location, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName]);
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/inventory-return', async (req, res) => {
  try {
    await runAsync("DELETE FROM inventory WHERE type='return'");
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ITEMS
app.get('/api/items', async (req, res) => {
  try {
    const rows = await readItems();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/items', requireRole('admin'), async (req, res) => {
  try {
    const { code, oldCode, name, category, unitPrice, description } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    if (oldCode && oldCode !== code) {
      await runAsync('DELETE FROM items WHERE code=$1', [oldCode]);
    }
    await runAsync(`INSERT INTO items(code,name,category,unitPrice,description)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, unitPrice=EXCLUDED.unitPrice, description=EXCLUDED.description`,
      [code, name, category, unitPrice ?? null, description]);
    res.status(201).json({ code, name, category, unitPrice, description });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/items/:code', requireRole('admin'), async (req, res) => {
  try {
    await runAsync('DELETE FROM items WHERE code=$1', [req.params.code]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// AUTH + USERS
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const existing = await getAsync('SELECT id FROM users WHERE email=$1', [email]);
    if (existing) return res.status(400).json({ error: 'email already exists' });
    const role = (await getAsync('SELECT COUNT(*) as c FROM users')).c === 0 ? 'admin' : 'user';
    const { salt, hash } = hashPassword(password);
    const user = { id: newId(), email, name, role, salt, hash, createdAt: Date.now() };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt]);
    res.status(201).json(safeUser(user));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const user = await getAsync('SELECT * FROM users WHERE email=$1', [email]);
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    if (!verifyPassword(password, user.salt, user.hash)) return res.status(401).json({ error: 'invalid credentials' });
    res.json(safeUser(user));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/users', requireRole('admin'), async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM users');
    res.json(rows.map(safeUser));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  try {
    const { email, password, name, role = 'user' } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const exists = await getAsync('SELECT id FROM users WHERE email=$1', [email]);
    if (exists) return res.status(400).json({ error: 'email already exists' });
    const { salt, hash } = hashPassword(password);
    const user = { id: newId(), email, name, role, salt, hash, createdAt: Date.now() };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt]);
    res.status(201).json(safeUser(user));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// JOBS
app.get('/api/jobs', async (req, res) => {
  try {
    const rows = await readJobs();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/jobs', requireRole('admin'), async (req, res) => {
  try {
    const { code, name, scheduleDate } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    await runAsync(`INSERT INTO jobs(code,name,scheduleDate) VALUES($1,$2,$3)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, scheduleDate=EXCLUDED.scheduleDate`, [code, name || '', scheduleDate || null]);
    res.status(201).json({ code, name: name || '', scheduleDate: scheduleDate || null });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/jobs/:code', requireRole('admin'), async (req, res) => {
  try {
    await runAsync('DELETE FROM jobs WHERE code=$1', [req.params.code]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ADMIN ORDERS
app.post('/api/inventory-order', requireRole('admin'), async (req, res) => {
  try {
    const { code, name, qty, eta, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const exists = await itemExists(code);
    if (!exists) {
      await runAsync('INSERT INTO items(code,name,category,unitPrice,description) VALUES($1,$2,$3,$4,$5)', [code, name || code, '', null, '']);
    }
    const entry = { id: newId(), code, name, qty: qtyNum, eta, notes, ts: ts || Date.now(), type: 'ordered', status: statusForType('ordered'), userEmail: req.body.userEmail, userName: req.body.userName };
    await runAsync(`INSERT INTO inventory(id,code,name,qty,eta,notes,ts,type,status,userEmail,userName) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entry.id, entry.code, entry.name, entry.qty, entry.eta, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName]);
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
    const rows = await allAsync('SELECT * FROM inventory ORDER BY ts DESC LIMIT $1', [limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));

// Helpers to read common lists
async function readItems() {
  return allAsync('SELECT * FROM items ORDER BY name ASC');
}
async function readJobs() {
  return allAsync('SELECT * FROM jobs ORDER BY code ASC');
}
