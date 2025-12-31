const FALLBACK = 'N/A';

let currentEditId = null;

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
      if(['description','desc','details'].includes(h)) headerMap.set('description', idx);
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
    const description = hasHeader ? getVal('description', headerMap.get('description')) : (cols[4] || '');
    if(!code || !name){
      skipped++;
      continue;
    }
    const unitPrice = unitPriceRaw && !Number.isNaN(Number(unitPriceRaw)) ? Number(unitPriceRaw) : null;
    items.push({ code, name, category, unitPrice, description });
  }
  return { items, skipped };
}

async function loadItems(){
  try{
    const r = await fetch('/api/items',{credentials:'include'});
    if(r.status === 401){ window.location.href='login.html'; return []; }
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

async function renderTable(){
  const tbody=document.querySelector('#itemTable tbody');tbody.innerHTML='';
  const items = await loadItems();
  const search = (document.getElementById('searchBox')?.value || '').toLowerCase();
  let filtered = items;
  if(search) filtered = items.filter(i=> i.code.toLowerCase().includes(search) || i.name.toLowerCase().includes(search));
  filtered.sort((a,b)=> a.code.localeCompare(b.code));
  if(!filtered.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="5" style="text-align:center;color:#6b7280;">No items in catalog</td>`;
    tbody.appendChild(tr);
    return;
  }
  filtered.forEach(item=>{
    const tr=document.createElement('tr');
    const price = item.unitPrice ? `$${parseFloat(item.unitPrice).toFixed(2)}` : FALLBACK;
    tr.innerHTML=`<td>${item.code}</td><td>${item.name}</td><td>${item.category||FALLBACK}</td><td>${price}</td><td><button class="edit-btn" data-code="${item.code}">Edit</button> <button class="delete-btn" data-code="${item.code}" class="muted">Delete</button></td>`;
    tbody.appendChild(tr);
  });
  document.querySelectorAll('.edit-btn').forEach(btn=> btn.addEventListener('click',editItem));
  document.querySelectorAll('.delete-btn').forEach(btn=> btn.addEventListener('click',deleteItem));
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
  currentEditId = code;
  document.getElementById('itemCode').value = item.code;
  document.getElementById('itemCode').disabled = true;
  document.getElementById('itemName').value = item.name;
  document.getElementById('category').value = item.category || '';
  document.getElementById('unitPrice').value = item.unitPrice || '';
  document.getElementById('description').value = item.description || '';
  document.getElementById('addBtn').textContent = 'Update Item';
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
}

document.addEventListener('DOMContentLoaded',()=>{
  if(window.utils){
    if(!utils.requireSession?.()) return;
    utils.requireRole?.('admin');
    utils.wrapFetchWithRole?.();
    utils.applyStoredTheme?.();
    utils.applyNavVisibility?.();
    utils.setupLogout?.();
  }
  // Verify server session is still valid
  fetch('/api/auth/me',{credentials:'include'})
    .then(r=>{ if(r.status===401) window.location.href='login.html'; return r; })
    .catch(()=>{});
  renderTable();
  const searchBox = document.getElementById('searchBox');
  if(searchBox) searchBox.addEventListener('input', renderTable);

  const importBtn = document.getElementById('importBtn');
  const importFile = document.getElementById('importFile');
  const importMsg = document.getElementById('importMsg');
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
      try{
        const r = await fetch('/api/items/bulk', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          credentials:'include',
          body: JSON.stringify({ items })
        });
        const data = await r.json().catch(()=>({}));
        if(!r.ok){
          importMsg.textContent = data.error || 'Import failed';
          importMsg.style.color = '#b91c1c';
          return;
        }
        importMsg.textContent = `Imported ${data.count} items${skipped ? `, skipped ${skipped}` : ''}.`;
        importMsg.style.color = '#15803d';
        await renderTable();
      }catch(e){
        importMsg.textContent = 'Import failed';
        importMsg.style.color = '#b91c1c';
      }
    });
  }

  const downloadBtn = document.getElementById('downloadTemplateBtn');
  if(downloadBtn){
    downloadBtn.addEventListener('click', ()=>{
      const csv = 'code,name,category,unitPrice,description\\n';
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
  
  const form = document.getElementById('itemForm');
  form.addEventListener('submit',async ev=>{
    ev.preventDefault();
    const code = document.getElementById('itemCode').value.trim();
    const name = document.getElementById('itemName').value.trim();
    const category = document.getElementById('category').value.trim();
    const unitPrice = document.getElementById('unitPrice').value;
    const description = document.getElementById('description').value.trim();
    if(!code||!name){alert('Code and name are required');return}
    
    const item = { code, name, category, unitPrice: unitPrice ? parseFloat(unitPrice) : null, description };
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
  
  document.getElementById('clearBtn').addEventListener('click',clearForm);
});
