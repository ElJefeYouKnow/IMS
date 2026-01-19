const FALLBACK = 'N/A';
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

let currentEditId = null;
let currentCategoryId = null;
let categoriesCache = [];
let editModalOpen = false;
let suppliersCache = [];
let currentSupplierId = null;
let itemsCache = [];
let pendingImport = null;

function unitPriceValue(item){
  const raw = item?.unitPrice ?? item?.unitprice;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function getEditModalEls(){
  const modal = document.getElementById('itemEditModal');
  if(!modal) return null;
  return {
    modal,
    close: document.getElementById('itemEditClose'),
    cancel: document.getElementById('itemEditCancel'),
    form: document.getElementById('itemEditForm'),
    code: document.getElementById('itemEditCode'),
    name: document.getElementById('itemEditName'),
    category: document.getElementById('itemEditCategory'),
    unitPrice: document.getElementById('itemEditUnitPrice'),
    material: document.getElementById('itemEditMaterial'),
    shape: document.getElementById('itemEditShape'),
    brand: document.getElementById('itemEditBrand'),
    tags: document.getElementById('itemEditTags'),
    lowStockEnabled: document.getElementById('itemEditLowStockEnabled'),
    notes: document.getElementById('itemEditNotes'),
    description: document.getElementById('itemEditDescription'),
    uom: document.getElementById('itemEditUom'),
    serialized: document.getElementById('itemEditSerialized'),
    lot: document.getElementById('itemEditLot'),
    expires: document.getElementById('itemEditExpires'),
    warehouse: document.getElementById('itemEditWarehouse'),
    zone: document.getElementById('itemEditZone'),
    bin: document.getElementById('itemEditBin'),
    reorderPoint: document.getElementById('itemEditReorderPoint'),
    minStock: document.getElementById('itemEditMinStock')
  };
}

function syncCategoryOptions(targetSelect){
  const source = document.getElementById('category');
  if(!source || !targetSelect) return;
  targetSelect.innerHTML = '';
  Array.from(source.options).forEach(opt=>{
    const cloned = document.createElement('option');
    cloned.value = opt.value;
    cloned.textContent = opt.textContent;
    targetSelect.appendChild(cloned);
  });
}

function openEditModal(item){
  const els = getEditModalEls();
  if(!els || !item) return;
  syncCategoryOptions(els.category);
  currentEditId = item.code;
  els.code.value = item.code || '';
  els.name.value = item.name || '';
  els.category.value = item.category || DEFAULT_CATEGORY_NAME;
  const unitPrice = unitPriceValue(item);
  els.unitPrice.value = unitPrice !== null ? unitPrice : '';
  if(els.material) els.material.value = item.material || '';
  if(els.shape) els.shape.value = item.shape || '';
  if(els.brand) els.brand.value = item.brand || '';
  els.tags.value = Array.isArray(item.tags) ? item.tags.join(', ') : (item.tags || '');
  if(els.notes) els.notes.value = item.notes || '';
  els.description.value = item.description || '';
  if(els.uom) els.uom.value = item.uom || item.unit || '';
  if(els.serialized) els.serialized.checked = !!item.serialized;
  if(els.lot) els.lot.checked = !!item.lot;
  if(els.expires) els.expires.checked = !!item.expires;
  if(els.warehouse) els.warehouse.value = item.warehouse || '';
  if(els.zone) els.zone.value = item.zone || '';
  if(els.bin) els.bin.value = item.bin || '';
  if(els.reorderPoint) els.reorderPoint.value = Number.isFinite(Number(item.reorderPoint)) ? item.reorderPoint : '';
  if(els.minStock) els.minStock.value = Number.isFinite(Number(item.minStock)) ? item.minStock : '';
  const itemLowStock = parseBool(item.lowStockEnabled ?? item.lowstockenabled);
  if(els.lowStockEnabled){
    const fallback = getCategoryLowStockEnabled(els.category.value);
    els.lowStockEnabled.checked = itemLowStock === null ? fallback : itemLowStock;
  }
  els.modal.classList.remove('hidden');
  els.modal.setAttribute('aria-hidden', 'false');
  editModalOpen = true;
}

function closeEditModal(){
  const els = getEditModalEls();
  if(!els) return;
  els.modal.classList.add('hidden');
  els.modal.setAttribute('aria-hidden', 'true');
  editModalOpen = false;
}

function parseCsvLine(line){
  const out = [];
  let cur = '';
  let inQuotes = false;
  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(ch === '"'){
      const next = line[i+1];
      if(inQuotes && next === '"'){
        cur += '"';
        i++;
      }else{
        inQuotes = !inQuotes;
      }
    }else if(ch === ',' && !inQuotes){
      out.push(cur.trim());
      cur = '';
    }else{
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function normalizeHeader(value){
  return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeTags(value){
  if(!value) return [];
  const input = Array.isArray(value) ? value : value.toString().split(/[,;|]/);
  const seen = new Set();
  const out = [];
  input.forEach(tag=>{
    const cleaned = (tag || '').toString().trim();
    if(!cleaned) return;
    const key = cleaned.toLowerCase();
    if(seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  });
  return out;
}

function parseBool(value){
  if(value === undefined || value === null || value === '') return null;
  if(typeof value === 'boolean') return value;
  const cleaned = value.toString().trim().toLowerCase();
  if(!cleaned) return null;
  if(['false','0','no','off','disabled'].includes(cleaned)) return false;
  if(['true','1','yes','on','enabled'].includes(cleaned)) return true;
  return null;
}

function normalizeCode(value){
  return (value || '').toString().trim().toLowerCase();
}

function findDuplicateItem(code, excludeCode){
  const key = normalizeCode(code);
  if(!key) return null;
  const excludeKey = normalizeCode(excludeCode);
  return itemsCache.find(item=>{
    const itemKey = normalizeCode(item?.code);
    if(!itemKey || itemKey !== key) return false;
    return !excludeKey || itemKey !== excludeKey;
  }) || null;
}

function updateCodeHint(code, hintId, excludeCode){
  const hint = document.getElementById(hintId);
  if(!hint) return;
  const match = findDuplicateItem(code, excludeCode);
  if(match){
    hint.textContent = `SKU already exists (${match.name || match.code}).`;
    hint.classList.remove('ok');
    hint.classList.add('warn');
  }else{
    hint.textContent = '';
    hint.classList.remove('warn','ok');
  }
}

function parseCsv(text){
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(!lines.length) return { items: [], skipped: 0 };
  const first = parseCsvLine(lines[0]).map(normalizeHeader);
  const headerMap = new Map();
  const hasHeader = first.includes('code') || first.includes('sku') || first.includes('partnumber') || first.includes('part');
  if(hasHeader){
    first.forEach((h, idx)=>{
      if(['code','sku','part','partnumber'].includes(h)) headerMap.set('code', idx);
      if(['name','itemname'].includes(h)) headerMap.set('name', idx);
      if(['category','cat','type'].includes(h)) headerMap.set('category', idx);
      if(['unitprice','price','unitcost','cost','unit'].includes(h)) headerMap.set('unitPrice', idx);
      if(['material','mat'].includes(h)) headerMap.set('material', idx);
      if(['shape','form'].includes(h)) headerMap.set('shape', idx);
      if(['brand','mfr','manufacturer'].includes(h)) headerMap.set('brand', idx);
      if(['notes','note','itemnotes','internalnotes'].includes(h)) headerMap.set('notes', idx);
      if(['description','desc','details'].includes(h)) headerMap.set('description', idx);
      if(['tags','tag','flags','labels'].includes(h)) headerMap.set('tags', idx);
      if(['lowstockenabled','lowstockalert','lowstockalerts','lowstockalertenabled'].includes(h)) headerMap.set('lowStockEnabled', idx);
    });
  }
  const start = hasHeader ? 1 : 0;
  let skipped = 0;
  const items = [];
  for(let i=start;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const getVal = (key, idx)=> (idx !== undefined ? cols[idx] : '');
    const code = hasHeader ? getVal('code', headerMap.get('code')) : (cols[0] || '');
    const name = hasHeader ? getVal('name', headerMap.get('name')) : (cols[1] || '');
    const category = hasHeader ? getVal('category', headerMap.get('category')) : (cols[2] || '');
    const unitPriceRaw = hasHeader ? getVal('unitPrice', headerMap.get('unitPrice')) : (cols[3] || '');
    const useLegacy = !hasHeader && cols.length <= 7;
    const material = hasHeader ? getVal('material', headerMap.get('material')) : (useLegacy ? '' : (cols[4] || ''));
    const shape = hasHeader ? getVal('shape', headerMap.get('shape')) : (useLegacy ? '' : (cols[5] || ''));
    const brand = hasHeader ? getVal('brand', headerMap.get('brand')) : (useLegacy ? '' : (cols[6] || ''));
    const notes = hasHeader ? getVal('notes', headerMap.get('notes')) : (useLegacy ? '' : (cols[7] || ''));
    const description = hasHeader ? getVal('description', headerMap.get('description')) : (useLegacy ? (cols[4] || '') : (cols[8] || ''));
    const tagsRaw = hasHeader ? getVal('tags', headerMap.get('tags')) : (useLegacy ? (cols[5] || '') : (cols[9] || ''));
    const lowStockRaw = hasHeader ? getVal('lowStockEnabled', headerMap.get('lowStockEnabled')) : (useLegacy ? (cols[6] || '') : (cols[10] || ''));
    if(!code || !name){
      skipped++;
      continue;
    }
    const unitPrice = unitPriceRaw && !Number.isNaN(Number(unitPriceRaw)) ? Number(unitPriceRaw) : null;
    const tags = normalizeTags(tagsRaw);
    const lowStockEnabled = parseBool(lowStockRaw);
    items.push({ code, name, category, unitPrice, material, shape, brand, notes, description, tags, lowStockEnabled, _unitPriceRaw: unitPriceRaw });
  }
  return { items, skipped };
}

function stripImportMeta(items){
  return (items || []).map(item=>{
    const { _unitPriceRaw, ...rest } = item;
    return rest;
  });
}

function buildImportSummary(items){
  const existingCodes = new Set((itemsCache || []).map(i=> normalizeCode(i.code)));
  const seen = new Set();
  const dupFile = new Set();
  const dupExisting = new Set();
  let missingCategory = 0;
  let invalidPrice = 0;
  (items || []).forEach(item=>{
    const key = normalizeCode(item.code);
    if(seen.has(key)) dupFile.add(key);
    else seen.add(key);
    if(existingCodes.has(key)) dupExisting.add(key);
    if(!item.category) missingCategory += 1;
    const rawPrice = (item._unitPriceRaw || '').toString().trim();
    if(rawPrice && item.unitPrice === null) invalidPrice += 1;
  });
  return {
    total: items.length,
    dupFile: dupFile.size,
    dupExisting: dupExisting.size,
    missingCategory,
    invalidPrice
  };
}

function renderImportPreview(items, summary){
  const wrap = document.getElementById('importPreview');
  const summaryEl = document.getElementById('importSummary');
  const body = document.getElementById('importPreviewBody');
  if(!wrap || !summaryEl || !body) return;
  wrap.classList.remove('hidden');
  summaryEl.innerHTML = '';
  const chips = [
    { label: `${summary.total} rows`, warn: false },
    { label: `${summary.dupFile} duplicates in file`, warn: summary.dupFile > 0 },
    { label: `${summary.dupExisting} existing SKUs`, warn: summary.dupExisting > 0 },
    { label: `${summary.missingCategory} missing category`, warn: summary.missingCategory > 0 },
    { label: `${summary.invalidPrice} invalid prices`, warn: summary.invalidPrice > 0 }
  ];
  chips.forEach(chip=>{
    const span = document.createElement('span');
    span.className = `import-chip${chip.warn ? ' warn' : ''}`;
    span.textContent = chip.label;
    summaryEl.appendChild(span);
  });
  body.innerHTML = '';
  items.slice(0,6).forEach(item=>{
    const tr = document.createElement('tr');
    const unitPrice = item.unitPrice === null ? FALLBACK : `$${Number(item.unitPrice).toFixed(2)}`;
    tr.innerHTML = `<td>${item.code}</td><td>${item.name}</td><td>${item.category || FALLBACK}</td><td>${unitPrice}</td>`;
    body.appendChild(tr);
  });
  if(items.length > 6){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" class="muted-text">Showing first 6 of ${items.length} rows.</td>`;
    body.appendChild(tr);
  }
}

function clearImportPreview(){
  const wrap = document.getElementById('importPreview');
  const summaryEl = document.getElementById('importSummary');
  const body = document.getElementById('importPreviewBody');
  if(wrap) wrap.classList.add('hidden');
  if(summaryEl) summaryEl.innerHTML = '';
  if(body) body.innerHTML = '';
  pendingImport = null;
}

function normalizeCategoryRules(raw){
  const input = (raw && typeof raw === 'object') ? raw : {};
  const out = { ...DEFAULT_CATEGORY_RULES };
  if(Object.prototype.hasOwnProperty.call(input, 'requireJobId')) out.requireJobId = !!input.requireJobId;
  if(Object.prototype.hasOwnProperty.call(input, 'requireLocation')) out.requireLocation = !!input.requireLocation;
  if(Object.prototype.hasOwnProperty.call(input, 'requireNotes')) out.requireNotes = !!input.requireNotes;
  if(Object.prototype.hasOwnProperty.call(input, 'allowFieldPurchase')) out.allowFieldPurchase = !!input.allowFieldPurchase;
  if(Object.prototype.hasOwnProperty.call(input, 'allowCheckout')) out.allowCheckout = !!input.allowCheckout;
  if(Object.prototype.hasOwnProperty.call(input, 'allowReserve')) out.allowReserve = !!input.allowReserve;
  if(Object.prototype.hasOwnProperty.call(input, 'lowStockEnabled')) out.lowStockEnabled = !!input.lowStockEnabled;
  const maxCheckoutQty = Number(input.maxCheckoutQty);
  out.maxCheckoutQty = Number.isFinite(maxCheckoutQty) && maxCheckoutQty > 0 ? Math.floor(maxCheckoutQty) : null;
  const returnWindowDays = Number(input.returnWindowDays);
  out.returnWindowDays = Number.isFinite(returnWindowDays) && returnWindowDays > 0 ? Math.floor(returnWindowDays) : DEFAULT_CATEGORY_RULES.returnWindowDays;
  const lowStockThreshold = Number(input.lowStockThreshold);
  out.lowStockThreshold = Number.isFinite(lowStockThreshold) && lowStockThreshold >= 0 ? Math.floor(lowStockThreshold) : DEFAULT_CATEGORY_RULES.lowStockThreshold;
  return out;
}

async function loadCategories(){
  try{
    const r = await fetch('/api/categories', { credentials:'include' });
    if(r.status === 401){ window.location.href='login.html'; return []; }
    if(r.ok){
      const rows = await r.json();
      categoriesCache = (rows || []).map(c=> ({ ...c, rules: normalizeCategoryRules(c.rules) }));
      categoriesCache.sort((a,b)=> (a.name || '').localeCompare(b.name || ''));
      return categoriesCache;
    }
  }catch(e){}
  categoriesCache = [];
  return categoriesCache;
}

function renderCategoryOptions(){
  const select = document.getElementById('category');
  if(!select) return;
  const list = categoriesCache.length ? categoriesCache : [{ name: DEFAULT_CATEGORY_NAME }];
  const current = select.value;
  select.innerHTML = '';
  list.forEach(cat=>{
    const opt = document.createElement('option');
    opt.value = cat.name;
    opt.textContent = cat.name;
    select.appendChild(opt);
  });
  if(current && list.some(c=> c.name === current)){
    select.value = current;
  }else if(list.length){
    select.value = list.find(c=> c.name === DEFAULT_CATEGORY_NAME)?.name || list[0].name;
  }
}

function getCategoryLowStockEnabled(name){
  const match = (categoriesCache || []).find(c=> (c.name || '').toLowerCase() === (name || '').toLowerCase());
  return match?.rules?.lowStockEnabled ?? DEFAULT_CATEGORY_RULES.lowStockEnabled;
}

function setMode(mode){
  let resolved = mode;
  if(!resolved) resolved = 'items';
  const panel = document.getElementById(`${resolved}-mode`);
  if(!panel){
    resolved = 'items';
  }
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    const btnMode = btn.dataset.mode || btn.dataset.tab;
    btn.classList.toggle('active', btnMode === resolved);
  });
  document.querySelectorAll('.mode-content').forEach(panelEl=>{
    panelEl.classList.toggle('active', panelEl.id === `${resolved}-mode`);
  });
}

async function loadItems(){
  try{
    const r = await fetch('/api/items',{credentials:'include'});
    if(r.status === 401){ window.location.href='login.html'; return []; }
    if(r.ok){
      const rows = await r.json();
      itemsCache = Array.isArray(rows) ? rows : [];
      return itemsCache;
    }
  }catch(e){}
  itemsCache = [];
  return itemsCache;
}

async function loadSuppliers(){
  try{
    const r = await fetch('/api/suppliers',{credentials:'include'});
    if(r.status === 401){ window.location.href='login.html'; return []; }
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

async function renderTable(){
  const tbody=document.querySelector('#itemTable tbody');
  if(!tbody) return;
  tbody.innerHTML='';
  const items = await loadItems();
  const search = (document.getElementById('searchBox')?.value || '').toLowerCase();
  let filtered = items;
  if(search) filtered = items.filter(i=> (i.code || '').toLowerCase().includes(search) || (i.name || '').toLowerCase().includes(search));
  filtered.sort((a,b)=> (a.code || '').localeCompare((b.code || '')));
  if(!filtered.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="10" style="text-align:center;color:#6b7280;">No items in catalog</td>`;
    tbody.appendChild(tr);
    return;
  }
  filtered.forEach(item=>{
    const tr=document.createElement('tr');
    const unitPriceNum = unitPriceValue(item);
    const price = Number.isFinite(unitPriceNum) ? `$${unitPriceNum.toFixed(2)}` : FALLBACK;
    const material = item.material || FALLBACK;
    const shape = item.shape || FALLBACK;
    const brand = item.brand || FALLBACK;
    const notes = item.notes || FALLBACK;
    const reorder = Number.isFinite(Number(item.reorderPoint)) ? item.reorderPoint : FALLBACK;
    const code = item.code || '';
    const name = item.name || FALLBACK;
    tr.innerHTML=`<td>${code}</td><td>${name}</td><td>${item.category||FALLBACK}</td><td>${price}</td><td>${material}</td><td>${shape}</td><td>${brand}</td><td>${notes}</td><td>${reorder}</td><td><button class="edit-btn" data-code="${code}">Edit</button> <button class="delete-btn" data-code="${code}" class="muted">Delete</button></td>`;
    tbody.appendChild(tr);
  });
  document.querySelectorAll('.edit-btn').forEach(btn=> btn.addEventListener('click',editItem));
  document.querySelectorAll('.delete-btn').forEach(btn=> btn.addEventListener('click',deleteItem));
  const codeInput = document.getElementById('itemCode');
  if(codeInput) updateCodeHint(codeInput.value, 'itemCodeHint');
}

function formatCategoryRequirements(rules){
  const reqs = [];
  if(rules.requireJobId) reqs.push('Project');
  if(rules.requireLocation) reqs.push('Location');
  if(rules.requireNotes) reqs.push('Notes');
  return reqs.length ? reqs.join(', ') : 'None';
}

function formatCategoryPermissions(rules){
  const perms = [];
  perms.push(rules.allowFieldPurchase === false ? 'No field purchase' : 'Field purchase');
  perms.push(rules.allowCheckout === false ? 'No checkout' : 'Checkout');
  perms.push(rules.allowReserve === false ? 'No reserve' : 'Reserve');
  return perms.join(', ');
}

function formatCategoryThresholds(rules){
  const parts = [];
  if(rules.maxCheckoutQty) parts.push(`Max checkout ${rules.maxCheckoutQty}`);
  parts.push(`Return ${rules.returnWindowDays}d`);
  if(rules.lowStockEnabled === false) parts.push('Low stock off');
  else parts.push(`Low stock ${rules.lowStockThreshold}`);
  return parts.join(', ');
}

async function renderCategoryTable(){
  const tbody = document.querySelector('#categoryTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  if(!categoriesCache.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" style="text-align:center;color:#6b7280;">No categories yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  categoriesCache.forEach(cat=>{
    const rules = normalizeCategoryRules(cat.rules);
    const tr = document.createElement('tr');
    const disabled = (cat.name || '').toLowerCase() === DEFAULT_CATEGORY_NAME.toLowerCase();
    tr.innerHTML = `<td>${cat.name}</td><td>${formatCategoryRequirements(rules)}</td><td>${formatCategoryPermissions(rules)}</td><td>${formatCategoryThresholds(rules)}</td><td><button class="cat-edit-btn" data-id="${cat.id}">Edit</button> <button class="cat-delete-btn muted" data-id="${cat.id}" ${disabled ? 'disabled' : ''}>Delete</button></td>`;
    tbody.appendChild(tr);
  });
  document.querySelectorAll('.cat-edit-btn').forEach(btn=> btn.addEventListener('click', editCategory));
  document.querySelectorAll('.cat-delete-btn').forEach(btn=> btn.addEventListener('click', deleteCategory));
}

function renderSupplierTable(){
  const tbody = document.querySelector('#supplierTable tbody');
  if(!tbody) return;
  const search = (document.getElementById('supplierSearch')?.value || '').toLowerCase();
  tbody.innerHTML = '';
  let rows = suppliersCache.slice();
  if(search){
    rows = rows.filter(s=>{
      return (s.name || '').toLowerCase().includes(search)
        || (s.contact || '').toLowerCase().includes(search)
        || (s.email || '').toLowerCase().includes(search);
    });
  }
  rows.sort((a,b)=> (a.name || '').localeCompare(b.name || ''));
  if(!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" style="text-align:center;color:#6b7280;">No suppliers</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.forEach(s=>{
    const lead = s.leadTime ? `${s.leadTime.avg ?? '-'}d` : '-';
    const moq = s.moq ?? '-';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.name || FALLBACK}</td><td>${s.contact || FALLBACK}</td><td>${lead}</td><td>${moq}</td><td><button class="supplier-edit" data-id="${s.id}">Edit</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.supplier-edit').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const supplier = suppliersCache.find(s=> s.id === btn.dataset.id);
      if(supplier) fillSupplierForm(supplier);
    });
  });
}

function fillSupplierForm(supplier){
  currentSupplierId = supplier?.id || null;
  document.getElementById('supplierId').value = supplier?.id || '';
  document.getElementById('supplierName').value = supplier?.name || '';
  document.getElementById('supplierContact').value = supplier?.contact || '';
  document.getElementById('supplierEmail').value = supplier?.email || '';
  document.getElementById('supplierPhone').value = supplier?.phone || '';
  document.getElementById('supplierLeadAvg').value = supplier?.leadTime?.avg ?? '';
  document.getElementById('supplierLeadMin').value = supplier?.leadTime?.min ?? '';
  document.getElementById('supplierLeadMax').value = supplier?.leadTime?.max ?? '';
  document.getElementById('supplierMoq').value = supplier?.moq ?? '';
  document.getElementById('supplierNotes').value = supplier?.notes || '';
  const msg = document.getElementById('supplierMsg');
  if(msg) msg.textContent = `Editing ${supplier?.name || ''}`;
}

function clearSupplierForm(){
  currentSupplierId = null;
  document.getElementById('supplierForm').reset();
  document.getElementById('supplierId').value = '';
  const msg = document.getElementById('supplierMsg');
  if(msg) msg.textContent = '';
}

async function saveSupplier(payload){
  const id = payload.id;
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/suppliers/${id}` : '/api/suppliers';
  try{
    const r = await fetch(url,{
      method,
      headers:{'Content-Type':'application/json'},
      credentials:'include',
      body: JSON.stringify(payload)
    });
    if(r.status === 401){ alert('Unauthorized'); return false; }
    if(!r.ok){
      const data = await r.json().catch(()=>({}));
      alert(data.error || 'Save failed');
      return false;
    }
    return true;
  }catch(e){
    alert('Save failed');
    return false;
  }
}

function fillCategoryForm(category){
  const rules = normalizeCategoryRules(category?.rules);
  document.getElementById('categoryName').value = category?.name || '';
  document.getElementById('categoryLowStock').value = Number.isFinite(Number(rules.lowStockThreshold)) ? rules.lowStockThreshold : '';
  document.getElementById('ruleLowStockEnabled').checked = rules.lowStockEnabled !== false;
  document.getElementById('categoryMaxCheckout').value = rules.maxCheckoutQty || '';
  document.getElementById('categoryReturnWindow').value = rules.returnWindowDays || '';
  document.getElementById('ruleRequireJob').checked = !!rules.requireJobId;
  document.getElementById('ruleRequireLocation').checked = !!rules.requireLocation;
  document.getElementById('ruleRequireNotes').checked = !!rules.requireNotes;
  document.getElementById('ruleAllowFieldPurchase').checked = rules.allowFieldPurchase !== false;
  document.getElementById('ruleAllowCheckout').checked = rules.allowCheckout !== false;
  document.getElementById('ruleAllowReserve').checked = rules.allowReserve !== false;
  document.getElementById('categorySaveBtn').textContent = currentCategoryId ? 'Update Category' : 'Save Category';
  document.getElementById('categoryName').disabled = (category?.name || '').toLowerCase() === DEFAULT_CATEGORY_NAME.toLowerCase();
}

function clearCategoryForm(){
  currentCategoryId = null;
  document.getElementById('categoryForm').reset();
  document.getElementById('categoryName').disabled = false;
  document.getElementById('categorySaveBtn').textContent = 'Save Category';
  const msg = document.getElementById('categoryMsg');
  if(msg) msg.textContent = '';
}

async function editCategory(e){
  const id = e.target.dataset.id;
  const category = categoriesCache.find(c=> c.id === id);
  if(!category) return;
  currentCategoryId = id;
  fillCategoryForm(category);
  setMode('categories');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteCategory(e){
  const id = e.target.dataset.id;
  const category = categoriesCache.find(c=> c.id === id);
  if(!category) return;
  if(!confirm(`Delete category "${category.name}"? Items will move to ${DEFAULT_CATEGORY_NAME}.`)) return;
  try{
    const r = await fetch(`/api/categories/${id}`, { method:'DELETE', credentials:'include' });
    const data = await r.json().catch(()=>({}));
    if(!r.ok){
      alert(data.error || 'Failed to delete category');
      return;
    }
    await loadCategories();
    renderCategoryOptions();
    await renderCategoryTable();
    await renderTable();
  }catch(e){
    alert('Failed to delete category');
  }
}

async function addItem(item){
  try{
    const r = await fetch('/api/items',{
      method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(item)
    });
    if(r.status === 401){ alert('Unauthorized. Please log in as admin.'); return false; }
    if(r.status === 403){ alert('Forbidden. Admin only.'); return false; }
    if(r.ok) return true;
    const data = await r.json().catch(()=>({}));
    alert(data.error || 'Failed to save item');
  }catch(e){}
  return false;
}

async function deleteItemApi(code){
  try{
    const r = await fetch(`/api/items/${code}`,{method:'DELETE',credentials:'include'});
    if(r.status === 401){ alert('Unauthorized. Please log in as admin.'); return false; }
    if(r.status === 403){ alert('Forbidden. Admin only.'); return false; }
    if(r.ok) return true;
  }catch(e){}
  return false;
}

async function editItem(e){
  const code = e.target.dataset.code;
  const items = await loadItems();
  const item = items.find(i=> i.code === code);
  if(!item) return;
  openEditModal(item);
}

async function deleteItem(e){
  const code = e.target.dataset.code;
  if(!confirm(`Delete item "${code}"?`)) return;
  const ok = await deleteItemApi(code);
  if(!ok) alert('Failed to delete item');
  else await renderTable();
}

function clearForm(){
  currentEditId = null;
  document.getElementById('itemForm').reset();
  document.getElementById('itemCode').disabled = false;
  document.getElementById('addBtn').textContent = 'Add Item';
  const categorySelect = document.getElementById('category');
  if(categorySelect){
    categorySelect.value = categoriesCache.find(c=> c.name === DEFAULT_CATEGORY_NAME)?.name || categorySelect.value;
  }
  const lowStockCheckbox = document.getElementById('itemLowStockEnabled');
  if(lowStockCheckbox){
    lowStockCheckbox.checked = getCategoryLowStockEnabled(categorySelect?.value);
  }
  ['itemSerialized','itemLot','itemExpires'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.checked = false;
  });
  updateCodeHint('', 'itemCodeHint');
}

document.addEventListener('DOMContentLoaded', async ()=>{
  if(window.utils){
    if(!utils.requireSession?.()) return;
    utils.requireRole?.('admin');
    utils.wrapFetchWithRole?.();
    utils.applyStoredTheme?.();
    utils.applyNavVisibility?.();
    utils.setupLogout?.();
  }
  const hash = (window.location.hash || '').replace('#','').toLowerCase();
  const initial = hash === 'categories' ? 'categories' : hash === 'suppliers' ? 'suppliers' : 'items';
  setMode(initial);
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const mode = btn.dataset.mode || btn.dataset.tab || 'items';
      setMode(mode);
      if(mode === 'categories') window.location.hash = 'categories';
      else if(mode === 'suppliers') window.location.hash = 'suppliers';
      else history.replaceState(null, '', window.location.pathname);
    });
  });
  // Verify server session is still valid
  fetch('/api/auth/me',{credentials:'include'})
    .then(r=>{ if(r.status===401) window.location.href='login.html'; return r; })
    .catch(()=>{});
  await loadCategories();
  renderCategoryOptions();
  await renderCategoryTable();
  await renderTable();
  suppliersCache = await loadSuppliers();
  renderSupplierTable();
  const categorySelect = document.getElementById('category');
  const lowStockCheckbox = document.getElementById('itemLowStockEnabled');
  if(categorySelect && lowStockCheckbox){
    lowStockCheckbox.checked = getCategoryLowStockEnabled(categorySelect.value);
    categorySelect.addEventListener('change', ()=>{
      lowStockCheckbox.checked = getCategoryLowStockEnabled(categorySelect.value);
    });
  }
  const searchBox = document.getElementById('searchBox');
  if(searchBox) searchBox.addEventListener('input', renderTable);
  const codeInput = document.getElementById('itemCode');
  if(codeInput){
    updateCodeHint(codeInput.value, 'itemCodeHint');
    codeInput.addEventListener('input', ()=> updateCodeHint(codeInput.value, 'itemCodeHint'));
  }
  const searchParam = new URLSearchParams(window.location.search).get('search');
  if(searchParam && searchBox){
    searchBox.value = searchParam;
    renderTable();
  }
  const importBtn = document.getElementById('importBtn');
  const importFile = document.getElementById('importFile');
  const importMsg = document.getElementById('importMsg');
  const importConfirmBtn = document.getElementById('importConfirmBtn');
  const importClearPreview = document.getElementById('importClearPreview');
  if(importBtn && importFile){
    importBtn.addEventListener('click', async ()=>{
      importMsg.textContent = '';
      if(!importFile.files || !importFile.files[0]){
        importMsg.textContent = 'Choose a CSV file first.';
        importMsg.style.color = '#b91c1c';
        return;
      }
      const text = await importFile.files[0].text();
      const { items, skipped } = parseCsv(text);
      if(!items.length){
        importMsg.textContent = 'No valid rows found.';
        importMsg.style.color = '#b91c1c';
        return;
      }
      const summary = buildImportSummary(items);
      pendingImport = { items: stripImportMeta(items), summary, skipped };
      renderImportPreview(items, summary);
      importMsg.textContent = `Preview ready${skipped ? `, skipped ${skipped} rows` : ''}. Review and confirm import.`;
      importMsg.style.color = '#475569';
    });
    importFile.addEventListener('change', ()=> clearImportPreview());
  }
  if(importConfirmBtn){
    importConfirmBtn.addEventListener('click', async ()=>{
      if(!pendingImport?.items?.length){
        importMsg.textContent = 'Preview a CSV file first.';
        importMsg.style.color = '#b91c1c';
        return;
      }
      if(pendingImport.summary?.dupFile > 0){
        const proceed = confirm('Duplicate SKUs found in the file. Continue import?');
        if(!proceed) return;
      }
      try{
        const r = await fetch('/api/items/bulk', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          credentials:'include',
          body: JSON.stringify({ items: pendingImport.items })
        });
        const data = await r.json().catch(()=>({}));
        if(!r.ok){
          importMsg.textContent = data.error || 'Import failed';
          importMsg.style.color = '#b91c1c';
          return;
        }
        importMsg.textContent = `Imported ${data.count} items${pendingImport.skipped ? `, skipped ${pendingImport.skipped}` : ''}.`;
        importMsg.style.color = '#15803d';
        clearImportPreview();
        if(importFile) importFile.value = '';
        await renderTable();
      }catch(e){
        importMsg.textContent = 'Import failed';
        importMsg.style.color = '#b91c1c';
      }
    });
  }
  if(importClearPreview){
    importClearPreview.addEventListener('click', ()=> clearImportPreview());
  }

  const downloadBtn = document.getElementById('downloadTemplateBtn');
  if(downloadBtn){
    downloadBtn.addEventListener('click', ()=>{
      const csv = 'code,name,category,unitPrice,material,shape,brand,notes,description,tags,lowStockEnabled\\n';
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'item-master-template.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  const supplierSearch = document.getElementById('supplierSearch');
  supplierSearch?.addEventListener('input', renderSupplierTable);
  document.getElementById('supplierRefresh')?.addEventListener('click', async ()=>{
    suppliersCache = await loadSuppliers();
    renderSupplierTable();
  });
  document.getElementById('supplierClear')?.addEventListener('click', clearSupplierForm);
  document.getElementById('supplierForm')?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const payload = {
      id: currentSupplierId,
      name: document.getElementById('supplierName').value.trim(),
      contact: document.getElementById('supplierContact').value.trim(),
      email: document.getElementById('supplierEmail').value.trim(),
      phone: document.getElementById('supplierPhone').value.trim(),
      moq: document.getElementById('supplierMoq').value ? Number(document.getElementById('supplierMoq').value) : null,
      notes: document.getElementById('supplierNotes').value.trim(),
      leadTime: {
        avg: document.getElementById('supplierLeadAvg').value ? Number(document.getElementById('supplierLeadAvg').value) : null,
        min: document.getElementById('supplierLeadMin').value ? Number(document.getElementById('supplierLeadMin').value) : null,
        max: document.getElementById('supplierLeadMax').value ? Number(document.getElementById('supplierLeadMax').value) : null
      }
    };
    const msg = document.getElementById('supplierMsg');
    if(!payload.name){
      if(msg){ msg.textContent = 'Name is required.'; msg.style.color = '#b91c1c'; }
      return;
    }
    const ok = await saveSupplier(payload);
    if(msg){
      if(ok){
        msg.textContent = 'Saved';
        msg.style.color = '#15803d';
      }else{
        msg.textContent = 'Save failed';
        msg.style.color = '#b91c1c';
      }
    }
    if(ok){
      suppliersCache = await loadSuppliers();
      renderSupplierTable();
      clearSupplierForm();
    }
  });

  const form = document.getElementById('itemForm');
  form?.addEventListener('submit',async ev=>{
    ev.preventDefault();
    const code = document.getElementById('itemCode').value.trim();
    const name = document.getElementById('itemName').value.trim();
    const category = document.getElementById('category').value.trim();
    const unitPrice = document.getElementById('unitPrice').value;
    const material = document.getElementById('itemMaterial').value.trim();
    const shape = document.getElementById('itemShape').value.trim();
    const brand = document.getElementById('itemBrand').value.trim();
    const tagsRaw = document.getElementById('itemTags').value;
    const lowStockEnabled = document.getElementById('itemLowStockEnabled').checked;
    const notes = document.getElementById('itemNotes').value.trim();
    const uom = document.getElementById('itemUom').value.trim();
    const serialized = document.getElementById('itemSerialized').checked;
    const lot = document.getElementById('itemLot').checked;
    const expires = document.getElementById('itemExpires').checked;
    const warehouse = document.getElementById('itemWarehouse').value.trim();
    const zone = document.getElementById('itemZone').value.trim();
    const bin = document.getElementById('itemBin').value.trim();
    const reorderPointRaw = document.getElementById('itemReorderPoint').value;
    const minStockRaw = document.getElementById('itemMinStock').value;
    const description = document.getElementById('description').value.trim();
    if(!code||!name){alert('Code and name are required');return}
    const duplicate = findDuplicateItem(code, currentEditId);
    if(duplicate && !currentEditId){
      updateCodeHint(code, 'itemCodeHint');
      alert('SKU already exists. Use a unique code.');
      return;
    }
    
    const tags = normalizeTags(tagsRaw);
    const item = {
      code,
      name,
      category,
      unitPrice: unitPrice ? parseFloat(unitPrice) : null,
      material,
      shape,
      brand,
      notes,
      description,
      tags,
      lowStockEnabled,
      uom,
      serialized,
      lot,
      expires,
      warehouse,
      zone,
      bin,
      reorderPoint: reorderPointRaw === '' ? null : Number(reorderPointRaw),
      minStock: minStockRaw === '' ? null : Number(minStockRaw)
    };
    if(currentEditId){
      item.oldCode = currentEditId;
    }
    const ok = await addItem(item);
    if(!ok) alert('Failed to save item');
    else{
      await renderTable();
      clearForm();
    }
  });

  document.getElementById('clearBtn')?.addEventListener('click',clearForm);

  const editEls = getEditModalEls();
  if(editEls){
    if(editEls.close) editEls.close.addEventListener('click', closeEditModal);
    if(editEls.cancel) editEls.cancel.addEventListener('click', closeEditModal);
    editEls.modal?.addEventListener('click', (ev)=>{
      if(ev.target === ev.currentTarget) closeEditModal();
    });
    document.addEventListener('keydown', (e)=>{
      if(e.key === 'Escape' && editModalOpen) closeEditModal();
    });
    editEls.form.addEventListener('submit', async ev=>{
      ev.preventDefault();
      const code = editEls.code.value.trim();
      const name = editEls.name.value.trim();
      const category = editEls.category.value.trim();
      const unitPrice = editEls.unitPrice.value;
      const material = editEls.material ? editEls.material.value.trim() : '';
      const shape = editEls.shape ? editEls.shape.value.trim() : '';
      const brand = editEls.brand ? editEls.brand.value.trim() : '';
      const tagsRaw = editEls.tags.value;
      const lowStockEnabled = editEls.lowStockEnabled ? editEls.lowStockEnabled.checked : false;
      const notes = editEls.notes ? editEls.notes.value.trim() : '';
      const description = editEls.description.value.trim();
      const uom = editEls.uom?.value.trim() || '';
      const serialized = editEls.serialized?.checked || false;
      const lot = editEls.lot?.checked || false;
      const expires = editEls.expires?.checked || false;
      const warehouse = editEls.warehouse?.value.trim() || '';
      const zone = editEls.zone?.value.trim() || '';
      const bin = editEls.bin?.value.trim() || '';
      const reorderPointRaw = editEls.reorderPoint?.value || '';
      const minStockRaw = editEls.minStock?.value || '';
      if(!code || !name){ alert('Code and name are required'); return; }
      const tags = normalizeTags(tagsRaw);
      const item = {
        code,
        name,
        category,
        unitPrice: unitPrice ? parseFloat(unitPrice) : null,
        material,
        shape,
        brand,
        notes,
        description,
        tags,
        lowStockEnabled,
        uom,
        serialized,
        lot,
        expires,
        warehouse,
        zone,
        bin,
        reorderPoint: reorderPointRaw === '' ? null : Number(reorderPointRaw),
        minStock: minStockRaw === '' ? null : Number(minStockRaw)
      };
      if(currentEditId){
        item.oldCode = currentEditId;
      }
      const ok = await addItem(item);
      if(!ok) alert('Failed to save item');
      else{
        await renderTable();
        closeEditModal();
      }
    });
  }

  const categoryForm = document.getElementById('categoryForm');
  categoryForm?.addEventListener('submit', async ev=>{
    ev.preventDefault();
    const name = document.getElementById('categoryName').value.trim();
    if(!name){ alert('Category name is required'); return; }
    const rules = {
      requireJobId: document.getElementById('ruleRequireJob').checked,
      requireLocation: document.getElementById('ruleRequireLocation').checked,
      requireNotes: document.getElementById('ruleRequireNotes').checked,
      lowStockEnabled: document.getElementById('ruleLowStockEnabled').checked,
      allowFieldPurchase: document.getElementById('ruleAllowFieldPurchase').checked,
      allowCheckout: document.getElementById('ruleAllowCheckout').checked,
      allowReserve: document.getElementById('ruleAllowReserve').checked,
      maxCheckoutQty: document.getElementById('categoryMaxCheckout').value,
      returnWindowDays: document.getElementById('categoryReturnWindow').value,
      lowStockThreshold: document.getElementById('categoryLowStock').value
    };
    const payload = { name, rules };
    const msg = document.getElementById('categoryMsg');
    if(msg){ msg.textContent = ''; msg.style.color = '#6b7280'; }
    try{
      const url = currentCategoryId ? `/api/categories/${currentCategoryId}` : '/api/categories';
      const method = currentCategoryId ? 'PUT' : 'POST';
      const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify(payload) });
      const data = await r.json().catch(()=>({}));
      if(!r.ok){
        if(msg){
          msg.textContent = data.error || 'Failed to save category';
          msg.style.color = '#b91c1c';
        }else{
          alert(data.error || 'Failed to save category');
        }
        return;
      }
      await loadCategories();
      renderCategoryOptions();
      await renderCategoryTable();
      await renderTable();
      clearCategoryForm();
      const okMsg = document.getElementById('categoryMsg');
      if(okMsg){
        okMsg.textContent = 'Category saved.';
        okMsg.style.color = '#15803d';
      }
    }catch(e){
      if(msg){
        msg.textContent = 'Failed to save category';
        msg.style.color = '#b91c1c';
      }else{
        alert('Failed to save category');
      }
    }
  });
  document.getElementById('categoryClearBtn')?.addEventListener('click', clearCategoryForm);

  const refreshBtn = document.getElementById('catalogRefreshBtn');
  if(refreshBtn){
    refreshBtn.addEventListener('click', async ()=>{
      refreshBtn.disabled = true;
      const label = refreshBtn.textContent;
      refreshBtn.textContent = 'Refreshing...';
      try{
        if('serviceWorker' in navigator){
          const reg = await navigator.serviceWorker.getRegistration();
          await reg?.update();
        }
        if('caches' in window){
          const keys = await caches.keys();
          await Promise.all(keys.map(key => caches.delete(key)));
        }
      }catch(e){}
      window.location.reload();
    });
  }
});
