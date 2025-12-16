async function loadReservations(){
  try{
    const r = await fetch('/api/inventory-reserve');
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

async function renderTable(){
  const tbody=document.querySelector('#reserveTable tbody');tbody.innerHTML='';
  const entries = await loadReservations();
  entries.slice().reverse().forEach(e=>{
    const tr=document.createElement('tr');
    const returnDate = e.returnDate ? new Date(e.returnDate).toLocaleDateString() : '—';
    tr.innerHTML=`<td>${e.code}</td><td>${e.jobId}</td><td>${e.qty}</td><td>${returnDate}</td><td>${new Date(e.ts).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
}

async function addReservation(e){
  try{
    const r = await fetch('/api/inventory-reserve',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)
    });
    if(r.ok){
      await renderTable();
      return true;
    }
  }catch(e){}
  return false;
}

async function clearReservations(){
  try{ await fetch('/api/inventory-reserve',{method:'DELETE'}); }catch(e){}
  await renderTable();
}

async function exportCSV(){
  const entries = await loadReservations();
  if(!entries.length){alert('No reservations to export');return}
  const hdr=['code','jobId','qty','returnDate','timestamp'];
  const rows=entries.map(r=>[r.code,r.jobId,r.qty,r.returnDate||'',new Date(r.ts).toISOString()]);
  const csv=[hdr.join(','),...rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='reservations.csv';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded',()=>{
  renderTable();
  const form=document.getElementById('reserveForm');
  form.addEventListener('submit',async ev=>{
    ev.preventDefault();
    const code=document.getElementById('itemCode').value.trim();
    const jobId=document.getElementById('jobId').value.trim();
    const qty=parseInt(document.getElementById('qty').value,10)||0;
    const returnDate=document.getElementById('returnDate').value;
    const notes=document.getElementById('notes').value.trim();
    if(!code||!jobId||qty<=0){alert('Please provide item code, job ID, and quantity');return}
    const ok = await addReservation({code,jobId,qty,returnDate,notes,ts:Date.now(),type:'reserve'});
    if(!ok) alert('Failed to reserve item');
    else{
      form.reset();document.getElementById('qty').value='1';
    }
  });
  document.getElementById('clearBtn').addEventListener('click',async ()=>{if(confirm('Clear all reservations?')) await clearReservations();});
  document.getElementById('exportBtn').addEventListener('click',exportCSV);
});
