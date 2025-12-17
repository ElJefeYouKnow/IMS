const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 8000;
const dataDir = path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'ims.db');

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use(helmet());
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 50, standardHeaders:true, legacyHeaders:false });
app.use(['/api/auth/login','/api/auth/register'], authLimiter);

if(!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if(!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, '');
const db = new sqlite3.Database(dbFile);

function newId(){
  return 'itm_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
}

function hashPassword(password, salt){
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', s).update(password).digest('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash){
  const h = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return h === hash;
}

function safeUser(u){ return { id: u.id, email: u.email, name: u.name || '', role: u.role || 'user', createdAt: u.createdAt }; }

function runAsync(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.run(sql, params, function(err){
      if(err) reject(err); else resolve(this);
    });
  });
}
function allAsync(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.all(sql, params, (err, rows)=> err ? reject(err) : resolve(rows));
  });
}
function getAsync(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.get(sql, params, (err, row)=> err ? reject(err) : resolve(row));
  });
}

async function initDb(){
  await runAsync(`CREATE TABLE IF NOT EXISTS items(
    code TEXT PRIMARY KEY,
    name TEXT,
    category TEXT,
    unitPrice REAL,
    description TEXT
  )`);
  await runAsync(`CREATE TABLE IF NOT EXISTS inventory(
    id TEXT PRIMARY KEY,
    code TEXT,
    name TEXT,
    qty INTEGER,
    location TEXT,
    jobId TEXT,
    notes TEXT,
    ts INTEGER,
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
    email TEXT UNIQUE,
    name TEXT,
    role TEXT,
    salt TEXT,
    hash TEXT,
    createdAt INTEGER
  )`);
  const row = await getAsync('SELECT COUNT(*) as c FROM users');
  if(row?.c === 0){
    const pwd = 'ChangeMe123!';
    const { salt, hash } = hashPassword(pwd);
    const user = { id:newId(), email:'admin@example.com', name:'Admin', role:'admin', salt, hash, createdAt: Date.now() };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt) VALUES(?,?,?,?,?,?,?)',
      [user.id,user.email,user.name,user.role,user.salt,user.hash,user.createdAt]);
    console.log('Seeded default admin: admin@example.com / ChangeMe123! — change after login.');
  }
}
initDb().catch(console.error);

function statusForType(type){
  if(type === 'ordered') return 'ordered';
  if(type === 'in') return 'in-stock';
  if(type === 'out') return 'checked-out';
  if(type === 'reserve') return 'reserved';
  if(type === 'return') return 'returned';
  return 'unknown';
}

async function itemExists(code){
  const row = await getAsync('SELECT 1 FROM items WHERE code=? LIMIT 1',[code]);
  return !!row;
}

async function calcAvailability(code){
  const row = await getAsync(`
    SELECT COALESCE(SUM(
      CASE 
        WHEN type='in' THEN qty
        WHEN type='return' THEN qty
        WHEN type='reserve' THEN -qty
        WHEN type='out' THEN -qty
        ELSE 0 END
    ),0) AS available
    FROM inventory WHERE code = ?
  `,[code]);
  return row?.available || 0;
}

async function calcOutstandingCheckout(code, jobId){
  const params=[code];
  let jobClause='';
  if(jobId){
    jobClause='AND jobId = ?'; params.push(jobId);
  }else{
    jobClause='AND (jobId IS NULL OR jobId = "")';
  }
  const row = await getAsync(`
    SELECT COALESCE(SUM(CASE WHEN type='out' THEN qty WHEN type='return' THEN -qty ELSE 0 END),0) as outstanding
    FROM inventory WHERE code=? ${jobClause}
  `, params);
  return Math.max(0,row?.outstanding||0);
}

function requireRole(role){
  return (req,res,next)=>{
    const r = (req.headers['x-user-role']||req.headers['x-admin-role']||'').toLowerCase();
    if(r !== role) return res.status(403).json({ error:'forbidden' });
    next();
  };
}

// INVENTORY
app.get('/api/inventory', async (req, res) => {
  try{
    const type = req.query.type;
    const rows = type ? await allAsync('SELECT * FROM inventory WHERE type = ?',[type]) : await allAsync('SELECT * FROM inventory');
    res.json(rows);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.post('/api/inventory', requireRole('admin'), async (req, res) => {
  try{
    const { code, name, qty, location, jobId, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if(!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    if(!(await itemExists(code))) return res.status(400).json({ error: 'unknown item code' });
    const entry = { id:newId(), code, name, qty: qtyNum, location, jobId, notes, ts: ts || Date.now(), type:'in', status: statusForType('in'), userEmail:req.body.userEmail, userName:req.body.userName };
    await runAsync(`INSERT INTO inventory(id,code,name,qty,location,jobId,notes,ts,type,status,userEmail,userName) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [entry.id, entry.code, entry.name, entry.qty, entry.location, entry.jobId, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName]);
    res.status(201).json(entry);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.post('/api/inventory-checkout', async (req, res) => {
  try{
    const { code, jobId, qty, reason, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if(!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    if(!(await itemExists(code))) return res.status(400).json({ error: 'unknown item code' });
    const available = await calcAvailability(code);
    if(qtyNum > available) return res.status(400).json({ error: 'insufficient stock', available });
    const entry = { id:newId(), code, jobId, qty: qtyNum, reason, notes, ts: ts || Date.now(), type:'out', status: statusForType('out'), userEmail:req.body.userEmail, userName:req.body.userName };
    await runAsync(`INSERT INTO inventory(id,code,jobId,qty,reason,notes,ts,type,status,userEmail,userName) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [entry.id, entry.code, entry.jobId, entry.qty, entry.reason, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName]);
    res.status(201).json(entry);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.delete('/api/inventory', async (req, res) => {
  try{
    const type = req.query.type;
    if(type) await runAsync('DELETE FROM inventory WHERE type = ?',[type]);
    else await runAsync('DELETE FROM inventory');
    res.status(204).end();
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.delete('/api/inventory-checkout', async (req, res) => {
  try{
    await runAsync('DELETE FROM inventory WHERE type="out"');
    res.status(204).end();
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.get('/api/inventory-reserve', async (req, res) => {
  try{
    const rows = await allAsync('SELECT * FROM inventory WHERE type="reserve"');
    res.json(rows);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.post('/api/inventory-reserve', async (req, res) => {
  try{
    const { code, jobId, qty, returnDate, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if(!code || !jobId || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code, jobId and positive qty required' });
    if(!(await itemExists(code))) return res.status(400).json({ error: 'unknown item code' });
    const available = await calcAvailability(code);
    if(qtyNum > available) return res.status(400).json({ error: 'insufficient stock', available });
    const entry = { id:newId(), code, jobId, qty: qtyNum, returnDate, notes, ts: ts || Date.now(), type:'reserve', status: statusForType('reserve'), userEmail:req.body.userEmail, userName:req.body.userName };
    await runAsync(`INSERT INTO inventory(id,code,jobId,qty,returnDate,notes,ts,type,status,userEmail,userName) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [entry.id, entry.code, entry.jobId, entry.qty, entry.returnDate, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName]);
    res.status(201).json(entry);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.delete('/api/inventory-reserve', async (req, res) => {
  try{
    await runAsync('DELETE FROM inventory WHERE type="reserve"');
    res.status(204).end();
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.get('/api/inventory-return', async (req, res) => {
  try{
    const rows = await allAsync('SELECT * FROM inventory WHERE type="return"');
    res.json(rows);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.post('/api/inventory-return', async (req, res) => {
  try{
    const { code, jobId, qty, reason, location, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if(!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    if(!(await itemExists(code))) return res.status(400).json({ error: 'unknown item code' });
    const outstanding = await calcOutstandingCheckout(code, jobId);
    if(outstanding <= 0) return res.status(400).json({ error: 'no matching checkout to return' });
    if(qtyNum > outstanding) return res.status(400).json({ error: 'return exceeds outstanding checkout', outstanding });
    const entry = { id:newId(), code, jobId, qty: qtyNum, reason, location, notes, ts: ts || Date.now(), type:'return', status: statusForType('return'), userEmail:req.body.userEmail, userName:req.body.userName };
    await runAsync(`INSERT INTO inventory(id,code,jobId,qty,reason,location,notes,ts,type,status,userEmail,userName) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [entry.id, entry.code, entry.jobId, entry.qty, entry.reason, entry.location, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName]);
    res.status(201).json(entry);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.delete('/api/inventory-return', async (req, res) => {
  try{
    await runAsync('DELETE FROM inventory WHERE type="return"');
    res.status(204).end();
  }catch(e){ res.status(500).json({error:'server error'}); }
});

// ITEMS
app.get('/api/items', async (req, res) => {
  try{
    const rows = await readItems();
    res.json(rows);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.post('/api/items', requireRole('admin'), async (req, res) => {
  try{
    const { code, oldCode, name, category, unitPrice, description } = req.body;
    if(!code || !name) return res.status(400).json({ error: 'code and name required' });
    if(oldCode && oldCode !== code){
      await runAsync('DELETE FROM items WHERE code=?',[oldCode]);
    }
    await runAsync(`INSERT INTO items(code,name,category,unitPrice,description)
      VALUES(?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, category=excluded.category, unitPrice=excluded.unitPrice, description=excluded.description`,
      [code,name,category,unitPrice ?? null,description]);
    res.status(201).json({ code, name, category, unitPrice, description });
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.delete('/api/items/:code', requireRole('admin'), async (req, res) => {
  try{
    await runAsync('DELETE FROM items WHERE code=?',[req.params.code]);
    res.status(204).end();
  }catch(e){ res.status(500).json({error:'server error'}); }
});

// AUTH + USERS
app.post('/api/auth/register', async (req, res) => {
  try{
    const { email, password, name } = req.body;
    if(!email || !password) return res.status(400).json({ error: 'email and password required' });
    const existing = await getAsync('SELECT id FROM users WHERE email=?',[email]);
    if(existing) return res.status(400).json({ error: 'email already exists' });
    const role = (await getAsync('SELECT COUNT(*) as c FROM users')).c === 0 ? 'admin' : 'user';
    const { salt, hash } = hashPassword(password);
    const user = { id:newId(), email, name, role, salt, hash, createdAt: Date.now() };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt) VALUES(?,?,?,?,?,?,?)',
      [user.id,user.email,user.name,user.role,user.salt,user.hash,user.createdAt]);
    res.status(201).json(safeUser(user));
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.post('/api/auth/login', async (req, res) => {
  try{
    const { email, password } = req.body;
    if(!email || !password) return res.status(400).json({ error: 'email and password required' });
    const user = await getAsync('SELECT * FROM users WHERE email=?',[email]);
    if(!user) return res.status(401).json({ error: 'invalid credentials' });
    if(!verifyPassword(password, user.salt, user.hash)) return res.status(401).json({ error: 'invalid credentials' });
    res.json(safeUser(user));
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.get('/api/users', requireRole('admin'), async (req, res) => {
  try{
    const rows = await allAsync('SELECT * FROM users');
    res.json(rows.map(safeUser));
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  try{
    const { email, password, name, role='user' } = req.body;
    if(!email || !password) return res.status(400).json({ error: 'email and password required' });
    const exists = await getAsync('SELECT id FROM users WHERE email=?',[email]);
    if(exists) return res.status(400).json({ error: 'email already exists' });
    const { salt, hash } = hashPassword(password);
    const user = { id:newId(), email, name, role, salt, hash, createdAt: Date.now() };
    await runAsync('INSERT INTO users(id,email,name,role,salt,hash,createdAt) VALUES(?,?,?,?,?,?,?)',
      [user.id,user.email,user.name,user.role,user.salt,user.hash,user.createdAt]);
    res.status(201).json(safeUser(user));
  }catch(e){ res.status(500).json({error:'server error'}); }
});

// JOBS
app.get('/api/jobs', async (req, res) => {
  try{
    const rows = await readJobs();
    res.json(rows);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.post('/api/jobs', requireRole('admin'), async (req, res) => {
  try{
    const { code, name, scheduleDate } = req.body;
    if(!code) return res.status(400).json({ error: 'code required' });
    await runAsync(`INSERT INTO jobs(code,name,scheduleDate) VALUES(?,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, scheduleDate=excluded.scheduleDate`,[code,name||'',scheduleDate||null]);
    res.status(201).json({ code, name:name||'', scheduleDate:scheduleDate||null });
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.delete('/api/jobs/:code', requireRole('admin'), async (req, res) => {
  try{
    await runAsync('DELETE FROM jobs WHERE code=?',[req.params.code]);
    res.status(204).end();
  }catch(e){ res.status(500).json({error:'server error'}); }
});

// ADMIN ORDERS
app.post('/api/inventory-order', requireRole('admin'), async (req, res) => {
  try{
    const { code, name, qty, eta, notes, ts } = req.body;
    const qtyNum = Number(qty);
    if(!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
    const exists = await itemExists(code);
    if(!exists){
      await runAsync('INSERT INTO items(code,name,category,unitPrice,description) VALUES(?,?,?,?,?)',[code,name||code,'',null,'']);
    }
    const entry = { id:newId(), code, name, qty: qtyNum, eta, notes, ts: ts || Date.now(), type:'ordered', status: statusForType('ordered'), userEmail:req.body.userEmail, userName:req.body.userName };
    await runAsync(`INSERT INTO inventory(id,code,name,qty,eta,notes,ts,type,status,userEmail,userName) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [entry.id, entry.code, entry.name, entry.qty, entry.eta, entry.notes, entry.ts, entry.type, entry.status, entry.userEmail, entry.userName]);
    res.status(201).json(entry);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

// METRICS
app.get('/api/metrics', async (req, res) => {
  try{
    const now = Date.now();
    const row = await getAsync(`
      SELECT 
        COALESCE(SUM(CASE WHEN type='in' THEN qty WHEN type='return' THEN qty WHEN type='out' THEN -qty WHEN type='reserve' THEN -qty ELSE 0 END),0) as availableUnits,
        COALESCE(SUM(CASE WHEN type='reserve' THEN qty ELSE 0 END),0) as reservedUnits,
        COALESCE(COUNT(DISTINCT CASE WHEN jobId IS NOT NULL AND jobId != '' THEN jobId END),0) as activeJobs,
        COALESCE(SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END),0) as txLast7
      FROM inventory
    `,[now - 7*24*60*60*1000]);
    // low stock count
    const lowRows = await allAsync(`
      SELECT i.code,
        COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) as available
      FROM items i
      LEFT JOIN inventory inv ON inv.code = i.code
      GROUP BY i.code
      HAVING available > 0 AND available <= 5
    `);
    res.json({ ...row, lowStockCount: lowRows.length });
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.get('/api/low-stock', async (req,res)=>{
  try{
    const rows = await allAsync(`
      SELECT i.code, i.name,
        COALESCE(SUM(CASE WHEN inv.type='in' THEN inv.qty WHEN inv.type='return' THEN inv.qty WHEN inv.type='out' THEN -inv.qty WHEN inv.type='reserve' THEN -inv.qty ELSE 0 END),0) as available,
        COALESCE(SUM(CASE WHEN inv.type='reserve' THEN inv.qty ELSE 0 END),0) as reserve
      FROM items i
      LEFT JOIN inventory inv ON inv.code = i.code
      GROUP BY i.code
      HAVING available > 0 AND available <= 5
      ORDER BY available ASC
      LIMIT 20
    `);
    res.json(rows);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.get('/api/recent-activity', async (req,res)=>{
  try{
    const limit = Math.min(parseInt(req.query.limit||'10',10)||10,50);
    const rows = await allAsync('SELECT * FROM inventory ORDER BY ts DESC LIMIT ?', [limit]);
    res.json(rows);
  }catch(e){ res.status(500).json({error:'server error'}); }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
