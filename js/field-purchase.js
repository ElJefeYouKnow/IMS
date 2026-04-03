let itemsCache = [];
let jobOptions = [];
let categoriesCache = [];
let inventoryLocationOptions = [];
let purchaseRowsCache = [];
let filteredPurchaseRows = [];
let receiptPhotos = [];
let receiptPhotoProcessing = false;
let purchaseSubmitInFlight = false;
let pendingPurchaseBatchId = '';
const DEFAULT_CATEGORY_NAME = 'Uncategorized';
const SESSION_KEY = 'sessionUser';
const MAX_RECEIPT_PHOTOS = 2;
const MAX_RECEIPT_PHOTO_BYTES = 260 * 1024;
const MAX_RECEIPT_TOTAL_BYTES = 520 * 1024;
const MAX_RECEIPT_DIMENSION = 1600;
const purchaseCurrencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const purchaseTableState = {
  search: '',
  project: '',
  vendor: '',
  receiptStatus: 'all',
  dateFrom: '',
  dateTo: '',
  sort: 'newest'
};
const FALLBACK_LOCATION_OPTIONS = [
  { id: 'loc:warehouse:main', name: 'Main Warehouse', label: 'Main Warehouse', type: 'warehouse', ref: 'main' },
  { id: 'loc:bin:primary', name: 'Primary Bin', label: 'Primary Bin', type: 'bin', ref: 'primary' },
  { id: 'loc:staging:staging', name: 'Staging Area', label: 'Staging Area', type: 'staging', ref: 'staging' },
  { id: 'loc:field:field', name: 'Field Stock', label: 'Field Stock', type: 'field', ref: 'field' },
  { id: 'loc:writeoff:writeoff', name: 'Lost / Write-off', label: 'Lost / Write-off', type: 'writeoff', ref: 'writeoff' }
];

function getSession(){
  if(window.utils?.getSession) return utils.getSession();
  try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch(e){return null;}
}

function uid(){
  return Math.random().toString(16).slice(2, 10);
}

function escapeHtml(value){
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes){
  const value = Number(bytes || 0);
  if(value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if(value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function normalizeText(value){
  return String(value || '').trim().toLowerCase();
}

function parseJsonObject(value){
  if(!value) return {};
  if(typeof value === 'string'){
    try{
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }catch(e){
      return {};
    }
  }
  return value && typeof value === 'object' ? value : {};
}

function parsePurchaseTs(value){
  const parsed = window.utils?.parseTs?.(value);
  if(parsed !== null && parsed !== undefined && Number.isFinite(parsed)) return parsed;
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatLocalDateKey(value){
  const date = new Date(parsePurchaseTs(value));
  if(!Number.isFinite(date.getTime())) return '';
  const pad = (part)=> String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getPurchaseSourceMeta(entry){
  return entry && typeof entry === 'object'
    ? parseJsonObject(entry.sourceMeta || entry.sourcemeta || {})
    : {};
}

function getPurchaseTs(entry){
  return parsePurchaseTs(entry?.ts);
}

function getPurchaseJobId(entry){
  return String(entry?.jobId || entry?.jobid || '').trim();
}

function getPurchaseProjectLabel(entry){
  return getPurchaseJobId(entry) || 'General';
}

function getPurchaseVendor(entry){
  const meta = getPurchaseSourceMeta(entry);
  return String(meta.vendor || meta.Vendor || '').trim();
}

function getPurchaseReceipt(entry){
  const meta = getPurchaseSourceMeta(entry);
  return String(meta.receipt || meta.receiptNumber || meta.receiptnumber || '').trim();
}

function getPurchaseBatchId(entry){
  const meta = getPurchaseSourceMeta(entry);
  return String(
    meta.batchId
    || meta.batchid
    || entry?.sourceId
    || entry?.sourceid
    || entry?.id
    || ''
  ).trim();
}

function getPurchaseCost(entry){
  const meta = getPurchaseSourceMeta(entry);
  const value = Number(meta.cost ?? meta.unitCost ?? meta.unitcost);
  return Number.isFinite(value) ? value : null;
}

function formatPurchaseCost(entry){
  const value = getPurchaseCost(entry);
  return Number.isFinite(value) ? purchaseCurrencyFmt.format(value) : '';
}

function normalizePurchaseEntry(entry){
  if(!entry || typeof entry !== 'object') return null;
  return {
    ...entry,
    code: String(entry.code || '').trim(),
    name: String(entry.name || '').trim(),
    qty: Number(entry.qty || 0) || 0,
    location: String(entry.location || '').trim(),
    notes: String(entry.notes || '').trim(),
    jobId: getPurchaseJobId(entry),
    sourceId: String(entry.sourceId || entry.sourceid || '').trim(),
    ts: parsePurchaseTs(entry.ts),
    sourceMeta: getPurchaseSourceMeta(entry)
  };
}

function normalizePurchaseRows(rows){
  if(!Array.isArray(rows)) return [];
  return rows
    .map(normalizePurchaseEntry)
    .filter(Boolean);
}

function ensureReceiptPhotoName(name, index){
  const raw = String(name || `receipt-${index + 1}`).trim();
  const stem = raw.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${stem || `receipt-${index + 1}`}.jpg`;
}

function estimateDataUrlBytes(dataUrl){
  const base64 = String(dataUrl || '').split(',')[1] || '';
  const paddingMatch = base64.match(/=*$/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function setReceiptPhotoMessage(message = '', tone = ''){
  const el = document.getElementById('purchase-receiptPhotoMsg');
  if(!el) return;
  const cls = ['field-hint'];
  if(tone) cls.push(tone);
  el.className = cls.join(' ');
  el.textContent = message;
}

function syncReceiptPhotoControls(){
  const input = document.getElementById('purchase-receiptPhotos');
  const submitBtn = document.getElementById('purchaseBtn');
  const addBtn = document.getElementById('purchase-addLine');
  const clearBtn = document.getElementById('purchase-clearBtn');
  const isBusy = receiptPhotoProcessing || purchaseSubmitInFlight;
  if(input) input.disabled = isBusy || receiptPhotos.length >= MAX_RECEIPT_PHOTOS;
  if(submitBtn){
    submitBtn.disabled = isBusy;
    submitBtn.textContent = purchaseSubmitInFlight ? 'Logging...' : 'Log Purchase';
  }
  if(addBtn) addBtn.disabled = purchaseSubmitInFlight;
  if(clearBtn) clearBtn.disabled = purchaseSubmitInFlight;
}

function renderReceiptPhotoPreview(){
  const wrap = document.getElementById('purchase-receiptPreview');
  if(!wrap) return;
  if(!receiptPhotos.length){
    wrap.innerHTML = '';
    wrap.classList.add('hidden');
    syncReceiptPhotoControls();
    return;
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML = receiptPhotos.map((photo, index)=> `
    <div class="receipt-photo-card">
      <img src="${photo.dataUrl}" alt="Receipt preview ${index + 1}">
      <div class="receipt-photo-meta">
        <span class="receipt-photo-name">${escapeHtml(photo.name || `Receipt ${index + 1}`)}</span>
        <span class="receipt-photo-sub">${escapeHtml(formatBytes(photo.sizeBytes || 0))}</span>
      </div>
      <div class="receipt-photo-actions">
        <button type="button" class="muted remove-receipt-photo" data-id="${photo.id}">Remove</button>
      </div>
    </div>
  `).join('');
  wrap.querySelectorAll('.remove-receipt-photo').forEach((button)=>{
    button.addEventListener('click', ()=>{
      receiptPhotos = receiptPhotos.filter((photo)=> photo.id !== button.dataset.id);
      renderReceiptPhotoPreview();
      setReceiptPhotoMessage(receiptPhotos.length ? `${receiptPhotos.length} receipt photo${receiptPhotos.length === 1 ? '' : 's'} ready.` : '', receiptPhotos.length ? 'ok' : '');
    });
  });
  syncReceiptPhotoControls();
}

function resetReceiptPhotos(message = '', tone = ''){
  receiptPhotos = [];
  renderReceiptPhotoPreview();
  setReceiptPhotoMessage(message, tone);
}

function invalidatePendingPurchaseBatch(){
  if(purchaseSubmitInFlight) return;
  pendingPurchaseBatchId = '';
}

function loadImageFromUrl(url){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=> resolve(img);
    img.onerror = ()=> reject(new Error('Unable to read image'));
    img.src = url;
  });
}

async function compressReceiptPhoto(file, index){
  if(!file || !String(file.type || '').toLowerCase().startsWith('image/')){
    throw new Error('Receipt photos must be image files.');
  }
  const objectUrl = URL.createObjectURL(file);
  try{
    const img = await loadImageFromUrl(objectUrl);
    const sourceWidth = img.naturalWidth || img.width || 1;
    const sourceHeight = img.naturalHeight || img.height || 1;
    const scale = Math.min(1, MAX_RECEIPT_DIMENSION / Math.max(sourceWidth, sourceHeight));
    let width = Math.max(1, Math.round(sourceWidth * scale));
    let height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if(!ctx) throw new Error('Receipt photo preview is not supported in this browser.');

    const draw = ()=>{
      canvas.width = width;
      canvas.height = height;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
    };

    draw();
    let quality = 0.82;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    let sizeBytes = estimateDataUrlBytes(dataUrl);

    while(sizeBytes > MAX_RECEIPT_PHOTO_BYTES && quality > 0.52){
      quality = Number((quality - 0.08).toFixed(2));
      dataUrl = canvas.toDataURL('image/jpeg', quality);
      sizeBytes = estimateDataUrlBytes(dataUrl);
    }

    while(sizeBytes > MAX_RECEIPT_PHOTO_BYTES && Math.max(width, height) > 960){
      width = Math.max(1, Math.round(width * 0.88));
      height = Math.max(1, Math.round(height * 0.88));
      draw();
      quality = Math.min(quality, 0.74);
      dataUrl = canvas.toDataURL('image/jpeg', quality);
      sizeBytes = estimateDataUrlBytes(dataUrl);
      while(sizeBytes > MAX_RECEIPT_PHOTO_BYTES && quality > 0.52){
        quality = Number((quality - 0.06).toFixed(2));
        dataUrl = canvas.toDataURL('image/jpeg', quality);
        sizeBytes = estimateDataUrlBytes(dataUrl);
      }
    }

    if(sizeBytes > MAX_RECEIPT_PHOTO_BYTES){
      throw new Error(`"${file.name}" is still too large after compression. Crop closer to the receipt and try again.`);
    }

    return {
      id: `receipt-${uid()}`,
      name: ensureReceiptPhotoName(file.name, index),
      type: 'image/jpeg',
      sizeBytes,
      width,
      height,
      dataUrl
    };
  }finally{
    URL.revokeObjectURL(objectUrl);
  }
}

async function handleReceiptPhotoSelection(event){
  const input = event?.target;
  const files = Array.from(input?.files || []).filter((file)=> String(file.type || '').toLowerCase().startsWith('image/'));
  if(!files.length){
    if(input) input.value = '';
    return;
  }
  const remainingSlots = MAX_RECEIPT_PHOTOS - receiptPhotos.length;
  if(remainingSlots <= 0){
    setReceiptPhotoMessage(`Only ${MAX_RECEIPT_PHOTOS} receipt photos can be attached to a field purchase.`, 'warn');
    if(input) input.value = '';
    syncReceiptPhotoControls();
    return;
  }

  const selectedFiles = files.slice(0, remainingSlots);
  receiptPhotoProcessing = true;
  syncReceiptPhotoControls();
  setReceiptPhotoMessage(`Preparing ${selectedFiles.length} receipt photo${selectedFiles.length === 1 ? '' : 's'}...`, 'warn');

  try{
    const nextPhotos = [];
    for(let index = 0; index < selectedFiles.length; index += 1){
      const photo = await compressReceiptPhoto(selectedFiles[index], receiptPhotos.length + index);
      const projectedBytes = receiptPhotos.concat(nextPhotos).reduce((sum, entry)=> sum + Number(entry.sizeBytes || 0), 0) + Number(photo.sizeBytes || 0);
      if(projectedBytes > MAX_RECEIPT_TOTAL_BYTES){
        throw new Error('Receipt photos are too large together. Use smaller images or keep one photo.');
      }
      nextPhotos.push(photo);
    }
    receiptPhotos = receiptPhotos.concat(nextPhotos);
    renderReceiptPhotoPreview();
    const limitNote = files.length > selectedFiles.length ? ` Limit is ${MAX_RECEIPT_PHOTOS}.` : '';
    setReceiptPhotoMessage(`${receiptPhotos.length} receipt photo${receiptPhotos.length === 1 ? '' : 's'} ready.${limitNote}`, 'ok');
  }catch(e){
    setReceiptPhotoMessage(e.message || 'Unable to prepare receipt photos.');
  }finally{
    receiptPhotoProcessing = false;
    if(input) input.value = '';
    syncReceiptPhotoControls();
  }
}

function getReceiptPhotosFromEntry(entry){
  const meta = getPurchaseSourceMeta(entry);
  const raw = meta.receiptPhotos || meta.receiptphotos || meta.photos || [];
  if(!Array.isArray(raw)) return [];
  return raw
    .map((photo, index)=>({
      name: ensureReceiptPhotoName(photo?.name, index),
      dataUrl: String(photo?.dataUrl || '').trim(),
      sizeBytes: Number(photo?.sizeBytes || 0) || 0
    }))
    .filter((photo)=> /^data:image\/(?:jpeg|png|webp);base64,/i.test(photo.dataUrl));
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
  if(matchByValue) select.value = matchByValue.value;
  else if(matchByRef) select.value = matchByRef.value;
  else if(preferredByValue) select.value = preferredByValue.value;
  else if(preferredByRef) select.value = preferredByRef.value;
  else if(select.options.length > 1) select.selectedIndex = 1;
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

async function loadItems(){
  itemsCache = await utils.fetchJsonSafe('/api/items', {}, []) || [];
  refreshItemOptions();
}

async function loadCategories(){
  categoriesCache = await utils.fetchJsonSafe('/api/categories', {}, []) || [];
  refreshCategorySelects();
}

function refreshCategorySelects(){
  const selects = document.querySelectorAll('select[name="category"]');
  selects.forEach((select)=>{
    const wasDisabled = select.disabled;
    const list = categoriesCache.length ? categoriesCache : [{ name: DEFAULT_CATEGORY_NAME }];
    const current = select.value;
    select.innerHTML = '';
    list.forEach((cat)=>{
      const opt = document.createElement('option');
      opt.value = cat.name;
      opt.textContent = cat.name;
      select.appendChild(opt);
    });
    if(current && list.some((category)=> category.name === current)){
      select.value = current;
    }else if(list.length){
      const def = list.find((category)=> category.name === DEFAULT_CATEGORY_NAME);
      select.value = def ? def.name : list[0].name;
    }
    select.disabled = wasDisabled;
  });
}

async function loadJobs(){
  const jobs = await utils.fetchJsonSafe('/api/jobs', {}, []);
  jobOptions = (jobs || []).map((job)=> job.code).filter(Boolean).sort();
  const select = document.getElementById('purchase-jobId');
  if(!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">General Inventory</option>';
  jobOptions.forEach((job)=>{
    const opt = document.createElement('option');
    opt.value = job;
    opt.textContent = job;
    select.appendChild(opt);
  });
  if(current) select.value = current;
}

function addLine(){
  const container = document.getElementById('purchase-lines');
  if(!container) return;
  const id = uid();
  const codeId = `purchase-code-${id}`;
  const nameId = `purchase-name-${id}`;
  const categoryId = `purchase-cat-${id}`;
  const qtyId = `purchase-qty-${id}`;
  const costId = `purchase-cost-${id}`;
  const suggId = `${codeId}-s`;
  const row = document.createElement('div');
  row.className = 'form-row line-row';
  row.innerHTML = `
    <label>Item Code
      <input id="${codeId}" name="code" required placeholder="SKU, part number or barcode" list="purchase-item-options">
      <div id="${suggId}" class="suggestions"></div>
    </label>
    <label>Item Name<input id="${nameId}" name="name" placeholder="Required if new"></label>
    <label>Category<select id="${categoryId}" name="category"></select></label>
    <label style="max-width:120px;">Qty<input id="${qtyId}" name="qty" type="number" min="1" value="1" required></label>
    <label style="max-width:140px;">Cost<input id="${costId}" name="cost" type="number" min="0" step="0.01" placeholder="Optional"></label>
    <button type="button" class="muted remove-line">Remove</button>
  `;
  container.appendChild(row);
  refreshCategorySelects();
  row.querySelector('.remove-line').addEventListener('click', ()=>{
    if(container.querySelectorAll('.line-row').length > 1){
      row.remove();
    }
  });
  utils.attachItemLookup({
    getItems: ()=> itemsCache,
    codeInputId: codeId,
    nameInputId: nameId,
    categoryInputId: categoryId,
    suggestionsId: suggId
  });
  const codeInput = row.querySelector(`#${codeId}`);
  const nameInput = row.querySelector(`#${nameId}`);
  const categoryInput = row.querySelector(`#${categoryId}`);
  const fillFromExisting = ()=>{
    const value = codeInput?.value.trim().toLowerCase() || '';
    if(!value){
      if(categoryInput) categoryInput.disabled = false;
      return;
    }
    const match = itemsCache.find((item)=> (item.code || '').toLowerCase() === value);
    if(!match){
      if(categoryInput) categoryInput.disabled = false;
      return;
    }
    if(nameInput && !nameInput.value) nameInput.value = match.name || '';
    if(categoryInput){
      categoryInput.value = match.category || DEFAULT_CATEGORY_NAME;
      categoryInput.disabled = true;
    }
  };
  codeInput?.addEventListener('change', fillFromExisting);
  codeInput?.addEventListener('blur', fillFromExisting);
}

function gatherLines(){
  const rows = [...document.querySelectorAll('#purchase-lines .line-row')];
  const output = [];
  rows.forEach((row)=>{
    const code = row.querySelector('input[name="code"]')?.value.trim() || '';
    const name = row.querySelector('input[name="name"]')?.value.trim() || '';
    const category = row.querySelector('select[name="category"]')?.value.trim() || '';
    const qty = parseInt(row.querySelector('input[name="qty"]')?.value || '0', 10) || 0;
    const cost = row.querySelector('input[name="cost"]')?.value;
    if(code && qty > 0){
      output.push({ code, name, category, qty, cost: cost ? Number(cost) : null });
    }
  });
  return output;
}

function downloadBlob(blob, filename){
  if(window.navigator?.msSaveOrOpenBlob){
    window.navigator.msSaveOrOpenBlob(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(()=> URL.revokeObjectURL(url), 1500);
}

function csvCell(value){
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function buildPurchaseFilterSummary(){
  const parts = [];
  if(purchaseTableState.search) parts.push(`Search: ${purchaseTableState.search}`);
  if(purchaseTableState.project === '__general__') parts.push('Project: General Inventory');
  else if(purchaseTableState.project) parts.push(`Project: ${purchaseTableState.project}`);
  if(purchaseTableState.vendor) parts.push(`Vendor: ${purchaseTableState.vendor}`);
  if(purchaseTableState.receiptStatus !== 'all') parts.push(`Receipt: ${purchaseTableState.receiptStatus}`);
  if(purchaseTableState.dateFrom) parts.push(`From: ${purchaseTableState.dateFrom}`);
  if(purchaseTableState.dateTo) parts.push(`To: ${purchaseTableState.dateTo}`);
  parts.push(`Sort: ${purchaseTableState.sort}`);
  return parts.join(' | ');
}

function updatePurchaseProjectFilter(rows){
  const select = document.getElementById('purchaseFilterProject');
  if(!select) return;
  const current = purchaseTableState.project;
  const projects = Array.from(new Set(
    (rows || [])
      .map((entry)=> getPurchaseJobId(entry))
      .filter(Boolean)
  )).sort((a, b)=> a.localeCompare(b));
  select.innerHTML = [
    '<option value="">All projects</option>',
    '<option value="__general__">General Inventory</option>',
    ...projects.map((project)=> `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`)
  ].join('');
  if(current === '__general__' || projects.includes(current)){
    select.value = current;
  }else{
    purchaseTableState.project = '';
    select.value = '';
  }
}

function matchesPurchaseReceiptStatus(entry){
  const receipt = getPurchaseReceipt(entry);
  const photos = getReceiptPhotosFromEntry(entry);
  if(purchaseTableState.receiptStatus === 'with-receipt') return !!(receipt || photos.length);
  if(purchaseTableState.receiptStatus === 'with-photo') return photos.length > 0;
  if(purchaseTableState.receiptStatus === 'missing') return !(receipt || photos.length);
  return true;
}

function applyPurchaseFilters(rows){
  const search = normalizeText(purchaseTableState.search);
  const vendorFilter = normalizeText(purchaseTableState.vendor);
  return (rows || []).filter((entry)=>{
    const vendor = getPurchaseVendor(entry);
    const receipt = getPurchaseReceipt(entry);
    const projectLabel = getPurchaseProjectLabel(entry);
    const jobId = getPurchaseJobId(entry);
    const notes = String(entry?.notes || '').trim();
    const location = String(entry?.location || '').trim();
    const searchText = normalizeText([
      entry?.code || '',
      entry?.name || '',
      projectLabel,
      vendor,
      receipt,
      notes,
      location
    ].join(' '));
    const dateKey = formatLocalDateKey(getPurchaseTs(entry));

    if(search && !searchText.includes(search)) return false;
    if(purchaseTableState.project === '__general__' && jobId) return false;
    if(purchaseTableState.project && purchaseTableState.project !== '__general__' && jobId !== purchaseTableState.project) return false;
    if(vendorFilter && !normalizeText(vendor).includes(vendorFilter)) return false;
    if(!matchesPurchaseReceiptStatus(entry)) return false;
    if(purchaseTableState.dateFrom && (!dateKey || dateKey < purchaseTableState.dateFrom)) return false;
    if(purchaseTableState.dateTo && (!dateKey || dateKey > purchaseTableState.dateTo)) return false;
    return true;
  });
}

function sortPurchaseRows(rows){
  const list = rows.slice();
  const compareText = (a, b)=> String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
  list.sort((left, right)=>{
    const leftTs = getPurchaseTs(left);
    const rightTs = getPurchaseTs(right);
    const leftVendor = getPurchaseVendor(left);
    const rightVendor = getPurchaseVendor(right);
    const leftProject = getPurchaseProjectLabel(left);
    const rightProject = getPurchaseProjectLabel(right);
    const leftReceiptRank = Number(!!(getPurchaseReceipt(left) || getReceiptPhotosFromEntry(left).length));
    const rightReceiptRank = Number(!!(getPurchaseReceipt(right) || getReceiptPhotosFromEntry(right).length));
    const leftQty = Number(left?.qty || 0) || 0;
    const rightQty = Number(right?.qty || 0) || 0;
    switch(purchaseTableState.sort){
      case 'oldest':
        if(leftTs !== rightTs) return leftTs - rightTs;
        break;
      case 'vendor': {
        const byVendor = compareText(leftVendor || 'Unknown Vendor', rightVendor || 'Unknown Vendor');
        if(byVendor !== 0) return byVendor;
        break;
      }
      case 'project': {
        const byProject = compareText(leftProject, rightProject);
        if(byProject !== 0) return byProject;
        break;
      }
      case 'code': {
        const byCode = compareText(left?.code || '', right?.code || '');
        if(byCode !== 0) return byCode;
        break;
      }
      case 'qty-high':
        if(leftQty !== rightQty) return rightQty - leftQty;
        break;
      case 'qty-low':
        if(leftQty !== rightQty) return leftQty - rightQty;
        break;
      case 'receipt':
        if(leftReceiptRank !== rightReceiptRank) return rightReceiptRank - leftReceiptRank;
        break;
      case 'newest':
      default:
        if(leftTs !== rightTs) return rightTs - leftTs;
        break;
    }
    if(rightTs !== leftTs) return rightTs - leftTs;
    return compareText(left?.code || '', right?.code || '');
  });
  return list;
}

function updatePurchaseTableStatus(filteredRows, totalRows){
  const el = document.getElementById('purchaseTableStatus');
  if(!el) return;
  if(!totalRows){
    el.textContent = 'No field purchases logged yet.';
    return;
  }
  const withReceipt = filteredRows.filter((entry)=> getPurchaseReceipt(entry) || getReceiptPhotosFromEntry(entry).length).length;
  const withPhotos = filteredRows.filter((entry)=> getReceiptPhotosFromEntry(entry).length).length;
  el.textContent = `Showing ${filteredRows.length} of ${totalRows} purchase lines | ${withReceipt} with receipt info | ${withPhotos} with photos`;
}

function groupPurchasesForReceiptPack(rows){
  const groups = [];
  const byKey = new Map();
  rows.forEach((entry, index)=>{
    const key = getPurchaseBatchId(entry) || `purchase-${index}`;
    const vendor = getPurchaseVendor(entry);
    const receipt = getPurchaseReceipt(entry);
    const when = utils.formatDateTime?.(getPurchaseTs(entry)) || '';
    const ts = getPurchaseTs(entry);
    if(!byKey.has(key)){
      const group = {
        key,
        vendor,
        receipt,
        when,
        ts,
        photos: [],
        lines: [],
        projects: new Set(),
        locations: new Set(),
        notes: new Set(),
        photoKeys: new Set()
      };
      byKey.set(key, group);
      groups.push(group);
    }
    const group = byKey.get(key);
    if(!group.vendor && vendor) group.vendor = vendor;
    if(!group.receipt && receipt) group.receipt = receipt;
    const photos = getReceiptPhotosFromEntry(entry);
    photos.forEach((photo)=>{
      const photoKey = `${photo.name}|${photo.dataUrl}`;
      if(group.photoKeys.has(photoKey)) return;
      group.photoKeys.add(photoKey);
      group.photos.push(photo);
    });
    group.projects.add(getPurchaseProjectLabel(entry));
    group.locations.add(String(entry?.location || '').trim() || 'Unspecified');
    if(String(entry?.notes || '').trim()) group.notes.add(String(entry.notes).trim());
    group.lines.push({
      code: entry?.code || '',
      name: entry?.name || '',
      qty: entry?.qty || '',
      project: getPurchaseProjectLabel(entry),
      cost: formatPurchaseCost(entry),
      notes: String(entry?.notes || '').trim()
    });
  });
  return groups
    .map((group)=>({
      ...group,
      photoKeys: undefined
    }))
    .sort((left, right)=> right.ts - left.ts);
}

function buildReceiptPackHtml(rows){
  const generatedAt = new Date();
  const groups = groupPurchasesForReceiptPack(rows);
  const summary = buildPurchaseFilterSummary() || 'All field purchases';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Field Purchase Receipt Pack</title>
  <style>
    body{font-family:Segoe UI,Arial,sans-serif;background:#f4f7f6;color:#1b2522;margin:0;padding:24px}
    .shell{max-width:1100px;margin:0 auto}
    .header{margin-bottom:18px;padding:20px 22px;border-radius:18px;background:linear-gradient(135deg,#132a24,#1f6f5c);color:#fff}
    .header h1{margin:0 0 8px;font-size:28px}
    .header p{margin:0 0 6px;opacity:.92}
    .receipt-card{margin-bottom:18px;padding:18px;border:1px solid #d8e2de;border-radius:18px;background:#fff;box-shadow:0 10px 24px rgba(24,36,32,.08)}
    .receipt-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:10px}
    .receipt-head h2{margin:0;font-size:18px}
    .receipt-meta{display:flex;flex-wrap:wrap;gap:8px 12px;font-size:13px;color:#4a5b56;margin-bottom:12px}
    .receipt-chip{display:inline-flex;align-items:center;padding:5px 9px;border-radius:999px;background:#eef4f1;border:1px solid #d5e2dc;font-size:12px;font-weight:700;color:#21453a}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th,td{padding:8px 10px;border-bottom:1px solid #e4ece8;text-align:left;font-size:13px;vertical-align:top}
    th{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#5d716b}
    .photos{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:14px}
    .photos img{width:100%;max-height:320px;object-fit:contain;border-radius:12px;border:1px solid #d8e2de;background:#fff}
    .empty{margin-top:12px;padding:12px;border:1px dashed #d8e2de;border-radius:12px;background:#f8fbfa;color:#60736d}
    @media print{body{background:#fff;padding:0}.receipt-card{box-shadow:none;break-inside:avoid-page}.header{border-radius:0}}
  </style>
</head>
<body>
  <div class="shell">
    <div class="header">
      <h1>Field Purchase Receipt Pack</h1>
      <p>Generated ${escapeHtml(generatedAt.toLocaleString())}</p>
      <p>${escapeHtml(summary)}</p>
    </div>
    ${groups.map((group, index)=> `
      <section class="receipt-card">
        <div class="receipt-head">
          <div>
            <h2>${escapeHtml(group.vendor || `Field Purchase ${index + 1}`)}</h2>
            <div class="receipt-meta">
              <span class="receipt-chip">When: ${escapeHtml(group.when || 'Unknown')}</span>
              <span class="receipt-chip">Receipt: ${escapeHtml(group.receipt || 'Missing')}</span>
              <span class="receipt-chip">Projects: ${escapeHtml(Array.from(group.projects).join(', ') || 'General')}</span>
              <span class="receipt-chip">Locations: ${escapeHtml(Array.from(group.locations).join(', ') || 'Unspecified')}</span>
              <span class="receipt-chip">Lines: ${escapeHtml(group.lines.length)}</span>
            </div>
          </div>
        </div>
        <table>
          <thead>
            <tr><th>Code</th><th>Name</th><th>Qty</th><th>Project</th><th>Cost</th><th>Notes</th></tr>
          </thead>
          <tbody>
            ${group.lines.map((line)=> `
              <tr>
                <td>${escapeHtml(line.code)}</td>
                <td>${escapeHtml(line.name)}</td>
                <td>${escapeHtml(line.qty)}</td>
                <td>${escapeHtml(line.project)}</td>
                <td>${escapeHtml(line.cost)}</td>
                <td>${escapeHtml(line.notes)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${group.photos.length ? `
          <div class="photos">
            ${group.photos.map((photo)=> `<img src="${photo.dataUrl}" alt="${escapeHtml(photo.name || 'Receipt photo')}">`).join('')}
          </div>
        ` : `
          <div class="empty">No receipt photos attached for this purchase batch.</div>
        `}
      </section>
    `).join('')}
  </div>
</body>
</html>`;
}

function downloadPurchaseCsv(){
  if(!filteredPurchaseRows.length){
    alert('No field purchases match the current filters.');
    return;
  }
  const headers = ['code','name','qty','project','vendor','receipt','receiptPhotos','cost','location','date','timestamp','notes','batchId'];
  const rows = filteredPurchaseRows.map((entry)=>[
    entry?.code || '',
    entry?.name || '',
    entry?.qty || '',
    getPurchaseProjectLabel(entry),
    getPurchaseVendor(entry),
    getPurchaseReceipt(entry),
    getReceiptPhotosFromEntry(entry).length ? 'Yes' : 'No',
    getPurchaseCost(entry) ?? '',
    entry?.location || '',
    formatLocalDateKey(getPurchaseTs(entry)),
    utils.formatDateTime?.(getPurchaseTs(entry)) || '',
    entry?.notes || '',
    getPurchaseBatchId(entry)
  ]);
  const csv = [headers.join(','), ...rows.map((row)=> row.map(csvCell).join(','))].join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `field-purchases-${new Date().toISOString().slice(0, 10)}.csv`);
}

async function downloadReceiptPack(){
  await refreshPurchaseRows();
  if(!filteredPurchaseRows.length){
    alert('No field purchases match the current filters.');
    return;
  }
  const html = buildReceiptPackHtml(filteredPurchaseRows);
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8;' }), `field-purchase-receipts-${new Date().toISOString().slice(0, 10)}.html`);
}

function closeReceiptModal(){
  const modal = document.getElementById('purchaseReceiptModal');
  const gallery = document.getElementById('purchaseReceiptGallery');
  const meta = document.getElementById('purchaseReceiptMeta');
  if(!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  if(gallery) gallery.innerHTML = '';
  if(meta) meta.textContent = '';
  document.body.classList.remove('panel-open');
}

function openReceiptModal(index){
  const entry = filteredPurchaseRows[index];
  const photos = getReceiptPhotosFromEntry(entry);
  if(!entry || !photos.length) return;
  const modal = document.getElementById('purchaseReceiptModal');
  const gallery = document.getElementById('purchaseReceiptGallery');
  const meta = document.getElementById('purchaseReceiptMeta');
  if(!modal || !gallery || !meta) return;
  const vendor = getPurchaseVendor(entry);
  const receipt = getPurchaseReceipt(entry);
  const when = utils.formatDateTime?.(getPurchaseTs(entry)) || '';
  const parts = [
    entry.code || '',
    getPurchaseProjectLabel(entry),
    vendor ? `Vendor: ${vendor}` : '',
    receipt ? `Receipt: ${receipt}` : '',
    when
  ].filter(Boolean);
  meta.textContent = parts.join(' | ');
  gallery.innerHTML = photos.map((photo, photoIndex)=> `
    <div class="receipt-viewer-card">
      <img src="${photo.dataUrl}" alt="Receipt ${photoIndex + 1} for ${escapeHtml(entry.code || 'purchase')}">
      <div class="receipt-viewer-card-head">
        <span>${escapeHtml(photo.name || `Receipt ${photoIndex + 1}`)}</span>
        <a class="receipt-link-btn" href="${photo.dataUrl}" download="${escapeHtml(photo.name || `receipt-${photoIndex + 1}.jpg`)}">Download</a>
      </div>
    </div>
  `).join('');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
}

async function refreshPurchaseRows(){
  const statusEl = document.getElementById('purchaseTableStatus');
  if(statusEl) statusEl.textContent = 'Loading field purchases...';
  try{
    const rows = await utils.fetchJsonSafe('/api/inventory?type=purchase', {}, []) || [];
    purchaseRowsCache = normalizePurchaseRows(rows);
    updatePurchaseProjectFilter(purchaseRowsCache);
    renderPurchaseTable();
  }catch(e){
    purchaseRowsCache = [];
    filteredPurchaseRows = [];
    updatePurchaseProjectFilter([]);
    renderPurchaseTable();
    if(statusEl) statusEl.textContent = 'Unable to load field purchases.';
  }
}

function renderPurchaseTable(){
  const tbody = document.querySelector('#purchaseTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  filteredPurchaseRows = sortPurchaseRows(applyPurchaseFilters(purchaseRowsCache));
  updatePurchaseTableStatus(filteredPurchaseRows, purchaseRowsCache.length);
  if(!filteredPurchaseRows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="7" style="text-align:center;color:#6b7280;">${purchaseRowsCache.length ? 'No field purchases match the current filters.' : 'No field purchases yet'}</td>`;
    tbody.appendChild(tr);
    return;
  }
  filteredPurchaseRows.forEach((entry, index)=>{
    const when = utils.formatDateTime?.(getPurchaseTs(entry)) || '';
    const vendor = getPurchaseVendor(entry);
    const receipt = getPurchaseReceipt(entry);
    const photos = getReceiptPhotosFromEntry(entry);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(entry.code || '')}</td>
      <td>${escapeHtml(entry.name || '')}</td>
      <td>${escapeHtml(entry.qty || '')}</td>
      <td>${escapeHtml(getPurchaseProjectLabel(entry))}</td>
      <td>${escapeHtml(when)}</td>
      <td>${escapeHtml(vendor || '-')}</td>
      <td>
        <div class="receipt-inline-links">
          <span>${escapeHtml(receipt || (photos.length ? 'Receipt photo attached' : '-'))}</span>
          ${photos.length ? `<div class="receipt-link-row"><button type="button" class="receipt-link-btn view-receipt-photo" data-index="${index}">${photos.length === 1 ? 'View photo' : `View ${photos.length} photos`}</button></div>` : ''}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.view-receipt-photo').forEach((button)=>{
    button.addEventListener('click', ()=> openReceiptModal(Number(button.dataset.index || 0)));
  });
}

function refreshItemOptions(){
  const list = document.getElementById('purchase-item-options');
  if(!list) return;
  list.innerHTML = '';
  itemsCache.forEach((item)=>{
    if(!item?.code) return;
    const opt = document.createElement('option');
    opt.value = item.code;
    if(item.name) opt.label = `${item.code} - ${item.name}`;
    list.appendChild(opt);
  });
}

document.addEventListener('keydown', (event)=>{
  if(event.key === 'Escape'){
    closeReceiptModal();
  }
});

document.addEventListener('DOMContentLoaded', async ()=>{
  const bindPurchaseTableControl = (id, eventName, apply)=>{
    const el = document.getElementById(id);
    el?.addEventListener(eventName, ()=>{
      apply(el);
      renderPurchaseTable();
    });
  };
  bindPurchaseTableControl('purchaseFilterSearch', 'input', (el)=>{ purchaseTableState.search = el.value.trim(); });
  bindPurchaseTableControl('purchaseFilterProject', 'change', (el)=>{ purchaseTableState.project = el.value; });
  bindPurchaseTableControl('purchaseFilterVendor', 'input', (el)=>{ purchaseTableState.vendor = el.value.trim(); });
  bindPurchaseTableControl('purchaseFilterReceiptStatus', 'change', (el)=>{ purchaseTableState.receiptStatus = el.value || 'all'; });
  bindPurchaseTableControl('purchaseFilterDateFrom', 'change', (el)=>{ purchaseTableState.dateFrom = el.value || ''; });
  bindPurchaseTableControl('purchaseFilterDateTo', 'change', (el)=>{ purchaseTableState.dateTo = el.value || ''; });
  bindPurchaseTableControl('purchaseSort', 'change', (el)=>{ purchaseTableState.sort = el.value || 'newest'; });
  document.getElementById('purchaseFilterReset')?.addEventListener('click', (event)=>{
    event.preventDefault();
    purchaseTableState.search = '';
    purchaseTableState.project = '';
    purchaseTableState.vendor = '';
    purchaseTableState.receiptStatus = 'all';
    purchaseTableState.dateFrom = '';
    purchaseTableState.dateTo = '';
    purchaseTableState.sort = 'newest';
    document.getElementById('purchaseFilterSearch').value = '';
    document.getElementById('purchaseFilterProject').value = '';
    document.getElementById('purchaseFilterVendor').value = '';
    document.getElementById('purchaseFilterReceiptStatus').value = 'all';
    document.getElementById('purchaseFilterDateFrom').value = '';
    document.getElementById('purchaseFilterDateTo').value = '';
    document.getElementById('purchaseSort').value = 'newest';
    renderPurchaseTable();
  });
  document.getElementById('purchaseDownloadCsv')?.addEventListener('click', (event)=>{
    event.preventDefault();
    downloadPurchaseCsv();
  });
  document.getElementById('purchaseDownloadReceipts')?.addEventListener('click', (event)=>{
    event.preventDefault();
    downloadReceiptPack().catch(()=>{
      alert('Unable to download the receipt pack right now.');
    });
  });

  const addBtn = document.getElementById('purchase-addLine');
  addBtn?.addEventListener('click', addLine);

  const receiptPhotoInput = document.getElementById('purchase-receiptPhotos');
  receiptPhotoInput?.addEventListener('change', handleReceiptPhotoSelection);

  addLine();
  renderReceiptPhotoPreview();

  const receiptModal = document.getElementById('purchaseReceiptModal');
  receiptModal?.addEventListener('click', (event)=>{
    if(event.target === receiptModal) closeReceiptModal();
  });
  document.getElementById('purchaseReceiptClose')?.addEventListener('click', closeReceiptModal);

  const form = document.getElementById('purchaseForm');
  form?.addEventListener('input', invalidatePendingPurchaseBatch);
  form?.addEventListener('change', invalidatePendingPurchaseBatch);
  form?.addEventListener('submit', async (event)=>{
    event.preventDefault();
    if(purchaseSubmitInFlight) return;
    if(receiptPhotoProcessing){
      alert('Receipt photos are still being prepared. Please wait a moment and submit again.');
      return;
    }
    const session = getSession();
    const lines = gatherLines();
    const jobId = document.getElementById('purchase-jobId').value.trim();
    const locationPayload = getInventoryLocationPayload('purchase-location');
    const vendor = document.getElementById('purchase-vendor').value.trim();
    const receipt = document.getElementById('purchase-receipt').value.trim();
    const notes = document.getElementById('purchase-notes').value.trim();
    if(!lines.length){ alert('Add at least one line'); return; }
    const missingName = lines.find((line)=> !itemsCache.find((item)=> item.code === line.code) && !line.name);
    if(missingName){ alert(`Name is required for new item ${missingName.code}`); return; }
    if(!pendingPurchaseBatchId) pendingPurchaseBatchId = `field-purchase-${uid()}`;
    purchaseSubmitInFlight = true;
    syncReceiptPhotoControls();
    try{
      const response = await fetch('/api/field-purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchId: pendingPurchaseBatchId,
          lines,
          jobId,
          ...locationPayload,
          vendor,
          receipt,
          receiptPhotos: receiptPhotos.map((photo)=>({
            name: photo.name,
            type: photo.type,
            sizeBytes: photo.sizeBytes,
            width: photo.width,
            height: photo.height,
            dataUrl: photo.dataUrl
          })),
          notes,
          userEmail: session?.email,
          userName: session?.name
        })
      });
      const data = await response.json().catch(()=>({}));
      if(!response.ok){
        alert(data.error || 'Failed to log purchase');
        return;
      }
      pendingPurchaseBatchId = '';
      form.reset();
      populateInventoryLocationSelect('purchase-location', 'field');
      document.getElementById('purchase-lines').innerHTML = '';
      resetReceiptPhotos();
      addLine();
      await loadItems();
      await refreshPurchaseRows();
      alert(`Logged ${data.count} purchase(s).`);
    }catch(e){
      alert('Failed to log purchase');
    }finally{
      purchaseSubmitInFlight = false;
      syncReceiptPhotoControls();
    }
  });

  const clearBtn = document.getElementById('purchase-clearBtn');
  clearBtn?.addEventListener('click', ()=>{
    if(confirm('Clear all lines?')){
      pendingPurchaseBatchId = '';
      document.getElementById('purchaseForm')?.reset();
      populateInventoryLocationSelect('purchase-location', 'field');
      document.getElementById('purchase-lines').innerHTML = '';
      resetReceiptPhotos();
      addLine();
    }
  });

  await Promise.allSettled([
    loadItems(),
    loadCategories(),
    loadJobs(),
    loadInventoryLocations(),
    refreshPurchaseRows()
  ]);
  populateInventoryLocationSelect('purchase-location', 'field');
});
