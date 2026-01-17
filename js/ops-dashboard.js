const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const RECENT_DAYS = 7;

const numFmt = new Intl.NumberFormat('en-US');
const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const currencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const currencyFmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const movementTypes = new Set(['in','out','return','consume']);

function setText(id, value){
  const el = document.getElementById(id);
  if(el) el.textContent = value;
}

function fmtPct(value){
  if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return pctFmt.format(Math.max(0, Math.min(1, value)));
}

function fmtNum(value){
  if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return numFmt.format(value);
}

function fmtCurrency(value, { precise } = {}){
  if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  const fmt = precise ? currencyFmt2 : currencyFmt;
  return fmt.format(value);
}

function fmtDuration(ms){
  if(!Number.isFinite(ms) || ms <= 0) return 'N/A';
  const mins = Math.round(ms / 60000);
  if(mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

function parseTs(val){
  if(!val) return null;
  if(typeof val === 'number') return val;
  const num = Number(val);
  if(Number.isFinite(num)) return num;
  const ts = Date.parse(val);
  return Number.isNaN(ts) ? null : ts;
}

function parseDetails(details){
  if(!details) return {};
  if(typeof details === 'object') return details;
  try{
    return JSON.parse(details);
  }catch(e){
    return {};
  }
}

function aggregateInventory(entries){
  const map = new Map();
  entries.forEach(entry=>{
    const code = (entry.code || '').trim();
    if(!code) return;
    const type = (entry.type || '').toLowerCase();
    const qty = Number(entry.qty || 0) || 0;
    const ts = parseTs(entry.ts) || 0;
    const rec = map.get(code) || {
      code,
      in: 0,
      out: 0,
      reserve: 0,
      reserveRelease: 0,
      returned: 0,
      consume: 0,
      ordered: 0,
      lastMoveTs: 0,
      lastAnyTs: 0
    };
    rec.lastAnyTs = Math.max(rec.lastAnyTs, ts);
    if(type === 'in') rec.in += qty;
    if(type === 'out') rec.out += qty;
    if(type === 'reserve') rec.reserve += qty;
    if(type === 'reserve_release') rec.reserveRelease += qty;
    if(type === 'return') rec.returned += qty;
    if(type === 'consume') rec.consume += qty;
    if(type === 'ordered') rec.ordered += qty;
    if(movementTypes.has(type)) rec.lastMoveTs = Math.max(rec.lastMoveTs, ts);
    map.set(code, rec);
  });
  map.forEach(rec=>{
    rec.available = rec.in + rec.returned + rec.reserveRelease - rec.out - rec.reserve - rec.consume;
    rec.onHand = rec.in + rec.returned - rec.out - rec.consume;
  });
  return map;
}

function getItemCost(item){
  const raw = item?.unitPrice ?? item?.unitprice;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

function computeAccuracy(statsMap, countsMap){
  let sumSystem = 0;
  let sumDiff = 0;
  let discrepancyValue = 0;
  let counted = 0;
  statsMap.forEach((rec, code)=>{
    const count = countsMap.get(code);
    if(!count) return;
    const systemQty = Number(rec.available || 0);
    const countedQty = Number(count.qty || 0);
    const diff = countedQty - systemQty;
    sumSystem += Math.abs(systemQty);
    sumDiff += Math.abs(diff);
    discrepancyValue += Math.abs(diff) * (count.cost || 0);
    counted += 1;
  });
  if(!counted || !sumSystem) return { accuracy: null, discrepancyValue };
  const accuracy = Math.max(0, 1 - (sumDiff / sumSystem));
  return { accuracy, discrepancyValue };
}

async function loadData(){
  const [inventory, counts, items, pickEvents, checkinEvents] = await Promise.all([
    utils.fetchJsonSafe('/api/inventory', {}, []),
    utils.fetchJsonSafe('/api/inventory-counts', {}, []),
    utils.fetchJsonSafe('/api/items', {}, []),
    utils.fetchJsonSafe(`/api/ops-events?type=pick&days=${WINDOW_DAYS}`, {}, []),
    utils.fetchJsonSafe(`/api/ops-events?type=checkin&days=${WINDOW_DAYS}`, {}, [])
  ]);
  return {
    inventory: Array.isArray(inventory) ? inventory : [],
    counts: Array.isArray(counts) ? counts : [],
    items: Array.isArray(items) ? items : [],
    pickEvents: Array.isArray(pickEvents) ? pickEvents : [],
    checkinEvents: Array.isArray(checkinEvents) ? checkinEvents : []
  };
}

function computeMetrics(data){
  const now = Date.now();
  const windowStart = now - WINDOW_DAYS * DAY_MS;
  const recentStart = now - RECENT_DAYS * DAY_MS;
  const inventory = data.inventory;
  const itemMap = new Map(data.items.map(item=>[(item.code || '').trim(), item]));
  const statsMap = aggregateInventory(inventory);

  const countsMap = new Map();
  data.counts.forEach(row=>{
    const code = (row.code || '').trim();
    if(!code) return;
    const existing = countsMap.get(code);
    const countedAt = parseTs(row.countedAt || row.countedat || row.ts);
    if(existing && countedAt && existing.countedAt && countedAt < existing.countedAt) return;
    countsMap.set(code, {
      qty: Number(row.qty || 0),
      countedAt,
      cost: getItemCost(itemMap.get(code))
    });
  });

  const { accuracy, discrepancyValue } = computeAccuracy(statsMap, countsMap);

  const totalTransactions = inventory.filter(e=>['in','out','return','reserve','consume','reserve_release'].includes((e.type || '').toLowerCase())).length;
  const adjustments = inventory.filter(e=>{
    const type = (e.type || '').toLowerCase();
    const status = (e.status || '').toLowerCase();
    return type === 'consume' || status === 'damaged' || status === 'lost';
  }).length;
  const adjustmentRate = totalTransactions ? adjustments / totalTransactions : null;

  let inventoryValue = 0;
  let belowReorder = 0;
  let negativeAvailability = 0;
  let notCounted = 0;
  let deadStock = 0;
  let stockouts = 0;
  let totalItems = 0;
  let totalAvailableValue = 0;

  statsMap.forEach((rec, code)=>{
    const item = itemMap.get(code);
    const cost = getItemCost(item);
    const available = Number(rec.available || 0);
    const onHand = Number(rec.onHand || 0);
    const reorderPoint = Number(item?.reorderPoint);
    if(Number.isFinite(reorderPoint) && available <= reorderPoint) belowReorder += 1;
    if(available < 0) negativeAvailability += 1;
    if(available <= 0) stockouts += 1;
    totalItems += 1;
    inventoryValue += Math.max(0, onHand) * cost;
    totalAvailableValue += Math.max(0, onHand) * cost;
    const count = countsMap.get(code);
    if(!count || !count.countedAt || count.countedAt < (now - WINDOW_DAYS * DAY_MS)) notCounted += 1;
    const lastMove = rec.lastMoveTs || 0;
    if(!lastMove || lastMove < windowStart) deadStock += 1;
  });

  const inventoryValueDelta = inventory.reduce((sum, entry)=>{
    const type = (entry.type || '').toLowerCase();
    if(!['in','out','return','consume'].includes(type)) return sum;
    const ts = parseTs(entry.ts);
    if(!ts || ts < (now - 7 * DAY_MS)) return sum;
    const qty = Number(entry.qty || 0) || 0;
    const cost = getItemCost(itemMap.get(entry.code || ''));
    const direction = (type === 'in' || type === 'return') ? 1 : -1;
    return sum + (direction * qty * cost);
  }, 0);
  const valueSevenDaysAgo = inventoryValue - inventoryValueDelta;
  const inventoryTrend = valueSevenDaysAgo ? (inventoryValue - valueSevenDaysAgo) / valueSevenDaysAgo : null;

  const handledByUser = new Map();
  inventory.forEach(entry=>{
    const type = (entry.type || '').toLowerCase();
    if(!['in','out','return','consume'].includes(type)) return;
    const ts = parseTs(entry.ts);
    if(!ts || ts < recentStart) return;
    const qty = Math.abs(Number(entry.qty || 0) || 0);
    const key = entry.userEmail || entry.useremail || entry.userName || 'Unknown';
    handledByUser.set(key, (handledByUser.get(key) || 0) + qty);
  });
  const totalHandled = Array.from(handledByUser.values()).reduce((sum, v)=> sum + v, 0);
  const itemsPerEmployee = handledByUser.size ? totalHandled / handledByUser.size : null;

  const ordersProcessed = new Set();
  inventory.forEach(entry=>{
    const type = (entry.type || '').toLowerCase();
    if(type !== 'in' || (entry.sourceType || '').toLowerCase() !== 'order') return;
    const ts = parseTs(entry.ts);
    if(!ts || ts < recentStart) return;
    const sourceId = entry.sourceId || entry.sourceid || entry.id;
    if(sourceId) ordersProcessed.add(sourceId);
  });
  const ordersPerDay = ordersProcessed.size / RECENT_DAYS;

  const orderMap = new Map();
  inventory.forEach(entry=>{
    const type = (entry.type || '').toLowerCase();
    if(type !== 'ordered') return;
    orderMap.set(entry.id, {
      id: entry.id,
      qty: Number(entry.qty || 0) || 0,
      ts: parseTs(entry.ts),
      eta: parseTs(entry.eta),
      received: 0,
      firstCheckin: null
    });
  });
  inventory.forEach(entry=>{
    const type = (entry.type || '').toLowerCase();
    if(type !== 'in' || (entry.sourceType || '').toLowerCase() !== 'order') return;
    const sourceId = entry.sourceId || entry.sourceid;
    if(!sourceId || !orderMap.has(sourceId)) return;
    const rec = orderMap.get(sourceId);
    const qty = Number(entry.qty || 0) || 0;
    rec.received += qty;
    const ts = parseTs(entry.ts);
    if(ts && (!rec.firstCheckin || ts < rec.firstCheckin)) rec.firstCheckin = ts;
  });

  const leadTimes = [];
  let onTime = 0;
  let onTimeTotal = 0;
  let orderedQtyWindow = 0;
  let receivedQtyWindow = 0;
  orderMap.forEach(order=>{
    const orderTs = order.ts || 0;
    if(orderTs && orderTs >= windowStart){
      orderedQtyWindow += order.qty;
      receivedQtyWindow += order.received;
    }
    if(orderTs && order.firstCheckin){
      leadTimes.push(order.firstCheckin - orderTs);
      if(order.eta){
        onTimeTotal += 1;
        if(order.firstCheckin <= order.eta) onTime += 1;
      }
    }
  });
  const avgLeadTime = leadTimes.length ? leadTimes.reduce((sum, v)=> sum + v, 0) / leadTimes.length : null;
  const leadVar = leadTimes.length > 1 ? Math.sqrt(leadTimes.reduce((sum, v)=> sum + Math.pow(v - avgLeadTime, 2), 0) / leadTimes.length) : null;
  const onTimeRate = onTimeTotal ? onTime / onTimeTotal : null;

  const fillRate = orderedQtyWindow ? Math.min(1, receivedQtyWindow / orderedQtyWindow) : null;
  const serviceLevel = stockouts === 0 && totalItems ? 1 : totalItems ? 1 - (stockouts / totalItems) : null;

  const cogs = inventory.reduce((sum, entry)=>{
    const type = (entry.type || '').toLowerCase();
    if(type !== 'out') return sum;
    const ts = parseTs(entry.ts);
    if(!ts || ts < windowStart) return sum;
    const qty = Number(entry.qty || 0) || 0;
    const cost = getItemCost(itemMap.get(entry.code || ''));
    return sum + qty * cost;
  }, 0);
  const avgInventoryValue = totalAvailableValue;
  const turnover = avgInventoryValue ? cogs / avgInventoryValue : null;
  const doh = cogs ? (avgInventoryValue / (cogs / WINDOW_DAYS)) : null;

  const usageWindow = new Map();
  inventory.forEach(entry=>{
    const type = (entry.type || '').toLowerCase();
    if(type !== 'out') return;
    const ts = parseTs(entry.ts);
    if(!ts || ts < windowStart) return;
    const code = (entry.code || '').trim();
    if(!code) return;
    const qty = Number(entry.qty || 0) || 0;
    usageWindow.set(code, (usageWindow.get(code) || 0) + qty);
  });

  const slowMovingList = Array.from(statsMap.values()).map(rec=>{
    const moves = usageWindow.get(rec.code) || 0;
    return { code: rec.code, moves, available: rec.available };
  }).filter(r=> r.moves <= 2).sort((a,b)=> a.moves - b.moves || a.available - b.available).slice(0,6);

  const usageSorted = Array.from(usageWindow.entries()).map(([code, qty])=>({
    code,
    qty
  })).sort((a,b)=> b.qty - a.qty);
  const usageTotal = usageSorted.reduce((sum, r)=> sum + r.qty, 0);
  const topUsage = usageSorted.slice(0,6).map(r=>{
    const item = itemMap.get(r.code);
    return {
      code: r.code,
      name: item?.name || '',
      qty: r.qty,
      share: usageTotal ? r.qty / usageTotal : 0
    };
  });
  let cumulative = 0;
  let skuCount = 0;
  for(const row of usageSorted){
    cumulative += row.qty;
    skuCount += 1;
    if(usageTotal && cumulative / usageTotal >= 0.8) break;
  }
  const eightyTwenty = totalItems ? (skuCount / totalItems) : null;

  const lostQty = inventory.reduce((sum, entry)=>{
    const type = (entry.type || '').toLowerCase();
    if(type !== 'consume') return sum;
    const status = (entry.status || '').toLowerCase();
    const reason = (entry.reason || '').toLowerCase();
    if(status === 'lost' || reason.includes('lost')) return sum + (Number(entry.qty || 0) || 0);
    return sum;
  }, 0);
  const damagedQty = inventory.reduce((sum, entry)=>{
    const type = (entry.type || '').toLowerCase();
    if(type !== 'consume') return sum;
    const status = (entry.status || '').toLowerCase();
    const reason = (entry.reason || '').toLowerCase();
    if(status === 'damaged' || reason.includes('damage')) return sum + (Number(entry.qty || 0) || 0);
    return sum;
  }, 0);
  const writeOffs = inventory.filter(entry=> (entry.type || '').toLowerCase() === 'consume').length;
  const totalIssued = inventory.reduce((sum, entry)=>{
    if((entry.type || '').toLowerCase() !== 'out') return sum;
    const ts = parseTs(entry.ts);
    if(!ts || ts < windowStart) return sum;
    return sum + (Number(entry.qty || 0) || 0);
  }, 0);
  const shrinkage = totalIssued ? lostQty / totalIssued : null;
  const damaged = totalIssued ? damagedQty / totalIssued : null;
  const lostValue = lostQty * (inventoryValue / Math.max(totalItems, 1));

  return {
    accuracy,
    adjustmentRate,
    discrepancyValue,
    inventoryValue,
    inventoryTrend,
    belowReorder,
    negativeAvailability,
    notCounted,
    deadStock,
    stockouts,
    totalItems,
    ordersPerDay,
    itemsPerEmployee,
    avgLeadTime,
    leadVar,
    onTimeRate,
    fillRate,
    serviceLevel,
    turnover,
    doh,
    slowMovingList,
    topUsage,
    eightyTwenty,
    shrinkage,
    damaged,
    writeOffs,
    lostValue
  };
}

function avgDuration(events){
  const durations = events.map(e=> {
    const details = parseDetails(e.details);
    return Number(details.durationMs || details.duration || e.durationMs || e.duration);
  }).filter(v=> Number.isFinite(v) && v > 0);
  if(!durations.length) return null;
  return durations.reduce((sum, v)=> sum + v, 0) / durations.length;
}

function renderTables(metrics, data){
  const slowBody = document.querySelector('#slowMovingTable tbody');
  if(slowBody){
    slowBody.innerHTML = '';
    if(!metrics.slowMovingList.length){
      slowBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#6b7280;">No slow movers found.</td></tr>';
    }else{
      metrics.slowMovingList.forEach(row=>{
        const item = data.items.find(i=> i.code === row.code);
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${row.code}</td><td>${item?.name || ''}</td><td>${row.moves}</td><td>${fmtNum(row.available)}</td>`;
        slowBody.appendChild(tr);
      });
    }
  }
  const usageBody = document.querySelector('#topUsageTable tbody');
  if(usageBody){
    usageBody.innerHTML = '';
    if(!metrics.topUsage.length){
      usageBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#6b7280;">No usage data yet.</td></tr>';
    }else{
      metrics.topUsage.forEach(row=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${row.code}</td><td>${row.name || ''}</td><td>${fmtNum(row.qty)}</td><td>${fmtPct(row.share)}</td>`;
        usageBody.appendChild(tr);
      });
    }
  }
}

async function renderOpsDashboard(){
  const data = await loadData();
  const metrics = computeMetrics(data);
  const avgPick = avgDuration(data.pickEvents);
  const avgCheckin = avgDuration(data.checkinEvents);

  setText('kpi-accuracy', fmtPct(metrics.accuracy));
  setText('kpi-adjustment', fmtPct(metrics.adjustmentRate));
  setText('kpi-discrepancy', fmtCurrency(metrics.discrepancyValue, { precise: true }));
  setText('kpi-pick-time', fmtDuration(avgPick));
  setText('kpi-checkin-time', fmtDuration(avgCheckin));
  setText('kpi-orders-day', fmtNum(metrics.ordersPerDay?.toFixed ? Number(metrics.ordersPerDay.toFixed(1)) : metrics.ordersPerDay));
  setText('kpi-items-employee', fmtNum(metrics.itemsPerEmployee?.toFixed ? Number(metrics.itemsPerEmployee.toFixed(1)) : metrics.itemsPerEmployee));
  setText('kpi-below-reorder', fmtNum(metrics.belowReorder));
  setText('kpi-negative', fmtNum(metrics.negativeAvailability));
  setText('kpi-not-counted', fmtNum(metrics.notCounted));
  setText('kpi-turnover', metrics.turnover !== null ? metrics.turnover.toFixed(2) : 'N/A');
  setText('kpi-doh', metrics.doh !== null ? `${Math.round(metrics.doh)}d` : 'N/A');
  setText('kpi-dead-stock', fmtPct(metrics.totalItems ? metrics.deadStock / metrics.totalItems : null));
  setText('kpi-slow-moving', fmtNum(metrics.slowMovingList.length));
  setText('kpi-stockout', fmtPct(metrics.totalItems ? metrics.stockouts / metrics.totalItems : null));
  setText('kpi-fill-rate', fmtPct(metrics.fillRate));
  setText('kpi-service-level', fmtPct(metrics.serviceLevel));
  setText('kpi-lead-time', metrics.avgLeadTime ? fmtDuration(metrics.avgLeadTime) : 'N/A');
  setText('kpi-lead-var', metrics.leadVar ? fmtDuration(metrics.leadVar) : 'N/A');
  setText('kpi-on-time', fmtPct(metrics.onTimeRate));
  setText('kpi-cost-var', 'N/A');
  setText('kpi-inv-value', fmtCurrency(metrics.inventoryValue));
  setText('kpi-inv-trend', fmtPct(metrics.inventoryTrend));
  setText('kpi-shrinkage', fmtPct(metrics.shrinkage));
  setText('kpi-damaged', fmtPct(metrics.damaged));
  setText('kpi-writeoffs', fmtNum(metrics.writeOffs));
  setText('kpi-lost-value', fmtCurrency(metrics.lostValue, { precise: true }));
  setText('kpi-usage-trend', fmtNum(metrics.topUsage.length ? metrics.topUsage[0].qty : null));
  setText('kpi-8020', metrics.eightyTwenty !== null ? `${Math.round(metrics.eightyTwenty * 100)}%` : 'N/A');

  renderTables(metrics, data);
}

document.addEventListener('DOMContentLoaded', async ()=>{
  renderOpsDashboard();
  const tick = ()=> setText('clockOps', new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }));
  tick();
  setInterval(tick, 60000);
});
