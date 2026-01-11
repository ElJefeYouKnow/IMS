let itemsCache = [];
let jobOptions = [];
let categoriesCache = [];
const DEFAULT_CATEGORY_NAME = 'Uncategorized';
const SESSION_KEY = 'sessionUser';

function getSession(){
  try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch(e){return null;}
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
  selects.forEach(select=>{
    const wasDisabled = select.disabled;
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
      const def = list.find(c=> c.name === DEFAULT_CATEGORY_NAME);
      select.value = def ? def.name : list[0].name;
    }
    select.disabled = wasDisabled;
  });
}

async function loadJobs(){
  const jobs = await utils.fetchJsonSafe('/api/jobs', {}, []);
  jobOptions = (jobs || []).map(j=> j.code).filter(Boolean).sort();
  const sel = document.getElementById('purchase-jobId');
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">General Inventory</option>';
  jobOptions.forEach(job=>{
    const opt = document.createElement('option');
    opt.value = job;
    opt.textContent = job;
    sel.appendChild(opt);
  });
  if(current) sel.value = current;
}

function addLine(){
  const container = document.getElementById('purchase-lines');
  if(!container) return;
  const id = Math.random().toString(16).slice(2,8);
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
    const val = codeInput?.value.trim().toLowerCase() || '';
    if(!val){
      if(categoryInput) categoryInput.disabled = false;
      return;
    }
    const match = itemsCache.find(i=> (i.code || '').toLowerCase() === val);
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
  const out = [];
  rows.forEach(r=>{
    const code = r.querySelector('input[name="code"]')?.value.trim() || '';
    const name = r.querySelector('input[name="name"]')?.value.trim() || '';
    const category = r.querySelector('select[name="category"]')?.value.trim() || '';
    const qty = parseInt(r.querySelector('input[name="qty"]')?.value || '0', 10) || 0;
    const cost = r.querySelector('input[name="cost"]')?.value;
    if(code && qty > 0){
      out.push({ code, name, category, qty, cost: cost ? Number(cost) : null });
    }
  });
  return out;
}

async function renderPurchaseTable(){
  const tbody = document.querySelector('#purchaseTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const rows = await utils.fetchJsonSafe('/api/inventory?type=purchase', {}, []) || [];
  if(!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" style="text-align:center;color:#6b7280;">No field purchases yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.slice().reverse().slice(0,12).forEach(e=>{
    const when = e.ts ? new Date(e.ts).toLocaleString() : '';
    const vendor = e.sourceMeta?.vendor || '';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${e.code}</td><td>${e.name||''}</td><td>${e.qty}</td><td>${e.jobId||'General'}</td><td>${when}</td><td>${vendor}</td>`;
    tbody.appendChild(tr);
  });
}

function refreshItemOptions(){
  const list = document.getElementById('purchase-item-options');
  if(!list) return;
  list.innerHTML = '';
  itemsCache.forEach(item=>{
    if(!item?.code) return;
    const opt = document.createElement('option');
    opt.value = item.code;
    if(item.name) opt.label = `${item.code} - ${item.name}`;
    list.appendChild(opt);
  });
}

document.addEventListener('DOMContentLoaded', async ()=>{
  await loadItems();
  await loadCategories();
  await loadJobs();
  addLine();
  renderPurchaseTable();

  const addBtn = document.getElementById('purchase-addLine');
  addBtn?.addEventListener('click', addLine);

  const form = document.getElementById('purchaseForm');
  form?.addEventListener('submit', async ev=>{
    ev.preventDefault();
    const session = getSession();
    const lines = gatherLines();
    const jobId = document.getElementById('purchase-jobId').value.trim();
    const location = document.getElementById('purchase-location').value.trim();
    const vendor = document.getElementById('purchase-vendor').value.trim();
    const receipt = document.getElementById('purchase-receipt').value.trim();
    const notes = document.getElementById('purchase-notes').value.trim();
    if(!lines.length){ alert('Add at least one line'); return; }
    const missingName = lines.find(l=> !itemsCache.find(i=> i.code === l.code) && !l.name);
    if(missingName){ alert(`Name is required for new item ${missingName.code}`); return; }
    try{
      const r = await fetch('/api/field-purchase', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ lines, jobId, location, vendor, receipt, notes, userEmail: session?.email, userName: session?.name })
      });
      const data = await r.json().catch(()=>({}));
      if(!r.ok){ alert(data.error || 'Failed to log purchase'); return; }
      form.reset();
      document.getElementById('purchase-lines').innerHTML = '';
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
      document.getElementById('purchase-lines').innerHTML = '';
      addLine();
    }
  });
});
