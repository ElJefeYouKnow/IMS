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
const drawerState = {
  itemCode: null,
  activeTab: 'overview',
  role: 'employee',
  dirty: false,
  cache: {
    overview: null,
    activity: null,
    jobs: null,
    logistics: null,
    insights: null,
    settings: null
  }
};

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
    category: document.getElementById('itemPanelCategory'),
    status: document.getElementById('itemPanelStatus'),
    statusDot: document.querySelector('#itemPanelStatus .dot'),
    statusLabel: document.querySelector('#itemPanelStatus .label'),
    actions: document.getElementById('itemDrawerActions'),
    tabs: document.getElementById('itemDrawerTabs'),
    body: document.getElementById('itemDrawerBody')
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

function getUserRole(){
  const session = window.utils?.getSession?.();
  const role = (session?.role || '').toLowerCase();
  if(role === 'admin' || role === 'manager' || role === 'employee') return role;
  return 'employee';
}

function computeStatus(item, threshold){
  if(!item) return { tone: 'info', label: 'Active' };
  if(Number.isFinite(item.available) && item.available <= 0) return { tone: 'danger', label: 'Out of stock' };
  if(item.overdue) return { tone: 'warn', label: 'Overdue returns' };
  if(Number.isFinite(threshold) && Number(item.available) <= threshold) return { tone: 'warn', label: 'Low stock' };
  if(item.recent) return { tone: 'info', label: 'Recently active' };
  return { tone: 'info', label: 'Active' };
}

function computeReorderStatus({ available, reorderPoint, inTransit, discrepancyUnits }){
  const avail = Number(available);
  const reorder = Number(reorderPoint);
  const disc = Number(discrepancyUnits);
  const transit = Number(inTransit);
  if(Number.isFinite(avail) && avail <= 0 && Number.isFinite(transit) && transit > 0) return { label:'In Transit', tone:'info' };
  if((Number.isFinite(avail) && avail <= 0) || (Number.isFinite(disc) && disc !== 0)) return { label:'Critical', tone:'danger' };
  if(Number.isFinite(avail) && Number.isFinite(reorder) && avail <= reorder) return { label:'Attention', tone:'warn' };
  return { label:'Healthy', tone:'success' };
}

function qtyCell(label, val, tooltip){
  const num = Number(val);
  const isNumber = Number.isFinite(num);
  const display = isNumber ? num : (val ?? '—');
  const cls = ['qty-cell'];
  if(isNumber && num < 0) cls.push('neg');
  else if(isNumber && num === 0) cls.push('zero');
  const tip = tooltip ? ` title="${tooltip}"` : '';
  return `<div class="${cls.join(' ')}"><span class="qty-label">${label}<span class="help-dot"${tip}>?</span></span><strong>${display}</strong></div>`;
}

function formatLastEvent(ev){
  if(!ev) return '—';
  const type = ev.type || 'Event';
  const ts = ev.timestamp || ev.ts || '';
  const user = ev.user || ev.userEmail || '';
  const when = ts ? fmtDT(ts) : '—';
  return `${type} · ${when}${user ? ' · ' + user : ''}`;
}

function renderDrawerHeader(item, meta, role, data){
  const els = getItemPanelEls();
  if(!els) return;
  const category = item.category || DEFAULT_CATEGORY_NAME;
  if(els.title) els.title.textContent = item.code || 'Item';
  if(els.name) els.name.textContent = item.name || 'Unnamed item';
  if(els.category) els.category.textContent = category;
  const status = computeStatus(item, data?.threshold);
  if(els.statusLabel) els.statusLabel.textContent = status.label || '-';
  if(els.status){
    els.status.classList.remove('warn','danger');
    if(status.tone === 'warn') els.status.classList.add('warn');
    if(status.tone === 'danger') els.status.classList.add('danger');
  }
  if(els.statusDot){
    els.statusDot.style.background = status.tone === 'danger' ? '#ef4444' : status.tone === 'warn' ? '#f59e0b' : '#22c55e';
  }

  if(els.actions){
    els.actions.innerHTML = '';
    const makeBtn = (label, cls, handler)=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `action-btn ${cls || ''}`.trim();
      btn.textContent = label;
      btn.addEventListener('click', handler);
      return btn;
    };
    els.actions.appendChild(makeBtn('Check Out', 'primary', ()=> window.location.href='inventory-operations.html?mode=checkout'));
    els.actions.appendChild(makeBtn('Reserve', 'outline', ()=> window.location.href='order-register.html#reserve'));
    if(role === 'manager' || role === 'admin'){
      els.actions.appendChild(makeBtn('Adjust', '', ()=> window.location.href='inventory-operations.html?mode=checkin'));
    }
  }
}

function allowedTabsForRole(role){
  const base = ['overview','activity','jobs','insights'];
  if(role === 'manager' || role === 'admin') base.push('logistics');
  if(role === 'admin') base.push('settings');
  return base;
}

function renderDrawerTabs(role){
  const els = getItemPanelEls();
  if(!els?.tabs) return;
  const tabs = allowedTabsForRole(role);
  if(!tabs.includes(drawerState.activeTab)) drawerState.activeTab = 'overview';
  const labels = { overview:'Overview', activity:'Activity', jobs:'Jobs', logistics:'Logistics', insights:'Insights', settings:'Settings' };
  els.tabs.innerHTML = '';
  tabs.forEach(key=>{
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drawer-tab';
    if(drawerState.activeTab === key) btn.classList.add('active');
    btn.dataset.tab = key;
    btn.textContent = labels[key] || key;
    els.tabs.appendChild(btn);
  });
}

function renderTabOverview(data){
  const item = data?.item || {};
  const states = data?.states || {};
  const summary = data?.summary || {};
  const meta = data?.meta || {};
  const availability = Number.isFinite(states.available) ? states.available : null;
  const status = computeReorderStatus({
    available: availability,
    reorderPoint: summary.reorderPoint,
    inTransit: states.inTransit,
    discrepancyUnits: summary.discrepancyUnits
  });
  const reorderBadge = `<span class="status-chip ${status.tone === 'danger' ? 'danger' : status.tone === 'warn' ? 'warn' : 'success'}"><span class="dot"></span><span class="label">${status.label}</span></span>`;
  const qtyTips = {
    onHand:'Total physical units across locations.',
    available:'Units free to allocate (on hand minus reserved/issued).',
    reserved:'Units held for projects/orders.',
    checkedOut:'Units currently issued/picked.',
    inTransit:'Units on open POs not yet received.',
    damaged:'Units marked damaged/unusable.',
    returned:'Units recently returned.'
  };
  const qtyGrid = `
    <div class="qty-grid">
      ${qtyCell('On Hand', states.onHand ?? states.available ?? 0, qtyTips.onHand)}
      ${qtyCell('Available', states.available ?? 0, qtyTips.available)}
      ${qtyCell('Reserved', states.reserved ?? 0, qtyTips.reserved)}
      ${qtyCell('Checked Out', states.checkedOut ?? 0, qtyTips.checkedOut)}
      ${qtyCell('In Transit', states.inTransit ?? 0, qtyTips.inTransit)}
      ${qtyCell('Damaged', states.damaged ?? 0, qtyTips.damaged)}
      ${qtyCell('Returned', states.returned ?? 0, qtyTips.returned)}
    </div>
  `;
  const estDays = (Number.isFinite(states.available) && Number.isFinite(summary.avgDailyUsage) && summary.avgDailyUsage > 0)
    ? Math.max(0, Math.round(states.available / summary.avgDailyUsage))
    : '—';
  const lastActivity = formatLastEvent(summary.lastActivity);
  const lastCount = summary.lastCount ? `${fmtDate(summary.lastCount.date || summary.lastCount)}${summary.lastCount.user ? ' · ' + summary.lastCount.user : ''}` : '—';
  const discUnits = summary.discrepancyUnits;
  const discVal = summary.discrepancyValue;
  const discLabel = discUnits === undefined || discUnits === null
    ? '—'
    : `${discUnits > 0 ? '+' : ''}${discUnits}${discVal ? ` (${discVal})` : ''}`;

  return `
    <div class="panel-section">
      <h3>Quantity States</h3>
      ${qtyGrid}
    </div>
    <div class="panel-section">
      <h3>Reorder &amp; Health</h3>
      <div class="reorder-row">
        <div class="reorder-field"><span>Reorder Point</span><strong>${summary.reorderPoint ?? '—'}</strong></div>
        <div class="reorder-field"><span>Minimum Stock</span><strong>${summary.minStock ?? '—'}</strong></div>
        <div class="reorder-field"><span>Reorder Status</span>${reorderBadge}</div>
        <div class="reorder-field"><span>Est. Days of Stock</span><strong>${estDays}</strong></div>
      </div>
    </div>
    <div class="panel-section">
      <h3>Last Control Events</h3>
      <div class="panel-list compact">
        <div class="panel-row"><span>Last Activity</span><strong>${lastActivity}</strong></div>
        <div class="panel-row"><span>Last Physical Count</span><strong>${lastCount}</strong></div>
        <div class="panel-row"><span>Discrepancy</span><strong>${discLabel}</strong></div>
      </div>
      <a class="muted-link" data-action="view-activity" href="#activity">View full activity</a>
    </div>
  `;
}

function renderTabActivity(data){
  const lastActivity = data?.lastDate || FALLBACK;
  const lastCount = data?.lastCount || FALLBACK;
  const countedQty = data?.countedQty ?? FALLBACK;
  const discrepancy = data?.discrepancy ?? FALLBACK;
  const countAge = data?.countAge ?? null;
  const ageLabel = Number.isFinite(countAge) ? `${countAge} days ago` : FALLBACK;
  return `
    <div class="panel-section">
      <h3>Recent Activity</h3>
      <div class="panel-list">
        <div class="panel-row"><span>Last Movement</span><strong>${lastActivity}</strong></div>
        <div class="panel-row"><span>Last Count</span><strong>${lastCount}</strong></div>
        <div class="panel-row"><span>Counted Qty</span><strong>${countedQty}</strong></div>
        <div class="panel-row"><span>Discrepancy</span><strong>${discrepancy}</strong></div>
        <div class="panel-row"><span>Count Age</span><strong>${ageLabel}</strong></div>
      </div>
    </div>
  `;
}

function renderTabJobs(data){
  const checked = data?.jobs?.checked || [];
  const reserved = data?.jobs?.reserved || [];
  const renderList = (rows, empty)=>{
    if(!rows.length) return `<div class="job-empty">${empty}</div>`;
    return `<div class="job-breakdown">${rows.map(r=>`<div class="job-row"><span>${r.jobId || 'General'}</span><span>${r.label}</span></div>`).join('')}</div>`;
  };
  return `
    <div class="panel-section">
      <h3>Checked Out</h3>
      ${renderList(checked, 'No active job checkouts.')}
    </div>
    <div class="panel-section">
      <h3>Reserved</h3>
      ${renderList(reserved, 'No active reservations.')}
    </div>
  `;
}

function renderTabLogistics(data){
  const threshold = data?.threshold ?? FALLBACK;
  const overdue = data?.flags?.overdue ? 'Yes' : 'No';
  const lowStock = data?.flags?.lowStock ? 'Yes' : 'No';
  const allowReserve = data?.flags?.allowReserve === false ? 'No' : 'Yes';
  return `
    <div class="panel-section">
      <h3>Logistics</h3>
      <div class="panel-list">
        <div class="panel-row"><span>Low Stock Threshold</span><strong>${threshold}</strong></div>
        <div class="panel-row"><span>Low Stock</span><strong>${lowStock}</strong></div>
        <div class="panel-row"><span>Overdue Returns</span><strong>${overdue}</strong></div>
        <div class="panel-row"><span>Allow Reserve</span><strong>${allowReserve}</strong></div>
      </div>
    </div>
  `;
}

function renderTabInsights(data){
  const points = [];
  if(data?.flags?.lowStock) points.push('Low stock — consider replenishing soon.');
  if(data?.flags?.overdue) points.push('Overdue returns detected.');
  if(data?.flags?.recent) points.push('Recently active item.');
  if(data?.countAge && data.countAge > COUNT_STALE_DAYS) points.push('Counts are stale — recalc recommended.');
  if(!points.length) points.push('No insights yet. All clear.');
  return `
    <div class="panel-section">
      <h3>Insights</h3>
      <ul class="panel-note" style="padding-left:18px;line-height:1.5;">
        ${points.map(p=>`<li>${p}</li>`).join('')}
      </ul>
    </div>
  `;
}

function renderTabSettings(data){
  const meta = data?.meta || {};
  return `
    <div class="panel-section">
      <h3>Settings</h3>
      <p class="panel-note">Admin controls for this item.</p>
      <div class="panel-list">
        <div class="panel-row"><span>Category</span><strong>${meta.category || data?.item?.category || DEFAULT_CATEGORY_NAME}</strong></div>
        <div class="panel-row"><span>Low Stock Threshold</span><strong>${data?.threshold ?? FALLBACK}</strong></div>
        <div class="panel-row"><span>Description</span><strong>${(meta.description || '').toString().trim() || FALLBACK}</strong></div>
      </div>
      <p class="panel-note">Use Catalog to edit full item details.</p>
    </div>
  `;
}

function setActiveTab(key){
  const els = getItemPanelEls();
  if(!els?.tabs || !els?.body || !drawerState.data) return;
  const tabs = allowedTabsForRole(drawerState.role);
  const nextKey = tabs.includes(key) ? key : 'overview';
  drawerState.activeTab = nextKey;
  els.tabs.querySelectorAll('.drawer-tab').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === nextKey);
  });
  let content = '';
  if(nextKey === 'overview') content = renderTabOverview(drawerState.data);
  else if(nextKey === 'activity') content = renderTabActivity(drawerState.data);
  else if(nextKey === 'jobs') content = renderTabJobs(drawerState.data);
  else if(nextKey === 'logistics') content = renderTabLogistics(drawerState.data);
  else if(nextKey === 'insights') content = renderTabInsights(drawerState.data);
  else if(nextKey === 'settings') content = renderTabSettings(drawerState.data);
  els.body.innerHTML = content;
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
  const lowStockCfg = getLowStockConfigForCode(item.code);
  const threshold = Number.isFinite(lowStockCfg?.threshold) ? lowStockCfg.threshold : DEFAULT_LOW_STOCK_THRESHOLD;
  const countDate = item.countedAt ? fmtDate(item.countedAt) : FALLBACK;
  const countedQty = item.countedQty !== null && item.countedQty !== undefined ? item.countedQty : FALLBACK;
  const discrepancy = item.discrepancy !== null && item.discrepancy !== undefined
    ? `${item.discrepancy > 0 ? '+' : ''}${item.discrepancy}`
    : FALLBACK;
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
  const role = getUserRole();
  const allowReserve = (categoryRulesByName.get((item.category || '').toLowerCase()) || {}).allowReserve;
  drawerState.data = {
    item,
    meta,
    tags: staticTags,
    stats: { available: item.available, reserved: item.reserveQty, checkedOut: item.checkedOut },
    threshold,
    lastDate: item.lastDate || FALLBACK,
    lastCount: countDate,
    countedQty,
    discrepancy,
    countAge: item.countAge ?? (item.countedAt ? daysBetween(item.countedAt) : null),
    jobs: { checked: outRows, reserved: reserveRows },
    flags: {
      lowStock: Number.isFinite(threshold) && Number(item.available) <= threshold,
      overdue: !!item.overdue,
      recent: !!item.recent,
      allowReserve: allowReserve !== undefined ? !!allowReserve : true
    }
  };
  drawerState.role = role;
  drawerState.activeTab = 'overview';
  renderDrawerHeader(item, meta, role, drawerState.data);
  renderDrawerTabs(role);
  setActiveTab('overview');
  setPanelOpen(true);
}

function closeItemPanel(){
  if(drawerState.dirty){
    const proceed = confirm('You have unsaved changes. Close anyway?');
    if(!proceed) return;
  }
  setPanelOpen(false);
  drawerState.dirty = false;
}

function setupItemPanel(){
  const els = getItemPanelEls();
  if(!els) return;
  if(els.close) els.close.addEventListener('click', closeItemPanel);
  if(els.backdrop) els.backdrop.addEventListener('click', closeItemPanel);
  if(els.tabs){
    els.tabs.addEventListener('click', (event)=>{
      const btn = event.target.closest('.drawer-tab');
      if(!btn) return;
      setActiveTab(btn.dataset.tab);
    });
  }
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
    lowStockThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
    lowStockEnabled: true
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
  if(Object.prototype.hasOwnProperty.call(input, 'lowStockEnabled')){
    out.lowStockEnabled = !!input.lowStockEnabled;
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

function parseBool(value){
  if(value === undefined || value === null || value === '') return null;
  if(typeof value === 'boolean') return value;
  const cleaned = value.toString().trim().toLowerCase();
  if(!cleaned) return null;
  if(['false','0','no','off','disabled'].includes(cleaned)) return false;
  if(['true','1','yes','on','enabled'].includes(cleaned)) return true;
  return null;
}

function getLowStockConfigForCode(code){
  const item = itemMetaByCode.get(code);
  const name = (item?.category || DEFAULT_CATEGORY_NAME || '').toString().trim();
  const rules = categoryRulesByName.get(name.toLowerCase());
  const threshold = rules?.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  const itemEnabled = parseBool(item?.lowStockEnabled ?? item?.lowstockenabled);
  const enabled = itemEnabled === null ? (rules?.lowStockEnabled ?? true) : itemEnabled;
  return { threshold, enabled };
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
  if(window.utils?.formatDateTime) return utils.formatDateTime(val);
  if(!val) return FALLBACK;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? FALLBACK : d.toLocaleString([], { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function fmtDate(val){
  if(window.utils?.formatDateOnly) return utils.formatDateOnly(val);
  if(!val) return FALLBACK;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? FALLBACK : d.toLocaleDateString([], { year:'numeric', month:'short', day:'2-digit' });
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
    const { threshold, enabled } = getLowStockConfigForCode(s.code);
    return {
      ...s,
      jobsList: activeJobs.length ? activeJobs.sort().join(', ') : FALLBACK,
      checkedOut,
      available,
      category: itemMetaByCode.get(s.code)?.category || DEFAULT_CATEGORY_NAME,
      lowStockThreshold: threshold,
      lowStockEnabled: enabled,
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
    if(low && (item.lowStockEnabled === false || item.available > lowThreshold)) return false;
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
    return item.lowStockEnabled !== false && item.available <= lowThreshold;
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
  if(item.lowStockEnabled === false){
    tags.push({ text: 'Alerts off', cls: 'static' });
  }else{
    if(item.available <= 0){
      tags.push({ text: 'Out of stock', cls: 'danger' });
    }else if(item.available <= threshold){
      tags.push({ text: 'Low stock', cls: 'warn' });
    }
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
