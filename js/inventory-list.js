const FALLBACK = 'N/A';

async function loadEntries(){
  try{
    const r = await fetch('/api/inventory');
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

function normalizeJobId(value){
  const val = (value || '').toString().trim();
  if(!val) return '';
  const lowered = val.toLowerCase();
  if(['general','general inventory','none','unassigned'].includes(lowered)) return '';
  return val;
}

function buildOrderBalance(orders, inventory){
  const map = new Map();
  (orders||[]).forEach(o=>{
    const jobId = normalizeJobId(o.jobId || o.jobid || '');
    const key = `${o.code}|${jobId}`;
    if(!map.has(key)) map.set(key, { code: o.code, jobId, name: o.name || '', ordered: 0, checkedIn: 0, eta: o.eta || '', lastOrderTs: 0 });
    const rec = map.get(key);
    rec.ordered += Number(o.qty || 0);
    rec.lastOrderTs = Math.max(rec.lastOrderTs, o.ts || 0);
    if(!rec.eta && o.eta) rec.eta = o.eta;
  });
  (inventory||[]).filter(e=> e.type === 'in').forEach(ci=>{
    const jobId = normalizeJobId(ci.jobId || '');
    const key = `${ci.code}|${jobId}`;
    if(!map.has(key)) map.set(key, { code: ci.code, jobId, name: ci.name || '', ordered: 0, checkedIn: 0, eta: '', lastOrderTs: 0 });
    const rec = map.get(key);
    rec.checkedIn += Number(ci.qty || 0);
  });
  return map;
}

function aggregateStock(entries){
  const stock = {};
  entries.forEach(e=>{
    if(!stock[e.code]) stock[e.code] = { code: e.code, name: e.name || '', inQty: 0, outQty: 0, reserveQty: 0, lastTs: 0, jobs: new Map() };
    if(e.type === 'in' || e.type === 'return') stock[e.code].inQty += e.qty;
    else if(e.type === 'reserve_release') stock[e.code].reserveQty -= e.qty;
    else if(e.type === 'out') stock[e.code].outQty += e.qty;
    else if(e.type === 'reserve') stock[e.code].reserveQty += e.qty;
    else if(e.type === 'reserve_release') stock[e.code].reserveQty -= e.qty;
    if(e.jobId){
      if(!stock[e.code].jobs.has(e.jobId)) stock[e.code].jobs.set(e.jobId, { out: 0, reserve: 0 });
      const job = stock[e.code].jobs.get(e.jobId);
      if(e.type === 'out') job.out += e.qty;
      else if(e.type === 'return') job.out -= e.qty;
      else if(e.type === 'reserve') job.reserve += e.qty;
      else if(e.type === 'reserve_release') job.reserve -= e.qty;
    }
    stock[e.code].lastTs = Math.max(stock[e.code].lastTs, e.ts || 0);
  });
  return Object.values(stock).map(s=>{
    const activeJobs = [];
    for (const [jobId, stats] of s.jobs.entries()) {
      if ((stats.out || 0) > 0 || (stats.reserve || 0) > 0) activeJobs.push(jobId);
    }
    return {
      ...s,
      jobsList: activeJobs.length ? activeJobs.sort().join(', ') : FALLBACK,
      current: s.inQty - s.outQty - s.reserveQty,
      available: s.inQty - s.outQty,
      lastDate: s.lastTs ? new Date(s.lastTs).toLocaleString() : FALLBACK
    };
  });
}

async function renderProjectSummary(){
  const tbody = document.querySelector('#jobSummaryTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const [inventory, orders] = await Promise.all([
    loadEntries(),
    utils.fetchJsonSafe('/api/inventory?type=ordered', {}, [])
  ]);
  const balances = buildOrderBalance(orders, inventory);
  const summary = {};

  balances.forEach((rec)=>{
    const jobId = normalizeJobId(rec.jobId || '');
    const openQty = Math.max(0, rec.ordered - rec.checkedIn);
    if(!jobId || openQty <= 0) return;
    const key = `${jobId}|${rec.code}`;
    if(!summary[key]) summary[key] = { jobId, code: rec.code, openOrders: 0, inQty: 0, outQty: 0, returnQty: 0, reserveQty: 0, lastTs: 0 };
    summary[key].openOrders += openQty;
    summary[key].lastTs = Math.max(summary[key].lastTs, rec.lastOrderTs || 0);
  });

  (inventory||[]).forEach(e=>{
    const jobId = normalizeJobId(e.jobId || '');
    if(!jobId) return;
    const key = `${jobId}|${e.code}`;
    if(!summary[key]) summary[key] = { jobId, code: e.code, openOrders: 0, inQty: 0, outQty: 0, returnQty: 0, reserveQty: 0, lastTs: 0 };
    if(e.type === 'in') summary[key].inQty += e.qty;
    else if(e.type === 'out') summary[key].outQty += e.qty;
    else if(e.type === 'return') summary[key].returnQty += e.qty;
    else if(e.type === 'reserve') summary[key].reserveQty += e.qty;
    else if(e.type === 'reserve_release') summary[key].reserveQty -= e.qty;
    summary[key].lastTs = Math.max(summary[key].lastTs, e.ts || 0);
  });

  const searchVal = (document.getElementById('jobSummarySearch')?.value || '').trim().toLowerCase();
  let items = Object.values(summary).map(s=>{
    const checkedOut = Math.max(0, s.outQty - s.returnQty);
    const reserved = Math.max(0, s.reserveQty);
    const available = Math.max(0, s.inQty - checkedOut - reserved);
    return {
      ...s,
      checkedOut,
      reserved,
      available,
      lastDate: s.lastTs ? ((window.utils && utils.formatDateTime) ? utils.formatDateTime(s.lastTs) : new Date(s.lastTs).toLocaleString()) : FALLBACK
    };
  });

  if(searchVal){
    items = items.filter(i=> i.jobId.toLowerCase().includes(searchVal) || i.code.toLowerCase().includes(searchVal));
  }
  items.sort((a,b)=> a.jobId.localeCompare(b.jobId) || a.code.localeCompare(b.code));
  if(!items.length){
    const tr=document.createElement('tr');
    tr.innerHTML = `<td colspan="8" style="text-align:center;color:#6b7280;">No project inventory yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  items.forEach(item=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${item.jobId}</td><td>${item.code}</td><td>${item.openOrders}</td><td>${item.inQty}</td><td>${item.reserved}</td><td>${item.checkedOut}</td><td>${item.available}</td><td>${item.lastDate}</td>`;
    tbody.appendChild(tr);
  });
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
    tr.innerHTML=`<td>${item.code}</td><td>${item.name}</td><td>${item.jobsList}</td><td>${item.inQty}</td><td>${item.outQty}</td><td>${item.reserveQty}</td><td>${item.current}</td><td>${item.lastDate}</td>`;
    tbody.appendChild(tr);
  });
}

async function renderIncoming(){
  const tbody = document.querySelector('#incomingTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const [orders, inventory] = await Promise.all([
    utils.fetchJsonSafe('/api/inventory?type=ordered', {}, []),
    utils.fetchJsonSafe('/api/inventory', {}, [])
  ]);
  const balances = buildOrderBalance(orders, inventory);
  const search = (document.getElementById('incomingSearchBox')?.value || '').toLowerCase();
  const rows = [];
  balances.forEach((rec)=>{
    const openQty = Math.max(0, rec.ordered - rec.checkedIn);
    if(openQty <= 0) return;
    const job = normalizeJobId(rec.jobId || '').toLowerCase();
    const code = (rec.code || '').toLowerCase();
    if(search && !(code.includes(search) || job.includes(search))) return;
    rows.push({ ...rec, openQty });
  });
  if(!rows.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:#6b7280;">No incoming inventory</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.sort((a,b)=> (b.lastOrderTs||0)-(a.lastOrderTs||0));
  rows.slice(0,20).forEach(o=>{
    const job = o.jobId || '';
    const eta = o.eta || '';
    const orderedOn = (window.utils && utils.formatDateTime) ? utils.formatDateTime(o.lastOrderTs) : (o.lastOrderTs ? new Date(o.lastOrderTs).toLocaleString() : '');
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${o.code}</td><td>${o.name||''}</td><td>${o.openQty}</td><td>${job||'General'}</td><td>${eta||FALLBACK}</td><td>${orderedOn||FALLBACK}</td>`;
    tbody.appendChild(tr);
  });
}


document.addEventListener('DOMContentLoaded',async ()=>{
  renderTable();
  const searchBox = document.getElementById('searchBox');
  if(searchBox) searchBox.addEventListener('input', renderTable);
  renderIncoming();
  const incomingSearchBox = document.getElementById('incomingSearchBox');
  if(incomingSearchBox) incomingSearchBox.addEventListener('input', renderIncoming);

  renderProjectSummary();
  const jobSummarySearch = document.getElementById('jobSummarySearch');
  if(jobSummarySearch) jobSummarySearch.addEventListener('input', renderProjectSummary);
});
