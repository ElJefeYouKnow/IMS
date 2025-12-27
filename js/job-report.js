async function loadEntries(){
  try{
    const r = await fetch('/api/inventory');
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

function aggregateByJob(entries){
  const jobs = {};
  entries.forEach(e=>{
    const jobId = e.jobId || 'Unassigned';
    const key = `${jobId}|${e.code}`;
    if(!jobs[key]) jobs[key] = { jobId, code: e.code, inQty: 0, outQty: 0, reserveQty: 0 };
    if(e.type === 'in' || e.type === 'return') jobs[key].inQty += e.qty;
    else if(e.type === 'out') jobs[key].outQty += e.qty;
    else if(e.type === 'reserve') jobs[key].reserveQty += e.qty;
    else if(e.type === 'reserve_release') jobs[key].reserveQty -= e.qty;
  });
  return Object.values(jobs).map(j=>({
    ...j, netUsage: j.inQty - j.outQty
  }));
}

async function renderTable(){
  const tbody=document.querySelector('#jobTable tbody');tbody.innerHTML='';
  const entries = await loadEntries();
  let items = aggregateByJob(entries);
  const search = (document.getElementById('searchBox')?.value || '').toLowerCase();
  if(search) items = items.filter(i=> i.jobId.toLowerCase().includes(search));
  items.sort((a,b)=> a.jobId.localeCompare(b.jobId) || a.code.localeCompare(b.code));
  items.forEach(item=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${item.jobId}</td><td>${item.code}</td><td>${item.inQty}</td><td>${item.outQty}</td><td>${item.reserveQty}</td><td>${item.netUsage}</td>`;
    tbody.appendChild(tr);
  });
}

async function exportCSV(){
  const entries = await loadEntries();
  const items = aggregateByJob(entries);
  if(!items.length){alert('No job data to export');return}
  const hdr=['jobId','code','checkedIn','checkedOut','reserved','netUsage'];
  const rows=items.map(r=>[r.jobId,r.code,r.inQty,r.outQty,r.reserveQty,r.netUsage]);
  const csv=[hdr.join(','),...rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='job-report.csv';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded',()=>{
  renderTable();
  const searchBox = document.getElementById('searchBox');
  if(searchBox) searchBox.addEventListener('input', renderTable);
  document.getElementById('exportBtn').addEventListener('click', exportCSV);
});
