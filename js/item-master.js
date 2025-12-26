const FALLBACK = 'N/A';

let currentEditId = null;

async function loadItems(){
  try{
    const r = await fetch('/api/items',{credentials:'include'});
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
  renderTable();
  const searchBox = document.getElementById('searchBox');
  if(searchBox) searchBox.addEventListener('input', renderTable);
  
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
