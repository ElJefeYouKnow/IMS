let allItems = [];
let jobOptions = [];
const FALLBACK = 'N/A';
const MIN_LINES = 1;
const SESSION_KEY = 'sessionUser';

function uid(){ return Math.random().toString(16).slice(2,8); }
function getSessionUser(){
  try{ return JSON.parse(localStorage.getItem(SESSION_KEY)||'null'); }catch(e){ return null; }
}

// ===== SHARED UTILITIES =====
async function loadItems(){
  allItems = await utils.fetchJsonSafe('/api/items', {}, []) || [];
}

async function loadJobOptions(){
  const jobs = await utils.fetchJsonSafe('/api/jobs', {}, []);
  const today = new Date();
  jobOptions = (jobs || [])
    .filter(j=> !j.scheduleDate || new Date(j.scheduleDate) >= today)
    .map(j=> j.code)
    .filter(Boolean)
    .sort();
  applyJobOptions();
}

function applyJobOptions(){
  const ids = ['checkin-jobId','checkout-jobId','reserve-jobId','return-jobId'];
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
  const priceId = `${prefix}-price-${uid()}`;
  const qtyId = `${prefix}-qty-${uid()}`;
  const suggId = `${codeId}-s`;
  const row = document.createElement('div');
  row.className = 'form-row line-row';
  row.innerHTML = `
    <label>Item Code
      <input id="${codeId}" name="code" required placeholder="SKU, part number or barcode">
      <div id="${suggId}" class="suggestions"></div>
    </label>
    <label>Item Name<input id="${nameId}" name="name" placeholder="Enter name if new"></label>
    <label>Category<input id="${categoryId}" name="category" placeholder="Category / type"></label>
    <label>Unit Price<input id="${priceId}" name="price" type="number" step="0.01" placeholder="0.00"></label>
    <label style="max-width:120px;">Qty<input id="${qtyId}" name="qty" type="number" min="1" value="1" required></label>
    <button type="button" class="muted remove-line">Remove</button>
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
    priceInputId: priceId,
    suggestionsId: suggId
  });
}

function resetLines(prefix){
  const container = document.getElementById(`${prefix}-lines`);
  if(!container) return;
  container.innerHTML = '';
  addLine(prefix);
}

function gatherLines(prefix){
  const rows=[...document.querySelectorAll(`#${prefix}-lines .line-row`)];
  const items=[];
  rows.forEach(r=>{
    const code = r.querySelector('input[name="code"]')?.value.trim() || '';
    const name = r.querySelector('input[name="name"]')?.value.trim() || '';
    const category = r.querySelector('input[name="category"]')?.value.trim() || '';
    const unitPriceRaw = r.querySelector('input[name="price"]')?.value.trim();
    const parsedPrice = unitPriceRaw ? Number(unitPriceRaw) : null;
    const unitPrice = parsedPrice !== null && !Number.isNaN(parsedPrice) ? parsedPrice : null;
    const qty = parseInt(r.querySelector('input[name="qty"]')?.value || '0', 10) || 0;
    if(code && qty>0){
      items.push({code,name,category,unitPrice,qty});
    }
  });
  return items;
}

function getOutstandingCheckouts(checkouts, returns){
  const map = new Map(); // key -> {qty, last}
  const sum = (list, sign)=>{
    list.forEach(e=>{
      const key = `${e.code}|${(e.jobId||'').trim()}`;
      const qty = Number(e.qty)||0;
      if(!map.has(key)) map.set(key,{qty:0,last:0,entry:e});
      const rec = map.get(key);
      rec.qty += sign*qty;
      if((e.ts||0) > rec.last){ rec.last = e.ts||0; rec.entry = e; }
    });
  };
  sum(checkouts, 1);
  sum(returns, -1);
  return Array.from(map.entries())
    .filter(([,v])=> v.qty > 0)
    .map(([key,v])=>({key, outstanding:v.qty, entry:v.entry}));
}

async function refreshReturnDropdown(select){
  const checkouts = await loadCheckouts();
  const returns = await loadReturns();
  const outstanding = getOutstandingCheckouts(checkouts, returns);
  select.innerHTML = '<option value="">-- Manual Entry --</option>';
  outstanding.slice(-20).reverse().forEach(item=>{
    const co = item.entry;
    const opt = document.createElement('option');
    opt.value = JSON.stringify({...co, qty: item.outstanding});
    opt.textContent = `${co.code} (Job: ${co.jobId||FALLBACK}, Qty left: ${item.outstanding})`;
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
    }
    document.getElementById('return-jobId').value = co.jobId || '';
    document.getElementById('return-reason').value = 'unused';
  };
}

// ===== CHECK-IN MODE =====
async function loadCheckins(){
  return await utils.fetchJsonSafe('/api/inventory?type=in', {}, []) || [];
}

async function renderCheckinTable(){
  const tbody=document.querySelector('#checkinTable tbody');tbody.innerHTML='';
  const entries = await loadCheckins();
  if(!entries.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:#6b7280;">No check-ins yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${e.code}</td><td>${e.name||''}</td><td>${e.qty}</td><td>${e.location||''}</td><td>${e.jobId||FALLBACK}</td><td>${new Date(e.ts).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
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
    tr.innerHTML=`<td colspan="4" style="text-align:center;color:#6b7280;">No check-outs yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${e.code}</td><td>${e.jobId||FALLBACK}</td><td>${e.qty}</td><td>${new Date(e.ts).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
}

async function addCheckout(e){
  try{
    const r = await fetch('/api/inventory-checkout',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)
    });
    if(r.ok){
      await renderCheckoutTable();
      return true;
    }
  }catch(e){}
  return false;
}

async function clearCheckouts(){
  try{ await fetch('/api/inventory-checkout',{method:'DELETE'}); }catch(e){}
  await renderCheckoutTable();
}

function exportCheckoutCSV(){
  exportCSV('checkout');
}

// ===== RESERVE MODE =====
async function loadReservations(){
  return await utils.fetchJsonSafe('/api/inventory-reserve', {}, []) || [];
}

async function renderReserveTable(){
  const tbody=document.querySelector('#reserveTable tbody');tbody.innerHTML='';
  const entries = await loadReservations();
  if(!entries.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="5" style="text-align:center;color:#6b7280;">No reservations yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const tr=document.createElement('tr');
    const returnDate = e.returnDate ? new Date(e.returnDate).toLocaleDateString() : FALLBACK;
    tr.innerHTML=`<td>${e.code}</td><td>${e.jobId}</td><td>${e.qty}</td><td>${returnDate}</td><td>${new Date(e.ts).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
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
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:#6b7280;">No returns yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${e.code}</td><td>${e.qty}</td><td>${e.jobId||FALLBACK}</td><td>${e.reason||FALLBACK}</td><td>${e.location||FALLBACK}</td><td>${new Date(e.ts).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
}

async function addReturn(e){
  try{
    const r = await fetch('/api/inventory-return',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)
    });
    if(r.ok){
      await renderReturnTable();
      return true;
    }
  }catch(e){}
  return false;
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
  document.getElementById('checkin-mode').classList.remove('active');
  document.getElementById('checkout-mode').classList.remove('active');
  document.getElementById('reserve-mode').classList.remove('active');
  document.getElementById('return-mode').classList.remove('active');
  
  // Remove active from all buttons
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
  
  // Show selected mode
  document.getElementById(`${mode}-mode`).classList.add('active');
  document.querySelector(`[data-mode="${mode}"]`).classList.add('active');
}

// ===== DOM READY =====
document.addEventListener('DOMContentLoaded', async ()=>{
  await loadItems();
  await loadJobOptions();
  const initialMode = new URLSearchParams(window.location.search).get('mode') || 'checkin';
  if(window.utils && utils.setupLogout) utils.setupLogout();
  
  // Load all tables initially
  await renderCheckinTable();
  await renderCheckoutTable();
  await renderReserveTable();
  await renderReturnTable();
  // Initialize line items
  resetLines('checkin');
  resetLines('checkout');
  resetLines('reserve');
  resetLines('return');
  ['checkin','checkout','reserve','return'].forEach(prefix=>{
    const btn = document.getElementById(`${prefix}-addLine`);
    if(btn) btn.addEventListener('click', ()=> addLine(prefix));
  });
  switchMode(initialMode);
  
  
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
    const jobId = document.getElementById('checkin-jobId').value.trim();
    const notes = document.getElementById('checkin-notes').value.trim();
    const user = getSessionUser();
    if(!lines.length){alert('Add at least one line with code and quantity'); return;}
    const missingName = lines.find(l=> !allItems.find(i=> i.code === l.code) && !l.name);
    if(missingName){ alert(`Item ${missingName.code} is new. Add a name before checking in.`); return; }
    let okAll=true;
    for(const line of lines){
      const ok = await addCheckin({code: line.code, name: line.name, qty: line.qty, location, jobId, notes, ts: Date.now(), userEmail: user?.email, userName: user?.name, unitPrice: line.unitPrice, category: line.category});
      if(!ok) okAll=false;
    }
    if(!okAll) alert('Some items failed to check in');
    checkinForm.reset();
    resetLines('checkin');
    ensureJobOption(jobId);
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
    for(const line of lines){
      const ok = await addCheckout({code: line.code, jobId, qty: line.qty, notes, ts: Date.now(), type: 'out', userEmail: user?.email, userName: user?.name});
      if(!ok) okAll=false;
    }
    if(!okAll) alert('Some items failed to check out');
    checkoutForm.reset();
    resetLines('checkout');
    ensureJobOption(jobId);
  });
  
  document.getElementById('checkout-clearBtn').addEventListener('click', async ()=>{
    if(confirm('Clear all check-out entries?')) await clearCheckouts();
  });
  document.getElementById('checkout-exportBtn').addEventListener('click', exportCheckoutCSV);
  
  // ===== RESERVE FORM =====
  const reserveForm = document.getElementById('reserveForm');
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
  
  document.getElementById('reserve-clearBtn').addEventListener('click', async ()=>{
    if(confirm('Clear all reservations?')) await clearReservations();
  });
  document.getElementById('reserve-exportBtn').addEventListener('click', exportReserveCSV);
  
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
      for(const line of lines){
        const ok = await addReturn({code: line.code, jobId, qty: line.qty, reason, location, notes, ts: Date.now(), type: 'return', userEmail: user?.email, userName: user?.name});
        if(!ok) okAll=false;
      }
      if(!okAll) alert('Some items failed to return');
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
