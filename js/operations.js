let allItems = [];
let jobOptions = [];
const FALLBACK = 'N/A';

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
    document.getElementById('return-itemCode').value = co.code;
    document.getElementById('return-itemName').value = co.name || '';
    document.getElementById('return-jobId').value = co.jobId || '';
    document.getElementById('return-qty').value = co.qty;
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
  
  // Load all tables initially
  await renderCheckinTable();
  await renderCheckoutTable();
  await renderReserveTable();
  await renderReturnTable();
  
  // Setup item lookups for all modes
  utils.attachItemLookup({
    getItems: ()=> allItems,
    codeInputId: 'checkin-itemCode',
    nameInputId: 'checkin-itemName',
    categoryInputId: 'checkin-itemCategory',
    priceInputId: 'checkin-itemUnitPrice',
    suggestionsId: 'checkin-itemCodeSuggestions'
  });
  utils.attachItemLookup({
    getItems: ()=> allItems,
    codeInputId: 'checkout-itemCode',
    nameInputId: 'checkout-itemName',
    categoryInputId: 'checkout-itemCategory',
    priceInputId: 'checkout-itemUnitPrice',
    suggestionsId: 'checkout-itemCodeSuggestions'
  });
  utils.attachItemLookup({
    getItems: ()=> allItems,
    codeInputId: 'reserve-itemCode',
    nameInputId: 'reserve-itemName',
    categoryInputId: 'reserve-itemCategory',
    priceInputId: 'reserve-itemUnitPrice',
    suggestionsId: 'reserve-itemCodeSuggestions'
  });
  utils.attachItemLookup({
    getItems: ()=> allItems,
    codeInputId: 'return-itemCode',
    nameInputId: 'return-itemName',
    categoryInputId: 'return-itemCategory',
    priceInputId: 'return-itemUnitPrice',
    suggestionsId: 'return-itemCodeSuggestions'
  });
  
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
    const code = document.getElementById('checkin-itemCode').value.trim();
    const name = document.getElementById('checkin-itemName').value.trim();
    const qty = parseInt(document.getElementById('checkin-qty').value, 10) || 0;
    const location = document.getElementById('checkin-location').value.trim();
    const jobId = document.getElementById('checkin-jobId').value.trim();
    const notes = document.getElementById('checkin-notes').value.trim();
    
    if(!code || qty <= 0){alert('Please provide item code and quantity'); return}
    
    const ok = await addCheckin({code, name, qty, location, jobId, notes, ts: Date.now()});
    if(!ok) alert('Failed to check in item');
    else{
      checkinForm.reset();
      document.getElementById('checkin-qty').value = '1';
      ensureJobOption(jobId);
    }
  });
  
  document.getElementById('checkin-clearBtn').addEventListener('click', async ()=>{
    if(confirm('Clear all check-in entries?')) await clearCheckins();
  });
  document.getElementById('checkin-exportBtn').addEventListener('click', exportCheckinCSV);
  
  // ===== CHECK-OUT FORM =====
  const checkoutForm = document.getElementById('checkoutForm');
  checkoutForm.addEventListener('submit', async ev=>{
    ev.preventDefault();
    const code = document.getElementById('checkout-itemCode').value.trim();
    const jobId = document.getElementById('checkout-jobId').value.trim();
    const qty = parseInt(document.getElementById('checkout-qty').value, 10) || 0;
    const notes = document.getElementById('checkout-notes').value.trim();
    
    if(!code || !jobId || qty <= 0){alert('Please provide item code, job ID, and quantity'); return}
    
    const ok = await addCheckout({code, jobId, qty, notes, ts: Date.now(), type: 'out'});
    if(!ok) alert('Failed to take item from inventory');
    else{
      checkoutForm.reset();
      document.getElementById('checkout-qty').value = '1';
      ensureJobOption(jobId);
    }
  });
  
  document.getElementById('checkout-clearBtn').addEventListener('click', async ()=>{
    if(confirm('Clear all check-out entries?')) await clearCheckouts();
  });
  document.getElementById('checkout-exportBtn').addEventListener('click', exportCheckoutCSV);
  
  // ===== RESERVE FORM =====
  const reserveForm = document.getElementById('reserveForm');
  reserveForm.addEventListener('submit', async ev=>{
    ev.preventDefault();
    const code = document.getElementById('reserve-itemCode').value.trim();
    const jobId = document.getElementById('reserve-jobId').value.trim();
    const qty = parseInt(document.getElementById('reserve-qty').value, 10) || 0;
    const returnDate = document.getElementById('reserve-returnDate').value;
    const notes = document.getElementById('reserve-notes').value.trim();
    
    if(!code || !jobId || qty <= 0){alert('Please provide item code, job ID, and quantity'); return}
    
    const ok = await addReservation({code, jobId, qty, returnDate, notes, ts: Date.now(), type: 'reserve'});
    if(!ok) alert('Failed to reserve item');
    else{
      reserveForm.reset();
      document.getElementById('reserve-qty').value = '1';
      ensureJobOption(jobId);
    }
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
      const code = document.getElementById('return-itemCode').value.trim();
      const jobId = document.getElementById('return-jobId').value.trim();
      const qty = parseInt(document.getElementById('return-qty').value, 10) || 0;
      const reason = document.getElementById('return-reason').value.trim();
      const location = document.getElementById('return-location').value.trim();
      const notes = document.getElementById('return-notes').value.trim();
      
      if(!code || !reason || qty <= 0){alert('Please provide item code, return reason, and quantity'); return}
      
      const ok = await addReturn({code, jobId, qty, reason, location, notes, ts: Date.now(), type: 'return'});
      if(!ok) alert('Failed to return item');
      else{
        returnForm.reset();
        document.getElementById('return-qty').value = '1';
        const select = document.getElementById('return-fromCheckout');
        if(select) await refreshReturnDropdown(select);
        ensureJobOption(jobId);
      }
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
