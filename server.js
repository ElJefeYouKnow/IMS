const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;
const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'inventory.json');
const itemsFile = path.join(dataDir, 'items.json');

app.use(express.json());
app.use(express.static(path.join(__dirname)));

function ensureDataFile(){
  if(!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if(!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '[]', 'utf8');
  if(!fs.existsSync(itemsFile)) fs.writeFileSync(itemsFile, '[]', 'utf8');
}

function readEntries(){
  ensureDataFile();
  try{
    const raw = fs.readFileSync(dataFile, 'utf8');
    return JSON.parse(raw || '[]');
  }catch(e){
    return [];
  }
}

function writeEntries(entries){
  ensureDataFile();
  fs.writeFileSync(dataFile, JSON.stringify(entries, null, 2), 'utf8');
}

function readItems(){
  ensureDataFile();
  try{
    const raw = fs.readFileSync(itemsFile, 'utf8');
    return JSON.parse(raw || '[]');
  }catch(e){
    return [];
  }
}

function writeItems(items){
  ensureDataFile();
  fs.writeFileSync(itemsFile, JSON.stringify(items, null, 2), 'utf8');
}

function filterByType(entries, type){
  if(!type) return entries;
  const types = Array.isArray(type) ? type : [type];
  return entries.filter(e=> types.includes(e.type));
}

function calcAvailability(entries, code){
  let qtyIn=0, qtyOut=0, qtyReserve=0, qtyReturn=0;
  entries.forEach(e=>{
    if(e.code !== code) return;
    const q = Number(e.qty) || 0;
    if(e.type === 'in') qtyIn += q;
    else if(e.type === 'out') qtyOut += q;
    else if(e.type === 'reserve') qtyReserve += q;
    else if(e.type === 'return') qtyReturn += q;
  });
  return qtyIn + qtyReturn - qtyOut - qtyReserve;
}

function calcOutstandingCheckout(entries, code, jobId){
  // Track per-job to avoid subtracting returns from unrelated jobs
  let qtyOut=0, qtyReturn=0;
  const targetJob = (jobId || '').trim();
  entries.forEach(e=>{
    if(e.code !== code) return;
    const entryJob = (e.jobId || '').trim();
    if(targetJob){
      if(entryJob !== targetJob) return;
    }else{
      if(entryJob) return; // only count job-less checkouts/returns when jobId not provided
    }
    const q = Number(e.qty) || 0;
    if(e.type === 'out') qtyOut += q;
    else if(e.type === 'return') qtyReturn += q;
  });
  return Math.max(0, qtyOut - qtyReturn);
}

app.get('/api/inventory', (req, res) => {
  const entries = readEntries();
  const type = req.query.type;
  res.json(filterByType(entries, type));
});

app.post('/api/inventory', (req, res) => {
  const { code, name, qty, location, jobId, notes, ts } = req.body;
  const qtyNum = Number(qty);
  if(!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
  const entries = readEntries();
  const entry = { code, name, qty: qtyNum, location, jobId, notes, ts: ts || Date.now(), type: 'in' };
  entries.push(entry);
  writeEntries(entries);
  res.status(201).json(entry);
});

app.post('/api/inventory-checkout', (req, res) => {
  const { code, jobId, qty, reason, notes, ts } = req.body;
  const qtyNum = Number(qty);
  if(!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
  const entries = readEntries();
  const available = calcAvailability(entries, code);
  if(qtyNum > available) return res.status(400).json({ error: 'insufficient stock', available });
  const entry = { code, jobId, qty: qtyNum, reason, notes, ts: ts || Date.now(), type: 'out' };
  entries.push(entry);
  writeEntries(entries);
  res.status(201).json(entry);
});

app.delete('/api/inventory', (req, res) => {
  let entries = readEntries();
  const type = req.query.type;
  if(type) entries = entries.filter(e=> e.type !== type);
  else entries = [];
  writeEntries(entries);
  res.status(204).end();
});

app.delete('/api/inventory-checkout', (req, res) => {
  let entries = readEntries();
  entries = entries.filter(e=> e.type !== 'out');
  writeEntries(entries);
  res.status(204).end();
});

app.get('/api/inventory-reserve', (req, res) => {
  const entries = readEntries();
  res.json(entries.filter(e=> e.type === 'reserve'));
});

app.post('/api/inventory-reserve', (req, res) => {
  const { code, jobId, qty, returnDate, notes, ts } = req.body;
  const qtyNum = Number(qty);
  if(!code || !jobId || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code, jobId and positive qty required' });
  const entries = readEntries();
  const available = calcAvailability(entries, code);
  if(qtyNum > available) return res.status(400).json({ error: 'insufficient stock', available });
  const entry = { code, jobId, qty: qtyNum, returnDate, notes, ts: ts || Date.now(), type: 'reserve' };
  entries.push(entry);
  writeEntries(entries);
  res.status(201).json(entry);
});

app.delete('/api/inventory-reserve', (req, res) => {
  let entries = readEntries();
  entries = entries.filter(e=> e.type !== 'reserve');
  writeEntries(entries);
  res.status(204).end();
});

app.get('/api/inventory-return', (req, res) => {
  const entries = readEntries();
  res.json(entries.filter(e=> e.type === 'return'));
});

app.post('/api/inventory-return', (req, res) => {
  const { code, jobId, qty, reason, location, notes, ts } = req.body;
  const qtyNum = Number(qty);
  if(!code || !qtyNum || qtyNum <= 0) return res.status(400).json({ error: 'code and positive qty required' });
  const entries = readEntries();
  const outstanding = calcOutstandingCheckout(entries, code, jobId);
  if(outstanding <= 0) return res.status(400).json({ error: 'no matching checkout to return' });
  if(qtyNum > outstanding) return res.status(400).json({ error: 'return exceeds outstanding checkout', outstanding });
  const entry = { code, jobId, qty: qtyNum, reason, location, notes, ts: ts || Date.now(), type: 'return' };
  entries.push(entry);
  writeEntries(entries);
  res.status(201).json(entry);
});

app.delete('/api/inventory-return', (req, res) => {
  let entries = readEntries();
  entries = entries.filter(e=> e.type !== 'return');
  writeEntries(entries);
  res.status(204).end();
});

app.get('/api/items', (req, res) => {
  res.json(readItems());
});

app.post('/api/items', (req, res) => {
  const { code, oldCode, name, category, unitPrice, description } = req.body;
  if(!code || !name) return res.status(400).json({ error: 'code and name required' });
  let items = readItems();
  if(oldCode && oldCode !== code){
    items = items.filter(i=> i.code !== oldCode);
  }else if(oldCode === code){
    items = items.filter(i=> i.code !== code);
  }
  const item = { code, name, category, unitPrice, description };
  items.push(item);
  writeItems(items);
  res.status(201).json(item);
});

app.delete('/api/items/:code', (req, res) => {
  const code = req.params.code;
  let items = readItems();
  items = items.filter(i=> i.code !== code);
  writeItems(items);
  res.status(204).end();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
