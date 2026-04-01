
const SESSION_KEY = 'sessionUser';
const FALLBACK = 'N/A';

function getSession(){
  if(window.utils?.getSession) return utils.getSession();
  try{ return JSON.parse(localStorage.getItem(SESSION_KEY)||'null'); }catch(e){ return null; }
}

function uid(){ return Math.random().toString(16).slice(2,8); }

let itemsCache = [];
let suppliersCache = [];
let jobOptions = [];
let openMaterialJobOptions = [];
let availabilityMap = new Map();
let inventoryCache = [];
let projectMaterialsCache = new Map();
let orderRangeFilter = 'all';
let pendingSubmit = null;
let currentShoppingPlan = null;
let inventoryLocationOptions = [];
const FALLBACK_LOCATION_OPTIONS = [
  { id: 'loc:warehouse:main', name: 'Main Warehouse', label: 'Main Warehouse', type: 'warehouse', ref: 'main' },
  { id: 'loc:bin:primary', name: 'Primary Bin', label: 'Primary Bin', type: 'bin', ref: 'primary' },
  { id: 'loc:staging:default', name: 'Staging Area', label: 'Staging Area', type: 'staging', ref: 'default' },
  { id: 'loc:field:default', name: 'Field Stock', label: 'Field Stock', type: 'field', ref: 'default' },
  { id: 'loc:writeoff:default', name: 'Lost / Write-off', label: 'Lost / Write-off', type: 'writeoff', ref: 'default' }
];

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

async function loadInventoryLocations(force = false){
  if(inventoryLocationOptions.length && !force) return inventoryLocationOptions;
  const rows = await utils.fetchJsonSafe('/api/inventory-locations', {}, []) || [];
  inventoryLocationOptions = (rows.length ? rows : FALLBACK_LOCATION_OPTIONS).map((row)=>({
    id: row.id || row.ref || row.name,
    name: row.name || row.label || 'Location',
    label: row.label || row.name || 'Location',
    type: row.type || '',
    ref: row.ref || row.id || ''
  }));
  return inventoryLocationOptions;
}

function populateInventoryLocationSelect(selectId, preferredId){
  const select = document.getElementById(selectId);
  if(!select) return;
  const current = select.value || preferredId || '';
  select.innerHTML = '<option value="">Select location...</option>';
  inventoryLocationOptions.forEach((option)=>{
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.label || option.name;
    el.dataset.locationName = option.name || option.label || '';
    el.dataset.locationType = option.type || '';
    el.dataset.locationRef = option.ref || '';
    select.appendChild(el);
  });
  const matchByValue = [...select.options].find((option)=> option.value === current);
  const matchByRef = [...select.options].find((option)=> option.dataset.locationRef === current);
  const preferredByValue = [...select.options].find((option)=> option.value === preferredId);
  const preferredByRef = [...select.options].find((option)=> option.dataset.locationRef === preferredId);
  if(matchByValue){
    select.value = matchByValue.value;
  }else if(matchByRef){
    select.value = matchByRef.value;
  }else if(preferredByValue){
    select.value = preferredByValue.value;
  }else if(preferredByRef){
    select.value = preferredByRef.value;
  }else if(select.options.length > 1){
    select.selectedIndex = 1;
  }
}

function getInventoryLocationPayload(selectId){
  const select = document.getElementById(selectId);
  const option = select?.selectedOptions?.[0];
  return {
    location: option?.dataset.locationName || '',
    locationType: option?.dataset.locationType || '',
    locationRef: option?.dataset.locationRef || ''
  };
}

function buildOrderBalance(orders, inventory){
  const map = new Map();
  (orders||[]).forEach(o=>{
    const status = String(o.status || '').toLowerCase();
    if(status === 'cancelled' || status === 'canceled') return;
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
    const [jobs, openMaterialJobs] = await Promise.all([
      utils.fetchJsonSafe('/api/jobs', {}, []),
      utils.fetchJsonSafe('/api/jobs/open-material-needs', {}, [])
    ]);
    jobOptions = (jobs || []).map(j=> j.code).filter(Boolean).sort();
    openMaterialJobOptions = (openMaterialJobs || []).map((job)=> job.jobId).filter(Boolean).sort();
    const selects = ['orderJob','orderMaterialsJob','reserve-jobId','reassign-from','reassign-to'].map(id=> document.getElementById(id)).filter(Boolean);
    selects.forEach(sel=>{
      const current = sel.value;
      const projectOnly = sel.id === 'orderMaterialsJob' || sel.id === 'reserve-jobId' || sel.id === 'reassign-from';
      const optionSource = sel.id === 'orderMaterialsJob' && openMaterialJobOptions.length ? openMaterialJobOptions : jobOptions;
      sel.innerHTML = projectOnly ? '<option value="">Select project...</option>' : '<option value="">General Inventory</option>';
      optionSource.forEach(job=>{
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

async function loadSuppliers(){
  try{
    suppliersCache = await utils.fetchJsonSafe('/api/suppliers', {}, []) || [];
  }catch(e){
    suppliersCache = [];
  }
  refreshOrderLineSupplierOptions();
}

async function loadProjectMaterials(jobId, force = false){
  const normalizedJobId = normalizeJobId(jobId);
  if(!normalizedJobId) return [];
  if(!force && projectMaterialsCache.has(normalizedJobId)) return projectMaterialsCache.get(normalizedJobId) || [];
  const rows = await utils.fetchJsonSafe(`/api/jobs/${encodeURIComponent(normalizedJobId)}/materials`, {}, []) || [];
  projectMaterialsCache.set(normalizedJobId, rows);
  return rows;
}

function shouldAddProcurementItemsToCatalog(){
  return !!document.getElementById('order-add-catalog')?.checked;
}

function shouldUseInventoryBeforeOrder(){
  return !!document.getElementById('order-use-inventory')?.checked;
}

function findItemByCode(code){
  const normalized = (code || '').trim().toLowerCase();
  if(!normalized) return null;
  return itemsCache.find(item => (item.code || '').trim().toLowerCase() === normalized) || null;
}

function findSupplierById(supplierId){
  const id = (supplierId || '').trim();
  if(!id) return null;
  return suppliersCache.find(supplier => supplier.id === id) || null;
}

function getSupplierTargetForLine(line){
  const item = findItemByCode(line?.code || '');
  const supplierId = (line?.supplierId || item?.supplierId || item?.supplierid || '').trim();
  const supplier = findSupplierById(supplierId);
  const supplierSku = item?.supplierSku || item?.suppliersku || '';
  const itemUrl = (item?.supplierUrl || item?.supplierurl || '').trim();
  const url = itemUrl || (supplier?.orderUrl || supplier?.websiteUrl || '').trim();
  return {
    supplierId: supplier?.id || supplierId || '',
    supplierName: supplier?.name || '',
    supplierSku,
    url,
    assigned: !!supplier
  };
}

function buildProcurementPlan(lines){
  const useInventoryFirst = shouldUseInventoryBeforeOrder();
  const remainingAvailability = new Map(availabilityMap || []);
  const plannedLines = (lines || []).map(rawLine=>{
    const line = { ...rawLine };
    const requestedQty = Number(line.qty || 0);
    const jobId = normalizeJobId(line.jobId || '');
    let inventoryQty = 0;
    if(useInventoryFirst && jobId && requestedQty > 0){
      const availableQty = Math.max(0, Number(remainingAvailability.get(line.code) || 0));
      inventoryQty = Math.min(requestedQty, availableQty);
      remainingAvailability.set(line.code, Math.max(0, availableQty - inventoryQty));
    }
    const orderQty = Math.max(0, requestedQty - inventoryQty);
    return {
      ...line,
      jobId,
      requestedQty,
      inventoryQty,
      orderQty
    };
  });
  return {
    useInventoryFirst,
    plannedLines,
    reserveLines: plannedLines.filter(line=> line.inventoryQty > 0),
    orderLines: plannedLines.filter(line=> line.orderQty > 0)
  };
}

function buildSupplierShoppingPlan(lines){
  const plan = buildProcurementPlan(lines);
  const groups = new Map();
  plan.orderLines.forEach((line)=>{
    const supplierMeta = getSupplierTargetForLine(line);
    const key = supplierMeta.assigned ? supplierMeta.supplierId : 'unassigned';
    if(!groups.has(key)){
      groups.set(key, {
        key,
        supplierId: supplierMeta.supplierId || '',
        supplierName: supplierMeta.supplierName || 'Unassigned Supplier',
        url: supplierMeta.url || '',
        assigned: supplierMeta.assigned,
        lines: [],
        totalQty: 0
      });
    }
    const group = groups.get(key);
    group.lines.push({
      ...line,
      supplierSku: supplierMeta.supplierSku || ''
    });
    group.totalQty += Number(line.orderQty || 0);
    if(!group.url && supplierMeta.url) group.url = supplierMeta.url;
  });
  return {
    ...plan,
    groups: Array.from(groups.values()).sort((a, b)=> {
      if(a.assigned !== b.assigned) return a.assigned ? -1 : 1;
      return (a.supplierName || '').localeCompare(b.supplierName || '');
    })
  };
}

function shoppingListTextForGroup(group){
  const header = [
    group.supplierName || 'Unassigned Supplier',
    group.url ? `Vendor URL: ${group.url}` : 'Vendor URL: not set'
  ];
  const lines = (group.lines || []).map((line)=>{
    const parts = [
      `${line.code} - ${line.name || ''}`.trim(),
      `Qty ${line.orderQty}`,
      line.jobId ? `Project ${line.jobId}` : 'General Inventory'
    ];
    if(line.supplierSku) parts.push(`Supplier SKU ${line.supplierSku}`);
    if(line.eta) parts.push(`ETA ${line.eta}`);
    return `- ${parts.join(' | ')}`;
  });
  return [...header, '', ...lines].join('\n');
}

async function copyTextToClipboard(text){
  if(navigator.clipboard?.writeText){
    await navigator.clipboard.writeText(text);
    return true;
  }
  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'absolute';
  fallback.style.left = '-9999px';
  document.body.appendChild(fallback);
  fallback.select();
  const ok = document.execCommand('copy');
  fallback.remove();
  return !!ok;
}

async function reserveInventoryBeforeOrdering(lines, notes, session){
  const grouped = new Map();
  for(const line of lines || []){
    const jobId = normalizeJobId(line.jobId || '');
    if(!jobId || !line.code || !(Number(line.inventoryQty) > 0)) continue;
    if(!grouped.has(jobId)) grouped.set(jobId, []);
    grouped.get(jobId).push({ code: line.code, qty: Number(line.inventoryQty), jobMaterialId: line.jobMaterialId || '' });
  }
  for(const [jobId, groupedLines] of grouped.entries()){
    const response = await fetch('/api/inventory-reserve/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        notes: notes || 'Allocated from available inventory before procurement order',
        lines: groupedLines,
        userEmail: session.email,
        userName: session.name
      })
    });
    const data = await response.json().catch(()=> ({}));
    if(!response.ok){
      return { ok: false, error: data.error || 'Failed to reserve available inventory' };
    }
  }
  return { ok: true };
}

async function ensureCatalogItems(lines){
  if(!shouldAddProcurementItemsToCatalog()) return { ok: true, created: 0 };
  const session = getSession();
  if(!session || session.role !== 'admin'){
    return { ok: false, error: 'Admin only' };
  }

  const existingCodes = new Set((itemsCache || []).map(item => (item.code || '').trim().toLowerCase()).filter(Boolean));
  const missingByCode = new Map();
  for(const line of lines || []){
    const code = (line?.code || '').trim();
    if(!code) continue;
    const normalizedCode = code.toLowerCase();
    if(existingCodes.has(normalizedCode) || missingByCode.has(normalizedCode)) continue;
    const name = (line?.name || '').trim();
    if(!name){
      return { ok: false, error: `Name required to add new catalog item: ${code}` };
    }
    missingByCode.set(normalizedCode, {
      code,
      name,
      supplierId: (line?.supplierId || '').trim() || null
    });
  }

  if(!missingByCode.size) return { ok: true, created: 0 };

  const response = await fetch('/api/items/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: Array.from(missingByCode.values()) })
  });
  const data = await response.json().catch(()=>({}));
  if(!response.ok){
    return { ok: false, error: data.error || 'Failed to add new items to catalog' };
  }

  await loadItems();
  await loadSuppliers();
  refreshOrderLineSupplierOptions();
  refreshReserveSkuDatalist();
  return { ok: true, created: Number(data.count || missingByCode.size) || missingByCode.size };
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
    <input type="hidden" name="jobMaterialId">
    <label class="with-suggest">Item Code
      <input id="${codeId}" name="code" placeholder="SKU/part" required>
      <div id="${suggId}" class="suggestions"></div>
    </label>
    <label>Item Name<input id="${nameId}" name="name" placeholder="Required for new codes"></label>
    <label>Supplier
      <select name="supplierId"></select>
    </label>
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
  const supplierSelect = row.querySelector('select[name="supplierId"]');
  const qtyInput = row.querySelector('input[name="qty"]');
  const etaInput = row.querySelector('input[name="eta"]');
  const jobSelect = row.querySelector('select[name="jobId"]');

  refreshOrderLineJobOptions();
  refreshOrderLineSupplierOptions();

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
  if(prefill.jobMaterialId){
    const materialInput = row.querySelector('input[name="jobMaterialId"]');
    if(materialInput) materialInput.value = prefill.jobMaterialId;
  }

  if(prefill.supplierId){ supplierSelect.value = prefill.supplierId; }
  codeInput.setAttribute('list', 'order-sku-options');
  const syncKnownItemMeta = ()=>{
    fillNameIfKnown(codeInput, nameInput);
    const match = findItemByCode(codeInput.value);
    if(match){
      supplierSelect.value = match.supplierId || match.supplierid || '';
    }
  };
  codeInput.addEventListener('input', syncKnownItemMeta);
  codeInput.addEventListener('blur', syncKnownItemMeta);
  codeInput.addEventListener('change', syncKnownItemMeta);

  syncKnownItemMeta();

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

async function loadSelectedProjectMaterials(force = false){
  const select = document.getElementById('orderMaterialsJob');
  const jobId = normalizeJobId(select?.value || '');
  const msg = document.getElementById('orderMsg');
  if(msg) msg.textContent = '';
  if(!jobId){
    if(msg){ msg.style.color = '#b91c1c'; msg.textContent = 'Select a project to load materials'; }
    return;
  }
  const materials = await loadProjectMaterials(jobId, force);
  const outstanding = (materials || []).filter(line=> Number(line.outstandingQty || 0) > 0);
  if(!outstanding.length){
    if(msg){ msg.style.color = '#475569'; msg.textContent = 'No outstanding materials to procure for that project'; }
    return;
  }
  const defaultEta = document.getElementById('orderEta')?.value || '';
  const existingIds = new Set(
    Array.from(document.querySelectorAll('#order-lines input[name="jobMaterialId"]'))
      .map(input=> (input.value || '').trim())
      .filter(Boolean)
  );
  const blankRow = document.querySelector('#order-lines .order-line');
  const blankRowUnused = blankRow
    && !(blankRow.querySelector('input[name="code"]')?.value.trim())
    && !(blankRow.querySelector('input[name="jobMaterialId"]')?.value.trim());
  if(blankRowUnused){
    blankRow.remove();
  }
  let added = 0;
  outstanding.forEach(line=>{
    if(line.id && existingIds.has(line.id)) return;
    addOrderLine({
      code: line.code,
      name: line.name,
      supplierId: line.supplierId || line.supplierid || '',
      qty: Number(line.outstandingQty || 0),
      eta: defaultEta,
      jobId,
      jobMaterialId: line.id
    });
    added += 1;
  });
  if(!added){
    if(msg){ msg.style.color = '#475569'; msg.textContent = 'All outstanding project materials are already in the procurement list'; }
    return;
  }
  document.getElementById('orderJob').value = jobId;
  if(document.getElementById('order-apply-default')) document.getElementById('order-apply-default').checked = true;
  if(msg){ msg.style.color = '#15803d'; msg.textContent = `Loaded ${added} project material lines for ${jobId}`; }
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
    const jobMaterialId = row.querySelector('input[name="jobMaterialId"]')?.value.trim() || '';
    const supplierId = row.querySelector('select[name="supplierId"]')?.value.trim() || '';
    return { row, code, name, qty, eta, jobId, jobMaterialId, supplierId };
  });

  let hasError = false;
  lines.forEach(line=>{
    clearLineError(line.row);
    const match = itemsCache.find(i=> i.code.toLowerCase() === line.code.toLowerCase());
    if(match){
      line.code = match.code || line.code;
      if(!line.name) line.name = match.name || '';
    }
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
  const plan = buildProcurementPlan(lines);

  pendingSubmit = { lines, clearAll, autoReserve, plan };
  tbody.innerHTML = '';
  plan.plannedLines.forEach(line=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${line.code}</td><td>${line.name || ''}</td><td>${line.requestedQty}</td><td>${line.inventoryQty || '—'}</td><td>${line.orderQty || '—'}</td><td>${line.eta}</td><td>${line.jobId || 'General'}</td>`;
    tbody.appendChild(tr);
  });
  const totalRequested = plan.plannedLines.reduce((sum,line)=> sum + (Number(line.requestedQty) || 0), 0);
  const totalFromInventory = plan.reserveLines.reduce((sum,line)=> sum + (Number(line.inventoryQty) || 0), 0);
  const totalToOrder = plan.orderLines.reduce((sum,line)=> sum + (Number(line.orderQty) || 0), 0);
  summary.textContent = `${plan.plannedLines.length} lines, ${totalRequested} requested, ${totalFromInventory} from inventory, ${totalToOrder} to order, auto-reserve ${autoReserve ? 'on' : 'off'}, inventory-first ${plan.useInventoryFirst ? 'on' : 'off'}.`;

  modal.classList.remove('hidden');
}

function closeReviewModal(){
  const modal = document.getElementById('orderReviewModal');
  if(modal) modal.classList.add('hidden');
  pendingSubmit = null;
}

function closeShoppingModal(){
  const modal = document.getElementById('supplierShoppingModal');
  if(modal) modal.classList.add('hidden');
  currentShoppingPlan = null;
}

function openVendorTab(url){
  if(!url) return false;
  const opened = window.open(url, '_blank', 'noopener');
  return !!opened;
}

async function logVendorOpen(group){
  try{
    await fetch('/api/procurement/vendor-open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supplierId: group?.supplierId || '',
        supplierName: group?.supplierName || '',
        url: group?.url || '',
        lineCount: Array.isArray(group?.lines) ? group.lines.length : 0
      })
    });
  }catch(e){}
}

function renderShoppingGroups(plan){
  const summary = document.getElementById('supplierShoppingSummary');
  const container = document.getElementById('supplierShoppingGroups');
  if(!summary || !container) return;
  container.innerHTML = '';
  currentShoppingPlan = plan;

  const validGroups = plan.groups.filter(group => group.assigned);
  const unassignedCount = plan.groups.filter(group => !group.assigned).reduce((sum, group)=> sum + group.lines.length, 0);
  summary.textContent = `${plan.groups.length} supplier groups, ${plan.orderLines.length} lines to order, ${validGroups.filter(group => group.url).length} vendor links ready${unassignedCount ? `, ${unassignedCount} lines unassigned` : ''}.`;

  if(!plan.orderLines.length){
    container.innerHTML = '<div class="ds-empty">No procurement order lines remain after inventory allocation.</div>';
    return;
  }

  plan.groups.forEach((group)=>{
    const card = document.createElement('section');
    card.className = 'card supplier-shopping-card';
    const rows = (group.lines || []).map((line)=>`
      <tr>
        <td>${line.code}</td>
        <td>${line.name || ''}</td>
        <td>${line.orderQty}</td>
        <td>${line.jobId || 'General'}</td>
        <td>${line.supplierSku || FALLBACK}</td>
        <td>${line.eta || FALLBACK}</td>
      </tr>
    `).join('');
    const status = !group.assigned
      ? 'No supplier is assigned to these catalog items yet.'
      : group.url
        ? `Vendor URL ready: ${group.url}`
        : 'Supplier exists, but no vendor URL is saved yet.';

    card.innerHTML = `
      <div class="supplier-shopping-head">
        <div>
          <h4>${group.supplierName || 'Unassigned Supplier'}</h4>
          <div class="muted-text">${status}</div>
        </div>
        <div class="supplier-shopping-actions">
          <button type="button" class="muted supplier-copy-btn" data-key="${group.key}">Copy List</button>
          <button type="button" class="supplier-open-btn" data-key="${group.key}" ${group.url ? '' : 'disabled'}>Open Vendor Site</button>
        </div>
      </div>
      <table class="supplier-shopping-table">
        <thead><tr><th>Code</th><th>Name</th><th>Qty</th><th>Project</th><th>Supplier SKU</th><th>ETA</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.supplier-copy-btn').forEach((button)=>{
    button.addEventListener('click', async ()=>{
      const group = currentShoppingPlan?.groups.find(entry => entry.key === button.dataset.key);
      if(!group) return;
      try{
        await copyTextToClipboard(shoppingListTextForGroup(group));
        const msg = document.getElementById('orderMsg');
        if(msg){
          msg.style.color = '#15803d';
          msg.textContent = `Copied shopping list for ${group.supplierName || 'supplier'}.`;
        }
      }catch(e){
        alert('Could not copy the shopping list.');
      }
    });
  });

  container.querySelectorAll('.supplier-open-btn').forEach((button)=>{
    button.addEventListener('click', async ()=>{
      const group = currentShoppingPlan?.groups.find(entry => entry.key === button.dataset.key);
      if(!group?.url){
        alert('No vendor URL is configured for this supplier.');
        return;
      }
      if(!openVendorTab(group.url)){
        alert('The vendor tab was blocked by the browser. Allow pop-ups for this app and try again.');
        return;
      }
      await logVendorOpen(group);
    });
  });
}

function refreshOrderLineSupplierOptions(){
  const selects = document.querySelectorAll('.order-line select[name="supplierId"]');
  selects.forEach(sel=>{
    const current = sel.value;
    sel.innerHTML = '<option value="">Unassigned supplier</option>';
    suppliersCache
      .slice()
      .sort((a,b)=> (a.name || '').localeCompare(b.name || ''))
      .forEach(supplier=>{
        const opt = document.createElement('option');
        opt.value = supplier.id;
        opt.textContent = supplier.name || FALLBACK;
        sel.appendChild(opt);
      });
    if(current && suppliersCache.some(s=> s.id === current)) sel.value = current;
  });
}

function openShoppingModal(lines){
  const modal = document.getElementById('supplierShoppingModal');
  if(!modal) return;
  const plan = buildSupplierShoppingPlan(lines);
  renderShoppingGroups(plan);
  modal.classList.remove('hidden');
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
  const plan = buildProcurementPlan(lines);
  const payload = plan.orderLines.map(line=>({
    code: line.code,
    name: line.name,
    qty: line.orderQty,
    eta: line.eta,
    jobId: line.jobId,
    jobMaterialId: line.jobMaterialId || '',
    notes,
    autoReserve
  }));

  try{
    const catalogResult = await ensureCatalogItems(lines);
    if(!catalogResult.ok){
      if(msg){ msg.style.color = '#b91c1c'; msg.textContent = catalogResult.error; }
      return false;
    }
    if(plan.reserveLines.length){
      const reserveResult = await reserveInventoryBeforeOrdering(plan.reserveLines, notes, session);
      if(!reserveResult.ok){
        if(msg){ msg.style.color = '#b91c1c'; msg.textContent = reserveResult.error; }
        return false;
      }
    }
    let orderedCount = 0;
    if(payload.length){
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
      orderedCount = Number(data.count || payload.length) || payload.length;
    }
    if(msg){
      msg.style.color = '#15803d';
      const reservedUnits = plan.reserveLines.reduce((sum,line)=> sum + (Number(line.inventoryQty) || 0), 0);
      const orderedUnits = plan.orderLines.reduce((sum,line)=> sum + (Number(line.orderQty) || 0), 0);
      msg.textContent = `Allocated ${reservedUnits} from inventory and registered ${orderedCount} orders (${orderedUnits} units).`;
      if(!plan.reserveLines.length){
        msg.textContent = `Registered ${orderedCount} orders (${orderedUnits} units).`;
      }else if(!payload.length){
        msg.textContent = `Allocated ${reservedUnits} units from inventory. No procurement order needed.`;
      }
    }

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
    await refreshInventoryAvailability();
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
    tr.innerHTML=`<td colspan="7" class="ds-table-empty">No orders yet</td>`;
    tbody.appendChild(tr);
  }else{
    recent.forEach(o=>{
      const tr=document.createElement('tr');
      const jobValue = o.jobId || '';
      const jobLabel = jobValue && jobValue.trim() ? jobValue : 'General';
      const tsLabel = utils.formatDateTime?.(o.lastOrderTs) || '';
      tr.innerHTML=`<td>${o.code}</td><td>${o.name||''}</td><td>${o.openQty}</td><td>${jobLabel}</td><td>${o.eta||''}</td><td>${tsLabel}</td><td><button type="button" class="muted cancel-order-btn" data-source-id="${o.sourceId}">Cancel</button></td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.cancel-order-btn').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const sourceId = btn.dataset.sourceId || '';
        if(!sourceId) return;
        if(!confirm('Cancel the remaining quantity on this incoming order?')) return;
        btn.disabled = true;
        const response = await fetch(`/api/inventory-order/${encodeURIComponent(sourceId)}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const data = await response.json().catch(()=> ({}));
        if(!response.ok){
          alert(data.error || 'Failed to cancel incoming order');
          btn.disabled = false;
          return;
        }
        await renderRecentOrders();
      });
    });
  }

  renderIncomingSummary(rows);
  updateReserveAvailability();
  refreshReserveSkuDatalist();
}

function initTabs(){
  const tabs = document.querySelectorAll('.mode-btn');
  const setMode = (mode)=>{
    tabs.forEach(btn=> btn.classList.toggle('active', btn.dataset.mode === mode));
    document.querySelectorAll('.mode-content').forEach(div=> div.classList.remove('active'));
    const tgt = document.getElementById(`${mode}-mode`);
    if(tgt) tgt.classList.add('active');
    if(history.replaceState){
      const url = new URL(window.location.href);
      url.hash = mode;
      history.replaceState(null, '', url.toString());
    }
  };
  tabs.forEach(btn=>{
    btn.addEventListener('click', ()=> setMode(btn.dataset.mode));
  });
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('mode') || (window.location.hash || '').replace('#','');
  setMode(requested === 'reserve' ? 'reserve' : 'order');
}

function initOrders(){
  const form = document.getElementById('orderForm');
  if(!form) return;
  const msg = document.getElementById('orderMsg');
  const addLineBtn = document.getElementById('order-addLine');
  const shoppingListBtn = document.getElementById('orderShoppingListBtn');
  const submitAnother = document.getElementById('orderSubmitAnother');
  const clearBtn = document.getElementById('orderClearBtn');
  const defaultJob = document.getElementById('orderJob');
  const materialsJob = document.getElementById('orderMaterialsJob');
  const applyDefault = document.getElementById('order-apply-default');
  const loadMaterialsBtn = document.getElementById('order-loadMaterials');
  const refreshMaterialsBtn = document.getElementById('order-refreshMaterials');

  addOrderLine();

  addLineBtn?.addEventListener('click', ()=> addOrderLine());
  shoppingListBtn?.addEventListener('click', ()=>{
    msg.textContent = '';
    const { lines, hasError } = gatherOrderLines();
    if(hasError){
      msg.style.color = '#b91c1c';
      msg.textContent = 'Fix the highlighted lines before opening the shopping list.';
      return;
    }
    openShoppingModal(lines);
  });
  defaultJob?.addEventListener('change', ()=>{
    if(materialsJob && !materialsJob.value && defaultJob.value) materialsJob.value = defaultJob.value;
    if(applyDefault?.checked){
      document.querySelectorAll('.order-line select[name="jobId"]').forEach(sel=>{
        if(!sel.value){ sel.value = defaultJob.value; }
      });
    }
  });
  loadMaterialsBtn?.addEventListener('click', ()=> loadSelectedProjectMaterials(false));
  refreshMaterialsBtn?.addEventListener('click', ()=> loadSelectedProjectMaterials(true));

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
    closeShoppingModal();
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
      const catalogResult = await ensureCatalogItems(parsed);
      if(!catalogResult.ok){
        msg.style.color = '#b91c1c';
        msg.textContent = catalogResult.error;
        return;
      }
      const defaultEta = document.getElementById('orderEta')?.value || '';
      const defaultJobValue = document.getElementById('orderJob')?.value || '';
      const autoReserve = document.getElementById('order-auto-reserve')?.checked;
      const notes = document.getElementById('orderNotes')?.value.trim() || '';
      const normalizedLines = parsed.map(line=>{
        const match = itemsCache.find(item => (item.code || '').toLowerCase() === (line.code || '').toLowerCase());
        return {
          ...line,
          code: match?.code || line.code,
          name: line.name || match?.name || '',
          eta: line.eta || defaultEta,
          jobId: line.jobId || defaultJobValue,
          jobMaterialId: line.jobMaterialId || ''
        };
      });
      const plan = buildProcurementPlan(normalizedLines);
      const payload = plan.orderLines.map(line=>({
        code: line.code,
        name: line.name,
        qty: line.orderQty,
        eta: line.eta,
        jobId: line.jobId,
        jobMaterialId: line.jobMaterialId || '',
        notes,
        autoReserve
      }));
    const session = getSession();
    if(!session || session.role !== 'admin'){
      msg.style.color = '#b91c1c'; msg.textContent = 'Admin only';
      return;
    }
    try{
      if(plan.reserveLines.length){
        const reserveResult = await reserveInventoryBeforeOrdering(plan.reserveLines, notes, session);
        if(!reserveResult.ok){ msg.style.color = '#b91c1c'; msg.textContent = reserveResult.error; return; }
      }
      let orderedCount = 0;
      if(payload.length){
        const r = await fetch('/api/inventory-order/bulk',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ orders: payload, userEmail: session.email, userName: session.name })
        });
        const data = await r.json().catch(()=>({}));
        if(!r.ok){ msg.style.color = '#b91c1c'; msg.textContent = data.error || 'Bulk failed'; return; }
        orderedCount = Number(data.count || payload.length) || payload.length;
      }
      const reservedUnits = plan.reserveLines.reduce((sum,line)=> sum + (Number(line.inventoryQty) || 0), 0);
      const orderedUnits = plan.orderLines.reduce((sum,line)=> sum + (Number(line.orderQty) || 0), 0);
      msg.style.color = '#15803d';
      msg.textContent = !plan.reserveLines.length
        ? `Registered ${orderedCount} orders (${orderedUnits} units)`
        : !payload.length
          ? `Allocated ${reservedUnits} units from inventory. No procurement order needed.`
          : `Allocated ${reservedUnits} from inventory and registered ${orderedCount} orders (${orderedUnits} units)`;
      bulkArea.value = '';
      await renderRecentOrders();
      await refreshInventoryAvailability();
    }catch(e){ msg.style.color = '#b91c1c'; msg.textContent = 'Bulk failed'; }
  });

  bulkClearBtn?.addEventListener('click', ()=>{ if(bulkArea) bulkArea.value = ''; });

  const reviewClose = document.getElementById('orderReviewClose');
  const reviewCancel = document.getElementById('orderReviewCancel');
  const reviewConfirm = document.getElementById('orderReviewConfirm');
  const shoppingClose = document.getElementById('supplierShoppingClose');
  const shoppingCancel = document.getElementById('supplierShoppingCancel');
  const shoppingOpenAll = document.getElementById('supplierShoppingOpenAll');
  reviewClose?.addEventListener('click', closeReviewModal);
  reviewCancel?.addEventListener('click', closeReviewModal);
  reviewConfirm?.addEventListener('click', async ()=>{
    if(!pendingSubmit) return;
    const ok = await submitOrders(pendingSubmit.lines, pendingSubmit.clearAll);
    if(ok){
      closeReviewModal();
    }
  });
  shoppingClose?.addEventListener('click', closeShoppingModal);
  shoppingCancel?.addEventListener('click', closeShoppingModal);
  shoppingOpenAll?.addEventListener('click', async ()=>{
    const groups = currentShoppingPlan?.groups.filter(group => group.url) || [];
    if(!groups.length){
      alert('No vendor URLs are configured for the current shopping list.');
      return;
    }
    let blocked = 0;
    for(const group of groups){
      if(!openVendorTab(group.url)){
        blocked += 1;
        continue;
      }
      await logVendorOpen(group);
    }
    if(blocked){
      alert('One or more vendor tabs were blocked by the browser. Allow pop-ups for this app and try again.');
    }
  });
  document.getElementById('supplierShoppingModal')?.addEventListener('click', (event)=>{
    if(event.target?.id === 'supplierShoppingModal') closeShoppingModal();
  });
  document.getElementById('orderReviewModal')?.addEventListener('click', (event)=>{
    if(event.target?.id === 'orderReviewModal') closeReviewModal();
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
  populateInventoryLocationSelect('reserve-location', 'primary');

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
      tr.innerHTML=`<td colspan="6" class="ds-table-empty">No reservations</td>`;
      reserveTable.appendChild(tr);
      return;
    }
    filtered.slice().reverse().forEach(e=>{
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${e.code}</td><td>${e.jobId||''}</td><td>${e.qty}</td><td class="mobile-hide">${e.location || FALLBACK}</td><td class="mobile-hide">${e.returnDate||''}</td><td class="mobile-hide">${utils.formatDateTime?.(e.ts) || ''}</td>`;
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
    const locationPayload = getInventoryLocationPayload('reserve-location');

    let okAll = true;
    for(const line of lines){
      const r = await fetch('/api/inventory-reserve',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ code: line.code, jobId, qty: line.qty, returnDate, notes, ...locationPayload, userEmail: session.email, userName: session.name })
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
      const locationPayload = getInventoryLocationPayload('reserve-location');
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
          body: JSON.stringify({ jobId, returnDate, notes, lines: payload, ...locationPayload, userEmail: session.email, userName: session.name })
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

async function applyPageIntent(){
  const params = new URLSearchParams(window.location.search);
  const project = normalizeJobId(params.get('project') || params.get('job') || '');
  if(!project) return;
  const orderJob = document.getElementById('orderJob');
  const orderMaterialsJob = document.getElementById('orderMaterialsJob');
  const reserveJob = document.getElementById('reserve-jobId');
  if(orderJob) orderJob.value = project;
  if(orderMaterialsJob) orderMaterialsJob.value = project;
  if(reserveJob) reserveJob.value = project;
  if(params.get('loadMaterials') === '1'){
    await loadSelectedProjectMaterials(true);
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  (async ()=>{
    await loadJobs();
    await loadItems();
    await loadInventoryLocations();
    await loadSuppliers();
    await renderRecentOrders();
    initTabs();
    initOrders();
    initReserve();
    initReassign();
    initFilterButtons();
    await applyPageIntent();
    document.getElementById('orderFilter')?.addEventListener('input', renderRecentOrders);
  })();
});
