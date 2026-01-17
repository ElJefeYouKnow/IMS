const FALLBACK = 'N/A';
const COUNT_STALE_DAYS = 30;
const MOVES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MOVE_TYPES = new Set(['in', 'out', 'return', 'reserve', 'reserve_release', 'purchase', 'consume']);

function normalizeJobId(value){
  const val = (value || '').toString().trim();
  if(!val) return '';
  const lowered = val.toLowerCase();
  if(['general','general inventory','none','unassigned'].includes(lowered)) return '';
  return val;
}

function getEntryJobId(entry){
  return normalizeJobId(entry?.jobId || entry?.jobid || '');
}

function updateClock(){
  const clock = document.getElementById('clock');
  if(clock) clock.textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

function parseTs(val){
  if(window.utils?.parseTs) return utils.parseTs(val);
  if(val === undefined || val === null) return null;
  if(typeof val === 'number') return val;
  const ts = Date.parse(val);
  return Number.isNaN(ts) ? null : ts;
}

function fmtDT(val){
  if(window.utils?.formatDateTime) return utils.formatDateTime(val);
  if(!val) return '';
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function fmtDate(val){
  if(window.utils?.formatDateOnly) return utils.formatDateOnly(val);
  if(!val) return '';
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { year:'numeric', month:'short', day:'2-digit' });
}

function setValue(id, val){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = val ?? FALLBACK;
}

function renderLowStock(items){
  const tbody = document.querySelector('#lowStockTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const rows = (items || []);
  if(!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" style="text-align:center;color:#6b7280;">No low stock items</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.slice(0, 8).forEach(r=>{
    const tr = document.createElement('tr');
    const reserve = r.reserve ?? r.reserved ?? 0;
    tr.innerHTML = `<td>${r.code}</td><td>${r.name}</td><td>${r.available}</td><td>${reserve}</td>`;
    tbody.appendChild(tr);
  });
}

function renderActivity(entries){
  const tbody = document.querySelector('#activityTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const recent = (entries || []).slice().sort((a,b)=> (parseTs(b.ts) || 0) - (parseTs(a.ts) || 0)).slice(0, 8);
  if(!recent.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" style="text-align:center;color:#6b7280;">No activity recorded yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  const label = {
    in: 'Check-In',
    out: 'Check-Out',
    reserve: 'Reserve',
    reserve_release: 'Reserve Release',
    return: 'Return',
    purchase: 'Field Purchase',
    ordered: 'Ordered',
    consume: 'Consumed'
  };
  recent.forEach(e=>{
    const jobId = getEntryJobId(e);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label[e.type] || e.type}</td><td>${e.code}</td><td>${e.qty}</td><td>${jobId || 'General'}</td><td>${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
}

function buildOrderBalance(orders, inventory){
  const map = new Map();
  (orders || []).forEach(o=>{
    const sourceId = o.sourceId || o.id;
    if(!sourceId) return;
    const jobId = normalizeJobId(o.jobId || o.jobid || '');
    const key = sourceId;
    if(!map.has(key)) map.set(key, { sourceId, code: o.code, jobId, name: o.name || '', ordered: 0, checkedIn: 0, eta: o.eta || '', lastOrderTs: 0 });
    const rec = map.get(key);
    rec.ordered += Number(o.qty || 0);
    rec.lastOrderTs = Math.max(rec.lastOrderTs, parseTs(o.ts) || 0);
    if(!rec.eta && o.eta) rec.eta = o.eta;
  });
  (inventory || []).filter(e=> e.type === 'in' && e.sourceId).forEach(ci=>{
    const key = ci.sourceId;
    if(!map.has(key)) return;
    const rec = map.get(key);
    rec.checkedIn += Number(ci.qty || 0);
  });
  const unlinked = (inventory || []).filter(e=> e.type === 'in' && !e.sourceId);
  unlinked.forEach(ci=>{
    const code = ci.code;
    if(!code) return;
    const jobId = getEntryJobId(ci);
    let qtyLeft = Number(ci.qty || 0);
    if(qtyLeft <= 0) return;
    const candidates = Array.from(map.values())
      .filter(r=> r.code === code && (r.jobId || '') === (jobId || ''))
      .sort((a,b)=> (a.lastOrderTs || 0) - (b.lastOrderTs || 0));
    candidates.forEach(rec=>{
      if(qtyLeft <= 0) return;
      const open = Math.max(0, rec.ordered - rec.checkedIn);
      if(open <= 0) return;
      const useQty = Math.min(open, qtyLeft);
      rec.checkedIn += useQty;
      qtyLeft -= useQty;
    });
  });
  return map;
}

function buildOpenOrders(orders, inventory){
  const balances = buildOrderBalance(orders, inventory);
  const rows = [];
  balances.forEach(rec=>{
    const openQty = Math.max(0, rec.ordered - rec.checkedIn);
    if(openQty <= 0) return;
    rows.push({ ...rec, openQty });
  });
  return rows;
}

function renderOrdered(openOrders){
  const tbody = document.querySelector('#orderedTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const rows = (openOrders || []);
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#6b7280;">No inbound orders</td></tr>`;
    return;
  }
  const top = rows.sort((a,b)=>{
    const aEta = parseTs(a.eta) ?? parseTs(a.lastOrderTs) ?? 0;
    const bEta = parseTs(b.eta) ?? parseTs(b.lastOrderTs) ?? 0;
    return aEta - bEta;
  }).slice(0, 8);
  top.forEach(e=>{
    const eta = e.eta ? fmtDT(e.eta) : (e.lastOrderTs ? fmtDT(e.lastOrderTs) : '');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${e.code}</td><td>${e.openQty}</td><td>${eta || FALLBACK}</td><td>${e.jobId || FALLBACK}</td>`;
    tbody.appendChild(tr);
  });
}

function aggregateStock(entries){
  const map = new Map();
  (entries || []).forEach(e=>{
    if(!e.code) return;
    if(!map.has(e.code)){
      map.set(e.code, { code: e.code, name: e.name || '', inQty: 0, outQty: 0, returnQty: 0, reserveQty: 0 });
    }
    const item = map.get(e.code);
    if(!item.name && e.name) item.name = e.name;
    const qty = Number(e.qty) || 0;
    if(e.type === 'in' || e.type === 'return') item.inQty += qty;
    if(e.type === 'out') item.outQty += qty;
    if(e.type === 'return') item.returnQty += qty;
    if(e.type === 'reserve') item.reserveQty += qty;
    if(e.type === 'reserve_release') item.reserveQty -= qty;
  });
  const list = [];
  const totals = { available: 0, reserved: 0, checkedOut: 0 };
  map.forEach(item=>{
    const checkedOut = Math.max(0, item.outQty - item.returnQty);
    const available = Math.max(0, item.inQty - item.outQty - item.reserveQty);
    const reserved = Math.max(0, item.reserveQty);
    const record = { ...item, checkedOut, available, reserveQty: reserved };
    totals.available += available;
    totals.reserved += reserved;
    totals.checkedOut += checkedOut;
    list.push(record);
  });
  const byCode = new Map(list.map(item=> [item.code, item]));
  return { list, byCode, totals };
}

function buildOverdueRows(entries){
  const map = new Map();
  (entries || []).forEach(e=>{
    if(e.type !== 'out' && e.type !== 'return') return;
    if(!e.code) return;
    const jobId = getEntryJobId(e);
    const key = `${e.code}|${jobId}`;
    const rec = map.get(key) || { code: e.code, jobId, out: 0, ret: 0, minDue: null, lastOutTs: 0 };
    const qty = Number(e.qty) || 0;
    if(e.type === 'out'){
      rec.out += qty;
      rec.lastOutTs = Math.max(rec.lastOutTs, parseTs(e.ts) || 0);
      const due = parseTs(e.returnDate);
      if(due){
        rec.minDue = rec.minDue ? Math.min(rec.minDue, due) : due;
      }
    }else if(e.type === 'return'){
      rec.ret += qty;
    }
    map.set(key, rec);
  });
  const now = Date.now();
  const rows = [];
  map.forEach(rec=>{
    const outstanding = Math.max(0, rec.out - rec.ret);
    if(outstanding <= 0) return;
    if(!rec.minDue || rec.minDue >= now) return;
    const daysLate = Math.floor((now - rec.minDue) / (24 * 60 * 60 * 1000));
    rows.push({ ...rec, outstanding, daysLate });
  });
  return rows;
}

function renderOverdue(rows){
  const tbody = document.querySelector('#overdueTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#6b7280;">None overdue</td></tr>`;
    return;
  }
  rows.sort((a,b)=> b.daysLate - a.daysLate);
  rows.slice(0, 8).forEach(e=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${e.code}</td><td>${e.outstanding}</td><td>${e.jobId || 'General'}</td><td>${e.lastOutTs ? fmtDT(e.lastOutTs) : FALLBACK}</td>`;
    tbody.appendChild(tr);
  });
}

function buildTopMovers(entries, itemMap, stockByCode){
  const cutoff = Date.now() - MOVES_WINDOW_MS;
  const map = new Map();
  (entries || []).forEach(e=>{
    const ts = parseTs(e.ts);
    if(!ts || ts < cutoff) return;
    if(!MOVE_TYPES.has(e.type)) return;
    if(!e.code) return;
    const qty = Math.abs(Number(e.qty) || 0);
    if(!qty) return;
    const rec = map.get(e.code) || { code: e.code, name: e.name || '', moves: 0, inUse: 0 };
    rec.moves += qty;
    if(!rec.name && e.name) rec.name = e.name;
    map.set(e.code, rec);
  });
  const rows = Array.from(map.values());
  rows.forEach(row=>{
    const meta = itemMap.get(row.code);
    if(meta?.name) row.name = meta.name;
    row.inUse = stockByCode.get(row.code)?.checkedOut || 0;
  });
  rows.sort((a,b)=> b.moves - a.moves);
  return rows.slice(0, 8);
}

function renderTopMovers(rows){
  const tbody = document.querySelector('#topMoversTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#6b7280;">No movement in the last 7 days</td></tr>`;
    return;
  }
  rows.forEach(row=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.code}</td><td>${row.name || FALLBACK}</td><td>${row.moves}</td><td>${row.inUse}</td>`;
    tbody.appendChild(tr);
  });
}

function buildCountDueRows(items, counts){
  const countMap = new Map();
  (counts || []).forEach(row=>{
    if(!row?.code) return;
    const ts = parseTs(row.countedAt || row.countedat || row.ts || row.counted_at || null);
    countMap.set(row.code, { ts });
  });
  const now = Date.now();
  const rows = [];
  (items || []).forEach(item=>{
    if(!item?.code) return;
    const count = countMap.get(item.code);
    const ts = count?.ts || null;
    const daysSince = ts ? Math.floor((now - ts) / (24 * 60 * 60 * 1000)) : null;
    if(!ts || daysSince > COUNT_STALE_DAYS){
      rows.push({ code: item.code, name: item.name || '', lastCounted: ts, daysSince });
    }
  });
  rows.sort((a,b)=>{
    const aScore = a.daysSince === null ? Number.POSITIVE_INFINITY : a.daysSince;
    const bScore = b.daysSince === null ? Number.POSITIVE_INFINITY : b.daysSince;
    return bScore - aScore;
  });
  return rows;
}

function renderCountDue(rows){
  const tbody = document.querySelector('#countDueTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#6b7280;">All counts up to date</td></tr>`;
    return;
  }
  rows.slice(0, 8).forEach(row=>{
    const lastCounted = row.lastCounted ? fmtDate(row.lastCounted) : 'Never';
    const daysSince = row.daysSince === null ? '—' : row.daysSince;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.code}</td><td>${row.name || FALLBACK}</td><td>${lastCounted}</td><td>${daysSince}</td>`;
    tbody.appendChild(tr);
  });
}

function drawChart(entries){
  const canvas = document.getElementById('trafficChart');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const days = Array.from({length: 7}).map((_, i)=>{
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const key = d.toDateString();
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, key, total: 0 };
  });
  (entries || []).forEach(e=>{
    const ts = parseTs(e.ts);
    if(!ts) return;
    const d = new Date(ts);
    const key = d.toDateString();
    const bucket = days.find(day=> day.key === key);
    if(bucket) bucket.total += 1;
  });
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const pad = 24;
  const max = Math.max(1, ...days.map(d=> d.total));
  const step = (w - 2 * pad) / (days.length - 1);
  ctx.strokeStyle = '#4f46e5';
  ctx.lineWidth = 2;
  ctx.beginPath();
  days.forEach((d,i)=>{
    const x = pad + i * step;
    const y = h - pad - (d.total / max) * (h - 2 * pad);
    if(i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = 'rgba(79,70,229,0.08)';
  ctx.lineTo(w - pad, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6b7280';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  days.forEach((d,i)=>{
    const x = pad + i * step;
    ctx.fillText(d.label, x, h - 8);
  });
}

function coerceNumber(value){
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function countActiveJobs(entries){
  const set = new Set();
  (entries || []).forEach(e=>{
    const jobId = getEntryJobId(e);
    if(jobId) set.add(jobId);
  });
  return set.size;
}

document.addEventListener('DOMContentLoaded', async ()=>{
  updateClock();
  setInterval(updateClock, 1000);

  const [
    metrics,
    lowStock,
    activity,
    inventory,
    items,
    counts
  ] = await Promise.all([
    utils.fetchJsonSafe('/api/metrics', {}, {}),
    utils.fetchJsonSafe('/api/low-stock', {}, []),
    utils.fetchJsonSafe('/api/recent-activity?limit=20', {}, []),
    utils.fetchJsonSafe('/api/inventory', {}, []),
    utils.fetchJsonSafe('/api/items', {}, []),
    utils.fetchJsonSafe('/api/inventory-counts', {}, [])
  ]);

  const itemMap = new Map();
  (items || []).forEach(item=>{
    if(item?.code) itemMap.set(item.code, item);
  });

  const stock = aggregateStock(inventory || []);
  const orders = (inventory || []).filter(e=> e.type === 'ordered');
  const openOrders = buildOpenOrders(orders, inventory || []);
  const overdueRows = buildOverdueRows(inventory || []);
  const topMovers = buildTopMovers(inventory || [], itemMap, stock.byCode);
  const countDueRows = buildCountDueRows(items || [], counts || []);

  const availableUnits = coerceNumber(metrics.availableUnits) ?? stock.totals.available;
  const reservedUnits = coerceNumber(metrics.reservedUnits) ?? stock.totals.reserved;
  const lowStockCount = coerceNumber(metrics.lowStockCount) ?? (lowStock || []).length;
  const activeJobs = coerceNumber(metrics.activeJobs) ?? countActiveJobs(inventory || []);

  setValue('availableUnits', availableUnits);
  setValue('checkedOutUnits', stock.totals.checkedOut);
  setValue('reservedUnits', reservedUnits);
  setValue('activeJobs', activeJobs);
  setValue('lowStockCount', lowStockCount);
  setValue('openOrdersCount', openOrders.length);
  setValue('overdueCount', overdueRows.length);
  setValue('outOfStockCount', stock.list.filter(item=> item.available <= 0).length);
  setValue('countDueCount', countDueRows.length);

  renderLowStock(lowStock || []);
  renderActivity(activity || []);
  drawChart(inventory || activity || []);
  renderOverdue(overdueRows);
  renderOrdered(openOrders);
  renderTopMovers(topMovers);
  renderCountDue(countDueRows);

  if(window.utils?.setupLogout) utils.setupLogout();
});
