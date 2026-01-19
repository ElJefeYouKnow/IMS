const FALLBACK = 'N/A';
const DEFAULT_CATEGORY_NAME = 'Uncategorized';

const state = {
  items: [],
  categories: [],
  suppliers: [],
  supplierApiAvailable: true,
  editingCode: null,
  editingCategoryId: null,
  editingSupplierId: null
};

const fieldMap = {
  code: 'Code',
  name: 'Name',
  category: 'Category',
  unitPrice: 'UnitPrice',
  material: 'Material',
  shape: 'Shape',
  brand: 'Brand',
  tags: 'Tags',
  lowStockEnabled: 'LowStockEnabled',
  notes: 'Notes',
  description: 'Description',
  uom: 'Uom',
  serialized: 'Serialized',
  lot: 'Lot',
  expires: 'Expires',
  warehouse: 'Warehouse',
  zone: 'Zone',
  bin: 'Bin',
  reorderPoint: 'ReorderPoint',
  minStock: 'MinStock'
};

const dom = {
  status: null,
  itemsTable: null,
  itemForm: null,
  searchBox: null,
  categorySelect: null,
  lowStockEnabled: null,
  importFile: null,
  importBtn: null,
  importMsg: null,
  categoryForm: null,
  categoryTable: null,
  categoryMsg: null,
  supplierTable: null,
  supplierForm: null,
  supplierMsg: null,
  supplierSearch: null,
  supplierRefresh: null,
  refreshBtn: null,
  editModal: null,
  editForm: null,
  editClose: null,
  editCancel: null
};

function setStatus(message, tone){
  if(!dom.status) dom.status = document.getElementById('catalogStatus');
  if(!dom.status) return;
  dom.status.textContent = message || '';
  if(tone === 'error') dom.status.style.color = '#b91c1c';
  else if(tone === 'ok') dom.status.style.color = '#15803d';
  else dom.status.style.color = '';
}

setStatus('Catalog script loaded...', 'muted');

function qs(id){
  return document.getElementById(id);
}

function getField(prefix, key){
  return qs(`${prefix}${fieldMap[key]}`);
}

function normalizeTags(value){
  if(!value) return [];
  const parts = value.split(/[,;|]/).map(v => v.trim()).filter(Boolean);
  const seen = new Set();
  return parts.filter(tag => {
    const key = tag.toLowerCase();
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseNumber(value){
  if(value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseIntSafe(value){
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
}

function fetchJson(url, options = {}){
  const opts = { credentials: 'include', ...options };
  return fetch(url, opts).then(async (res) => {
    if(res.status === 401){
      window.location.href = 'login.html';
      return null;
    }
    let data = null;
    try{ data = await res.json(); }catch(e){ data = null; }
    return { ok: res.ok, status: res.status, data };
  });
}

function setMode(mode){
  const resolved = mode || 'items';
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    const btnMode = btn.dataset.mode || btn.dataset.tab || 'items';
    btn.classList.toggle('active', btnMode === resolved);
  });
  document.querySelectorAll('.mode-content').forEach(panel=>{
    panel.classList.toggle('active', panel.id === `${resolved}-mode`);
  });
}

function getCategoryLowStockEnabled(name){
  const match = state.categories.find(c => (c.name || '').toLowerCase() === (name || '').toLowerCase());
  return match?.rules?.lowStockEnabled ?? false;
}

function renderCategoryOptions(){
  const select = dom.categorySelect;
  if(!select) return;
  const current = select.value;
  const list = state.categories.length ? state.categories : [{ name: DEFAULT_CATEGORY_NAME }];
  select.innerHTML = '';
  list.forEach(cat=>{
    const opt = document.createElement('option');
    opt.value = cat.name;
    opt.textContent = cat.name;
    select.appendChild(opt);
  });
  if(current && list.some(c=> c.name === current)) select.value = current;
  else select.value = list.find(c=> c.name === DEFAULT_CATEGORY_NAME)?.name || list[0].name;
}

function buildItemPayload(prefix, oldCode){
  const code = getField(prefix, 'code')?.value.trim();
  const name = getField(prefix, 'name')?.value.trim();
  const category = getField(prefix, 'category')?.value.trim();
  if(!code || !name) return { error: 'Code and name are required.' };
  const unitPrice = parseNumber(getField(prefix, 'unitPrice')?.value);
  const material = getField(prefix, 'material')?.value.trim() || '';
  const shape = getField(prefix, 'shape')?.value.trim() || '';
  const brand = getField(prefix, 'brand')?.value.trim() || '';
  const tags = normalizeTags(getField(prefix, 'tags')?.value || '');
  const lowStockEnabled = !!getField(prefix, 'lowStockEnabled')?.checked;
  const notes = getField(prefix, 'notes')?.value.trim() || '';
  const description = getField(prefix, 'description')?.value.trim() || '';
  const uom = getField(prefix, 'uom')?.value.trim() || '';
  const serialized = !!getField(prefix, 'serialized')?.checked;
  const lot = !!getField(prefix, 'lot')?.checked;
  const expires = !!getField(prefix, 'expires')?.checked;
  const warehouse = getField(prefix, 'warehouse')?.value.trim() || '';
  const zone = getField(prefix, 'zone')?.value.trim() || '';
  const bin = getField(prefix, 'bin')?.value.trim() || '';
  const reorderPoint = parseIntSafe(getField(prefix, 'reorderPoint')?.value);
  const minStock = parseIntSafe(getField(prefix, 'minStock')?.value);

  const payload = {
    code,
    name,
    category,
    unitPrice,
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
    reorderPoint,
    minStock
  };
  if(oldCode && oldCode !== code) payload.oldCode = oldCode;
  return { payload };
}

function fillItemForm(prefix, item){
  if(!item) return;
  const setValue = (key, value)=>{
    const el = getField(prefix, key);
    if(!el) return;
    if(el.type === 'checkbox') el.checked = !!value;
    else el.value = value ?? '';
  };
  setValue('code', item.code || '');
  setValue('name', item.name || '');
  setValue('category', item.category || DEFAULT_CATEGORY_NAME);
  setValue('unitPrice', item.unitPrice ?? '');
  setValue('material', item.material || '');
  setValue('shape', item.shape || '');
  setValue('brand', item.brand || '');
  setValue('tags', Array.isArray(item.tags) ? item.tags.join(', ') : (item.tags || ''));
  setValue('lowStockEnabled', item.lowStockEnabled ?? false);
  setValue('notes', item.notes || '');
  setValue('description', item.description || '');
  setValue('uom', item.uom || '');
  setValue('serialized', item.serialized);
  setValue('lot', item.lot);
  setValue('expires', item.expires);
  setValue('warehouse', item.warehouse || '');
  setValue('zone', item.zone || '');
  setValue('bin', item.bin || '');
  setValue('reorderPoint', item.reorderPoint ?? '');
  setValue('minStock', item.minStock ?? '');
}

function clearItemForm(){
  state.editingCode = null;
  dom.itemForm?.reset();
  renderCategoryOptions();
  if(dom.categorySelect && dom.lowStockEnabled){
    dom.lowStockEnabled.checked = getCategoryLowStockEnabled(dom.categorySelect.value);
  }
}

function openEditModal(item){
  if(!dom.editModal) return;
  state.editingCode = item.code;
  fillItemForm('itemEdit', item);
  const codeField = getField('itemEdit', 'code');
  if(codeField) codeField.disabled = true;
  dom.editModal.classList.remove('hidden');
  dom.editModal.setAttribute('aria-hidden', 'false');
}

function closeEditModal(){
  if(!dom.editModal) return;
  dom.editModal.classList.add('hidden');
  dom.editModal.setAttribute('aria-hidden', 'true');
}

async function loadItems(){
  const res = await fetchJson('/api/items');
  if(!res){
    setStatus('Catalog error: unable to load items', 'error');
    state.items = [];
    return;
  }
  state.items = Array.isArray(res.data) ? res.data : [];
}

async function loadCategories(){
  const res = await fetchJson('/api/categories');
  if(!res){
    setStatus('Catalog error: unable to load categories', 'error');
    state.categories = [];
    return;
  }
  state.categories = Array.isArray(res.data) ? res.data : [];
}

async function loadSuppliers(){
  const res = await fetchJson('/api/suppliers');
  if(!res){
    state.suppliers = [];
    state.supplierApiAvailable = false;
    return;
  }
  if(res.status === 404){
    state.suppliers = [];
    state.supplierApiAvailable = false;
    return;
  }
  state.suppliers = Array.isArray(res.data) ? res.data : [];
  state.supplierApiAvailable = true;
}

function renderItemsTable(){
  if(!dom.itemsTable) return;
  const tbody = dom.itemsTable.querySelector('tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const search = (dom.searchBox?.value || '').toLowerCase();
  const items = state.items.filter(item => {
    if(!search) return true;
    return (item.code || '').toLowerCase().includes(search) || (item.name || '').toLowerCase().includes(search);
  });
  items.sort((a,b)=> (a.code || '').localeCompare((b.code || '')));
  if(!items.length){
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="10" style="text-align:center;color:#6b7280;">No items in catalog</td>';
    tbody.appendChild(tr);
    return;
  }
  items.forEach(item=>{
    const tr = document.createElement('tr');
    const price = Number.isFinite(Number(item.unitPrice)) ? `$${Number(item.unitPrice).toFixed(2)}` : FALLBACK;
    const reorder = Number.isFinite(Number(item.reorderPoint)) ? item.reorderPoint : FALLBACK;
    tr.innerHTML = `
      <td>${item.code || ''}</td>
      <td>${item.name || FALLBACK}</td>
      <td>${item.category || FALLBACK}</td>
      <td>${price}</td>
      <td>${item.material || FALLBACK}</td>
      <td>${item.shape || FALLBACK}</td>
      <td>${item.brand || FALLBACK}</td>
      <td>${item.notes || FALLBACK}</td>
      <td>${reorder}</td>
      <td>
        <button class="edit-btn" data-code="${item.code || ''}">Edit</button>
        <button class="delete-btn muted" data-code="${item.code || ''}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.edit-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const code = btn.dataset.code;
      const item = state.items.find(i => i.code === code);
      if(item) openEditModal(item);
    });
  });
  tbody.querySelectorAll('.delete-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const code = btn.dataset.code;
      if(!code) return;
      if(!confirm(`Delete item "${code}"?`)) return;
      const res = await fetchJson(`/api/items/${encodeURIComponent(code)}`, { method:'DELETE' });
      if(!res || !res.ok){
        alert(res?.data?.error || 'Failed to delete item');
        return;
      }
      await refreshItems();
    });
  });
}

function renderCategoriesTable(){
  if(!dom.categoryTable) return;
  const tbody = dom.categoryTable.querySelector('tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  if(!state.categories.length){
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" style="text-align:center;color:#6b7280;">No categories yet</td>';
    tbody.appendChild(tr);
    return;
  }
  state.categories.forEach(cat=>{
    const isDefault = (cat.name || '').toLowerCase() === DEFAULT_CATEGORY_NAME.toLowerCase();
    const rules = cat.rules || {};
    const thresholds = rules.lowStockEnabled === false ? 'Low stock off' : `Low stock ${rules.lowStockThreshold ?? ''}`;
    const perms = [
      rules.allowFieldPurchase === false ? 'No field purchase' : 'Field purchase',
      rules.allowCheckout === false ? 'No checkout' : 'Checkout',
      rules.allowReserve === false ? 'No reserve' : 'Reserve'
    ].join(', ');
    const reqs = [
      rules.requireJobId ? 'Project' : null,
      rules.requireLocation ? 'Location' : null,
      rules.requireNotes ? 'Notes' : null
    ].filter(Boolean).join(', ') || 'None';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${cat.name || FALLBACK}</td>
      <td>${reqs}</td>
      <td>${perms}</td>
      <td>${thresholds}</td>
      <td>
        <button class="cat-edit-btn" data-id="${cat.id}">Edit</button>
        <button class="cat-delete-btn muted" data-id="${cat.id}" ${isDefault ? 'disabled' : ''}>Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.cat-edit-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.id;
      const cat = state.categories.find(c => c.id === id);
      if(!cat) return;
      state.editingCategoryId = id;
      fillCategoryForm(cat);
      setMode('categories');
    });
  });
  tbody.querySelectorAll('.cat-delete-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.id;
      if(!id) return;
      const cat = state.categories.find(c => c.id === id);
      if(!cat) return;
      if(!confirm(`Delete category "${cat.name}"? Items will move to ${DEFAULT_CATEGORY_NAME}.`)) return;
      const res = await fetchJson(`/api/categories/${id}`, { method:'DELETE' });
      if(!res || !res.ok){
        alert(res?.data?.error || 'Failed to delete category');
        return;
      }
      await refreshCategories();
      await refreshItems();
    });
  });
}

function renderSuppliersTable(){
  if(!dom.supplierTable) return;
  const tbody = dom.supplierTable.querySelector('tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  if(!state.supplierApiAvailable){
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" style="text-align:center;color:#6b7280;">Suppliers are not available yet.</td>';
    tbody.appendChild(tr);
    return;
  }
  const search = (dom.supplierSearch?.value || '').toLowerCase();
  let rows = state.suppliers.slice();
  if(search){
    rows = rows.filter(s => (s.name || '').toLowerCase().includes(search) || (s.contact || '').toLowerCase().includes(search) || (s.email || '').toLowerCase().includes(search));
  }
  rows.sort((a,b)=> (a.name || '').localeCompare((b.name || '')));
  if(!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" style="text-align:center;color:#6b7280;">No suppliers</td>';
    tbody.appendChild(tr);
    return;
  }
  rows.forEach(s=>{
    const lead = s.leadTime?.avg != null ? `${s.leadTime.avg}d` : '-';
    const moq = s.moq ?? '-';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.name || FALLBACK}</td>
      <td>${s.contact || FALLBACK}</td>
      <td>${lead}</td>
      <td>${moq}</td>
      <td><button class="supplier-edit" data-id="${s.id}">Edit</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.supplier-edit').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const supplier = state.suppliers.find(s => s.id === btn.dataset.id);
      if(supplier) fillSupplierForm(supplier);
    });
  });
}

function fillCategoryForm(category){
  state.editingCategoryId = category?.id || null;
  qs('categoryName').value = category?.name || '';
  const rules = category?.rules || {};
  qs('categoryLowStock').value = Number.isFinite(Number(rules.lowStockThreshold)) ? rules.lowStockThreshold : '';
  qs('ruleLowStockEnabled').checked = rules.lowStockEnabled !== false;
  qs('categoryMaxCheckout').value = rules.maxCheckoutQty || '';
  qs('categoryReturnWindow').value = rules.returnWindowDays || '';
  qs('ruleRequireJob').checked = !!rules.requireJobId;
  qs('ruleRequireLocation').checked = !!rules.requireLocation;
  qs('ruleRequireNotes').checked = !!rules.requireNotes;
  qs('ruleAllowFieldPurchase').checked = rules.allowFieldPurchase !== false;
  qs('ruleAllowCheckout').checked = rules.allowCheckout !== false;
  qs('ruleAllowReserve').checked = rules.allowReserve !== false;
  qs('categorySaveBtn').textContent = state.editingCategoryId ? 'Update Category' : 'Save Category';
  const isDefault = (category?.name || '').toLowerCase() === DEFAULT_CATEGORY_NAME.toLowerCase();
  qs('categoryName').disabled = isDefault;
}

function clearCategoryForm(){
  state.editingCategoryId = null;
  qs('categoryForm')?.reset();
  qs('categoryName').disabled = false;
  qs('categorySaveBtn').textContent = 'Save Category';
  if(dom.categoryMsg) dom.categoryMsg.textContent = '';
}

function fillSupplierForm(supplier){
  state.editingSupplierId = supplier?.id || null;
  qs('supplierId').value = supplier?.id || '';
  qs('supplierName').value = supplier?.name || '';
  qs('supplierContact').value = supplier?.contact || '';
  qs('supplierEmail').value = supplier?.email || '';
  qs('supplierPhone').value = supplier?.phone || '';
  qs('supplierLeadAvg').value = supplier?.leadTime?.avg ?? '';
  qs('supplierLeadMin').value = supplier?.leadTime?.min ?? '';
  qs('supplierLeadMax').value = supplier?.leadTime?.max ?? '';
  qs('supplierMoq').value = supplier?.moq ?? '';
  qs('supplierNotes').value = supplier?.notes || '';
  if(dom.supplierMsg) dom.supplierMsg.textContent = supplier ? `Editing ${supplier.name || ''}` : '';
}

function clearSupplierForm(){
  state.editingSupplierId = null;
  qs('supplierForm')?.reset();
  qs('supplierId').value = '';
  if(dom.supplierMsg) dom.supplierMsg.textContent = '';
}

async function refreshItems(){
  await loadItems();
  renderItemsTable();
  setStatus(`Loaded ${state.items.length} items, ${state.categories.length} categories.`, 'ok');
}

async function refreshCategories(){
  await loadCategories();
  renderCategoryOptions();
  renderCategoriesTable();
}

async function refreshSuppliers(){
  await loadSuppliers();
  renderSuppliersTable();
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

function parseCsv(text){
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if(!lines.length) return { items: [], skipped: 0 };
  const header = parseCsvLine(lines[0]).map(normalizeHeader);
  const hasHeader = header.includes('code') || header.includes('sku');
  const map = new Map();
  if(hasHeader){
    header.forEach((h, idx)=>{
      if(['code','sku','part','partnumber'].includes(h)) map.set('code', idx);
      if(['name','itemname'].includes(h)) map.set('name', idx);
      if(['category','cat'].includes(h)) map.set('category', idx);
      if(['unitprice','price','unitcost','cost'].includes(h)) map.set('unitPrice', idx);
      if(['material'].includes(h)) map.set('material', idx);
      if(['shape'].includes(h)) map.set('shape', idx);
      if(['brand'].includes(h)) map.set('brand', idx);
      if(['notes','note'].includes(h)) map.set('notes', idx);
      if(['description','desc'].includes(h)) map.set('description', idx);
      if(['tags','tag','flags'].includes(h)) map.set('tags', idx);
      if(['lowstockenabled','lowstockalert'].includes(h)) map.set('lowStockEnabled', idx);
    });
  }
  const start = hasHeader ? 1 : 0;
  const items = [];
  let skipped = 0;
  for(let i=start;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const get = (key, idx)=> idx !== undefined ? cols[idx] : '';
    const code = hasHeader ? get('code', map.get('code')) : (cols[0] || '');
    const name = hasHeader ? get('name', map.get('name')) : (cols[1] || '');
    if(!code || !name){ skipped++; continue; }
    items.push({
      code,
      name,
      category: hasHeader ? get('category', map.get('category')) : (cols[2] || ''),
      unitPrice: parseNumber(hasHeader ? get('unitPrice', map.get('unitPrice')) : (cols[3] || '')),
      material: hasHeader ? get('material', map.get('material')) : (cols[4] || ''),
      shape: hasHeader ? get('shape', map.get('shape')) : (cols[5] || ''),
      brand: hasHeader ? get('brand', map.get('brand')) : (cols[6] || ''),
      notes: hasHeader ? get('notes', map.get('notes')) : (cols[7] || ''),
      description: hasHeader ? get('description', map.get('description')) : (cols[8] || ''),
      tags: normalizeTags(hasHeader ? get('tags', map.get('tags')) : (cols[9] || '')),
      lowStockEnabled: /^(true|1|yes|on|enabled)$/i.test(hasHeader ? get('lowStockEnabled', map.get('lowStockEnabled')) : (cols[10] || ''))
    });
  }
  return { items, skipped };
}

async function handleImport(){
  if(!dom.importFile || !dom.importMsg) return;
  if(!dom.importFile.files || !dom.importFile.files[0]){
    dom.importMsg.textContent = 'Choose a CSV file first.';
    dom.importMsg.style.color = '#b91c1c';
    return;
  }
  const text = await dom.importFile.files[0].text();
  const { items, skipped } = parseCsv(text);
  if(!items.length){
    dom.importMsg.textContent = 'No valid rows found.';
    dom.importMsg.style.color = '#b91c1c';
    return;
  }
  const proceed = confirm(`Import ${items.length} items?${skipped ? ` Skipped ${skipped} rows.` : ''}`);
  if(!proceed) return;
  const res = await fetchJson('/api/items/bulk', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ items })
  });
  if(!res || !res.ok){
    dom.importMsg.textContent = res?.data?.error || 'Import failed';
    dom.importMsg.style.color = '#b91c1c';
    return;
  }
  dom.importMsg.textContent = `Imported ${res.data.count || items.length} items.`;
  dom.importMsg.style.color = '#15803d';
  dom.importFile.value = '';
  await refreshItems();
}

async function handleSaveItem(prefix, isEdit){
  const { payload, error } = buildItemPayload(prefix, isEdit ? state.editingCode : null);
  if(error){
    alert(error);
    return;
  }
  const res = await fetchJson('/api/items', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if(!res || !res.ok){
    alert(res?.data?.error || 'Failed to save item');
    return;
  }
  await refreshItems();
  if(isEdit) closeEditModal();
  else clearItemForm();
}

async function handleSaveCategory(){
  const name = qs('categoryName')?.value.trim();
  if(!name){
    alert('Category name is required.');
    return;
  }
  const rules = {
    requireJobId: qs('ruleRequireJob')?.checked || false,
    requireLocation: qs('ruleRequireLocation')?.checked || false,
    requireNotes: qs('ruleRequireNotes')?.checked || false,
    lowStockEnabled: qs('ruleLowStockEnabled')?.checked || false,
    allowFieldPurchase: qs('ruleAllowFieldPurchase')?.checked || false,
    allowCheckout: qs('ruleAllowCheckout')?.checked || false,
    allowReserve: qs('ruleAllowReserve')?.checked || false,
    maxCheckoutQty: qs('categoryMaxCheckout')?.value,
    returnWindowDays: qs('categoryReturnWindow')?.value,
    lowStockThreshold: qs('categoryLowStock')?.value
  };
  const url = state.editingCategoryId ? `/api/categories/${state.editingCategoryId}` : '/api/categories';
  const method = state.editingCategoryId ? 'PUT' : 'POST';
  const res = await fetchJson(url, {
    method,
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name, rules })
  });
  if(!res || !res.ok){
    if(dom.categoryMsg){
      dom.categoryMsg.textContent = res?.data?.error || 'Failed to save category';
      dom.categoryMsg.style.color = '#b91c1c';
    }else{
      alert(res?.data?.error || 'Failed to save category');
    }
    return;
  }
  if(dom.categoryMsg){
    dom.categoryMsg.textContent = 'Category saved.';
    dom.categoryMsg.style.color = '#15803d';
  }
  await refreshCategories();
  await refreshItems();
  clearCategoryForm();
}

async function handleSaveSupplier(){
  if(!state.supplierApiAvailable){
    alert('Suppliers are not available yet.');
    return;
  }
  const payload = {
    id: state.editingSupplierId,
    name: qs('supplierName')?.value.trim(),
    contact: qs('supplierContact')?.value.trim(),
    email: qs('supplierEmail')?.value.trim(),
    phone: qs('supplierPhone')?.value.trim(),
    moq: parseNumber(qs('supplierMoq')?.value),
    notes: qs('supplierNotes')?.value.trim(),
    leadTime: {
      avg: parseNumber(qs('supplierLeadAvg')?.value),
      min: parseNumber(qs('supplierLeadMin')?.value),
      max: parseNumber(qs('supplierLeadMax')?.value)
    }
  };
  if(!payload.name){
    if(dom.supplierMsg){
      dom.supplierMsg.textContent = 'Name is required.';
      dom.supplierMsg.style.color = '#b91c1c';
    }
    return;
  }
  const url = payload.id ? `/api/suppliers/${payload.id}` : '/api/suppliers';
  const method = payload.id ? 'PUT' : 'POST';
  const res = await fetchJson(url, {
    method,
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if(!res || !res.ok){
    if(dom.supplierMsg){
      dom.supplierMsg.textContent = res?.data?.error || 'Save failed';
      dom.supplierMsg.style.color = '#b91c1c';
    }
    return;
  }
  if(dom.supplierMsg){
    dom.supplierMsg.textContent = 'Saved';
    dom.supplierMsg.style.color = '#15803d';
  }
  await refreshSuppliers();
  clearSupplierForm();
}

async function refreshAll(){
  setStatus('Loading catalog...', 'muted');
  await Promise.all([loadCategories(), loadItems(), loadSuppliers()]);
  renderCategoryOptions();
  renderCategoriesTable();
  renderItemsTable();
  renderSuppliersTable();
  setStatus(`Loaded ${state.items.length} items, ${state.categories.length} categories, ${state.suppliers.length} suppliers.`, 'ok');
}

function bindEvents(){
  dom.itemsTable = qs('itemTable');
  dom.itemForm = qs('itemForm');
  dom.searchBox = qs('searchBox');
  dom.categorySelect = qs('category');
  dom.lowStockEnabled = qs('itemLowStockEnabled');
  dom.importFile = qs('importFile');
  dom.importBtn = qs('importBtn');
  dom.importMsg = qs('importMsg');
  dom.categoryForm = qs('categoryForm');
  dom.categoryTable = qs('categoryTable');
  dom.categoryMsg = qs('categoryMsg');
  dom.supplierTable = qs('supplierTable');
  dom.supplierForm = qs('supplierForm');
  dom.supplierMsg = qs('supplierMsg');
  dom.supplierSearch = qs('supplierSearch');
  dom.supplierRefresh = qs('supplierRefresh');
  dom.refreshBtn = qs('catalogRefreshBtn');
  dom.editModal = qs('itemEditModal');
  dom.editForm = qs('itemEditForm');
  dom.editClose = qs('itemEditClose');
  dom.editCancel = qs('itemEditCancel');

  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const mode = btn.dataset.mode || btn.dataset.tab || 'items';
      setMode(mode);
      if(mode === 'categories') window.location.hash = 'categories';
      else if(mode === 'suppliers') window.location.hash = 'suppliers';
      else history.replaceState(null, '', window.location.pathname);
    });
  });
  window.addEventListener('hashchange', ()=>{
    const hash = (window.location.hash || '').replace('#','').toLowerCase();
    const mode = hash === 'categories' ? 'categories' : hash === 'suppliers' ? 'suppliers' : 'items';
    setMode(mode);
  });

  dom.searchBox?.addEventListener('input', renderItemsTable);
  dom.categorySelect?.addEventListener('change', ()=>{
    if(dom.lowStockEnabled) dom.lowStockEnabled.checked = getCategoryLowStockEnabled(dom.categorySelect.value);
  });

  dom.itemForm?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    await handleSaveItem('item', false);
  });
  qs('clearBtn')?.addEventListener('click', clearItemForm);

  dom.importBtn?.addEventListener('click', handleImport);

  dom.editForm?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    await handleSaveItem('itemEdit', true);
  });
  dom.editClose?.addEventListener('click', closeEditModal);
  dom.editCancel?.addEventListener('click', closeEditModal);
  dom.editModal?.addEventListener('click', (e)=>{
    if(e.target === dom.editModal) closeEditModal();
  });
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && dom.editModal && !dom.editModal.classList.contains('hidden')) closeEditModal();
  });

  dom.categoryForm?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    await handleSaveCategory();
  });
  qs('categoryClearBtn')?.addEventListener('click', clearCategoryForm);

  dom.supplierSearch?.addEventListener('input', renderSuppliersTable);
  dom.supplierRefresh?.addEventListener('click', async ()=>{
    await refreshSuppliers();
  });
  qs('supplierClear')?.addEventListener('click', clearSupplierForm);
  dom.supplierForm?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    await handleSaveSupplier();
  });

  dom.refreshBtn?.addEventListener('click', async ()=>{
    dom.refreshBtn.disabled = true;
    const label = dom.refreshBtn.textContent;
    dom.refreshBtn.textContent = 'Refreshing...';
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

async function init(){
  if(window.utils){
    let session = utils.getSession?.();
    if(!session){
      await utils.refreshSession?.();
      session = utils.getSession?.();
    }
    if(!session){
      window.location.href = 'login.html';
      return;
    }
    utils.requireRole?.('admin');
    utils.wrapFetchWithRole?.();
    utils.applyStoredTheme?.();
    utils.applyNavVisibility?.();
    utils.setupLogout?.();
  }
  bindEvents();
  const hash = (window.location.hash || '').replace('#','').toLowerCase();
  const initial = hash === 'categories' ? 'categories' : hash === 'suppliers' ? 'suppliers' : 'items';
  setMode(initial);
  await refreshAll();
}

document.addEventListener('DOMContentLoaded', init);
