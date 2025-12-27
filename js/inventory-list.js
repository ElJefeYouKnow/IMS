const FALLBACK = 'N/A';

async function loadEntries(){
  try{
    const r = await fetch('/api/inventory');
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

function aggregateStock(entries){
  const stock = {};
  entries.forEach(e=>{
    if(!stock[e.code]) stock[e.code] = { code: e.code, name: e.name || '', inQty: 0, outQty: 0, reserveQty: 0, lastTs: 0 };
    if(e.type === 'in' || e.type === 'return') stock[e.code].inQty += e.qty;
    else if(e.type === 'out') stock[e.code].outQty += e.qty;
    else if(e.type === 'reserve') stock[e.code].reserveQty += e.qty;
    stock[e.code].lastTs = Math.max(stock[e.code].lastTs, e.ts || 0);
  });
  return Object.values(stock).map(s=>({
    ...s, current: s.inQty - s.outQty - s.reserveQty, available: s.inQty - s.outQty, lastDate: s.lastTs ? new Date(s.lastTs).toLocaleString() : FALLBACK
  }));
}

async function renderTable(){
  const tbody=document.querySelector('#invTable tbody');tbody.innerHTML='';
  const entries = await loadEntries();
  let items = aggregateStock(entries);
  const search = (document.getElementById('searchBox')?.value || '').toLowerCase();
  if(search) items = items.filter(i=> i.code.toLowerCase().includes(search) || i.name.toLowerCase().includes(search));
  items.sort((a,b)=> a.code.localeCompare(b.code));
  if(!items.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="7" style="text-align:center;color:#6b7280;">No inventory activity yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  items.forEach(item=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${item.code}</td><td>${item.name}</td><td>${item.inQty}</td><td>${item.outQty}</td><td>${item.reserveQty}</td><td>${item.current}</td><td>${item.lastDate}</td>`;
    tbody.appendChild(tr);
  });
}

document.addEventListener('DOMContentLoaded',async ()=>{
  renderTable();
  const searchBox = document.getElementById('searchBox');
  if(searchBox) searchBox.addEventListener('input', renderTable);
  
  const jobSearchBox = document.getElementById('jobSearchBox');
  jobSearchBox.addEventListener('input', async ()=>{
    const jobId = jobSearchBox.value.trim().toLowerCase();
    const tbody = document.querySelector('#jobTransactionTable tbody');
    tbody.innerHTML = '';
    if(!jobId) return;
    
    const entries = await loadEntries();
    const jobEntries = entries.filter(e=> e.jobId && e.jobId.toLowerCase().includes(jobId)).sort((a,b)=> b.ts - a.ts);
    if(!jobEntries.length){
      const tr=document.createElement('tr');
      tr.innerHTML = `<td colspan="7" style="text-align:center;color:#6b7280;">No transactions for this job</td>`;
      tbody.appendChild(tr);
      return;
    }
    jobEntries.forEach(e=>{
      const tr = document.createElement('tr');
      const typeLabel = e.type === 'in' ? 'Check-In' : e.type === 'out' ? 'Check-Out' : e.type === 'return' ? 'Return' : 'Reserve';
      tr.innerHTML = `<td>${typeLabel}</td><td>${e.code}</td><td>${e.qty}</td><td>${e.location||e.returnDate||FALLBACK}</td><td>${e.reason||FALLBACK}</td><td>${e.notes||FALLBACK}</td><td>${new Date(e.ts).toLocaleString()}</td>`;
      tbody.appendChild(tr);
    });
  });
  
  const jobSummarySearch = document.getElementById('jobSummarySearch');
  jobSummarySearch.addEventListener('input', async ()=>{
    const searchVal = jobSummarySearch.value.trim().toLowerCase();
    const tbody = document.querySelector('#jobSummaryTable tbody');
    tbody.innerHTML = '';
    
    const entries = await loadEntries();
    const jobs = {};
    entries.forEach(e=>{
      const jobId = e.jobId || 'Unassigned';
      const key = `${jobId}|${e.code}`;
      if(!jobs[key]) jobs[key] = { jobId, code: e.code, inQty: 0, outQty: 0, reserveQty: 0 };
      if(e.type === 'in' || e.type === 'return') jobs[key].inQty += e.qty;
      else if(e.type === 'out') jobs[key].outQty += e.qty;
      else if(e.type === 'reserve') jobs[key].reserveQty += e.qty;
    });
    
    let items = Object.values(jobs).map(j=>({
      ...j, netUsage: j.inQty - j.outQty
    }));
    
    if(searchVal) items = items.filter(i=> i.jobId.toLowerCase().includes(searchVal));
    items.sort((a,b)=> a.jobId.localeCompare(b.jobId) || a.code.localeCompare(b.code));
    if(!items.length){
      const tr=document.createElement('tr');
      tr.innerHTML = `<td colspan="6" style="text-align:center;color:#6b7280;">No job summaries yet</td>`;
      tbody.appendChild(tr);
      return;
    }
    items.forEach(item=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${item.jobId}</td><td>${item.code}</td><td>${item.inQty}</td><td>${item.outQty}</td><td>${item.reserveQty}</td><td>${item.netUsage}</td>`;
      tbody.appendChild(tr);
    });
  });
});
