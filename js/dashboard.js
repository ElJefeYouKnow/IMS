const FALLBACK = 'N/A';
const LOW_STOCK_THRESHOLD = 5;

function updateClock(){document.getElementById('clock').textContent=new Date().toLocaleString()}

async function loadData(){
  const [items, entries] = await Promise.all([
    utils.fetchJsonSafe('/api/items', {}, []),
    utils.fetchJsonSafe('/api/inventory', {}, [])
  ]);
  return { items: items || [], entries: entries || [] };
}

function buildStock(entries){
  const stock = {};
  entries.forEach(e=>{
    const code = e.code;
    const qty = Number(e.qty)||0;
    if(!stock[code]) stock[code] = { in:0, out:0, reserve:0, ret:0, last:0 };
    if(e.type === 'in') stock[code].in += qty;
    else if(e.type === 'out') stock[code].out += qty;
    else if(e.type === 'reserve') stock[code].reserve += qty;
    else if(e.type === 'return') stock[code].ret += qty;
    stock[code].last = Math.max(stock[code].last, e.ts || 0);
  });
  return stock;
}

function computeMetrics(items, entries){
  const stock = buildStock(entries);
  let availableUnits = 0;
  let reservedUnits = 0;
  Object.values(stock).forEach(s=>{
    availableUnits += s.in + s.ret - s.out - s.reserve;
    reservedUnits += s.reserve;
  });
  const lowStock = items.filter(i=>{
    const s = stock[i.code] || { in:0,out:0,reserve:0,ret:0 };
    const available = s.in + s.ret - s.out - s.reserve;
    return available > 0 && available <= LOW_STOCK_THRESHOLD;
  });
  return { stock, availableUnits, reservedUnits, lowStockCount: lowStock.length };
}

function setValue(id, val){
  const el = document.getElementById(id);
  if(el) el.textContent = val ?? FALLBACK;
}

function renderLowStock(items, stock){
  const tbody = document.querySelector('#lowStockTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const rows = items.map(i=>{
    const s = stock[i.code] || { in:0,out:0,reserve:0,ret:0 };
    const available = s.in + s.ret - s.out - s.reserve;
    return { code: i.code, name: i.name || FALLBACK, available, reserve: s.reserve };
  }).filter(r=> r.available > 0 && r.available <= LOW_STOCK_THRESHOLD);
  if(!rows.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="4" style="text-align:center;color:#6b7280;">No low stock items</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.sort((a,b)=> a.available - b.available);
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
  const label = { in:'Check-In', out:'Check-Out', reserve:'Reserve', return:'Return' };
  recent.forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${label[e.type]||e.type}</td><td>${e.code}</td><td>${e.qty}</td><td>${e.jobId||FALLBACK}</td><td>${new Date(e.ts).toLocaleString()}</td>`;
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
    if(!e.ts) return;
    const d=new Date(e.ts);
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
  const { items, entries } = await loadData();
  const metrics = computeMetrics(items, entries);
  setValue('availableUnits', metrics.availableUnits);
  setValue('reservedUnits', metrics.reservedUnits);
  setValue('lowStockCount', metrics.lowStockCount);
  renderLowStock(items, metrics.stock);
  renderActivity(entries);
  drawChart(entries);
});
