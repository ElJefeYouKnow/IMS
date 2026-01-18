const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = IS_PROD ? '1' : '0';
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Parser } = require('json2csv');

const PORT = process.env.PORT || 8000;
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'modulr.pro';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (IS_PROD ? `https://${BASE_DOMAIN}` : `http://localhost:${PORT}`);
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : IS_PROD;
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || (IS_PROD ? BASE_DOMAIN : undefined);
const SESSION_STORE = process.env.SESSION_STORE || (IS_PROD ? 'db' : 'memory');
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || (IS_PROD ? PUBLIC_BASE_URL : '')).split(',')
  .map((value) => value.trim())
  .filter(Boolean));
if (!IS_PROD) {
  ALLOWED_ORIGINS.add(`http://localhost:${PORT}`);
  ALLOWED_ORIGINS.add(`http://127.0.0.1:${PORT}`);
}

// Session store (memory by default, DB in production for scalability)
const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
const REMEMBER_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_COOKIE = 'sid';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
if (IS_PROD && SESSION_SECRET === 'dev-secret-change-me') {
  throw new Error('SESSION_SECRET must be set in production');
}
const loginAttempts = new Map(); // email -> {count, lockUntil}
const AUDIT_ACTIONS = [
  'auth.login',
  'auth.register',
  'inventory.in',
  'inventory.out',
  'inventory.reserve',
  'inventory.return',
  'inventory.order',
  'inventory.count',
  'items.create',
  'items.update',
  'items.delete',
  'ops.pick.start',
  'ops.pick.finish',
  'ops.checkin.start',
  'ops.checkin.finish'
];
const CHECKOUT_RETURN_WINDOW_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const DEV_EMAIL = normalizeEmail(process.env.DEV_DEFAULT_EMAIL || 'Dev@ManageX.com');
const DEV_PASSWORD = process.env.DEV_DEFAULT_PASSWORD || 'Dev123!';
const DEV_TENANT_CODE = process.env.DEV_TENANT_CODE || 'dev';
const DEV_TENANT_ID = process.env.DEV_TENANT_ID || DEV_TENANT_CODE;
const DEV_RESET_TOKEN = process.env.DEV_RESET_TOKEN || 'reset-all-data-now';
const SELLER_DATA_PATH = path.join(__dirname, 'data', 'seller-admin.json');
const SELLER_ACTIVITY_LIMIT = 8;
const DEFAULT_CATEGORY_NAME = 'Uncategorized';
const DEFAULT_CATEGORY_RULES = {
  requireJobId: false,
  requireLocation: false,
  requireNotes: false,
  allowFieldPurchase: true,
  allowCheckout: true,
  allowReserve: true,
  maxCheckoutQty: null,
  returnWindowDays: 5,
  lowStockThreshold: 5,
  lowStockEnabled: true
};
let sellerStore = { clients: [], tickets: [], activities: [] };

const app = express();
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ims';
// Prefer strict SSL in production; allow relaxed mode for local/dev if explicitly needed.
const sslCaEnvRaw = process.env.DATABASE_SSL_CA_PEM || process.env.DATABASE_CA_CERT || process.env.CA_CERT || '';
const sslCaBase64 = process.env.DATABASE_SSL_CA_B64 || process.env.DATABASE_SSL_CA_BASE64 || '';
const sslRootCertPath = process.env.DATABASE_SSL_CA || process.env.PGSSLROOTCERT;
let ca;
if (sslCaBase64) {
  try {
    ca = Buffer.from(sslCaBase64, 'base64').toString('utf8');
  } catch (e) {
    console.warn('Could not decode DATABASE_SSL_CA_B64', e.message);
  }
} else if (sslCaEnvRaw) {
  let normalized = sslCaEnvRaw.trim();
  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }
  ca = normalized.replace(/\\n/g, '\n');
} else if (sslRootCertPath) {
  try {
    ca = fs.readFileSync(path.resolve(sslRootCertPath)).toString();
  } catch (e) {
    console.warn('Could not read SSL CA file at', sslRootCertPath, e.message);
  }
}
const rejectUnauthorized =
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED
    ? process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true'
    : IS_PROD;
if (IS_PROD && rejectUnauthorized && !ca) {
  console.warn('DATABASE_SSL_REJECT_UNAUTHORIZED=true but no CA cert was provided.');
}
const sslConfig = { rejectUnauthorized, ca };
console.log('DB SSL config', {
  rejectUnauthorized,
  hasCa: Boolean(ca),
  caLength: ca ? ca.length : 0,
});
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslConfig,
});

// Behind proxies (App Platform/Cloudflare), trust forwarded headers for rate limiting + IPs.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (!IS_PROD) return next();
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (host && host !== BASE_DOMAIN) {
    if (host === `www.${BASE_DOMAIN}`) {
      return res.redirect(301, `https://${BASE_DOMAIN}${req.originalUrl}`);
    }
    return res.status(400).send('Invalid host');
  }
  if (req.protocol !== 'https') {
    return res.redirect(301, `https://${BASE_DOMAIN}${req.originalUrl}`);
  }
  return next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  return next();
});

app.use(express.json({ limit: '1mb' }));
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
const staticOptions = {
  index: false,
  etag: false,
  setHeaders: (res, filePath) => {
    if (/\.(png|jpe?g|gif|svg|webp|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
};
app.use(express.static(path.join(__dirname), staticOptions));
app.use('/app', express.static(path.join(__dirname), staticOptions));
app.use(helmet({
  hsts: IS_PROD ? { maxAge: 15552000, includeSubDomains: true, preload: true } : false,
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

// Prevent browser caching of HTML so UI changes propagate immediately.
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
app.use(['/api/auth/login', '/api/auth/register'], authLimiter);
const tenantLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

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
function newSellerId(prefix = 'seller_') {
  return prefix + Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
}
function seedSellerStore() {
  const now = Date.now();
  const clientA = { id: newSellerId('cli_'), name: 'Acme Builders', email: 'ops@acme.com', plan: 'growth', status: 'active', activeUsers: 12, notes: 'Expansion', updatedAt: now - 86400000 };
  const clientB = { id: newSellerId('cli_'), name: 'Northline Group', email: 'admin@northline.com', plan: 'starter', status: 'trial', activeUsers: 4, notes: '', updatedAt: now - 43200000 };
  const clientC = { id: newSellerId('cli_'), name: 'Stonefield', email: 'it@stonefield.com', plan: 'enterprise', status: 'past_due', activeUsers: 28, notes: 'Invoice overdue', updatedAt: now - 21600000 };
  sellerStore = {
    clients: [clientA, clientB, clientC],
    tickets: [
      { id: newSellerId('tkt_'), clientId: clientA.id, subject: 'Inventory sync delay', priority: 'medium', status: 'open', updatedAt: now - 5400000 },
      { id: newSellerId('tkt_'), clientId: clientC.id, subject: 'Billing access request', priority: 'high', status: 'pending', updatedAt: now - 7200000 }
    ],
    activities: [
      { id: newSellerId('act_'), message: 'Acme Builders upgraded to Growth', ts: now - 7200000 },
      { id: newSellerId('act_'), message: 'New ticket opened for Stonefield', ts: now - 5400000 }
    ]
  };
}
function ensureSellerStoreShape() {
  if (!sellerStore || typeof sellerStore !== 'object') sellerStore = { clients: [], tickets: [], activities: [] };
  if (!Array.isArray(sellerStore.clients)) sellerStore.clients = [];
  if (!Array.isArray(sellerStore.tickets)) sellerStore.tickets = [];
  if (!Array.isArray(sellerStore.activities)) sellerStore.activities = [];
}
function loadSellerStore() {
  try {
    if (fs.existsSync(SELLER_DATA_PATH)) {
      const raw = fs.readFileSync(SELLER_DATA_PATH, 'utf8');
      sellerStore = raw ? JSON.parse(raw) : { clients: [], tickets: [], activities: [] };
    } else {
      seedSellerStore();
      saveSellerStore();
      return;
    }
    ensureSellerStoreShape();
    if (!sellerStore.clients.length) {
      seedSellerStore();
      saveSellerStore();
    }
  } catch (e) {
    console.warn('Failed to load seller admin data', e.message);
    seedSellerStore();
    saveSellerStore();
  }
}
function saveSellerStore() {
  try {
    ensureSellerStoreShape();
    fs.writeFileSync(SELLER_DATA_PATH, JSON.stringify(sellerStore, null, 2));
  } catch (e) {
    console.warn('Failed to save seller admin data', e.message);
  }
}
function recordSellerActivity(message) {
  sellerStore.activities.unshift({ id: newSellerId('act_'), message, ts: Date.now() });
  sellerStore.activities = sellerStore.activities.slice(0, SELLER_ACTIVITY_LIMIT);
  saveSellerStore();
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

function normalizeUserRole(role) {
  const r = (role || '').toString().trim().toLowerCase();
  if (!r || r === 'user') return 'employee';
  if (r === 'admin' || r === 'manager' || r === 'employee' || r === 'dev') return r;
  return 'employee';
}

function safeUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name || '',
    role: normalizeUserRole(u.role),
    tenantId: u.tenantid || u.tenantId,
    createdAt: u.createdat || u.createdAt
  };
}
function normalizeTenantCode(code) {
  return (code || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'default';
}
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}
function normalizeJobId(value) {
  const val = (value || '').toString().trim();
  if (!val) return '';
  const lowered = val.toLowerCase();
  if (['general', 'general inventory', 'none', 'unassigned'].includes(lowered)) return '';
  return val;
}
function normalizeCategoryName(value) {
  return (value || '').toString().trim();
}
function parseCategoryRules(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  if (typeof raw === 'object') return raw;
  return {};
}
function normalizeCategoryRules(raw) {
  const input = parseCategoryRules(raw);
  const out = { ...DEFAULT_CATEGORY_RULES };
  if (Object.prototype.hasOwnProperty.call(input, 'requireJobId')) out.requireJobId = !!input.requireJobId;
  if (Object.prototype.hasOwnProperty.call(input, 'requireLocation')) out.requireLocation = !!input.requireLocation;
  if (Object.prototype.hasOwnProperty.call(input, 'requireNotes')) out.requireNotes = !!input.requireNotes;
  if (Object.prototype.hasOwnProperty.call(input, 'allowFieldPurchase')) out.allowFieldPurchase = !!input.allowFieldPurchase;
  if (Object.prototype.hasOwnProperty.call(input, 'allowCheckout')) out.allowCheckout = !!input.allowCheckout;
  if (Object.prototype.hasOwnProperty.call(input, 'allowReserve')) out.allowReserve = !!input.allowReserve;
  if (Object.prototype.hasOwnProperty.call(input, 'lowStockEnabled')) out.lowStockEnabled = !!input.lowStockEnabled;
  const maxCheckoutQty = Number(input.maxCheckoutQty);
  out.maxCheckoutQty = Number.isFinite(maxCheckoutQty) && maxCheckoutQty > 0 ? Math.floor(maxCheckoutQty) : null;
  const returnWindowDays = Number(input.returnWindowDays);
  out.returnWindowDays = Number.isFinite(returnWindowDays) && returnWindowDays > 0
    ? Math.floor(returnWindowDays)
    : DEFAULT_CATEGORY_RULES.returnWindowDays;
  const lowStockThreshold = Number(input.lowStockThreshold);
  out.lowStockThreshold = Number.isFinite(lowStockThreshold) && lowStockThreshold >= 0
    ? Math.floor(lowStockThreshold)
    : DEFAULT_CATEGORY_RULES.lowStockThreshold;
  return out;
}
function normalizeItemTags(input) {
  if (!input) return [];
  let tags = [];
  if (Array.isArray(input)) {
    tags = input;
  } else if (typeof input === 'string') {
    tags = input.split(/[,;|]/);
  }
  const seen = new Set();
  const out = [];
  tags.forEach((tag) => {
    const value = (tag || '').toString().trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  return out;
}
function normalizeItemLowStockEnabled(input) {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input === 'boolean') return input;
  const value = String(input).trim().toLowerCase();
  if (!value) return null;
  if (['false', '0', 'no', 'off', 'disabled'].includes(value)) return false;
  if (['true', '1', 'yes', 'on', 'enabled'].includes(value)) return true;
  return null;
}
function normalizeOptionalBool(input) {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input === 'boolean') return input;
  const value = String(input).trim().toLowerCase();
  if (!value) return null;
  if (['false', '0', 'no', 'off', 'disabled'].includes(value)) return false;
  if (['true', '1', 'yes', 'on', 'enabled'].includes(value)) return true;
  return null;
}
function getReturnWindowMs(rules) {
  const days = Number(rules?.returnWindowDays);
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_CATEGORY_RULES.returnWindowDays;
  return safeDays * 24 * 60 * 60 * 1000;
}
function enforceCategoryRules(rules, { action, jobId, location, notes, qty }) {
  const jobVal = normalizeJobId(jobId || '');
  if (rules?.requireJobId && !jobVal) throw new Error('jobId required for category');
  const needsLocation = ['checkin', 'return', 'field-purchase'].includes(action);
  if (rules?.requireLocation && needsLocation && !(location || '').trim()) throw new Error('location required for category');
  if (rules?.requireNotes && !(notes || '').trim()) throw new Error('notes required for category');
  if (action === 'checkout' && rules?.allowCheckout === false) throw new Error('checkout not allowed for category');
  if (action === 'reserve' && rules?.allowReserve === false) throw new Error('reserve not allowed for category');
  if (action === 'field-purchase' && rules?.allowFieldPurchase === false) throw new Error('field purchase not allowed for category');
  if (action === 'checkout') {
    const max = Number(rules?.maxCheckoutQty);
    if (Number.isFinite(max) && max > 0 && Number(qty) > max) throw new Error(`max checkout qty is ${max}`);
  }
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
async function getCategoryByNameTx(client, tenantIdVal, name) {
  const norm = normalizeCategoryName(name);
  if (!norm) return null;
  const row = await client.query(
    'SELECT * FROM categories WHERE tenantId=$1 AND LOWER(name)=LOWER($2) LIMIT 1',
    [tenantIdVal, norm]
  );
  return row.rows[0] || null;
}
async function getCategoryByName(tenantIdVal, name) {
  const norm = normalizeCategoryName(name);
  if (!norm) return null;
  return getAsync(
    'SELECT * FROM categories WHERE tenantId=$1 AND LOWER(name)=LOWER($2) LIMIT 1',
    [tenantIdVal, norm]
  );
}
async function ensureDefaultCategoryTx(client, tenantIdVal) {
  const now = Date.now();
  await client.query(
    `INSERT INTO categories(id,name,rules,tenantId,createdAt,updatedAt)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT DO NOTHING`,
    [newId(), DEFAULT_CATEGORY_NAME, DEFAULT_CATEGORY_RULES, tenantIdVal, now, now]
  );
  return getCategoryByNameTx(client, tenantIdVal, DEFAULT_CATEGORY_NAME);
}
async function ensureDefaultCategory(tenantIdVal) {
  const now = Date.now();
  await runAsync(
    `INSERT INTO categories(id,name,rules,tenantId,createdAt,updatedAt)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT DO NOTHING`,
    [newId(), DEFAULT_CATEGORY_NAME, DEFAULT_CATEGORY_RULES, tenantIdVal, now, now]
  );
  return getCategoryByName(tenantIdVal, DEFAULT_CATEGORY_NAME);
}
async function resolveCategoryInputTx(client, tenantIdVal, name) {
  const norm = normalizeCategoryName(name);
  if (!norm) {
    const def = await ensureDefaultCategoryTx(client, tenantIdVal);
    return { name: def.name, rules: normalizeCategoryRules(def.rules) };
  }
  const row = await getCategoryByNameTx(client, tenantIdVal, norm);
  if (!row) throw new Error(`category not found: ${norm}`);
  return { name: row.name, rules: normalizeCategoryRules(row.rules) };
}
async function resolveCategoryInput(tenantIdVal, name) {
  const norm = normalizeCategoryName(name);
  if (!norm) {
    const def = await ensureDefaultCategory(tenantIdVal);
    return { name: def.name, rules: normalizeCategoryRules(def.rules) };
  }
  const row = await getCategoryByName(tenantIdVal, norm);
  if (!row) throw new Error(`category not found: ${norm}`);
  return { name: row.name, rules: normalizeCategoryRules(row.rules) };
}
async function getItemCategoryRulesTx(client, tenantIdVal, code, categoryInput) {
  const item = await loadItem(client, code, tenantIdVal);
  const inputNorm = normalizeCategoryName(categoryInput);
  if (item) {
    const current = normalizeCategoryName(item.category);
    if (current) {
      if (inputNorm && inputNorm.toLowerCase() !== current.toLowerCase()) {
        throw new Error(`category mismatch for item ${code}`);
      }
      const row = await getCategoryByNameTx(client, tenantIdVal, current);
      if (row) {
        return { item, categoryName: row.name, rules: normalizeCategoryRules(row.rules) };
      }
      const def = await ensureDefaultCategoryTx(client, tenantIdVal);
      await client.query('UPDATE items SET category=$1 WHERE code=$2 AND tenantId=$3', [def.name, code, tenantIdVal]);
      return { item, categoryName: def.name, rules: normalizeCategoryRules(def.rules) };
    }
    const resolved = await resolveCategoryInputTx(client, tenantIdVal, inputNorm);
    await client.query('UPDATE items SET category=$1 WHERE code=$2 AND tenantId=$3', [resolved.name, code, tenantIdVal]);
    return { item, categoryName: resolved.name, rules: resolved.rules };
  }
  const resolved = await resolveCategoryInputTx(client, tenantIdVal, inputNorm);
  return { item: null, categoryName: resolved.name, rules: resolved.rules };
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

function normalizeSessionRow(row) {
  if (!row) return null;
  return {
    userId: row.userId || row.userid,
    expires: Number(row.expires),
  };
}

async function createSession(userId, ttlMs = SESSION_TTL_MS) {
  const token = crypto.createHmac('sha256', SESSION_SECRET)
    .update(userId + Date.now().toString() + Math.random().toString())
    .digest('hex');
  const expires = Date.now() + ttlMs;
  if (SESSION_STORE === 'db') {
    await runAsync('INSERT INTO sessions(token,userId,expires,createdAt) VALUES($1,$2,$3,$4)', [token, userId, expires, Date.now()]);
  } else {
    sessions.set(token, { userId, expires });
  }
  return token;
}

async function getSession(token) {
  if (!token) return null;
  if (SESSION_STORE === 'db') {
    const row = await getAsync('SELECT token,userId,expires FROM sessions WHERE token=$1', [token]);
    const sess = normalizeSessionRow(row);
    if (!sess) return null;
    if (sess.expires < Date.now()) {
      await runAsync('DELETE FROM sessions WHERE token=$1', [token]);
      return null;
    }
    return sess;
  }
  const sess = sessions.get(token);
  if (!sess) return null;
  if (sess.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return sess;
}

async function deleteSession(token) {
  if (!token) return;
  if (SESSION_STORE === 'db') {
    await runAsync('DELETE FROM sessions WHERE token=$1', [token]);
    return;
  }
  sessions.delete(token);
}

async function clearSessions() {
  if (SESSION_STORE === 'db') {
    await runAsync('DELETE FROM sessions');
    return;
  }
  sessions.clear();
}

async function cleanupExpiredSessions() {
  const now = Date.now();
  if (SESSION_STORE === 'db') {
    await runAsync('DELETE FROM sessions WHERE expires < $1', [now]);
    return;
  }
  for (const [token, sess] of sessions.entries()) {
    if (sess.expires < now) sessions.delete(token);
  }
}

setInterval(() => {
  cleanupExpiredSessions().catch(() => {});
}, 60 * 60 * 1000);

async function loadUserById(id) {
  return getAsync('SELECT * FROM users WHERE id=$1', [id]);
}
function currentUserId(req) {
  return (req.user && (req.user.id || req.user.userid)) || null;
}

async function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  const sess = await getSession(token);
  if (!sess) return res.status(401).json({ error: 'unauthorized' });
  const user = await loadUserById(sess.userId);
  if (!user) {
    await deleteSession(token);
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
  await runAsync(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan TEXT`);
  await runAsync(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status TEXT`);
  await runAsync(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contactEmail TEXT`);
  await runAsync(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS notes TEXT`);
  await runAsync(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS seatLimit INTEGER`);
  await runAsync(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS updatedAt BIGINT`);
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
    material TEXT,
    shape TEXT,
    brand TEXT,
    notes TEXT,
    uom TEXT,
    serialized BOOLEAN,
    lot BOOLEAN,
    expires BOOLEAN,
    warehouse TEXT,
    zone TEXT,
    bin TEXT,
    reorderPoint INTEGER,
    minStock INTEGER,
    description TEXT,
    tags JSONB,
    lowStockEnabled BOOLEAN,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'
  )`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS category TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS unitPrice NUMERIC`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS material TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS shape TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS brand TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS notes TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS uom TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS serialized BOOLEAN`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS lot BOOLEAN`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS expires BOOLEAN`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS warehouse TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS zone TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS bin TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS reorderPoint INTEGER`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS minStock INTEGER`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS description TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS tags JSONB`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS lowStockEnabled BOOLEAN`);
  await runAsync(`CREATE TABLE IF NOT EXISTS categories(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rules JSONB,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default',
    createdAt BIGINT,
    updatedAt BIGINT
  )`);
  await runAsync(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS rules JSONB`);
  await runAsync(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS createdAt BIGINT`);
  await runAsync(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS updatedAt BIGINT`);
  await runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_tenant_name ON categories(tenantId, LOWER(name))`);
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
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default',
    sourceType TEXT,
    sourceId TEXT,
    sourceMeta JSONB
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS jobs(
    code TEXT PRIMARY KEY,
    name TEXT,
    scheduleDate TEXT,
    startDate TEXT,
    endDate TEXT,
    status TEXT,
    location TEXT,
    notes TEXT,
    updatedAt BIGINT,
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
  await runAsync(`CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    expires BIGINT NOT NULL,
    createdAt BIGINT
  )`);
  await runAsync('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)');
  await runAsync(`CREATE TABLE IF NOT EXISTS inventory_counts(
    id TEXT PRIMARY KEY,
    code TEXT,
    qty INTEGER NOT NULL,
    countedAt BIGINT,
    countedBy TEXT,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS support_tickets(
    id TEXT PRIMARY KEY,
    tenantId TEXT REFERENCES tenants(id),
    subject TEXT NOT NULL,
    priority TEXT,
    status TEXT,
    createdAt BIGINT,
    updatedAt BIGINT
  )`);
  await runAsync(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS body TEXT`);
  await runAsync(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS userId TEXT`);
  await runAsync(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS userEmail TEXT`);
  await runAsync(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS userName TEXT`);
  await runAsync(`UPDATE support_tickets SET status = 'open' WHERE status IS NULL OR status = ''`);
  await runAsync(`UPDATE support_tickets SET priority = 'medium' WHERE priority IS NULL OR priority = ''`);
  await runAsync(`UPDATE support_tickets SET updatedAt = COALESCE(updatedAt, createdAt, $1::bigint)`, [Date.now()]);
  // Backfill tenant columns if the DB was created earlier
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS sourceType TEXT`);
  await runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS sourceId TEXT`);
  await runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS sourceMeta JSONB`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS startDate TEXT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS endDate TEXT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status TEXT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS location TEXT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notes TEXT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updatedAt BIGINT`);
  await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE inventory_counts ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`UPDATE items SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE items SET category=$1 WHERE category IS NULL OR category=''`, [DEFAULT_CATEGORY_NAME]);
  await runAsync(`UPDATE categories SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE inventory SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE jobs SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE jobs SET startDate = scheduleDate WHERE startDate IS NULL AND scheduleDate IS NOT NULL`);
  await runAsync(`UPDATE jobs SET status = 'planned' WHERE status IS NULL OR status = ''`);
  await runAsync(`UPDATE jobs SET updatedAt = COALESCE(updatedAt, $1::bigint)`, [Date.now()]);
  await runAsync(`UPDATE users SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE inventory_counts SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE tenants SET status = 'active' WHERE status IS NULL OR status = ''`);
  await runAsync(`UPDATE tenants SET plan = 'starter' WHERE plan IS NULL OR plan = ''`);
  await runAsync(`UPDATE tenants SET updatedAt = COALESCE(updatedAt, createdAt, $1::bigint)`, [Date.now()]);
  const tenants = await allAsync('SELECT id FROM tenants', []);
  for (const tenant of tenants) {
    await ensureDefaultCategory(tenant.id);
  }
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_code ON inventory(code)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_job ON inventory(jobId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_source ON inventory(sourceType, sourceId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_items_tenant ON items(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_tenant ON inventory(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_counts_tenant ON inventory_counts(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant ON support_tickets(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(userId)');
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
  await runAsync('CREATE UNIQUE INDEX IF NOT EXISTS uq_counts_code_tenant ON inventory_counts(code, tenantId)');
  await runAsync(`
    WITH dup AS (
      SELECT ctid FROM (
        SELECT ctid, code, tenantId, ROW_NUMBER() OVER (PARTITION BY code, tenantId ORDER BY ctid) AS rn
        FROM inventory_counts
      ) t WHERE rn > 1
    )
    DELETE FROM inventory_counts WHERE ctid IN (SELECT ctid FROM dup)
  `);
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
  // Clean any legacy duplicate jobs per tenant before enforcing composite PK
  await runAsync(`
    WITH dup AS (
      SELECT ctid FROM (
        SELECT ctid, code, tenantId, ROW_NUMBER() OVER (PARTITION BY code, tenantId ORDER BY ctid) AS rn
        FROM jobs
      ) t WHERE rn > 1
    )
    DELETE FROM jobs WHERE ctid IN (SELECT ctid FROM dup)
  `);
  await runAsync('ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_pkey');
  await runAsync('ALTER TABLE jobs ADD CONSTRAINT jobs_pkey PRIMARY KEY (code, tenantId)');
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
  await runAsync(`UPDATE inventory SET sourceType='order', sourceId=id WHERE type='ordered' AND (sourceId IS NULL OR sourceId = '')`);
  // Backfill any jobs referenced by inventory rows
  await runAsync(`
    INSERT INTO jobs(code,name,startDate,endDate,status,location,notes,updatedAt,tenantId)
    SELECT DISTINCT inv.jobId, inv.jobId, NULL, NULL, 'planned', NULL, NULL, $1::bigint, inv.tenantId
    FROM inventory inv
    WHERE inv.jobId IS NOT NULL AND inv.jobId <> ''
    ON CONFLICT (code, tenantId) DO NOTHING
  `, [Date.now()]);
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
  await runAsync('ALTER TABLE inventory_counts DROP CONSTRAINT IF EXISTS inventory_counts_code_fk');
  await runAsync(`DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_counts_code_fk') THEN
      ALTER TABLE inventory_counts ADD CONSTRAINT inventory_counts_code_fk FOREIGN KEY (code, tenantId) REFERENCES items(code, tenantId);
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
loadSellerStore();

function statusForType(type) {
  if (type === 'ordered') return 'ordered';
  if (type === 'purchase') return 'purchased';
  if (type === 'in') return 'in-stock';
  if (type === 'out') return 'checked-out';
  if (type === 'reserve') return 'reserved';
  if (type === 'reserve_release') return 'reserve-released';
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
        WHEN type='reserve_release' THEN qty
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
    if(t==='in' || t==='return' || t==='reserve_release') return sum + q;
    if(t==='reserve' || t==='out' || t==='consume') return sum - q;
    return sum;
  },0);
}

async function calcReservedOutstandingTx(client, code, jobId, tenantIdVal) {
  if(!jobId) return 0;
  const rows = await client.query(
    `SELECT type,qty FROM inventory WHERE code=$1 AND tenantId=$2 AND jobId=$3 FOR UPDATE`,
    [code, tenantIdVal, jobId]
  );
  const reserved = (rows.rows || []).reduce((sum,r)=>{
    const q = Number(r.qty)||0;
    if(r.type==='reserve') return sum + q;
    if(r.type==='reserve_release') return sum - q;
    return sum;
  },0);
  return Math.max(0, reserved);
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

async function resolveReturnJobIdTx(client, code, tenantIdVal, jobIdRaw) {
  const normalized = normalizeJobId(jobIdRaw);
  if (normalized) return normalized;
  const rows = await client.query(
    `SELECT jobId, COALESCE(SUM(CASE WHEN type='out' THEN qty WHEN type='return' THEN -qty ELSE 0 END),0) as outstanding
     FROM inventory
     WHERE code=$1 AND tenantId=$2 AND type IN ('out','return')
     GROUP BY jobId
     HAVING COALESCE(SUM(CASE WHEN type='out' THEN qty WHEN type='return' THEN -qty ELSE 0 END),0) > 0`,
    [code, tenantIdVal]
  );
  if (rows.rows.length === 1) {
    return rows.rows[0].jobid || rows.rows[0].jobId || null;
  }
  if (rows.rows.length > 1) {
    throw new Error('jobId required (multiple outstanding checkouts)');
  }
  return null;
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
function actorInfo(req) {
  const user = req.user || {};
  return { userEmail: user.email || '', userName: user.name || '' };
}
async function loadItem(client, code, tenantIdVal) {
  const row = await client.query('SELECT * FROM items WHERE code=$1 AND tenantId=$2', [code, tenantIdVal]);
  return row.rows[0];
}

async function loadSourceEvent(client, sourceType, sourceId, tenantIdVal) {
  if (!sourceType || !sourceId) return null;
  const row = await client.query('SELECT * FROM inventory WHERE id=$1 AND tenantId=$2', [sourceId, tenantIdVal]);
  const source = row.rows[0];
  if (!source) return null;
  if (sourceType === 'order' && source.type !== 'ordered') return null;
  if (sourceType === 'purchase' && source.type !== 'purchase') return null;
  return source;
}

async function calcOpenSourceQtyTx(client, sourceId, code, tenantIdVal) {
  const sourceRow = await client.query('SELECT qty FROM inventory WHERE id=$1 AND tenantId=$2', [sourceId, tenantIdVal]);
  const sourceQty = Number(sourceRow.rows[0]?.qty || 0);
  const checkins = await client.query(
    `SELECT COALESCE(SUM(qty),0) AS qty FROM inventory WHERE sourceId=$1 AND tenantId=$2 AND type='in' AND code=$3`,
    [sourceId, tenantIdVal, code]
  );
  const checkedIn = Number(checkins.rows[0]?.qty || 0);
  return Math.max(0, sourceQty - checkedIn);
}

async function ensureItem(client, { code, name, category, unitPrice, tenantIdVal }) {
  let item = await loadItem(client, code, tenantIdVal);
  if (item) {
    if (!normalizeCategoryName(item.category)) {
      const resolved = await resolveCategoryInputTx(client, tenantIdVal, category);
      await client.query('UPDATE items SET category=$1 WHERE code=$2 AND tenantId=$3', [resolved.name, code, tenantIdVal]);
      item = await loadItem(client, code, tenantIdVal);
    }
    return item;
  }
  if (!name) throw new Error('unknown item code; include a name to add it');
  const resolved = await resolveCategoryInputTx(client, tenantIdVal, category);
  const price = unitPrice === undefined || unitPrice === null || Number.isNaN(Number(unitPrice)) ? null : Number(unitPrice);
  await client.query(`INSERT INTO items(code,name,category,unitPrice,tenantId)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (code, tenantId) DO NOTHING`, [code, name, resolved.name || null, price, tenantIdVal]);
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
  await ensureDefaultCategory(tenantId);
  const { salt, hash } = await hashPassword(DEV_PASSWORD);
  await runAsync(`INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (email, tenantId) DO UPDATE SET role='dev', salt=EXCLUDED.salt, hash=EXCLUDED.hash, name=EXCLUDED.name`,
    [newId(), normalizeEmail(DEV_EMAIL), 'Dev', 'dev', salt, hash, Date.now(), tenantId]);
}

async function processInventoryEvent(client, { type, code, name, category, unitPrice, qty, location, jobId, notes, reason, ts, returnDate, userEmail, userName, tenantIdVal, requireRecentReturn, returnWindowDays, sourceType, sourceId, sourceMeta }) {
  const qtyNum = Number(qty);
  if (!code || !qtyNum || qtyNum <= 0) throw new Error('code and positive qty required');
  const jobIdVal = (jobId || '').trim() || null;
  const item = await ensureItem(client, { code, name, category, unitPrice, tenantIdVal });
  const nowTs = ts || Date.now();
  let status = statusForType(type);

  if (type === 'reserve') {
    if (!jobIdVal) throw new Error('jobId required');
    const avail = await calcAvailabilityTx(client, code, tenantIdVal);
    if (qtyNum > avail) throw new Error('insufficient stock to reserve');
  }
  if (type === 'out') {
    await enforceCheckoutAging(tenantIdVal);
    const avail = await calcAvailabilityTx(client, code, tenantIdVal);
    let reserved = 0;
    if (jobIdVal) {
      reserved = await calcReservedOutstandingTx(client, code, jobIdVal, tenantIdVal);
    }
    if (qtyNum > (avail + reserved)) throw new Error('insufficient stock to checkout');
    if (jobIdVal) {
      const releaseQty = Math.min(qtyNum, reserved);
      if (releaseQty > 0) {
        await client.query(`INSERT INTO inventory(id,code,name,qty,jobId,notes,ts,type,status,userEmail,userName,tenantId)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [newId(), code, item?.name || name || code, releaseQty, jobIdVal, 'auto-release on checkout', nowTs, 'reserve_release', statusForType('reserve_release'), userEmail, userName, tenantIdVal]);
      }
    }
  }
  if (type === 'return') {
    const outstanding = await calcOutstandingCheckoutTx(client, code, jobIdVal, tenantIdVal);
    if (outstanding <= 0) throw new Error('no matching checkout to return');
    if (qtyNum > outstanding) throw new Error('return exceeds outstanding checkout');
    if (requireRecentReturn) {
      const last = await getLastCheckoutTs(client, code, jobIdVal, tenantIdVal);
      const windowMs = getReturnWindowMs({ returnWindowDays });
      const windowDays = Math.round(windowMs / (24 * 60 * 60 * 1000));
      if (!last || (nowTs - last) > windowMs) throw new Error(`return window exceeded (${windowDays} days)`);
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
    jobId: jobIdVal,
    notes,
    reason,
    returnDate,
    ts: nowTs,
    type,
    status,
    userEmail,
    userName,
    tenantId: tenantIdVal,
    sourceType: sourceType || null,
    sourceId: sourceId || null,
    sourceMeta: sourceMeta || null
  };
  await client.query(`INSERT INTO inventory(id,code,name,qty,location,jobId,notes,reason,returnDate,ts,type,status,userEmail,userName,tenantId,sourceType,sourceId,sourceMeta)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [entry.id, entry.code, entry.name, entry.qty, entry.location, entry.jobId, entry.notes, entry.reason, entry.returnDate, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName, entry.tenantId, entry.sourceType, entry.sourceId, entry.sourceMeta]);
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
    const { code, name, category, unitPrice, qty, location, jobId, notes, ts, sourceType, sourceId, reassignReason } = req.body;
    const qtyNum = Number(qty);
    if (!sourceType || !sourceId) return res.status(400).json({ error: 'sourceType and sourceId required' });
    if (!['order','purchase'].includes(sourceType)) return res.status(400).json({ error: 'invalid sourceType' });
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const entry = await withTransaction(async (client) => {
      const source = await loadSourceEvent(client, sourceType, sourceId, t);
      if (!source) throw new Error('source not found');
      if (source.code !== code) throw new Error('source item mismatch');
      const sourceMeta = source?.sourcemeta || source?.sourceMeta || null;
      const autoReserve = sourceMeta?.autoReserve !== false;
      const openQty = await calcOpenSourceQtyTx(client, sourceId, code, t);
      if (qtyNum > openQty) throw new Error('check-in exceeds remaining open qty');
      const sourceJob = normalizeJobId(source.jobid || source.jobId || '');
      let jobIdVal = normalizeJobId(jobId) || sourceJob;
      if (sourceJob && jobIdVal !== sourceJob) {
        const role = (req.user?.role || '').toLowerCase();
        if (role !== 'admin' && role !== 'dev') throw new Error('project mismatch for source');
        if (!reassignReason) throw new Error('reassign reason required to override project');
      }
      jobIdVal = jobIdVal || null;
      const categoryInfo = await getItemCategoryRulesTx(client, t, code, category);
      enforceCategoryRules(categoryInfo.rules, { action: 'checkin', jobId: jobIdVal, location, notes, qty: qtyNum });
      const checkin = await processInventoryEvent(client, {
        type: 'in',
        code,
        name,
        category: categoryInfo.categoryName,
        unitPrice,
        qty,
        location,
        jobId: jobIdVal,
        notes,
        ts,
        userEmail: actor.userEmail,
        userName: actor.userName,
        tenantIdVal: t,
        sourceType,
        sourceId
      });
      // If a project is selected, auto-reserve the same qty to earmark stock for that project.
      if (jobIdVal && autoReserve && categoryInfo.rules.allowReserve !== false) {
        const avail = await calcAvailabilityTx(client, code, t);
        const reserveQty = Math.min(qtyNum, Math.max(0, avail));
        if (reserveQty > 0) {
          await processInventoryEvent(client, { type: 'reserve', code, jobId: jobIdVal, qty: reserveQty, returnDate: null, notes: 'auto-reserve on check-in', ts: checkin.ts, userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t });
        }
      }
      return checkin;
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.in', details: { code, qty, jobId, location, sourceType, sourceId } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

app.post('/api/inventory-checkout', async (req, res) => {
  try {
    const { code, jobId, qty, reason, notes, ts } = req.body;
    const t = tenantId(req);
    const actor = actorInfo(req);
    const entry = await withTransaction(async (client) => {
      const { rules } = await getItemCategoryRulesTx(client, t, code);
      enforceCategoryRules(rules, { action: 'checkout', jobId, notes: notes || reason, qty });
      const tsNow = ts || Date.now();
      const due = tsNow + getReturnWindowMs(rules);
      return processInventoryEvent(client, { type: 'out', code, jobId, qty, reason, notes, ts: tsNow, returnDate: new Date(due).toISOString(), userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t });
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.out', details: { code, qty, jobId } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

app.delete('/api/inventory', requireRole('admin'), async (req, res) => {
  try {
    const type = req.query.type;
    const t = tenantId(req);
    if (type) await runAsync('DELETE FROM inventory WHERE tenantId=$1 AND type = $2', [t, type]);
    else await runAsync('DELETE FROM inventory WHERE tenantId=$1', [t]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/inventory-checkout', requireRole('admin'), async (req, res) => {
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
    const actor = actorInfo(req);
    const entry = await withTransaction(async (client) => {
      const { rules } = await getItemCategoryRulesTx(client, t, code);
      enforceCategoryRules(rules, { action: 'reserve', jobId, notes, qty });
      return processInventoryEvent(client, { type: 'reserve', code, jobId, qty, returnDate, notes, ts, userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t });
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.reserve', details: { code, qty, jobId, returnDate } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

// Bulk reserve to minimize clicks (admin only)
app.post('/api/inventory-reserve/bulk', requireRole('admin'), async (req, res) => {
  try {
    const { jobId, returnDate, notes, lines } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const entries = Array.isArray(lines) ? lines : [];
    if (!entries.length) return res.status(400).json({ error: 'lines array required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const results = [];
    await withTransaction(async (client) => {
      for (const line of entries) {
        const code = (line?.code || '').trim();
        const qty = Number(line?.qty || 0);
        if (!code || qty <= 0) throw new Error(`Invalid line for code ${code || ''}`);
        const { rules } = await getItemCategoryRulesTx(client, t, code);
        enforceCategoryRules(rules, { action: 'reserve', jobId, notes, qty });
        const ev = await processInventoryEvent(client, { type: 'reserve', code, jobId, qty, returnDate, notes, ts: line?.ts || Date.now(), userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t });
        results.push(ev);
      }
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.reserve', details: { lines: results.length, jobId } });
    res.status(201).json({ count: results.length, reserves: results });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.delete('/api/inventory-reserve', requireRole('admin'), async (req, res) => {
  try {
    await runAsync("DELETE FROM inventory WHERE type='reserve' AND tenantId=$1", [tenantId(req)]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ADMIN REASSIGN (move reserved stock between projects or to general)
app.post('/api/inventory-reassign', requireRole('admin'), async (req, res) => {
  try {
    const { code, fromJobId, toJobId, qty, reason } = req.body || {};
    const qtyNum = Number(qty);
    if (!code || !fromJobId) return res.status(400).json({ error: 'code and fromJobId required' });
    if (!qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'positive qty required' });
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const fromId = normalizeJobId(fromJobId);
    const toId = normalizeJobId(toJobId);
    const result = await withTransaction(async (client) => {
      const { rules } = await getItemCategoryRulesTx(client, t, code);
      enforceCategoryRules(rules, { action: 'reserve', jobId: fromId, notes: reason, qty: qtyNum });
      const reserved = await calcReservedOutstandingTx(client, code, fromId, t);
      if (qtyNum > reserved) throw new Error('reassign exceeds reserved qty');
      const release = await processInventoryEvent(client, { type: 'reserve_release', code, jobId: fromId, qty: qtyNum, notes: `reassign: ${reason}`, ts: Date.now(), userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t });
      let reserve = null;
      if (toId) {
        reserve = await processInventoryEvent(client, { type: 'reserve', code, jobId: toId, qty: qtyNum, notes: `reassign: ${reason}`, ts: release.ts, userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t });
      }
      return { release, reserve };
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.reserve', details: { code, qty: qtyNum, fromJobId, toJobId, reason } });
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/inventory-return', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM inventory WHERE type=$1 AND tenantId=$2', ['return', tenantId(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/inventory-return', async (req, res) => {
  try {
    const { code, jobId, qty, reason, location, notes, ts } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const entry = await withTransaction(async (client) => {
      const resolvedJobId = await resolveReturnJobIdTx(client, code, t, jobId);
      const { rules } = await getItemCategoryRulesTx(client, t, code);
      enforceCategoryRules(rules, { action: 'return', jobId: resolvedJobId, location, notes: notes || reason, qty });
      return processInventoryEvent(client, { type: 'return', code, jobId: resolvedJobId, qty, reason, location, notes, ts, userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t, requireRecentReturn: true, returnWindowDays: rules.returnWindowDays });
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.return', details: { code, qty, jobId: entry.jobId || null, reason } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

app.delete('/api/inventory-return', requireRole('admin'), async (req, res) => {
  try {
    await runAsync("DELETE FROM inventory WHERE type='return' AND tenantId=$1", [tenantId(req)]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// INVENTORY COUNTS (cycle counts)
app.get('/api/inventory-counts', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM inventory_counts WHERE tenantId=$1', [tenantId(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/inventory-counts', async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.counts) ? req.body.counts : [];
    if (!entries.length) return res.status(400).json({ error: 'counts array required' });
    const t = tenantId(req);
    await withTransaction(async (client) => {
      for (const entry of entries) {
        const code = (entry.code || '').trim();
        const qtyNum = Number(entry.qty);
        if (!code || !Number.isFinite(qtyNum) || qtyNum < 0) {
          throw new Error('code and non-negative qty required');
        }
        const item = await loadItem(client, code, t);
        if (!item) throw new Error(`item not found: ${code}`);
        await client.query(
          `INSERT INTO inventory_counts(id,code,qty,countedAt,countedBy,tenantId)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (code, tenantId)
           DO UPDATE SET qty=EXCLUDED.qty, countedAt=EXCLUDED.countedAt, countedBy=EXCLUDED.countedBy`,
          [newId(), code, qtyNum, Date.now(), req.user?.email || '', t]
        );
      }
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.count', details: { lines: entries.length } });
    const rows = await allAsync('SELECT * FROM inventory_counts WHERE tenantId=$1', [t]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

// OPS EVENTS (pick/check-in timers)
app.post('/api/ops-events', async (req, res) => {
  try {
    const { type, stage, sessionId, durationMs, qty, lines } = req.body || {};
    const t = tenantId(req);
    const allowedTypes = ['pick', 'checkin'];
    const allowedStages = ['start', 'finish'];
    if (!allowedTypes.includes(type) || !allowedStages.includes(stage)) {
      return res.status(400).json({ error: 'invalid type or stage' });
    }
    const action = `ops.${type}.${stage}`;
    const details = {
      type,
      stage,
      sessionId: sessionId || null,
      durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
      qty: Number.isFinite(Number(qty)) ? Number(qty) : null,
      lines: Number.isFinite(Number(lines)) ? Number(lines) : null
    };
    await logAudit({ tenantId: t, userId: currentUserId(req), action, details });
    res.status(201).json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/ops-events', async (req, res) => {
  try {
    const type = (req.query.type || '').toString().toLowerCase();
    const days = Number(req.query.days || 30);
    if (!['pick', 'checkin'].includes(type)) return res.status(400).json({ error: 'type required' });
    const action = `ops.${type}.finish`;
    const cutoff = Date.now() - (Number.isFinite(days) ? days : 30) * 24 * 60 * 60 * 1000;
    const rows = await allAsync(
      `SELECT a.id, a.action, a.details, a.ts, u.email as userEmail
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.userId
       WHERE a.tenantId=$1 AND a.action=$2 AND a.ts >= $3
       ORDER BY a.ts DESC`,
      [tenantId(req), action, cutoff]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// CONSUME / LOST / DAMAGED (admin-only)
app.post('/api/inventory-consume', requireRole('admin'), async (req, res) => {
  try {
    const { code, qty, reason, notes, ts } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const entry = await withTransaction(async (client) => {
      return processInventoryEvent(client, { type: 'consume', code, qty, reason, notes, ts, userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t });
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
    const { code, oldCode, name, category, unitPrice, material, shape, brand, notes, description, tags, lowStockEnabled, uom, serialized, lot, expires, warehouse, zone, bin, reorderPoint, minStock } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const t = tenantId(req);
    const exists = await itemExists(code, t);
    const categoryInfo = await resolveCategoryInput(t, category);
    const normalizedTags = normalizeItemTags(tags);
    const normalizedLowStockEnabled = normalizeItemLowStockEnabled(lowStockEnabled);
    const price = unitPrice === undefined || unitPrice === null || Number.isNaN(Number(unitPrice)) ? null : Number(unitPrice);
    const materialValue = (material || '').trim() || null;
    const shapeValue = (shape || '').trim() || null;
    const brandValue = (brand || '').trim() || null;
    const notesValue = (notes || '').trim() || null;
    const uomValue = (uom || '').trim() || null;
    const warehouseValue = (warehouse || '').trim() || null;
    const zoneValue = (zone || '').trim() || null;
    const binValue = (bin || '').trim() || null;
    const serializedValue = normalizeOptionalBool(serialized);
    const lotValue = normalizeOptionalBool(lot);
    const expiresValue = normalizeOptionalBool(expires);
    const reorderPointValue = Number(reorderPoint);
    const minStockValue = Number(minStock);
    const normalizedReorderPoint = Number.isFinite(reorderPointValue) && reorderPointValue >= 0 ? Math.floor(reorderPointValue) : null;
    const normalizedMinStock = Number.isFinite(minStockValue) && minStockValue >= 0 ? Math.floor(minStockValue) : null;
    if (oldCode && oldCode !== code) await runAsync('DELETE FROM items WHERE code=$1 AND tenantId=$2', [oldCode, t]);
    await runAsync(`INSERT INTO items(code,name,category,unitPrice,material,shape,brand,notes,uom,serialized,lot,expires,warehouse,zone,bin,reorderPoint,minStock,description,tags,lowStockEnabled,tenantId)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT(code,tenantId) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, unitPrice=EXCLUDED.unitPrice, material=EXCLUDED.material, shape=EXCLUDED.shape, brand=EXCLUDED.brand, notes=EXCLUDED.notes, uom=EXCLUDED.uom, serialized=EXCLUDED.serialized, lot=EXCLUDED.lot, expires=EXCLUDED.expires, warehouse=EXCLUDED.warehouse, zone=EXCLUDED.zone, bin=EXCLUDED.bin, reorderPoint=EXCLUDED.reorderPoint, minStock=EXCLUDED.minStock, description=EXCLUDED.description, tags=EXCLUDED.tags, lowStockEnabled=EXCLUDED.lowStockEnabled, tenantId=EXCLUDED.tenantId`,
      [code, name, categoryInfo.name, price, materialValue, shapeValue, brandValue, notesValue, uomValue, serializedValue, lotValue, expiresValue, warehouseValue, zoneValue, binValue, normalizedReorderPoint, normalizedMinStock, description, normalizedTags, normalizedLowStockEnabled, t]);
    await logAudit({ tenantId: t, userId: currentUserId(req), action: exists ? 'items.update' : 'items.create', details: { code } });
    res.status(201).json({ code, name, category: categoryInfo.name, unitPrice: price, material: materialValue, shape: shapeValue, brand: brandValue, notes: notesValue, uom: uomValue, serialized: serializedValue, lot: lotValue, expires: expiresValue, warehouse: warehouseValue, zone: zoneValue, bin: binValue, reorderPoint: normalizedReorderPoint, minStock: normalizedMinStock, description, tags: normalizedTags, lowStockEnabled: normalizedLowStockEnabled, tenantId: t });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});
app.delete('/api/items/:code', requireRole('admin'), async (req, res) => {
  try {
    await runAsync('DELETE FROM items WHERE code=$1 AND tenantId=$2', [req.params.code, tenantId(req)]);
    await logAudit({ tenantId: tenantId(req), userId: currentUserId(req), action: 'items.delete', details: { code: req.params.code } });
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// BULK ITEM IMPORT (admin)
app.post('/api/items/bulk', requireRole('admin'), async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'items array required' });
    const t = tenantId(req);
    const results = [];
    await withTransaction(async (client) => {
      for (const raw of items) {
        const code = (raw?.code || '').trim();
        const name = (raw?.name || '').trim();
        if (!code || !name) throw new Error('code and name required');
        const categoryInfo = await resolveCategoryInputTx(client, t, raw?.category);
        const description = (raw?.description || '').trim() || null;
        const material = (raw?.material || '').trim() || null;
        const shape = (raw?.shape || '').trim() || null;
        const brand = (raw?.brand || '').trim() || null;
        const notes = (raw?.notes || '').trim() || null;
        const uom = (raw?.uom || '').trim() || null;
        const warehouse = (raw?.warehouse || '').trim() || null;
        const zone = (raw?.zone || '').trim() || null;
        const bin = (raw?.bin || '').trim() || null;
        const serialized = normalizeOptionalBool(raw?.serialized);
        const lot = normalizeOptionalBool(raw?.lot);
        const expires = normalizeOptionalBool(raw?.expires);
        const reorderPointVal = Number(raw?.reorderPoint);
        const minStockVal = Number(raw?.minStock);
        const reorderPoint = Number.isFinite(reorderPointVal) && reorderPointVal >= 0 ? Math.floor(reorderPointVal) : null;
        const minStock = Number.isFinite(minStockVal) && minStockVal >= 0 ? Math.floor(minStockVal) : null;
        const unitPrice = raw?.unitPrice === undefined || raw?.unitPrice === null || Number.isNaN(Number(raw.unitPrice))
          ? null
          : Number(raw.unitPrice);
        const tags = normalizeItemTags(raw?.tags);
        const lowStockEnabled = normalizeItemLowStockEnabled(raw?.lowStockEnabled);
        await client.query(`INSERT INTO items(code,name,category,unitPrice,material,shape,brand,notes,uom,serialized,lot,expires,warehouse,zone,bin,reorderPoint,minStock,description,tags,lowStockEnabled,tenantId)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
          ON CONFLICT(code,tenantId) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, unitPrice=EXCLUDED.unitPrice, material=EXCLUDED.material, shape=EXCLUDED.shape, brand=EXCLUDED.brand, notes=EXCLUDED.notes, uom=EXCLUDED.uom, serialized=EXCLUDED.serialized, lot=EXCLUDED.lot, expires=EXCLUDED.expires, warehouse=EXCLUDED.warehouse, zone=EXCLUDED.zone, bin=EXCLUDED.bin, reorderPoint=EXCLUDED.reorderPoint, minStock=EXCLUDED.minStock, description=EXCLUDED.description, tags=EXCLUDED.tags, lowStockEnabled=EXCLUDED.lowStockEnabled, tenantId=EXCLUDED.tenantId`,
          [code, name, categoryInfo.name, unitPrice, material, shape, brand, notes, uom, serialized, lot, expires, warehouse, zone, bin, reorderPoint, minStock, description, tags, lowStockEnabled, t]);
        results.push(code);
      }
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'items.update', details: { bulk: results.length } });
    res.status(201).json({ count: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

// CATEGORIES
app.get('/api/categories', async (req, res) => {
  try {
    const t = tenantId(req);
    await ensureDefaultCategory(t);
    const rows = await allAsync('SELECT * FROM categories WHERE tenantId=$1 ORDER BY name ASC', [t]);
    const categories = rows.map(r => ({
      id: r.id,
      name: r.name,
      rules: normalizeCategoryRules(r.rules),
      tenantId: r.tenantid || r.tenantId,
      createdAt: r.createdat || r.createdAt || null,
      updatedAt: r.updatedat || r.updatedAt || null
    }));
    res.json(categories);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/categories', requireRole('admin'), async (req, res) => {
  try {
    const name = normalizeCategoryName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name required' });
    const t = tenantId(req);
    await ensureDefaultCategory(t);
    const existing = await getAsync('SELECT id FROM categories WHERE tenantId=$1 AND LOWER(name)=LOWER($2) LIMIT 1', [t, name]);
    if (existing) return res.status(409).json({ error: 'category already exists' });
    const rules = normalizeCategoryRules(req.body?.rules || req.body);
    const now = Date.now();
    const id = newId();
    await runAsync(
      `INSERT INTO categories(id,name,rules,tenantId,createdAt,updatedAt)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [id, name, rules, t, now, now]
    );
    res.status(201).json({ id, name, rules, tenantId: t, createdAt: now, updatedAt: now });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

app.put('/api/categories/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const existing = await getAsync('SELECT * FROM categories WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    if (!existing) return res.status(404).json({ error: 'category not found' });
    const existingName = existing.name || '';
    const isDefault = existingName.toLowerCase() === DEFAULT_CATEGORY_NAME.toLowerCase();
    const name = normalizeCategoryName(req.body?.name) || existingName;
    if (isDefault && name.toLowerCase() !== existingName.toLowerCase()) {
      return res.status(400).json({ error: 'default category cannot be renamed' });
    }
    if (name.toLowerCase() !== existingName.toLowerCase()) {
      const dup = await getAsync(
        'SELECT id FROM categories WHERE tenantId=$1 AND LOWER(name)=LOWER($2) AND id<>$3 LIMIT 1',
        [t, name, req.params.id]
      );
      if (dup) return res.status(409).json({ error: 'category name already exists' });
    }
    const rules = normalizeCategoryRules(req.body?.rules || req.body);
    const now = Date.now();
    await runAsync('UPDATE categories SET name=$1, rules=$2, updatedAt=$3 WHERE id=$4 AND tenantId=$5', [name, rules, now, req.params.id, t]);
    if (name.toLowerCase() !== existingName.toLowerCase()) {
      await runAsync('UPDATE items SET category=$1 WHERE tenantId=$2 AND LOWER(category)=LOWER($3)', [name, t, existingName]);
    }
    res.json({ id: req.params.id, name, rules, tenantId: t, updatedAt: now });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

app.delete('/api/categories/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const existing = await getAsync('SELECT * FROM categories WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    if (!existing) return res.status(404).json({ error: 'category not found' });
    const existingName = existing.name || '';
    if (existingName.toLowerCase() === DEFAULT_CATEGORY_NAME.toLowerCase()) {
      return res.status(400).json({ error: 'default category cannot be deleted' });
    }
    await withTransaction(async (client) => {
      await client.query('DELETE FROM categories WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
      const def = await ensureDefaultCategoryTx(client, t);
      await client.query('UPDATE items SET category=$1 WHERE tenantId=$2 AND LOWER(category)=LOWER($3)', [def.name, t, existingName]);
    });
    res.json({ status: 'ok', id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

// AUTH + USERS
app.post('/api/tenants', tenantLimiter, async (req, res) => {
  try {
  const { code, name, adminEmail, adminPassword, adminName } = req.body;
  const tenantSecret = process.env.TENANT_SIGNUP_SECRET;
  if (!tenantSecret) return res.status(400).json({ error: 'tenant signups disabled (missing TENANT_SIGNUP_SECRET)' });
  const provided = req.headers['x-tenant-signup'] || req.body?.tenantKey;
  if (provided !== tenantSecret) return res.status(403).json({ error: 'invalid tenant signup key' });
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
    const token = await createSession(user.id);
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
    let role = totalCount === 0 ? 'admin' : 'employee';
    const adminSecret = process.env.ADMIN_SIGNUP_SECRET;
    if (requestedRole === 'admin') {
      if (!adminSecret) return res.status(400).json({ error: 'admin signups disabled (missing ADMIN_SIGNUP_SECRET)' });
      const key = adminKey || req.headers['x-admin-signup'];
      if (key !== adminSecret) return res.status(403).json({ error: 'invalid admin signup key' });
      role = 'admin';
    }
    const { salt, hash } = await hashPassword(password);
    const user = { id: newId(), email: emailNorm, name, role: normalizeUserRole(role), salt, hash, createdAt: Date.now(), tenantId: tenant.id };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.tenantId]);
    const token = await createSession(user.id);
    setSessionCookie(res, token);
    await logAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.register', details: { email } });
    res.status(201).json(safeUser(user));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, tenantCode, remember } = req.body;
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
    const rememberFlag = remember === true || remember === 'true';
    const ttlMs = rememberFlag ? REMEMBER_SESSION_TTL_MS : SESSION_TTL_MS;
    const token = await createSession(user.id, ttlMs);
    setSessionCookie(res, token, ttlMs);
    await logAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.login', details: { email: emailNorm } });
    res.json(safeUser(user));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/auth/logout', async (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) await deleteSession(token);
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
    const { email, password, name, role = 'employee' } = req.body;
    const emailNorm = normalizeEmail(email);
    if (!emailNorm || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 10) return res.status(400).json({ error: 'password too weak' });
    const t = tenantId(req);
    const exists = await getAsync('SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND tenantId=$2', [emailNorm, t]);
    if (exists) return res.status(400).json({ error: 'email already exists' });
    const { salt, hash } = await hashPassword(password);
    const user = { id: newId(), email: emailNorm, name, role: normalizeUserRole(role), salt, hash, createdAt: Date.now(), tenantId: t };
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
    const nextRole = normalizeUserRole(role || user.role);
    await runAsync('UPDATE users SET email=$1, name=$2, role=$3, salt=$4, hash=$5 WHERE id=$6 AND tenantId=$7',
      [emailNorm, name ?? user.name, nextRole, salt, hash, id, t]);
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
    const { code, name, scheduleDate, startDate, endDate, status, location, notes } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const t = tenantId(req);
    const start = startDate || scheduleDate || null;
    const statusValue = (status || 'planned').toString().trim().toLowerCase();
    const updatedAt = Date.now();
    await runAsync(`INSERT INTO jobs(code,name,startDate,endDate,status,location,notes,updatedAt,tenantId)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(code,tenantId) DO UPDATE SET name=EXCLUDED.name, startDate=EXCLUDED.startDate, endDate=EXCLUDED.endDate, status=EXCLUDED.status, location=EXCLUDED.location, notes=EXCLUDED.notes, updatedAt=EXCLUDED.updatedAt`, [code, name || '', start, endDate || null, statusValue, location || null, notes || null, updatedAt, t]);
    res.status(201).json({ code, name: name || '', startDate: start || null, endDate: endDate || null, status: statusValue, location: location || null, notes: notes || null, updatedAt, tenantId: t });
  } catch (e) {
    console.warn('Job save failed', e.message || e);
    res.status(500).json({ error: e.message || 'server error' });
  }
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
    const { code, name, qty, eta, notes, ts, jobId, autoReserve } = req.body;
    const qtyNum = Number(qty);
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const jobIdVal = (jobId || '').trim() || null;
    const entry = await withTransaction(async (client) => {
      await ensureItem(client, { code, name: name || code, category: '', unitPrice: null, tenantIdVal: t });
      const sourceMeta = { autoReserve: autoReserve !== false };
      const ev = { id: newId(), code, name: name || code, qty: qtyNum, eta, notes, jobId: jobIdVal, ts: ts || Date.now(), type: 'ordered', status: statusForType('ordered'), userEmail: actor.userEmail, userName: actor.userName, tenantId: t, sourceType: 'order', sourceId: null, sourceMeta };
      ev.sourceId = ev.id;
      await client.query(`INSERT INTO inventory(id,code,name,qty,eta,notes,jobId,ts,type,status,userEmail,userName,tenantId,sourceType,sourceId,sourceMeta) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [ev.id, ev.code, ev.name, ev.qty, ev.eta, ev.notes, ev.jobId, ev.ts, ev.type, ev.status, ev.userEmail, ev.userName, ev.tenantId, ev.sourceType, ev.sourceId, ev.sourceMeta]);
      return ev;
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.order', details: { code, qty: qtyNum, jobId, eta } });
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

// Bulk order placement (admin)
app.post('/api/inventory-order/bulk', requireRole('admin'), async (req, res) => {
  try {
    const lines = Array.isArray(req.body?.orders) ? req.body.orders : [];
    if (!lines.length) return res.status(400).json({ error: 'orders array required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const results = [];
    await withTransaction(async (client) => {
      for (const line of lines) {
        const { code, name, qty, eta, notes, ts, jobId, autoReserve } = line || {};
        const qtyNum = Number(qty);
        if (!code || !qtyNum || qtyNum <= 0) throw new Error(`Invalid order line for code ${code || ''}`);
        const jobIdVal = (jobId || '').trim() || null;
        await ensureItem(client, { code, name: name || code, category: '', unitPrice: null, tenantIdVal: t });
        const sourceMeta = { autoReserve: autoReserve !== false };
        const ev = { id: newId(), code, name: name || code, qty: qtyNum, eta, notes, jobId: jobIdVal, ts: ts || Date.now(), type: 'ordered', status: statusForType('ordered'), userEmail: actor.userEmail, userName: actor.userName, tenantId: t, sourceType: 'order', sourceId: null, sourceMeta };
        ev.sourceId = ev.id;
        await client.query(`INSERT INTO inventory(id,code,name,qty,eta,notes,jobId,ts,type,status,userEmail,userName,tenantId,sourceType,sourceId,sourceMeta) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [ev.id, ev.code, ev.name, ev.qty, ev.eta, ev.notes, ev.jobId, ev.ts, ev.type, ev.status, ev.userEmail, ev.userName, ev.tenantId, ev.sourceType, ev.sourceId, ev.sourceMeta]);
        results.push(ev);
      }
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.order', details: { lines: results.length } });
    res.status(201).json({ count: results.length, orders: results });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

// FIELD PURCHASES (employee intake)
app.post('/api/field-purchase', async (req, res) => {
  try {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!lines.length) return res.status(400).json({ error: 'lines array required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const results = [];
    await withTransaction(async (client) => {
      for (const line of lines) {
        const code = (line?.code || '').trim();
        const name = (line?.name || '').trim();
        const category = (line?.category || '').trim();
        const qtyNum = Number(line?.qty || 0);
        if (!code || !qtyNum || qtyNum <= 0) throw new Error(`Invalid line for code ${code || ''}`);
        if (!name) throw new Error(`Name required for new purchase (${code})`);
        const jobIdVal = normalizeJobId(line?.jobId || req.body?.jobId || '') || null;
        const location = (line?.location || req.body?.location || '').trim();
        const notes = (line?.notes || req.body?.notes || '').trim();
        const tsVal = line?.ts || req.body?.purchasedAt || Date.now();
        const unitPrice = line?.unitPrice ?? null;
        const categoryInfo = await getItemCategoryRulesTx(client, t, code, category);
        enforceCategoryRules(categoryInfo.rules, { action: 'field-purchase', jobId: jobIdVal, location, notes, qty: qtyNum });
        const sourceMeta = {
          vendor: line?.vendor || req.body?.vendor || '',
          receipt: line?.receipt || req.body?.receipt || '',
          cost: line?.cost ?? line?.unitPrice ?? null,
          purchasedAt: tsVal
        };
        const purchase = await processInventoryEvent(client, {
          type: 'purchase',
          code,
          name,
          category: categoryInfo.categoryName,
          unitPrice,
          qty: qtyNum,
          location,
          jobId: jobIdVal,
          notes,
          ts: tsVal,
          userEmail: actor.userEmail,
          userName: actor.userName,
          tenantIdVal: t,
          sourceType: 'purchase',
          sourceMeta
        });
        const checkin = await processInventoryEvent(client, {
          type: 'in',
          code,
          name,
          category: categoryInfo.categoryName,
          unitPrice,
          qty: qtyNum,
          location,
          jobId: jobIdVal,
          notes: notes || 'Field purchase',
          ts: tsVal,
          userEmail: actor.userEmail,
          userName: actor.userName,
          tenantIdVal: t,
          sourceType: 'purchase',
          sourceId: purchase.id,
          sourceMeta
        });
        if (jobIdVal && categoryInfo.rules.allowReserve !== false) {
          const avail = await calcAvailabilityTx(client, code, t);
          const reserveQty = Math.min(qtyNum, Math.max(0, avail));
          if (reserveQty > 0) {
            await processInventoryEvent(client, {
              type: 'reserve',
              code,
              jobId: jobIdVal,
              qty: reserveQty,
              returnDate: null,
              notes: 'auto-reserve on field purchase',
              ts: checkin.ts,
              userEmail: actor.userEmail,
              userName: actor.userName,
              tenantIdVal: t
            });
          }
        }
        results.push({ purchase, checkin });
      }
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.in', details: { sourceType: 'purchase', count: results.length } });
    res.status(201).json({ count: results.length, entries: results });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

// DEV RESET (destructive, dev-only)
app.post('/api/dev/reset', requireDev, async (req, res) => {
  try {
    const token = req.headers['x-dev-reset'];
    if (!token || token !== DEV_RESET_TOKEN) return res.status(401).json({ error: 'invalid token' });

    await withTransaction(async (client) => {
      await client.query('TRUNCATE inventory');
      await client.query('TRUNCATE audit_events');
      await client.query('TRUNCATE inventory_counts');
      await client.query('TRUNCATE support_tickets');
      await client.query('TRUNCATE items');
      await client.query('TRUNCATE jobs');
      await client.query('TRUNCATE users');
      await client.query('TRUNCATE sessions');
      await client.query('TRUNCATE categories');
      await client.query("DELETE FROM tenants WHERE id <> 'default'");
      await client.query(`INSERT INTO tenants(id,code,name,createdAt) VALUES('default','default','Default Tenant',$1)
        ON CONFLICT (id) DO NOTHING`, [Date.now()]);
      await client.query(
        `INSERT INTO categories(id,name,rules,tenantId,createdAt,updatedAt)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [newId(), DEFAULT_CATEGORY_NAME, DEFAULT_CATEGORY_RULES, 'default', Date.now(), Date.now()]
      );
      const adminPwd = 'ChangeMe123!';
      const adminHash = await hashPassword(adminPwd);
      const devHash = await hashPassword(DEV_PASSWORD);
      await client.query('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [newId(), 'admin@example.com', 'Admin', 'admin', adminHash.salt, adminHash.hash, Date.now(), 'default']);
      await client.query('INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [newId(), DEV_EMAIL, 'Dev', 'admin', devHash.salt, devHash.hash, Date.now(), 'default']);
    });
    await clearSessions();
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
    const t = tenantId(req);
    const row = await getAsync(`
      SELECT 
        COALESCE(SUM(CASE WHEN type='in' THEN qty WHEN type='return' THEN qty WHEN type='reserve_release' THEN qty 
WHEN type='out' THEN -qty WHEN type='reserve' THEN -qty ELSE 0 END),0) as availableunits,
        COALESCE(SUM(CASE WHEN type='reserve' THEN qty WHEN type='reserve_release' THEN -qty ELSE 0 END),0) as 
reservedunits,
        COALESCE(COUNT(DISTINCT CASE WHEN jobId IS NOT NULL AND jobId != '' THEN jobId END),0) as activejobs,
        COALESCE(SUM(CASE WHEN ts >= $1 THEN 1 ELSE 0 END),0) as txlast7
      FROM inventory
      WHERE tenantId=$2
    `, [now - 7 * 24 * 60 * 60 * 1000, t]);
    const lowRows = await allAsync(`
      SELECT i.code, i.name,
        COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN 
inv.type='reserve_release' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 
END),0) as available,
        COALESCE(SUM(CASE WHEN inv.type='reserve' THEN inv.qty WHEN inv.type='reserve_release' THEN -inv.qty ELSE 0 
END),0) as reserve
      FROM items i
      LEFT JOIN inventory inv ON inv.code = i.code AND inv.tenantId = i.tenantId
      LEFT JOIN categories c ON c.tenantId = i.tenantId AND LOWER(c.name)=LOWER(COALESCE(NULLIF(i.category,''), $2))
      WHERE i.tenantId=$1
        AND COALESCE(i.lowStockEnabled, (c.rules->>'lowStockEnabled')::boolean, true) = true
      GROUP BY i.code, i.name, c.rules
      HAVING COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN 
inv.type='reserve_release' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 
END),0) > 0
        AND COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN 
inv.type='reserve_release' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 
END),0) <= COALESCE((c.rules->>'lowStockThreshold')::int, $3)
      ORDER BY available ASC
      LIMIT 20
    `, [t, DEFAULT_CATEGORY_NAME, DEFAULT_CATEGORY_RULES.lowStockThreshold]);
    res.json({ ...row, lowStockCount: lowRows.length });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/low-stock', async (req, res) => {
  try {
    const t = tenantId(req);
    const rows = await allAsync(`
      SELECT i.code, i.name,
        COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN 
inv.type='reserve_release' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 
END),0) as available,
        COALESCE(SUM(CASE WHEN inv.type='reserve' THEN inv.qty WHEN inv.type='reserve_release' THEN -inv.qty ELSE 0 
END),0) as reserve
      FROM items i
      LEFT JOIN inventory inv ON inv.code = i.code AND inv.tenantId = i.tenantId
      LEFT JOIN categories c ON c.tenantId = i.tenantId AND LOWER(c.name)=LOWER(COALESCE(NULLIF(i.category,''), $2))
      WHERE i.tenantId=$1
        AND COALESCE(i.lowStockEnabled, (c.rules->>'lowStockEnabled')::boolean, true) = true
      GROUP BY i.code, i.name, c.rules
      HAVING COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN 
inv.type='reserve_release' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 
END),0) > 0
        AND COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN 
inv.type='reserve_release' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 
END),0) <= COALESCE((c.rules->>'lowStockThreshold')::int, $3)
      ORDER BY available ASC
      LIMIT 20
    `, [t, DEFAULT_CATEGORY_NAME, DEFAULT_CATEGORY_RULES.lowStockThreshold]);
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

// SUPPORT TICKETS (authenticated)
app.get('/api/support/tickets', async (req, res) => {
  try {
    const t = tenantId(req);
    const role = (req.user?.role || '').toLowerCase();
    let rows = [];
    if (role === 'admin' || role === 'dev') {
      rows = await allAsync(
        'SELECT * FROM support_tickets WHERE tenantId=$1 ORDER BY updatedAt DESC NULLS LAST, createdAt DESC NULLS LAST',
        [t]
      );
    } else {
      rows = await allAsync(
        'SELECT * FROM support_tickets WHERE tenantId=$1 AND userId=$2 ORDER BY updatedAt DESC NULLS LAST, createdAt DESC NULLS LAST',
        [t, currentUserId(req)]
      );
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/support/tickets', async (req, res) => {
  try {
    const subject = (req.body?.subject || '').trim();
    const priority = (req.body?.priority || 'medium').toString().trim().toLowerCase();
    const body = (req.body?.body || '').trim();
    if (!subject) return res.status(400).json({ error: 'subject required' });
    const t = tenantId(req);
    const user = req.user || {};
    const now = Date.now();
    const ticket = {
      id: newId(),
      tenantId: t,
      subject,
      priority: ['low','medium','high'].includes(priority) ? priority : 'medium',
      status: 'open',
      body,
      userId: user.id || null,
      userEmail: user.email || '',
      userName: user.name || '',
      createdAt: now,
      updatedAt: now
    };
    await runAsync(
      `INSERT INTO support_tickets(id,tenantId,subject,priority,status,body,userId,userEmail,userName,createdAt,updatedAt)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ticket.id,
        ticket.tenantId,
        ticket.subject,
        ticket.priority,
        ticket.status,
        ticket.body,
        ticket.userId,
        ticket.userEmail,
        ticket.userName,
        ticket.createdAt,
        ticket.updatedAt
      ]
    );
    res.status(201).json(ticket);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// SELLER ADMIN (dev-only)
function formatAuditMessage(entry) {
  const action = entry.action || '';
  let details = entry.details || {};
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch (e) { details = {}; }
  }
  const code = details.code || details.itemCode || '';
  const qty = details.qty || details.quantity || '';
  const jobId = details.jobId || details.jobid || '';
  const actionMap = {
    'auth.login': 'User login',
    'auth.register': 'User registered',
    'inventory.in': 'Checked in',
    'inventory.out': 'Checked out',
    'inventory.reserve': 'Reserved',
    'inventory.return': 'Returned',
    'inventory.order': 'Ordered',
    'inventory.count': 'Cycle count',
    'items.create': 'Item created',
    'items.update': 'Item updated',
    'items.delete': 'Item deleted',
    'ops.pick.start': 'Pick started',
    'ops.pick.finish': 'Pick completed',
    'ops.checkin.start': 'Check-in started',
    'ops.checkin.finish': 'Check-in completed'
  };
  const label = actionMap[action] || action.replace('.', ' ');
  const parts = [label];
  if (code) parts.push(code);
  if (qty) parts.push(`x${qty}`);
  if (jobId) parts.push(`job ${jobId}`);
  const who = entry.useremail || entry.userEmail;
  if (who) parts.push(`by ${who}`);
  const tenantCode = entry.tenantcode || entry.tenantCode || 'default';
  return `${tenantCode}: ${parts.join(' ')}`;
}

app.get('/api/seller/data', requireDev, async (req, res) => {
  try {
    const tenants = await allAsync(
      'SELECT id, code, name, plan, status, contactEmail, notes, seatLimit, updatedAt, createdAt FROM tenants ORDER BY code ASC'
    );
    const userCounts = await allAsync('SELECT tenantId, COUNT(*)::int as count FROM users GROUP BY tenantId', []);
    const countMap = new Map(userCounts.map(r => [(r.tenantid || r.tenantId), Number(r.count || 0)]));
    const clients = tenants.map(t => {
      const tenantId = t.id;
      return {
        id: tenantId,
        code: t.code,
        name: t.name,
        email: t.contactemail || t.contactEmail || '',
        plan: t.plan || 'starter',
        status: t.status || 'active',
        notes: t.notes || '',
        seatLimit: t.seatlimit ?? t.seatLimit ?? null,
        activeUsers: countMap.get(tenantId) || 0,
        updatedAt: t.updatedat || t.updatedAt || t.createdat || t.createdAt || Date.now()
      };
    });
    const ticketRows = await allAsync(
      'SELECT id, tenantId, subject, priority, status, updatedAt, createdAt FROM support_tickets ORDER BY updatedAt DESC NULLS LAST, createdAt DESC NULLS LAST'
    );
    const tickets = ticketRows.map(t => ({
      id: t.id,
      tenantId: t.tenantid || t.tenantId,
      subject: t.subject,
      priority: t.priority,
      status: t.status,
      updatedAt: t.updatedat || t.updatedAt || t.createdat || t.createdAt
    }));
    const activityRows = await allAsync(`
      SELECT a.id, a.action, a.details, a.ts, t.code as tenantCode, u.email as userEmail
      FROM audit_events a
      LEFT JOIN tenants t ON t.id = a.tenantId
      LEFT JOIN users u ON u.id = a.userId
      ORDER BY a.ts DESC
      LIMIT 30
    `);
    const activities = activityRows.map(row => ({
      id: row.id,
      message: formatAuditMessage(row),
      ts: row.ts
    }));
    res.json({ clients, tickets, activities });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/seller/clients', requireDev, async (req, res) => {
  try {
    const { name, email, plan, status, activeUsers, notes, code, adminPassword, adminName } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });
    const tCode = normalizeTenantCode(code || name);
    if (!tCode) return res.status(400).json({ error: 'tenant code required' });
    const existing = await getAsync('SELECT id FROM tenants WHERE code=$1', [tCode]);
    if (existing) return res.status(400).json({ error: 'tenant code already exists' });
    const adminEmail = normalizeEmail(email);
    if (!adminEmail) return res.status(400).json({ error: 'valid email required' });
    const existingUser = await getAsync('SELECT 1 FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1', [adminEmail]);
    if (existingUser) return res.status(400).json({ error: 'email already exists' });
    const now = Date.now();
    const tenantId = newId();
    const planVal = plan || 'starter';
    const statusVal = status || 'active';
    const seatLimit = Number.isFinite(Number(activeUsers)) ? Number(activeUsers) : null;
    const password = (adminPassword || '').trim() || 'ChangeMe123!';
    const { salt, hash } = await hashPassword(password);
  await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO tenants(id,code,name,createdAt,plan,status,contactEmail,notes,seatLimit,updatedAt)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tenantId, tCode, name, now, planVal, statusVal, adminEmail, notes || '', seatLimit, now]
      );
      await client.query(
        'INSERT INTO users(id,email,name,role,salt,hash,createdAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [newId(), adminEmail, adminName || name || 'Admin', 'admin', salt, hash, now, tenantId]
      );
    });
    await ensureDefaultCategory(tenantId);
    res.status(201).json({
      id: tenantId,
      code: tCode,
      name,
      email: adminEmail,
      plan: planVal,
      status: statusVal,
      notes: notes || '',
      seatLimit,
      activeUsers: 1,
      updatedAt: now,
      tempPassword: adminPassword ? null : password
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.put('/api/seller/clients/:id', requireDev, async (req, res) => {
  try {
    const { name, email, plan, status, activeUsers, notes } = req.body || {};
    const tenant = await getAsync('SELECT * FROM tenants WHERE id=$1', [req.params.id]);
    if (!tenant) return res.status(404).json({ error: 'client not found' });
    const now = Date.now();
    const planVal = plan || tenant.plan || 'starter';
    const statusVal = status || tenant.status || 'active';
    const seatLimit = Number.isFinite(Number(activeUsers)) ? Number(activeUsers) : null;
    const contactEmail = normalizeEmail(email || tenant.contactemail || tenant.contactEmail || '');
    if (!contactEmail) return res.status(400).json({ error: 'valid email required' });
    await runAsync(
      `UPDATE tenants
       SET name=$1, plan=$2, status=$3, contactEmail=$4, notes=$5, seatLimit=$6, updatedAt=$7
       WHERE id=$8`,
      [
        name || tenant.name,
        planVal,
        statusVal,
        contactEmail,
        notes || '',
        seatLimit,
        now,
        req.params.id
      ]
    );
    res.json({
      id: req.params.id,
      code: tenant.code,
      name: name || tenant.name,
      email: contactEmail,
      plan: planVal,
      status: statusVal,
      notes: notes || '',
      seatLimit,
      updatedAt: now
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/seller/clients/:id', requireDev, async (req, res) => {
  try {
    const tenant = await getAsync('SELECT * FROM tenants WHERE id=$1', [req.params.id]);
    if (!tenant) return res.status(404).json({ error: 'client not found' });
    const protectedTenants = new Set(['default', normalizeTenantCode(DEV_TENANT_CODE)]);
    if (protectedTenants.has(normalizeTenantCode(tenant.code))) {
      return res.status(400).json({ error: 'cannot delete protected tenant' });
    }
    await withTransaction(async (client) => {
      await client.query('DELETE FROM inventory WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM audit_events WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM inventory_counts WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM support_tickets WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM items WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM jobs WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM users WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM inventory_counts WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM support_tickets WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM tenants WHERE id=$1', [tenant.id]);
    });
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/seller/tickets', requireDev, async (req, res) => {
  try {
    const { clientId, subject, priority, status } = req.body || {};
    if (!clientId || !subject) return res.status(400).json({ error: 'clientId and subject required' });
    const tenant = await getAsync('SELECT id FROM tenants WHERE id=$1', [clientId]);
    if (!tenant) return res.status(400).json({ error: 'invalid clientId' });
    const now = Date.now();
    const ticket = {
      id: newId(),
      tenantId: clientId,
      subject,
      priority: priority || 'medium',
      status: status || 'open',
      createdAt: now,
      updatedAt: now
    };
    await runAsync(
      `INSERT INTO support_tickets(id,tenantId,subject,priority,status,createdAt,updatedAt)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [ticket.id, ticket.tenantId, ticket.subject, ticket.priority, ticket.status, ticket.createdAt, ticket.updatedAt]
    );
    res.status(201).json(ticket);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.put('/api/seller/tickets/:id', requireDev, async (req, res) => {
  try {
    const { clientId, subject, priority, status } = req.body || {};
    const ticket = await getAsync('SELECT * FROM support_tickets WHERE id=$1', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'ticket not found' });
    if (clientId) {
      const tenant = await getAsync('SELECT id FROM tenants WHERE id=$1', [clientId]);
      if (!tenant) return res.status(400).json({ error: 'invalid clientId' });
    }
    const now = Date.now();
    await runAsync(
      `UPDATE support_tickets
       SET tenantId=$1, subject=$2, priority=$3, status=$4, updatedAt=$5
       WHERE id=$6`,
      [
        clientId || ticket.tenantid || ticket.tenantId,
        subject || ticket.subject,
        priority || ticket.priority,
        status || ticket.status,
        now,
        req.params.id
      ]
    );
    res.json({
      id: req.params.id,
      tenantId: clientId || ticket.tenantid || ticket.tenantId,
      subject: subject || ticket.subject,
      priority: priority || ticket.priority,
      status: status || ticket.status,
      updatedAt: now
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/seller/tickets/:id/close', requireDev, async (req, res) => {
  try {
    const ticket = await getAsync('SELECT * FROM support_tickets WHERE id=$1', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'ticket not found' });
    const now = Date.now();
    await runAsync('UPDATE support_tickets SET status=$1, updatedAt=$2 WHERE id=$3', ['closed', now, req.params.id]);
    res.json({ id: req.params.id, status: 'closed', updatedAt: now });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get(['/app', '/app/'], (req, res) => {
  res.redirect(302, '/app/login.html');
});

app.listen(PORT, () => console.log(`Server listening on ${PUBLIC_BASE_URL}`));

// Helpers to read common lists
async function readItems(tenantIdVal) {
  return allAsync('SELECT * FROM items WHERE tenantId=$1 ORDER BY name ASC', [tenantIdVal]);
}
async function readJobs(tenantIdVal) {
  return allAsync('SELECT * FROM jobs WHERE tenantId=$1 ORDER BY code ASC', [tenantIdVal]);
}
function setSessionCookie(res, token, maxAgeMs = SESSION_TTL_MS) {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: maxAgeMs,
  };
  if (COOKIE_DOMAIN) options.domain = COOKIE_DOMAIN;
  res.cookie(SESSION_COOKIE, token, options);
}

function clearSessionCookie(res) {
  const options = { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE };
  if (COOKIE_DOMAIN) options.domain = COOKIE_DOMAIN;
  res.clearCookie(SESSION_COOKIE, options);
}



