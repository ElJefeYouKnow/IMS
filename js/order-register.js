
const SESSION_KEY = 'sessionUser';
const FALLBACK = 'N/A';

function getSession(){
  try{ return JSON.parse(localStorage.getItem(SESSION_KEY)||'null'); }catch(e){ return null; }
}

function uid(){ return Math.random().toString(16).slice(2,8); }

let itemsCache = [];
let jobOptions = [];
let availabilityMap = new Map();
let inventoryCache = [];
let orderRangeFilter = 'all';
let pendingSubmit = null;

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

function buildOrderBalance(orders, inventory){
  const map = new Map();
  (orders||[]).forEach(o=>{
    const sourceId = o.sourceId || o.id;
    const jobId = normalizeJobId(o.jobId || o.jobid || '');
    const key = sourceId;
    if(!map.has(key)) map.set(key, { sourceId, code: o.code, jobId, name: o.name || '', ordered: 0, checkedIn: 0, eta: o.eta || '', lastOrderTs: 0 });
    const rec = map.get(key);
    rec.ordered += Number(o.qty || 0);
    rec.lastOrderTs = Math.max(rec.lastOrderTs, o.ts || 0);
    if(!rec.eta && o.eta) rec.eta = o.eta;
  });
  (inventory||[]).filter(e=> e.type === 'in' && e.sourceId).forEach(ci=>{
    const key = ci.sourceId;
    if(!map.has(key)) return;
    const rec = map.get(key);
    rec.checkedIn += Number(ci.qty || 0);
  });
  // Fallback: allocate unlinked check-ins by code + project
  const unlinked = (inventory || []).filter(e=> e.type === 'in' && !e.sourceId);
  unlinked.forEach(ci=>{
    const code = ci.code;
    if(!code) return;
    const jobId = getEntryJobId(ci);
    let qtyLeft = Number(ci.qty || 0);
    if(qtyLeft <= 0) return;
    const candidates = Array.from(map.values())
      .filter(r=> r.code === code && (r.jobId || '') === (jobId || ''))
      .sort((a,b)=> (a.lastOrderTs || 0) - (b.lastOrderTs || 0));
    candidates.forEach(rec=>{
      if(qtyLeft <= 0) return;
      const open = Math.max(0, rec.ordered - rec.checkedIn);
      if(open <= 0) return;
      const useQty = Math.min(open, qtyLeft);
      rec.checkedIn += useQty;
      qtyLeft -= useQty;
    });
  });
  return map;
}

function computeAvailability(inventory){
  const map = new Map();
  (inventory || []).forEach(e=>{
    if(!e.code) return;
    if(!map.has(e.code)) map.set(e.code, { inQty: 0, outQty: 0, reserveQty: 0 });
    const rec = map.get(e.code);
    const qty = Number(e.qty || 0);
    if(e.type === 'in' || e.type === 'return') rec.inQty += qty;
    else if(e.type === 'out') rec.outQty += qty;
    else if(e.type === 'reserve') rec.reserveQty += qty;
    else if(e.type === 'reserve_release') rec.reserveQty -= qty;
  });
  availabilityMap = new Map();
  map.forEach((rec, code)=>{
    const available = Math.max(0, rec.inQty - rec.outQty - rec.reserveQty);
    availabilityMap.set(code, available);
  });
}

function availableFor(code){
  if(!code) return 0;
  return availabilityMap.get(code) || 0;
}

function fillNameIfKnown(codeInput, nameInput){
  const val = codeInput.value.trim();
  if(!val) return;
  const match = itemsCache.find(i=> i.code.toLowerCase() === val.toLowerCase());
  if(match){
    nameInput.value = match.name || '';
    nameInput.dataset.existing = 'true';
  }else{
    if(nameInput.dataset.existing === 'true'){
      nameInput.value = '';
    }
    nameInput.dataset.existing = 'false';
  }
}

async function loadJobs(){
  try{
    const jobs = await utils.fetchJsonSafe('/api/jobs', {}, []);
    jobOptions = (jobs || []).map(j=> j.code).filter(Boolean).sort();
    const selects = ['orderJob','reserve-jobId','reassign-from','reassign-to'].map(id=> document.getElementById(id)).filter(Boolean);
    selects.forEach(sel=>{
      const current = sel.value;
      const projectOnly = sel.id === 'reserve-jobId' || sel.id === 'reassign-from';
      sel.innerHTML = projectOnly ? '<option value="">Select project...</option>' : '<option value="">General Inventory</option>';
      jobOptions.forEach(job=>{
        const opt = document.createElement('option');
        opt.value = job;
        opt.textContent = job;
        sel.appendChild(opt);
      });
      if(current) sel.value = current;
    });
    refreshOrderLineJobOptions();
  }catch(e){}
}

async function loadItems(){
  try{
    itemsCache = await utils.fetchJsonSafe('/api/items', {}, []) || [];
    refreshSkuDatalist();
  }catch(e){}
}

function refreshSkuDatalist(){
  const list = document.getElementById('order-sku-options');
  if(!list) return;
  list.innerHTML = '';
  itemsCache
    .slice()
    .sort((a,b)=> (a.code || '').localeCompare(b.code || ''))
    .forEach(item=>{
      if(!item.code) return;
      const opt = document.createElement('option');
      opt.value = item.code;
      if(item.name) opt.label = `${item.code} - ${item.name}`;
      list.appendChild(opt);
    });
}

function getGeneralInventoryItems(){
  return (itemsCache || []).filter(item=> availableFor(item.code) > 0);
}

function refreshReserveSkuDatalist(){
  const list = document.getElementById('reserve-sku-options');
  if(!list) return;
  list.innerHTML = '';
  getGeneralInventoryItems()
    .slice()
    .sort((a,b)=> (a.code || '').localeCompare(b.code || ''))
    .forEach(item=>{
      if(!item.code) return;
      const opt = document.createElement('option');
      opt.value = item.code;
      if(item.name) opt.label = `${item.code} - ${item.name}`;
      list.appendChild(opt);
    });
}

function refreshOrderLineJobOptions(){
  const selects = document.querySelectorAll('.order-line select[name="jobId"]');
  selects.forEach(sel=>{
    const current = sel.value;
    sel.innerHTML = '<option value="">Use default</option>';
    jobOptions.forEach(job=>{
      const opt = document.createElement('option');
      opt.value = job;
      opt.textContent = job;
      sel.appendChild(opt);
    });
    if(current) sel.value = current;
  });
}

function setEtaDays(days){
  const eta = document.getElementById('orderEta');
  const d = new Date();
  d.setDate(d.getDate()+days);
  eta.value = d.toISOString().slice(0,10);
}

function setEtaNextMonday(){
  const eta = document.getElementById('orderEta');
  const d = new Date();
  const day = d.getDay();
  const add = ((8 - day) % 7) || 7;
  d.setDate(d.getDate()+add);
  eta.value = d.toISOString().slice(0,10);
}

function addOrderLine(prefill = {}){
  const container = document.getElementById('order-lines');
  if(!container) return;
  const codeId = `order-code-${uid()}`;
  const nameId = `order-name-${uid()}`;
  const qtyId = `order-qty-${uid()}`;
  const etaId = `order-eta-${uid()}`;
  const jobId = `order-job-${uid()}`;
  const suggId = `${codeId}-s`;

  const row = document.createElement('div');
  row.className = 'form-row line-row order-line';
  row.innerHTML = `
    <label class="with-suggest">Item Code
      <input id="${codeId}" name="code" placeholder="SKU/part" required>
      <div id="${suggId}" class="suggestions"></div>
    </label>
    <label>Item Name<input id="${nameId}" name="name" placeholder="Required for new codes"></label>
    <label style="max-width:120px;">Qty<input id="${qtyId}" name="qty" type="number" min="1" value="1" required></label>
    <label style="max-width:160px;">ETA<input id="${etaId}" name="eta" type="date" class="eta-input"></label>
    <label>Project
      <select id="${jobId}" name="jobId"></select>
    </label>
    <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-start;">
      <button type="button" class="muted remove-line">Remove</button>
      <div class="line-error"></div>
    </div>
  `;
  container.appendChild(row);

  const codeInput = row.querySelector('input[name="code"]');
  const nameInput = row.querySelector('input[name="name"]');
  const qtyInput = row.querySelector('input[name="qty"]');
  const etaInput = row.querySelector('input[name="eta"]');
  const jobSelect = row.querySelector('select[name="jobId"]');

  refreshOrderLineJobOptions();

  const applyDefault = document.getElementById('order-apply-default')?.checked;
  const defaultJob = document.getElementById('orderJob')?.value.trim() || '';
  const defaultEta = document.getElementById('orderEta')?.value || '';

  if(applyDefault && defaultJob){
    jobSelect.value = defaultJob;
  }
  if(applyDefault && defaultEta){
    etaInput.value = defaultEta;
  }

  if(prefill.code){ codeInput.value = prefill.code; }
  if(prefill.name){ nameInput.value = prefill.name; }
  if(prefill.qty){ qtyInput.value = prefill.qty; }
  if(prefill.eta){ etaInput.value = prefill.eta; }
  if(prefill.jobId){ jobSelect.value = prefill.jobId; }

  codeInput.setAttribute('list', 'order-sku-options');
  codeInput.addEventListener('input', ()=> fillNameIfKnown(codeInput, nameInput));
  codeInput.addEventListener('blur', ()=> fillNameIfKnown(codeInput, nameInput));
  codeInput.addEventListener('change', ()=> fillNameIfKnown(codeInput, nameInput));

  fillNameIfKnown(codeInput, nameInput);

  row.querySelector('.remove-line').addEventListener('click', ()=>{
    row.remove();
    if(!container.querySelector('.order-line')){
      addOrderLine();
    }
  });
}

function clearOrderLines(){
  const container = document.getElementById('order-lines');
  if(container){
    container.innerHTML = '';
    addOrderLine();
  }
}

function clearLineError(row){
  row.classList.remove('has-error');
  const err = row.querySelector('.line-error');
  if(err) err.textContent = '';
}

function setLineError(row, message){
  row.classList.add('has-error');
  const err = row.querySelector('.line-error');
  if(err) err.textContent = message;
}

function gatherOrderLines(){
  const rows = Array.from(document.querySelectorAll('#order-lines .order-line'));
  const defaultJob = document.getElementById('orderJob')?.value.trim() || '';
  const defaultEta = document.getElementById('orderEta')?.value || '';
  const applyDefault = document.getElementById('order-apply-default')?.checked;

  const lines = rows.map(row=>{
    const code = row.querySelector('input[name="code"]')?.value.trim() || '';
    const name = row.querySelector('input[name="name"]')?.value.trim() || '';
    const qty = parseInt(row.querySelector('input[name="qty"]')?.value || '0', 10) || 0;
    const eta = row.querySelector('input[name="eta"]')?.value || (applyDefault ? defaultEta : '');
    const lineJob = row.querySelector('select[name="jobId"]')?.value.trim() || '';
    const jobId = lineJob || (applyDefault ? defaultJob : '');
    return { row, code, name, qty, eta, jobId };
  });

  let hasError = false;
  lines.forEach(line=>{
    clearLineError(line.row);
    const match = itemsCache.find(i=> i.code.toLowerCase() === line.code.toLowerCase());
    if(match && !line.name){ line.name = match.name || ''; }
    if(!line.code){
      setLineError(line.row, 'Code is required');
      hasError = true;
      return;
    }
    if(line.qty <= 0){
      setLineError(line.row, 'Quantity must be at least 1');
      hasError = true;
      return;
    }
    if(!line.eta){
      setLineError(line.row, 'ETA is required');
      hasError = true;
      return;
    }
    if(!match && !line.name){
      setLineError(line.row, 'Name required for new code');
      hasError = true;
      return;
    }
  });

  return { lines, hasError };
}

function parseBulkOrders(text){
  const lines = text.split('\n').map(l=> l.split(','));
  const orders = [];
  for(const parts of lines){
    const [code,name,qty,eta,jobId] = parts.map(p=> (p||'').trim());
    if(!code || !qty) continue;
    orders.push({ code, name, qty:Number(qty), eta, jobId });
  }
  return orders;
}

function openReviewModal(lines, clearAll){
  const modal = document.getElementById('orderReviewModal');
  if(!modal) return;
  const tbody = document.querySelector('#orderReviewTable tbody');
  const summary = document.getElementById('orderReviewSummary');
  const autoReserve = document.getElementById('order-auto-reserve')?.checked;

  pendingSubmit = { lines, clearAll, autoReserve };
  tbody.innerHTML = '';
  lines.forEach(line=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${line.code}</td><td>${line.name || ''}</td><td>${line.qty}</td><td>${line.eta}</td><td>${line.jobId || 'General'}</td>`;
    tbody.appendChild(tr);
  });
  const totalQty = lines.reduce((sum,l)=> sum + (Number(l.qty)||0), 0);
  summary.textContent = `${lines.length} lines, ${totalQty} total units, auto-reserve ${autoReserve ? 'on' : 'off'}.`;

  modal.classList.remove('hidden');
}

function closeReviewModal(){
  const modal = document.getElementById('orderReviewModal');
  if(modal) modal.classList.add('hidden');
  pendingSubmit = null;
}

async function submitOrders(lines, clearAll){
  const msg = document.getElementById('orderMsg');
  if(msg) msg.textContent = '';
  const session = getSession();
  if(!session || session.role !== 'admin'){
    if(msg){ msg.style.color = '#b91c1c'; msg.textContent = 'Admin only'; }
    return false;
  }

  const notes = document.getElementById('orderNotes')?.value.trim() || '';
  const autoReserve = document.getElementById('order-auto-reserve')?.checked;
  const payload = lines.map(line=>({
    code: line.code,
    name: line.name,
    qty: line.qty,
    eta: line.eta,
    jobId: line.jobId,
    notes,
    autoReserve
  }));

  try{
    const r = await fetch('/api/inventory-order/bulk',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ orders: payload, userEmail: session.email, userName: session.name })
    });
    const data = await r.json().catch(()=>({}));
    if(!r.ok){
      if(msg){ msg.style.color = '#b91c1c'; msg.textContent = data.error || 'Failed to register orders'; }
      return false;
    }
    if(msg){ msg.style.color = '#15803d'; msg.textContent = `Registered ${data.count || payload.length} orders`; }

    const keepJob = document.getElementById('order-stick-job')?.checked;
    const defaultJob = document.getElementById('orderJob')?.value || '';
    const defaultEta = document.getElementById('orderEta')?.value || '';
    if(clearAll){
      document.getElementById('orderForm')?.reset();
      if(keepJob) document.getElementById('orderJob').value = defaultJob;
      if(defaultEta) document.getElementById('orderEta').value = defaultEta;
    }
    clearOrderLines();
    if(keepJob) document.getElementById('orderJob').value = defaultJob;

    await renderRecentOrders();
    return true;
  }catch(e){
    if(msg){ msg.style.color = '#b91c1c'; msg.textContent = 'Failed to register orders'; }
    return false;
  }
}

function renderIncomingSummary(rows){
  const openUnits = rows.reduce((sum,r)=> sum + (Number(r.openQty)||0), 0);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const overdue = rows.filter(r=>{
    const etaTs = Date.parse(r.eta || '');
    return etaTs && etaTs < today;
  });
  const upcoming = rows.filter(r=>{
    const etaTs = Date.parse(r.eta || '');
    return etaTs && etaTs >= today;
  }).sort((a,b)=> Date.parse(a.eta||'') - Date.parse(b.eta||''));

  const nextEta = upcoming.length ? upcoming[0].eta : FALLBACK;

  const topMap = new Map();
  rows.forEach(r=>{
    const key = r.code;
    const current = topMap.get(key) || { code: r.code, name: r.name || '', qty: 0 };
    current.qty += Number(r.openQty)||0;
    topMap.set(key, current);
  });
  const topItems = Array.from(topMap.values()).sort((a,b)=> b.qty - a.qty).slice(0,5);

  const orderSummaryCount = document.getElementById('orderSummaryCount');
  const orderSummaryLate = document.getElementById('orderSummaryLate');
  const orderSummaryNext = document.getElementById('orderSummaryNext');
  const orderSummaryTop = document.getElementById('orderSummaryTop');
  const orderSummaryEta = document.getElementById('orderSummaryEta');

  if(orderSummaryCount) orderSummaryCount.textContent = `${openUnits}`;
  if(orderSummaryLate) orderSummaryLate.textContent = `${overdue.length}`;
  if(orderSummaryNext) orderSummaryNext.textContent = nextEta || FALLBACK;

  if(orderSummaryTop){
    orderSummaryTop.innerHTML = '';
    if(!topItems.length){
      orderSummaryTop.innerHTML = '<div class="ds-empty">No open orders.</div>';
    }else{
      topItems.forEach(item=>{
        const row = document.createElement('div');
        const nameLabel = item.name ? ` - ${item.name}` : '';
        row.className = 'summary-row';
        row.innerHTML = `<span>${item.code}${nameLabel}</span><span>${item.qty}</span>`;
        orderSummaryTop.appendChild(row);
      });
    }
  }

  if(orderSummaryEta){
    orderSummaryEta.innerHTML = '';
    const list = upcoming.slice(0,5);
    if(!list.length){
      orderSummaryEta.innerHTML = '<div class="ds-empty">No upcoming ETAs.</div>';
    }else{
      list.forEach(item=>{
        const row = document.createElement('div');
        row.className = 'summary-row';
        row.innerHTML = `<span>${item.code}</span><span>${item.eta || FALLBACK}</span>`;
        orderSummaryEta.appendChild(row);
      });
    }
  }
}

async function renderRecentOrders(){
  const tbody = document.querySelector('#recentOrdersTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const [orders, inventory] = await Promise.all([
    utils.fetchJsonSafe('/api/inventory?type=ordered', {}, []),
    utils.fetchJsonSafe('/api/inventory', {}, [])
  ]);
  inventoryCache = inventory;
  computeAvailability(inventory);
  const balances = buildOrderBalance(orders, inventory);
  const filter = (document.getElementById('orderFilter')?.value || '').toLowerCase();
  const rows = [];
  balances.forEach((rec)=>{
    const openQty = Math.max(0, rec.ordered - rec.checkedIn);
    if(openQty <= 0) return;
    const job = normalizeJobId(rec.jobId || '').toLowerCase();
    if(filter && !(rec.code.toLowerCase().includes(filter) || job.includes(filter))) return;
    rows.push({ ...rec, openQty });
  });

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let filtered = rows;
  if(orderRangeFilter === 'today'){
    filtered = rows.filter(r=> (r.lastOrderTs || 0) >= todayStart);
  }else if(orderRangeFilter === 'week'){
    const weekAgo = todayStart - (6 * 24 * 60 * 60 * 1000);
    filtered = rows.filter(r=> (r.lastOrderTs || 0) >= weekAgo);
  }else if(orderRangeFilter === 'late'){
    filtered = rows.filter(r=>{
      const etaTs = Date.parse(r.eta || '');
      return etaTs && etaTs < todayStart;
    });
  }

  const recent = filtered.sort((a,b)=> (b.lastOrderTs||0)-(a.lastOrderTs||0)).slice(0,12);
  if(!recent.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" class="ds-table-empty">No orders yet</td>`;
    tbody.appendChild(tr);
  }else{
    recent.forEach(o=>{
      const tr=document.createElement('tr');
      const jobValue = o.jobId || '';
      const jobLabel = jobValue && jobValue.trim() ? jobValue : 'General';
      const tsLabel = utils.formatDateTime?.(o.lastOrderTs) || '';
      tr.innerHTML=`<td>${o.code}</td><td>${o.name||''}</td><td>${o.openQty}</td><td>${jobLabel}</td><td>${o.eta||''}</td><td>${tsLabel}</td>`;
      tbody.appendChild(tr);
    });
  }

  renderIncomingSummary(rows);
  updateReserveAvailability();
  refreshReserveSkuDatalist();
}

function initTabs(){
  const tabs = document.querySelectorAll('.mode-btn');
  tabs.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      tabs.forEach(b=> b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      document.querySelectorAll('.mode-content').forEach(div=> div.classList.remove('active'));
      const tgt = document.getElementById(`${mode}-mode`);
      if(tgt) tgt.classList.add('active');
    });
  });
}

function initOrders(){
  const form = document.getElementById('orderForm');
  if(!form) return;
  const msg = document.getElementById('orderMsg');
  const addLineBtn = document.getElementById('order-addLine');
  const submitAnother = document.getElementById('orderSubmitAnother');
  const clearBtn = document.getElementById('orderClearBtn');
  const defaultJob = document.getElementById('orderJob');
  const applyDefault = document.getElementById('order-apply-default');

  addOrderLine();

  addLineBtn?.addEventListener('click', ()=> addOrderLine());
  defaultJob?.addEventListener('change', ()=>{
    if(applyDefault?.checked){
      document.querySelectorAll('.order-line select[name="jobId"]').forEach(sel=>{
        if(!sel.value){ sel.value = defaultJob.value; }
      });
    }
  });

  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    msg.textContent = '';
    const { lines, hasError } = gatherOrderLines();
    if(hasError){
      msg.style.color = '#b91c1c';
      msg.textContent = 'Fix the highlighted lines before submitting.';
      return;
    }
    openReviewModal(lines, true);
  });

  submitAnother?.addEventListener('click', async ()=>{
    msg.textContent = '';
    const { lines, hasError } = gatherOrderLines();
    if(hasError){
      msg.style.color = '#b91c1c';
      msg.textContent = 'Fix the highlighted lines before submitting.';
      return;
    }
    openReviewModal(lines, false);
  });

  clearBtn?.addEventListener('click', ()=>{
    form.reset();
    msg.textContent = '';
    clearOrderLines();
  });

  const bulkLoadBtn = document.getElementById('order-bulk-load');
  const bulkApplyBtn = document.getElementById('order-bulk-apply');
  const bulkClearBtn = document.getElementById('order-bulk-clear');
  const bulkArea = document.getElementById('order-bulk');

  bulkLoadBtn?.addEventListener('click', ()=>{
    if(!bulkArea?.value.trim()) return;
    const parsed = parseBulkOrders(bulkArea.value.trim());
    if(!parsed.length){
      if(msg){ msg.style.color = '#b91c1c'; msg.textContent = 'No valid lines found'; }
      return;
    }
    parsed.forEach(line=> addOrderLine(line));
    bulkArea.value = '';
  });

  bulkApplyBtn?.addEventListener('click', async ()=>{
    msg.textContent = '';
    if(!bulkArea?.value.trim()) return;
    const parsed = parseBulkOrders(bulkArea.value.trim());
    if(!parsed.length){
      msg.style.color = '#b91c1c'; msg.textContent = 'No valid lines found';
      return;
    }
    const defaultEta = document.getElementById('orderEta')?.value || '';
    const defaultJobValue = document.getElementById('orderJob')?.value || '';
    const autoReserve = document.getElementById('order-auto-reserve')?.checked;
    const notes = document.getElementById('orderNotes')?.value.trim() || '';

    const payload = parsed.map(line=>({
      code: line.code,
      name: line.name,
      qty: line.qty,
      eta: line.eta || defaultEta,
      jobId: line.jobId || defaultJobValue,
      notes,
      autoReserve
    }));
    const session = getSession();
    if(!session || session.role !== 'admin'){
      msg.style.color = '#b91c1c'; msg.textContent = 'Admin only';
      return;
    }
    try{
      const r = await fetch('/api/inventory-order/bulk',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ orders: payload, userEmail: session.email, userName: session.name })
      });
      const data = await r.json().catch(()=>({}));
      if(!r.ok){ msg.style.color = '#b91c1c'; msg.textContent = data.error || 'Bulk failed'; return; }
      msg.style.color = '#15803d'; msg.textContent = `Registered ${data.count} orders`;
      bulkArea.value = '';
      await renderRecentOrders();
    }catch(e){ msg.style.color = '#b91c1c'; msg.textContent = 'Bulk failed'; }
  });

  bulkClearBtn?.addEventListener('click', ()=>{ if(bulkArea) bulkArea.value = ''; });

  const reviewClose = document.getElementById('orderReviewClose');
  const reviewCancel = document.getElementById('orderReviewCancel');
  const reviewConfirm = document.getElementById('orderReviewConfirm');
  reviewClose?.addEventListener('click', closeReviewModal);
  reviewCancel?.addEventListener('click', closeReviewModal);
  reviewConfirm?.addEventListener('click', async ()=>{
    if(!pendingSubmit) return;
    const ok = await submitOrders(pendingSubmit.lines, pendingSubmit.clearAll);
    if(ok){
      closeReviewModal();
    }
  });
}

function updateReserveAvailability(){
  document.querySelectorAll('.reserve-line').forEach(row=>{
    const code = row.querySelector('input[name="code"]')?.value.trim() || '';
    const avail = row.querySelector('.available-pill');
    if(avail){ avail.textContent = code ? String(availableFor(code)) : '-'; }
  });
}

async function refreshInventoryAvailability(){
  const inventory = await utils.fetchJsonSafe('/api/inventory', {}, []) || [];
  inventoryCache = inventory;
  computeAvailability(inventory);
  updateReserveAvailability();
  refreshReserveSkuDatalist();
}

function initReserve(){
  const reserveLines = document.getElementById('reserve-lines');
  if(!reserveLines) return;

  function addReserveLine(prefill = {}){
    const codeId = `reserve-code-${uid()}`;
    const nameId = `reserve-name-${uid()}`;
    const qtyId = `reserve-qty-${uid()}`;
    const suggId = `${codeId}-s`;
    const row = document.createElement('div');
    row.className = 'form-row line-row reserve-line';
    row.innerHTML = `
      <label class="with-suggest">Item Code
        <input id="${codeId}" name="code" required placeholder="SKU/part">
        <div id="${suggId}" class="suggestions"></div>
      </label>
      <label>Item Name<input id="${nameId}" name="name" readonly></label>
      <label style="max-width:120px;">Qty<input id="${qtyId}" name="qty" type="number" min="1" value="1" required></label>
      <label style="max-width:140px;">Available<div class="available-pill">-</div></label>
      <button type="button" class="muted remove-line">Remove</button>
    `;
    reserveLines.appendChild(row);

    const codeInput = row.querySelector('input[name="code"]');
    const nameInput = row.querySelector('input[name="name"]');

    if(prefill.code){ codeInput.value = prefill.code; }
    if(prefill.qty){ row.querySelector('input[name="qty"]').value = prefill.qty; }

    codeInput.setAttribute('list', 'reserve-sku-options');
    if(window.utils && utils.attachItemLookup){
      utils.attachItemLookup({
        getItems: ()=> getGeneralInventoryItems(),
        codeInputId: codeId,
        nameInputId: nameId,
        suggestionsId: suggId
      });
    }

    codeInput.addEventListener('blur', ()=>{
      fillNameIfKnown(codeInput, nameInput);
      updateReserveAvailability();
    });
    codeInput.addEventListener('change', ()=>{
      fillNameIfKnown(codeInput, nameInput);
      updateReserveAvailability();
    });

    row.querySelector('.remove-line').addEventListener('click', ()=>{
      row.remove();
      if(!reserveLines.querySelector('.reserve-line')) addReserveLine();
      updateReserveAvailability();
    });

    updateReserveAvailability();
  }

  function gatherReserve(){
    const rows = [...reserveLines.querySelectorAll('.reserve-line')];
    const out = [];
    rows.forEach(r=>{
      const code = r.querySelector('input[name="code"]')?.value.trim() || '';
      const qty = parseInt(r.querySelector('input[name="qty"]')?.value||'0',10) || 0;
      if(code && qty > 0) out.push({ code, qty });
    });
    return out;
  }

  addReserveLine();
  const addBtn = document.getElementById('reserve-addLine');
  addBtn?.addEventListener('click', ()=> addReserveLine());

  const reserveForm = document.getElementById('reserveForm');
  const reserveMsg = document.getElementById('reserveMsg');
  const reserveTable = document.querySelector('#reserveTable tbody');

  async function renderReserves(){
    if(!reserveTable) return;
    reserveTable.innerHTML='';
    const rows = await utils.fetchJsonSafe('/api/inventory-reserve', {}, []) || [];
    const filter = (document.getElementById('reserveFilter')?.value || '').toLowerCase();
    const filtered = rows.filter(r=>{
      const job = (r.jobId||'').toLowerCase();
      return !filter || r.code.toLowerCase().includes(filter) || job.includes(filter);
    });
    if(!filtered.length){
      const tr=document.createElement('tr');
      tr.innerHTML=`<td colspan="5" class="ds-table-empty">No reservations</td>`;
      reserveTable.appendChild(tr);
      return;
    }
    filtered.slice().reverse().forEach(e=>{
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${e.code}</td><td>${e.jobId||''}</td><td>${e.qty}</td><td class="mobile-hide">${e.returnDate||''}</td><td class="mobile-hide">${utils.formatDateTime?.(e.ts) || ''}</td>`;
      reserveTable.appendChild(tr);
    });
  }

  reserveForm?.addEventListener('submit', async ev=>{
    ev.preventDefault();
    reserveMsg.textContent = '';
    const session = getSession();
    if(!session || session.role !== 'admin'){ reserveMsg.style.color = '#b91c1c'; reserveMsg.textContent = 'Admin only'; return; }
    const jobId = document.getElementById('reserve-jobId').value.trim();
    const returnDate = document.getElementById('reserve-returnDate').value;
    const notes = document.getElementById('reserve-notes').value.trim();
    const lines = gatherReserve();
    if(!jobId){ reserveMsg.style.color = '#b91c1c'; reserveMsg.textContent = 'Project is required'; return; }
    if(!lines.length){ reserveMsg.style.color = '#b91c1c'; reserveMsg.textContent = 'Add at least one line'; return; }
    const missing = lines.find(line=> !itemsCache.find(i=> i.code.toLowerCase() === line.code.toLowerCase()));
    if(missing){ reserveMsg.style.color = '#b91c1c'; reserveMsg.textContent = `Unknown item code: ${missing.code}`; return; }

    let okAll = true;
    for(const line of lines){
      const r = await fetch('/api/inventory-reserve',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ code: line.code, jobId, qty: line.qty, returnDate, notes, userEmail: session.email, userName: session.name })
      });
      if(!r.ok){
        const data = await r.json().catch(()=>({ error: 'Failed' }));
        reserveMsg.style.color = '#b91c1c';
        reserveMsg.textContent = data.error || 'Failed to reserve';
        okAll = false;
        break;
      }
    }
    if(okAll){
      reserveMsg.style.color = '#15803d'; reserveMsg.textContent = 'Reserved';
      await refreshInventoryAvailability();
      reserveForm.reset(); reserveLines.innerHTML=''; addReserveLine(); renderReserves();
    }
  });

  renderReserves();

  document.getElementById('reserveFilter')?.addEventListener('input', renderReserves);

  const reserveBulkBtn = document.getElementById('reserve-bulk-apply');
  const reserveBulkArea = document.getElementById('reserve-bulk');
  const reserveBulkLoad = document.getElementById('reserve-bulk-load');

  reserveBulkLoad?.addEventListener('click', ()=>{
    if(!reserveBulkArea?.value.trim()) return;
    const lines = reserveBulkArea.value.trim().split('\n').map(l=> l.split(','));
    const payload = [];
    for(const parts of lines){
      const [code, qty] = parts.map(p=> (p||'').trim());
      if(!code || !qty) continue;
      payload.push({ code, qty: Number(qty) });
    }
    if(!payload.length){ reserveMsg.style.color = '#b91c1c'; reserveMsg.textContent = 'No valid lines'; return; }
    payload.forEach(line=> addReserveLine(line));
    reserveBulkArea.value = '';
  });

  if(reserveBulkBtn && reserveBulkArea){
    reserveBulkBtn.addEventListener('click', async ()=>{
      reserveMsg.textContent = '';
      const session = getSession();
      if(!session || session.role !== 'admin'){ reserveMsg.style.color = '#b91c1c'; reserveMsg.textContent = 'Admin only'; return; }
      const jobId = document.getElementById('reserve-jobId').value.trim();
      if(!jobId){ reserveMsg.style.color = '#b91c1c'; reserveMsg.textContent = 'Project is required'; return; }
      const returnDate = document.getElementById('reserve-returnDate').value;
      const notes = document.getElementById('reserve-notes').value.trim();
      const text = reserveBulkArea.value.trim();
      if(!text){ reserveMsg.textContent = ''; return; }
      const lines = text.split('\n').map(l=> l.split(','));
      const payload = [];
      for(const parts of lines){
        const [code, qty] = parts.map(p=> (p||'').trim());
        if(!code || !qty) continue;
        payload.push({ code, qty: Number(qty) });
      }
      if(!payload.length){ reserveMsg.style.color = '#b91c1c'; reserveMsg.textContent = 'No valid lines'; return; }
      try{
        const r = await fetch('/api/inventory-reserve/bulk',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ jobId, returnDate, notes, lines: payload, userEmail: session.email, userName: session.name })
        });
        const data = await r.json().catch(()=>({}));
        if(!r.ok){ reserveMsg.style.color = '#b91c1c'; reserveMsg.textContent = data.error || 'Bulk reserve failed'; return; }
        reserveMsg.style.color = '#15803d'; reserveMsg.textContent = `Reserved ${data.count} lines`;
        await refreshInventoryAvailability();
        reserveForm.reset(); reserveLines.innerHTML=''; addReserveLine(); reserveBulkArea.value=''; renderReserves();
      }catch(e){ reserveMsg.style.color = '#b91c1c'; reserveMsg.textContent = 'Bulk reserve failed'; }
    });
    document.getElementById('reserve-bulk-clear')?.addEventListener('click', ()=>{ reserveBulkArea.value=''; });
  }
}

function initReassign(){
  const form = document.getElementById('reassignForm');
  if(!form) return;
  const msg = document.getElementById('reassignMsg');
  const clearBtn = document.getElementById('reassign-clearBtn');
  if(window.utils && utils.attachItemLookup){
    utils.attachItemLookup({
      getItems: ()=> itemsCache,
      codeInputId: 'reassign-code',
      suggestionsId: 'reassign-code-s'
    });
  }
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    msg.textContent = '';
    const session = getSession();
    if(!session || session.role !== 'admin'){ msg.style.color = '#b91c1c'; msg.textContent = 'Admin only'; return; }
    const code = document.getElementById('reassign-code').value.trim();
    const fromJobId = document.getElementById('reassign-from').value.trim();
    const toJobId = document.getElementById('reassign-to').value.trim();
    const qty = parseInt(document.getElementById('reassign-qty').value, 10) || 0;
    const reason = document.getElementById('reassign-reason').value.trim();
    if(!code || !fromJobId || qty <= 0 || !reason){
      msg.style.color = '#b91c1c';
      msg.textContent = 'Code, from project, qty, and reason are required';
      return;
    }
    try{
      const r = await fetch('/api/inventory-reassign', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ code, fromJobId, toJobId, qty, reason, userEmail: session.email, userName: session.name })
      });
      const data = await r.json().catch(()=>({}));
      if(!r.ok){ msg.style.color = '#b91c1c'; msg.textContent = data.error || 'Reassign failed'; return; }
      msg.style.color = '#15803d'; msg.textContent = 'Reassigned reserved stock';
      form.reset();
      await refreshInventoryAvailability();
      document.getElementById('reserveFilter')?.dispatchEvent(new Event('input'));
    }catch(e){
      msg.style.color = '#b91c1c'; msg.textContent = 'Reassign failed';
    }
  });
  clearBtn?.addEventListener('click', ()=>{ form.reset(); msg.textContent=''; });
}

function initFilterButtons(){
  document.querySelectorAll('.filter-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.filter-btn').forEach(b=> b.classList.remove('active'));
      btn.classList.add('active');
      orderRangeFilter = btn.dataset.range || 'all';
      renderRecentOrders();
    });
  });
}

document.addEventListener('DOMContentLoaded', ()=>{
  (async ()=>{
    await loadJobs();
    await loadItems();
    await renderRecentOrders();
    initTabs();
    initOrders();
    initReserve();
    initReassign();
    initFilterButtons();
    document.getElementById('orderFilter')?.addEventListener('input', renderRecentOrders);
  })();
});
