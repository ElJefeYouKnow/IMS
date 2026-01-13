const FALLBACK = 'N/A';
const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const DEFAULT_CATEGORY_NAME = 'Uncategorized';
const COUNT_STALE_DAYS = 30;
const RECENT_DAYS = 3;
const CLOSED_JOB_STATUSES = new Set(['complete', 'completed', 'closed', 'archived', 'cancelled', 'canceled']);

let incomingBaseRows = [];
let onhandBaseRows = [];
let overdueByCode = {};
let overdueRows = [];
let countCache = {};
let itemMetaByCode = new Map();
let categoryRulesByName = new Map();
let closedJobIds = new Set();
let itemPanelEls = null;

function getItemPanelEls(){
  if(itemPanelEls) return itemPanelEls;
  const panel = document.getElementById('itemPanel');
  if(!panel) return null;
  itemPanelEls = {
    panel,
    backdrop: document.getElementById('itemPanelBackdrop'),
    close: document.getElementById('itemPanelClose'),
    title: document.getElementById('itemPanelTitle'),
    name: document.getElementById('itemPanelName'),
    badges: document.getElementById('itemPanelBadges'),
    available: document.getElementById('itemPanelAvailable'),
    reserved: document.getElementById('itemPanelReserved'),
    checkedOut: document.getElementById('itemPanelCheckedOut'),
    code: document.getElementById('itemPanelCode'),
    category: document.getElementById('itemPanelCategory'),
    price: document.getElementById('itemPanelPrice'),
    tags: document.getElementById('itemPanelTags'),
    threshold: document.getElementById('itemPanelThreshold'),
    overdue: document.getElementById('itemPanelOverdue'),
    projects: document.getElementById('itemPanelProjects'),
    lastActivity: document.getElementById('itemPanelLastActivity'),
    lastCount: document.getElementById('itemPanelLastCount'),
    countedQty: document.getElementById('itemPanelCountedQty'),
    discrepancy: document.getElementById('itemPanelDiscrepancy'),
    checkedOutProjects: document.getElementById('itemPanelCheckedOutProjects'),
    reservedProjects: document.getElementById('itemPanelReservedProjects'),
    description: document.getElementById('itemPanelDescription')
  };
  return itemPanelEls;
}

function setPanelOpen(isOpen){
  const els = getItemPanelEls();
  if(!els) return;
  els.panel.classList.toggle('open', isOpen);
  if(els.backdrop) els.backdrop.classList.toggle('active', isOpen);
  document.body.classList.toggle('panel-open', isOpen);
  els.panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
}

function renderJobBreakdown(container, rows, emptyText){
  if(!container) return;
  container.innerHTML = '';
  if(!rows.length){
    const empty = document.createElement('div');
    empty.className = 'job-empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }
  const list = document.createElement('div');
  list.className = 'job-breakdown';
  rows.forEach(row=>{
    const wrap = document.createElement('div');
    wrap.className = 'job-row';
    const name = document.createElement('span');
    name.textContent = row.jobId || 'General';
    const qty = document.createElement('span');
    qty.textContent = row.label;
    wrap.appendChild(name);
    wrap.appendChild(qty);
    list.appendChild(wrap);
  });
  container.appendChild(list);
}

function openItemPanel(item){
  const els = getItemPanelEls();
  if(!els || !item) return;
  const meta = itemMetaByCode.get(item.code) || {};
  const staticTags = normalizeTags(meta.tags);
  const threshold = Number.isFinite(Number(item.lowStockThreshold)) ? Number(item.lowStockThreshold) : DEFAULT_LOW_STOCK_THRESHOLD;
  const countDate = item.countedAt ? fmtDate(item.countedAt) : FALLBACK;
  const countedQty = item.countedQty !== null && item.countedQty !== undefined ? item.countedQty : FALLBACK;
  const discrepancy = item.discrepancy !== null && item.discrepancy !== undefined
    ? `${item.discrepancy > 0 ? '+' : ''}${item.discrepancy}`
    : FALLBACK;

  els.title.textContent = item.code || 'Item';
  els.name.textContent = item.name || 'Unnamed item';
  if(els.code) els.code.textContent = item.code || FALLBACK;
  els.available.textContent = Number.isFinite(Number(item.available)) ? item.available : FALLBACK;
  els.reserved.textContent = Number.isFinite(Number(item.reserveQty)) ? item.reserveQty : FALLBACK;
  els.checkedOut.textContent = Number.isFinite(Number(item.checkedOut)) ? item.checkedOut : FALLBACK;
  els.category.textContent = item.category || DEFAULT_CATEGORY_NAME;
  if(els.price) els.price.textContent = fmtMoney(meta.unitPrice);
  if(els.tags) els.tags.textContent = staticTags.length ? staticTags.join(', ') : FALLBACK;
  els.threshold.textContent = threshold;
  if(els.overdue) els.overdue.textContent = item.overdue ? 'Yes' : 'No';
  els.projects.textContent = item.jobsList || FALLBACK;
  els.lastActivity.textContent = item.lastDate || FALLBACK;
  els.lastCount.textContent = countDate;
  els.countedQty.textContent = countedQty;
  els.discrepancy.textContent = discrepancy;
  els.description.textContent = (meta.description || '').toString().trim() || 'No description provided.';

  if(els.badges){
    els.badges.innerHTML = '';
    const badges = [];
    if(item.available <= 0){
      badges.push({ text: 'Out of stock', cls: 'danger' });
    }else if(item.available <= threshold){
      badges.push({ text: 'Low stock', cls: 'warn' });
    }
    if(item.overdue) badges.push({ text: 'Overdue returns', cls: 'danger' });
    if(item.recent) badges.push({ text: 'Recently active', cls: 'info' });
    if(!badges.length){
      badges.push({ text: 'On hand', cls: 'info' });
    }
    badges.forEach(badge=>{
      const el = document.createElement('span');
      el.className = badge.cls ? `badge ${badge.cls}` : 'badge';
      el.textContent = badge.text;
      els.badges.appendChild(el);
    });
  }

  const outRows = [];
  const reserveRows = [];
  if(item.jobs && item.jobs.size){
    item.jobs.forEach((stats, jobId)=>{
      const checkedOut = Math.max(0, Number(stats.out || 0));
      if(checkedOut > 0){
        outRows.push({ jobId, label: `${checkedOut} out` });
      }
      const reserved = Math.max(0, Number(stats.reserve || 0));
      if(reserved > 0){
        reserveRows.push({ jobId, label: `${reserved} reserved` });
      }
    });
  }
  renderJobBreakdown(els.checkedOutProjects, outRows, 'No active job checkouts.');
  renderJobBreakdown(els.reservedProjects, reserveRows, 'No active reservations.');

  setPanelOpen(true);
}

function closeItemPanel(){
  setPanelOpen(false);
}

function setupItemPanel(){
  const els = getItemPanelEls();
  if(!els) return;
  if(els.close) els.close.addEventListener('click', closeItemPanel);
  if(els.backdrop) els.backdrop.addEventListener('click', closeItemPanel);
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && els.panel.classList.contains('open')){
      closeItemPanel();
    }
  });
}

async function loadEntries(){
  try{
    const r = await fetch('/api/inventory');
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

function normalizeCategoryRules(raw){
  const input = (raw && typeof raw === 'object') ? raw : {};
  const out = {
    requireJobId: false,
    requireLocation: false,
    requireNotes: false,
    allowFieldPurchase: true,
    allowCheckout: true,
    allowReserve: true,
    maxCheckoutQty: null,
    returnWindowDays: 5,
    lowStockThreshold: DEFAULT_LOW_STOCK_THRESHOLD
  };
  if(Object.prototype.hasOwnProperty.call(input, 'maxCheckoutQty')){
    const max = Number(input.maxCheckoutQty);
    out.maxCheckoutQty = Number.isFinite(max) && max > 0 ? Math.floor(max) : null;
  }
  if(Object.prototype.hasOwnProperty.call(input, 'returnWindowDays')){
    const days = Number(input.returnWindowDays);
    out.returnWindowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : out.returnWindowDays;
  }
  if(Object.prototype.hasOwnProperty.call(input, 'lowStockThreshold')){
    const low = Number(input.lowStockThreshold);
    out.lowStockThreshold = Number.isFinite(low) && low >= 0 ? Math.floor(low) : out.lowStockThreshold;
  }
  return out;
}

async function loadItemsMeta(){
  const rows = (window.utils && utils.fetchJsonSafe)
    ? await utils.fetchJsonSafe('/api/items', {}, [])
    : await fetch('/api/items').then(r=> r.ok ? r.json() : []);
  itemMetaByCode = new Map();
  (rows || []).forEach(item=>{
    if(!item?.code) return;
    itemMetaByCode.set(item.code, item);
  });
  return itemMetaByCode;
}

async function loadCategoryRules(){
  const rows = (window.utils && utils.fetchJsonSafe)
    ? await utils.fetchJsonSafe('/api/categories', {}, [])
    : await fetch('/api/categories').then(r=> r.ok ? r.json() : []);
  categoryRulesByName = new Map();
  (rows || []).forEach(cat=>{
    if(!cat?.name) return;
    categoryRulesByName.set(cat.name.toLowerCase(), normalizeCategoryRules(cat.rules));
  });
  return categoryRulesByName;
}

async function loadClosedJobs(){
  const rows = (window.utils && utils.fetchJsonSafe)
    ? await utils.fetchJsonSafe('/api/jobs', {}, [])
    : await fetch('/api/jobs').then(r=> r.ok ? r.json() : []);
  closedJobIds = new Set();
  (rows || []).forEach(job=>{
    const code = (job?.code || '').toString().trim();
    const status = (job?.status || '').toString().trim().toLowerCase();
    if(code && CLOSED_JOB_STATUSES.has(status)){
      closedJobIds.add(code.toLowerCase());
    }
  });
  return closedJobIds;
}

function getLowStockThresholdForCode(code){
  const item = itemMetaByCode.get(code);
  const name = (item?.category || DEFAULT_CATEGORY_NAME || '').toString().trim();
  const rules = categoryRulesByName.get(name.toLowerCase());
  return rules?.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
}

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

async function fetchCounts(){
  const rows = (window.utils && utils.fetchJsonSafe)
    ? await utils.fetchJsonSafe('/api/inventory-counts', {}, [])
    : await fetch('/api/inventory-counts').then(r=> r.ok ? r.json() : []);
  countCache = {};
  (rows || []).forEach(r=>{
    const code = r.code;
    if(!code) return;
    countCache[code] = {
      qty: Number(r.qty),
      ts: r.countedat || r.countedAt || r.ts || r.counted_at || null
    };
  });
  return countCache;
}

async function saveCounts(lines){
  try{
    const r = await fetch('/api/inventory-counts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ counts: lines })
    });
    const data = await r.json().catch(()=>[]);
    if(!r.ok) return { ok:false, error: data?.error || 'Failed to save counts' };
    countCache = {};
    (data || []).forEach(r=>{
      const code = r.code;
      if(!code) return;
      countCache[code] = {
        qty: Number(r.qty),
        ts: r.countedat || r.countedAt || r.ts || r.counted_at || null
      };
    });
    return { ok:true };
  }catch(e){
    return { ok:false, error: 'Failed to save counts' };
  }
}

function fmtDT(val){
  if(window.utils && utils.formatDateTime){
    return utils.formatDateTime(val);
  }
  return val ? new Date(val).toLocaleString() : FALLBACK;
}

function fmtDate(val){
  if(window.utils && utils.formatDateOnly){
    return utils.formatDateOnly(val);
  }
  return val ? new Date(val).toLocaleDateString() : FALLBACK;
}

function fmtMoney(val){
  const num = Number(val);
  if(!Number.isFinite(num)) return FALLBACK;
  return `$${num.toFixed(2)}`;
}

function normalizeTags(value){
  if(!value) return [];
  const input = Array.isArray(value) ? value : value.toString().split(/[,;|]/);
  const seen = new Set();
  const out = [];
  input.forEach(tag=>{
    const cleaned = (tag || '').toString().trim();
    if(!cleaned) return;
    const key = cleaned.toLowerCase();
    if(seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  });
  return out;
}

function daysBetween(ts){
  if(!ts) return null;
  const diff = Date.now() - ts;
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function parseDate(val){
  if(!val) return null;
  const ts = Date.parse(val);
  return Number.isNaN(ts) ? null : ts;
}

function buildOrderBalance(orders, inventory){
  const map = new Map();
  (orders||[]).forEach(o=>{
    const sourceId = o.sourceId || o.id;
    const jobId = normalizeJobId(o.jobId || o.jobid || '');
    const key = sourceId;
    if(!map.has(key)) map.set(key, { sourceId, code: o.code, jobId, name: o.name || '', ordered: 0, checkedIn: 0, eta: o.eta || '', lastOrderTs: 0 });
    const rec = map.get(key);
    rec.ordered += Number(o.qty || 0);
    rec.lastOrderTs = Math.max(rec.lastOrderTs, o.ts || 0);
    if(!rec.eta && o.eta) rec.eta = o.eta;
  });
  (inventory||[]).filter(e=> e.type === 'in' && e.sourceId).forEach(ci=>{
    const key = ci.sourceId;
    if(!map.has(key)) return;
    const rec = map.get(key);
    rec.checkedIn += Number(ci.qty || 0);
  });
  // Fallback: allocate unlinked check-ins by code + project to reduce incoming clutter
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

function aggregateStock(entries){
  const stock = {};
  entries.forEach(e=>{
    if(!e.code) return;
    if(!stock[e.code]) stock[e.code] = { code: e.code, name: e.name || '', inQty: 0, outQty: 0, returnQty: 0, reserveQty: 0, lastTs: 0, lastLocation: '', lastLocationTs: 0, jobs: new Map() };
    const item = stock[e.code];
    if(!item.name && e.name) item.name = e.name;
    const qty = Number(e.qty)||0;
    if(e.type === 'in' || e.type === 'return') item.inQty += qty;
    if(e.type === 'return') item.returnQty += qty;
    else if(e.type === 'out') item.outQty += qty;
    else if(e.type === 'reserve') item.reserveQty += qty;
    else if(e.type === 'reserve_release') item.reserveQty -= qty;

    const jobId = getEntryJobId(e);
    const jobKey = jobId ? jobId.toLowerCase() : '';
    if(jobId && !closedJobIds.has(jobKey)){
      if(!item.jobs.has(jobId)) item.jobs.set(jobId, { out: 0, reserve: 0 });
      const job = item.jobs.get(jobId);
      if(e.type === 'out') job.out += qty;
      else if(e.type === 'return') job.out -= qty;
      else if(e.type === 'reserve') job.reserve += qty;
      else if(e.type === 'reserve_release') job.reserve -= qty;
    }
    item.lastTs = Math.max(item.lastTs, e.ts || 0);
    if(e.location){
      const locTs = e.ts || 0;
      if(locTs >= item.lastLocationTs){
        item.lastLocation = e.location;
        item.lastLocationTs = locTs;
      }
    }
  });
  return Object.values(stock).map(s=>{
    const activeJobs = [];
    for (const [jobId, stats] of s.jobs.entries()) {
      if ((stats.out || 0) > 0 || (stats.reserve || 0) > 0) activeJobs.push(jobId);
    }
    const checkedOut = Math.max(0, s.outQty - s.returnQty);
    const available = Math.max(0, s.inQty - s.outQty - s.reserveQty);
    const lowStockThreshold = getLowStockThresholdForCode(s.code);
    return {
      ...s,
      jobsList: activeJobs.length ? activeJobs.sort().join(', ') : FALLBACK,
      checkedOut,
      available,
      category: itemMetaByCode.get(s.code)?.category || DEFAULT_CATEGORY_NAME,
      lowStockThreshold,
      lastDate: s.lastTs ? fmtDT(s.lastTs) : FALLBACK,
      location: s.lastLocation || FALLBACK
    };
  });
}

function buildOverdueMap(entries){
  const map = new Map();
  entries.forEach(e=>{
    if(e.type !== 'out' && e.type !== 'return') return;
    const key = `${e.code}|${getEntryJobId(e)}`;
    const rec = map.get(key) || { out: 0, ret: 0, minDue: null };
    const qty = Number(e.qty)||0;
    if(e.type === 'out'){
      rec.out += qty;
      const due = parseDate(e.returnDate);
      if(due){
        rec.minDue = rec.minDue ? Math.min(rec.minDue, due) : due;
      }
    }else if(e.type === 'return'){
      rec.ret += qty;
    }
    map.set(key, rec);
  });
  const overdue = {};
  let count = 0;
  const now = Date.now();
  map.forEach((rec, key)=>{
    const outstanding = Math.max(0, rec.out - rec.ret);
    if(outstanding <= 0) return;
    if(rec.minDue && rec.minDue < now){
      const code = key.split('|')[0];
      overdue[code] = true;
      count += 1;
    }
  });
  return { overdueByCode: overdue, overdueCount: count };
}

function buildOverdueRows(entries){
  const map = new Map();
  entries.forEach(e=>{
    if(e.type !== 'out' && e.type !== 'return') return;
    const code = e.code;
    if(!code) return;
    const jobId = getEntryJobId(e);
    const key = `${code}|${jobId}`;
    const rec = map.get(key) || { code, jobId, out: 0, ret: 0, minDue: null, lastOutTs: 0 };
    const qty = Number(e.qty)||0;
    if(e.type === 'out'){
      rec.out += qty;
      rec.lastOutTs = Math.max(rec.lastOutTs, e.ts || 0);
      const due = parseDate(e.returnDate);
      if(due){
        rec.minDue = rec.minDue ? Math.min(rec.minDue, due) : due;
      }
    }else if(e.type === 'return'){
      rec.ret += qty;
    }
    map.set(key, rec);
  });
  const rows = [];
  const now = Date.now();
  map.forEach(rec=>{
    const outstanding = Math.max(0, rec.out - rec.ret);
    if(outstanding <= 0) return;
    if(!rec.minDue || rec.minDue >= now) return;
    const daysLate = Math.floor((now - rec.minDue) / (24 * 60 * 60 * 1000));
    rows.push({
      ...rec,
      outstanding,
      daysLate
    });
  });
  return rows;
}

function buildIncomingRows(orders, inventory){
  const balances = buildOrderBalance(orders, inventory);
  const rows = [];
  balances.forEach((rec)=>{
    const openQty = Math.max(0, rec.ordered - rec.checkedIn);
    if(openQty <= 0) return;
    rows.push({ ...rec, openQty });
  });
  return rows;
}

function computeOnhandRows(entries){
  const { overdueByCode: overdueMap } = buildOverdueMap(entries);
  overdueByCode = overdueMap;
  const counts = countCache || {};
  return aggregateStock(entries).map(item=>{
    const countInfo = counts[item.code];
    const countTs = countInfo?.ts || null;
    const countAge = countTs ? daysBetween(countTs) : null;
    const countedQty = (countInfo && Number.isFinite(Number(countInfo.qty))) ? Number(countInfo.qty) : null;
    const discrepancy = countedQty !== null ? countedQty - item.available : null;
    return {
      ...item,
      countedQty,
      countedAt: countTs,
      countAge,
      discrepancy,
      overdue: !!overdueByCode[item.code],
      recent: item.lastTs ? (Date.now() - item.lastTs) <= (RECENT_DAYS * 24 * 60 * 60 * 1000) : false
    };
  });
}

function applyOnhandFilters(items){
  const search = (document.getElementById('searchBox')?.value || '').toLowerCase();
  const low = document.getElementById('filter-low')?.checked;
  const overdue = document.getElementById('filter-overdue')?.checked;
  const project = document.getElementById('filter-project')?.checked;
  const recent = document.getElementById('filter-recent')?.checked;
  const needsCount = document.getElementById('filter-count')?.checked;

  return items.filter(item=>{
    if(search && !(item.code.toLowerCase().includes(search) || (item.name||'').toLowerCase().includes(search))) return false;
    const lowThreshold = Number.isFinite(Number(item.lowStockThreshold)) ? Number(item.lowStockThreshold) : DEFAULT_LOW_STOCK_THRESHOLD;
    if(low && item.available > lowThreshold) return false;
    if(overdue && !item.overdue) return false;
    if(project && item.jobsList === FALLBACK) return false;
    if(recent && !item.recent) return false;
    if(needsCount){
      const stale = !item.countedAt || (item.countAge !== null && item.countAge > COUNT_STALE_DAYS);
      if(!stale) return false;
    }
    return true;
  });
}

function setText(id, value){
  const el = document.getElementById(id);
  if(el) el.textContent = value;
}

function updateSummary(){
  const incomingTotal = incomingBaseRows.reduce((sum, row)=> sum + (Number(row.openQty)||0), 0);
  const overdueIncoming = incomingBaseRows.filter(row=>{
    const etaTs = parseDate(row.eta);
    return etaTs && etaTs < Date.now();
  }).length;
  setText('incomingTotal', incomingTotal || 0);
  setText('incomingMeta', `${incomingBaseRows.length} open orders - ${overdueIncoming} late`);

  const lowStockCount = onhandBaseRows.filter(item=>{
    const lowThreshold = Number.isFinite(Number(item.lowStockThreshold)) ? Number(item.lowStockThreshold) : DEFAULT_LOW_STOCK_THRESHOLD;
    return item.available <= lowThreshold;
  }).length;
  setText('lowStockCount', lowStockCount);

  const overdueCount = Object.keys(overdueByCode || {}).length;
  setText('overdueCount', overdueCount);
}

function exportCSV(headers, rows, filename){
  const csv=[headers.join(','),...rows.map(r=>r.map(c=>`"${String(c ?? '').replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename || 'export.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function printTable(title, headers, rows){
  const w = window.open('', '_blank');
  if(!w) return;
  const head = `<!doctype html><html><head><title>${title}</title><style>body{font-family:Arial,sans-serif;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f5f5f5}</style></head><body>`;
  const table = `<h2>${title}</h2><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  w.document.write(`${head}${table}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

function renderIncoming(){
  const tbody = document.querySelector('#incomingTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const search = (document.getElementById('incomingSearchBox')?.value || '').toLowerCase();
  let rows = incomingBaseRows.slice();
  if(search){
    rows = rows.filter(r=> r.code.toLowerCase().includes(search) || (r.jobId||'').toLowerCase().includes(search));
  }
  if(!rows.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="7" style="text-align:center;color:#6b7280;">No incoming inventory</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.sort((a,b)=> (b.lastOrderTs||0)-(a.lastOrderTs||0));
  rows.forEach(o=>{
    const job = o.jobId || '';
    const etaTs = parseDate(o.eta);
    const daysLate = etaTs ? Math.floor((Date.now() - etaTs)/(24*60*60*1000)) : null;
    const lateText = etaTs ? (daysLate > 0 ? `${daysLate}d` : '0d') : FALLBACK;
    const lateBadge = etaTs ? `<span class="badge ${daysLate > 0 ? 'warn' : 'info'}">${lateText}</span>` : FALLBACK;
    const orderedOn = o.lastOrderTs ? fmtDT(o.lastOrderTs) : FALLBACK;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${o.code}</td><td>${o.name||''}</td><td>${o.openQty}</td><td>${job||'General'}</td><td>${o.eta||FALLBACK}</td><td>${lateBadge}</td><td>${orderedOn}</td>`;
    tbody.appendChild(tr);
  });
}

function buildTagListHtml(item, threshold, staticTags){
  const tags = [];
  (staticTags || []).forEach(tag=>{
    tags.push({ text: tag, cls: 'static' });
  });
  const needsCount = item.countAge === null || item.countAge > COUNT_STALE_DAYS;
  if(item.available <= 0){
    tags.push({ text: 'Out of stock', cls: 'danger' });
  }else if(item.available <= threshold){
    tags.push({ text: 'Low stock', cls: 'warn' });
  }
  if(item.overdue) tags.push({ text: 'Overdue', cls: 'danger' });
  if(needsCount) tags.push({ text: 'Needs count', cls: 'warn' });
  if(item.jobsList && item.jobsList !== FALLBACK) tags.push({ text: 'Assigned', cls: 'info' });
  if(item.recent) tags.push({ text: 'Recent', cls: 'info' });
  if(!tags.length) tags.push({ text: 'On hand', cls: 'info' });

  return `<div class="tag-list">${tags.map(t=>`<span class="badge ${t.cls}">${t.text}</span>`).join('')}</div>`;
}

function renderOnhand(){
  const tbody=document.querySelector('#invTable tbody');
  if(!tbody) return;
  tbody.innerHTML='';
  let items = applyOnhandFilters(onhandBaseRows);
  items.sort((a,b)=> a.code.localeCompare(b.code));

  if(!items.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="11" style="text-align:center;color:#6b7280;">No inventory matches these filters</td>`;
    tbody.appendChild(tr);
    return;
  }

  items.forEach(item=>{
    const tr=document.createElement('tr');
    tr.className = 'onhand-row';
    tr.dataset.code = item.code;
    const countDate = item.countedAt ? fmtDate(item.countedAt) : FALLBACK;
    const countStale = item.countAge !== null && item.countAge > COUNT_STALE_DAYS;
    const discrepancy = item.discrepancy;
    let discrepancyHtml = FALLBACK;
    if(discrepancy !== null){
      const abs = Math.abs(discrepancy);
      const cls = abs === 0 ? 'ok' : (abs <= 2 ? 'warn' : 'bad');
      discrepancyHtml = `<span class="discrepancy-badge ${cls}">${discrepancy > 0 ? '+' : ''}${discrepancy}</span>`;
    }
    const threshold = Number.isFinite(Number(item.lowStockThreshold)) ? Number(item.lowStockThreshold) : DEFAULT_LOW_STOCK_THRESHOLD;
    const meta = itemMetaByCode.get(item.code) || {};
    const staticTags = normalizeTags(meta.tags);
    const tagHtml = buildTagListHtml(item, threshold, staticTags);
    tr.innerHTML=`
      <td>${item.code}</td>
      <td>${item.name||''}</td>
      <td>${item.available}</td>
      <td>${item.reserveQty}</td>
      <td>${item.checkedOut}</td>
      <td>${item.location || FALLBACK}</td>
      <td>${item.lastDate}</td>
      <td class="${countStale ? 'stale' : ''}">${countDate}</td>
      <td>${tagHtml}</td>
      <td class="count-input-col"><input class="count-input" data-code="${item.code}" type="number" min="0" value="${item.countedQty ?? ''}"></td>
      <td>${discrepancyHtml}</td>
    `;
    tr.addEventListener('click', (e)=>{
      if(e.target && (e.target.tagName === 'INPUT' || e.target.closest('button') || e.target.closest('a'))) return;
      openItemPanel(item);
    });

    tbody.appendChild(tr);
  });
}

function renderOverdue(){
  const tbody = document.querySelector('#overdueTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  if(!overdueRows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="7" style="text-align:center;color:#6b7280;">No overdue returns</td>`;
    tbody.appendChild(tr);
    return;
  }
  overdueRows.sort((a,b)=> b.daysLate - a.daysLate);
  overdueRows.forEach(row=>{
    const due = row.minDue ? fmtDate(row.minDue) : FALLBACK;
    const lastOut = row.lastOutTs ? fmtDT(row.lastOutTs) : FALLBACK;
    const tr=document.createElement('tr');
    tr.innerHTML = `
      <td>${row.code}</td>
      <td>${row.jobId || 'General'}</td>
      <td>${row.outstanding}</td>
      <td>${due}</td>
      <td><span class="badge warn">${row.daysLate}d</span></td>
      <td>${lastOut}</td>
      <td>
        <button class="action-btn copy-overdue" data-code="${row.code}" data-job="${row.jobId || ''}" data-qty="${row.outstanding}">Copy</button>
        <a class="action-btn return-overdue" href="inventory-operations.html#return" data-code="${row.code}">Return</a>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function setActiveTab(tab){
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.mode-content').forEach(panel=>{
    panel.classList.toggle('active', panel.id === `${tab}-tab`);
  });
}

function setupTabs(){
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> setActiveTab(btn.dataset.tab));
  });
}

function setupFilters(){
  const inputs = ['searchBox','filter-low','filter-overdue','filter-project','filter-recent','filter-count'];
  inputs.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('input', renderOnhand);
    el.addEventListener('change', renderOnhand);
  });

  const clearBtn = document.getElementById('clearFiltersBtn');
  if(clearBtn){
    clearBtn.addEventListener('click', ()=>{
      ['filter-low','filter-overdue','filter-project','filter-recent','filter-count'].forEach(id=>{
        const el = document.getElementById(id);
        if(el) el.checked = false;
      });
      const searchBox = document.getElementById('searchBox');
      if(searchBox) searchBox.value = '';
      renderOnhand();
    });
  }

  const scanMode = document.getElementById('scanMode');
  const searchBox = document.getElementById('searchBox');
  if(scanMode && searchBox){
    searchBox.addEventListener('keydown', (e)=>{
      if(e.key !== 'Enter' || !scanMode.checked) return;
      e.preventDefault();
      const scanValue = searchBox.value.trim();
      if(!scanValue) return;
      const match = onhandBaseRows.find(i=> i.code.toLowerCase() === scanValue.toLowerCase());
      if(!match){
        alert('No matching item code found');
        return;
      }
      if(!document.body.classList.contains('count-mode')){
        document.body.classList.add('count-mode');
      }
      searchBox.value = match.code;
      renderOnhand();
      const row = document.querySelector(`tr.onhand-row[data-code="${match.code}"]`);
      if(row){
        row.classList.add('row-highlight');
        setTimeout(()=> row.classList.remove('row-highlight'), 600);
        const countInput = row.querySelector('.count-input');
        if(countInput){
          const current = Number(countInput.value || 0);
          countInput.value = Number.isFinite(current) ? current + 1 : 1;
          countInput.focus();
          countInput.select();
        }
      }
      setTimeout(()=>{
        searchBox.value='';
        renderOnhand();
      }, 200);
    });
  }
}

function setupActions(){
  const exportIncoming = document.getElementById('incoming-exportBtn');
  if(exportIncoming){
    exportIncoming.addEventListener('click', ()=>{
      const rows = incomingBaseRows.map(r=>[r.code, r.name || '', r.openQty, r.jobId || 'General', r.eta || '', r.lastOrderTs ? new Date(r.lastOrderTs).toISOString() : '']);
      exportCSV(['code','name','openQty','project','eta','orderedOn'], rows, 'incoming.csv');
    });
  }

  const printIncoming = document.getElementById('incoming-printBtn');
  if(printIncoming){
    printIncoming.addEventListener('click', ()=>{
      const rows = incomingBaseRows.map(r=>[r.code, r.name || '', r.openQty, r.jobId || 'General', r.eta || '', r.lastOrderTs ? fmtDT(r.lastOrderTs) : '']);
      printTable('Incoming Inventory', ['Code','Name','Open Qty','Project','ETA','Ordered On'], rows);
    });
  }

  const exportOnhand = document.getElementById('exportOnhandBtn');
  if(exportOnhand){
    exportOnhand.addEventListener('click', ()=>{
      const rows = applyOnhandFilters(onhandBaseRows).map(i=>[i.code, i.name || '', i.available, i.reserveQty, i.checkedOut, i.lastDate]);
      exportCSV(['code','name','available','reserved','checkedOut','lastActivity'], rows, 'onhand.csv');
    });
  }

  const printOnhand = document.getElementById('printOnhandBtn');
  if(printOnhand){
    printOnhand.addEventListener('click', ()=>{
      const rows = applyOnhandFilters(onhandBaseRows).map(i=>[i.code, i.name || '', i.available, i.reserveQty, i.checkedOut, i.lastDate]);
      printTable('On-hand Inventory', ['Code','Name','Available','Reserved','Checked Out','Last Activity'], rows);
    });
  }

  const cycleToggle = document.getElementById('cycleToggle');
  if(cycleToggle){
    cycleToggle.addEventListener('click', ()=>{
      document.body.classList.toggle('count-mode');
    });
  }

  const saveBtn = document.getElementById('saveCountsBtn');
  if(saveBtn){
    saveBtn.addEventListener('click', async ()=>{
      const inputs = document.querySelectorAll('.count-input');
      const lines = [];
      inputs.forEach(input=>{
        const code = input.dataset.code;
        const val = input.value;
        if(!code || val === '') return;
        const qty = Number(val);
        if(Number.isNaN(qty)) return;
        lines.push({ code, qty });
      });
      if(!lines.length){
        alert('Enter at least one count before saving.');
        return;
      }
      const res = await saveCounts(lines);
      if(!res.ok){
        alert(res.error || 'Failed to save counts');
        return;
      }
      onhandBaseRows = computeOnhandRows(loadCountsCacheEntries());
      renderOnhand();
    });
  }

  const overdueExport = document.getElementById('overdue-exportBtn');
  if(overdueExport){
    overdueExport.addEventListener('click', ()=>{
      const rows = overdueRows.map(r=>[
        r.code,
        r.jobId || 'General',
        r.outstanding,
        r.minDue ? fmtDate(r.minDue) : '',
        r.daysLate,
        r.lastOutTs ? fmtDT(r.lastOutTs) : ''
      ]);
      exportCSV(['code','project','outstanding','dueDate','daysLate','lastCheckout'], rows, 'overdue-returns.csv');
    });
  }

  const overduePrint = document.getElementById('overdue-printBtn');
  if(overduePrint){
    overduePrint.addEventListener('click', ()=>{
      const rows = overdueRows.map(r=>[
        r.code,
        r.jobId || 'General',
        r.outstanding,
        r.minDue ? fmtDate(r.minDue) : '',
        r.daysLate,
        r.lastOutTs ? fmtDT(r.lastOutTs) : ''
      ]);
      printTable('Overdue Returns', ['Code','Project','Outstanding','Due Date','Days Late','Last Checkout'], rows);
    });
  }

  const overdueTable = document.getElementById('overdueTable');
  if(overdueTable){
    overdueTable.addEventListener('click', async (e)=>{
      const target = e.target;
      if(target && target.classList.contains('copy-overdue')){
        const code = target.dataset.code || '';
        const jobId = target.dataset.job || '';
        const qty = target.dataset.qty || '';
        const text = `Return ${qty} of ${code}${jobId ? ` for project ${jobId}` : ''}`;
        try{
          await navigator.clipboard.writeText(text);
          target.textContent = 'Copied';
          setTimeout(()=>{ target.textContent = 'Copy'; }, 1200);
        }catch(err){}
      }
    });
  }
}

function loadCountsCacheEntries(){
  return window.__cachedInventory || [];
}

async function refreshAll(){
  const ordersPromise = (window.utils && utils.fetchJsonSafe)
    ? utils.fetchJsonSafe('/api/inventory?type=ordered', {}, [])
    : fetch('/api/inventory?type=ordered').then(r=> r.ok ? r.json() : []);
  const [inventory, orders] = await Promise.all([loadEntries(), ordersPromise]);
  await Promise.all([fetchCounts(), loadItemsMeta(), loadCategoryRules(), loadClosedJobs()]);
  window.__cachedInventory = inventory;
  incomingBaseRows = buildIncomingRows(orders, inventory);
  onhandBaseRows = computeOnhandRows(inventory);
  overdueRows = buildOverdueRows(inventory);
  renderIncoming();
  renderOnhand();
  renderOverdue();
  updateSummary();
}

document.addEventListener('DOMContentLoaded',async ()=>{
  setupTabs();
  setupFilters();
  setupActions();
  setupItemPanel();
  await refreshAll();

  const incomingSearchBox = document.getElementById('incomingSearchBox');
  if(incomingSearchBox) incomingSearchBox.addEventListener('input', renderIncoming);
});


