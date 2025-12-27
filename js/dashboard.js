const FALLBACK = 'N/A';
const LOW_STOCK_THRESHOLD = 5;
const RETURN_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

function normalizeJobId(value){
  const val = (value || '').toString().trim();
  if(!val) return '';
  const lowered = val.toLowerCase();
  if(['general','general inventory','none','unassigned'].includes(lowered)) return '';
  return val;
}

function updateClock(){document.getElementById('clock').textContent=new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
function fmtDT(val){ return (window.utils && utils.formatDateTime) ? utils.formatDateTime(val) : (val ? new Date(val).toLocaleString() : ''); }

function setValue(id, val){
  const el = document.getElementById(id);
  if(el) el.textContent = val ?? FALLBACK;
}

function renderLowStock(items){
  const tbody = document.querySelector('#lowStockTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const rows = (items||[]);
  if(!rows.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="4" style="text-align:center;color:#6b7280;">No low stock items</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.slice(0,8).forEach(r=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${r.code}</td><td>${r.name}</td><td>${r.available}</td><td>${r.reserve||0}</td>`;
    tbody.appendChild(tr);
  });
}

function renderActivity(entries){
  const tbody = document.querySelector('#activityTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const recent = entries.slice().sort((a,b)=> (b.ts||0) - (a.ts||0)).slice(0,8);
  if(!recent.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="5" style="text-align:center;color:#6b7280;">No activity recorded yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  const label = { in:'Check-In', out:'Check-Out', reserve:'Reserve', return:'Return', purchase:'Field Purchase', ordered:'Ordered' };
  recent.forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${label[e.type]||e.type}</td><td>${e.code}</td><td>${e.qty}</td><td>${e.jobId||FALLBACK}</td><td>${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
}

function renderOverdue(entries){
  const tbody = document.querySelector('#overdueTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const now = Date.now();
  const overdue = (entries||[]).filter(e=> e.type==='out' && e.ts && (now - Number(utils.parseTs?.(e.ts) || e.ts)) > RETURN_WINDOW_MS);
  const top = overdue.sort((a,b)=> (a.ts||0)-(b.ts||0)).slice(0,8);
  if(!top.length){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#6b7280;">None overdue</td></tr>`;
    return;
  }
  top.forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${e.code}</td><td>${e.qty}</td><td>${e.jobId||'—'}</td><td>${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
}

function renderOrdered(entries){
  const tbody = document.querySelector('#orderedTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const orders = (entries||[]).filter(e=> e.type==='ordered');
  const checkins = (entries||[]).filter(e=> e.type==='in');
  const map = new Map();
  orders.forEach(o=>{
    const sourceId = o.sourceId || o.id;
    const jobId = normalizeJobId(o.jobId || '');
    const key = sourceId;
    if(!map.has(key)) map.set(key, { sourceId, code: o.code, jobId, ordered: 0, checkedIn: 0, eta: o.eta || '', lastOrderTs: 0 });
    const rec = map.get(key);
    rec.ordered += Number(o.qty || 0);
    rec.lastOrderTs = Math.max(rec.lastOrderTs, o.ts || 0);
    if(!rec.eta && o.eta) rec.eta = o.eta;
  });
  checkins.forEach(ci=>{
    if(!ci.sourceId) return;
    const key = ci.sourceId;
    if(!map.has(key)) return;
    const rec = map.get(key);
    rec.checkedIn += Number(ci.qty || 0);
  });
  const openOrders = [];
  map.forEach(rec=>{
    const openQty = Math.max(0, rec.ordered - rec.checkedIn);
    if(openQty <= 0) return;
    openOrders.push({ ...rec, openQty });
  });
  const top = openOrders.sort((a,b)=>{
    const aEta = utils.parseTs?.(a.eta) ?? utils.parseTs?.(a.lastOrderTs) ?? 0;
    const bEta = utils.parseTs?.(b.eta) ?? utils.parseTs?.(b.lastOrderTs) ?? 0;
    return aEta - bEta;
  }).slice(0,8);
  if(!top.length){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#6b7280;">No inbound orders</td></tr>`;
    return;
  }
  top.forEach(e=>{
    const eta = e.eta ? fmtDT(e.eta) : (e.lastOrderTs ? fmtDT(e.lastOrderTs) : '');
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${e.code}</td><td>${e.openQty}</td><td>${eta || FALLBACK}</td><td>${e.jobId||FALLBACK}</td>`;
    tbody.appendChild(tr);
  });
}

function drawChart(entries){
  const canvas=document.getElementById('trafficChart');
  if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const days=Array.from({length:7}).map((_,i)=>{
    const d=new Date(); d.setDate(d.getDate()-(6-i));
    const key=d.toDateString();
    return { label:`${d.getMonth()+1}/${d.getDate()}`, key, total:0 };
  });
  entries.forEach(e=>{
    const ts = e.ts || utils?.parseTs?.(e.ts);
    if(!ts) return;
    const d=new Date(ts);
    const key=d.toDateString();
    const bucket=days.find(day=> day.key===key);
    if(bucket) bucket.total += 1;
  });
  const w=canvas.width, h=canvas.height; ctx.clearRect(0,0,w,h);
  const pad=24;
  const max=Math.max(1,...days.map(d=>d.total));
  const step=(w-2*pad)/(days.length-1);
  ctx.strokeStyle='#4f46e5'; ctx.lineWidth=2; ctx.beginPath();
  days.forEach((d,i)=>{
    const x=pad+i*step;
    const y=h-pad-(d.total/max)*(h-2*pad);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
  ctx.fillStyle='rgba(79,70,229,0.08)';
  ctx.lineTo(w-pad,h-pad); ctx.lineTo(pad,h-pad); ctx.closePath(); ctx.fill();
  ctx.fillStyle='#6b7280'; ctx.font='12px sans-serif'; ctx.textAlign='center';
  days.forEach((d,i)=>{
    const x=pad+i*step; const y=h-8;
    ctx.fillText(d.label,x,y);
  });
}

document.addEventListener('DOMContentLoaded',async ()=>{
  updateClock(); setInterval(updateClock,1000);
  const metrics = await utils.fetchJsonSafe('/api/metrics', {}, {availableUnits:'N/A',reservedUnits:'N/A',lowStockCount:'N/A',activeJobs:'N/A',txLast7:'N/A'});
  setValue('availableUnits', metrics.availableUnits);
  setValue('reservedUnits', metrics.reservedUnits);
  setValue('lowStockCount', metrics.lowStockCount);
  setValue('activeJobs', metrics.activeJobs);
  setValue('txLast7', metrics.txLast7);
  const [lowStock, activity, inventory] = await Promise.all([
    utils.fetchJsonSafe('/api/low-stock', {}, []),
    utils.fetchJsonSafe('/api/recent-activity?limit=12', {}, []),
    utils.fetchJsonSafe('/api/inventory', {}, [])
  ]);
  renderLowStock(lowStock || [], {});
  renderActivity(activity || []);
  drawChart(activity || []);
  renderOverdue(inventory || []);
  renderOrdered(inventory || []);
  if(window.utils && utils.setupLogout) utils.setupLogout();
});
