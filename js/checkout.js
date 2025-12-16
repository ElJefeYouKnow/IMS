let allItems = [];

async function loadCheckouts(){
  try{
    const r = await fetch('/api/inventory?type=out');
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

async function loadItems(){
  try{
    const r = await fetch('/api/items');
    if(r.ok) allItems = await r.json();
  }catch(e){}
}

async function renderTable(){
  const tbody=document.querySelector('#checkoutTable tbody');tbody.innerHTML='';
  const entries = await loadCheckouts();
  entries.slice().reverse().forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${e.code}</td><td>${e.jobId||'—'}</td><td>${e.qty}</td><td>${e.reason||'—'}</td><td>${new Date(e.ts).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
}

async function addCheckout(e){
  try{
    const r = await fetch('/api/inventory-checkout',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)
    });
    if(r.ok){
      await renderTable();
      return true;
    }
  }catch(e){}
  return false;
}

async function clearCheckouts(){
  try{ await fetch('/api/inventory-checkout',{method:'DELETE'}); }catch(e){}
  await renderTable();
}

async function exportCSV(){
  const entries = await loadCheckouts();
  if(!entries.length){alert('No checkout entries to export');return}
  const hdr=['code','jobId','qty','reason','timestamp'];
  const rows=entries.map(r=>[r.code,r.jobId,r.qty,r.reason,new Date(r.ts).toISOString()]);
  const csv=[hdr.join(','),...rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='checkout.csv';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded',async ()=>{
  await loadItems();
  renderTable();
  
  const itemCodeInput = document.getElementById('itemCode');
  const suggestionsDiv = document.getElementById('itemCodeSuggestions');
  
  itemCodeInput.addEventListener('input', ()=>{
    const val = itemCodeInput.value.trim().toLowerCase();
    suggestionsDiv.innerHTML = '';
    if(!val) return;
    const matches = allItems.filter(i=> i.code.toLowerCase().includes(val)).slice(0, 5);
    matches.forEach(item=>{
      const div = document.createElement('div');
      div.textContent = item.code;
      div.style.padding = '8px';
      div.style.cursor = 'pointer';
      div.style.borderBottom = '1px solid #eee';
      div.addEventListener('click', ()=>{
        itemCodeInput.value = item.code;
        document.getElementById('itemName').value = item.name;
        document.getElementById('itemCategory').value = item.category || '';
        document.getElementById('itemUnitPrice').value = item.unitPrice || '';
        suggestionsDiv.innerHTML = '';
      });
      suggestionsDiv.appendChild(div);
    });
  });
  
  const form=document.getElementById('checkoutForm');
  form.addEventListener('submit',async ev=>{
    ev.preventDefault();
    const code=document.getElementById('itemCode').value.trim();
    const jobId=document.getElementById('jobId').value.trim();
    const qty=parseInt(document.getElementById('qty').value,10)||0;
    const reason=document.getElementById('reason').value.trim();
    const notes=document.getElementById('notes').value.trim();
    if(!code||!jobId||!reason||qty<=0){alert('Please provide item code, job ID, reason, and quantity');return}
    const ok = await addCheckout({code,jobId,qty,reason,notes,ts:Date.now(),type:'out'});
    if(!ok) alert('Failed to check out item');
    else{
      form.reset();document.getElementById('qty').value='1';
    }
  });
  document.getElementById('clearBtn').addEventListener('click',async ()=>{if(confirm('Clear all checkout entries?')) await clearCheckouts();});
  document.getElementById('exportBtn').addEventListener('click',exportCSV);
});
