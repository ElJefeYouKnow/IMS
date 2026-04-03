let itemsCache = [];
let jobOptions = [];
let categoriesCache = [];
let inventoryLocationOptions = [];
let recentPurchaseRows = [];
let receiptPhotos = [];
let receiptPhotoProcessing = false;
const DEFAULT_CATEGORY_NAME = 'Uncategorized';
const SESSION_KEY = 'sessionUser';
const MAX_RECEIPT_PHOTOS = 2;
const MAX_RECEIPT_PHOTO_BYTES = 260 * 1024;
const MAX_RECEIPT_TOTAL_BYTES = 520 * 1024;
const MAX_RECEIPT_DIMENSION = 1600;
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
  if(input) input.disabled = receiptPhotoProcessing || receiptPhotos.length >= MAX_RECEIPT_PHOTOS;
  if(submitBtn) submitBtn.disabled = receiptPhotoProcessing;
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
  const raw = entry?.sourceMeta?.receiptPhotos;
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
  const entry = recentPurchaseRows[index];
  const photos = getReceiptPhotosFromEntry(entry);
  if(!entry || !photos.length) return;
  const modal = document.getElementById('purchaseReceiptModal');
  const gallery = document.getElementById('purchaseReceiptGallery');
  const meta = document.getElementById('purchaseReceiptMeta');
  if(!modal || !gallery || !meta) return;
  const vendor = String(entry.sourceMeta?.vendor || '').trim();
  const receipt = String(entry.sourceMeta?.receipt || '').trim();
  const when = utils.formatDateTime?.(entry.ts) || '';
  const parts = [
    entry.code || '',
    entry.jobId || 'General Inventory',
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

async function renderPurchaseTable(){
  const tbody = document.querySelector('#purchaseTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const rows = await utils.fetchJsonSafe('/api/inventory?type=purchase', {}, []) || [];
  recentPurchaseRows = rows.slice().reverse().slice(0, 12);
  if(!recentPurchaseRows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="7" style="text-align:center;color:#6b7280;">No field purchases yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  recentPurchaseRows.forEach((entry, index)=>{
    const when = utils.formatDateTime?.(entry.ts) || '';
    const vendor = String(entry.sourceMeta?.vendor || '').trim();
    const receipt = String(entry.sourceMeta?.receipt || '').trim();
    const photos = getReceiptPhotosFromEntry(entry);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(entry.code || '')}</td>
      <td>${escapeHtml(entry.name || '')}</td>
      <td>${escapeHtml(entry.qty || '')}</td>
      <td>${escapeHtml(entry.jobId || 'General')}</td>
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
  await loadItems();
  await loadCategories();
  await loadJobs();
  await loadInventoryLocations();
  populateInventoryLocationSelect('purchase-location', 'field');
  addLine();
  renderReceiptPhotoPreview();
  renderPurchaseTable();

  const addBtn = document.getElementById('purchase-addLine');
  addBtn?.addEventListener('click', addLine);

  const receiptPhotoInput = document.getElementById('purchase-receiptPhotos');
  receiptPhotoInput?.addEventListener('change', handleReceiptPhotoSelection);

  const receiptModal = document.getElementById('purchaseReceiptModal');
  receiptModal?.addEventListener('click', (event)=>{
    if(event.target === receiptModal) closeReceiptModal();
  });
  document.getElementById('purchaseReceiptClose')?.addEventListener('click', closeReceiptModal);

  const form = document.getElementById('purchaseForm');
  form?.addEventListener('submit', async (event)=>{
    event.preventDefault();
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
    try{
      const response = await fetch('/api/field-purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
      form.reset();
      populateInventoryLocationSelect('purchase-location', 'field');
      document.getElementById('purchase-lines').innerHTML = '';
      resetReceiptPhotos();
      addLine();
      await loadItems();
      await renderPurchaseTable();
      alert(`Logged ${data.count} purchase(s).`);
    }catch(e){
      alert('Failed to log purchase');
    }
  });

  const clearBtn = document.getElementById('purchase-clearBtn');
  clearBtn?.addEventListener('click', ()=>{
    if(confirm('Clear all lines?')){
      document.getElementById('purchaseForm')?.reset();
      populateInventoryLocationSelect('purchase-location', 'field');
      document.getElementById('purchase-lines').innerHTML = '';
      resetReceiptPhotos();
      addLine();
    }
  });
});
