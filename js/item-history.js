const SESSION_KEY = 'sessionUser';

function getSession(){
  try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch(e){return null;}
}

function typeLabel(t){
  if(t==='in') return 'Check-In';
  if(t==='out') return 'Check-Out';
  if(t==='reserve') return 'Reserve';
  if(t==='reserve_release') return 'Reserve Release';
  if(t==='return') return 'Return';
  if(t==='ordered') return 'Ordered';
  if(t==='purchase') return 'Field Purchase';
  return t;
}

async function loadEntries(){
  try{
    const r = await fetch('/api/inventory');
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

async function renderTable(){
  const tbody=document.querySelector('#historyTable tbody');tbody.innerHTML='';
  const entries = await loadEntries();
  const search = (document.getElementById('histSearch').value||'').toLowerCase();
  const type = document.getElementById('histType').value;
  let rows = entries.slice().sort((a,b)=> (b.ts||0)-(a.ts||0));
  if(search){
    rows = rows.filter(e=> (e.code||'').toLowerCase().includes(search) || (e.jobId||'').toLowerCase().includes(search));
  }
  if(type){
    rows = rows.filter(e=> e.type === type);
  }
  if(!rows.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="8" style="text-align:center;color:#6b7280;">No history found</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.forEach(e=>{
    const tr=document.createElement('tr');
    const user = e.userName ? `${e.userName} (${e.userEmail||''})` : (e.userEmail||'');
    const when = e.ts ? new Date(e.ts).toLocaleString() : '';
    const notes = e.notes || e.reason || e.location || '';
    tr.innerHTML=`<td>${typeLabel(e.type)}</td><td>${e.status||''}</td><td>${e.code}</td><td>${e.qty}</td><td>${e.jobId||''}</td><td>${user}</td><td>${when}</td><td>${notes}</td>`;
    tbody.appendChild(tr);
  });
}

document.addEventListener('DOMContentLoaded', ()=>{
  const session = getSession();
  // Soft guard: show page but note admin intended (server is not enforcing)
  renderTable();
  document.getElementById('histSearch').addEventListener('input', renderTable);
  document.getElementById('histType').addEventListener('change', renderTable);
});
