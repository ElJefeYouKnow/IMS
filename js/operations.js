let allItems = [];
let jobOptions = [];
let openOrders = [];
let openOrdersMap = new Map();
const FALLBACK = 'N/A';
const MIN_LINES = 1;
const SESSION_KEY = 'sessionUser';

function uid(){ return Math.random().toString(16).slice(2,8); }
function getSessionUser(){
  try{ return JSON.parse(localStorage.getItem(SESSION_KEY)||'null'); }catch(e){ return null; }
}
function normalizeJobId(value){
  const val = (value || '').toString().trim();
  if(!val) return '';
  const lowered = val.toLowerCase();
  if(['general','general inventory','none','unassigned'].includes(lowered)) return '';
  return val;
}
function getEntryJobId(entry){
  return normalizeJobId(entry?.jobId || entry?.jobid || '');
}

// ===== SHARED UTILITIES =====
async function loadItems(){
  allItems = await utils.fetchJsonSafe('/api/items', {}, []) || [];
}
function addItemLocally(item){
  if(!item || !item.code) return;
  const exists = allItems.find(i=> i.code === item.code);
  if(!exists){
    allItems.push(item);
  }
}

async function loadJobOptions(){
  const jobs = await utils.fetchJsonSafe('/api/jobs', {}, []);
  const today = new Date();
  jobOptions = (jobs || [])
    .filter(j=>{
      if(!j.endDate) return true;
      const end = new Date(j.endDate);
      return !Number.isNaN(end.getTime()) && end >= today;
    })
    .map(j=> j.code)
    .filter(Boolean)
    .sort();
  applyJobOptions();
}

function applyJobOptions(){
  const ids = ['checkout-jobId','return-jobId'];
  ids.forEach(id=>{
    const sel = document.getElementById(id);
    if(!sel) return;
    const current = sel.value;
    const isRequired = sel.hasAttribute('required');
    sel.innerHTML = isRequired ? '<option value="">Select job...</option>' : '<option value="">General Inventory</option>';
    jobOptions.forEach(job=>{
      const opt=document.createElement('option');
      opt.value=job; opt.textContent=job;
      sel.appendChild(opt);
    });
    if(current) sel.value=current;
  });
}

function ensureJobOption(jobId){
  const id = (jobId||'').trim();
  if(!id) return;
  if(!jobOptions.includes(id)) return; // only allow known, non-expired jobs
}

function addLine(prefix){
  const container = document.getElementById(`${prefix}-lines`);
  if(!container) return;
  const codeId = `${prefix}-code-${uid()}`;
  const nameId = `${prefix}-name-${uid()}`;
  const categoryId = `${prefix}-category-${uid()}`;
  const qtyId = `${prefix}-qty-${uid()}`;
  const suggId = `${codeId}-s`;
  const sourceFields = prefix === 'checkin' ? `<input type="hidden" name="sourceId"><input type="hidden" name="sourceType">` : '';
  const row = document.createElement('div');
  row.className = 'form-row line-row';
  row.innerHTML = `
    <label>Item Code
      <input id="${codeId}" name="code" required placeholder="SKU, part number or barcode">
      <div id="${suggId}" class="suggestions"></div>
    </label>
    <label>Item Name<input id="${nameId}" name="name" placeholder="Enter name if new"></label>
    <label>Category<input id="${categoryId}" name="category" placeholder="Category / type"></label>
    <label style="max-width:120px;">Qty<input id="${qtyId}" name="qty" type="number" min="1" value="1" required></label>
    <button type="button" class="muted remove-line">Remove</button>
    ${sourceFields}
  `;
  container.appendChild(row);
  row.querySelector('.remove-line').addEventListener('click', ()=>{
    if(container.querySelectorAll('.line-row').length > MIN_LINES){
      row.remove();
    }
  });
  utils.attachItemLookup({
    getItems: ()=> allItems,
    codeInputId: codeId,
    nameInputId: nameId,
    categoryInputId: categoryId,
    suggestionsId: suggId
  });
}

function resetLines(prefix){
  const container = document.getElementById(`${prefix}-lines`);
  if(!container) return;
  container.innerHTML = '';
  if(prefix !== 'checkin') addLine(prefix);
}

function gatherLines(prefix){
  const rows=[...document.querySelectorAll(`#${prefix}-lines .line-row`)];
  const items=[];
  rows.forEach(r=>{
    const code = r.querySelector('input[name="code"]')?.value.trim() || '';
    const name = r.querySelector('input[name="name"]')?.value.trim() || '';
    const category = r.querySelector('input[name="category"]')?.value.trim() || '';
    const qty = parseInt(r.querySelector('input[name="qty"]')?.value || '0', 10) || 0;
    if(code && qty>0){
      const sourceId = r.querySelector('input[name="sourceId"]')?.value || '';
      const sourceType = r.querySelector('input[name="sourceType"]')?.value || '';
      const jobId = r.dataset.jobId || '';
      items.push({code,name,category,qty,sourceId,sourceType,jobId});
    }
  });
  return items;
}

function getOutstandingCheckouts(checkouts, returns){
  const map = new Map(); // key -> {qty, last}
  const sum = (list, sign)=>{
    list.forEach(e=>{
      const jobId = getEntryJobId(e);
      const key = `${e.code}|${jobId}`;
      const qty = Number(e.qty)||0;
      if(!map.has(key)) map.set(key,{qty:0,last:0,entry:{...e, jobId}});
      const rec = map.get(key);
      rec.qty += sign*qty;
      if((e.ts||0) > rec.last){ rec.last = e.ts||0; rec.entry = {...e, jobId}; }
    });
  };
  sum(checkouts, 1);
  sum(returns, -1);
  return Array.from(map.entries())
    .filter(([,v])=> v.qty > 0)
    .map(([key,v])=>({key, outstanding:v.qty, entry:v.entry}));
}

function wireSelectAll(tableId){
  const master = document.querySelector(`input[data-select-all="${tableId}"]`);
  if(!master) return;
  master.addEventListener('change', ()=>{
    document.querySelectorAll(`#${tableId} tbody .row-select`).forEach(cb=> cb.checked = master.checked);
  });
}

function fmtDT(val){ return (window.utils && utils.formatDateTime) ? utils.formatDateTime(val) : (val ? new Date(val).toLocaleString() : ''); }
function fmtD(val){ return (window.utils && utils.formatDateOnly) ? utils.formatDateOnly(val) : (val ? new Date(val).toLocaleDateString() : ''); }

async function refreshReturnDropdown(select){
  const checkouts = await loadCheckouts();
  const returns = await loadReturns();
  const outstanding = getOutstandingCheckouts(checkouts, returns);
  select.innerHTML = '<option value="">-- Manual Entry --</option>';
  outstanding.slice(-20).reverse().forEach(item=>{
    const co = item.entry;
    const jobId = getEntryJobId(co);
    const opt = document.createElement('option');
    opt.value = JSON.stringify({...co, jobId, qty: item.outstanding});
    opt.textContent = `${co.code} (Job: ${jobId||FALLBACK}, Qty left: ${item.outstanding})`;
    select.appendChild(opt);
  });
  select.onchange = ()=>{
    if(!select.value) return;
    const co = JSON.parse(select.value);
    const row = document.querySelector('#return-lines .line-row');
    if(row){
      row.querySelector('input[name="code"]').value = co.code;
      row.querySelector('input[name="name"]').value = co.name || '';
      row.querySelector('input[name="qty"]').value = co.qty;
      row.dataset.jobId = (co.jobId || '').trim();
    }
    document.getElementById('return-jobId').value = co.jobId || '';
    document.getElementById('return-reason').value = 'unused';
  };
}

// ===== CHECK-IN MODE =====
async function loadCheckins(){
  return await utils.fetchJsonSafe('/api/inventory?type=in', {}, []) || [];
}
async function loadOrders(){
  return await utils.fetchJsonSafe('/api/inventory?type=ordered', {}, []) || [];
}

async function loadOpenOrders(){
  const [orders, inventory] = await Promise.all([
    loadOrders(),
    utils.fetchJsonSafe('/api/inventory', {}, [])
  ]);
  const map = new Map();
  (orders||[]).forEach(o=>{
    const sourceId = o.sourceId || o.id;
    const jobId = normalizeJobId(o.jobId || o.jobid || '');
    map.set(sourceId, {
      sourceId,
      sourceType: 'order',
      code: o.code,
      name: o.name || '',
      jobId,
      eta: o.eta || '',
      ordered: Number(o.qty || 0),
      checkedIn: 0
    });
  });
  (inventory||[]).filter(e=> e.type === 'in' && e.sourceId).forEach(ci=>{
    const sourceId = ci.sourceId;
    if(!map.has(sourceId)) return;
    const rec = map.get(sourceId);
    rec.checkedIn += Number(ci.qty || 0);
  });
  // Fallback: allocate unlinked check-ins by code + project so fully received orders disappear.
  const unlinked = (inventory || []).filter(e=> e.type === 'in' && !e.sourceId);
  unlinked.forEach(ci=>{
    const code = ci.code;
    if(!code) return;
    const jobId = normalizeJobId(ci.jobId || ci.jobid || '');
    let qtyLeft = Number(ci.qty || 0);
    if(qtyLeft <= 0) return;
    const candidates = Array.from(map.values())
      .filter(r=> r.code === code && (r.jobId || '') === (jobId || ''))
      .sort((a,b)=> (a.eta || '').localeCompare(b.eta || '') || (a.sourceId || '').localeCompare(b.sourceId || ''));
    candidates.forEach(rec=>{
      if(qtyLeft <= 0) return;
      const open = Math.max(0, rec.ordered - rec.checkedIn);
      if(open <= 0) return;
      const useQty = Math.min(open, qtyLeft);
      rec.checkedIn += useQty;
      qtyLeft -= useQty;
    });
  });
  openOrders = [];
  openOrdersMap = new Map();
  map.forEach(rec=>{
    const openQty = Math.max(0, rec.ordered - rec.checkedIn);
    if(openQty <= 0) return;
    const row = { ...rec, openQty };
    openOrders.push(row);
    openOrdersMap.set(rec.sourceId, row);
  });
  openOrders.sort((a,b)=> (a.eta || '').localeCompare(b.eta || '') || a.code.localeCompare(b.code));
  return openOrders;
}

async function renderCheckinTable(){
  const tbody=document.querySelector('#checkinTable tbody');tbody.innerHTML='';
  const entries = await loadCheckins();
  if(!entries.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="7" style="text-align:center;color:#6b7280;">No check-ins yet</td>`;
    tbody.appendChild(tr);
    wireSelectAll('checkinTable');
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td><input type="checkbox" class="row-select" data-payload='${JSON.stringify({code:e.code,name:e.name,qty:e.qty,location:e.location,jobId:e.jobId,ts:e.ts})}'></td><td>${e.code}</td><td>${e.name||''}</td><td>${e.qty}</td><td>${e.location||''}</td><td>${e.jobId||FALLBACK}</td><td>${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
  wireSelectAll('checkinTable');
}

function populateOrderSelect(){
  const sel = document.getElementById('checkin-orderSelect');
  if(!sel) return;
  sel.innerHTML = '<option value="">Select incoming order...</option>';
  if(!openOrders.length){
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No open orders';
    sel.appendChild(opt);
    return;
  }
  openOrders.forEach(o=>{
    const jobLabel = o.jobId || 'General';
    const etaLabel = o.eta || 'N/A';
    const opt = document.createElement('option');
    opt.value = o.sourceId;
    opt.textContent = `${o.code} | ${jobLabel} | Open ${o.openQty} | ETA ${etaLabel}`;
    sel.appendChild(opt);
  });
}

function addOrderLine(sourceId){
  const order = openOrdersMap.get(sourceId);
  if(!order) return;
  addLine('checkin');
  const container = document.getElementById('checkin-lines');
  const row = container.lastElementChild;
  if(!row) return;
  row.querySelector('input[name="code"]').value = order.code;
  row.querySelector('input[name="name"]').value = order.name || '';
  row.querySelector('input[name="qty"]').value = order.openQty;
  row.querySelector('input[name="sourceId"]').value = order.sourceId;
  row.querySelector('input[name="sourceType"]').value = order.sourceType;
  row.dataset.jobId = order.jobId || '';
  row.dataset.openQty = String(order.openQty);
  row.querySelector('input[name="code"]').readOnly = true;
  row.querySelector('input[name="name"]').readOnly = true;
}

async function addCheckin(e){
  try{
    const r = await fetch('/api/inventory',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...e, type:'in'})
    });
    if(r.ok){
      await renderCheckinTable();
      return true;
    }
  }catch(e){}
  return false;
}

async function clearCheckins(){
  try{ await fetch('/api/inventory',{method:'DELETE'}); }catch(e){}
  await renderCheckinTable();
}

function exportCheckinCSV(){
  exportCSV('checkin');
}

// ===== CHECK-OUT MODE =====
async function loadCheckouts(){
  return await utils.fetchJsonSafe('/api/inventory?type=out', {}, []) || [];
}

async function renderCheckoutTable(){
  const tbody=document.querySelector('#checkoutTable tbody');tbody.innerHTML='';
  const entries = await loadCheckouts();
  if(!entries.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:#6b7280;">No check-outs yet</td>`;
    tbody.appendChild(tr);
    wireSelectAll('checkoutTable');
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const jobId = getEntryJobId(e);
    const tr=document.createElement('tr');
    tr.innerHTML=`<td><input type="checkbox" class="row-select" data-payload='${JSON.stringify({code:e.code,jobId,qty:e.qty,name:e.name,ts:e.ts})}'></td><td>${e.code}</td><td>${e.name||''}</td><td>${jobId||FALLBACK}</td><td>${e.qty}</td><td class="mobile-hide">${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
  wireSelectAll('checkoutTable');
}

async function addCheckout(e){
  try{
    const r = await fetch('/api/inventory-checkout',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)
    });
    const data = await r.json().catch(()=>({}));
    if(r.ok){
      await renderCheckoutTable();
      return { ok:true };
    }
    return { ok:false, error: data.error || 'Checkout failed' };
  }catch(err){
    return { ok:false, error: err.message || 'Checkout failed' };
  }
}

async function clearCheckouts(){
  try{ await fetch('/api/inventory-checkout',{method:'DELETE'}); }catch(e){}
  await renderCheckoutTable();
}

function exportCheckoutCSV(){
  exportCSV('checkout');
}
function getSelectedPayloads(tableId){
  const rows = document.querySelectorAll(`#${tableId} tbody .row-select:checked`);
  const out = [];
  rows.forEach(cb=>{
    try{
      const data = JSON.parse(cb.dataset.payload || '{}');
      out.push(data);
    }catch(e){}
  });
  return out;
}
function exportSelected(tableId, headers, mapFn, filename){
  const selected = getSelectedPayloads(tableId);
  if(!selected.length){ alert('Select at least one row first'); return; }
  const rows = selected.map(mapFn);
  const csv=[headers.join(','),...rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename || 'export.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ===== RESERVE MODE =====
async function loadReservations(){
  return await utils.fetchJsonSafe('/api/inventory-reserve', {}, []) || [];
}

async function renderReserveTable(){
  const tbody=document.querySelector('#reserveTable tbody');
  if(!tbody) return;
  tbody.innerHTML='';
  const entries = await loadReservations();
  if(!entries.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:#6b7280;">No reservations yet</td>`;
    tbody.appendChild(tr);
    wireSelectAll('reserveTable');
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const tr=document.createElement('tr');
    const returnDate = fmtD(e.returnDate) || FALLBACK;
    tr.innerHTML=`<td><input type="checkbox" class="row-select" data-payload='${JSON.stringify({code:e.code,jobId:e.jobId,qty:e.qty,returnDate:e.returnDate,ts:e.ts})}'></td><td>${e.code}</td><td>${e.jobId}</td><td>${e.qty}</td><td class="mobile-hide">${returnDate}</td><td class="mobile-hide">${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
  wireSelectAll('reserveTable');
}

async function addReservation(e){
  try{
    const r = await fetch('/api/inventory-reserve',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)
    });
    if(r.ok){
      await renderReserveTable();
      return true;
    }
  }catch(e){}
  return false;
}

async function clearReservations(){
  try{ await fetch('/api/inventory-reserve',{method:'DELETE'}); }catch(e){}
  await renderReserveTable();
}

function exportReserveCSV(){
  exportCSV('reserve');
}

// ===== RETURN MODE =====
async function loadReturns(){
  return await utils.fetchJsonSafe('/api/inventory-return', {}, []) || [];
}

async function renderReturnTable(){
  const tbody=document.querySelector('#returnTable tbody');tbody.innerHTML='';
  const entries = await loadReturns();
  if(!entries.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="7" style="text-align:center;color:#6b7280;">No returns yet</td>`;
    tbody.appendChild(tr);
    wireSelectAll('returnTable');
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const jobId = getEntryJobId(e);
    const tr=document.createElement('tr');
    tr.innerHTML=`<td><input type="checkbox" class="row-select" data-payload='${JSON.stringify({code:e.code,qty:e.qty,jobId,reason:e.reason,location:e.location,ts:e.ts})}'></td><td>${e.code}</td><td>${e.qty}</td><td>${jobId||FALLBACK}</td><td>${e.reason||FALLBACK}</td><td class="mobile-hide">${e.location||FALLBACK}</td><td class="mobile-hide">${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
  wireSelectAll('returnTable');
}

function setMetric(id,val){
  const el = document.getElementById(id);
  if(el) el.textContent = val ?? '-';
}

async function updateOpsMetrics(){
  const metrics = await utils.fetchJsonSafe('/api/metrics', {}, {});
  if(metrics){
    setMetric('ops-available', metrics.availableUnits);
    setMetric('ops-reserved', metrics.reservedUnits);
    setMetric('ops-out', metrics.txLast7 ?? '—');
  }
  const checkouts = await loadCheckouts();
  const returns = await loadReturns();
  const outstanding = getOutstandingCheckouts(checkouts, returns);
  setMetric('ops-due', outstanding.length);
}

async function addReturn(e){
  try{
    const r = await fetch('/api/inventory-return',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)
    });
    const data = await r.json().catch(()=>({}));
    if(r.ok){
      await renderReturnTable();
      return { ok:true };
    }
    return { ok:false, error: data.error || 'Return failed' };
  }catch(e){}
  return { ok:false, error: 'Return failed' };
}

async function clearReturns(){
  try{ await fetch('/api/inventory-return',{method:'DELETE'}); }catch(e){}
  await renderReturnTable();
}

function exportReturnCSV(){
  exportCSV('return');
}

// ===== EXPORT CSV HELPER =====
async function exportCSV(mode){
  let entries = [];
  let hdr = [];
  let filename = '';
  
  if(mode === 'checkin'){
    entries = await loadCheckins();
    hdr = ['code','name','qty','location','jobId','timestamp'];
    filename = 'checkin.csv';
  }else if(mode === 'checkout'){
    entries = await loadCheckouts();
    hdr = ['code','jobId','qty','timestamp'];
    filename = 'checkout.csv';
  }else if(mode === 'reserve'){
    entries = await loadReservations();
    hdr = ['code','jobId','qty','returnDate','timestamp'];
    filename = 'reservations.csv';
  }else if(mode === 'return'){
    entries = await loadReturns();
    hdr = ['code','qty','jobId','reason','location','timestamp'];
    filename = 'returns.csv';
  }
  
  if(!entries.length){alert(`No ${mode} entries to export`);return}
  
  let rows;
  if(mode === 'checkin'){
    rows = entries.map(r=>[r.code,r.name,r.qty,r.location,r.jobId,new Date(r.ts).toISOString()]);
  }else if(mode === 'checkout'){
    rows = entries.map(r=>[r.code,r.jobId,r.qty,new Date(r.ts).toISOString()]);
  }else if(mode === 'reserve'){
    rows = entries.map(r=>[r.code,r.jobId,r.qty,r.returnDate||'',new Date(r.ts).toISOString()]);
  }else if(mode === 'return'){
    rows = entries.map(r=>[r.code,r.qty,r.jobId,r.reason,r.location,new Date(r.ts).toISOString()]);
  }
  
  const csv=[hdr.join(','),...rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ===== MODE SWITCHING =====
function switchMode(mode){
  // Hide all modes
  ['checkin','checkout','reserve','return'].forEach(m=>{
    const el = document.getElementById(`${m}-mode`);
    if(el) el.classList.remove('active');
  });
  
  // Remove active from all buttons
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));

  // Show selected mode
  const target = document.getElementById(`${mode}-mode`);
  if(target) target.classList.add('active');
  const btn = document.querySelector(`[data-mode="${mode}"]`);
  if(btn) btn.classList.add('active');
}

// ===== DOM READY =====
document.addEventListener('DOMContentLoaded', async ()=>{
  await loadItems();
  await loadJobOptions();
  await loadOpenOrders();
  populateOrderSelect();
  updateOpsMetrics();
  const initialMode = new URLSearchParams(window.location.search).get('mode') || 'checkin';
  if(window.utils && utils.setupLogout) utils.setupLogout();
  // adjust available modes based on DOM
  const availableModes = ['checkin','checkout','return'].filter(m=> document.getElementById(`${m}-mode`));
  
  // Load all tables initially
  await renderCheckinTable();
  await renderCheckoutTable();
  await renderReserveTable();
  await renderReturnTable();
  // Initialize line items
  resetLines('checkin');
  resetLines('checkout');
  resetLines('return');
  ['checkin','checkout','return'].forEach(prefix=>{
    const btn = document.getElementById(`${prefix}-addLine`);
    if(btn) btn.addEventListener('click', ()=> addLine(prefix));
  });
  switchMode(initialMode);

  const addOrderBtn = document.getElementById('checkin-addOrderBtn');
  if(addOrderBtn){
    addOrderBtn.addEventListener('click', ()=>{
      const sel = document.getElementById('checkin-orderSelect');
      if(!sel || !sel.value) return;
      addOrderLine(sel.value);
    });
  }
  const orderSelect = document.getElementById('checkin-orderSelect');
  if(orderSelect){
    orderSelect.addEventListener('change', ()=>{
      if(!orderSelect.value) return;
      addOrderLine(orderSelect.value);
      orderSelect.value = '';
    });
  }
  const refreshOrdersBtn = document.getElementById('checkin-refreshOrders');
  if(refreshOrdersBtn){
    refreshOrdersBtn.addEventListener('click', async ()=>{
      await loadOpenOrders();
      populateOrderSelect();
    });
  }
  
  
  // Mode switching
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', async ()=>{
      switchMode(btn.dataset.mode);
      // Auto-load checkouts when switching to return mode
      if(btn.dataset.mode === 'return'){
        const select = document.getElementById('return-fromCheckout');
        await refreshReturnDropdown(select);
      }
    });
  });

  // Export selected buttons
  const checkinSelBtn = document.getElementById('checkin-export-selected');
  if(checkinSelBtn){
    checkinSelBtn.addEventListener('click', ()=>{
      exportSelected('checkinTable', ['code','name','qty','location','jobId','timestamp'], r=>[r.code,r.name||'',r.qty||'',r.location||'',r.jobId||'', r.ts ? new Date(r.ts).toISOString() : ''], 'checkin-selected.csv');
    });
  }
  const checkoutSelBtn = document.getElementById('checkout-export-selected');
  if(checkoutSelBtn){
    checkoutSelBtn.addEventListener('click', ()=>{
      exportSelected('checkoutTable', ['code','jobId','qty','timestamp'], r=>[r.code,r.jobId||'',r.qty||'', r.ts ? new Date(r.ts).toISOString() : ''], 'checkout-selected.csv');
    });
  }
  const returnSelBtn = document.getElementById('return-export-selected');
  if(returnSelBtn){
    returnSelBtn.addEventListener('click', ()=>{
      exportSelected('returnTable', ['code','qty','jobId','reason','location','timestamp'], r=>[r.code,r.qty||'',r.jobId||'',r.reason||'',r.location||'', r.ts ? new Date(r.ts).toISOString() : ''], 'return-selected.csv');
    });
  }

  // ===== RETURN CHECKOUT LOADER (manual refresh option) =====
  const returnLoadBtn = document.getElementById('return-loadCheckoutBtn');
  if(returnLoadBtn){
    returnLoadBtn.addEventListener('click', async ()=>{
      const select = document.getElementById('return-fromCheckout');
      const checkouts = await loadCheckouts();
      if(!checkouts.length){alert('No recent checkouts found'); return}
      await refreshReturnDropdown(select);
      if(select.options.length <= 1){alert('No available checkouts (all have been returned)');}
    });
  }
  
  // ===== CHECK-IN FORM =====
  const checkinForm = document.getElementById('checkinForm');
  checkinForm.addEventListener('submit', async ev=>{
    ev.preventDefault();
    const lines = gatherLines('checkin');
    const location = document.getElementById('checkin-location').value.trim();
    const notes = document.getElementById('checkin-notes').value.trim();
    const user = getSessionUser();
    if(!lines.length){alert('Add at least one incoming order line before receiving.'); return;}
    const missingSource = lines.find(l=> !l.sourceId || !l.sourceType);
    if(missingSource){ alert('Each check-in line must be linked to an incoming order.'); return; }
    const overLimit = [...document.querySelectorAll('#checkin-lines .line-row')].find(row=>{
      const qty = parseInt(row.querySelector('input[name="qty"]')?.value || '0', 10) || 0;
      const open = Number(row.dataset.openQty || 0);
      return open > 0 && qty > open;
    });
    if(overLimit){ alert('Check-in quantity exceeds open order quantity.'); return; }
    let okAll=true;
    for(const line of lines){
      const ok = await addCheckin({code: line.code, name: line.name, qty: line.qty, location, jobId: line.jobId, notes, ts: Date.now(), userEmail: user?.email, userName: user?.name, category: line.category, sourceType: line.sourceType, sourceId: line.sourceId});
      if(ok){
        addItemLocally({code: line.code, name: line.name, category: line.category});
      }else{
        okAll=false;
      }
    }
    if(!okAll) alert('Some items failed to check in');
    checkinForm.reset();
    resetLines('checkin');
    await loadOpenOrders();
    populateOrderSelect();
  });
  
  document.getElementById('checkin-clearBtn').addEventListener('click', async ()=>{
    if(confirm('Clear all check-in entries?')) await clearCheckins();
  });
  document.getElementById('checkin-exportBtn').addEventListener('click', exportCheckinCSV);
  
  // ===== CHECK-OUT FORM =====
  const checkoutForm = document.getElementById('checkoutForm');
  checkoutForm.addEventListener('submit', async ev=>{
    ev.preventDefault();
    const lines = gatherLines('checkout');
    const jobId = document.getElementById('checkout-jobId').value.trim();
    const notes = document.getElementById('checkout-notes').value.trim();
    const user = getSessionUser();
    
    if(!jobId){alert('Job ID required'); return;}
    if(!lines.length){alert('Add at least one line with code and quantity'); return;}
    const missing = lines.find(l=> !allItems.find(i=> i.code === l.code));
    if(missing){ alert(`Item ${missing.code} does not exist. Check it in first or add via check-in.`); return; }
    
    let okAll=true;
    const errors=[];
    for(const line of lines){
      const res = await addCheckout({code: line.code, jobId, qty: line.qty, notes, ts: Date.now(), type: 'out', userEmail: user?.email, userName: user?.name});
      if(!res.ok){
        okAll=false;
        if(res.error) errors.push(`${line.code}: ${res.error}`);
      }
    }
    if(!okAll) alert(errors.join('\n') || 'Some items failed to check out');
    checkoutForm.reset();
    resetLines('checkout');
    ensureJobOption(jobId);
  });
  
  document.getElementById('checkout-clearBtn').addEventListener('click', async ()=>{
    if(confirm('Clear all check-out entries?')) await clearCheckouts();
  });
  document.getElementById('checkout-exportBtn').addEventListener('click', exportCheckoutCSV);
  const devBtn = document.getElementById('devResetBtn');
  const sessionDev = utils.getSession?.();
  if(devBtn && sessionDev && sessionDev.email === 'dev@example.com'){
    devBtn.style.display = 'inline-block';
    devBtn.addEventListener('click', async ()=>{
      const token = prompt('Enter dev reset token to TRUNCATE all data. This is destructive.');
      if(!token) return;
      if(!confirm('Are you sure? This clears all data.')) return;
      const res = await fetch('/api/dev/reset',{method:'POST',headers:{'Content-Type':'application/json','x-dev-reset':token}});
      if(res.ok){ alert('Reset complete. Reloading.'); window.location.reload(); }
      else{
        const data = await res.json().catch(()=>({error:'Reset failed'}));
        alert(data.error || 'Reset failed');
      }
    });
  }
  
  // ===== RESERVE FORM (if present) =====
  const reserveForm = document.getElementById('reserveForm');
  if(reserveForm){
    reserveForm.addEventListener('submit', async ev=>{
      ev.preventDefault();
      const lines = gatherLines('reserve');
      const jobId = document.getElementById('reserve-jobId').value.trim();
      const returnDate = document.getElementById('reserve-returnDate').value;
      const notes = document.getElementById('reserve-notes').value.trim();
      const user = getSessionUser();
      
      if(!jobId){alert('Job ID required'); return;}
      if(!lines.length){alert('Add at least one line with code and quantity'); return;}
      const missing = lines.find(l=> !allItems.find(i=> i.code === l.code));
      if(missing){ alert(`Item ${missing.code} does not exist. Check it in first or add via check-in.`); return; }
      
      let okAll=true;
      for(const line of lines){
        const ok = await addReservation({code: line.code, jobId, qty: line.qty, returnDate, notes, ts: Date.now(), type: 'reserve', userEmail: user?.email, userName: user?.name});
        if(!ok) okAll=false;
      }
      if(!okAll) alert('Some items failed to reserve');
      reserveForm.reset();
      resetLines('reserve');
      ensureJobOption(jobId);
    });
    
    const reserveClearBtn = document.getElementById('reserve-clearBtn');
    reserveClearBtn?.addEventListener('click', async ()=>{
      if(confirm('Clear all reservations?')) await clearReservations();
    });
    document.getElementById('reserve-exportBtn')?.addEventListener('click', exportReserveCSV);
  }
  
  // ===== RETURN FORM =====
  const returnForm = document.getElementById('returnForm');
  if(returnForm){
    returnForm.addEventListener('submit', async ev=>{
      ev.preventDefault();
      const jobId = document.getElementById('return-jobId').value.trim();
      const reason = document.getElementById('return-reason').value.trim();
      const location = document.getElementById('return-location').value.trim();
      const notes = document.getElementById('return-notes').value.trim();
      const user = getSessionUser();
      
      const lines = gatherLines('return');
      if(!lines.length){alert('Add at least one line with code and quantity'); return}
      if(!reason){alert('Return reason required'); return;}
      const missing = lines.find(l=> !allItems.find(i=> i.code === l.code));
      if(missing){ alert(`Item ${missing.code} does not exist. Check it in first.`); return; }
      
      let okAll=true;
      const errors=[];
      for(const line of lines){
        const lineJobId = line.jobId || jobId;
        const res = await addReturn({code: line.code, jobId: lineJobId, qty: line.qty, reason, location, notes, ts: Date.now(), type: 'return', userEmail: user?.email, userName: user?.name});
        if(!res.ok){
          okAll=false;
          if(res.error) errors.push(`${line.code}: ${res.error}`);
        }
      }
      if(!okAll) alert(errors.join('\n') || 'Some items failed to return');
      returnForm.reset();
      resetLines('return');
      const select = document.getElementById('return-fromCheckout');
      if(select) await refreshReturnDropdown(select);
      ensureJobOption(jobId);
    });
  }
  
  const returnClearBtn = document.getElementById('return-clearBtn');
  if(returnClearBtn){
    returnClearBtn.addEventListener('click', async ()=>{
      if(confirm('Clear all returns?')) await clearReturns();
    });
  }
  
  const returnExportBtn = document.getElementById('return-exportBtn');
  if(returnExportBtn){
    returnExportBtn.addEventListener('click', exportReturnCSV);
  }
});
