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
const nodemailer = require('nodemailer');

function loadOptionalEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex <= 0) return;
      const key = trimmed.slice(0, eqIndex).trim();
      if (!key || process.env[key] !== undefined) return;
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value.replace(/\\n/g, '\n');
    });
  } catch (e) {
    console.warn('Could not load optional env file', filePath, e.message);
  }
}

loadOptionalEnvFile(path.join(__dirname, '.env.local'));

const PORT = process.env.PORT || 8000;
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'modulr.pro';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (IS_PROD ? `https://${BASE_DOMAIN}` : `http://localhost:${PORT}`);
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : IS_PROD;
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || (IS_PROD ? BASE_DOMAIN : undefined);
const SESSION_STORE = process.env.SESSION_STORE || (IS_PROD ? 'db' : 'memory');
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_FROM || 'support@modulr.pro';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || EMAIL_FROM;
const SUPPORT_INBOX = process.env.SUPPORT_INBOX || 'support@modulr.pro';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_SECURE = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : SMTP_PORT === 465;
const REQUIRE_EMAIL_VERIFICATION = process.env.EMAIL_VERIFICATION_REQUIRED ? process.env.EMAIL_VERIFICATION_REQUIRED === 'true' : IS_PROD;
const VERYFI_API_URL = process.env.VERYFI_API_URL || 'https://api.veryfi.com/api/v8/partner/documents';
const VERYFI_CLIENT_ID = process.env.VERYFI_CLIENT_ID || '';
const VERYFI_AUTHORIZATION = process.env.VERYFI_AUTHORIZATION
  || (
    process.env.VERYFI_USERNAME && process.env.VERYFI_API_KEY
      ? `apikey ${process.env.VERYFI_USERNAME}:${process.env.VERYFI_API_KEY}`
      : ''
  );
const VERYFI_TIMEOUT_MS = process.env.VERYFI_TIMEOUT_MS ? Math.max(1000, Number(process.env.VERYFI_TIMEOUT_MS) || 30000) : 30000;
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
const VERIFY_TOKEN_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
const RESET_TOKEN_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours
const INVITE_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const DEFAULT_TENANT_CAPS = {
  ims_enabled: true,
  oms_enabled: false,
  bms_enabled: false,
  fms_enabled: false,
  automation_enabled: false,
  insights_enabled: false,
  audit_enabled: false,
  integration_enabled: false,
  end_to_end_ops: false,
  financial_accuracy: false,
  enterprise_governance: false
};
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
  'inventory.order.cancel',
  'inventory.adjust',
  'inventory.transfer',
  'inventory.count',
  'items.create',
  'items.update',
  'items.delete',
  'procurement.vendor_open',
  'suppliers.update',
  'projects.materials.update',
  'fleet.equipment.create',
  'fleet.equipment.update',
  'fleet.equipment.delete',
  'fleet.vehicle.create',
  'fleet.vehicle.update',
  'fleet.vehicle.delete',
  'webhooks.inbound.received',
  'ops.pick.start',
  'ops.pick.finish',
  'ops.checkin.start',
  'ops.checkin.finish'
];
const CHECKOUT_RETURN_WINDOW_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const DEV_EMAIL = normalizeEmail(process.env.DEV_DEFAULT_EMAIL || 'support@modulr.pro');
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
  lowStockEnabled: false
};
const INBOUND_WEBHOOK_SIGNATURE_TTL_MS = 5 * 60 * 1000;
const INVENTORY_LOCATION_TYPE_LABELS = {
  warehouse: 'Warehouse',
  bin: 'Bin / Shelf / Zone',
  staging: 'Staging Area',
  vehicle: 'Vehicle',
  field: 'Field',
  writeoff: 'Lost / Write-off'
};
const SYSTEM_INVENTORY_LOCATIONS = [
  { id: 'loc:warehouse:main', ref: 'main', name: 'Main Warehouse', type: 'warehouse', system: true, sortOrder: 10 },
  { id: 'loc:bin:primary', ref: 'primary', name: 'Primary Bin', type: 'bin', parentRef: 'main', system: true, sortOrder: 20 },
  { id: 'loc:staging:default', ref: 'staging', name: 'Staging Area', type: 'staging', parentRef: 'main', system: true, sortOrder: 30 },
  { id: 'loc:vehicle:fleet', ref: 'fleet', name: 'Vehicle Fleet', type: 'vehicle', system: true, sortOrder: 40 },
  { id: 'loc:field:default', ref: 'field', name: 'Field Stock', type: 'field', system: true, sortOrder: 50 },
  { id: 'loc:writeoff:default', ref: 'writeoff', name: 'Lost / Write-off', type: 'writeoff', system: true, sortOrder: 90 }
];
const CLOSED_PROJECT_STATUSES = new Set(['complete', 'completed', 'closed', 'archived', 'cancelled', 'canceled']);
const JOB_MANUAL_STATUS_OVERRIDES = new Set(['on-hold', 'cancelled', 'canceled', 'archived']);
const JOB_AUTO_COMPLETE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
let sellerStore = { clients: [], tickets: [], activities: [] };

const app = express();
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ims';
// Prefer strict SSL in production; allow relaxed mode for local/dev if explicitly needed.
const databaseSslEnabled =
  process.env.DATABASE_SSL !== undefined
    ? process.env.DATABASE_SSL === 'true'
    : IS_PROD;
const sslCaEnvRaw = process.env.DATABASE_SSL_CA_PEM || process.env.DATABASE_CA_CERT || process.env.CA_CERT || '';
const sslCaBase64 = process.env.DATABASE_SSL_CA_B64 || process.env.DATABASE_SSL_CA_BASE64 || '';
const sslRootCertPath = process.env.DATABASE_SSL_CA || process.env.PGSSLROOTCERT;
let ca;
if (databaseSslEnabled && sslCaBase64) {
  try {
    ca = Buffer.from(sslCaBase64, 'base64').toString('utf8');
  } catch (e) {
    console.warn('Could not decode DATABASE_SSL_CA_B64', e.message);
  }
} else if (databaseSslEnabled && sslCaEnvRaw) {
  let normalized = sslCaEnvRaw.trim();
  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }
  ca = normalized.replace(/\\n/g, '\n');
} else if (databaseSslEnabled && sslRootCertPath) {
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
const sslConfig = databaseSslEnabled ? { rejectUnauthorized, ca } : false;
console.log('DB SSL config', {
  enabled: databaseSslEnabled,
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

app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    req.rawBody = buf?.length ? buf.toString('utf8') : '';
  }
}));
app.use((req, res, next) => {
  if (!/^\/(?:app\/)?operations-system-[^/]+\.html$/i.test(req.path)) return next();
  if (isLocalhostRequest(req)) return next();
  return res.redirect(302, '/inventory-operations.html');
});
// Disable etags and caching for HTML/CSS/JS so UI changes propagate immediately
app.disable('etag');
app.use((req, res, next) => {
  if (/\.html$/i.test(req.path)) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  } else if (/\.(css|js)$/i.test(req.path)) {
    res.set('Cache-Control', 'public, max-age=300, must-revalidate');
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
  if (req.path.startsWith('/api/webhooks/inbound')) return next();
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
function newInboundWebhookSecret() {
  return crypto.randomBytes(24).toString('hex');
}
function normalizeInboundWebhookName(value) {
  return String(value || '').trim();
}
function normalizeInboundWebhookSource(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'generic';
  return raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'generic';
}
function maskSecret(secret) {
  const value = String(secret || '').trim();
  if (!value) return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}
function buildInboundWebhookReceiveUrl(id) {
  return `${PUBLIC_BASE_URL}/api/webhooks/inbound/${encodeURIComponent(id)}`;
}
function formatInboundWebhookRow(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const activeValue = Object.prototype.hasOwnProperty.call(row, 'isactive') ? row.isactive : row.isActive;
  const formatted = {
    id: row.id,
    tenantId: row.tenantid || row.tenantId || '',
    name: row.name || 'Inbound Webhook',
    source: row.source || 'generic',
    notes: row.notes || '',
    isActive: activeValue !== false,
    createdAt: Number(row.createdat || row.createdAt || 0) || 0,
    updatedAt: Number(row.updatedat || row.updatedAt || 0) || 0,
    lastReceivedAt: Number(row.lastreceivedat || row.lastReceivedAt || 0) || 0,
    eventCount: Number(row.eventcount || row.eventCount || 0) || 0,
    receiveUrl: buildInboundWebhookReceiveUrl(row.id),
    maskedSecret: maskSecret(row.secret)
  };
  if (includeSecret) formatted.secret = row.secret || '';
  return formatted;
}
function createInboundWebhookSignature(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', String(secret || ''))
    .update(`${String(timestamp || '')}.${String(rawBody || '')}`)
    .digest('hex');
}
function signaturesMatch(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function verifyInboundWebhookSignature(secret, timestamp, rawBody, signatureHeader) {
  const provided = String(signatureHeader || '').trim().replace(/^sha256=/i, '');
  const expected = createInboundWebhookSignature(secret, timestamp, rawBody);
  return signaturesMatch(provided, expected);
}
function pickInboundWebhookHeaders(req) {
  return {
    contentType: req.get('content-type') || '',
    userAgent: req.get('user-agent') || '',
    signature: req.get('x-modulr-signature') || '',
    timestamp: req.get('x-modulr-timestamp') || '',
    event: req.get('x-modulr-event') || '',
    deliveryId: req.get('x-modulr-delivery-id') || ''
  };
}
async function getInboundWebhookEndpoint(id, tenantIdVal) {
  const params = [id];
  let sql = 'SELECT * FROM inbound_webhook_endpoints WHERE id=$1';
  if (tenantIdVal) {
    params.push(tenantIdVal);
    sql += ` AND tenantId=$${params.length}`;
  }
  return getAsync(sql, params);
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

function isEmailConfigured() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_FROM);
}

let mailTransport = null;
function getMailTransport() {
  if (mailTransport) return mailTransport;
  if (!isEmailConfigured()) return null;
  mailTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  return mailTransport;
}

async function sendEmail({ to, subject, text, html }) {
  const transport = getMailTransport();
  if (!transport) {
    console.warn('Email not configured; skipping send to', to);
    return { ok: false, skipped: true };
  }
  try {
    await transport.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      text,
      html,
      replyTo: EMAIL_REPLY_TO || undefined
    });
    return { ok: true };
  } catch (e) {
    console.warn('Email send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function buildAppLink(pathname, params) {
  const base = (PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const cleanPath = pathname.replace(/^\//, '');
  const url = new URL(`${base}/app/${cleanPath}`);
  if (params && typeof params === 'object') {
    Object.entries(params).forEach(([key, val]) => {
      if (val !== undefined && val !== null && val !== '') url.searchParams.set(key, String(val));
    });
  }
  return url.toString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRoleLabel(role) {
  const normalized = normalizeUserRole(role);
  if (normalized === 'dev') return 'Developer';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatDurationLabel(ms) {
  const dayMs = 1000 * 60 * 60 * 24;
  const hourMs = 1000 * 60 * 60;
  if (ms >= dayMs) {
    const days = Math.round(ms / dayMs);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  const hours = Math.max(1, Math.round(ms / hourMs));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createAuthToken({ type, userId, tenantId, email, meta, ttlMs }) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  await runAsync(
    'INSERT INTO auth_tokens(id,type,tokenHash,userId,tenantId,email,createdAt,expiresAt,meta) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [newId(), type, tokenHash, userId || null, tenantId || null, email || null, now, expiresAt, meta ? JSON.stringify(meta) : null]
  );
  return token;
}

async function consumeAuthToken(rawToken, type) {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const row = await getAsync('SELECT * FROM auth_tokens WHERE tokenHash=$1 AND type=$2', [tokenHash, type]);
  if (!row) return null;
  const consumedAt = row.consumedat || row.consumedAt;
  const expiresAt = row.expiresat || row.expiresAt;
  if (consumedAt) return null;
  if (expiresAt && expiresAt < Date.now()) return null;
  await runAsync('UPDATE auth_tokens SET consumedAt=$1 WHERE id=$2', [Date.now(), row.id]);
  return row;
}

async function sendVerificationEmail(user) {
  const token = await createAuthToken({
    type: 'verify',
    userId: user.id,
    tenantId: user.tenantid || user.tenantId,
    email: user.email,
    ttlMs: VERIFY_TOKEN_TTL_MS
  });
  const link = buildAppLink('verify.html', { token });
  const subject = 'Verify your Modulr account';
  const text = `Verify your email to finish setup: ${link}`;
  const html = `<p>Verify your email to finish setup:</p><p><a href="${link}">Verify email</a></p><p>If the button doesn't work, copy this link: ${link}</p>`;
  const result = await sendEmail({ to: user.email, subject, text, html });
  if (!result.ok && result.skipped && !IS_PROD) {
    console.log('Verify link:', link);
  }
  return { ...result, token };
}

async function sendResetEmail(user) {
  const token = await createAuthToken({
    type: 'reset',
    userId: user.id,
    tenantId: user.tenantid || user.tenantId,
    email: user.email,
    ttlMs: RESET_TOKEN_TTL_MS
  });
  const link = buildAppLink('reset.html', { token });
  const recipientName = (user.name || '').trim();
  const expiresIn = formatDurationLabel(RESET_TOKEN_TTL_MS);
  const subject = 'Reset your Modulr password';
  const text = [
    recipientName ? `Hi ${recipientName},` : 'Hello,',
    '',
    'We received a request to reset your Modulr password.',
    'Use the link below to choose a new password and regain access to your account.',
    '',
    link,
    '',
    `This reset link expires in ${expiresIn}.`,
    'If you did not request a password reset, you can ignore this email.'
  ].join('\n');
  const html = `
    <div style="margin:0;padding:24px;background:#f4f7f6;font-family:Arial,sans-serif;color:#173229;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d7e4de;border-radius:18px;overflow:hidden;">
        <div style="padding:28px 32px 22px;background:linear-gradient(135deg,#10372d 0%,#1d5a48 100%);color:#ffffff;">
          <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.78;">Modulr</div>
          <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;font-weight:700;">Reset your password</h1>
        </div>
        <div style="padding:28px 32px 32px;">
          <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">${recipientName ? `Hi ${escapeHtml(recipientName)},` : 'Hello,'}</p>
          <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">We received a request to reset your Modulr password.</p>
          <p style="margin:0 0 20px;font-size:16px;line-height:1.6;">Use the button below to choose a new password and sign back in.</p>
          <div style="margin:0 0 22px;padding:18px 20px;background:#f7fbf9;border:1px solid #d7e4de;border-radius:14px;">
            <div style="display:flex;gap:12px;justify-content:space-between;align-items:flex-start;">
              <span style="font-size:13px;line-height:1.4;color:#5b746a;">Reset link expires</span>
              <span style="font-size:14px;line-height:1.4;color:#173229;font-weight:600;text-align:right;">${escapeHtml(expiresIn)}</span>
            </div>
          </div>
          <div style="margin:0 0 18px;">
            <a href="${link}" style="display:inline-block;padding:14px 22px;background:#173f33;border-radius:12px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;">Set new password</a>
          </div>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#5b746a;">If the button does not open, use this link:</p>
          <p style="margin:0 0 20px;font-size:13px;line-height:1.7;word-break:break-all;"><a href="${link}" style="color:#1d5a48;text-decoration:underline;">${link}</a></p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#5b746a;">If you did not request a password reset, you can ignore this email.</p>
        </div>
      </div>
    </div>
  `;
  const result = await sendEmail({ to: user.email, subject, text, html });
  if (!result.ok && result.skipped && !IS_PROD) {
    console.log('Reset link:', link);
  }
  return { ...result, token };
}

async function sendInviteEmail(user, inviter) {
  const token = await createAuthToken({
    type: 'invite',
    userId: user.id,
    tenantId: user.tenantid || user.tenantId,
    email: user.email,
    ttlMs: INVITE_TOKEN_TTL_MS,
    meta: { inviter: inviter || '' }
  });
  const link = buildAppLink('invite.html', { token });
  const tenant = user.tenantid || user.tenantId
    ? await getAsync('SELECT name FROM tenants WHERE id=$1', [user.tenantid || user.tenantId])
    : null;
  const tenantName = (tenant?.name || '').trim();
  const recipientName = (user.name || '').trim();
  const inviterName = (inviter || '').trim();
  const roleLabel = formatRoleLabel(user.role);
  const expiresIn = formatDurationLabel(INVITE_TOKEN_TTL_MS);
  const subject = tenantName
    ? `You're invited to ${tenantName} on Modulr`
    : "You're invited to Modulr";
  const introLine = tenantName
    ? `${inviterName ? `${inviterName} invited you to join ${tenantName}` : `You've been invited to join ${tenantName}`} in Modulr.`
    : `${inviterName ? `${inviterName} invited you to join Modulr.` : `You've been invited to join Modulr.`}`;
  const detailRows = [
    tenantName ? ['Workspace', tenantName] : null,
    ['Access', roleLabel],
    inviterName ? ['Invited by', inviterName] : null,
    ['Invite expires', expiresIn]
  ].filter(Boolean);
  const text = [
    recipientName ? `Hi ${recipientName},` : 'Hello,',
    '',
    introLine,
    `Your access is set up as ${roleLabel}.`,
    'Create your password to finish setup and sign in.',
    '',
    link,
    '',
    `This invite expires in ${expiresIn}.`,
    'If you were not expecting this email, you can ignore it.'
  ].join('\n');
  const html = `
    <div style="margin:0;padding:24px;background:#f4f7f6;font-family:Arial,sans-serif;color:#173229;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d7e4de;border-radius:18px;overflow:hidden;">
        <div style="padding:28px 32px 22px;background:linear-gradient(135deg,#10372d 0%,#1d5a48 100%);color:#ffffff;">
          <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.78;">Modulr</div>
          <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;font-weight:700;">Your account invitation</h1>
        </div>
        <div style="padding:28px 32px 32px;">
          <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">${recipientName ? `Hi ${escapeHtml(recipientName)},` : 'Hello,'}</p>
          <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">${escapeHtml(introLine)}</p>
          <p style="margin:0 0 20px;font-size:16px;line-height:1.6;">Create your password to finish setup and access the live Inventory Management System.</p>
          <div style="margin:0 0 22px;padding:18px 20px;background:#f7fbf9;border:1px solid #d7e4de;border-radius:14px;">
            ${detailRows.map(([label, value]) => `
              <div style="display:flex;gap:12px;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:${label === 'Invite expires' ? '0' : '1px solid #e3ece8'};">
                <span style="font-size:13px;line-height:1.4;color:#5b746a;">${escapeHtml(label)}</span>
                <span style="font-size:14px;line-height:1.4;color:#173229;font-weight:600;text-align:right;">${escapeHtml(value)}</span>
              </div>
            `).join('')}
          </div>
          <div style="margin:0 0 18px;">
            <a href="${link}" style="display:inline-block;padding:14px 22px;background:#173f33;border-radius:12px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;">Create password</a>
          </div>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#5b746a;">If the button does not open, use this link:</p>
          <p style="margin:0 0 20px;font-size:13px;line-height:1.7;word-break:break-all;"><a href="${link}" style="color:#1d5a48;text-decoration:underline;">${link}</a></p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#5b746a;">If you were not expecting this email, you can ignore it.</p>
        </div>
      </div>
    </div>
  `;
  const result = await sendEmail({ to: user.email, subject, text, html });
  if (!result.ok && result.skipped && !IS_PROD) {
    console.log('Invite link:', link);
  }
  return { ...result, token };
}

function formatProjectDateLabel(startDate, endDate) {
  const start = String(startDate || '').trim();
  const end = String(endDate || '').trim();
  if (start && end) return `${start} to ${end}`;
  return start || end || 'Not scheduled';
}

function jobMaterialsAllReceived(materials) {
  const rows = Array.isArray(materials) ? materials : [];
  if (!rows.length) return false;
  return rows.every((row) => {
    const required = roundQty(row?.qtyrequired ?? row?.qtyRequired);
    const received = roundQty(row?.qtyreceived ?? row?.qtyReceived);
    return required > 0 && received >= required;
  });
}

async function markJobMaterialsReadyTransitionTx(client, tenantIdVal, jobId) {
  const jobCode = String(jobId || '').trim();
  if (!jobCode) return null;
  const jobResult = await client.query(
    'SELECT code,name,startDate,endDate,status,location,notes,materialsReadyNotifiedAt FROM jobs WHERE code=$1 AND tenantId=$2 FOR UPDATE',
    [jobCode, tenantIdVal]
  );
  const job = jobResult.rows?.[0];
  if (!job) return null;
  const materialRows = await client.query(
    'SELECT * FROM job_materials WHERE tenantId=$1 AND jobId=$2 ORDER BY sortOrder ASC, createdAt ASC, code ASC',
    [tenantIdVal, jobCode]
  );
  const materials = (materialRows.rows || []).map(normalizeJobMaterialRow);
  if (!jobMaterialsAllReceived(materials)) return null;
  const notifiedAt = job.materialsreadynotifiedat ?? job.materialsReadyNotifiedAt;
  if (notifiedAt) return null;
  const nextTs = Date.now();
  await client.query(
    'UPDATE jobs SET materialsReadyNotifiedAt=$1 WHERE code=$2 AND tenantId=$3',
    [nextTs, jobCode, tenantIdVal]
  );
  return {
    tenantId: tenantIdVal,
    jobCode,
    jobName: job.name || '',
    startDate: job.startdate || job.startDate || '',
    endDate: job.enddate || job.endDate || '',
    location: job.location || '',
    status: job.status || '',
    notes: job.notes || '',
    materials,
    notifiedAt: nextTs
  };
}

async function sendProjectMaterialsReadyEmails(notification) {
  if (!notification?.tenantId || !notification?.jobCode) return { ok: false, skipped: true };
  const admins = await allAsync(
    `SELECT email,name,notificationPrefs,role FROM users
     WHERE tenantId=$1 AND LOWER(role) IN ('admin','dev') AND email IS NOT NULL AND email <> ''
     ORDER BY email ASC`,
    [notification.tenantId]
  );
  const recipients = admins.filter((user) => normalizeNotificationPrefs(user.notificationprefs ?? user.notificationPrefs).projectMaterialsReadyEmail !== false);
  if (!recipients.length) return { ok: false, skipped: true };
  const tenant = await getAsync('SELECT name FROM tenants WHERE id=$1', [notification.tenantId]);
  const tenantName = (tenant?.name || '').trim();
  const projectLabel = notification.jobName
    ? `${notification.jobCode} · ${notification.jobName}`
    : notification.jobCode;
  const totalLines = notification.materials.length;
  const totalRequired = roundQty(notification.materials.reduce((sum, row) => sum + roundQty(row.qtyRequired), 0));
  const totalReceived = roundQty(notification.materials.reduce((sum, row) => sum + roundQty(row.qtyReceived), 0));
  const scheduleLabel = formatProjectDateLabel(notification.startDate, notification.endDate);
  const detailRows = [
    ['Project', projectLabel],
    tenantName ? ['Workspace', tenantName] : null,
    ['Material lines', String(totalLines)],
    ['Received', `${totalReceived} / ${totalRequired}`],
    ['Schedule', scheduleLabel],
    notification.location ? ['Location', notification.location] : null
  ].filter(Boolean);
  const projectLink = `${buildAppLink('job-creator.html', { search: notification.jobCode })}#report`;
  const subject = `All materials received for project ${notification.jobCode}`;
  let sent = 0;
  for (const admin of recipients) {
    const recipientName = (admin?.name || '').trim();
    const introLine = tenantName
      ? `All materials for project ${projectLabel} in ${tenantName} have now been received.`
      : `All materials for project ${projectLabel} have now been received.`;
    const text = [
      recipientName ? `Hi ${recipientName},` : 'Hello,',
      '',
      introLine,
      `Material lines: ${totalLines}`,
      `Received: ${totalReceived} / ${totalRequired}`,
      `Schedule: ${scheduleLabel}`,
      notification.location ? `Location: ${notification.location}` : null,
      '',
      `Open project manager: ${projectLink}`
    ].filter(Boolean).join('\n');
    const html = `
      <div style="margin:0;padding:24px;background:#f4f7f6;font-family:Arial,sans-serif;color:#173229;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d7e4de;border-radius:18px;overflow:hidden;">
          <div style="padding:28px 32px 22px;background:linear-gradient(135deg,#10372d 0%,#1d5a48 100%);color:#ffffff;">
            <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.78;">Modulr</div>
            <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;font-weight:700;">Project materials received</h1>
          </div>
          <div style="padding:28px 32px 32px;">
            <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">${recipientName ? `Hi ${escapeHtml(recipientName)},` : 'Hello,'}</p>
            <p style="margin:0 0 20px;font-size:16px;line-height:1.6;">${escapeHtml(introLine)}</p>
            <div style="margin:0 0 22px;padding:18px 20px;background:#f7fbf9;border:1px solid #d7e4de;border-radius:14px;">
              ${detailRows.map(([label, value]) => `
                <div style="display:flex;gap:12px;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:${label === 'Location' || (!notification.location && label === 'Schedule') ? '0' : '1px solid #e3ece8'};">
                  <span style="font-size:13px;line-height:1.4;color:#5b746a;">${escapeHtml(label)}</span>
                  <span style="font-size:14px;line-height:1.4;color:#173229;font-weight:600;text-align:right;">${escapeHtml(value)}</span>
                </div>
              `).join('')}
            </div>
            <div style="margin:0 0 18px;">
              <a href="${projectLink}" style="display:inline-block;padding:14px 22px;background:#173f33;border-radius:12px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;">Open project manager</a>
            </div>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#5b746a;">This notification was sent because every required material line for this project is now fully received.</p>
          </div>
        </div>
      </div>
    `;
    const result = await sendEmail({ to: admin.email, subject, text, html });
    if (result.ok) sent += 1;
    if (!result.ok && result.skipped && !IS_PROD) {
      console.log('Project ready link:', projectLink);
    }
  }
  return { ok: sent > 0, sent };
}

async function collectLowStockTransitionsTx(client, tenantIdVal, codes) {
  const uniqueCodes = Array.from(new Set((codes || []).map((code) => String(code || '').trim()).filter(Boolean)));
  if (!uniqueCodes.length) return [];
  const notifications = [];
  for (const code of uniqueCodes) {
    const itemResult = await client.query(
      `SELECT i.code,i.name,i.category,i.reorderPoint,i.lowStockEnabled,i.lowStockNotifiedAt,c.rules AS categoryRules
       FROM items i
       LEFT JOIN categories c ON c.tenantId = i.tenantId AND LOWER(c.name)=LOWER(COALESCE(NULLIF(i.category,''), $3))
       WHERE i.code=$1 AND i.tenantId=$2
       LIMIT 1
       FOR UPDATE OF i`,
      [code, tenantIdVal, DEFAULT_CATEGORY_NAME]
    );
    const item = itemResult.rows?.[0];
    if (!item) continue;
    const rulesMap = new Map([
      [String(item.category || DEFAULT_CATEGORY_NAME).trim().toLowerCase(), normalizeCategoryRules(item.categoryrules || item.categoryRules)]
    ]);
    const lowStockEnabled = resolveLowStockEnabled(item, rulesMap);
    const threshold = resolveLowStockThreshold(item, rulesMap);
    const available = roundQty(await calcAvailabilityTx(client, code, tenantIdVal));
    const notifiedAt = item.lowstocknotifiedat ?? item.lowStockNotifiedAt;
    if (!lowStockEnabled) {
      if (notifiedAt) {
        await client.query('UPDATE items SET lowStockNotifiedAt=NULL WHERE code=$1 AND tenantId=$2', [code, tenantIdVal]);
      }
      continue;
    }
    if (available <= threshold) {
      if (!notifiedAt) {
        const nextTs = Date.now();
        await client.query('UPDATE items SET lowStockNotifiedAt=$1 WHERE code=$2 AND tenantId=$3', [nextTs, code, tenantIdVal]);
        notifications.push({
          code,
          name: item.name || code,
          available,
          threshold
        });
      }
    } else if (notifiedAt) {
      await client.query('UPDATE items SET lowStockNotifiedAt=NULL WHERE code=$1 AND tenantId=$2', [code, tenantIdVal]);
    }
  }
  return notifications;
}

async function sendLowStockAlertEmails({ tenantId, items }) {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!tenantId || !rows.length) return { ok: false, skipped: true };
  const admins = await allAsync(
    `SELECT email,name,notificationPrefs,role FROM users
     WHERE tenantId=$1 AND LOWER(role) IN ('admin','dev') AND email IS NOT NULL AND email <> ''
     ORDER BY email ASC`,
    [tenantId]
  );
  const recipients = admins.filter((user) => normalizeNotificationPrefs(user.notificationprefs ?? user.notificationPrefs).lowStockEmail !== false);
  if (!recipients.length) return { ok: false, skipped: true };
  const tenant = await getAsync('SELECT name FROM tenants WHERE id=$1', [tenantId]);
  const tenantName = (tenant?.name || '').trim();
  const inventoryLink = buildAppLink('inventory-list.html');
  const subject = rows.length === 1
    ? `Low stock alert: ${rows[0].code}`
    : `Low stock alert: ${rows.length} items need attention`;
  let sent = 0;
  for (const admin of recipients) {
    const recipientName = (admin?.name || '').trim();
    const introLine = tenantName
      ? `The following low-stock item${rows.length === 1 ? ' is' : 's are'} now below the configured threshold in ${tenantName}.`
      : `The following low-stock item${rows.length === 1 ? ' is' : 's are'} now below the configured threshold.`;
    const text = [
      recipientName ? `Hi ${recipientName},` : 'Hello,',
      '',
      introLine,
      '',
      ...rows.map((item) => `${item.code} - ${item.name}: ${item.available} available (threshold ${item.threshold})`),
      '',
      `Review inventory: ${inventoryLink}`
    ].join('\n');
    const html = `
      <div style="margin:0;padding:24px;background:#f4f7f6;font-family:Arial,sans-serif;color:#173229;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d7e4de;border-radius:18px;overflow:hidden;">
          <div style="padding:28px 32px 22px;background:linear-gradient(135deg,#10372d 0%,#1d5a48 100%);color:#ffffff;">
            <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.78;">Modulr</div>
            <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;font-weight:700;">Low stock alert</h1>
          </div>
          <div style="padding:28px 32px 32px;">
            <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">${recipientName ? `Hi ${escapeHtml(recipientName)},` : 'Hello,'}</p>
            <p style="margin:0 0 20px;font-size:16px;line-height:1.6;">${escapeHtml(introLine)}</p>
            <div style="margin:0 0 22px;padding:18px 20px;background:#f7fbf9;border:1px solid #d7e4de;border-radius:14px;">
              ${rows.map((item, index) => `
                <div style="display:flex;gap:12px;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:${index === rows.length - 1 ? '0' : '1px solid #e3ece8'};">
                  <div>
                    <div style="font-size:14px;font-weight:700;color:#173229;">${escapeHtml(item.code)}</div>
                    <div style="font-size:13px;line-height:1.5;color:#5b746a;">${escapeHtml(item.name || item.code)}</div>
                  </div>
                  <div style="text-align:right;">
                    <div style="font-size:14px;font-weight:700;color:#173229;">${escapeHtml(String(item.available))} available</div>
                    <div style="font-size:13px;line-height:1.5;color:#5b746a;">Threshold ${escapeHtml(String(item.threshold))}</div>
                  </div>
                </div>
              `).join('')}
            </div>
            <div style="margin:0 0 18px;">
              <a href="${inventoryLink}" style="display:inline-block;padding:14px 22px;background:#173f33;border-radius:12px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;">Review inventory</a>
            </div>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#5b746a;">This notification was sent because these items crossed into a low-stock state.</p>
          </div>
        </div>
      </div>
    `;
    const result = await sendEmail({ to: admin.email, subject, text, html });
    if (result.ok) sent += 1;
  }
  return { ok: sent > 0, sent };
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
    createdAt: u.createdat || u.createdAt,
    emailVerified: u.emailverified ?? u.emailVerified ?? false,
    notificationPrefs: normalizeNotificationPrefs(u.notificationprefs ?? u.notificationPrefs)
  };
}
function normalizeTenantCode(code) {
  return (code || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'default';
}
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}
async function resolveUserByEmail(emailNorm, tenantCode) {
  const rawTenant = (tenantCode || '').toString().trim();
  if (rawTenant) {
    const tenant = await getAsync('SELECT * FROM tenants WHERE code=$1', [normalizeTenantCode(rawTenant)]);
    if (!tenant) return { error: 'tenant' };
    const user = await getAsync('SELECT * FROM users WHERE LOWER(email)=LOWER($1) AND tenantId=$2', [emailNorm, tenant.id]);
    return { user, tenant };
  }
  const matches = await allAsync(
    'SELECT u.*, t.code AS tenantCode FROM users u JOIN tenants t ON t.id = u.tenantId WHERE LOWER(u.email)=LOWER($1)',
    [emailNorm]
  );
  if (matches.length === 1) {
    const user = matches[0];
    const tenant = { id: user.tenantid || user.tenantId, code: user.tenantcode || user.tenantCode };
    return { user, tenant };
  }
  if (matches.length > 1) return { error: 'multiple' };
  return { user: null };
}
async function emailExistsGlobal(emailNorm, excludeId) {
  if (!emailNorm) return null;
  if (excludeId) {
    return await getAsync(
      'SELECT id, tenantId FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2 LIMIT 1',
      [emailNorm, excludeId]
    );
  }
  return await getAsync(
    'SELECT id, tenantId FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1',
    [emailNorm]
  );
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
function resolveLowStockEnabled(item, categoryRulesMap) {
  const itemEnabled = normalizeItemLowStockEnabled(item?.lowStockEnabled ?? item?.lowstockenabled);
  if (itemEnabled !== null) return itemEnabled;
  const catName = (item?.category || DEFAULT_CATEGORY_NAME || '').toString().trim().toLowerCase();
  const rules = categoryRulesMap.get(catName);
  return rules ? !!rules.lowStockEnabled : false;
}
function parseNotificationPrefs(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  if (typeof raw === 'object') return raw;
  return {};
}
function normalizeNotificationPrefs(raw) {
  const input = parseNotificationPrefs(raw);
  return {
    projectMaterialsReadyEmail: input.projectMaterialsReadyEmail !== false,
    lowStockEmail: input.lowStockEmail !== false
  };
}
function resolveLowStockThreshold(item, categoryRulesMap) {
  const reorderPoint = Number(item?.reorderpoint ?? item?.reorderPoint);
  if (Number.isFinite(reorderPoint) && reorderPoint >= 0) return Math.floor(reorderPoint);
  const catName = (item?.category || DEFAULT_CATEGORY_NAME || '').toString().trim().toLowerCase();
  const rules = categoryRulesMap.get(catName);
  const threshold = Number(rules?.lowStockThreshold);
  return Number.isFinite(threshold) && threshold >= 0
    ? Math.floor(threshold)
    : DEFAULT_CATEGORY_RULES.lowStockThreshold;
}

function dashboardParseTs(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') return val;
  const num = Number(val);
  if (Number.isFinite(num)) return num;
  const ts = Date.parse(val);
  return Number.isNaN(ts) ? null : ts;
}

function dashboardNormalizeJobId(value) {
  const val = (value || '').toString().trim();
  if (!val) return '';
  const lowered = val.toLowerCase();
  if (['general', 'general inventory', 'none', 'unassigned'].includes(lowered)) return '';
  return val;
}

function dashboardBuildOrderBalance(orders, inventory) {
  const map = new Map();
  (orders || []).forEach((order) => {
    const status = String(order.status || '').toLowerCase();
    if (status === 'cancelled' || status === 'canceled') return;
    const sourceId = order.sourceid || order.sourceId || order.id;
    if (!sourceId) return;
    const jobId = dashboardNormalizeJobId(order.jobid || order.jobId || '');
    if (!map.has(sourceId)) {
      map.set(sourceId, {
        sourceId,
        code: order.code,
        jobId,
        name: order.name || '',
        ordered: 0,
        checkedIn: 0,
        eta: order.eta || '',
        lastOrderTs: 0,
      });
    }
    const rec = map.get(sourceId);
    rec.ordered += Number(order.qty || 0);
    rec.lastOrderTs = Math.max(rec.lastOrderTs, dashboardParseTs(order.ts) || 0);
    if (!rec.eta && order.eta) rec.eta = order.eta;
  });
  (inventory || []).filter((entry) => (entry.type || '').toLowerCase() === 'in' && (entry.sourceid || entry.sourceId)).forEach((checkin) => {
    const key = checkin.sourceid || checkin.sourceId;
    if (!map.has(key)) return;
    const rec = map.get(key);
    rec.checkedIn += Number(checkin.qty || 0);
  });
  (inventory || []).filter((entry) => (entry.type || '').toLowerCase() === 'in' && !(entry.sourceid || entry.sourceId)).forEach((checkin) => {
    const code = checkin.code;
    if (!code) return;
    const jobId = dashboardNormalizeJobId(checkin.jobid || checkin.jobId || '');
    let qtyLeft = Number(checkin.qty || 0);
    if (qtyLeft <= 0) return;
    const candidates = Array.from(map.values())
      .filter((rec) => rec.code === code && (rec.jobId || '') === (jobId || ''))
      .sort((a, b) => (a.lastOrderTs || 0) - (b.lastOrderTs || 0));
    candidates.forEach((rec) => {
      if (qtyLeft <= 0) return;
      const openQty = Math.max(0, rec.ordered - rec.checkedIn);
      if (openQty <= 0) return;
      const usedQty = Math.min(openQty, qtyLeft);
      rec.checkedIn += usedQty;
      qtyLeft -= usedQty;
    });
  });
  return map;
}

function dashboardBuildOpenOrders(orders, inventory) {
  const balances = dashboardBuildOrderBalance(orders, inventory);
  const rows = [];
  balances.forEach((rec) => {
    const openQty = Math.max(0, rec.ordered - rec.checkedIn);
    if (openQty <= 0) return;
    rows.push({ ...rec, openQty });
  });
  return rows;
}

function dashboardAggregateStock(entries) {
  const map = new Map();
  (entries || []).forEach((entry) => {
    if (!entry.code) return;
    if (!map.has(entry.code)) {
      map.set(entry.code, { code: entry.code, name: entry.name || '', inQty: 0, outQty: 0, returnQty: 0, reserveQty: 0 });
    }
    const rec = map.get(entry.code);
    if (!rec.name && entry.name) rec.name = entry.name;
    const qty = Number(entry.qty || 0) || 0;
    const type = (entry.type || '').toLowerCase();
    if (type === 'in' || type === 'return') rec.inQty += qty;
    if (type === 'out') rec.outQty += qty;
    if (type === 'return') rec.returnQty += qty;
    if (type === 'reserve') rec.reserveQty += qty;
    if (type === 'reserve_release') rec.reserveQty -= qty;
  });
  const list = [];
  const totals = { available: 0, reserved: 0, checkedOut: 0 };
  map.forEach((rec) => {
    const checkedOut = Math.max(0, rec.outQty - rec.returnQty);
    const available = Math.max(0, rec.inQty - rec.outQty - rec.reserveQty);
    const reserved = Math.max(0, rec.reserveQty);
    const row = { ...rec, checkedOut, available, reserveQty: reserved };
    totals.available += available;
    totals.reserved += reserved;
    totals.checkedOut += checkedOut;
    list.push(row);
  });
  return { list, byCode: new Map(list.map((row) => [row.code, row])), totals };
}

function dashboardBuildOverdueRows(entries) {
  const map = new Map();
  (entries || []).forEach((entry) => {
    const type = (entry.type || '').toLowerCase();
    if (type !== 'out' && type !== 'return') return;
    if (!entry.code) return;
    const jobId = dashboardNormalizeJobId(entry.jobid || entry.jobId || '');
    const key = `${entry.code}|${jobId}`;
    const rec = map.get(key) || { code: entry.code, jobId, out: 0, ret: 0, minDue: null, lastOutTs: 0 };
    const qty = Number(entry.qty || 0) || 0;
    if (type === 'out') {
      rec.out += qty;
      rec.lastOutTs = Math.max(rec.lastOutTs, dashboardParseTs(entry.ts) || 0);
      const due = dashboardParseTs(entry.returnDate || entry.returndate);
      if (due) rec.minDue = rec.minDue ? Math.min(rec.minDue, due) : due;
    } else {
      rec.ret += qty;
    }
    map.set(key, rec);
  });
  const now = Date.now();
  const rows = [];
  map.forEach((rec) => {
    const outstanding = Math.max(0, rec.out - rec.ret);
    if (outstanding <= 0) return;
    if (!rec.minDue || rec.minDue >= now) return;
    const daysLate = Math.floor((now - rec.minDue) / (24 * 60 * 60 * 1000));
    rows.push({ ...rec, outstanding, daysLate });
  });
  return rows;
}

function dashboardBuildTopMovers(entries, itemMap, stockByCode) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const allowedTypes = new Set(['in', 'out', 'return', 'reserve', 'reserve_release', 'purchase', 'consume']);
  const map = new Map();
  (entries || []).forEach((entry) => {
    const ts = dashboardParseTs(entry.ts);
    if (!ts || ts < cutoff) return;
    const type = (entry.type || '').toLowerCase();
    if (!allowedTypes.has(type) || !entry.code) return;
    const qty = Math.abs(Number(entry.qty || 0) || 0);
    if (!qty) return;
    const rec = map.get(entry.code) || { code: entry.code, name: entry.name || '', moves: 0, inUse: 0 };
    rec.moves += qty;
    if (!rec.name && entry.name) rec.name = entry.name;
    map.set(entry.code, rec);
  });
  const rows = Array.from(map.values());
  rows.forEach((row) => {
    const item = itemMap.get(row.code);
    if (item?.name) row.name = item.name;
    row.inUse = stockByCode.get(row.code)?.checkedOut || 0;
  });
  rows.sort((a, b) => b.moves - a.moves);
  return rows.slice(0, 8);
}

function dashboardBuildCountDueRows(items, counts) {
  const countMap = new Map();
  (counts || []).forEach((row) => {
    if (!row?.code) return;
    const ts = dashboardParseTs(row.countedAt || row.countedat || row.ts || row.counted_at);
    const existing = countMap.get(row.code);
    if (existing && existing.ts && ts && existing.ts > ts) return;
    countMap.set(row.code, { ts });
  });
  const cutoffDays = 30;
  const now = Date.now();
  const rows = [];
  (items || []).forEach((item) => {
    if (!item?.code) return;
    const ts = countMap.get(item.code)?.ts || null;
    const daysSince = ts ? Math.floor((now - ts) / (24 * 60 * 60 * 1000)) : null;
    if (!ts || daysSince > cutoffDays) {
      rows.push({ code: item.code, name: item.name || '', lastCounted: ts, daysSince });
    }
  });
  rows.sort((a, b) => {
    const aScore = a.daysSince === null ? Number.POSITIVE_INFINITY : a.daysSince;
    const bScore = b.daysSince === null ? Number.POSITIVE_INFINITY : b.daysSince;
    return bScore - aScore;
  });
  return rows;
}

function dashboardBuildChartBuckets(entries, days = 7) {
  const buckets = Array.from({ length: days }).map((_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (days - 1 - index));
    return {
      key: date.toDateString(),
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      total: 0,
    };
  });
  (entries || []).forEach((entry) => {
    const ts = dashboardParseTs(entry.ts);
    if (!ts) return;
    const bucket = buckets.find((candidate) => candidate.key === new Date(ts).toDateString());
    if (bucket) bucket.total += 1;
  });
  return buckets.map(({ label, total }) => ({ label, total }));
}

function dashboardParseDetails(details) {
  if (!details) return {};
  if (typeof details === 'object') return details;
  try {
    return JSON.parse(details);
  } catch (e) {
    return {};
  }
}

function dashboardBuildCategoryRules(categories) {
  return new Map((categories || []).filter((cat) => cat?.name).map((cat) => [String(cat.name).toLowerCase(), normalizeCategoryRules(cat.rules)]));
}

function dashboardComputeManagerMetrics({ inventory, counts, items, categories, pickEvents, checkinEvents }, options = {}) {
  const parsedNow = Number(options.nowTs);
  const now = Number.isFinite(parsedNow) && parsedNow > 0 ? parsedNow : Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const parsedWindow = Number(options.windowDays);
  const windowDays = Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : 30;
  const recentDays = Math.min(windowDays, 7);
  const windowStart = now - windowDays * dayMs;
  const recentStart = now - recentDays * dayMs;
  inventory = (inventory || []).filter((entry) => {
    const ts = dashboardParseTs(entry.ts);
    return !ts || ts <= now;
  });
  counts = (counts || []).filter((row) => {
    const ts = dashboardParseTs(row.countedAt || row.countedat || row.ts);
    return !ts || ts <= now;
  });
  pickEvents = (pickEvents || []).filter((row) => {
    const ts = dashboardParseTs(row.ts);
    return !ts || ts <= now;
  });
  checkinEvents = (checkinEvents || []).filter((row) => {
    const ts = dashboardParseTs(row.ts);
    return !ts || ts <= now;
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const itemMap = new Map((items || []).map((item) => [String(item.code || '').trim(), item]));
  const categoryRules = dashboardBuildCategoryRules(categories || []);
  const statsMap = new Map();
  (inventory || []).forEach((entry) => {
    const code = String(entry.code || '').trim();
    if (!code) return;
    const type = String(entry.type || '').toLowerCase();
    const qty = Number(entry.qty || 0) || 0;
    const ts = dashboardParseTs(entry.ts) || 0;
    const rec = statsMap.get(code) || {
      code,
      in: 0,
      out: 0,
      reserve: 0,
      reserveRelease: 0,
      returned: 0,
      consume: 0,
      ordered: 0,
      lastMoveTs: 0,
      lastAnyTs: 0,
    };
    rec.lastAnyTs = Math.max(rec.lastAnyTs, ts);
    if (type === 'in') rec.in += qty;
    if (type === 'out') rec.out += qty;
    if (type === 'reserve') rec.reserve += qty;
    if (type === 'reserve_release') rec.reserveRelease += qty;
    if (type === 'return') rec.returned += qty;
    if (type === 'consume') rec.consume += qty;
    if (type === 'ordered') rec.ordered += qty;
    if (['in', 'out', 'return', 'consume'].includes(type)) rec.lastMoveTs = Math.max(rec.lastMoveTs, ts);
    statsMap.set(code, rec);
  });
  statsMap.forEach((rec) => {
    rec.available = rec.in + rec.returned + rec.reserveRelease - rec.out - rec.reserve - rec.consume;
    rec.onHand = rec.in + rec.returned - rec.out - rec.consume;
  });

  let pickedToday = 0;
  let receivedToday = 0;
  (inventory || []).forEach((entry) => {
    const type = String(entry.type || '').toLowerCase();
    const ts = dashboardParseTs(entry.ts);
    if (!ts || ts < todayStart) return;
    const qty = Math.abs(Number(entry.qty || 0) || 0);
    if (type === 'out') pickedToday += qty;
    if (type === 'in') receivedToday += qty;
  });

  const countsMap = new Map();
  (counts || []).forEach((row) => {
    const code = String(row.code || '').trim();
    if (!code) return;
    const countedAt = dashboardParseTs(row.countedAt || row.countedat || row.ts);
    const existing = countsMap.get(code);
    if (existing && existing.countedAt && countedAt && existing.countedAt > countedAt) return;
    const item = itemMap.get(code);
    const rawCost = item?.unitPrice ?? item?.unitprice;
    const cost = Number(rawCost);
    countsMap.set(code, {
      qty: Number(row.qty || 0),
      countedAt,
      cost: Number.isFinite(cost) ? cost : 0,
    });
  });

  const countDueList = [];
  statsMap.forEach((rec, code) => {
    const count = countsMap.get(code);
    const lastCounted = count?.countedAt || 0;
    if (lastCounted && lastCounted >= (now - windowDays * dayMs)) return;
    countDueList.push({
      code,
      name: itemMap.get(code)?.name || '',
      lastCounted,
      available: rec.available,
    });
  });
  countDueList.sort((a, b) => {
    const aTs = a.lastCounted || 0;
    const bTs = b.lastCounted || 0;
    if (aTs === bTs) return String(a.code || '').localeCompare(String(b.code || ''));
    if (!aTs) return -1;
    if (!bTs) return 1;
    return aTs - bTs;
  });

  const returnMap = new Map();
  (inventory || []).forEach((entry) => {
    const type = String(entry.type || '').toLowerCase();
    if (type !== 'out' && type !== 'return') return;
    const code = String(entry.code || '').trim();
    if (!code) return;
    const jobId = dashboardNormalizeJobId(entry.jobid || entry.jobId || '');
    const key = `${code}|${jobId}`;
    const rec = returnMap.get(key) || { code, jobId, out: 0, ret: 0, lastOutTs: 0, minDue: null };
    const qty = Number(entry.qty || 0) || 0;
    const ts = dashboardParseTs(entry.ts) || 0;
    if (type === 'out') {
      rec.out += qty;
      rec.lastOutTs = Math.max(rec.lastOutTs, ts);
      const due = dashboardParseTs(entry.returnDate || entry.returndate);
      if (due) rec.minDue = rec.minDue ? Math.min(rec.minDue, due) : due;
    } else {
      rec.ret += qty;
    }
    returnMap.set(key, rec);
  });
  const outstandingReturns = Array.from(returnMap.values()).map((rec) => ({ ...rec, outstanding: Math.max(0, rec.out - rec.ret) }));
  const overdueReturns = outstandingReturns.filter((rec) => {
    if (rec.outstanding <= 0) return false;
    if (rec.minDue && rec.minDue < now) return true;
    return !rec.minDue && rec.lastOutTs && rec.lastOutTs < (now - windowDays * dayMs);
  });
  const pendingReturnsQty = outstandingReturns.reduce((sum, rec) => sum + rec.outstanding, 0);
  const overdueReturnsQty = overdueReturns.reduce((sum, rec) => sum + rec.outstanding, 0);
  const overdueReturnsCount = overdueReturns.length;
  const lateReturnsList = overdueReturns.map((rec) => ({
    code: rec.code,
    name: itemMap.get(rec.code)?.name || '',
    jobId: rec.jobId,
    outstanding: rec.outstanding,
    due: rec.minDue || rec.lastOutTs || 0,
  })).sort((a, b) => (a.due || 0) - (b.due || 0)).slice(0, 5);

  let sumSystem = 0;
  let sumDiff = 0;
  let discrepancyValue = 0;
  let counted = 0;
  statsMap.forEach((rec, code) => {
    const count = countsMap.get(code);
    if (!count) return;
    const systemQty = Number(rec.available || 0);
    const countedQty = Number(count.qty || 0);
    const diff = countedQty - systemQty;
    sumSystem += Math.abs(systemQty);
    sumDiff += Math.abs(diff);
    discrepancyValue += Math.abs(diff) * (count.cost || 0);
    counted += 1;
  });
  const accuracy = counted && sumSystem ? Math.max(0, 1 - (sumDiff / sumSystem)) : null;

  const totalTransactions = (inventory || []).filter((entry) => ['in', 'out', 'return', 'reserve', 'consume', 'reserve_release'].includes(String(entry.type || '').toLowerCase())).length;
  const adjustments = (inventory || []).filter((entry) => {
    const type = String(entry.type || '').toLowerCase();
    const status = String(entry.status || '').toLowerCase();
    return type === 'consume' || status === 'damaged' || status === 'lost';
  }).length;
  const adjustmentRate = totalTransactions ? adjustments / totalTransactions : null;

  let inventoryValue = 0;
  let belowReorder = 0;
  let negativeAvailability = 0;
  let notCounted = 0;
  let deadStock = 0;
  let stockouts = 0;
  let totalItems = 0;
  let totalAvailableValue = 0;

  statsMap.forEach((rec, code) => {
    const item = itemMap.get(code);
    const lowStockEnabled = resolveLowStockEnabled(item, categoryRules);
    const rawCost = item?.unitPrice ?? item?.unitprice;
    const cost = Number(rawCost);
    const itemCost = Number.isFinite(cost) ? cost : 0;
    const available = Number(rec.available || 0);
    const onHand = Number(rec.onHand || 0);
    const reorderPoint = Number(item?.reorderPoint ?? item?.reorderpoint);
    if (lowStockEnabled && Number.isFinite(reorderPoint) && available <= reorderPoint) belowReorder += 1;
    if (available < 0) negativeAvailability += 1;
    if (lowStockEnabled && available <= 0) stockouts += 1;
    totalItems += 1;
    inventoryValue += Math.max(0, onHand) * itemCost;
    totalAvailableValue += Math.max(0, onHand) * itemCost;
    const count = countsMap.get(code);
    if (!count || !count.countedAt || count.countedAt < (now - windowDays * dayMs)) notCounted += 1;
    if (!rec.lastMoveTs || rec.lastMoveTs < windowStart) deadStock += 1;
  });

  const inventoryValueDelta = (inventory || []).reduce((sum, entry) => {
    const type = String(entry.type || '').toLowerCase();
    if (!['in', 'out', 'return', 'consume'].includes(type)) return sum;
    const ts = dashboardParseTs(entry.ts);
    if (!ts || ts < (now - 7 * dayMs)) return sum;
    const qty = Number(entry.qty || 0) || 0;
    const item = itemMap.get(entry.code || '');
    const cost = Number(item?.unitPrice ?? item?.unitprice);
    const unitCost = Number.isFinite(cost) ? cost : 0;
    const direction = (type === 'in' || type === 'return') ? 1 : -1;
    return sum + (direction * qty * unitCost);
  }, 0);
  const valueSevenDaysAgo = inventoryValue - inventoryValueDelta;
  const inventoryTrend = valueSevenDaysAgo ? (inventoryValue - valueSevenDaysAgo) / valueSevenDaysAgo : null;

  const handledByUser = new Map();
  (inventory || []).forEach((entry) => {
    const type = String(entry.type || '').toLowerCase();
    if (!['in', 'out', 'return', 'consume'].includes(type)) return;
    const ts = dashboardParseTs(entry.ts);
    if (!ts || ts < recentStart) return;
    const qty = Math.abs(Number(entry.qty || 0) || 0);
    const key = entry.useremail || entry.userEmail || entry.username || entry.userName || 'Unknown';
    handledByUser.set(key, (handledByUser.get(key) || 0) + qty);
  });
  const totalHandled = Array.from(handledByUser.values()).reduce((sum, value) => sum + value, 0);
  const itemsPerEmployee = handledByUser.size ? totalHandled / handledByUser.size : null;

  const ordersProcessed = new Set();
  (inventory || []).forEach((entry) => {
    const type = String(entry.type || '').toLowerCase();
    if (type !== 'in' || String(entry.sourcetype || entry.sourceType || '').toLowerCase() !== 'order') return;
    const ts = dashboardParseTs(entry.ts);
    if (!ts || ts < recentStart) return;
    const sourceId = entry.sourceid || entry.sourceId || entry.id;
    if (sourceId) ordersProcessed.add(sourceId);
  });
  const ordersPerDay = ordersProcessed.size / recentDays;

  const orderMap = new Map();
  (inventory || []).forEach((entry) => {
    if (String(entry.type || '').toLowerCase() !== 'ordered') return;
    const status = String(entry.status || '').toLowerCase();
    if (status === 'cancelled' || status === 'canceled') return;
    orderMap.set(entry.id, {
      id: entry.id,
      qty: Number(entry.qty || 0) || 0,
      ts: dashboardParseTs(entry.ts),
      eta: dashboardParseTs(entry.eta),
      received: 0,
      firstCheckin: null,
    });
  });
  (inventory || []).forEach((entry) => {
    const type = String(entry.type || '').toLowerCase();
    if (type !== 'in' || String(entry.sourcetype || entry.sourceType || '').toLowerCase() !== 'order') return;
    const sourceId = entry.sourceid || entry.sourceId;
    if (!sourceId || !orderMap.has(sourceId)) return;
    const rec = orderMap.get(sourceId);
    const qty = Number(entry.qty || 0) || 0;
    rec.received += qty;
    const ts = dashboardParseTs(entry.ts);
    if (ts && (!rec.firstCheckin || ts < rec.firstCheckin)) rec.firstCheckin = ts;
  });

  const leadTimes = [];
  let onTime = 0;
  let onTimeTotal = 0;
  let orderedQtyWindow = 0;
  let receivedQtyWindow = 0;
  orderMap.forEach((order) => {
    const orderTs = order.ts || 0;
    if (orderTs && orderTs >= windowStart) {
      orderedQtyWindow += order.qty;
      receivedQtyWindow += order.received;
    }
    if (orderTs && order.firstCheckin) {
      leadTimes.push(order.firstCheckin - orderTs);
      if (order.eta) {
        onTimeTotal += 1;
        if (order.firstCheckin <= order.eta) onTime += 1;
      }
    }
  });
  const avgLeadTime = leadTimes.length ? leadTimes.reduce((sum, value) => sum + value, 0) / leadTimes.length : null;
  const leadVar = leadTimes.length > 1
    ? Math.sqrt(leadTimes.reduce((sum, value) => sum + Math.pow(value - avgLeadTime, 2), 0) / leadTimes.length)
    : null;
  const onTimeRate = onTimeTotal ? onTime / onTimeTotal : null;
  const fillRate = orderedQtyWindow ? Math.min(1, receivedQtyWindow / orderedQtyWindow) : null;
  const serviceLevel = stockouts === 0 && totalItems ? 1 : totalItems ? 1 - (stockouts / totalItems) : null;

  const cogs = (inventory || []).reduce((sum, entry) => {
    if (String(entry.type || '').toLowerCase() !== 'out') return sum;
    const ts = dashboardParseTs(entry.ts);
    if (!ts || ts < windowStart) return sum;
    const qty = Number(entry.qty || 0) || 0;
    const item = itemMap.get(entry.code || '');
    const cost = Number(item?.unitPrice ?? item?.unitprice);
    return sum + (Number.isFinite(cost) ? cost : 0) * qty;
  }, 0);
  const avgInventoryValue = totalAvailableValue;
  const turnover = avgInventoryValue ? cogs / avgInventoryValue : null;
  const doh = cogs ? (avgInventoryValue / (cogs / windowDays)) : null;

  const usageWindow = new Map();
  (inventory || []).forEach((entry) => {
    if (String(entry.type || '').toLowerCase() !== 'out') return;
    const ts = dashboardParseTs(entry.ts);
    if (!ts || ts < windowStart) return;
    const code = String(entry.code || '').trim();
    if (!code) return;
    usageWindow.set(code, (usageWindow.get(code) || 0) + (Number(entry.qty || 0) || 0));
  });
  const slowMovingList = Array.from(statsMap.values()).map((rec) => ({
    code: rec.code,
    name: itemMap.get(rec.code)?.name || '',
    moves: usageWindow.get(rec.code) || 0,
    available: rec.available,
  })).filter((row) => row.moves <= 2).sort((a, b) => a.moves - b.moves || a.available - b.available).slice(0, 6);

  const usageSorted = Array.from(usageWindow.entries()).map(([code, qty]) => ({
    code,
    name: itemMap.get(code)?.name || '',
    qty,
  })).sort((a, b) => b.qty - a.qty);
  const usageTotal = usageSorted.reduce((sum, row) => sum + row.qty, 0);
  const topUsage = usageSorted.slice(0, 6).map((row) => ({
    ...row,
    share: usageTotal ? row.qty / usageTotal : 0,
  }));
  let cumulative = 0;
  let skuCount = 0;
  for (const row of usageSorted) {
    cumulative += row.qty;
    skuCount += 1;
    if (usageTotal && cumulative / usageTotal >= 0.8) break;
  }
  const eightyTwenty = totalItems ? (skuCount / totalItems) : null;

  const lostQty = (inventory || []).reduce((sum, entry) => {
    if (String(entry.type || '').toLowerCase() !== 'consume') return sum;
    const status = String(entry.status || '').toLowerCase();
    const reason = String(entry.reason || '').toLowerCase();
    if (status === 'lost' || reason.includes('lost')) return sum + (Number(entry.qty || 0) || 0);
    return sum;
  }, 0);
  const damagedQty = (inventory || []).reduce((sum, entry) => {
    if (String(entry.type || '').toLowerCase() !== 'consume') return sum;
    const status = String(entry.status || '').toLowerCase();
    const reason = String(entry.reason || '').toLowerCase();
    if (status === 'damaged' || reason.includes('damage')) return sum + (Number(entry.qty || 0) || 0);
    return sum;
  }, 0);
  const writeOffs = (inventory || []).filter((entry) => String(entry.type || '').toLowerCase() === 'consume').length;
  const totalIssued = (inventory || []).reduce((sum, entry) => {
    if (String(entry.type || '').toLowerCase() !== 'out') return sum;
    const ts = dashboardParseTs(entry.ts);
    if (!ts || ts < windowStart) return sum;
    return sum + (Number(entry.qty || 0) || 0);
  }, 0);
  const shrinkage = totalIssued ? lostQty / totalIssued : null;
  const damaged = totalIssued ? damagedQty / totalIssued : null;
  const avgPerItemValue = inventoryValue / Math.max(totalItems, 1);
  const lostValue = lostQty * avgPerItemValue;
  const alertsCount = negativeAvailability + stockouts + overdueReturnsCount;

  const avgDuration = (events) => {
    const durations = (events || []).map((event) => {
      const details = dashboardParseDetails(event.details);
      return Number(details.durationMs || details.duration || event.durationMs || event.duration);
    }).filter((value) => Number.isFinite(value) && value > 0);
    if (!durations.length) return null;
    return durations.reduce((sum, value) => sum + value, 0) / durations.length;
  };

  return {
    generatedAt: now,
    pickedToday,
    receivedToday,
    pendingReturnsQty,
    overdueReturnsQty,
    overdueReturnsCount,
    alertsCount,
    countDueList: countDueList.slice(0, 5),
    lateReturnsList,
    accuracy,
    adjustmentRate,
    discrepancyValue,
    inventoryValue,
    inventoryTrend,
    belowReorder,
    negativeAvailability,
    notCounted,
    deadStock,
    stockouts,
    totalItems,
    ordersPerDay,
    itemsPerEmployee,
    avgLeadTime,
    leadVar,
    onTimeRate,
    fillRate,
    serviceLevel,
    turnover,
    doh,
    slowMovingList,
    topUsage,
    eightyTwenty,
    shrinkage,
    damaged,
    writeOffs,
    lostValue,
    avgPickTime: avgDuration(pickEvents),
    avgCheckinTime: avgDuration(checkinEvents),
  };
}

function workflowNormalizeJob(row) {
  return {
    code: row?.code || '',
    name: row?.name || '',
    status: row?.status || '',
    startDate: row?.startdate || row?.startDate || '',
    endDate: row?.enddate || row?.endDate || '',
    location: row?.location || '',
    notes: row?.notes || '',
    updatedAt: row?.updatedat || row?.updatedAt || row?.createdat || row?.createdAt || 0,
  };
}

function workflowProjectSortValue(job) {
  const status = String(job?.status || '').trim().toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTs = today.getTime();
  const startTs = dashboardParseTs(job?.startDate) || 0;
  const endTs = dashboardParseTs(job?.endDate) || 0;
  const updatedTs = dashboardParseTs(job?.updatedAt) || 0;
  const isClosed = CLOSED_PROJECT_STATUSES.has(status);
  const isActive = !isClosed && (
    status === 'active'
    || ((startTs && startTs <= todayTs) && (!endTs || endTs >= todayTs))
  );
  const isUpcoming = !isClosed && !isActive && startTs && startTs >= todayTs;
  if (isActive) return { bucket: 0, value: endTs && endTs >= todayTs ? endTs : (startTs || todayTs) };
  if (isUpcoming) return { bucket: 1, value: startTs };
  return { bucket: 2, value: -(updatedTs || endTs || startTs || 0) };
}

function workflowCompareProjects(a, b) {
  const left = workflowProjectSortValue(a);
  const right = workflowProjectSortValue(b);
  if (left.bucket !== right.bucket) return left.bucket - right.bucket;
  if (left.value !== right.value) return left.value - right.value;
  return String(a?.code || '').localeCompare(String(b?.code || ''));
}

function workflowAggregateInventory(entries) {
  const byCode = new Map();
  const reservedByJob = new Map();
  (entries || []).forEach((entry) => {
    const code = String(entry.code || '').trim();
    if (!code) return;
    const type = String(entry.type || '').toLowerCase();
    const qty = Number(entry.qty || 0) || 0;
    const rec = byCode.get(code) || {
      code,
      name: entry.name || '',
      inQty: 0,
      outQty: 0,
      returnedQty: 0,
      reserveQty: 0,
      reserveReleaseQty: 0,
      consumeQty: 0,
      orderedQty: 0,
      lastTs: 0,
    };
    if (!rec.name && entry.name) rec.name = entry.name;
    rec.lastTs = Math.max(rec.lastTs, dashboardParseTs(entry.ts) || 0);
    if (type === 'in') rec.inQty += qty;
    if (type === 'out') rec.outQty += qty;
    if (type === 'return') {
      rec.returnedQty += qty;
    }
    if (type === 'reserve') rec.reserveQty += qty;
    if (type === 'reserve_release') rec.reserveReleaseQty += qty;
    if (type === 'consume') rec.consumeQty += qty;
    if (type === 'ordered') rec.orderedQty += qty;
    byCode.set(code, rec);

    if (type === 'reserve' || type === 'reserve_release') {
      const jobId = dashboardNormalizeJobId(entry.jobid || entry.jobId || '');
      if (jobId) {
        const key = `${jobId}|${code}`;
        const delta = type === 'reserve' ? qty : -qty;
        const current = reservedByJob.get(key) || { jobId, code, qty: 0 };
        current.qty += delta;
        reservedByJob.set(key, current);
      }
    }
  });
  byCode.forEach((rec) => {
    rec.reserved = rec.reserveQty - rec.reserveReleaseQty;
    rec.available = rec.inQty + rec.returnedQty + rec.reserveReleaseQty - rec.outQty - rec.reserveQty - rec.consumeQty;
    rec.onHand = rec.inQty + rec.returnedQty - rec.outQty - rec.consumeQty;
    rec.checkedOut = Math.max(0, rec.outQty - rec.returnedQty);
  });
  return {
    byCode,
    reservedByJob: Array.from(reservedByJob.values()).filter((row) => row.qty > 0),
  };
}

function workflowBuildOverview({ jobs, materials, items, suppliers, categories, inventory, counts }) {
  const supplierMap = new Map((suppliers || []).map((supplier) => [supplier.id, supplier]));
  const itemMap = new Map((items || []).map((item) => [String(item.code || '').trim(), item]));
  const categoryRules = dashboardBuildCategoryRules(categories || []);
  const stock = workflowAggregateInventory(inventory || []);
  const overdueReturns = dashboardBuildOverdueRows(inventory || []).sort((a, b) => b.daysLate - a.daysLate);
  const countDue = dashboardBuildCountDueRows(items || [], counts || []);
  const orderedRows = (inventory || []).filter((entry) => String(entry.type || '').toLowerCase() === 'ordered');
  const openOrders = dashboardBuildOpenOrders(orderedRows, inventory || [])
    .sort((a, b) => (dashboardParseTs(a.eta) || a.lastOrderTs || 0) - (dashboardParseTs(b.eta) || b.lastOrderTs || 0));
  const materialsByJob = new Map();
  (materials || []).forEach((row) => {
    const jobId = String(row.jobId || '').trim();
    if (!jobId) return;
    if (!materialsByJob.has(jobId)) materialsByJob.set(jobId, []);
    materialsByJob.get(jobId).push(row);
  });

  const checkedOutByJob = new Map();
  (inventory || []).forEach((entry) => {
    const jobId = dashboardNormalizeJobId(entry.jobid || entry.jobId || '');
    const code = String(entry.code || '').trim();
    if (!jobId || !code) return;
    const key = `${jobId}|${code}`;
    const rec = checkedOutByJob.get(key) || { jobId, code, qty: 0 };
    const qty = Number(entry.qty || 0) || 0;
    const type = String(entry.type || '').toLowerCase();
    if (type === 'out') rec.qty += qty;
    if (type === 'return') rec.qty -= qty;
    checkedOutByJob.set(key, rec);
  });

  const projects = (jobs || []).map(workflowNormalizeJob).map((job) => {
    const projectMaterials = (materialsByJob.get(job.code) || [])
      .slice()
      .sort((a, b) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.code || '').localeCompare(String(b.code || '')));
    let totalRequired = 0;
    let totalOrdered = 0;
    let totalAllocated = 0;
    let totalReceived = 0;
    let outstandingLines = 0;
    let readyLines = 0;
    let shortageLines = 0;
    let shortageQty = 0;
    let missingSupplierLines = 0;
    const materialRows = projectMaterials.map((material) => {
      const code = String(material.code || '').trim();
      const item = itemMap.get(code);
      const supplierId = material.supplierId || item?.supplierId || item?.supplierid || '';
      const supplier = supplierMap.get(supplierId);
      const stockRow = stock.byCode.get(code);
      const available = Math.max(0, Number(stockRow?.available || 0));
      const outstandingQty = Math.max(0, Number(material.outstandingQty || 0));
      const reserveReadyQty = Math.min(available, outstandingQty);
      const shortage = Math.max(0, outstandingQty - available);
      totalRequired += Number(material.qtyRequired || 0);
      totalOrdered += Number(material.qtyOrdered || 0);
      totalAllocated += Number(material.qtyAllocated || 0);
      totalReceived += Number(material.qtyReceived || 0);
      if (outstandingQty > 0) outstandingLines += 1;
      if (String(material.status || '') === 'ready') readyLines += 1;
      if (shortage > 0) {
        shortageLines += 1;
        shortageQty += shortage;
      }
      if (!supplierId) missingSupplierLines += 1;
      return {
        ...material,
        supplierId,
        supplierName: supplier?.name || '',
        available,
        reserveReadyQty,
        shortageQty: shortage,
      };
    });
    const dueReturns = overdueReturns.filter((row) => row.jobId === job.code);
    const reservedQty = stock.reservedByJob
      .filter((row) => row.jobId === job.code)
      .reduce((sum, row) => sum + Number(row.qty || 0), 0);
    const checkedOutQty = Array.from(checkedOutByJob.values())
      .filter((row) => row.jobId === job.code && row.qty > 0)
      .reduce((sum, row) => sum + Number(row.qty || 0), 0);
    let nextAction = 'review';
    let nextActionLabel = 'Review project';
    if (!materialRows.length) {
      nextAction = 'plan_materials';
      nextActionLabel = 'Build material plan';
    } else if (missingSupplierLines > 0) {
      nextAction = 'assign_suppliers';
      nextActionLabel = 'Assign suppliers';
    } else if (shortageQty > 0) {
      nextAction = 'order_materials';
      nextActionLabel = 'Order materials';
    } else if (outstandingLines > 0) {
      nextAction = 'reserve_stock';
      nextActionLabel = 'Reserve stock';
    } else if (dueReturns.length) {
      nextAction = 'close_returns';
      nextActionLabel = 'Close returns';
    } else {
      nextAction = 'ready';
      nextActionLabel = 'Ready to run';
    }
    return {
      ...job,
      materialLines: materialRows.length,
      outstandingLines,
      readyLines,
      shortageLines,
      shortageQty: roundQty(shortageQty),
      missingSupplierLines,
      totalRequired: roundQty(totalRequired),
      totalOrdered: roundQty(totalOrdered),
      totalAllocated: roundQty(totalAllocated),
      totalReceived: roundQty(totalReceived),
      reservedQty: roundQty(reservedQty),
      checkedOutQty: roundQty(checkedOutQty),
      overdueReturnLines: dueReturns.length,
      nextAction,
      nextActionLabel,
      materials: materialRows,
    };
  }).sort(workflowCompareProjects);

  const projectsMissingMaterials = projects
    .filter((project) => !project.materialLines && !CLOSED_PROJECT_STATUSES.has(String(project.status || '').toLowerCase()))
    .slice(0, 8)
    .map((project) => ({
      code: project.code,
      name: project.name,
      status: project.status,
      startDate: project.startDate,
      endDate: project.endDate,
      location: project.location,
    }));

  const procurementSuggestions = projects.flatMap((project) => project.materials
    .filter((material) => Number(material.outstandingQty || 0) > 0)
    .map((material) => ({
      jobId: project.code,
      projectName: project.name || '',
      materialId: material.id,
      code: material.code,
      name: material.name || '',
      supplierId: material.supplierId || '',
      supplierName: material.supplierName || '',
      outstandingQty: roundQty(material.outstandingQty || 0),
      availableQty: roundQty(material.available || 0),
      reserveReadyQty: roundQty(material.reserveReadyQty || 0),
      shortageQty: roundQty(material.shortageQty || 0),
      qtyOrdered: roundQty(material.qtyOrdered || 0),
      qtyAllocated: roundQty(material.qtyAllocated || 0),
      qtyReceived: roundQty(material.qtyReceived || 0),
      notes: material.notes || '',
    })))
    .sort((a, b) => {
      if ((b.shortageQty || 0) !== (a.shortageQty || 0)) return (b.shortageQty || 0) - (a.shortageQty || 0);
      if ((a.reserveReadyQty || 0) !== (b.reserveReadyQty || 0)) return (a.reserveReadyQty || 0) - (b.reserveReadyQty || 0);
      return String(a.jobId || '').localeCompare(String(b.jobId || ''));
    })
    .slice(0, 16);

  const negativeAvailability = Array.from(stock.byCode.values())
    .filter((row) => Number(row.available || 0) < 0)
    .map((row) => ({
      code: row.code,
      name: itemMap.get(row.code)?.name || row.name || '',
      available: roundQty(row.available || 0),
      reserved: roundQty(row.reserved || 0),
      checkedOut: roundQty(row.checkedOut || 0),
    }))
    .sort((a, b) => a.available - b.available)
    .slice(0, 8);

  const missingSupplier = (items || [])
    .filter((item) => !(item.supplierId || item.supplierid))
    .map((item) => {
      const projectDemand = procurementSuggestions
        .filter((row) => row.code === item.code)
        .reduce((sum, row) => sum + Number(row.outstandingQty || 0), 0);
      return {
        code: item.code,
        name: item.name || '',
        category: item.category || '',
        demandQty: roundQty(projectDemand),
      };
    })
    .sort((a, b) => (b.demandQty || 0) - (a.demandQty || 0) || String(a.code || '').localeCompare(String(b.code || '')))
    .slice(0, 8);

  const missingReorderRule = (items || [])
    .filter((item) => resolveLowStockEnabled(item, categoryRules))
    .filter((item) => {
      const reorderPoint = Number(item.reorderPoint ?? item.reorderpoint);
      return !Number.isFinite(reorderPoint) || reorderPoint < 0;
    })
    .map((item) => ({
      code: item.code,
      name: item.name || '',
      category: item.category || '',
    }))
    .slice(0, 8);

  const employeePickMap = new Map();
  stock.reservedByJob.forEach((row) => {
    if (!row.jobId) return;
    const current = employeePickMap.get(row.jobId) || { jobId: row.jobId, skuCount: 0, reservedQty: 0 };
    current.skuCount += 1;
    current.reservedQty += Number(row.qty || 0);
    employeePickMap.set(row.jobId, current);
  });
  const employeePicks = Array.from(employeePickMap.values())
    .map((row) => ({
      title: `Pick ${row.jobId}`,
      detail: `${row.skuCount} SKUs reserved / ${roundQty(row.reservedQty)} units`,
      href: 'inventory-operations.html?mode=checkout',
      tone: row.reservedQty > 10 ? 'warn' : 'ok',
    }))
    .sort((a, b) => {
      const aQty = Number((a.detail.match(/\/ ([\d.]+)/) || [])[1] || 0);
      const bQty = Number((b.detail.match(/\/ ([\d.]+)/) || [])[1] || 0);
      return bQty - aQty;
    })
    .slice(0, 5);

  const employeeReturns = overdueReturns.slice(0, 5).map((row) => ({
    title: `Return ${row.code}`,
    detail: `${row.outstanding} overdue for ${row.jobId || 'General'}`,
    href: 'inventory-operations.html?mode=return',
    tone: 'critical',
  }));

  const employeeInbound = openOrders.slice(0, 5).map((row) => ({
    title: `Receive ${row.code}`,
    detail: `${row.openQty} due ${row.eta || 'soon'}`,
    href: 'inventory-operations.html?mode=checkin',
    tone: dashboardParseTs(row.eta) && dashboardParseTs(row.eta) < Date.now() ? 'critical' : 'ok',
  }));

  return {
    generatedAt: Date.now(),
    fulfillmentBoard: projects.slice(0, 10),
    procurementSuggestions,
    exceptions: {
      negativeAvailability,
      missingSupplier,
      missingReorderRule,
      overdueReturns: overdueReturns.slice(0, 8).map((row) => ({
        code: row.code,
        jobId: row.jobId,
        outstanding: row.outstanding,
        daysLate: row.daysLate,
      })),
      projectsMissingMaterials,
    },
    inbox: {
      employee: {
        picks: employeePicks,
        returns: employeeReturns,
        inbound: employeeInbound,
      },
      manager: {
        countsDue: countDue.slice(0, 5),
        shortages: procurementSuggestions.filter((row) => Number(row.shortageQty || 0) > 0).slice(0, 5),
        projects: projects.filter((project) => project.outstandingLines > 0 || project.missingSupplierLines > 0).slice(0, 5),
        overdueReturns: overdueReturns.slice(0, 5).map((row) => ({
          code: row.code,
          jobId: row.jobId,
          outstanding: row.outstanding,
          daysLate: row.daysLate,
        })),
      },
      admin: {
        missingSupplier: missingSupplier.slice(0, 5),
        missingReorderRule: missingReorderRule.slice(0, 5),
        projectsMissingMaterials: projectsMissingMaterials.slice(0, 5),
        openOrders: openOrders.slice(0, 5).map((row) => ({
          code: row.code,
          jobId: row.jobId,
          openQty: row.openQty,
          eta: row.eta || '',
        })),
      },
    },
  };
}

async function ensureTenantCapabilities(tenantIdVal) {
  if (!tenantIdVal) return;
  const now = Date.now();
  await runAsync(
    `INSERT INTO tenant_capabilities(
      tenant_id,
      ims_enabled, oms_enabled, bms_enabled, fms_enabled,
      automation_enabled, insights_enabled, audit_enabled, integration_enabled,
      end_to_end_ops, financial_accuracy, enterprise_governance,
      created_at, updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
    ON CONFLICT (tenant_id) DO NOTHING`,
    [
      tenantIdVal,
      DEFAULT_TENANT_CAPS.ims_enabled,
      DEFAULT_TENANT_CAPS.oms_enabled,
      DEFAULT_TENANT_CAPS.bms_enabled,
      DEFAULT_TENANT_CAPS.fms_enabled,
      DEFAULT_TENANT_CAPS.automation_enabled,
      DEFAULT_TENANT_CAPS.insights_enabled,
      DEFAULT_TENANT_CAPS.audit_enabled,
      DEFAULT_TENANT_CAPS.integration_enabled,
      DEFAULT_TENANT_CAPS.end_to_end_ops,
      DEFAULT_TENANT_CAPS.financial_accuracy,
      DEFAULT_TENANT_CAPS.enterprise_governance,
      now
    ]
  );
}

function mapTenantCapabilities(row) {
  if (!row) return { tenantId: null, ...DEFAULT_TENANT_CAPS };
  return {
    tenantId: row.tenant_id || row.tenantId,
    ims_enabled: row.ims_enabled ?? DEFAULT_TENANT_CAPS.ims_enabled,
    oms_enabled: row.oms_enabled ?? DEFAULT_TENANT_CAPS.oms_enabled,
    bms_enabled: row.bms_enabled ?? DEFAULT_TENANT_CAPS.bms_enabled,
    fms_enabled: row.fms_enabled ?? DEFAULT_TENANT_CAPS.fms_enabled,
    automation_enabled: row.automation_enabled ?? DEFAULT_TENANT_CAPS.automation_enabled,
    insights_enabled: row.insights_enabled ?? DEFAULT_TENANT_CAPS.insights_enabled,
    audit_enabled: row.audit_enabled ?? DEFAULT_TENANT_CAPS.audit_enabled,
    integration_enabled: row.integration_enabled ?? DEFAULT_TENANT_CAPS.integration_enabled,
    end_to_end_ops: row.end_to_end_ops ?? DEFAULT_TENANT_CAPS.end_to_end_ops,
    financial_accuracy: row.financial_accuracy ?? DEFAULT_TENANT_CAPS.financial_accuracy,
    enterprise_governance: row.enterprise_governance ?? DEFAULT_TENANT_CAPS.enterprise_governance,
    created_at: row.created_at || row.createdAt || null,
    updated_at: row.updated_at || row.updatedAt || null
  };
}

async function getTenantCapabilities(tenantIdVal) {
  await ensureTenantCapabilities(tenantIdVal);
  const row = await getAsync('SELECT * FROM tenant_capabilities WHERE tenant_id=$1', [tenantIdVal]);
  return mapTenantCapabilities(row);
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
function normalizeBool(input, fallback = false) {
  const normalized = normalizeOptionalBool(input);
  return normalized === null ? fallback : normalized;
}
function normalizeInventoryLocationType(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  if (['warehouse', 'wh'].includes(raw)) return 'warehouse';
  if (['bin', 'shelf', 'zone', 'rack', 'storage'].includes(raw)) return 'bin';
  if (['staging', 'staging-area', 'receiving'].includes(raw)) return 'staging';
  if (['vehicle', 'truck', 'van'].includes(raw)) return 'vehicle';
  if (['field', 'site'].includes(raw)) return 'field';
  if (['writeoff', 'write-off', 'lost', 'lost-writeoff', 'lost/write-off'].includes(raw)) return 'writeoff';
  return '';
}
function inferInventoryLocationType(label) {
  const raw = String(label || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('warehouse')) return 'warehouse';
  if (raw.includes('bin') || raw.includes('shelf') || raw.includes('zone') || raw.includes('rack')) return 'bin';
  if (raw.includes('staging') || raw.includes('receiving')) return 'staging';
  if (raw.includes('truck') || raw.includes('vehicle') || raw.includes('van')) return 'vehicle';
  if (raw.includes('field') || raw.includes('site')) return 'field';
  if (raw.includes('lost') || raw.includes('write-off') || raw.includes('writeoff')) return 'writeoff';
  return '';
}
function normalizeInventoryLocationLabel(location, locationType) {
  const label = String(location || '').trim();
  if (label) return label;
  const type = normalizeInventoryLocationType(locationType);
  const system = SYSTEM_INVENTORY_LOCATIONS.find((entry) => entry.type === type);
  return system?.name || '';
}
function isUnspecifiedInventoryLocation(value) {
  return String(value || '').trim().toLowerCase() === 'unspecified';
}
function buildInventoryLocationId(tenantIdVal, ref) {
  return `invloc:${tenantIdVal}:${ref}`;
}
function normalizeInventoryLocationRef(input, fallbackName) {
  const raw = String(input || fallbackName || '').trim().toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
async function ensureDefaultInventoryLocations(tenantIdVal) {
  const existing = await getAsync('SELECT COUNT(*)::int AS count FROM inventory_locations WHERE tenantId=$1', [tenantIdVal]);
  if (Number(existing?.count || 0) > 0) return;
  const now = Date.now();
  const byRef = new Map();
  for (const entry of SYSTEM_INVENTORY_LOCATIONS) {
    const id = buildInventoryLocationId(tenantIdVal, entry.ref);
    byRef.set(entry.ref, id);
  }
  for (const entry of SYSTEM_INVENTORY_LOCATIONS) {
    const id = byRef.get(entry.ref);
    const parentId = entry.parentRef ? byRef.get(entry.parentRef) || null : null;
    await runAsync(
      `INSERT INTO inventory_locations(id,ref,name,type,parentId,sortOrder,isActive,notes,tenantId,createdAt,updatedAt)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       ON CONFLICT (id) DO NOTHING`,
      [id, entry.ref, entry.name, entry.type, parentId, entry.sortOrder || 0, true, entry.system ? 'System default location' : null, tenantIdVal, now]
    );
  }
}
function decorateInventoryLocationRows(rows) {
  const sourceRows = (rows || []).map((row) => ({
    id: row.id,
    ref: row.ref,
    name: row.name,
    type: row.type,
    parentId: row.parentid || row.parentId || null,
    sortOrder: Number(row.sortorder || row.sortOrder || 0) || 0,
    isActive: normalizeBool(row.isactive ?? row.isActive, true),
    isConsumptionPoint: normalizeBool(row.isconsumptionpoint ?? row.isConsumptionPoint, false),
    notes: row.notes || '',
    createdAt: row.createdat || row.createdAt || null,
    updatedAt: row.updatedat || row.updatedAt || null
  }));
  const byId = new Map(sourceRows.map((row) => [row.id, row]));
  const buildPath = (row, seen = new Set()) => {
    if (!row) return [];
    if (seen.has(row.id)) return [row.name];
    const nextSeen = new Set(seen);
    nextSeen.add(row.id);
    const parent = row.parentId ? byId.get(row.parentId) : null;
    const parentPath = parent ? buildPath(parent, nextSeen) : [];
    return [...parentPath, row.name];
  };
  return sourceRows
    .map((row) => {
      const path = buildPath(row);
      const depth = Math.max(0, path.length - 1);
      return {
        ...row,
        typeLabel: INVENTORY_LOCATION_TYPE_LABELS[row.type] || row.type,
        path,
        depth,
        label: path.join(' / '),
        parentName: row.parentId ? byId.get(row.parentId)?.name || '' : '',
        parentRef: row.parentId ? byId.get(row.parentId)?.ref || '' : ''
      };
    })
    .sort((a, b) => {
      const bySort = (a.sortOrder || 0) - (b.sortOrder || 0);
      if (bySort !== 0) return bySort;
      if (a.label !== b.label) return a.label.localeCompare(b.label);
      return a.name.localeCompare(b.name);
    });
}
async function listManagedInventoryLocations(tenantIdVal) {
  await ensureDefaultInventoryLocations(tenantIdVal);
  const rows = await allAsync(
    `SELECT id, ref, name, type, parentId, sortOrder, isActive, isConsumptionPoint, notes, createdAt, updatedAt
     FROM inventory_locations
     WHERE tenantId=$1 AND COALESCE(isActive, true)=true`,
    [tenantIdVal]
  );
  return decorateInventoryLocationRows(rows);
}
async function listInventoryLocations(tenantIdVal) {
  const managedRows = await listManagedInventoryLocations(tenantIdVal);
  const vehicles = await allAsync(
    'SELECT id, code, name, location FROM vehicle_assets WHERE tenantId=$1 ORDER BY name ASC NULLS LAST, code ASC',
    [tenantIdVal]
  );
  const vehicleRows = (vehicles || []).map((row, index) => {
    const name = (row.name || row.code || '').trim();
    return {
      id: `vehicle:${row.id}`,
      ref: row.code || row.id,
      name,
      label: `Vehicle Fleet / ${name}${row.location ? ` (${row.location})` : ''}`,
      type: 'vehicle',
      typeLabel: INVENTORY_LOCATION_TYPE_LABELS.vehicle,
      system: false,
      sortOrder: 500 + index,
      depth: 1,
      path: ['Vehicle Fleet', name]
    };
  });
  return [
    ...managedRows,
    ...vehicleRows
  ];
}
async function getInventoryLocationById(locationId, tenantIdVal) {
  if (!locationId) return null;
  return getAsync(
    `SELECT id, ref, name, type, parentId, sortOrder, isActive, isConsumptionPoint, notes, createdAt, updatedAt
     FROM inventory_locations WHERE id=$1 AND tenantId=$2`,
    [locationId, tenantIdVal]
  );
}
async function getInventoryLocationByRef(locationRef, tenantIdVal) {
  const ref = normalizeInventoryLocationRef(locationRef);
  if (!ref) return null;
  return getAsync(
    `SELECT id, ref, name, type, parentId, sortOrder, isActive, isConsumptionPoint, notes, createdAt, updatedAt
     FROM inventory_locations WHERE ref=$1 AND tenantId=$2`,
    [ref, tenantIdVal]
  );
}
async function getConsumptionPointLocationById(locationId, tenantIdVal) {
  const row = await getInventoryLocationById(locationId, tenantIdVal);
  if (!row) throw new Error('consumption point location not found');
  if (!normalizeBool(row.isconsumptionpoint ?? row.isConsumptionPoint, false)) throw new Error('selected location is not a consumption point');
  if (!normalizeBool(row.isactive ?? row.isActive, true)) throw new Error('selected consumption point is inactive');
  return row;
}
async function assertInventoryLocationHierarchy({ tenantIdVal, locationId = null, parentId = null }) {
  if (!parentId) return null;
  if (locationId && parentId === locationId) throw new Error('location cannot be its own parent');
  const parent = await getInventoryLocationById(parentId, tenantIdVal);
  if (!parent) throw new Error('parent location not found');
  if (!locationId) return parent;
  let cursor = parent;
  const seen = new Set([locationId]);
  while (cursor?.parentid || cursor?.parentId) {
    const nextId = cursor.parentid || cursor.parentId;
    if (seen.has(nextId)) throw new Error('location hierarchy cannot contain a cycle');
    seen.add(nextId);
    cursor = await getInventoryLocationById(nextId, tenantIdVal);
  }
  return parent;
}
function normalizeInventoryLocationInput(body = {}) {
  const name = String(body.name || '').trim();
  const type = normalizeInventoryLocationType(body.type);
  const ref = normalizeInventoryLocationRef(body.ref, name);
  const notes = String(body.notes || '').trim() || null;
  const sortOrderRaw = Number(body.sortOrder);
  const sortOrder = Number.isFinite(sortOrderRaw) ? Math.round(sortOrderRaw) : 0;
  const isActive = body.isActive === undefined ? true : !!body.isActive;
  const isConsumptionPoint = body.isConsumptionPoint === undefined ? false : !!body.isConsumptionPoint;
  return {
    name,
    type,
    ref,
    parentId: String(body.parentId || '').trim() || null,
    notes,
    sortOrder,
    isActive,
    isConsumptionPoint
  };
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
function normalizeItemStorageValue(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
}
function itemStorageSnapshot(source) {
  return {
    warehouse: normalizeItemStorageValue(source?.warehouse),
    zone: normalizeItemStorageValue(source?.zone),
    bin: normalizeItemStorageValue(source?.bin)
  };
}
function itemStorageLabel(source) {
  const snapshot = itemStorageSnapshot(source);
  const parts = [snapshot.warehouse, snapshot.zone, snapshot.bin].filter(Boolean);
  return parts.length ? parts.join(' / ') : 'Unassigned';
}
function itemStorageChanged(before, after) {
  const previous = itemStorageSnapshot(before);
  const next = itemStorageSnapshot(after);
  return previous.warehouse !== next.warehouse
    || previous.zone !== next.zone
    || previous.bin !== next.bin;
}
function buildItemStorageAuditDetails(code, before, after) {
  const previous = itemStorageSnapshot(before);
  const next = itemStorageSnapshot(after);
  return {
    code,
    storageChanged: true,
    storageBefore: previous,
    storageAfter: next,
    storageFromLabel: itemStorageLabel(previous),
    storageToLabel: itemStorageLabel(next),
    storageFieldsChanged: {
      warehouse: { from: previous.warehouse, to: next.warehouse },
      zone: { from: previous.zone, to: next.zone },
      bin: { from: previous.bin, to: next.bin }
    }
  };
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

function isLocalhostRequest(req) {
  const host = String(req.hostname || req.headers.host || '').toLowerCase().split(':')[0];
  const remote = String(req.ip || req.socket?.remoteAddress || '').toLowerCase().replace('::ffff:', '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || remote === '127.0.0.1' || remote === '::1';
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
  req.tenantCaps = await getTenantCapabilities(user.tenantid || user.tenantId);
  next();
}
let initDbPhase = 'not-started';
async function initDb() {
  initDbPhase = 'core-schema';
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
    supplierId TEXT,
    supplierSku TEXT,
    supplierUrl TEXT,
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
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS lowStockNotifiedAt BIGINT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS supplierId TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS supplierSku TEXT`);
  await runAsync(`ALTER TABLE items ADD COLUMN IF NOT EXISTS supplierUrl TEXT`);
  await runAsync(`CREATE TABLE IF NOT EXISTS suppliers(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT,
    email TEXT,
    phone TEXT,
    orderMethod TEXT,
    websiteUrl TEXT,
    orderUrl TEXT,
    leadTime JSONB,
    moq NUMERIC,
    notes TEXT,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default',
    createdAt BIGINT,
    updatedAt BIGINT
  )`);
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
    locationType TEXT,
    locationRef TEXT,
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
  await runAsync(`CREATE TABLE IF NOT EXISTS inventory_locations(
    id TEXT PRIMARY KEY,
    ref TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    parentId TEXT,
    sortOrder INTEGER DEFAULT 0,
    isActive BOOLEAN DEFAULT true,
    isConsumptionPoint BOOLEAN DEFAULT false,
    notes TEXT,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default',
    createdAt BIGINT,
    updatedAt BIGINT
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
    materialsReadyNotifiedAt BIGINT,
    updatedAt BIGINT,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS job_materials(
    id TEXT PRIMARY KEY,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default',
    jobId TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    supplierId TEXT,
    qtyRequired NUMERIC DEFAULT 0,
    qtyOrdered NUMERIC DEFAULT 0,
    qtyAllocated NUMERIC DEFAULT 0,
    qtyReceived NUMERIC DEFAULT 0,
    notes TEXT,
    sortOrder INTEGER DEFAULT 0,
    createdAt BIGINT,
    updatedAt BIGINT
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    role TEXT NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    createdAt BIGINT,
    emailVerified BOOLEAN,
    emailVerifiedAt BIGINT,
    invitedAt BIGINT,
    notificationPrefs JSONB,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    expires BIGINT NOT NULL,
    createdAt BIGINT
  )`);
  await runAsync('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)');
  await runAsync(`CREATE TABLE IF NOT EXISTS auth_tokens(
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    tokenHash TEXT UNIQUE NOT NULL,
    userId TEXT,
    tenantId TEXT REFERENCES tenants(id),
    email TEXT,
    createdAt BIGINT,
    expiresAt BIGINT,
    consumedAt BIGINT,
    meta JSONB
  )`);
  await runAsync('CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(userId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_auth_tokens_email ON auth_tokens(LOWER(email))');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expiresAt)');
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
  await runAsync(`CREATE TABLE IF NOT EXISTS equipment_assets(
    id TEXT PRIMARY KEY,
    code TEXT,
    name TEXT,
    category TEXT,
    location TEXT,
    status TEXT,
    serial TEXT,
    model TEXT,
    manufacturer TEXT,
    purchaseDate TEXT,
    warrantyEnd TEXT,
    usageHours INTEGER,
    lastServiceAt BIGINT,
    nextServiceAt BIGINT,
    lastActivityAt BIGINT,
    assignedProject TEXT,
    notes TEXT,
    tags JSONB,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS vehicle_assets(
    id TEXT PRIMARY KEY,
    code TEXT,
    name TEXT,
    make TEXT,
    model TEXT,
    year INTEGER,
    vin TEXT,
    plate TEXT,
    location TEXT,
    consumptionLocationId TEXT,
    status TEXT,
    mileage INTEGER,
    lastServiceAt BIGINT,
    nextServiceAt BIGINT,
    lastActivityAt BIGINT,
    assignedProject TEXT,
    notes TEXT,
    tags JSONB,
    tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'
  )`);
  await runAsync('CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_code_tenant ON equipment_assets(code, tenantId)');
  await runAsync('CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_code_tenant ON vehicle_assets(code, tenantId)');
  await runAsync(`CREATE TABLE IF NOT EXISTS tenant_capabilities(
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
    ims_enabled BOOLEAN DEFAULT true,
    oms_enabled BOOLEAN DEFAULT false,
    bms_enabled BOOLEAN DEFAULT false,
    fms_enabled BOOLEAN DEFAULT false,
    automation_enabled BOOLEAN DEFAULT false,
    insights_enabled BOOLEAN DEFAULT false,
    audit_enabled BOOLEAN DEFAULT false,
    integration_enabled BOOLEAN DEFAULT false,
    end_to_end_ops BOOLEAN DEFAULT false,
    financial_accuracy BOOLEAN DEFAULT false,
    enterprise_governance BOOLEAN DEFAULT false,
    created_at BIGINT,
    updated_at BIGINT
  )`);
  await runAsync('CREATE INDEX IF NOT EXISTS idx_tenant_caps_updated ON tenant_capabilities(updated_at)');
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
  await runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS locationType TEXT`);
  await runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS locationRef TEXT`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS ref TEXT`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS name TEXT`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS type TEXT`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS parentId TEXT`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS sortOrder INTEGER DEFAULT 0`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS isActive BOOLEAN DEFAULT true`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS isConsumptionPoint BOOLEAN DEFAULT false`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS notes TEXT`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS createdAt BIGINT`);
  await runAsync(`ALTER TABLE inventory_locations ADD COLUMN IF NOT EXISTS updatedAt BIGINT`);
  await runAsync(`UPDATE inventory
    SET locationType = CASE
      WHEN LOWER(COALESCE(location, '')) LIKE '%warehouse%' THEN 'warehouse'
      WHEN LOWER(COALESCE(location, '')) LIKE '%bin%' OR LOWER(COALESCE(location, '')) LIKE '%shelf%' OR LOWER(COALESCE(location, '')) LIKE '%zone%' OR LOWER(COALESCE(location, '')) LIKE '%rack%' THEN 'bin'
      WHEN LOWER(COALESCE(location, '')) LIKE '%staging%' OR LOWER(COALESCE(location, '')) LIKE '%receiving%' THEN 'staging'
      WHEN LOWER(COALESCE(location, '')) LIKE '%truck%' OR LOWER(COALESCE(location, '')) LIKE '%vehicle%' OR LOWER(COALESCE(location, '')) LIKE '%van%' THEN 'vehicle'
      WHEN LOWER(COALESCE(location, '')) LIKE '%field%' OR LOWER(COALESCE(location, '')) LIKE '%site%' THEN 'field'
      WHEN LOWER(COALESCE(location, '')) LIKE '%lost%' OR LOWER(COALESCE(location, '')) LIKE '%write-off%' OR LOWER(COALESCE(location, '')) LIKE '%writeoff%' THEN 'writeoff'
      ELSE locationType
    END
    WHERE (locationType IS NULL OR locationType = '') AND COALESCE(location, '') <> ''`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS startDate TEXT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS endDate TEXT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status TEXT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS location TEXT`);
  await runAsync(`ALTER TABLE vehicle_assets ADD COLUMN IF NOT EXISTS consumptionLocationId TEXT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notes TEXT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS materialsReadyNotifiedAt BIGINT`);
  await runAsync(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updatedAt BIGINT`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS jobId TEXT`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS code TEXT`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS name TEXT`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS supplierId TEXT`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS qtyRequired NUMERIC DEFAULT 0`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS qtyOrdered NUMERIC DEFAULT 0`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS qtyAllocated NUMERIC DEFAULT 0`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS qtyReceived NUMERIC DEFAULT 0`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS notes TEXT`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS sortOrder INTEGER DEFAULT 0`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS createdAt BIGINT`);
  await runAsync(`ALTER TABLE job_materials ADD COLUMN IF NOT EXISTS updatedAt BIGINT`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact TEXT`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS email TEXT`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS phone TEXT`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS orderMethod TEXT`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS websiteUrl TEXT`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS orderUrl TEXT`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS leadTime JSONB`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS moq NUMERIC`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS notes TEXT`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS createdAt BIGINT`);
  await runAsync(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updatedAt BIGINT`);
  await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS emailVerified BOOLEAN`);
  await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS emailVerifiedAt BIGINT`);
  await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invitedAt BIGINT`);
  await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notificationPrefs JSONB`);
  await runAsync(`ALTER TABLE inventory_counts ADD COLUMN IF NOT EXISTS tenantId TEXT REFERENCES tenants(id) DEFAULT 'default'`);
  await runAsync(`UPDATE items SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE items SET category=$1 WHERE category IS NULL OR category=''`, [DEFAULT_CATEGORY_NAME]);
  await runAsync(`UPDATE categories SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE inventory SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE jobs SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE jobs SET startDate = scheduleDate WHERE startDate IS NULL AND scheduleDate IS NOT NULL`);
  await runAsync(`UPDATE jobs SET status = 'planned' WHERE status IS NULL OR status = ''`);
  await runAsync(`UPDATE jobs SET updatedAt = COALESCE(updatedAt, $1::bigint)`, [Date.now()]);
  await runAsync(`UPDATE job_materials SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE job_materials SET qtyRequired = COALESCE(qtyRequired, 0)`);
  await runAsync(`UPDATE job_materials SET qtyOrdered = COALESCE(qtyOrdered, 0)`);
  await runAsync(`UPDATE job_materials SET qtyAllocated = COALESCE(qtyAllocated, 0)`);
  await runAsync(`UPDATE job_materials SET qtyReceived = COALESCE(qtyReceived, 0)`);
  await runAsync(`UPDATE job_materials SET createdAt = COALESCE(createdAt, $1::bigint) WHERE createdAt IS NULL`, [Date.now()]);
  await runAsync(`UPDATE job_materials SET updatedAt = COALESCE(updatedAt, createdAt, $1::bigint) WHERE updatedAt IS NULL`, [Date.now()]);
  await runAsync(`UPDATE suppliers SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE suppliers SET createdAt = COALESCE(createdAt, $1::bigint) WHERE createdAt IS NULL`, [Date.now()]);
  await runAsync(`UPDATE suppliers SET updatedAt = COALESCE(updatedAt, createdAt, $1::bigint) WHERE updatedAt IS NULL`, [Date.now()]);
  await runAsync(`UPDATE users SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE users SET emailVerified=true WHERE emailVerified IS NULL`);
  await runAsync(`UPDATE inventory_counts SET tenantId='default' WHERE tenantId IS NULL`);
  await runAsync(`UPDATE tenants SET status = 'active' WHERE status IS NULL OR status = ''`);
  await runAsync(`UPDATE tenants SET plan = 'starter' WHERE plan IS NULL OR plan = ''`);
  await runAsync(`UPDATE tenants SET updatedAt = COALESCE(updatedAt, createdAt, $1::bigint)`, [Date.now()]);
  initDbPhase = 'tenant-defaults';
  const tenants = await allAsync('SELECT id FROM tenants', []);
  for (const tenant of tenants) {
    await ensureDefaultCategory(tenant.id);
    await ensureTenantCapabilities(tenant.id);
  }
  initDbPhase = 'indexes-and-audit';
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_code ON inventory(code)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_job ON inventory(jobId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_source ON inventory(sourceType, sourceId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_items_tenant ON items(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_suppliers_tenant ON suppliers(tenantId)');
  await runAsync('CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_tenant_name ON suppliers(tenantId, LOWER(name))');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_job_materials_tenant_job ON job_materials(tenantId, jobId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_job_materials_tenant_code_job ON job_materials(tenantId, code, jobId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_tenant ON inventory(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_tenant_ts ON inventory(tenantId, ts DESC)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_tenant_type_ts ON inventory(tenantId, type, ts DESC)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_tenant_code_ts ON inventory(tenantId, code, ts DESC)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_tenant_job_ts ON inventory(tenantId, jobId, ts DESC)');
  await runAsync('CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_locations_tenant_ref ON inventory_locations(tenantId, ref)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inventory_locations_tenant_parent ON inventory_locations(tenantId, parentId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_counts_tenant ON inventory_counts(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_counts_tenant_code_countedat ON inventory_counts(tenantId, code, countedAt DESC)');
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
  await runAsync(`CREATE TABLE IF NOT EXISTS inbound_webhook_endpoints(
    id TEXT PRIMARY KEY,
    tenantId TEXT REFERENCES tenants(id),
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    secret TEXT NOT NULL,
    isActive BOOLEAN DEFAULT true,
    notes TEXT,
    createdAt BIGINT,
    updatedAt BIGINT,
    lastReceivedAt BIGINT
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS inbound_webhook_events(
    id TEXT PRIMARY KEY,
    endpointId TEXT REFERENCES inbound_webhook_endpoints(id) ON DELETE CASCADE,
    tenantId TEXT REFERENCES tenants(id),
    source TEXT,
    eventType TEXT,
    externalId TEXT,
    payload JSONB,
    headers JSONB,
    status TEXT,
    receivedAt BIGINT
  )`);
  await runAsync('CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_events(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inbound_webhook_endpoints_tenant ON inbound_webhook_endpoints(tenantId)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inbound_webhook_events_tenant_received ON inbound_webhook_events(tenantId, receivedAt DESC)');
  await runAsync('CREATE INDEX IF NOT EXISTS idx_inbound_webhook_events_endpoint_received ON inbound_webhook_events(endpointId, receivedAt DESC)');
  // Multi-tenant safety: unique per tenant and FKs
  initDbPhase = 'constraints-and-backfills';
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
  await runAsync('ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_code_fkey');
  await runAsync('ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_code_fk');
  await runAsync('ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_jobid_fkey');
  await runAsync('ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_jobid_fk');
  await runAsync('ALTER TABLE inventory_counts DROP CONSTRAINT IF EXISTS inventory_counts_code_fk');
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

  initDbPhase = 'seed-admin';
  const row = await getAsync('SELECT COUNT(*) as c FROM users');
  if (row?.c === 0) {
    const tenantId = 'default';
    const pwd = 'ChangeMe123!';
    const { salt, hash } = await hashPassword(pwd);
    const user = {
      id: newId(),
      email: 'admin@example.com',
      name: 'Admin',
      role: 'admin',
      salt,
      hash,
      createdAt: Date.now(),
      tenantId,
      emailVerified: true,
      emailVerifiedAt: Date.now()
    };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,emailVerified,emailVerifiedAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.emailVerified, user.emailVerifiedAt, user.tenantId]);
    console.log('Seeded default tenant + admin: admin@example.com / ChangeMe123! (change after login).');
  }
  initDbPhase = 'ensure-dev-account';
  await ensureDevAccount();
  initDbPhase = 'complete';
}

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

async function calcAvailabilityAtLocationTx(client, code, { location, locationRef }, tenantIdVal) {
  const normalizedRef = String(locationRef || '').trim();
  const normalizedLocation = String(location || '').trim();
  const wantsUnspecified = isUnspecifiedInventoryLocation(normalizedLocation) || isUnspecifiedInventoryLocation(normalizedRef);
  const rows = await client.query(
    `SELECT type, qty, location, locationRef FROM inventory WHERE code=$1 AND tenantId=$2 FOR UPDATE`,
    [code, tenantIdVal]
  );
  return (rows.rows || []).reduce((sum, row) => {
    const rowRef = String(row.locationref || row.locationRef || '').trim();
    const rowLocation = String(row.location || '').trim();
    const matches = wantsUnspecified
      ? (!rowRef && !rowLocation)
      : normalizedRef
        ? (rowRef === normalizedRef || rowLocation === normalizedLocation)
        : rowLocation === normalizedLocation;
    if (!matches) return sum;
    const type = row.type;
    const qty = Number(row.qty) || 0;
    if (type === 'in' || type === 'return' || type === 'reserve_release') return sum + qty;
    if (type === 'reserve' || type === 'out' || type === 'consume') return sum - qty;
    return sum;
  }, 0);
}

async function calcOnHandTx(client, code, tenantIdVal) {
  const rows = await client.query(
    `SELECT id,type,qty FROM inventory WHERE code = $1 AND tenantId=$2 FOR UPDATE`,
    [code, tenantIdVal]
  );
  return (rows.rows || []).reduce((sum, r) => {
    const t = r.type;
    const q = Number(r.qty) || 0;
    if (t === 'in' || t === 'return') return sum + q;
    if (t === 'out' || t === 'consume') return sum - q;
    return sum;
  }, 0);
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
async function calcPrimaryReservedLocationTx(client, code, jobId, tenantIdVal) {
  if (!jobId) return { location: null, locationType: null, locationRef: null };
  const rows = await client.query(
    `SELECT location, locationType, locationRef, type, qty, ts
     FROM inventory
     WHERE code=$1 AND tenantId=$2 AND jobId=$3 AND type IN ('reserve','reserve_release')
     ORDER BY ts DESC`,
    [code, tenantIdVal, jobId]
  );
  const totals = new Map();
  for (const row of rows.rows || []) {
    const key = [row.location || '', row.locationtype || row.locationType || '', row.locationref || row.locationRef || ''].join('|');
    const current = totals.get(key) || {
      location: row.location || null,
      locationType: row.locationtype || row.locationType || null,
      locationRef: row.locationref || row.locationRef || null,
      qty: 0
    };
    const qty = Number(row.qty || 0) || 0;
    current.qty += row.type === 'reserve' ? qty : -qty;
    totals.set(key, current);
  }
  const active = Array.from(totals.values())
    .filter((entry) => entry.qty > 0)
    .sort((a, b) => b.qty - a.qty);
  return active[0] || { location: null, locationType: null, locationRef: null };
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
function readInventoryRequestKey(req) {
  return String(
    req.body?.requestKey
    || req.body?.requestId
    || req.body?.clientRequestId
    || req.get('x-request-id')
    || ''
  ).trim().slice(0, 160);
}
function withRequestKeyMeta(sourceMeta, requestKey, operation) {
  if (!requestKey) return sourceMeta || null;
  const base = sourceMeta && typeof sourceMeta === 'object' ? { ...sourceMeta } : {};
  base.requestKey = requestKey;
  if (operation && !base.operation) base.operation = operation;
  return base;
}
async function lockInventoryRequestTx(client, tenantIdVal, requestKey) {
  if (!requestKey) return;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tenantIdVal}:${requestKey}`]);
}
async function findInventoryEventsByRequestKeyTx(client, tenantIdVal, requestKey) {
  if (!requestKey) return [];
  const rows = await client.query(
    `SELECT * FROM inventory
     WHERE tenantId=$1
       AND COALESCE(sourceMeta->>'requestKey','')=$2
     ORDER BY ts ASC, id ASC`,
    [tenantIdVal, requestKey]
  );
  return rows.rows || [];
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
  if (String(source.status || '').toLowerCase() === 'cancelled') return null;
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
  await ensureTenantCapabilities(tenantId);
  const { salt, hash } = await hashPassword(DEV_PASSWORD);
  await runAsync(`INSERT INTO users(id,email,name,role,salt,hash,createdAt,emailVerified,emailVerifiedAt,tenantId)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (email, tenantId) DO UPDATE SET role='dev', salt=EXCLUDED.salt, hash=EXCLUDED.hash, name=EXCLUDED.name, emailVerified=true, emailVerifiedAt=EXCLUDED.emailVerifiedAt`,
    [newId(), normalizeEmail(DEV_EMAIL), 'Dev', 'dev', salt, hash, Date.now(), true, Date.now(), tenantId]);
}

async function processInventoryEvent(client, { type, code, name, category, unitPrice, qty, location, locationType, locationRef, jobId, notes, reason, ts, returnDate, userEmail, userName, tenantIdVal, requireRecentReturn, returnWindowDays, sourceType, sourceId, sourceMeta, consumeAgainstOnHand }) {
  const qtyNum = Number(qty);
  if (!code || !qtyNum || qtyNum <= 0) throw new Error('code and positive qty required');
  const jobIdVal = (jobId || '').trim() || null;
  const item = await ensureItem(client, { code, name, category, unitPrice, tenantIdVal });
  const nowTs = ts || Date.now();
  let status = statusForType(type);
  const normalizedLocationType = normalizeInventoryLocationType(locationType) || inferInventoryLocationType(location);
  const normalizedLocation = normalizeInventoryLocationLabel(location, normalizedLocationType);
  const normalizedLocationRef = String(locationRef || '').trim() || null;

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
        const releaseLocation = normalizedLocation
          ? {
              location: normalizedLocation,
              locationType: normalizedLocationType || null,
              locationRef: normalizedLocationRef
            }
          : await calcPrimaryReservedLocationTx(client, code, jobIdVal, tenantIdVal);
        await client.query(`INSERT INTO inventory(id,code,name,qty,location,locationType,locationRef,jobId,notes,ts,type,status,userEmail,userName,tenantId)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            newId(),
            code,
            item?.name || name || code,
            releaseQty,
            releaseLocation.location || null,
            releaseLocation.locationType || null,
            releaseLocation.locationRef || null,
            jobIdVal,
            'auto-release on checkout',
            nowTs,
            'reserve_release',
            statusForType('reserve_release'),
            userEmail,
            userName,
            tenantIdVal
          ]);
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
    const availableQty = consumeAgainstOnHand
      ? await calcOnHandTx(client, code, tenantIdVal)
      : await calcAvailabilityTx(client, code, tenantIdVal);
    if (qtyNum > availableQty) {
      throw new Error(consumeAgainstOnHand ? 'insufficient stock on hand to adjust' : 'insufficient stock to consume');
    }
  }

  const entry = {
    id: newId(),
    code,
    name: item?.name || name,
    qty: qtyNum,
    location: normalizedLocation || null,
    locationType: normalizedLocationType || null,
    locationRef: normalizedLocationRef,
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
  await client.query(`INSERT INTO inventory(id,code,name,qty,location,locationType,locationRef,jobId,notes,reason,returnDate,ts,type,status,userEmail,userName,tenantId,sourceType,sourceId,sourceMeta)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [entry.id, entry.code, entry.name, entry.qty, entry.location, entry.locationType, entry.locationRef, entry.jobId, entry.notes, entry.reason, entry.returnDate, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName, entry.tenantId, entry.sourceType, entry.sourceId, entry.sourceMeta]);
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

app.get('/api/inventory-locations', async (req, res) => {
  try {
    const rows = await listInventoryLocations(tenantId(req));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/locations', requireRole('admin'), async (req, res) => {
  try {
    const rows = await listManagedInventoryLocations(tenantId(req));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.post('/api/locations', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const payload = normalizeInventoryLocationInput(req.body || {});
    if (!payload.name) return res.status(400).json({ error: 'name required' });
    if (!payload.type) return res.status(400).json({ error: 'valid type required' });
    if (!payload.ref) return res.status(400).json({ error: 'reference required' });
    if (await getInventoryLocationByRef(payload.ref, t)) return res.status(400).json({ error: 'location reference already exists' });
    await assertInventoryLocationHierarchy({ tenantIdVal: t, parentId: payload.parentId });
    const now = Date.now();
    const row = {
      id: buildInventoryLocationId(t, payload.ref),
      ...payload,
      tenantId: t,
      createdAt: now,
      updatedAt: now
    };
    await runAsync(
      `INSERT INTO inventory_locations(id,ref,name,type,parentId,sortOrder,isActive,isConsumptionPoint,notes,tenantId,createdAt,updatedAt)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.id, row.ref, row.name, row.type, row.parentId, row.sortOrder, row.isActive, row.isConsumptionPoint, row.notes, row.tenantId, row.createdAt, row.updatedAt]
    );
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'locations.create', details: { location: row.name, ref: row.ref, type: row.type, parentId: row.parentId, isConsumptionPoint: row.isConsumptionPoint } });
    const rows = await listManagedInventoryLocations(t);
    const created = rows.find((entry) => entry.id === row.id) || row;
    res.status(201).json(created);
  } catch (e) {
    res.status(400).json({ error: e.message || 'unable to create location' });
  }
});

app.patch('/api/locations/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const existing = await getInventoryLocationById(req.params.id, t);
    if (!existing) return res.status(404).json({ error: 'location not found' });
    const payload = normalizeInventoryLocationInput({ ...existing, ...req.body });
    if (!payload.name) return res.status(400).json({ error: 'name required' });
    if (!payload.type) return res.status(400).json({ error: 'valid type required' });
    if (!payload.ref) return res.status(400).json({ error: 'reference required' });
    const refOwner = await getInventoryLocationByRef(payload.ref, t);
    if (refOwner && refOwner.id !== existing.id) return res.status(400).json({ error: 'location reference already exists' });
    await assertInventoryLocationHierarchy({ tenantIdVal: t, locationId: existing.id, parentId: payload.parentId });
    if (payload.ref !== existing.ref) {
      const usage = await getAsync(
        `SELECT COUNT(*)::int AS count FROM inventory
         WHERE tenantId=$1 AND (locationRef=$2 OR (location=$3 AND COALESCE(locationRef,'')=''))`,
        [t, existing.ref, existing.name]
      );
      if (Number(usage?.count || 0) > 0) {
        return res.status(400).json({ error: 'cannot change reference after the location has been used' });
      }
    }
    await runAsync(
      `UPDATE inventory_locations
       SET ref=$1, name=$2, type=$3, parentId=$4, sortOrder=$5, isActive=$6, isConsumptionPoint=$7, notes=$8, updatedAt=$9
       WHERE id=$10 AND tenantId=$11`,
      [payload.ref, payload.name, payload.type, payload.parentId, payload.sortOrder, payload.isActive, payload.isConsumptionPoint, payload.notes, Date.now(), existing.id, t]
    );
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'locations.update', details: { location: payload.name, ref: payload.ref, type: payload.type, parentId: payload.parentId, isConsumptionPoint: payload.isConsumptionPoint } });
    const rows = await listManagedInventoryLocations(t);
    const updated = rows.find((entry) => entry.id === existing.id);
    res.json(updated || { ...existing, ...payload });
  } catch (e) {
    res.status(400).json({ error: e.message || 'unable to update location' });
  }
});

app.delete('/api/locations/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const existing = await getInventoryLocationById(req.params.id, t);
    if (!existing) return res.status(404).json({ error: 'location not found' });
    const child = await getAsync('SELECT id FROM inventory_locations WHERE tenantId=$1 AND parentId=$2 LIMIT 1', [t, existing.id]);
    if (child) return res.status(400).json({ error: 'move or delete child locations first' });
    const usage = await getAsync(
      `SELECT COUNT(*)::int AS count FROM inventory
       WHERE tenantId=$1 AND (locationRef=$2 OR (location=$3 AND COALESCE(locationRef,'')=''))`,
      [t, existing.ref, existing.name]
    );
    if (Number(usage?.count || 0) > 0) return res.status(400).json({ error: 'location is already used in inventory history' });
    await runAsync('DELETE FROM inventory_locations WHERE id=$1 AND tenantId=$2', [existing.id, t]);
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'locations.delete', details: { location: existing.name, ref: existing.ref, type: existing.type } });
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(400).json({ error: e.message || 'unable to delete location' });
  }
});

app.post('/api/inventory', async (req, res) => {
  try {
    const { code, name, category, unitPrice, qty, location, locationType, locationRef, jobId, notes, ts, sourceType, sourceId, reassignReason } = req.body;
    const qtyNum = Number(qty);
    if (!sourceType || !sourceId) return res.status(400).json({ error: 'sourceType and sourceId required' });
    if (!['order','purchase'].includes(sourceType)) return res.status(400).json({ error: 'invalid sourceType' });
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const requestKey = readInventoryRequestKey(req);
    let materialsReadyNotification = null;
    let lowStockNotifications = [];
    let deduped = false;
    const entry = await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const existing = (await findInventoryEventsByRequestKeyTx(client, t, requestKey))
          .find((row) => row.type === 'in');
        if (existing) {
          deduped = true;
          return existing;
        }
      }
      const source = await loadSourceEvent(client, sourceType, sourceId, t);
      if (!source) throw new Error('source not found');
      if (source.code !== code) throw new Error('source item mismatch');
      const sourceMeta = source?.sourcemeta || source?.sourceMeta || null;
      const autoReserve = sourceMeta?.autoReserve !== false;
      const jobMaterialId = sourceMeta?.jobMaterialId || null;
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
        locationType,
        locationRef,
        jobId: jobIdVal,
        notes,
        ts,
        userEmail: actor.userEmail,
        userName: actor.userName,
        tenantIdVal: t,
        sourceType,
        sourceId,
        sourceMeta: withRequestKeyMeta(null, requestKey, 'checkin')
      });
      await changeJobMaterialQtyTx(client, t, jobIdVal, jobMaterialId, 'qtyReceived', qtyNum);
      // If a project is selected, auto-reserve the same qty to earmark stock for that project.
      if (jobIdVal && autoReserve && categoryInfo.rules.allowReserve !== false) {
        const avail = await calcAvailabilityTx(client, code, t);
        const reserveQty = Math.min(qtyNum, Math.max(0, avail));
        if (reserveQty > 0) {
          await processInventoryEvent(client, { type: 'reserve', code, jobId: jobIdVal, qty: reserveQty, location, locationType, locationRef, returnDate: null, notes: 'auto-reserve on check-in', ts: checkin.ts, userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t });
          await changeJobMaterialQtyTx(client, t, jobIdVal, jobMaterialId, 'qtyAllocated', reserveQty);
        }
      }
      materialsReadyNotification = await markJobMaterialsReadyTransitionTx(client, t, jobIdVal);
      lowStockNotifications = await collectLowStockTransitionsTx(client, t, [code]);
      return checkin;
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.in', details: { code, qty, jobId, location, sourceType, sourceId } });
    if (materialsReadyNotification) await sendProjectMaterialsReadyEmails(materialsReadyNotification);
    if (lowStockNotifications.length) await sendLowStockAlertEmails({ tenantId: t, items: lowStockNotifications });
    res.status(deduped ? 200 : 201).json({ ...entry, deduped, requestKey: requestKey || null });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

app.post('/api/inventory-checkout', async (req, res) => {
  try {
    const { code, jobId, qty, reason, notes, ts, location, locationType, locationRef } = req.body;
    const t = tenantId(req);
    const actor = actorInfo(req);
    const requestKey = readInventoryRequestKey(req);
    let lowStockNotifications = [];
    let deduped = false;
    const entry = await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const existing = (await findInventoryEventsByRequestKeyTx(client, t, requestKey))
          .find((row) => row.type === 'out');
        if (existing) {
          deduped = true;
          return existing;
        }
      }
      const { rules } = await getItemCategoryRulesTx(client, t, code);
      enforceCategoryRules(rules, { action: 'checkout', jobId, notes: notes || reason, qty });
      const tsNow = ts || Date.now();
      const due = tsNow + getReturnWindowMs(rules);
      const result = await processInventoryEvent(client, { type: 'out', code, jobId, qty, reason, notes, location, locationType, locationRef, ts: tsNow, returnDate: new Date(due).toISOString(), userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t, sourceMeta: withRequestKeyMeta(null, requestKey, 'checkout') });
      lowStockNotifications = await collectLowStockTransitionsTx(client, t, [code]);
      return result;
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.out', details: { code, qty, jobId } });
    if (lowStockNotifications.length) await sendLowStockAlertEmails({ tenantId: t, items: lowStockNotifications });
    res.status(deduped ? 200 : 201).json({ ...entry, deduped, requestKey: requestKey || null });
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
    const { code, jobId, qty, returnDate, notes, ts, jobMaterialId, location, locationType, locationRef } = req.body;
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const requestKey = readInventoryRequestKey(req);
    let lowStockNotifications = [];
    let deduped = false;
    const entry = await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const existing = (await findInventoryEventsByRequestKeyTx(client, t, requestKey))
          .find((row) => row.type === 'reserve');
        if (existing) {
          deduped = true;
          return existing;
        }
      }
      const { rules } = await getItemCategoryRulesTx(client, t, code);
      enforceCategoryRules(rules, { action: 'reserve', jobId, notes, qty });
      const ev = await processInventoryEvent(client, { type: 'reserve', code, jobId, qty, returnDate, notes, location, locationType, locationRef, ts, userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t, sourceMeta: withRequestKeyMeta(null, requestKey, 'reserve') });
      await changeJobMaterialQtyTx(client, t, normalizeJobId(jobId), jobMaterialId, 'qtyAllocated', Number(qty));
      lowStockNotifications = await collectLowStockTransitionsTx(client, t, [code]);
      return ev;
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.reserve', details: { code, qty, jobId, returnDate } });
    if (lowStockNotifications.length) await sendLowStockAlertEmails({ tenantId: t, items: lowStockNotifications });
    res.status(deduped ? 200 : 201).json({ ...entry, deduped, requestKey: requestKey || null });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

// Bulk reserve to minimize clicks (admin only)
app.post('/api/inventory-reserve/bulk', requireRole('admin'), async (req, res) => {
  try {
    const { jobId, returnDate, notes, lines, location, locationType, locationRef } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const entries = Array.isArray(lines) ? lines : [];
    if (!entries.length) return res.status(400).json({ error: 'lines array required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const requestKey = readInventoryRequestKey(req);
    const results = [];
    let lowStockNotifications = [];
    let deduped = false;
    await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const existing = (await findInventoryEventsByRequestKeyTx(client, t, requestKey))
          .filter((row) => row.type === 'reserve');
        if (existing.length) {
          deduped = true;
          results.push(...existing);
          return;
        }
      }
      for (const line of entries) {
        const code = (line?.code || '').trim();
        const qty = Number(line?.qty || 0);
        if (!code || qty <= 0) throw new Error(`Invalid line for code ${code || ''}`);
        const { rules } = await getItemCategoryRulesTx(client, t, code);
        enforceCategoryRules(rules, { action: 'reserve', jobId, notes, qty });
        const ev = await processInventoryEvent(client, { type: 'reserve', code, jobId, qty, returnDate, notes, location: line?.location || location, locationType: line?.locationType || locationType, locationRef: line?.locationRef || locationRef, ts: line?.ts || Date.now(), userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t, sourceMeta: withRequestKeyMeta(null, requestKey, 'reserve-bulk') });
        await changeJobMaterialQtyTx(client, t, normalizeJobId(jobId), line?.jobMaterialId || null, 'qtyAllocated', qty);
        results.push(ev);
      }
      lowStockNotifications = await collectLowStockTransitionsTx(client, t, entries.map((line) => line?.code));
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.reserve', details: { lines: results.length, jobId } });
    if (lowStockNotifications.length) await sendLowStockAlertEmails({ tenantId: t, items: lowStockNotifications });
    res.status(deduped ? 200 : 201).json({ count: results.length, reserves: results, deduped, requestKey: requestKey || null });
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
    const requestKey = readInventoryRequestKey(req);
    let lowStockNotifications = [];
    const fromId = normalizeJobId(fromJobId);
    const toId = normalizeJobId(toJobId);
    let deduped = false;
    const result = await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const existing = await findInventoryEventsByRequestKeyTx(client, t, requestKey);
        const releaseExisting = existing.find((row) => row.type === 'reserve_release');
        if (releaseExisting) {
          deduped = true;
          return {
            release: releaseExisting,
            reserve: existing.find((row) => row.type === 'reserve') || null
          };
        }
      }
      const { rules } = await getItemCategoryRulesTx(client, t, code);
      enforceCategoryRules(rules, { action: 'reserve', jobId: fromId, notes: reason, qty: qtyNum });
      const reserved = await calcReservedOutstandingTx(client, code, fromId, t);
      if (qtyNum > reserved) throw new Error('reassign exceeds reserved qty');
      const primaryLocation = await calcPrimaryReservedLocationTx(client, code, fromId, t);
      const release = await processInventoryEvent(client, { type: 'reserve_release', code, jobId: fromId, qty: qtyNum, location: primaryLocation.location, locationType: primaryLocation.locationType, locationRef: primaryLocation.locationRef, notes: `reassign: ${reason}`, ts: Date.now(), userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t, sourceMeta: withRequestKeyMeta(null, requestKey, 'reassign') });
      let reserve = null;
      if (toId) {
        reserve = await processInventoryEvent(client, { type: 'reserve', code, jobId: toId, qty: qtyNum, location: release.location, locationType: release.locationType, locationRef: release.locationRef, notes: `reassign: ${reason}`, ts: release.ts, userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t, sourceMeta: withRequestKeyMeta(null, requestKey, 'reassign') });
      }
      lowStockNotifications = await collectLowStockTransitionsTx(client, t, [code]);
      return { release, reserve };
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.reserve', details: { code, qty: qtyNum, fromJobId, toJobId, reason } });
    if (lowStockNotifications.length) await sendLowStockAlertEmails({ tenantId: t, items: lowStockNotifications });
    res.status(deduped ? 200 : 201).json({ ...result, deduped, requestKey: requestKey || null });
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
    const { code, jobId, qty, reason, location, locationType, locationRef, notes, ts } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const requestKey = readInventoryRequestKey(req);
    let lowStockNotifications = [];
    let deduped = false;
    const entry = await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const existing = (await findInventoryEventsByRequestKeyTx(client, t, requestKey))
          .find((row) => row.type === 'return');
        if (existing) {
          deduped = true;
          return existing;
        }
      }
      const resolvedJobId = await resolveReturnJobIdTx(client, code, t, jobId);
      const { rules } = await getItemCategoryRulesTx(client, t, code);
      enforceCategoryRules(rules, { action: 'return', jobId: resolvedJobId, location, notes: notes || reason, qty });
      const ev = await processInventoryEvent(client, { type: 'return', code, jobId: resolvedJobId, qty, reason, location, locationType, locationRef, notes, ts, userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t, requireRecentReturn: true, returnWindowDays: rules.returnWindowDays, sourceMeta: withRequestKeyMeta(null, requestKey, 'return') });
      lowStockNotifications = await collectLowStockTransitionsTx(client, t, [code]);
      return ev;
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.return', details: { code, qty, jobId: entry.jobId || null, reason } });
    if (lowStockNotifications.length) await sendLowStockAlertEmails({ tenantId: t, items: lowStockNotifications });
    res.status(deduped ? 200 : 201).json({ ...entry, deduped, requestKey: requestKey || null });
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

app.post('/api/inventory-counts', requireRole('admin'), async (req, res) => {
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
    const { code, qty, reason, notes, ts, location, locationType, locationRef } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const requestKey = readInventoryRequestKey(req);
    let lowStockNotifications = [];
    let deduped = false;
    const entry = await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const existing = (await findInventoryEventsByRequestKeyTx(client, t, requestKey)).find((row) => row.type === 'consume');
        if (existing) {
          deduped = true;
          return existing;
        }
      }
      const ev = await processInventoryEvent(client, { type: 'consume', code, qty, reason, notes, location, locationType, locationRef, ts, userEmail: actor.userEmail, userName: actor.userName, tenantIdVal: t, sourceMeta: withRequestKeyMeta(null, requestKey, 'consume') });
      lowStockNotifications = await collectLowStockTransitionsTx(client, t, [code]);
      return ev;
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.out', details: { code, qty, reason } });
    if (lowStockNotifications.length) await sendLowStockAlertEmails({ tenantId: t, items: lowStockNotifications });
    res.status(deduped ? 200 : 201).json({ ...entry, deduped, requestKey: requestKey || null });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

app.post('/api/inventory-adjust', requireRole('admin'), async (req, res) => {
  try {
    const { code, delta, reason, notes, location, locationType, locationRef, ts } = req.body || {};
    const qtyNum = Math.abs(Number(delta));
    if (!code || !Number.isFinite(qtyNum) || qtyNum <= 0) return res.status(400).json({ error: 'code and non-zero delta required' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason required' });
    const deltaNum = Number(delta);
    const t = tenantId(req);
    const actor = actorInfo(req);
    const requestKey = readInventoryRequestKey(req);
    let lowStockNotifications = [];
    let deduped = false;
    const entry = await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const expectedType = deltaNum > 0 ? 'in' : 'consume';
        const existing = (await findInventoryEventsByRequestKeyTx(client, t, requestKey)).find((row) => row.type === expectedType);
        if (existing) {
          deduped = true;
          return existing;
        }
      }
      if (deltaNum > 0) {
        const categoryInfo = await getItemCategoryRulesTx(client, t, code);
        const adjustmentNotes = [`Adjustment: ${String(reason).trim()}`];
        if (notes && String(notes).trim()) adjustmentNotes.push(String(notes).trim());
        enforceCategoryRules(categoryInfo.rules, { action: 'checkin', jobId: null, location, notes: adjustmentNotes.join(' | '), qty: qtyNum });
        const ev = await processInventoryEvent(client, {
          type: 'in',
          code,
          qty: qtyNum,
          location,
          locationType,
          locationRef,
          notes: adjustmentNotes.join(' | '),
          ts,
          userEmail: actor.userEmail,
          userName: actor.userName,
          tenantIdVal: t,
          sourceMeta: withRequestKeyMeta(null, requestKey, 'adjust')
        });
        lowStockNotifications = await collectLowStockTransitionsTx(client, t, [code]);
        return ev;
      }
      const ev = await processInventoryEvent(client, {
        type: 'consume',
        code,
        qty: qtyNum,
        location,
        locationType,
        locationRef,
        reason: String(reason).trim(),
        notes,
        ts,
        userEmail: actor.userEmail,
        userName: actor.userName,
        tenantIdVal: t,
        consumeAgainstOnHand: true,
        sourceMeta: withRequestKeyMeta(null, requestKey, 'adjust')
      });
      lowStockNotifications = await collectLowStockTransitionsTx(client, t, [code]);
      return ev;
    });
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'inventory.adjust',
      details: { code, delta: deltaNum, qty: qtyNum, reason, location: location || null }
    });
    if (lowStockNotifications.length) await sendLowStockAlertEmails({ tenantId: t, items: lowStockNotifications });
    res.status(deduped ? 200 : 201).json({ ...entry, deduped, requestKey: requestKey || null });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.post('/api/inventory-transfer', requireRole('admin'), async (req, res) => {
  try {
    const {
      code,
      qty,
      reason,
      notes,
      fromLocation,
      fromLocationType,
      fromLocationRef,
      toLocation,
      toLocationType,
      toLocationRef,
      ts
    } = req.body || {};
    const qtyNum = Number(qty);
    if (!code || !Number.isFinite(qtyNum) || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason required' });
    const normalizedFromType = normalizeInventoryLocationType(fromLocationType) || inferInventoryLocationType(fromLocation);
    const normalizedFromLocation = normalizeInventoryLocationLabel(fromLocation, normalizedFromType);
    const normalizedFromRef = String(fromLocationRef || '').trim() || null;
    const normalizedToType = normalizeInventoryLocationType(toLocationType) || inferInventoryLocationType(toLocation);
    const normalizedToLocation = normalizeInventoryLocationLabel(toLocation, normalizedToType);
    const normalizedToRef = String(toLocationRef || '').trim() || null;
    if (!normalizedFromLocation || !normalizedToLocation) return res.status(400).json({ error: 'source and destination locations required' });
    if ((normalizedFromRef && normalizedToRef && normalizedFromRef === normalizedToRef) || (!normalizedFromRef && !normalizedToRef && normalizedFromLocation === normalizedToLocation)) {
      return res.status(400).json({ error: 'source and destination must be different' });
    }
    const t = tenantId(req);
    const actor = actorInfo(req);
    const requestKey = readInventoryRequestKey(req);
    const transferTs = ts || Date.now();
    const transferId = newId();
    let deduped = false;
    let transferOut = null;
    let transferIn = null;
    await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const existing = await findInventoryEventsByRequestKeyTx(client, t, requestKey);
        transferOut = existing.find((row) => row.type === 'consume' && row.sourcetype === 'transfer') || null;
        transferIn = existing.find((row) => row.type === 'in' && row.sourcetype === 'transfer') || null;
        if (transferOut || transferIn) {
          deduped = true;
          return;
        }
      }
      const availableAtSource = await calcAvailabilityAtLocationTx(
        client,
        code,
        { location: normalizedFromLocation, locationRef: normalizedFromRef },
        t
      );
      if (qtyNum > availableAtSource) throw new Error('insufficient available stock in source location');
      transferOut = await processInventoryEvent(client, {
        type: 'consume',
        code,
        qty: qtyNum,
        reason: 'location transfer',
        notes: [`Transfer out: ${String(reason).trim()}`, notes && String(notes).trim()].filter(Boolean).join(' | '),
        location: normalizedFromLocation,
        locationType: normalizedFromType,
        locationRef: normalizedFromRef,
        ts: transferTs,
        userEmail: actor.userEmail,
        userName: actor.userName,
        tenantIdVal: t,
        sourceType: 'transfer',
        sourceId: transferId,
        sourceMeta: withRequestKeyMeta({
          fromLocation: normalizedFromLocation,
          fromLocationRef: normalizedFromRef,
          toLocation: normalizedToLocation,
          toLocationRef: normalizedToRef
        }, requestKey, 'transfer')
      });
      transferIn = await processInventoryEvent(client, {
        type: 'in',
        code,
        qty: qtyNum,
        location: normalizedToLocation,
        locationType: normalizedToType,
        locationRef: normalizedToRef,
        notes: [`Transfer in: ${String(reason).trim()}`, notes && String(notes).trim()].filter(Boolean).join(' | '),
        ts: transferTs + 1,
        userEmail: actor.userEmail,
        userName: actor.userName,
        tenantIdVal: t,
        sourceType: 'transfer',
        sourceId: transferId,
        sourceMeta: withRequestKeyMeta({
          fromLocation: normalizedFromLocation,
          fromLocationRef: normalizedFromRef,
          toLocation: normalizedToLocation,
          toLocationRef: normalizedToRef
        }, requestKey, 'transfer')
      });
    });
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'inventory.transfer',
      details: {
        code,
        qty: qtyNum,
        reason: String(reason).trim(),
        fromLocation: normalizedFromLocation,
        toLocation: normalizedToLocation
      }
    });
    res.status(deduped ? 200 : 201).json({ ok: true, code, qty: qtyNum, transferOut, transferIn, deduped, requestKey: requestKey || null });
  } catch (e) {
    res.status(400).json({ error: e.message || 'unable to move stock' });
  }
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
    const { code, oldCode, name, category, unitPrice, material, shape, brand, notes, description, tags, lowStockEnabled, uom, serialized, lot, expires, warehouse, zone, bin, reorderPoint, minStock, supplierId, supplierSku, supplierUrl } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const t = tenantId(req);
    const exists = await itemExists(code, t);
    const existingItem = exists
      ? await getAsync('SELECT code, warehouse, zone, bin FROM items WHERE code=$1 AND tenantId=$2', [code, t])
      : null;
    const categoryInfo = await resolveCategoryInput(t, category);
    const normalizedTags = normalizeItemTags(tags);
    const tagsJson = JSON.stringify(normalizedTags);
    const normalizedLowStockEnabled = normalizeItemLowStockEnabled(lowStockEnabled);
    const price = unitPrice === undefined || unitPrice === null || Number.isNaN(Number(unitPrice)) ? null : Number(unitPrice);
    const materialValue = (material || '').trim() || null;
    const shapeValue = (shape || '').trim() || null;
    const brandValue = (brand || '').trim() || null;
    const notesValue = (notes || '').trim() || null;
    const uomValue = (uom || '').trim() || null;
    const warehouseValue = normalizeItemStorageValue(warehouse);
    const zoneValue = normalizeItemStorageValue(zone);
    const binValue = normalizeItemStorageValue(bin);
    const serializedValue = normalizeOptionalBool(serialized);
    const lotValue = normalizeOptionalBool(lot);
    const expiresValue = normalizeOptionalBool(expires);
    const reorderPointValue = Number(reorderPoint);
    const minStockValue = Number(minStock);
    const normalizedReorderPoint = Number.isFinite(reorderPointValue) && reorderPointValue >= 0 ? Math.floor(reorderPointValue) : null;
    const normalizedMinStock = Number.isFinite(minStockValue) && minStockValue >= 0 ? Math.floor(minStockValue) : null;
    const normalizedSupplierId = (supplierId || '').trim() || null;
    const normalizedSupplierSku = (supplierSku || '').trim() || null;
    const normalizedSupplierUrl = normalizeUrl(supplierUrl);
    if (normalizedSupplierId) {
      const supplier = await getAsync('SELECT id FROM suppliers WHERE id=$1 AND tenantId=$2', [normalizedSupplierId, t]);
      if (!supplier) return res.status(400).json({ error: 'invalid supplier' });
    }
    if (oldCode && oldCode !== code) await runAsync('DELETE FROM items WHERE code=$1 AND tenantId=$2', [oldCode, t]);
    await runAsync(`INSERT INTO items(code,name,category,unitPrice,material,shape,brand,notes,uom,serialized,lot,expires,warehouse,zone,bin,reorderPoint,minStock,description,tags,lowStockEnabled,supplierId,supplierSku,supplierUrl,tenantId)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      ON CONFLICT(code,tenantId) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, unitPrice=EXCLUDED.unitPrice, material=EXCLUDED.material, shape=EXCLUDED.shape, brand=EXCLUDED.brand, notes=EXCLUDED.notes, uom=EXCLUDED.uom, serialized=EXCLUDED.serialized, lot=EXCLUDED.lot, expires=EXCLUDED.expires, warehouse=EXCLUDED.warehouse, zone=EXCLUDED.zone, bin=EXCLUDED.bin, reorderPoint=EXCLUDED.reorderPoint, minStock=EXCLUDED.minStock, description=EXCLUDED.description, tags=EXCLUDED.tags, lowStockEnabled=EXCLUDED.lowStockEnabled, supplierId=EXCLUDED.supplierId, supplierSku=EXCLUDED.supplierSku, supplierUrl=EXCLUDED.supplierUrl, tenantId=EXCLUDED.tenantId`,
      [code, name, categoryInfo.name, price, materialValue, shapeValue, brandValue, notesValue, uomValue, serializedValue, lotValue, expiresValue, warehouseValue, zoneValue, binValue, normalizedReorderPoint, normalizedMinStock, description, tagsJson, normalizedLowStockEnabled, normalizedSupplierId, normalizedSupplierSku, normalizedSupplierUrl, t]);
    const auditDetails = exists && itemStorageChanged(existingItem, { warehouse: warehouseValue, zone: zoneValue, bin: binValue })
      ? buildItemStorageAuditDetails(code, existingItem, { warehouse: warehouseValue, zone: zoneValue, bin: binValue })
      : { code };
    await logAudit({ tenantId: t, userId: currentUserId(req), action: exists ? 'items.update' : 'items.create', details: auditDetails });
    res.status(201).json({ code, name, category: categoryInfo.name, unitPrice: price, material: materialValue, shape: shapeValue, brand: brandValue, notes: notesValue, uom: uomValue, serialized: serializedValue, lot: lotValue, expires: expiresValue, warehouse: warehouseValue, zone: zoneValue, bin: binValue, reorderPoint: normalizedReorderPoint, minStock: normalizedMinStock, description, tags: normalizedTags, lowStockEnabled: normalizedLowStockEnabled, supplierId: normalizedSupplierId, supplierSku: normalizedSupplierSku, supplierUrl: normalizedSupplierUrl, tenantId: t });
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
        const supplierId = (raw?.supplierId || '').trim() || null;
        const supplierSku = (raw?.supplierSku || '').trim() || null;
        const supplierUrl = normalizeUrl(raw?.supplierUrl);
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
        const tagsJson = JSON.stringify(tags);
        const lowStockEnabled = normalizeItemLowStockEnabled(raw?.lowStockEnabled);
        await client.query(`INSERT INTO items(code,name,category,unitPrice,material,shape,brand,notes,uom,serialized,lot,expires,warehouse,zone,bin,reorderPoint,minStock,description,tags,lowStockEnabled,supplierId,supplierSku,supplierUrl,tenantId)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
          ON CONFLICT(code,tenantId) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, unitPrice=EXCLUDED.unitPrice, material=EXCLUDED.material, shape=EXCLUDED.shape, brand=EXCLUDED.brand, notes=EXCLUDED.notes, uom=EXCLUDED.uom, serialized=EXCLUDED.serialized, lot=EXCLUDED.lot, expires=EXCLUDED.expires, warehouse=EXCLUDED.warehouse, zone=EXCLUDED.zone, bin=EXCLUDED.bin, reorderPoint=EXCLUDED.reorderPoint, minStock=EXCLUDED.minStock, description=EXCLUDED.description, tags=EXCLUDED.tags, lowStockEnabled=EXCLUDED.lowStockEnabled, supplierId=EXCLUDED.supplierId, supplierSku=EXCLUDED.supplierSku, supplierUrl=EXCLUDED.supplierUrl, tenantId=EXCLUDED.tenantId`,
          [code, name, categoryInfo.name, unitPrice, material, shape, brand, notes, uom, serialized, lot, expires, warehouse, zone, bin, reorderPoint, minStock, description, tagsJson, lowStockEnabled, supplierId, supplierSku, supplierUrl, t]);
        results.push(code);
      }
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'items.update', details: { bulk: results.length } });
    res.status(201).json({ count: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.patch('/api/items/:code', requireRole('admin'), async (req, res) => {
  try {
    const code = req.params.code;
    const t = tenantId(req);
    const item = await getAsync('SELECT * FROM items WHERE code=$1 AND tenantId=$2', [code, t]);
    if (!item) return res.status(404).json({ error: 'item not found' });
    const payload = req.body || {};
    const categoryInfo = await resolveCategoryInput(t, payload.category ?? item.category);
    const normalizedTags = Object.prototype.hasOwnProperty.call(payload, 'tags')
      ? normalizeItemTags(payload.tags)
      : normalizeItemTags(item.tags);
    const normalizedLowStockEnabled = Object.prototype.hasOwnProperty.call(payload, 'lowStockEnabled')
      ? normalizeItemLowStockEnabled(payload.lowStockEnabled)
      : normalizeItemLowStockEnabled(item.lowStockEnabled ?? item.lowstockenabled);
    const updates = {
      name: (payload.name ?? item.name)?.toString().trim(),
      category: categoryInfo.name,
      description: payload.description ?? item.description,
      unitPrice: Object.prototype.hasOwnProperty.call(payload, 'unitPrice')
        ? (payload.unitPrice === '' || payload.unitPrice === null || Number.isNaN(Number(payload.unitPrice)) ? null : Number(payload.unitPrice))
        : (item.unitprice ?? item.unitPrice),
      material: payload.material ?? item.material,
      shape: payload.vendor ?? payload.shape ?? item.shape,
      brand: payload.manufacturer ?? payload.brand ?? item.brand,
      notes: payload.notes ?? item.notes,
      uom: payload.uom ?? item.uom,
      serialized: Object.prototype.hasOwnProperty.call(payload, 'serialized') ? !!payload.serialized : item.serialized,
      lot: Object.prototype.hasOwnProperty.call(payload, 'lot') ? !!payload.lot : item.lot,
      expires: Object.prototype.hasOwnProperty.call(payload, 'expires') ? !!payload.expires : item.expires,
      warehouse: Object.prototype.hasOwnProperty.call(payload, 'warehouse') ? normalizeItemStorageValue(payload.warehouse) : normalizeItemStorageValue(item.warehouse),
      zone: Object.prototype.hasOwnProperty.call(payload, 'zone') ? normalizeItemStorageValue(payload.zone) : normalizeItemStorageValue(item.zone),
      bin: Object.prototype.hasOwnProperty.call(payload, 'bin') ? normalizeItemStorageValue(payload.bin) : normalizeItemStorageValue(item.bin),
      supplierId: payload.supplierId ?? item.supplierid ?? item.supplierId,
      supplierSku: payload.supplierSku ?? item.suppliersku ?? item.supplierSku,
      supplierUrl: Object.prototype.hasOwnProperty.call(payload, 'supplierUrl') ? normalizeUrl(payload.supplierUrl) : (item.supplierurl ?? item.supplierUrl),
      reorderPoint: Object.prototype.hasOwnProperty.call(payload, 'reorderPoint') ? Number(payload.reorderPoint) : item.reorderpoint ?? item.reorderPoint,
      minStock: Object.prototype.hasOwnProperty.call(payload, 'minStock') ? Number(payload.minStock) : item.minstock ?? item.minStock,
      tags: normalizedTags,
      lowStockEnabled: normalizedLowStockEnabled
    };
    if (updates.supplierId) {
      const supplier = await getAsync('SELECT id FROM suppliers WHERE id=$1 AND tenantId=$2', [updates.supplierId, t]);
      if (!supplier) return res.status(400).json({ error: 'invalid supplier' });
    }
    await runAsync(
      `UPDATE items
       SET name=$1, category=$2, description=$3, unitPrice=$4, material=$5, shape=$6, brand=$7, notes=$8,
           uom=$9, serialized=$10, lot=$11, expires=$12, warehouse=$13, zone=$14, bin=$15,
           supplierId=$16, supplierSku=$17, supplierUrl=$18, reorderPoint=$19, minStock=$20, tags=$21, lowStockEnabled=$22
       WHERE code=$23 AND tenantId=$24`,
      [
        updates.name,
        updates.category,
        updates.description,
        updates.unitPrice,
        updates.material,
        updates.shape,
        updates.brand,
        updates.notes,
        updates.uom,
        updates.serialized,
        updates.lot,
        updates.expires,
        updates.warehouse,
        updates.zone,
        updates.bin,
        updates.supplierId || null,
        updates.supplierSku || null,
        updates.supplierUrl || null,
        Number.isFinite(updates.reorderPoint) ? Math.floor(updates.reorderPoint) : null,
        Number.isFinite(updates.minStock) ? Math.floor(updates.minStock) : null,
        JSON.stringify(updates.tags),
        updates.lowStockEnabled,
        code,
        t
      ]
    );
    const auditDetails = itemStorageChanged(item, updates)
      ? buildItemStorageAuditDetails(code, item, updates)
      : { code };
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'items.update',
      details: auditDetails
    });
    res.json({
      ok: true,
      item: {
        code,
        ...updates,
        reorderPoint: Number.isFinite(updates.reorderPoint) ? Math.floor(updates.reorderPoint) : null,
        minStock: Number.isFinite(updates.minStock) ? Math.floor(updates.minStock) : null
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/items/:code/activity', async (req, res) => {
  try {
    const t = tenantId(req);
    const code = req.params.code;
    const rangeDays = Math.min(365, Math.max(1, Number(req.query.range || 30)));
    const type = (req.query.type || '').toString().trim().toLowerCase();
    const search = (req.query.search || '').toString().trim().toLowerCase();
    const project = (req.query.project || '').toString().trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(20, Number(req.query.limit || 50)));
    const startTs = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
    const params = [t, code, startTs];
    let where = 'tenantId=$1 AND code=$2 AND ts >= $3';
    if (project) {
      params.push(project);
      where += ` AND jobId=$${params.length}`;
    }
    if (type) {
      const tParam = type.toLowerCase();
      if (tParam === 'adjust') {
        where += ` AND (type='consume' OR LOWER(status) IN ('damaged','lost','adjusted'))`;
      } else if (tParam === 'count') {
        // handled in counts section
      } else {
        params.push(tParam);
        where += ` AND LOWER(type)=$${params.length}`;
      }
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (LOWER(jobId) LIKE $${params.length} OR LOWER(reason) LIKE $${params.length} OR LOWER(notes) LIKE $${params.length} OR LOWER(userEmail) LIKE $${params.length} OR LOWER(userName) LIKE $${params.length} OR LOWER(sourceId) LIKE $${params.length})`;
    }
    const offset = (page - 1) * limit;
    const invRows = await allAsync(
      `SELECT id, qty, location, jobId, notes, ts, type, status, reason, returnDate, eta, userEmail, userName, sourceType, sourceId
       FROM inventory
       WHERE ${where}
       ORDER BY ts DESC
       LIMIT ${limit + 1} OFFSET ${offset}`,
      params
    );
    let records = invRows.map(row => ({
      id: row.id,
      ts: row.ts,
      type: row.type || '',
      qty: row.qty,
      from: row.sourcetype || row.sourceType || '',
      to: row.location || '',
      jobId: row.jobid || row.jobId || '',
      reason: row.reason || row.status || '',
      userEmail: row.useremail || row.userEmail || row.username || row.userName || '',
      sourceId: row.sourceid || row.sourceId || ''
    }));
    if (!type || type === 'count') {
      const countRows = await allAsync(
        `SELECT id, qty, countedAt, countedBy FROM inventory_counts WHERE tenantId=$1 AND code=$2 AND countedAt >= $3 ORDER BY countedAt DESC`,
        [t, code, startTs]
      );
      const countRecords = countRows.map(r => ({
        id: r.id,
        ts: r.countedat || r.countedAt,
        type: 'count',
        qty: r.qty,
        reason: 'Count',
        userEmail: r.countedby || r.countedBy || ''
      }));
      records = records.concat(countRecords);
      records.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }
    const hasMore = records.length > limit;
    if (hasMore) records = records.slice(0, limit);
    res.json({ records, hasMore });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/items/:code/insights', async (req, res) => {
  try {
    const t = tenantId(req);
    const code = req.params.code;
    const item = await getAsync('SELECT * FROM items WHERE code=$1 AND tenantId=$2', [code, t]);
    if (!item) return res.status(404).json({ error: 'item not found' });
    const categories = await allAsync('SELECT name, rules FROM categories WHERE tenantId=$1', [t]);
    const rulesMap = new Map((categories || []).map(c => [(c.name || '').toLowerCase(), normalizeCategoryRules(c.rules)]));
    const lowStockEnabled = resolveLowStockEnabled(item, rulesMap);
    const entries = await allAsync('SELECT type, qty, ts, status FROM inventory WHERE tenantId=$1 AND code=$2', [t, code]);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const windows = { d7: now - 7 * dayMs, d30: now - 30 * dayMs, d90: now - 90 * dayMs };
    let inQty = 0;
    let outQty = 0;
    let returnQty = 0;
    let reserveQty = 0;
    let reserveRelease = 0;
    let consumeQty = 0;
    let lastMove = 0;
    let usage7 = 0;
    let usage30 = 0;
    let usage90 = 0;
    let adjustments30 = 0;
    entries.forEach(e => {
      const type = (e.type || '').toLowerCase();
      const qty = Number(e.qty || 0) || 0;
      const ts = Number(e.ts || 0) || 0;
      if (type === 'in') inQty += qty;
      if (type === 'out') outQty += qty;
      if (type === 'return') returnQty += qty;
      if (type === 'reserve') reserveQty += qty;
      if (type === 'reserve_release') reserveRelease += qty;
      if (type === 'consume') consumeQty += qty;
      if (['in','out','return','reserve','reserve_release','consume'].includes(type)) {
        lastMove = Math.max(lastMove, ts || 0);
      }
      if (type === 'out' || type === 'consume') {
        if (ts >= windows.d7) usage7 += qty;
        if (ts >= windows.d30) usage30 += qty;
        if (ts >= windows.d90) usage90 += qty;
      }
      if (ts >= windows.d30 && (type === 'consume' || ['damaged','lost','adjusted'].includes((e.status || '').toLowerCase()))) {
        adjustments30 += 1;
      }
    });
    const available = Math.max(0, inQty + returnQty + reserveRelease - outQty - reserveQty - consumeQty);
    const avg7 = Number((usage7 / 7).toFixed(2));
    const avg30 = Number((usage30 / 30).toFixed(2));
    const avg90 = Number((usage90 / 90).toFixed(2));
    const deadStock = !lastMove || lastMove < windows.d90;
    const slowMover = usage90 <= 1;
    const reorderPoint = Number(item.reorderpoint ?? item.reorderPoint);
    const minStock = Number(item.minstock ?? item.minStock);
    const safety = Number.isFinite(minStock) ? minStock : (Number.isFinite(reorderPoint) ? reorderPoint : 0);
    const leadTimeDays = 7;
    const targetStock = Math.max(0, Math.ceil((avg30 * leadTimeDays) + safety));
    const suggestedQty = Math.max(0, targetStock - available);
    res.json({
      velocity: { avg7, avg30, avg90 },
      performance: { available, deadStock, slowMover },
      risk: { stockouts: available <= 0 ? 1 : 0, adjustments: adjustments30 },
      reorder: {
        lowStockEnabled,
        leadTimeDays,
        targetStock,
        suggestedQty
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// SUPPLIERS
app.get('/api/suppliers', async (req, res) => {
  try {
    const rows = await readSuppliers(tenantId(req));
    res.json((rows || []).map(normalizeSupplierRow));
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/suppliers', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const payload = req.body || {};
    const name = String(payload.name || '').trim();
    const rawOrderMethod = String(payload.orderMethod || payload.ordermethod || '').trim().toLowerCase();
    const orderMethod = ['web', 'email', 'phone'].includes(rawOrderMethod) ? rawOrderMethod : null;
    if (!name) return res.status(400).json({ error: 'name required' });
    const existing = await getAsync('SELECT id FROM suppliers WHERE tenantId=$1 AND LOWER(name)=LOWER($2) LIMIT 1', [t, name]);
    if (existing) return res.status(409).json({ error: 'supplier already exists' });
    const now = Date.now();
    const row = {
      id: newId(),
      name,
      contact: String(payload.contact || '').trim() || null,
      email: String(payload.email || '').trim() || null,
      phone: String(payload.phone || '').trim() || null,
      orderMethod,
      websiteUrl: normalizeUrl(payload.websiteUrl),
      orderUrl: normalizeUrl(payload.orderUrl),
      leadTime: payload.leadTime || {},
      moq: payload.moq === '' || payload.moq === null || payload.moq === undefined || Number.isNaN(Number(payload.moq)) ? null : Number(payload.moq),
      notes: String(payload.notes || '').trim() || null,
      tenantId: t,
      createdAt: now,
      updatedAt: now
    };
    await runAsync(
      `INSERT INTO suppliers(id,name,contact,email,phone,orderMethod,websiteUrl,orderUrl,leadTime,moq,notes,tenantId,createdAt,updatedAt)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [row.id, row.name, row.contact, row.email, row.phone, row.orderMethod, row.websiteUrl, row.orderUrl, row.leadTime, row.moq, row.notes, row.tenantId, row.createdAt, row.updatedAt]
    );
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'suppliers.update', details: { id: row.id, name: row.name } });
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.put('/api/suppliers/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const existing = await getAsync('SELECT * FROM suppliers WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    if (!existing) return res.status(404).json({ error: 'supplier not found' });
    const payload = req.body || {};
    const name = String(payload.name || existing.name || '').trim();
    const rawOrderMethod = String(payload.orderMethod ?? existing.ordermethod ?? existing.orderMethod ?? '').trim().toLowerCase();
    const orderMethod = ['web', 'email', 'phone'].includes(rawOrderMethod) ? rawOrderMethod : null;
    if (!name) return res.status(400).json({ error: 'name required' });
    const dup = await getAsync('SELECT id FROM suppliers WHERE tenantId=$1 AND LOWER(name)=LOWER($2) AND id<>$3 LIMIT 1', [t, name, req.params.id]);
    if (dup) return res.status(409).json({ error: 'supplier already exists' });
    const updated = {
      id: req.params.id,
      name,
      contact: String(payload.contact ?? existing.contact ?? '').trim() || null,
      email: String(payload.email ?? existing.email ?? '').trim() || null,
      phone: String(payload.phone ?? existing.phone ?? '').trim() || null,
      orderMethod,
      websiteUrl: normalizeUrl(payload.websiteUrl ?? existing.websiteurl ?? existing.websiteUrl),
      orderUrl: normalizeUrl(payload.orderUrl ?? existing.orderurl ?? existing.orderUrl),
      leadTime: payload.leadTime ?? existing.leadtime ?? existing.leadTime ?? {},
      moq: payload.moq === '' ? null : (payload.moq !== undefined ? Number(payload.moq) : (existing.moq ?? null)),
      notes: String(payload.notes ?? existing.notes ?? '').trim() || null,
      tenantId: t,
      createdAt: existing.createdat || existing.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    await runAsync(
      `UPDATE suppliers
       SET name=$1, contact=$2, email=$3, phone=$4, orderMethod=$5, websiteUrl=$6, orderUrl=$7, leadTime=$8, moq=$9, notes=$10, updatedAt=$11
       WHERE id=$12 AND tenantId=$13`,
      [updated.name, updated.contact, updated.email, updated.phone, updated.orderMethod, updated.websiteUrl, updated.orderUrl, updated.leadTime, updated.moq, updated.notes, updated.updatedAt, updated.id, updated.tenantId]
    );
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'suppliers.update', details: { id: updated.id, name: updated.name } });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.delete('/api/suppliers/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    await runAsync('UPDATE items SET supplierId=NULL WHERE supplierId=$1 AND tenantId=$2', [req.params.id, t]);
    await runAsync('DELETE FROM suppliers WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'suppliers.update', details: { id: req.params.id, deleted: true } });
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: 'server error' });
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
    await ensureTenantCapabilities(tenantId);
    const { salt, hash } = await hashPassword(adminPassword);
    const adminEmailNorm = normalizeEmail(adminEmail);
    const globalAdmin = await emailExistsGlobal(adminEmailNorm);
    if (globalAdmin) return res.status(400).json({ error: 'email already exists in another business' });
    const emailVerified = !REQUIRE_EMAIL_VERIFICATION;
    const emailVerifiedAt = emailVerified ? Date.now() : null;
    const user = {
      id: newId(),
      email: adminEmailNorm,
      name: adminName || name || 'Admin',
      role: 'admin',
      salt,
      hash,
      createdAt: Date.now(),
      emailVerified,
      emailVerifiedAt,
      tenantId
    };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,emailVerified,emailVerifiedAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.emailVerified, user.emailVerifiedAt, user.tenantId]);
    if (REQUIRE_EMAIL_VERIFICATION) {
      const mail = await sendVerificationEmail(user);
      if (!mail.ok && IS_PROD) return res.status(500).json({ error: 'failed to send verification email' });
      return res.status(201).json({ tenant: { id: tenantId, code: normCode, name }, admin: safeUser(user), status: 'verify' });
    }
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
      const globalExisting = await emailExistsGlobal(emailNorm);
      if (globalExisting) return res.status(400).json({ error: 'email already exists in another business' });
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
    const emailVerified = !REQUIRE_EMAIL_VERIFICATION;
    const emailVerifiedAt = emailVerified ? Date.now() : null;
    const user = {
      id: newId(),
      email: emailNorm,
      name,
      role: normalizeUserRole(role),
      salt,
      hash,
      createdAt: Date.now(),
      emailVerified,
      emailVerifiedAt,
      tenantId: tenant.id
    };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,emailVerified,emailVerifiedAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.emailVerified, user.emailVerifiedAt, user.tenantId]);
    await logAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.register', details: { email } });
    if (REQUIRE_EMAIL_VERIFICATION) {
      const mail = await sendVerificationEmail(user);
      if (!mail.ok && IS_PROD) return res.status(500).json({ error: 'failed to send verification email' });
      return res.status(201).json({ status: 'verify', email: user.email });
    }
    const token = await createSession(user.id);
    setSessionCookie(res, token);
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
      const rawTenant = (tenantCode || '').toString().trim();
      const hasTenantCode = !!rawTenant;
      const normalizedTenant = hasTenantCode ? normalizeTenantCode(rawTenant) : null;
      const isDevEmail = emailNorm === DEV_EMAIL.toLowerCase();
      const attemptKey = hasTenantCode ? `${emailNorm}:${normalizedTenant}` : `${emailNorm}:__auto__`;
      const attempt = loginAttempts.get(attemptKey) || { count: 0, lockUntil: 0 };
      if (!isDevEmail && attempt.lockUntil > Date.now()) return res.status(429).json({ error: 'account locked, try later' });
  
      let tenant = null;
      let user = null;
      let passwordVerified = false;
      if (hasTenantCode) {
        tenant = await getAsync('SELECT * FROM tenants WHERE code=$1', [normalizedTenant]);
        if (!tenant) return res.status(400).json({ error: 'Business code not found' });
        user = await getAsync('SELECT * FROM users WHERE LOWER(email)=LOWER($1) AND tenantId=$2', [emailNorm, tenant.id]);
        if (user && verifyPassword(password, user.salt, user.hash)) passwordVerified = true;
      } else {
        const matches = await allAsync(
          'SELECT u.*, t.code AS tenantCode FROM users u JOIN tenants t ON t.id = u.tenantId WHERE LOWER(u.email)=LOWER($1)',
          [emailNorm]
        );
        if (matches.length === 1) {
          user = matches[0];
          tenant = { id: user.tenantid || user.tenantId, code: user.tenantcode || user.tenantCode };
          if (verifyPassword(password, user.salt, user.hash)) passwordVerified = true;
        } else if (matches.length > 1) {
          const valid = matches.filter(candidate => verifyPassword(password, candidate.salt, candidate.hash));
          if (valid.length === 1) {
            user = valid[0];
            tenant = { id: user.tenantid || user.tenantId, code: user.tenantcode || user.tenantCode };
            passwordVerified = true;
          } else if (valid.length > 1) {
            return res.status(400).json({ error: 'Multiple businesses found for this email. Use your business link or contact support.' });
          }
        }
      }
      if (!user) {
        if (!isDevEmail) {
          attempt.count += 1;
          if (attempt.count >= MAX_ATTEMPTS) {
          attempt.lockUntil = Date.now() + LOCK_MS;
          attempt.count = 0;
        }
        loginAttempts.set(attemptKey, attempt);
      }
        return res.status(401).json({ error: hasTenantCode ? 'Email not found for this business' : 'Email not found' });
      }
      if (!passwordVerified && !verifyPassword(password, user.salt, user.hash)) {
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
    const verified = user.emailverified ?? user.emailVerified;
    if (REQUIRE_EMAIL_VERIFICATION && !verified && !isDevEmail) {
      await sendVerificationEmail(user);
      return res.status(403).json({ error: 'email not verified', code: 'email_not_verified' });
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

app.post('/api/auth/dev-login', async (req, res) => {
  try {
    if (IS_PROD || !isLocalhostRequest(req)) return res.status(404).json({ error: 'not found' });
    await ensureDevAccount();
    const tenantId = DEV_TENANT_ID || normalizeTenantCode(DEV_TENANT_CODE);
    const user = await getAsync('SELECT * FROM users WHERE LOWER(email)=LOWER($1) AND tenantId=$2', [DEV_EMAIL, tenantId]);
    if (!user) return res.status(500).json({ error: 'dev account unavailable' });
    const token = await createSession(user.id, REMEMBER_SESSION_TTL_MS);
    setSessionCookie(res, token, REMEMBER_SESSION_TTL_MS);
    await logAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.login', details: { email: user.email, source: 'dev-auto-login' } });
    res.json(safeUser(user));
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/auth/verify/resend', async (req, res) => {
  try {
    const { email, tenantCode } = req.body || {};
    const emailNorm = normalizeEmail(email);
    if (!emailNorm) return res.status(400).json({ error: 'email required' });
    const resolved = await resolveUserByEmail(emailNorm, tenantCode);
    if (resolved.error === 'tenant') return res.status(400).json({ error: 'invalid tenant' });
    if (resolved.error === 'multiple') {
      return res.status(400).json({ error: 'multiple businesses found for this email. Use your business link.' });
    }
    const user = resolved.user;
    if (!user) return res.json({ status: 'ok' });
    const verified = user.emailverified ?? user.emailVerified;
    if (verified) return res.json({ status: 'ok' });
    const mail = await sendVerificationEmail(user);
    if (!mail.ok && IS_PROD) return res.status(500).json({ error: 'failed to send verification email' });
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/auth/verify', async (req, res) => {
  try {
    const token = (req.query?.token || '').toString().trim();
    if (!token) return res.status(400).json({ error: 'token required' });
    const record = await consumeAuthToken(token, 'verify');
    if (!record) return res.status(400).json({ error: 'invalid or expired token' });
    const user = await getAsync('SELECT * FROM users WHERE id=$1', [record.userid || record.userId]);
    if (!user) return res.status(404).json({ error: 'user not found' });
    await runAsync('UPDATE users SET emailVerified=true, emailVerifiedAt=$1 WHERE id=$2', [Date.now(), user.id]);
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/auth/password/request', async (req, res) => {
  try {
    const { email, tenantCode } = req.body || {};
    const emailNorm = normalizeEmail(email);
    if (!emailNorm) return res.status(400).json({ error: 'email required' });
    const resolved = await resolveUserByEmail(emailNorm, tenantCode);
    if (resolved.error === 'tenant') return res.status(400).json({ error: 'invalid tenant' });
    if (resolved.error === 'multiple') {
      return res.status(400).json({ error: 'multiple businesses found for this email. Use your business link.' });
    }
    const user = resolved.user;
    if (!user) return res.json({ status: 'ok' });
    const mail = await sendResetEmail(user);
    if (!mail.ok && IS_PROD) return res.status(500).json({ error: 'failed to send reset email' });
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/auth/password/reset', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    if (password.length < 10) return res.status(400).json({ error: 'password too weak' });
    const record = await consumeAuthToken(token, 'reset');
    if (!record) return res.status(400).json({ error: 'invalid or expired token' });
    const user = await getAsync('SELECT * FROM users WHERE id=$1', [record.userid || record.userId]);
    if (!user) return res.status(404).json({ error: 'user not found' });
    const { salt, hash } = await hashPassword(password);
    await runAsync('UPDATE users SET salt=$1, hash=$2 WHERE id=$3', [salt, hash, user.id]);
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/auth/invite/accept', async (req, res) => {
  try {
    const { token, password, name } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    if (password.length < 10) return res.status(400).json({ error: 'password too weak' });
    const record = await consumeAuthToken(token, 'invite');
    if (!record) return res.status(400).json({ error: 'invalid or expired token' });
    const user = await getAsync('SELECT * FROM users WHERE id=$1', [record.userid || record.userId]);
    if (!user) return res.status(404).json({ error: 'user not found' });
    const { salt, hash } = await hashPassword(password);
    const updatedName = (name || '').trim() || user.name || '';
    await runAsync('UPDATE users SET salt=$1, hash=$2, name=$3, emailVerified=true, emailVerifiedAt=$4 WHERE id=$5',
      [salt, hash, updatedName, Date.now(), user.id]);
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/auth/logout', async (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) await deleteSession(token);
  clearSessionCookie(res);
  res.status(204).end();
});

app.post('/api/webhooks/inbound/:id', async (req, res) => {
  try {
    const endpoint = await getInboundWebhookEndpoint(req.params.id);
    if (!endpoint || endpoint.isactive === false) return res.status(404).json({ error: 'webhook endpoint not found' });
    const timestampHeader = String(req.get('x-modulr-timestamp') || '').trim();
    const signatureHeader = String(req.get('x-modulr-signature') || '').trim();
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) return res.status(400).json({ error: 'invalid timestamp header' });
    if (Math.abs(Date.now() - timestamp) > INBOUND_WEBHOOK_SIGNATURE_TTL_MS) {
      return res.status(401).json({ error: 'stale webhook signature' });
    }
    const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
    if (!verifyInboundWebhookSignature(endpoint.secret, timestampHeader, rawBody, signatureHeader)) {
      return res.status(401).json({ error: 'invalid webhook signature' });
    }
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const eventType = String(req.get('x-modulr-event') || payload.event || payload.type || 'generic.event').trim().slice(0, 120) || 'generic.event';
    const externalId = String(req.get('x-modulr-delivery-id') || payload.id || payload.deliveryId || '').trim().slice(0, 160) || null;
    const source = normalizeInboundWebhookSource(req.get('x-modulr-source') || payload.source || endpoint.source || 'generic');
    const now = Date.now();
    const eventId = newId();
    await runAsync(
      `INSERT INTO inbound_webhook_events(id,endpointId,tenantId,source,eventType,externalId,payload,headers,status,receivedAt)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        eventId,
        endpoint.id,
        endpoint.tenantid || endpoint.tenantId,
        source,
        eventType,
        externalId,
        payload,
        pickInboundWebhookHeaders(req),
        'accepted',
        now
      ]
    );
    await runAsync('UPDATE inbound_webhook_endpoints SET lastReceivedAt=$1, updatedAt=$1 WHERE id=$2', [now, endpoint.id]);
    await logAudit({
      tenantId: endpoint.tenantid || endpoint.tenantId,
      userId: null,
      action: 'webhooks.inbound.received',
      details: {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        source,
        eventType,
        externalId
      }
    });
    res.status(202).json({ ok: true, received: true, eventId });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(safeUser(req.user));
});

app.get('/api/users/me/notifications', requireAuth, async (req, res) => {
  try {
    const user = await getAsync('SELECT * FROM users WHERE id=$1 AND tenantId=$2', [req.user.id, tenantId(req)]);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({ notificationPrefs: normalizeNotificationPrefs(user.notificationprefs ?? user.notificationPrefs) });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.put('/api/users/me/notifications', requireAuth, async (req, res) => {
  try {
    const prefs = normalizeNotificationPrefs(req.body?.notificationPrefs || req.body || {});
    await runAsync(
      'UPDATE users SET notificationPrefs=$1 WHERE id=$2 AND tenantId=$3',
      [prefs, req.user.id, tenantId(req)]
    );
    const updated = await getAsync('SELECT * FROM users WHERE id=$1 AND tenantId=$2', [req.user.id, tenantId(req)]);
    res.json(safeUser(updated));
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/inbound-webhooks', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const rows = await allAsync(
      `SELECT w.*,
              COALESCE(evt.event_count, 0) AS eventCount
       FROM inbound_webhook_endpoints w
       LEFT JOIN (
         SELECT endpointId, COUNT(*)::int AS event_count
         FROM inbound_webhook_events
         WHERE tenantId=$1
         GROUP BY endpointId
       ) evt ON evt.endpointId = w.id
       WHERE w.tenantId=$1
       ORDER BY w.createdAt DESC`,
      [t]
    );
    res.json(rows.map((row) => formatInboundWebhookRow(row)));
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/inbound-webhooks/events', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit || 25)));
    const rows = await allAsync(
      `SELECT e.*, w.name AS endpointName
       FROM inbound_webhook_events e
       LEFT JOIN inbound_webhook_endpoints w ON w.id = e.endpointId
       WHERE e.tenantId=$1
       ORDER BY e.receivedAt DESC
       LIMIT $2`,
      [t, limit]
    );
    res.json(rows.map((row) => ({
      id: row.id,
      endpointId: row.endpointid || row.endpointId,
      endpointName: row.endpointname || row.endpointName || 'Webhook',
      source: row.source || 'generic',
      eventType: row.eventtype || row.eventType || 'generic.event',
      externalId: row.externalid || row.externalId || '',
      status: row.status || 'accepted',
      receivedAt: Number(row.receivedat || row.receivedAt || 0) || 0
    })));
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.post('/api/inbound-webhooks', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const now = Date.now();
    const name = normalizeInboundWebhookName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name required' });
    const row = {
      id: newId(),
      tenantId: t,
      name,
      source: normalizeInboundWebhookSource(req.body?.source),
      secret: newInboundWebhookSecret(),
      isActive: req.body?.isActive !== false,
      notes: String(req.body?.notes || '').trim() || '',
      createdAt: now,
      updatedAt: now
    };
    await runAsync(
      `INSERT INTO inbound_webhook_endpoints(id,tenantId,name,source,secret,isActive,notes,createdAt,updatedAt)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id, row.tenantId, row.name, row.source, row.secret, row.isActive, row.notes, row.createdAt, row.updatedAt]
    );
    res.status(201).json(formatInboundWebhookRow(row, { includeSecret: true }));
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.patch('/api/inbound-webhooks/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const existing = await getInboundWebhookEndpoint(req.params.id, t);
    if (!existing) return res.status(404).json({ error: 'webhook endpoint not found' });
    const name = normalizeInboundWebhookName(req.body?.name || existing.name);
    if (!name) return res.status(400).json({ error: 'name required' });
    const source = normalizeInboundWebhookSource(req.body?.source || existing.source);
    const notes = Object.prototype.hasOwnProperty.call(req.body || {}, 'notes') ? String(req.body?.notes || '').trim() : (existing.notes || '');
    const isActive = Object.prototype.hasOwnProperty.call(req.body || {}, 'isActive') ? req.body?.isActive !== false : existing.isactive !== false;
    const updatedAt = Date.now();
    await runAsync(
      `UPDATE inbound_webhook_endpoints
       SET name=$1, source=$2, notes=$3, isActive=$4, updatedAt=$5
       WHERE id=$6 AND tenantId=$7`,
      [name, source, notes, isActive, updatedAt, req.params.id, t]
    );
    const refreshed = await getInboundWebhookEndpoint(req.params.id, t);
    res.json(formatInboundWebhookRow(refreshed));
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.post('/api/inbound-webhooks/:id/rotate-secret', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const existing = await getInboundWebhookEndpoint(req.params.id, t);
    if (!existing) return res.status(404).json({ error: 'webhook endpoint not found' });
    const secret = newInboundWebhookSecret();
    const updatedAt = Date.now();
    await runAsync(
      'UPDATE inbound_webhook_endpoints SET secret=$1, updatedAt=$2 WHERE id=$3 AND tenantId=$4',
      [secret, updatedAt, req.params.id, t]
    );
    const refreshed = await getInboundWebhookEndpoint(req.params.id, t);
    res.json(formatInboundWebhookRow({ ...refreshed, secret }, { includeSecret: true }));
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.delete('/api/inbound-webhooks/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const existing = await getInboundWebhookEndpoint(req.params.id, t);
    if (!existing) return res.status(404).json({ error: 'webhook endpoint not found' });
    await runAsync('DELETE FROM inbound_webhook_endpoints WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    res.json({ ok: true, id: req.params.id });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
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
      const globalExisting = await emailExistsGlobal(emailNorm);
      if (globalExisting) return res.status(400).json({ error: 'email already exists in another business' });
      const exists = await getAsync('SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND tenantId=$2', [emailNorm, t]);
      if (exists) return res.status(400).json({ error: 'email already exists' });
      const { salt, hash } = await hashPassword(password);
    const emailVerified = !REQUIRE_EMAIL_VERIFICATION;
    const emailVerifiedAt = emailVerified ? Date.now() : null;
    const user = {
      id: newId(),
      email: emailNorm,
      name,
      role: normalizeUserRole(role),
      salt,
      hash,
      createdAt: Date.now(),
      emailVerified,
      emailVerifiedAt,
      tenantId: t
    };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,emailVerified,emailVerifiedAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.emailVerified, user.emailVerifiedAt, user.tenantId]);
    if (REQUIRE_EMAIL_VERIFICATION) {
      const mail = await sendVerificationEmail(user);
      if (!mail.ok && IS_PROD) return res.status(500).json({ error: 'failed to send verification email' });
    }
    res.status(201).json(safeUser(user));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/users/invite', requireRole('admin'), async (req, res) => {
  try {
    const { email, name, role = 'employee' } = req.body || {};
    const emailNorm = normalizeEmail(email);
    if (!emailNorm) return res.status(400).json({ error: 'email required' });
    const t = tenantId(req);
    const existing = await getAsync('SELECT * FROM users WHERE LOWER(email)=LOWER($1) AND tenantId=$2', [emailNorm, t]);
    if (existing) {
      const verified = existing.emailverified ?? existing.emailVerified;
      if (verified) return res.status(400).json({ error: 'user already exists' });
      const mail = await sendInviteEmail(existing, req.user?.email || '');
      if (!mail.ok && IS_PROD) return res.status(500).json({ error: 'failed to send invite email' });
      return res.json({ status: 'resent', user: safeUser(existing) });
    }
    const globalExisting = await emailExistsGlobal(emailNorm);
    if (globalExisting) return res.status(400).json({ error: 'email already exists in another business' });
    const tempPassword = crypto.randomBytes(18).toString('hex');
    const { salt, hash } = await hashPassword(tempPassword);
    const now = Date.now();
    const user = {
      id: newId(),
      email: emailNorm,
      name,
      role: normalizeUserRole(role),
      salt,
      hash,
      createdAt: now,
      emailVerified: false,
      emailVerifiedAt: null,
      invitedAt: now,
      tenantId: t
    };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt,emailVerified,emailVerifiedAt,invitedAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [user.id, user.email, user.name, user.role, user.salt, user.hash, user.createdAt, user.emailVerified, user.emailVerifiedAt, user.invitedAt, user.tenantId]);
    const mail = await sendInviteEmail(user, req.user?.email || '');
    if (!mail.ok && IS_PROD) return res.status(500).json({ error: 'failed to send invite email' });
    res.status(201).json({ status: 'invited', user: safeUser(user) });
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
        const globalDup = await emailExistsGlobal(emailNorm, id);
        if (globalDup) return res.status(400).json({ error: 'email already exists in another business' });
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
    const { code, name, scheduleDate, startDate, endDate, status, location, notes, materials } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const t = tenantId(req);
    const start = startDate || scheduleDate || null;
    const updatedAt = Date.now();
    let materialsReadyNotification = null;
    let statusValue = 'planned';
    await withTransaction(async (client) => {
      const existing = await client.query('SELECT status FROM jobs WHERE code=$1 AND tenantId=$2 LIMIT 1', [code, t]);
      const storedExistingStatus = String(existing.rows?.[0]?.status || '').trim().toLowerCase();
      const incomingStatus = typeof status === 'string' ? status.trim().toLowerCase() : '';
      statusValue = incomingStatus || storedExistingStatus || 'planned';
      await client.query(`INSERT INTO jobs(code,name,startDate,endDate,status,location,notes,updatedAt,tenantId)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(code,tenantId) DO UPDATE SET name=EXCLUDED.name, startDate=EXCLUDED.startDate, endDate=EXCLUDED.endDate, status=EXCLUDED.status, location=EXCLUDED.location, notes=EXCLUDED.notes, updatedAt=EXCLUDED.updatedAt`, [code, name || '', start, endDate || null, statusValue, location || null, notes || null, updatedAt, t]);
      if (Array.isArray(materials)) {
        await replaceJobMaterialsTx(client, t, code, materials);
        materialsReadyNotification = await markJobMaterialsReadyTransitionTx(client, t, code);
      }
    });
    const materialRows = Array.isArray(materials) ? await readJobMaterials(t, code) : [];
    if (Array.isArray(materials)) {
      await logAudit({ tenantId: t, userId: currentUserId(req), action: 'projects.materials.update', details: { jobId: code, count: materialRows.length } });
    }
    if (materialsReadyNotification) await sendProjectMaterialsReadyEmails(materialsReadyNotification);
    const savedJob = (await readJobs(t)).find((job) => String(job.code || '') === String(code || ''));
    res.status(201).json(savedJob
      ? { ...savedJob, materials: materialRows }
      : { code, name: name || '', startDate: start || null, endDate: endDate || null, status: statusValue, storedStatus: statusValue, statusSource: 'manual', location: location || null, notes: notes || null, updatedAt, tenantId: t, materials: materialRows });
  } catch (e) {
    console.warn('Job save failed', e.message || e);
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/jobs/:code/materials', async (req, res) => {
  try {
    const t = tenantId(req);
    const job = await getAsync('SELECT code FROM jobs WHERE code=$1 AND tenantId=$2', [req.params.code, t]);
    if (!job) return res.status(404).json({ error: 'project not found' });
    const materials = await readJobMaterials(t, req.params.code);
    res.json(materials);
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/jobs/open-material-needs', async (req, res) => {
  try {
    const t = tenantId(req);
    const [jobs, materials] = await Promise.all([
      readJobs(t),
      readAllJobMaterials(t)
    ]);
    const jobMeta = new Map((jobs || []).map((job) => [job.code, job]));
    const rows = new Map();
    (materials || []).forEach((material) => {
      const jobId = normalizeJobId(material.jobId || material.jobid || '');
      if (!jobId) return;
      const job = jobMeta.get(jobId);
      const status = String(job?.status || '').trim().toLowerCase();
      if (CLOSED_PROJECT_STATUSES.has(status)) return;
      const outstandingQty = Number(material.outstandingQty || 0) || 0;
      if (outstandingQty <= 0) return;
      const current = rows.get(jobId) || {
        jobId,
        name: job?.name || '',
        status: job?.status || '',
        openLines: 0,
        openQty: 0
      };
      current.openLines += 1;
      current.openQty = roundQty(current.openQty + outstandingQty);
      rows.set(jobId, current);
    });
    res.json(Array.from(rows.values()).sort((a, b) => a.jobId.localeCompare(b.jobId)));
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.put('/api/jobs/:code/materials', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const job = await getAsync('SELECT code FROM jobs WHERE code=$1 AND tenantId=$2', [req.params.code, t]);
    if (!job) return res.status(404).json({ error: 'project not found' });
    const materials = Array.isArray(req.body?.materials) ? req.body.materials : [];
    let materialsReadyNotification = null;
    await withTransaction(async (client) => {
      await replaceJobMaterialsTx(client, t, req.params.code, materials);
      materialsReadyNotification = await markJobMaterialsReadyTransitionTx(client, t, req.params.code);
    });
    const rows = await readJobMaterials(t, req.params.code);
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'projects.materials.update', details: { jobId: req.params.code, count: rows.length } });
    if (materialsReadyNotification) await sendProjectMaterialsReadyEmails(materialsReadyNotification);
    res.json({ ok: true, materials: rows });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.delete('/api/jobs/:code', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    await runAsync('DELETE FROM job_materials WHERE jobId=$1 AND tenantId=$2', [req.params.code, t]);
    await runAsync('DELETE FROM jobs WHERE code=$1 AND tenantId=$2', [req.params.code, t]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ADMIN ORDERS
app.post('/api/inventory-order', requireRole('admin'), async (req, res) => {
  try {
    const { code, name, qty, eta, notes, ts, jobId, autoReserve, jobMaterialId, orderNumber } = req.body;
    const qtyNum = Number(qty);
    if (!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const requestKey = readInventoryRequestKey(req);
    const jobIdVal = (jobId || '').trim() || null;
    const orderNumberVal = String(orderNumber || '').trim().slice(0, 80);
    let deduped = false;
    const entry = await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const existing = (await findInventoryEventsByRequestKeyTx(client, t, requestKey)).find((row) => row.type === 'ordered');
        if (existing) {
          deduped = true;
          return existing;
        }
      }
      await ensureItem(client, { code, name: name || code, category: '', unitPrice: null, tenantIdVal: t });
      const sourceMeta = withRequestKeyMeta({ autoReserve: autoReserve !== false, jobMaterialId: jobMaterialId || null, orderNumber: orderNumberVal }, requestKey, 'order');
      const ev = { id: newId(), code, name: name || code, qty: qtyNum, eta, notes, jobId: jobIdVal, ts: ts || Date.now(), type: 'ordered', status: statusForType('ordered'), userEmail: actor.userEmail, userName: actor.userName, tenantId: t, sourceType: 'order', sourceId: null, sourceMeta };
      ev.sourceId = ev.id;
      ev.sourceMeta.batchId = ev.sourceId;
      await client.query(`INSERT INTO inventory(id,code,name,qty,eta,notes,jobId,ts,type,status,userEmail,userName,tenantId,sourceType,sourceId,sourceMeta) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [ev.id, ev.code, ev.name, ev.qty, ev.eta, ev.notes, ev.jobId, ev.ts, ev.type, ev.status, ev.userEmail, ev.userName, ev.tenantId, ev.sourceType, ev.sourceId, ev.sourceMeta]);
      await changeJobMaterialQtyTx(client, t, jobIdVal, jobMaterialId, 'qtyOrdered', qtyNum);
      return ev;
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.order', details: { code, qty: qtyNum, jobId, eta, orderNumber: orderNumberVal } });
    res.status(deduped ? 200 : 201).json({ ...entry, deduped, requestKey: requestKey || null });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

// Bulk order placement (admin)
app.post('/api/inventory-order/bulk', requireRole('admin'), async (req, res) => {
  try {
    const lines = Array.isArray(req.body?.orders) ? req.body.orders : [];
    if (!lines.length) return res.status(400).json({ error: 'orders array required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const requestKey = readInventoryRequestKey(req);
    const results = [];
    const batchId = newId();
    let deduped = false;
    await withTransaction(async (client) => {
      await lockInventoryRequestTx(client, t, requestKey);
      if (requestKey) {
        const existing = (await findInventoryEventsByRequestKeyTx(client, t, requestKey)).filter((row) => row.type === 'ordered');
        if (existing.length) {
          deduped = true;
          results.push(...existing);
          return;
        }
      }
      for (const line of lines) {
        const { code, name, qty, eta, notes, ts, jobId, autoReserve, jobMaterialId, orderNumber } = line || {};
        const qtyNum = Number(qty);
        if (!code || !qtyNum || qtyNum <= 0) throw new Error(`Invalid order line for code ${code || ''}`);
        const jobIdVal = (jobId || '').trim() || null;
        const orderNumberVal = String(orderNumber || '').trim().slice(0, 80);
        await ensureItem(client, { code, name: name || code, category: '', unitPrice: null, tenantIdVal: t });
        const sourceMeta = withRequestKeyMeta({ autoReserve: autoReserve !== false, batchId, jobMaterialId: jobMaterialId || null, orderNumber: orderNumberVal }, requestKey, 'order-bulk');
        const ev = { id: newId(), code, name: name || code, qty: qtyNum, eta, notes, jobId: jobIdVal, ts: ts || Date.now(), type: 'ordered', status: statusForType('ordered'), userEmail: actor.userEmail, userName: actor.userName, tenantId: t, sourceType: 'order', sourceId: null, sourceMeta };
        ev.sourceId = ev.id;
        await client.query(`INSERT INTO inventory(id,code,name,qty,eta,notes,jobId,ts,type,status,userEmail,userName,tenantId,sourceType,sourceId,sourceMeta) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [ev.id, ev.code, ev.name, ev.qty, ev.eta, ev.notes, ev.jobId, ev.ts, ev.type, ev.status, ev.userEmail, ev.userName, ev.tenantId, ev.sourceType, ev.sourceId, ev.sourceMeta]);
        await changeJobMaterialQtyTx(client, t, jobIdVal, jobMaterialId, 'qtyOrdered', qtyNum);
        results.push(ev);
      }
    });
    await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.order', details: { lines: results.length, orderNumbers: [...new Set(results.map((row) => String(row?.sourceMeta?.orderNumber || '').trim()).filter(Boolean))] } });
    res.status(deduped ? 200 : 201).json({ count: results.length, batchId, orders: results, deduped, requestKey: requestKey || null });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.post('/api/inventory-order/:sourceId/cancel', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const { reason } = req.body || {};
    const actor = actorInfo(req);
    const result = await withTransaction(async (client) => {
      const sourceRow = await client.query(
        `SELECT * FROM inventory WHERE id=$1 AND tenantId=$2 AND type='ordered' FOR UPDATE`,
        [req.params.sourceId, t]
      );
      const source = sourceRow.rows?.[0];
      if (!source) throw new Error('incoming order not found');
      const status = String(source.status || '').toLowerCase();
      if (status === 'cancelled' || status === 'canceled') throw new Error('incoming order already cancelled');
      const openQty = await calcOpenSourceQtyTx(client, req.params.sourceId, source.code, t);
      if (!(openQty > 0)) throw new Error('no open quantity left to cancel');
      const sourceMeta = source.sourcemeta || source.sourceMeta || {};
      const jobIdVal = normalizeJobId(source.jobid || source.jobId || '') || null;
      const nextMeta = {
        ...sourceMeta,
        cancelledAt: Date.now(),
        cancelledBy: actor.userEmail,
        cancelReason: reason ? String(reason).trim() : '',
        cancelledOpenQty: openQty
      };
      await client.query(
        'UPDATE inventory SET status=$1, sourceMeta=$2 WHERE id=$3 AND tenantId=$4',
        ['cancelled', nextMeta, req.params.sourceId, t]
      );
      await changeJobMaterialQtyTx(client, t, jobIdVal, sourceMeta?.jobMaterialId || null, 'qtyOrdered', -openQty);
      return {
        sourceId: req.params.sourceId,
        code: source.code,
        jobId: jobIdVal,
        cancelledQty: openQty
      };
    });
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'inventory.order.cancel',
      details: { sourceId: result.sourceId, code: result.code, jobId: result.jobId, qty: result.cancelledQty, reason: reason || '' }
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    const message = e.message || 'server error';
    if (message === 'incoming order not found') return res.status(404).json({ error: message });
    if (message === 'incoming order already cancelled' || message === 'no open quantity left to cancel') {
      return res.status(400).json({ error: message });
    }
    res.status(500).json({ error: message });
  }
});

app.post('/api/procurement/vendor-open', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const supplierId = (req.body?.supplierId || '').toString().trim();
    const supplierName = (req.body?.supplierName || '').toString().trim();
    const url = normalizeUrl(req.body?.url || '');
    const lineCount = Number(req.body?.lineCount || 0) || 0;
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'procurement.vendor_open',
      details: { supplierId, supplierName, url, qty: lineCount }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

const FIELD_PURCHASE_RECEIPT_PHOTO_LIMIT = 2;
const FIELD_PURCHASE_RECEIPT_PHOTO_MAX_BYTES = 300 * 1024;
const FIELD_PURCHASE_RECEIPT_PHOTO_TOTAL_BYTES = FIELD_PURCHASE_RECEIPT_PHOTO_LIMIT * FIELD_PURCHASE_RECEIPT_PHOTO_MAX_BYTES;
const FIELD_PURCHASE_RECEIPT_DIR = path.join(__dirname, 'data', 'receipt-photos');

function estimateReceiptPhotoBytes(dataUrl = '') {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  const paddingMatch = base64.match(/=*$/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function fieldPurchaseReceiptExt(type = '') {
  const normalized = String(type || '').trim().toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  return 'jpg';
}

function isVeryfiConfigured() {
  return !!(VERYFI_CLIENT_ID && VERYFI_AUTHORIZATION);
}

function normalizeVeryfiScalar(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return String(
      value.value
      || value.text
      || value.name
      || value.label
      || value.number
      || value.code
      || ''
    ).trim();
  }
  return '';
}

function normalizeVeryfiNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') {
    return normalizeVeryfiNumber(
      value.amount
      ?? value.value
      ?? value.number
      ?? value.total
      ?? null
    );
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeVeryfiDate(value) {
  const raw = normalizeVeryfiScalar(value?.date || value?.value || value);
  if (!raw) return '';
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw;
  return new Date(parsed).toISOString();
}

function normalizeVeryfiLineItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  return items.map((item) => {
    const description = normalizeVeryfiScalar(
      item?.description
      || item?.normalized_description
      || item?.normalizedDescription
      || item?.full_description
      || item?.fullDescription
      || item?.name
      || ''
    );
    const reference = normalizeVeryfiScalar(
      item?.reference
      || item?.product_code
      || item?.productCode
      || item?.sku
      || item?.code
      || ''
    );
    const quantity = normalizeVeryfiNumber(item?.quantity);
    const price = normalizeVeryfiNumber(item?.price ?? item?.unit_price ?? item?.unitPrice ?? null);
    const total = normalizeVeryfiNumber(item?.total ?? item?.line_total ?? item?.amount ?? null);
    return {
      description,
      reference,
      quantity: quantity && quantity > 0 ? quantity : 1,
      price,
      total,
      section: normalizeVeryfiScalar(item?.section || ''),
      category: Array.isArray(item?.category) ? item.category.map((entry) => normalizeVeryfiScalar(entry)).filter(Boolean) : []
    };
  }).filter((item) => item.description || item.reference);
}

function summarizeVeryfiDocument(document, { attachedPhotoCount = 1 } = {}) {
  const vendor = normalizeVeryfiScalar(
    document?.vendor?.name
    || document?.vendor
    || document?.vendors?.[0]?.name
    || document?.meta?.vendor?.value
    || document?.meta?.vendor?.name
    || ''
  );
  const receiptNumber = normalizeVeryfiScalar(
    document?.invoice_number
    || document?.document_reference_number
    || document?.purchase_order_number
    || document?.receipt_number
    || document?.external_id
    || ''
  );
  return {
    documentId: document?.id || null,
    externalId: normalizeVeryfiScalar(document?.external_id || ''),
    vendor,
    receiptNumber,
    total: normalizeVeryfiNumber(document?.total ?? document?.meta?.total ?? null),
    subtotal: normalizeVeryfiNumber(document?.subtotal ?? document?.meta?.subtotal ?? null),
    tax: normalizeVeryfiNumber(document?.tax ?? document?.meta?.tax ?? null),
    currencyCode: normalizeVeryfiScalar(document?.currency_code?.code || document?.currency_code || document?.meta?.currency_code?.code || document?.meta?.currency_code || ''),
    date: normalizeVeryfiDate(document?.date || document?.meta?.date || ''),
    documentType: normalizeVeryfiScalar(document?.document_type?.value || document?.document_type || document?.meta?.document_type?.value || document?.meta?.document_type || ''),
    warnings: Array.isArray(document?.warnings) ? document.warnings.map((entry) => normalizeVeryfiScalar(entry)).filter(Boolean) : [],
    lineItems: normalizeVeryfiLineItems(document?.line_items),
    attachedPhotoCount
  };
}

function persistFieldPurchaseReceiptPhoto({ batchId, index, type, normalizedDataUrl, name, sizeBytes, width, height }) {
  const ext = fieldPurchaseReceiptExt(type);
  const safeBatch = String(batchId || 'receipt')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'receipt';
  const fileName = `${Date.now()}-${safeBatch}-${index + 1}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const targetDir = FIELD_PURCHASE_RECEIPT_DIR;
  const targetPath = path.join(targetDir, fileName);
  const rawBase64 = String(normalizedDataUrl || '').split(',')[1] || '';
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(rawBase64, 'base64'));
  return {
    name: String(name || `receipt-${index + 1}.${ext}`).trim().slice(0, 120) || `receipt-${index + 1}.${ext}`,
    type,
    sizeBytes,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    url: `/data/receipt-photos/${fileName}`
  };
}

function parseFieldPurchaseSourceMeta(rawMeta) {
  if (!rawMeta) return {};
  if (typeof rawMeta === 'string') {
    try {
      const parsed = JSON.parse(rawMeta);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }
  return typeof rawMeta === 'object' ? rawMeta : {};
}

function readFieldPurchaseReceiptPhotos(rawMeta) {
  const meta = parseFieldPurchaseSourceMeta(rawMeta);
  let photos = meta.receiptPhotos || meta.receiptphotos || meta.photos || [];
  if (typeof photos === 'string') {
    try {
      photos = JSON.parse(photos);
    } catch (e) {
      photos = [];
    }
  }
  if (!Array.isArray(photos)) return [];
  return photos.map((photo, index) => {
    const rawData = String(
      photo?.dataUrl
      || photo?.dataurl
      || photo?.url
      || photo?.src
      || ''
    ).trim();
    const dataUrlMatch = /^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/=\s]+)$/i.exec(rawData);
    let dataUrl = '';
    let type = String(photo?.type || photo?.mimeType || photo?.mimetype || '').trim().toLowerCase();
    if (dataUrlMatch) {
      type = dataUrlMatch[1].toLowerCase();
      dataUrl = `data:${type};base64,${dataUrlMatch[2].replace(/\s+/g, '')}`;
    } else if (/^[a-z0-9+/=\s]+$/i.test(rawData) && rawData.length > 64) {
      type = /^image\/(?:jpeg|png|webp)$/i.test(type) ? type : 'image/jpeg';
      dataUrl = `data:${type};base64,${rawData.replace(/\s+/g, '')}`;
    }
    const url = !dataUrl && /^(\/|https?:\/\/)/i.test(rawData) ? rawData : '';
    if (!dataUrl && !url) return null;
    const sizeBytes = Number(photo?.sizeBytes || photo?.sizebytes || (dataUrl ? estimateReceiptPhotoBytes(dataUrl) : 0)) || (dataUrl ? estimateReceiptPhotoBytes(dataUrl) : 0);
    return {
      name: String(photo?.name || `receipt-${index + 1}.jpg`).trim().slice(0, 120) || `receipt-${index + 1}.jpg`,
      type: type || 'image/jpeg',
      sizeBytes,
      width: Number.isFinite(Number(photo?.width)) ? Math.round(Number(photo.width)) : null,
      height: Number.isFinite(Number(photo?.height)) ? Math.round(Number(photo.height)) : null,
      ...(dataUrl ? { dataUrl } : {}),
      ...(url ? { url } : {})
    };
  }).filter(Boolean);
}

function mergeFieldPurchaseSourceMeta(entries) {
  const merged = {
    batchId: '',
    vendor: '',
    receipt: '',
    purchasedAt: null,
    cost: null,
    receiptPhotos: []
  };
  const seenPhotos = new Set();
  (entries || []).forEach((entry) => {
    const meta = parseFieldPurchaseSourceMeta(entry?.sourcemeta || entry?.sourceMeta || {});
    if (!merged.batchId) merged.batchId = String(meta.batchId || meta.batchid || '').trim();
    if (!merged.vendor) merged.vendor = String(meta.vendor || meta.Vendor || '').trim();
    if (!merged.receipt) merged.receipt = String(meta.receipt || meta.receiptNumber || meta.receiptnumber || '').trim();
    if (merged.purchasedAt === null) {
      const purchasedAt = Number(meta.purchasedAt || meta.purchasedat || entry?.ts || 0);
      merged.purchasedAt = Number.isFinite(purchasedAt) && purchasedAt > 0 ? purchasedAt : null;
    }
    if (merged.cost === null) {
      const cost = Number(meta.cost ?? meta.unitCost ?? meta.unitcost);
      if (Number.isFinite(cost)) merged.cost = cost;
    }
    readFieldPurchaseReceiptPhotos(meta).forEach((photo) => {
      const photoKey = `${photo.name}|${photo.url || ''}|${photo.dataUrl || ''}`;
      if (seenPhotos.has(photoKey)) return;
      seenPhotos.add(photoKey);
      merged.receiptPhotos.push(photo);
    });
  });
  return merged;
}

function normalizeFieldPurchaseVeryfiMeta(rawValue) {
  if (!rawValue || typeof rawValue !== 'object') return null;
  const warnings = Array.isArray(rawValue.warnings)
    ? rawValue.warnings.map((entry) => normalizeVeryfiScalar(entry)).filter(Boolean).slice(0, 5)
    : [];
  return {
    documentId: rawValue.documentId || rawValue.id || null,
    externalId: normalizeVeryfiScalar(rawValue.externalId || ''),
    vendor: normalizeVeryfiScalar(rawValue.vendor || ''),
    receiptNumber: normalizeVeryfiScalar(rawValue.receiptNumber || ''),
    total: normalizeVeryfiNumber(rawValue.total),
    currencyCode: normalizeVeryfiScalar(rawValue.currencyCode || ''),
    date: normalizeVeryfiDate(rawValue.date || ''),
    documentType: normalizeVeryfiScalar(rawValue.documentType || ''),
    matchedLineCount: Math.max(0, Number(rawValue.matchedLineCount || 0) || 0),
    extractedLineCount: Math.max(0, Number(rawValue.extractedLineCount || 0) || 0),
    warnings
  };
}

function prepareFieldPurchaseReceiptPhotos(rawPhotos) {
  const photos = Array.isArray(rawPhotos) ? rawPhotos : [];
  if (!photos.length) return [];
  if (photos.length > FIELD_PURCHASE_RECEIPT_PHOTO_LIMIT) throw new Error(`only ${FIELD_PURCHASE_RECEIPT_PHOTO_LIMIT} receipt photos allowed`);
  const normalized = photos.map((photo, index) => {
    const dataUrl = String(photo?.dataUrl || '').trim();
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
    if (!match) throw new Error(`receipt photo ${index + 1} must be a jpg, png, or webp image`);
    const type = match[1].toLowerCase();
    const normalizedDataUrl = `data:${type};base64,${match[2].replace(/\s+/g, '')}`;
    const sizeBytes = estimateReceiptPhotoBytes(normalizedDataUrl);
    if (!sizeBytes) throw new Error(`receipt photo ${index + 1} is empty`);
    if (sizeBytes > FIELD_PURCHASE_RECEIPT_PHOTO_MAX_BYTES) throw new Error(`receipt photo ${index + 1} is too large`);
    const width = Number(photo?.width || 0);
    const height = Number(photo?.height || 0);
    return {
      name: String(photo?.name || `receipt-${index + 1}.jpg`).trim().slice(0, 120) || `receipt-${index + 1}.jpg`,
      type,
      sizeBytes,
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
      normalizedDataUrl
    };
  });
  const totalBytes = normalized.reduce((sum, photo) => sum + Number(photo.sizeBytes || 0), 0);
  if (totalBytes > FIELD_PURCHASE_RECEIPT_PHOTO_TOTAL_BYTES) throw new Error('receipt photos are too large together');
  return normalized;
}

function normalizeFieldPurchaseReceiptPhotos(rawPhotos, batchId = '') {
  const normalized = prepareFieldPurchaseReceiptPhotos(rawPhotos);
  return normalized.map((photo, index) => persistFieldPurchaseReceiptPhoto({
    batchId,
    index,
    type: photo.type,
    normalizedDataUrl: photo.normalizedDataUrl,
    name: photo.name,
    sizeBytes: photo.sizeBytes,
    width: photo.width,
    height: photo.height
  }));
}

app.post('/api/field-purchase/veryfi-process', async (req, res) => {
  if (!isVeryfiConfigured()) {
    return res.status(503).json({ error: 'Veryfi is not configured on this server.' });
  }
  if (typeof fetch !== 'function') {
    return res.status(500).json({ error: 'This Node runtime does not support outbound fetch. Use Node 18 or newer.' });
  }
  try {
    const batchId = String(req.body?.batchId || '').trim().slice(0, 120) || `field-purchase-${newId()}`;
    const preparedPhotos = prepareFieldPurchaseReceiptPhotos(req.body?.receiptPhotos);
    if (!preparedPhotos.length) {
      return res.status(400).json({ error: 'Attach at least one receipt photo before scanning with Veryfi.' });
    }
    const targetPhoto = preparedPhotos[0];
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(new Error('Veryfi request timed out')), VERYFI_TIMEOUT_MS) : null;
    let upstream;
    try {
      upstream = await fetch(VERYFI_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'CLIENT-ID': VERYFI_CLIENT_ID,
          AUTHORIZATION: VERYFI_AUTHORIZATION
        },
        body: JSON.stringify({
          external_id: batchId,
          file_data: targetPhoto.normalizedDataUrl,
          file_name: targetPhoto.name,
          document_type: 'receipt',
          country: String(req.body?.country || 'US').trim().toUpperCase() || 'US',
          boost_mode: false,
          async: false,
          compute: true,
          auto_delete: true,
          max_pages_to_process: 1
        }),
        ...(controller ? { signal: controller.signal } : {})
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const rawText = await upstream.text();
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch (e) {
        payload = null;
      }
    }
    if (!upstream.ok) {
      const message = payload?.error || payload?.detail || rawText || `Veryfi request failed with status ${upstream.status}`;
      return res.status(upstream.status || 502).json({ error: message });
    }
    const extracted = summarizeVeryfiDocument(payload || {}, { attachedPhotoCount: preparedPhotos.length });
    return res.json({ extracted });
  } catch (e) {
    const message = e?.name === 'AbortError'
      ? 'Veryfi request timed out.'
      : (e.message || 'Unable to process receipt with Veryfi.');
    return res.status(/timed out/i.test(message) ? 504 : 500).json({ error: message });
  }
});

app.get('/api/field-purchases', async (req, res) => {
  try {
    const t = tenantId(req);
    const rows = await allAsync(
      `SELECT * FROM inventory
       WHERE tenantId=$1
         AND sourceType='purchase'
         AND type IN ('purchase','in')
       ORDER BY ts DESC, id DESC`,
      [t]
    );
    const groups = new Map();
    const ensureGroup = (key) => {
      if (!groups.has(key)) groups.set(key, { events: [], purchases: [] });
      return groups.get(key);
    };
    (rows || []).forEach((row) => {
      const meta = parseFieldPurchaseSourceMeta(row?.sourcemeta || row?.sourceMeta || {});
      const batchId = String(meta.batchId || meta.batchid || '').trim();
      const purchaseKey = row.type === 'purchase'
        ? String(row.id || '').trim()
        : String(row.sourceid || row.sourceId || '').trim();
      const groupKey = batchId || purchaseKey || String(row.id || '').trim();
      if (!groupKey) return;
      const group = ensureGroup(groupKey);
      group.events.push(row);
      if (row.type === 'purchase') group.purchases.push(row);
    });
    const output = [];
    groups.forEach((group) => {
      if (!group.purchases.length) return;
      const mergedMeta = mergeFieldPurchaseSourceMeta(group.events);
      group.purchases.forEach((purchase) => {
        const purchaseMeta = parseFieldPurchaseSourceMeta(purchase?.sourcemeta || purchase?.sourceMeta || {});
        output.push({
          ...purchase,
          sourceMeta: {
            ...purchaseMeta,
            ...mergedMeta,
            receiptPhotos: mergedMeta.receiptPhotos
          }
        });
      });
    });
    output.sort((left, right) => Number(right?.ts || 0) - Number(left?.ts || 0));
    res.json(output);
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// FIELD PURCHASES (employee intake)
app.post('/api/field-purchase', async (req, res) => {
  try {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!lines.length) return res.status(400).json({ error: 'lines array required' });
    const t = tenantId(req);
    const actor = actorInfo(req);
    const batchId = String(req.body?.batchId || '').trim().slice(0, 120) || `field-purchase-${newId()}`;
    const receiptPhotos = normalizeFieldPurchaseReceiptPhotos(req.body?.receiptPhotos, batchId);
    const veryfiMeta = normalizeFieldPurchaseVeryfiMeta(req.body?.veryfi);
    const results = [];
    let lowStockNotifications = [];
    let deduped = false;
    let savedReceiptPhotoCount = 0;
    let savedReceiptPhotos = [];
    await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${t}:${batchId}`]);
      const existingPurchasesRes = await client.query(
        `SELECT * FROM inventory
         WHERE tenantId=$1
           AND type='purchase'
           AND sourceType='purchase'
           AND COALESCE(sourceMeta->>'batchId','')=$2
         ORDER BY ts ASC, id ASC`,
        [t, batchId]
      );
      const existingPurchases = existingPurchasesRes.rows || [];
      if (existingPurchases.length) {
        deduped = true;
        const mergedExistingMeta = mergeFieldPurchaseSourceMeta(existingPurchases);
        savedReceiptPhotos = mergedExistingMeta.receiptPhotos;
        savedReceiptPhotoCount = savedReceiptPhotos.length;
        if (receiptPhotos.length && !savedReceiptPhotoCount) {
          throw new Error('receipt photos were not saved to this purchase batch');
        }
        const purchaseIds = existingPurchases.map((row) => row.id);
        const existingCheckins = purchaseIds.length
          ? (await client.query(
              `SELECT * FROM inventory
               WHERE tenantId=$1
                 AND type='in'
                 AND sourceType='purchase'
                 AND sourceId = ANY($2::text[])`,
              [t, purchaseIds]
            )).rows || []
          : [];
        const checkinsBySourceId = new Map(existingCheckins.map((row) => [row.sourceid || row.sourceId || '', row]));
        existingPurchases.forEach((purchase) => {
          results.push({ purchase, checkin: checkinsBySourceId.get(purchase.id) || null });
        });
        return;
      }
      for (const line of lines) {
        const code = (line?.code || '').trim();
        const name = (line?.name || '').trim();
        const category = (line?.category || '').trim();
        const qtyNum = Number(line?.qty || 0);
        if (!code || !qtyNum || qtyNum <= 0) throw new Error(`Invalid line for code ${code || ''}`);
        if (!name) throw new Error(`Name required for new purchase (${code})`);
        const jobIdVal = normalizeJobId(line?.jobId || req.body?.jobId || '') || null;
        const location = (line?.location || req.body?.location || '').trim();
        const locationType = line?.locationType || req.body?.locationType || '';
        const locationRef = line?.locationRef || req.body?.locationRef || '';
        const notes = (line?.notes || req.body?.notes || '').trim();
        const tsVal = line?.ts || req.body?.purchasedAt || Date.now();
        const unitPrice = line?.unitPrice ?? null;
        const categoryInfo = await getItemCategoryRulesTx(client, t, code, category);
        enforceCategoryRules(categoryInfo.rules, { action: 'field-purchase', jobId: jobIdVal, location, notes, qty: qtyNum });
        const sourceMeta = {
          batchId,
          vendor: line?.vendor || req.body?.vendor || '',
          receipt: line?.receipt || req.body?.receipt || '',
          ...(receiptPhotos.length ? { receiptPhotos } : {}),
          ...(veryfiMeta ? { veryfi: veryfiMeta } : {}),
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
          locationType,
          locationRef,
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
          locationType,
          locationRef,
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
              location,
              locationType,
              locationRef,
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
      const savedPurchasesRes = await client.query(
        `SELECT * FROM inventory
         WHERE tenantId=$1
           AND type='purchase'
           AND sourceType='purchase'
           AND COALESCE(sourceMeta->>'batchId','')=$2
         ORDER BY ts ASC, id ASC`,
        [t, batchId]
      );
      const savedPurchases = savedPurchasesRes.rows || [];
      const mergedSavedMeta = mergeFieldPurchaseSourceMeta(savedPurchases);
      savedReceiptPhotos = mergedSavedMeta.receiptPhotos;
      savedReceiptPhotoCount = savedReceiptPhotos.length;
      if (receiptPhotos.length && !savedReceiptPhotoCount) {
        throw new Error('receipt photos were not saved to the purchase records');
      }
      lowStockNotifications = await collectLowStockTransitionsTx(client, t, lines.map((line) => line?.code));
    });
    if (!deduped) {
      await logAudit({ tenantId: t, userId: currentUserId(req), action: 'inventory.in', details: { sourceType: 'purchase', count: results.length } });
      if (lowStockNotifications.length) await sendLowStockAlertEmails({ tenantId: t, items: lowStockNotifications });
    }
    res.status(deduped ? 200 : 201).json({
      count: results.length,
      entries: results,
      batchId,
      deduped,
      savedReceiptPhotoCount,
      savedReceiptPhotos
    });
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
      await client.query('TRUNCATE tenant_capabilities');
      await client.query('TRUNCATE inventory_locations');
      await client.query('TRUNCATE items');
      await client.query('TRUNCATE suppliers');
      await client.query('TRUNCATE equipment_assets');
      await client.query('TRUNCATE vehicle_assets');
      await client.query('TRUNCATE job_materials');
      await client.query('TRUNCATE jobs');
      await client.query('TRUNCATE users');
      await client.query('TRUNCATE sessions');
      await client.query('TRUNCATE auth_tokens');
      await client.query('TRUNCATE categories');
      await client.query("DELETE FROM tenants WHERE id <> 'default'");
      await client.query(`INSERT INTO tenants(id,code,name,createdAt) VALUES('default','default','Default Tenant',$1)
        ON CONFLICT (id) DO NOTHING`, [Date.now()]);
      await client.query(
        `INSERT INTO categories(id,name,rules,tenantId,createdAt,updatedAt)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [newId(), DEFAULT_CATEGORY_NAME, DEFAULT_CATEGORY_RULES, 'default', Date.now(), Date.now()]
      );
      await client.query(
        `INSERT INTO tenant_capabilities(
          tenant_id, ims_enabled, oms_enabled, bms_enabled, fms_enabled,
          automation_enabled, insights_enabled, audit_enabled, integration_enabled,
          end_to_end_ops, financial_accuracy, enterprise_governance,
          created_at, updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [
          'default',
          DEFAULT_TENANT_CAPS.ims_enabled,
          DEFAULT_TENANT_CAPS.oms_enabled,
          DEFAULT_TENANT_CAPS.bms_enabled,
          DEFAULT_TENANT_CAPS.fms_enabled,
          DEFAULT_TENANT_CAPS.automation_enabled,
          DEFAULT_TENANT_CAPS.insights_enabled,
          DEFAULT_TENANT_CAPS.audit_enabled,
          DEFAULT_TENANT_CAPS.integration_enabled,
          DEFAULT_TENANT_CAPS.end_to_end_ops,
          DEFAULT_TENANT_CAPS.financial_accuracy,
          DEFAULT_TENANT_CAPS.enterprise_governance,
          Date.now()
        ]
      );
      const adminPwd = 'ChangeMe123!';
      const adminHash = await hashPassword(adminPwd);
      const devHash = await hashPassword(DEV_PASSWORD);
      await client.query('INSERT INTO users(id,email,name,role,salt,hash,createdAt,emailVerified,emailVerifiedAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [newId(), 'admin@example.com', 'Admin', 'admin', adminHash.salt, adminHash.hash, Date.now(), true, Date.now(), 'default']);
      await client.query('INSERT INTO users(id,email,name,role,salt,hash,createdAt,emailVerified,emailVerifiedAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [newId(), DEV_EMAIL, 'Dev', 'admin', devHash.salt, devHash.hash, Date.now(), true, Date.now(), 'default']);
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
      await client.query('DELETE FROM inventory_counts WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM support_tickets WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM auth_tokens WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM tenant_capabilities WHERE tenant_id=$1', [tenant.id]);
      await client.query('DELETE FROM inventory_locations WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM equipment_assets WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM vehicle_assets WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM items WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM suppliers WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM job_materials WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM jobs WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM categories WHERE tenantId=$1', [tenant.id]);
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

app.get('/api/dashboard/admin', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const [metricsRow, lowStockRows, activityRows, items, counts, orderRows, checkins, returnRows, movementRows, stockRows] = await Promise.all([
      getAsync(`
        SELECT
          COALESCE(SUM(CASE WHEN type='in' THEN qty WHEN type='return' THEN qty WHEN type='reserve_release' THEN qty WHEN type='out' THEN -qty WHEN type='reserve' THEN -qty ELSE 0 END),0) as availableunits,
          COALESCE(SUM(CASE WHEN type='reserve' THEN qty WHEN type='reserve_release' THEN -qty ELSE 0 END),0) as reservedunits,
          COALESCE(COUNT(DISTINCT CASE WHEN jobId IS NOT NULL AND jobId != '' THEN jobId END),0) as activejobs
        FROM inventory
        WHERE tenantId=$1
      `, [t]),
      allAsync(`
        SELECT i.code, i.name,
          COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='reserve_release' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) as available,
          COALESCE(SUM(CASE WHEN inv.type='reserve' THEN inv.qty WHEN inv.type='reserve_release' THEN -inv.qty ELSE 0 END),0) as reserve
        FROM items i
        LEFT JOIN inventory inv ON inv.code = i.code AND inv.tenantId = i.tenantId
        LEFT JOIN categories c ON c.tenantId = i.tenantId AND LOWER(c.name)=LOWER(COALESCE(NULLIF(i.category,''), $2))
        WHERE i.tenantId=$1
          AND COALESCE(i.lowStockEnabled, (c.rules->>'lowStockEnabled')::boolean, false) = true
        GROUP BY i.code, i.name, c.rules
        HAVING COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='reserve_release' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) > 0
          AND COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='reserve_release' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) <= COALESCE((c.rules->>'lowStockThreshold')::int, $3)
        ORDER BY available ASC
        LIMIT 20
      `, [t, DEFAULT_CATEGORY_NAME, DEFAULT_CATEGORY_RULES.lowStockThreshold]),
      allAsync('SELECT type, code, qty, jobId, ts FROM inventory WHERE tenantId=$1 ORDER BY ts DESC LIMIT 20', [t]),
      allAsync('SELECT code, name FROM items WHERE tenantId=$1 ORDER BY name ASC', [t]),
      allAsync('SELECT code, countedAt, ts FROM inventory_counts WHERE tenantId=$1', [t]),
      allAsync("SELECT id, sourceId, code, name, qty, jobId, eta, ts FROM inventory WHERE tenantId=$1 AND type='ordered' ORDER BY ts DESC", [t]),
      allAsync("SELECT sourceId, code, name, qty, jobId, ts, type FROM inventory WHERE tenantId=$1 AND type='in' ORDER BY ts DESC", [t]),
      allAsync("SELECT code, qty, jobId, returnDate, ts, type FROM inventory WHERE tenantId=$1 AND type IN ('out','return') ORDER BY ts DESC", [t]),
      allAsync("SELECT code, name, qty, type, ts FROM inventory WHERE tenantId=$1 AND ts >= $2 AND type IN ('in','out','return','reserve','reserve_release','purchase','consume')", [t, Date.now() - 7 * 24 * 60 * 60 * 1000]),
      allAsync("SELECT code, name, qty, type FROM inventory WHERE tenantId=$1 AND type IN ('in','out','return','reserve','reserve_release')", [t]),
    ]);

    const itemMap = new Map((items || []).map((item) => [item.code, item]));
    const stock = dashboardAggregateStock(stockRows || []);
    const openOrders = dashboardBuildOpenOrders(orderRows || [], checkins || []);
    const overdueRows = dashboardBuildOverdueRows(returnRows || []);
    const topMovers = dashboardBuildTopMovers(movementRows || [], itemMap, stock.byCode);
    const countDueRows = dashboardBuildCountDueRows(items || [], counts || []);
    const chart = dashboardBuildChartBuckets(activityRows || [], 7);

    res.json({
      metrics: {
        availableUnits: Number(metricsRow?.availableunits || 0),
        checkedOutUnits: stock.totals.checkedOut,
        reservedUnits: Number(metricsRow?.reservedunits || 0),
        activeJobs: Number(metricsRow?.activejobs || 0),
        lowStockCount: (lowStockRows || []).length,
        openOrdersCount: openOrders.length,
        overdueCount: overdueRows.length,
        outOfStockCount: stock.list.filter((item) => item.available <= 0).length,
        countDueCount: countDueRows.length,
      },
      lowStock: lowStockRows || [],
      activity: (activityRows || []).slice(0, 8),
      openOrders: openOrders.sort((a, b) => (dashboardParseTs(a.eta) || a.lastOrderTs || 0) - (dashboardParseTs(b.eta) || b.lastOrderTs || 0)).slice(0, 8),
      overdue: overdueRows.sort((a, b) => b.daysLate - a.daysLate).slice(0, 8),
      topMovers,
      countDue: countDueRows.slice(0, 8),
      chart,
    });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/dashboard/manager', async (req, res) => {
  try {
    const t = tenantId(req);
    const parsedDays = Number(req.query.days);
    const parsedUntil = Number(req.query.until);
    const windowDays = Number.isFinite(parsedDays) && parsedDays > 0 ? Math.floor(parsedDays) : 30;
    const untilTs = Number.isFinite(parsedUntil) && parsedUntil > 0 ? parsedUntil : Date.now();
    const eventStart = untilTs - windowDays * 24 * 60 * 60 * 1000;
    const [inventory, counts, items, categories, pickEvents, checkinEvents] = await Promise.all([
      allAsync('SELECT code, qty, jobId, ts, type, status, reason, returnDate, sourceType, sourceId, userEmail, userName FROM inventory WHERE tenantId=$1 ORDER BY ts DESC', [t]),
      allAsync('SELECT code, qty, countedAt, ts FROM inventory_counts WHERE tenantId=$1', [t]),
      allAsync('SELECT code, name, category, unitPrice, reorderPoint, lowStockEnabled FROM items WHERE tenantId=$1 ORDER BY name ASC', [t]),
      allAsync('SELECT name, rules FROM categories WHERE tenantId=$1', [t]),
      allAsync(
        `SELECT id, action, details, ts
         FROM audit_events
         WHERE tenantId=$1 AND action='ops.pick.finish' AND ts >= $2 AND ts <= $3
         ORDER BY ts DESC`,
        [t, eventStart, untilTs]
      ),
      allAsync(
        `SELECT id, action, details, ts
         FROM audit_events
         WHERE tenantId=$1 AND action='ops.checkin.finish' AND ts >= $2 AND ts <= $3
         ORDER BY ts DESC`,
        [t, eventStart, untilTs]
      ),
    ]);
    const metrics = dashboardComputeManagerMetrics({
      inventory: inventory || [],
      counts: counts || [],
      items: items || [],
      categories: categories || [],
      pickEvents: pickEvents || [],
      checkinEvents: checkinEvents || [],
    }, {
      windowDays,
      nowTs: untilTs,
    });
    res.json(metrics);
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/workflows/overview', async (req, res) => {
  try {
    const t = tenantId(req);
    const [jobs, materials, items, suppliers, categories, inventory, counts] = await Promise.all([
      readJobs(t),
      readAllJobMaterials(t),
      readItems(t),
      readSuppliers(t),
      readCategories(t),
      allAsync(
        `SELECT id, code, name, qty, type, jobId, returnDate, eta, ts, status, sourceId, sourceType
         FROM inventory
         WHERE tenantId=$1
         ORDER BY ts DESC`,
        [t]
      ),
      allAsync('SELECT code, qty, countedAt, ts FROM inventory_counts WHERE tenantId=$1', [t]),
    ]);
    res.json(workflowBuildOverview({
      jobs: jobs || [],
      materials: materials || [],
      items: items || [],
      suppliers: suppliers || [],
      categories: categories || [],
      inventory: inventory || [],
      counts: counts || [],
    }));
  } catch (e) {
    res.status(500).json({ error: 'server error' });
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
        AND COALESCE(i.lowStockEnabled, (c.rules->>'lowStockEnabled')::boolean, false) = true
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
        AND COALESCE(i.lowStockEnabled, (c.rules->>'lowStockEnabled')::boolean, false) = true
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

app.get('/api/export/purchase-history', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const rows = await allAsync(
      `SELECT * FROM inventory
       WHERE tenantId=$1 AND type='purchase'
       ORDER BY ts DESC, id DESC`,
      [t]
    );
    if (!rows.length) return res.status(400).json({ error: 'no data' });
    const exportRows = rows.map((row) => {
      const meta = parseFieldPurchaseSourceMeta(row.sourcemeta || row.sourceMeta || {});
      const photos = readFieldPurchaseReceiptPhotos(meta);
      return {
        batchId: meta.batchId || meta.batchid || row.sourceid || row.sourceId || row.id || '',
        code: row.code || '',
        name: row.name || '',
        qty: row.qty || 0,
        vendor: meta.vendor || meta.Vendor || '',
        receipt: meta.receipt || meta.receiptNumber || meta.receiptnumber || '',
        receiptPhotoCount: photos.length,
        cost: meta.cost ?? meta.unitCost ?? meta.unitcost ?? '',
        location: row.location || '',
        locationType: row.locationtype || row.locationType || '',
        locationRef: row.locationref || row.locationRef || '',
        jobId: row.jobid || row.jobId || '',
        notes: row.notes || '',
        purchasedAt: row.ts || meta.purchasedAt || meta.purchasedat || '',
        createdBy: row.useremail || row.userEmail || ''
      };
    });
    const parser = new Parser();
    const csv = parser.parse(exportRows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="purchase-history.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/export/suppliers', requireRole('admin'), async (req, res) => {
  try {
    const rows = await readSuppliers(tenantId(req));
    if (!rows.length) return res.status(400).json({ error: 'no data' });
    const parser = new Parser();
    const csv = parser.parse(rows.map(normalizeSupplierRow));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="suppliers.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/export/locations', requireRole('admin'), async (req, res) => {
  try {
    const rows = await listManagedInventoryLocations(tenantId(req));
    if (!rows.length) return res.status(400).json({ error: 'no data' });
    const exportRows = rows.map((row) => ({
      id: row.id || '',
      ref: row.ref || '',
      name: row.name || '',
      label: row.label || '',
      type: row.type || '',
      parentId: row.parentId || '',
      parentName: row.parentName || '',
      depth: row.depth || 0,
      sortOrder: row.sortOrder || 0,
      isActive: row.isActive !== false,
      isConsumptionPoint: row.isConsumptionPoint === true,
      notes: row.notes || '',
      createdAt: row.createdAt || '',
      updatedAt: row.updatedAt || ''
    }));
    const parser = new Parser();
    const csv = parser.parse(exportRows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="locations.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/export/pilot-snapshot', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const exportedAt = Date.now();
    const [
      tenantRow,
      capabilities,
      users,
      categories,
      suppliers,
      items,
      jobs,
      jobMaterials,
      locations,
      equipment,
      vehicles,
      counts,
      webhooks,
      webhookEvents,
      inventory,
      audits
    ] = await Promise.all([
      getAsync('SELECT id, code, name, createdAt FROM tenants WHERE id=$1', [t]),
      getAsync('SELECT * FROM tenant_capabilities WHERE tenant_id=$1', [t]),
      allAsync(
        `SELECT id, email, name, role, createdAt, emailVerified, emailVerifiedAt, invitedAt, notificationPrefs
         FROM users
         WHERE tenantId=$1
         ORDER BY createdAt ASC, email ASC`,
        [t]
      ),
      allAsync('SELECT * FROM categories WHERE tenantId=$1 ORDER BY name ASC', [t]),
      allAsync('SELECT * FROM suppliers WHERE tenantId=$1 ORDER BY name ASC', [t]),
      allAsync('SELECT * FROM items WHERE tenantId=$1 ORDER BY code ASC', [t]),
      allAsync('SELECT * FROM jobs WHERE tenantId=$1 ORDER BY code ASC', [t]),
      allAsync('SELECT * FROM job_materials WHERE tenantId=$1 ORDER BY jobId ASC, code ASC', [t]),
      allAsync('SELECT * FROM inventory_locations WHERE tenantId=$1 ORDER BY sortOrder ASC, name ASC', [t]),
      allAsync('SELECT * FROM equipment_assets WHERE tenantId=$1 ORDER BY name ASC NULLS LAST, code ASC', [t]),
      allAsync('SELECT * FROM vehicle_assets WHERE tenantId=$1 ORDER BY name ASC NULLS LAST, code ASC', [t]),
      allAsync('SELECT * FROM inventory_counts WHERE tenantId=$1 ORDER BY countedAt DESC, code ASC', [t]),
      allAsync(
        `SELECT id, tenantId, name, source, isActive, notes, createdAt, updatedAt, lastReceivedAt
         FROM inbound_webhook_endpoints
         WHERE tenantId=$1
         ORDER BY createdAt DESC`,
        [t]
      ),
      allAsync(
        `SELECT id, endpointId, tenantId, source, eventType, externalId, payload, status, receivedAt
         FROM inbound_webhook_events
         WHERE tenantId=$1
         ORDER BY receivedAt DESC
         LIMIT 250`,
        [t]
      ),
      allAsync('SELECT * FROM inventory WHERE tenantId=$1 ORDER BY ts ASC, id ASC', [t]),
      allAsync(
        `SELECT id, action, details, ts, userId
         FROM audit_events
         WHERE tenantId=$1
         ORDER BY ts DESC
         LIMIT 1000`,
        [t]
      )
    ]);

    const payload = {
      exportedAt,
      exportedAtIso: new Date(exportedAt).toISOString(),
      tenant: tenantRow || { id: t },
      summary: {
        users: users.length,
        categories: categories.length,
        suppliers: suppliers.length,
        items: items.length,
        jobs: jobs.length,
        jobMaterials: jobMaterials.length,
        inventoryLocations: locations.length,
        equipmentAssets: equipment.length,
        vehicleAssets: vehicles.length,
        inventoryCounts: counts.length,
        webhooks: webhooks.length,
        webhookEvents: webhookEvents.length,
        inventoryEvents: inventory.length,
        auditEvents: audits.length
      },
      data: {
        capabilities: capabilities || null,
        users,
        categories,
        suppliers,
        items,
        jobs,
        jobMaterials,
        inventoryLocations: locations,
        equipmentAssets: equipment,
        vehicleAssets: vehicles,
        inventoryCounts: counts,
        inboundWebhooks: webhooks,
        recentWebhookEvents: webhookEvents,
        inventory,
        recentAuditEvents: audits
      }
    };

    const stamp = new Date(exportedAt).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="pilot-snapshot-${stamp}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/notifications', async (req, res) => {
  try {
    const t = tenantId(req);
    const rows = await allAsync('SELECT * FROM audit_events WHERE tenantId=$1 ORDER BY ts DESC LIMIT 20', [t]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.get('/api/analytics/audit', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const parsedDays = Number(req.query.days);
    const parsedLimit = Number(req.query.limit);
    const days = Number.isFinite(parsedDays) && parsedDays > 0 ? Math.min(Math.floor(parsedDays), 365) : 30;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), 2000) : 600;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = await allAsync(`
      SELECT a.id, a.action, a.details, a.ts, u.email as userEmail, u.name as userName
      FROM audit_events a
      LEFT JOIN users u ON u.id = a.userId
      WHERE a.tenantId=$1 AND a.ts >= $2
      ORDER BY a.ts DESC
      LIMIT $3
    `, [t, cutoff, limit]);
    const events = (rows || []).map((row) => auditNormalizeEntry(row));
    const actions = Array.from(new Set(events.map((row) => row.action).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    res.json({
      generatedAt: Date.now(),
      days,
      total: events.length,
      actions,
      events,
    });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
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

app.get('/api/capabilities', requireRole('admin'), async (req, res) => {
  try {
    const caps = await getTenantCapabilities(tenantId(req));
    res.json(caps);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

function fleetTrimText(value) {
  return String(value ?? '').trim();
}

function fleetOptionalText(value) {
  const text = fleetTrimText(value);
  return text || null;
}

function fleetParseInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
}

function fleetParseTsInput(value) {
  const text = fleetTrimText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T12:00:00Z`);
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
}

function fleetNormalizeTags(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((tag) => fleetTrimText(tag)).filter(Boolean);
  return String(value)
    .split(/[,;|]/)
    .map((tag) => fleetTrimText(tag))
    .filter(Boolean);
}
function fleetSerializeTags(value) {
  return JSON.stringify(fleetNormalizeTags(value));
}

function fleetNormalizeEquipmentPayload(body = {}) {
  const code = fleetTrimText(body.code);
  const name = fleetTrimText(body.name);
  if (!code || !name) return { error: 'code and name required' };
  return {
    code,
    name,
    category: fleetOptionalText(body.category),
    location: fleetOptionalText(body.location),
    status: fleetOptionalText(body.status) || 'active',
    serial: fleetOptionalText(body.serial),
    model: fleetOptionalText(body.model),
    manufacturer: fleetOptionalText(body.manufacturer),
    purchaseDate: fleetOptionalText(body.purchaseDate),
    warrantyEnd: fleetOptionalText(body.warrantyEnd),
    usageHours: fleetParseInt(body.usageHours),
    lastServiceAt: fleetParseTsInput(body.lastServiceAt),
    nextServiceAt: fleetParseTsInput(body.nextServiceAt),
    lastActivityAt: fleetParseTsInput(body.lastActivityAt),
    assignedProject: fleetOptionalText(body.assignedProject),
    notes: fleetOptionalText(body.notes),
    tags: fleetNormalizeTags(body.tags)
  };
}

function fleetNormalizeVehiclePayload(body = {}) {
  const code = fleetTrimText(body.code);
  const name = fleetTrimText(body.name);
  if (!code || !name) return { error: 'code and name required' };
  return {
    code,
    name,
    make: fleetOptionalText(body.make),
    model: fleetOptionalText(body.model),
    year: fleetParseInt(body.year),
    vin: fleetOptionalText(body.vin),
    plate: fleetOptionalText(body.plate),
    location: fleetOptionalText(body.location),
    consumptionLocationId: fleetOptionalText(body.consumptionLocationId),
    status: fleetOptionalText(body.status) || 'active',
    mileage: fleetParseInt(body.mileage),
    lastServiceAt: fleetParseTsInput(body.lastServiceAt),
    nextServiceAt: fleetParseTsInput(body.nextServiceAt),
    lastActivityAt: fleetParseTsInput(body.lastActivityAt),
    assignedProject: fleetOptionalText(body.assignedProject),
    notes: fleetOptionalText(body.notes),
    tags: fleetNormalizeTags(body.tags)
  };
}

function fleetConflictMessage(err, fallback) {
  if (err?.code === '23505') return fallback;
  return err?.message || 'server error';
}

function mapVehicleAssetRow(row, statsByRef = new Map()) {
  const consumptionLocationRef = row.consumptionlocationref || row.consumptionLocationRef || '';
  const stats = consumptionLocationRef ? (statsByRef.get(consumptionLocationRef) || null) : null;
  return {
    ...row,
    consumptionLocationId: row.consumptionlocationid || row.consumptionLocationId || null,
    consumptionLocationRef: consumptionLocationRef || null,
    consumptionLocationName: row.consumptionlocationname || row.consumptionLocationName || '',
    consumptionQty: Number(stats?.qty || 0) || 0,
    consumptionLines: Number(stats?.lines || 0) || 0,
    lastConsumedAt: stats?.lastts || stats?.lastTs || null
  };
}

async function listFleetVehiclesWithConsumption(tenantIdVal) {
  const rows = await allAsync(
    `SELECT v.*,
            loc.ref AS consumptionLocationRef,
            loc.name AS consumptionLocationName
       FROM vehicle_assets v
       LEFT JOIN inventory_locations loc
         ON loc.id = v.consumptionLocationId
        AND loc.tenantId = v.tenantId
      WHERE v.tenantId=$1
      ORDER BY v.name ASC NULLS LAST, v.code ASC`,
    [tenantIdVal]
  );
  const refs = [...new Set((rows || []).map((row) => row.consumptionlocationref || row.consumptionLocationRef).filter(Boolean))];
  const statsByRef = new Map();
  if (refs.length) {
    const statsRows = await allAsync(
      `SELECT locationRef, SUM(qty)::numeric AS qty, COUNT(*)::int AS lines, MAX(ts) AS lastTs
         FROM inventory
        WHERE tenantId=$1
          AND type='consume'
          AND locationRef = ANY($2::text[])
        GROUP BY locationRef`,
      [tenantIdVal, refs]
    );
    for (const row of statsRows || []) {
      const ref = String(row.locationref || row.locationRef || '').trim();
      if (ref) statsByRef.set(ref, row);
    }
  }
  return (rows || []).map((row) => mapVehicleAssetRow(row, statsByRef));
}

app.get('/api/fleet/equipment', async (req, res) => {
  try {
    const rows = await allAsync(
      'SELECT * FROM equipment_assets WHERE tenantId=$1 ORDER BY name ASC NULLS LAST, code ASC',
      [tenantId(req)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/fleet/equipment', requireRole('admin'), async (req, res) => {
  try {
    const payload = fleetNormalizeEquipmentPayload(req.body || {});
    if (payload.error) return res.status(400).json({ error: payload.error });
    const t = tenantId(req);
    const id = newId();
    const row = {
      id,
      tenantId: t,
      ...payload
    };
    await runAsync(
      `INSERT INTO equipment_assets(
        id, code, name, category, location, status, serial, model, manufacturer,
        purchaseDate, warrantyEnd, usageHours, lastServiceAt, nextServiceAt, lastActivityAt,
        assignedProject, notes, tags, tenantId
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        row.id,
        row.code,
        row.name,
        row.category,
        row.location,
        row.status,
        row.serial,
        row.model,
        row.manufacturer,
        row.purchaseDate,
        row.warrantyEnd,
        row.usageHours,
        row.lastServiceAt,
        row.nextServiceAt,
        row.lastActivityAt,
        row.assignedProject,
        row.notes,
        fleetSerializeTags(row.tags),
        row.tenantId
      ]
    );
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'fleet.equipment.create',
      details: { code: row.code, name: row.name, status: row.status, location: row.location || '' }
    });
    res.status(201).json(row);
  } catch (e) {
    res.status(e?.code === '23505' ? 409 : 500).json({ error: fleetConflictMessage(e, 'equipment code already exists') });
  }
});

app.put('/api/fleet/equipment/:id', requireRole('admin'), async (req, res) => {
  try {
    const payload = fleetNormalizeEquipmentPayload(req.body || {});
    if (payload.error) return res.status(400).json({ error: payload.error });
    const t = tenantId(req);
    const existing = await getAsync('SELECT id, code FROM equipment_assets WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    if (!existing) return res.status(404).json({ error: 'equipment not found' });
    await runAsync(
      `UPDATE equipment_assets SET
        code=$1, name=$2, category=$3, location=$4, status=$5, serial=$6, model=$7, manufacturer=$8,
        purchaseDate=$9, warrantyEnd=$10, usageHours=$11, lastServiceAt=$12, nextServiceAt=$13,
        lastActivityAt=$14, assignedProject=$15, notes=$16, tags=$17
       WHERE id=$18 AND tenantId=$19`,
      [
        payload.code,
        payload.name,
        payload.category,
        payload.location,
        payload.status,
        payload.serial,
        payload.model,
        payload.manufacturer,
        payload.purchaseDate,
        payload.warrantyEnd,
        payload.usageHours,
        payload.lastServiceAt,
        payload.nextServiceAt,
        payload.lastActivityAt,
        payload.assignedProject,
        payload.notes,
        fleetSerializeTags(payload.tags),
        req.params.id,
        t
      ]
    );
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'fleet.equipment.update',
      details: { code: payload.code, name: payload.name, status: payload.status, location: payload.location || '' }
    });
    res.json({ id: req.params.id, tenantId: t, ...payload });
  } catch (e) {
    res.status(e?.code === '23505' ? 409 : 500).json({ error: fleetConflictMessage(e, 'equipment code already exists') });
  }
});

app.delete('/api/fleet/equipment/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const existing = await getAsync('SELECT id, code, name FROM equipment_assets WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    if (!existing) return res.status(404).json({ error: 'equipment not found' });
    await runAsync('DELETE FROM equipment_assets WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'fleet.equipment.delete',
      details: { code: existing.code || '', name: existing.name || '' }
    });
    res.json({ ok: true, id: req.params.id });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
});

app.get('/api/fleet/vehicles', async (req, res) => {
  try {
    const rows = await listFleetVehiclesWithConsumption(tenantId(req));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/fleet/vehicles', requireRole('admin'), async (req, res) => {
  try {
    const payload = fleetNormalizeVehiclePayload(req.body || {});
    if (payload.error) return res.status(400).json({ error: payload.error });
    const t = tenantId(req);
    if (payload.consumptionLocationId) await getConsumptionPointLocationById(payload.consumptionLocationId, t);
    const id = newId();
    const row = {
      id,
      tenantId: t,
      ...payload
    };
    await runAsync(
      `INSERT INTO vehicle_assets(
        id, code, name, make, model, year, vin, plate, location, consumptionLocationId, status, mileage,
        lastServiceAt, nextServiceAt, lastActivityAt, assignedProject, notes, tags, tenantId
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        row.id,
        row.code,
        row.name,
        row.make,
        row.model,
        row.year,
        row.vin,
        row.plate,
        row.location,
        row.consumptionLocationId,
        row.status,
        row.mileage,
        row.lastServiceAt,
        row.nextServiceAt,
        row.lastActivityAt,
        row.assignedProject,
        row.notes,
        fleetSerializeTags(row.tags),
        row.tenantId
      ]
    );
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'fleet.vehicle.create',
      details: { code: row.code, name: row.name, status: row.status, location: row.location || '', consumptionLocationId: row.consumptionLocationId || '' }
    });
    const created = await listFleetVehiclesWithConsumption(t);
    res.status(201).json(created.find((entry) => entry.id === id) || row);
  } catch (e) {
    res.status(e?.code === '23505' ? 409 : 500).json({ error: fleetConflictMessage(e, 'vehicle code already exists') });
  }
});

app.put('/api/fleet/vehicles/:id', requireRole('admin'), async (req, res) => {
  try {
    const payload = fleetNormalizeVehiclePayload(req.body || {});
    if (payload.error) return res.status(400).json({ error: payload.error });
    const t = tenantId(req);
    const existing = await getAsync('SELECT id, code FROM vehicle_assets WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    if (!existing) return res.status(404).json({ error: 'vehicle not found' });
    if (payload.consumptionLocationId) await getConsumptionPointLocationById(payload.consumptionLocationId, t);
    await runAsync(
      `UPDATE vehicle_assets SET
        code=$1, name=$2, make=$3, model=$4, year=$5, vin=$6, plate=$7, location=$8, consumptionLocationId=$9, status=$10,
        mileage=$11, lastServiceAt=$12, nextServiceAt=$13, lastActivityAt=$14, assignedProject=$15, notes=$16, tags=$17
       WHERE id=$18 AND tenantId=$19`,
      [
        payload.code,
        payload.name,
        payload.make,
        payload.model,
        payload.year,
        payload.vin,
        payload.plate,
        payload.location,
        payload.consumptionLocationId,
        payload.status,
        payload.mileage,
        payload.lastServiceAt,
        payload.nextServiceAt,
        payload.lastActivityAt,
        payload.assignedProject,
        payload.notes,
        fleetSerializeTags(payload.tags),
        req.params.id,
        t
      ]
    );
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'fleet.vehicle.update',
      details: { code: payload.code, name: payload.name, status: payload.status, location: payload.location || '', consumptionLocationId: payload.consumptionLocationId || '' }
    });
    const rows = await listFleetVehiclesWithConsumption(t);
    res.json(rows.find((entry) => entry.id === req.params.id) || { id: req.params.id, tenantId: t, ...payload });
  } catch (e) {
    res.status(e?.code === '23505' ? 409 : 500).json({ error: fleetConflictMessage(e, 'vehicle code already exists') });
  }
});

app.delete('/api/fleet/vehicles/:id', requireRole('admin'), async (req, res) => {
  try {
    const t = tenantId(req);
    const existing = await getAsync('SELECT id, code, name FROM vehicle_assets WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    if (!existing) return res.status(404).json({ error: 'vehicle not found' });
    await runAsync('DELETE FROM vehicle_assets WHERE id=$1 AND tenantId=$2', [req.params.id, t]);
    await logAudit({
      tenantId: t,
      userId: currentUserId(req),
      action: 'fleet.vehicle.delete',
      details: { code: existing.code || '', name: existing.name || '' }
    });
    res.json({ ok: true, id: req.params.id });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
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
    try {
      const tenant = await getAsync('SELECT code,name FROM tenants WHERE id=$1', [t]);
      const tenantCode = tenant?.code || t || 'unknown';
      const tenantName = tenant?.name || '';
      const subjectLine = `[Support] ${tenantCode}: ${ticket.subject}`;
      const text = [
        `Tenant: ${tenantName} (${tenantCode})`,
        `Priority: ${ticket.priority}`,
        `From: ${ticket.userName || ticket.userEmail || 'Unknown'} (${ticket.userEmail || 'n/a'})`,
        `User ID: ${ticket.userId || 'n/a'}`,
        `Ticket ID: ${ticket.id}`,
        '',
        ticket.body || '(no message)'
      ].join('\n');
      const html = `
        <p><strong>Tenant:</strong> ${tenantName ? `${tenantName} (${tenantCode})` : tenantCode}</p>
        <p><strong>Priority:</strong> ${ticket.priority}</p>
        <p><strong>From:</strong> ${ticket.userName || ticket.userEmail || 'Unknown'} (${ticket.userEmail || 'n/a'})</p>
        <p><strong>User ID:</strong> ${ticket.userId || 'n/a'}</p>
        <p><strong>Ticket ID:</strong> ${ticket.id}</p>
        <hr />
        <pre style="white-space:pre-wrap;font-family:inherit">${ticket.body || '(no message)'}</pre>
      `;
      await sendEmail({ to: SUPPORT_INBOX, subject: subjectLine, text, html });
    } catch (e) {
      console.warn('Support email failed:', e.message);
    }
    res.status(201).json(ticket);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// SELLER ADMIN (dev-only)
function auditActionArea(action) {
  const normalized = String(action || '').toLowerCase();
  if (normalized.startsWith('inventory.')) return { key: 'inventory', label: 'Inventory' };
  if (normalized.startsWith('ops.')) return { key: 'operations', label: 'Operations' };
  if (normalized.startsWith('procurement.')) return { key: 'procurement', label: 'Procurement' };
  if (normalized.startsWith('webhooks.')) return { key: 'integrations', label: 'Integrations' };
  if (normalized.startsWith('fleet.')) return { key: 'fleet', label: 'Fleet' };
  if (normalized.startsWith('items.')) return { key: 'catalog', label: 'Catalog' };
  if (normalized.startsWith('suppliers.')) return { key: 'suppliers', label: 'Suppliers' };
  if (normalized.startsWith('projects.')) return { key: 'projects', label: 'Projects' };
  if (normalized.startsWith('auth.')) return { key: 'access', label: 'Access' };
  return { key: 'system', label: 'System' };
}

function auditActionLabel(action) {
  const normalized = String(action || '').toLowerCase();
  const actionMap = {
    'auth.login': 'User Login',
    'auth.register': 'User Registered',
    'inventory.in': 'Inventory Check-In',
    'inventory.out': 'Inventory Check-Out',
    'inventory.adjust': 'Inventory Adjustment',
    'inventory.reserve': 'Inventory Reserved',
    'inventory.return': 'Inventory Returned',
    'inventory.order': 'Incoming Order Created',
    'inventory.order.cancel': 'Incoming Order Cancelled',
    'inventory.transfer': 'Inventory Moved',
    'inventory.count': 'Cycle Count Submitted',
    'fleet.equipment.create': 'Equipment Created',
    'fleet.equipment.update': 'Equipment Updated',
    'fleet.equipment.delete': 'Equipment Deleted',
    'fleet.vehicle.create': 'Vehicle Created',
    'fleet.vehicle.update': 'Vehicle Updated',
    'fleet.vehicle.delete': 'Vehicle Deleted',
    'webhooks.inbound.received': 'Inbound Webhook Received',
    'items.create': 'Item Created',
    'items.update': 'Item Updated',
    'items.delete': 'Item Deleted',
    'procurement.vendor_open': 'Vendor Site Opened',
    'suppliers.update': 'Supplier Updated',
    'projects.materials.update': 'Project Materials Updated',
    'ops.pick.start': 'Pick Started',
    'ops.pick.finish': 'Pick Completed',
    'ops.checkin.start': 'Check-In Started',
    'ops.checkin.finish': 'Check-In Completed'
  };
  if (actionMap[normalized]) return actionMap[normalized];
  return normalized
    .split('.')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function auditNormalizeText(value) {
  return String(value ?? '').trim();
}

function auditExtractQty(details) {
  const candidates = [details?.qty, details?.quantity, details?.delta, details?.lines, details?.count, details?.bulk];
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function auditFormatDuration(ms) {
  const duration = Number(ms);
  if (!Number.isFinite(duration) || duration <= 0) return '';
  const minutes = Math.round(duration / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function auditBuildSummary(action, details) {
  const normalized = String(action || '').toLowerCase();
  const code = auditNormalizeText(details?.code || details?.itemCode);
  const qty = auditExtractQty(details);
  const qtyLabel = Number.isFinite(qty) ? `${Math.abs(qty)}` : '';
  const jobId = auditNormalizeText(details?.jobId || details?.jobid);
  const fromJobId = auditNormalizeText(details?.fromJobId);
  const toJobId = auditNormalizeText(details?.toJobId);
  const reason = auditNormalizeText(details?.reason);
  const location = auditNormalizeText(details?.location);
  const fromLocation = auditNormalizeText(details?.fromLocation);
  const toLocation = auditNormalizeText(details?.toLocation);
  const sourceType = auditNormalizeText(details?.sourceType);
  const sourceId = auditNormalizeText(details?.sourceId);
  const supplierName = auditNormalizeText(details?.supplierName || details?.name || details?.id);
  const endpointName = auditNormalizeText(details?.endpointName);
  const eventType = auditNormalizeText(details?.eventType);
  const externalId = auditNormalizeText(details?.externalId);
  const lineCount = Number(details?.lines || details?.count || 0) || 0;
  const bulkCount = Number(details?.bulk || 0) || 0;
  const duration = auditFormatDuration(details?.durationMs || details?.duration);
  const withJob = (text) => jobId ? `${text} for ${jobId}` : text;
  if (normalized === 'inventory.in') {
    if (sourceType === 'purchase' && lineCount) return `Recorded field purchase receipt for ${lineCount} lines`;
    const base = `Checked in ${qtyLabel ? `${qtyLabel} ` : ''}${code || 'inventory'}`.trim();
    return location ? `${withJob(base)} at ${location}` : withJob(base);
  }
  if (normalized === 'inventory.out') {
    const base = `Checked out ${qtyLabel ? `${qtyLabel} ` : ''}${code || 'inventory'}`.trim();
    return reason ? `${withJob(base)} | ${reason}` : withJob(base);
  }
  if (normalized === 'inventory.reserve') {
    if (fromJobId || toJobId) {
      return `Moved reserved ${qtyLabel ? `${qtyLabel} ` : ''}${code || 'inventory'}${fromJobId ? ` from ${fromJobId}` : ''}${toJobId ? ` to ${toJobId}` : ''}`.trim();
    }
    if (lineCount && !code) return `Reserved ${lineCount} material lines${jobId ? ` for ${jobId}` : ''}`;
    const base = `Reserved ${qtyLabel ? `${qtyLabel} ` : ''}${code || 'inventory'}`.trim();
    return withJob(base);
  }
  if (normalized === 'inventory.return') {
    const base = `Returned ${qtyLabel ? `${qtyLabel} ` : ''}${code || 'inventory'}`.trim();
    return reason ? `${withJob(base)} | ${reason}` : withJob(base);
  }
  if (normalized === 'inventory.count') {
    return `Submitted ${lineCount || (qtyLabel || '0')} cycle count lines`;
  }
  if (normalized === 'inventory.adjust') {
    const delta = Number(details?.delta);
    const deltaLabel = Number.isFinite(delta) ? `${delta > 0 ? '+' : ''}${delta}` : (qtyLabel || '');
    const base = `Adjusted ${code || 'inventory'} by ${deltaLabel}`.trim();
    if (reason) return `${base} | ${reason}`;
    if (location) return `${base} at ${location}`;
    return base;
  }
  if (normalized === 'inventory.transfer') {
    const base = `Moved ${qtyLabel ? `${qtyLabel} ` : ''}${code || 'inventory'}`.trim();
    const route = fromLocation || toLocation ? ` | ${fromLocation || 'Unknown'} -> ${toLocation || 'Unknown'}` : '';
    return reason ? `${base}${route} | ${reason}` : `${base}${route}`;
  }
  if (normalized === 'inventory.order') {
    if (lineCount && !code) return `Created ${lineCount} incoming orders${jobId ? ` for ${jobId}` : ''}`;
    return `Ordered ${qtyLabel ? `${qtyLabel} ` : ''}${code || 'inventory'}${jobId ? ` for ${jobId}` : ''}`.trim();
  }
  if (normalized === 'inventory.order.cancel') {
    const base = `Cancelled ${qtyLabel ? `${qtyLabel} open ` : ''}${code || 'incoming order'}`.trim();
    return reason ? `${base} | ${reason}` : `${base}${jobId ? ` for ${jobId}` : ''}`;
  }
  if (normalized === 'procurement.vendor_open') {
    const target = supplierName || sourceId || auditNormalizeText(details?.url) || 'supplier';
    return `Opened vendor site for ${target}${Number.isFinite(qty) && qty > 0 ? ` | ${qty} lines` : ''}`;
  }
  if (normalized === 'webhooks.inbound.received') {
    const target = endpointName || sourceType || sourceId || 'endpoint';
    const parts = [`Received inbound webhook for ${target}`];
    if (eventType) parts.push(eventType);
    if (externalId) parts.push(`delivery ${externalId}`);
    return parts.join(' | ');
  }
  if (normalized.startsWith('fleet.')) {
    const assetName = auditNormalizeText(details?.name);
    const assetLabel = code || assetName || 'asset';
    if (normalized.endsWith('.create')) return `Created fleet asset ${assetLabel}${location ? ` at ${location}` : ''}`;
    if (normalized.endsWith('.update')) return `Updated fleet asset ${assetLabel}${location ? ` at ${location}` : ''}`;
    if (normalized.endsWith('.delete')) return `Deleted fleet asset ${assetLabel}`;
  }
  if (normalized === 'projects.materials.update') {
    return `Updated ${lineCount || Number(details?.count || 0) || 0} material lines${jobId ? ` for ${jobId}` : ''}`;
  }
  if (normalized === 'items.create') return `Created item ${code || sourceId || 'record'}`.trim();
  if (normalized === 'items.update') {
    if ((lineCount || bulkCount) && !code) return `Updated ${lineCount || bulkCount} item records`;
    if (details?.storageChanged) {
      const itemLabel = code || sourceId || 'record';
      const fromLabel = auditNormalizeText(details?.storageFromLabel) || 'Unassigned';
      const toLabel = auditNormalizeText(details?.storageToLabel) || 'Unassigned';
      return `Changed storage for ${itemLabel} | ${fromLabel} -> ${toLabel}`;
    }
    return `Updated item ${code || sourceId || 'record'}`.trim();
  }
  if (normalized === 'items.delete') return `Deleted item ${code || sourceId || 'record'}`.trim();
  if (normalized === 'suppliers.update') {
    if (details?.deleted) return `Deleted supplier ${supplierName || 'record'}`.trim();
    return `Updated supplier ${supplierName || 'record'}`.trim();
  }
  if (normalized === 'auth.login') return 'User signed in';
  if (normalized === 'auth.register') return 'User registered';
  if (normalized === 'ops.pick.start') return 'Pick session started';
  if (normalized === 'ops.checkin.start') return 'Check-in session started';
  if (normalized === 'ops.pick.finish' || normalized === 'ops.checkin.finish') {
    const phase = normalized.includes('pick') ? 'Pick completed' : 'Check-in completed';
    const parts = [phase];
    if (duration) parts.push(duration);
    if (Number.isFinite(qty) && qty > 0) parts.push(`${qty} units`);
    if (lineCount > 0) parts.push(`${lineCount} lines`);
    return parts.join(' | ');
  }
  return auditActionLabel(action);
}

function auditNormalizeEntry(entry) {
  const action = auditNormalizeText(entry?.action).toLowerCase();
  const details = dashboardParseDetails(entry?.details);
  const area = auditActionArea(action);
  const code = auditNormalizeText(details?.code || details?.itemCode);
  const userEmail = auditNormalizeText(entry?.userEmail || entry?.useremail || details?.email);
  const userName = auditNormalizeText(entry?.userName || entry?.username);
  const reference = auditNormalizeText(
    details?.jobId
    || details?.jobid
    || details?.fromJobId
    || details?.toJobId
    || details?.sourceId
    || details?.supplierName
    || details?.id
    || details?.url
    || details?.email
  );
  return {
    id: entry?.id || '',
    action,
    label: auditActionLabel(action),
    area: area.label,
    areaKey: area.key,
    code,
    qty: auditExtractQty(details),
    reference,
    jobId: auditNormalizeText(details?.jobId || details?.jobid),
    userEmail,
    userName,
    summary: auditBuildSummary(action, details),
    ts: Number(entry?.ts || 0) || 0
  };
}

function formatAuditMessage(entry) {
  const normalized = auditNormalizeEntry(entry);
  const parts = [normalized.summary || auditActionLabel(normalized.action)];
  if (normalized.userEmail) parts.push(`by ${normalized.userEmail}`);
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
        'INSERT INTO users(id,email,name,role,salt,hash,createdAt,emailVerified,emailVerifiedAt,tenantId) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [newId(), adminEmail, adminName || name || 'Admin', 'admin', salt, hash, now, true, now, tenantId]
      );
    });
    await ensureDefaultCategory(tenantId);
    await ensureTenantCapabilities(tenantId);
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
      await client.query('DELETE FROM auth_tokens WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM tenant_capabilities WHERE tenant_id=$1', [tenant.id]);
      await client.query('DELETE FROM inventory_locations WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM equipment_assets WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM vehicle_assets WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM items WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM suppliers WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM job_materials WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM jobs WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM categories WHERE tenantId=$1', [tenant.id]);
      await client.query('DELETE FROM users WHERE tenantId=$1', [tenant.id]);
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

async function startServer() {
  try {
    console.log('Starting server bootstrap...');
    loadSellerStore();
    await initDb();
    console.log(`Database bootstrap complete. Phase: ${initDbPhase}`);
    app.listen(PORT, () => console.log(`Server listening on ${PUBLIC_BASE_URL}`));
  } catch (err) {
    console.error(`Startup failed during database initialization at phase "${initDbPhase}"`, err);
    process.exit(1);
  }
}

startServer();

// Helpers to read common lists
async function readItems(tenantIdVal) {
  return allAsync('SELECT * FROM items WHERE tenantId=$1 ORDER BY name ASC', [tenantIdVal]);
}
async function readCategories(tenantIdVal) {
  return allAsync('SELECT * FROM categories WHERE tenantId=$1 ORDER BY name ASC', [tenantIdVal]);
}
async function readJobLifecycleStats(tenantIdVal) {
  const rows = await allAsync(
    `SELECT jobId,
            COUNT(*)::int AS actionCount,
            MAX(ts) AS lastActionAt,
            MAX(CASE WHEN type='return' THEN ts END) AS lastReturnAt,
            MAX(CASE WHEN type<>'return' THEN ts END) AS lastNonReturnAt,
            COALESCE(SUM(CASE WHEN type='out' THEN qty WHEN type='return' THEN -qty ELSE 0 END),0) AS outstandingCheckoutQty
       FROM inventory
      WHERE tenantId=$1
        AND jobId IS NOT NULL
        AND jobId <> ''
      GROUP BY jobId`,
    [tenantIdVal]
  );
  return new Map((rows || []).map((row) => [normalizeJobId(row.jobid || row.jobId || ''), row]));
}
function deriveJobLifecycleStatus(job, lifecycleRow, now = Date.now()) {
  const storedStatus = String(job?.status || '').trim().toLowerCase();
  if (JOB_MANUAL_STATUS_OVERRIDES.has(storedStatus)) {
    return {
      status: storedStatus,
      storedStatus,
      statusSource: 'manual',
      lastActionAt: Number(lifecycleRow?.lastactionat || lifecycleRow?.lastActionAt || 0) || null,
      lastReturnAt: Number(lifecycleRow?.lastreturnat || lifecycleRow?.lastReturnAt || 0) || null,
    };
  }
  const actionCount = Number(lifecycleRow?.actioncount || lifecycleRow?.actionCount || 0) || 0;
  const lastActionAt = Number(lifecycleRow?.lastactionat || lifecycleRow?.lastActionAt || 0) || null;
  const lastReturnAt = Number(lifecycleRow?.lastreturnat || lifecycleRow?.lastReturnAt || 0) || null;
  const lastNonReturnAt = Number(lifecycleRow?.lastnonreturnat || lifecycleRow?.lastNonReturnAt || 0) || 0;
  const outstandingCheckoutQty = Number(lifecycleRow?.outstandingcheckoutqty || lifecycleRow?.outstandingCheckoutQty || 0) || 0;
  if (actionCount <= 0) {
    return { status: 'planned', storedStatus, statusSource: 'auto', lastActionAt, lastReturnAt };
  }
  const returnWasLastMeaningfulAction = !!lastReturnAt && lastReturnAt >= lastNonReturnAt;
  const canAutoComplete = returnWasLastMeaningfulAction
    && outstandingCheckoutQty <= 0
    && (now - lastReturnAt) >= JOB_AUTO_COMPLETE_GRACE_MS;
  return {
    status: canAutoComplete ? 'complete' : 'active',
    storedStatus,
    statusSource: 'auto',
    lastActionAt,
    lastReturnAt,
  };
}
async function readJobs(tenantIdVal) {
  const [jobs, lifecycleByJob] = await Promise.all([
    allAsync('SELECT * FROM jobs WHERE tenantId=$1 ORDER BY code ASC', [tenantIdVal]),
    readJobLifecycleStats(tenantIdVal),
  ]);
  const now = Date.now();
  return (jobs || []).map((job) => {
    const code = normalizeJobId(job.code);
    const derived = deriveJobLifecycleStatus(job, lifecycleByJob.get(code), now);
    return {
      ...job,
      status: derived.status,
      storedStatus: derived.storedStatus,
      statusSource: derived.statusSource,
      lastActionAt: derived.lastActionAt,
      lastReturnAt: derived.lastReturnAt,
    };
  });
}
async function readSuppliers(tenantIdVal) {
  return allAsync('SELECT * FROM suppliers WHERE tenantId=$1 ORDER BY name ASC', [tenantIdVal]);
}
function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}
function normalizeSupplierRow(row) {
  const rawOrderMethod = String(row?.ordermethod || row?.orderMethod || '').trim().toLowerCase();
  const orderMethod = ['web', 'email', 'phone'].includes(rawOrderMethod) ? rawOrderMethod : '';
  return {
    id: row?.id || '',
    tenantId: row?.tenantid || row?.tenantId || '',
    name: row?.name || '',
    contact: row?.contact || '',
    email: row?.email || '',
    phone: row?.phone || '',
    orderMethod,
    websiteUrl: row?.websiteurl || row?.websiteUrl || '',
    orderUrl: row?.orderurl || row?.orderUrl || '',
    leadTime: row?.leadtime || row?.leadTime || {},
    moq: row?.moq ?? null,
    notes: row?.notes || '',
    createdAt: row?.createdat || row?.createdAt || null,
    updatedAt: row?.updatedat || row?.updatedAt || null
  };
}
function numberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}
function roundQty(value) {
  return Number(numberOrZero(value).toFixed(2));
}
function normalizeJobMaterialRow(row) {
  const qtyRequired = roundQty(row?.qtyrequired ?? row?.qtyRequired);
  const qtyOrdered = roundQty(row?.qtyordered ?? row?.qtyOrdered);
  const qtyAllocated = roundQty(row?.qtyallocated ?? row?.qtyAllocated);
  const qtyReceived = roundQty(row?.qtyreceived ?? row?.qtyReceived);
  const outstandingQty = Math.max(0, roundQty(qtyRequired - qtyOrdered - qtyAllocated));
  const coveredFromStockQty = roundQty(qtyAllocated + qtyReceived);
  let status = 'not_ordered';
  if (qtyReceived >= qtyRequired && qtyRequired > 0) status = 'ready';
  else if (coveredFromStockQty > 0 && outstandingQty <= 0 && qtyRequired > 0) status = 'ready';
  else if (coveredFromStockQty > 0) status = 'partially_received';
  else if (qtyOrdered >= qtyRequired && qtyRequired > 0) status = 'ordered';
  else if (qtyOrdered > 0 || qtyAllocated > 0) status = 'partially_ordered';
  return {
    id: row?.id,
    tenantId: row?.tenantid || row?.tenantId || '',
    jobId: row?.jobid || row?.jobId || '',
    code: row?.code || '',
    name: row?.name || row?.code || '',
    supplierId: row?.supplierid || row?.supplierId || '',
    qtyRequired,
    qtyOrdered,
    qtyAllocated,
    qtyReceived,
    outstandingQty,
    notes: row?.notes || '',
    sortOrder: Number(row?.sortorder ?? row?.sortOrder ?? 0) || 0,
    status,
    createdAt: row?.createdat || row?.createdAt || null,
    updatedAt: row?.updatedat || row?.updatedAt || null
  };
}
function normalizeJobMaterialInput(raw, index = 0) {
  const code = String(raw?.code || '').trim();
  const name = String(raw?.name || '').trim();
  const supplierId = String(raw?.supplierId || '').trim();
  const qtyRequired = roundQty(raw?.qtyRequired ?? raw?.qty ?? 0);
  if (!code) throw new Error('material code required');
  if (!(qtyRequired > 0)) throw new Error(`material qty required for ${code}`);
  return {
    id: String(raw?.id || '').trim() || newId(),
    code,
    name: name || code,
    supplierId,
    qtyRequired,
    notes: String(raw?.notes || '').trim(),
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.floor(Number(raw.sortOrder)) : index
  };
}
async function readJobMaterials(tenantIdVal, jobId) {
  const rows = await allAsync(
    'SELECT * FROM job_materials WHERE tenantId=$1 AND jobId=$2 ORDER BY sortOrder ASC, createdAt ASC, code ASC',
    [tenantIdVal, jobId]
  );
  return (rows || []).map(normalizeJobMaterialRow);
}
async function readAllJobMaterials(tenantIdVal) {
  const rows = await allAsync(
    'SELECT * FROM job_materials WHERE tenantId=$1 ORDER BY jobId ASC, sortOrder ASC, createdAt ASC, code ASC',
    [tenantIdVal]
  );
  return (rows || []).map(normalizeJobMaterialRow);
}
async function replaceJobMaterialsTx(client, tenantIdVal, jobId, materials) {
  const existingRows = await client.query('SELECT * FROM job_materials WHERE tenantId=$1 AND jobId=$2', [tenantIdVal, jobId]);
  const existingNormalized = (existingRows.rows || []).map(normalizeJobMaterialRow);
  const existingMap = new Map(existingNormalized.map((row) => [row.id, row]));
  const nextNormalized = [];
  for (let i = 0; i < (materials || []).length; i += 1) {
    nextNormalized.push(normalizeJobMaterialInput(materials[i], i));
  }
  const planSignature = (row) => JSON.stringify({
    id: row.id,
    code: row.code,
    name: row.name || row.code,
    supplierId: row.supplierId || '',
    qtyRequired: roundQty(row.qtyRequired || 0),
    notes: row.notes || '',
    sortOrder: Number(row.sortOrder || 0) || 0
  });
  const existingSignature = existingNormalized.map(planSignature).join('|');
  const nextSignature = nextNormalized.map(planSignature).join('|');
  await client.query('DELETE FROM job_materials WHERE tenantId=$1 AND jobId=$2', [tenantIdVal, jobId]);
  if (existingSignature !== nextSignature) {
    await client.query('UPDATE jobs SET materialsReadyNotifiedAt=NULL WHERE code=$1 AND tenantId=$2', [jobId, tenantIdVal]);
  }
  const now = Date.now();
  const normalized = [];
  for (let i = 0; i < nextNormalized.length; i += 1) {
    const material = nextNormalized[i];
    const existing = existingMap.get(material.id);
    if (material.supplierId) {
      const supplier = await client.query('SELECT id FROM suppliers WHERE id=$1 AND tenantId=$2 LIMIT 1', [material.supplierId, tenantIdVal]);
      if (!supplier.rows?.[0]) throw new Error(`supplier not found for ${material.code}`);
    }
    await client.query(
      `INSERT INTO job_materials(id,tenantId,jobId,code,name,supplierId,qtyRequired,qtyOrdered,qtyAllocated,qtyReceived,notes,sortOrder,createdAt,updatedAt)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        material.id,
        tenantIdVal,
        jobId,
        material.code,
        material.name,
        material.supplierId || null,
        material.qtyRequired,
        roundQty(existing?.qtyordered ?? 0),
        roundQty(existing?.qtyallocated ?? 0),
        roundQty(existing?.qtyreceived ?? 0),
        material.notes || null,
        material.sortOrder,
        existing?.createdat || existing?.createdAt || now,
        now
      ]
    );
    normalized.push(material);
  }
  return normalized;
}
async function changeJobMaterialQtyTx(client, tenantIdVal, jobId, materialId, field, qtyDelta) {
  if (!materialId || !jobId || !Number.isFinite(Number(qtyDelta)) || Number(qtyDelta) === 0) return;
  if (!['qtyOrdered', 'qtyAllocated', 'qtyReceived'].includes(field)) return;
  const columnMap = {
    qtyOrdered: 'qtyOrdered',
    qtyAllocated: 'qtyAllocated',
    qtyReceived: 'qtyReceived'
  };
  await client.query(
    `UPDATE job_materials
     SET ${columnMap[field]} = GREATEST(0, COALESCE(${columnMap[field]},0) + $1), updatedAt=$2
     WHERE id=$3 AND tenantId=$4 AND jobId=$5`,
    [roundQty(qtyDelta), Date.now(), materialId, tenantIdVal, jobId]
  );
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



