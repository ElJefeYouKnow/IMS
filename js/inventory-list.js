const FALLBACK = 'N/A';
const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const DEFAULT_CATEGORY_NAME = 'Uncategorized';
const COUNT_STALE_DAYS = 30;
const RECENT_DAYS = 3;
const CLOSED_JOB_STATUSES = new Set(['complete', 'completed', 'closed', 'archived', 'cancelled', 'canceled']);
const CACHE_KEY = 'ims.inventory.cache.v1';

let incomingBaseRows = [];
let onhandBaseRows = [];
let overdueByCode = {};
let overdueRows = [];
let countCache = {};
let itemMetaByCode = new Map();
let categoryRulesByName = new Map();
let closedJobIds = new Set();
let itemPanelEls = null;
let lastSyncTs = null;

function haptic(kind){
  if(!navigator.vibrate) return;
  const patterns = {
    light: [10],
    success: [15, 30, 15],
    error: [30, 40, 30]
  };
  navigator.vibrate(patterns[kind] || patterns.light);
}

function readCache(){
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){
    return null;
  }
}

function writeCache(payload){
  try{
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  }catch(e){}
}

function updateSyncStatus(offline, ts){
  const el = document.getElementById('syncStatus');
  if(!el) return;
  if(ts) lastSyncTs = ts;
  if(offline){
    const label = lastSyncTs ? `Offline · Last sync ${fmtDate(lastSyncTs)}` : 'Offline';
    el.textContent = label;
    el.classList.add('offline');
  }else{
    const label = lastSyncTs ? `Online · Synced ${fmtDate(lastSyncTs)}` : 'Online';
    el.textContent = label;
    el.classList.remove('offline');
  }
}
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

function computeStatus(item, threshold, lowStockEnabled){
  if(!item) return { tone: 'info', label: 'Active' };
  if(Number.isFinite(item.available) && item.available <= 0) return { tone: 'danger', label: 'Out of stock' };
  if(item.overdue) return { tone: 'warn', label: 'Overdue returns' };
  if(lowStockEnabled !== false && Number.isFinite(threshold) && Number(item.available) <= threshold) return { tone: 'warn', label: 'Low stock' };
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
  const status = computeStatus(item, data?.threshold, data?.lowStockEnabled);
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
  const cache = data || { records: [], filters: {}, loading: true, page:1, hasMore:false };
  const filters = cache.filters || {};
  const records = cache.records || [];
  const loading = cache.loading;
  const rows = records.map(r=>{
    const when = fmtDT(r.ts || r.timestamp);
    const qty = r.qty ?? '—';
    const from = r.from || r.source || '';
    const to = r.to || r.destination || '';
    const related = r.related || r.jobId || r.po || '';
    const reason = r.reason || '';
    const user = r.user || r.userEmail || '';
    return `<tr>
      <td>${when}</td>
      <td>${(r.type || '').toUpperCase()}</td>
      <td>${qty}</td>
      <td>${from || '—'}${to ? ` → ${to}` : ''}</td>
      <td>${related || '—'}</td>
      <td>${user || '—'}</td>
      <td>${reason || '—'}</td>
    </tr>`;
  }).join('');
  return `
    <div class="panel-section">
      <div class="filters-row">
        <select id="activity-range">
          <option value="7" ${filters.range==='7'?'selected':''}>Last 7 days</option>
          <option value="30" ${filters.range==='30'?'selected':''}>Last 30 days</option>
          <option value="90" ${filters.range==='90'?'selected':''}>Last 90 days</option>
          <option value="custom" ${filters.range==='custom'?'selected':''}>Custom</option>
        </select>
        <select id="activity-type">
          <option value="">All Types</option>
          ${['IN','OUT','RESERVE','RETURN','ADJUST','TRANSFER'].map(t=>`<option value="${t}" ${filters.type===t?'selected':''}>${t}</option>`).join('')}
        </select>
        <input id="activity-search" type="search" placeholder="Search job, PO, user, reason" value="${filters.search || ''}">
      </div>
      <div class="panel-table-wrap">
        <table class="drawer-table">
          <thead><tr><th>Date/Time</th><th>Type</th><th>Qty</th><th>From → To</th><th>Related</th><th>User</th><th>Reason</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="muted-text">No activity yet.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="pager-row">
        ${loading ? '<span class="muted-text">Loading...</span>' : ''}
        ${cache.hasMore ? '<button id="activity-loadMore" type="button" class="muted">Load more</button>' : ''}
      </div>
    </div>
  `;
}

function renderTabJobs(data){
  const cache = data || { active: [], history: [], filters: {} };
  const filters = cache.filters || {};
  const activeRows = cache.active.map(r=>`
    <tr data-job="${r.jobId || ''}" class="${r.canNavigate ? 'job-link' : ''}">
      <td>${r.jobId || '—'}</td>
      <td>${r.project || r.customer || '—'}</td>
      <td>${r.reservedQty ?? '—'}</td>
      <td>${r.issuedQty ?? '—'}</td>
      <td>${r.status || '—'}</td>
    </tr>
  `).join('');
  const historyRows = cache.history.map(r=>`
    <tr data-job="${r.jobId || ''}" class="${r.canNavigate ? 'job-link' : ''}">
      <td>${r.jobId || '—'}</td>
      <td>${r.usedQty ?? '—'}</td>
      <td>${r.returnedQty ?? '—'}</td>
      <td>${r.variance ?? '—'}</td>
      <td>${r.closedDate ? fmtDate(r.closedDate) : '—'}</td>
    </tr>
  `).join('');
  return `
    <div class="panel-section">
      <div class="filters-row">
        <select id="jobs-status">
          <option value="open" ${filters.status==='open'?'selected':''}>Open</option>
          <option value="closed" ${filters.status==='closed'?'selected':''}>Closed</option>
          <option value="all" ${filters.status==='all'?'selected':''}>All</option>
        </select>
        <select id="jobs-range">
          <option value="30" ${filters.range==='30'?'selected':''}>30 days</option>
          <option value="90" ${filters.range==='90'?'selected':''}>90 days</option>
          <option value="365" ${filters.range==='365'?'selected':''}>365 days</option>
        </select>
      </div>
      <h4 class="subhead">Active Allocations</h4>
      <div class="panel-table-wrap">
        <table class="drawer-table">
          <thead><tr><th>Job ID</th><th>Project</th><th>Reserved Qty</th><th>Issued Qty</th><th>Status</th></tr></thead>
          <tbody>${activeRows || '<tr><td colspan="5" class="muted-text">No active allocations.</td></tr>'}</tbody>
        </table>
      </div>
      <h4 class="subhead">Historical Usage</h4>
      <div class="panel-table-wrap">
        <table class="drawer-table">
          <thead><tr><th>Job ID</th><th>Used Qty</th><th>Returned Qty</th><th>Variance</th><th>Closed</th></tr></thead>
          <tbody>${historyRows || '<tr><td colspan="5" class="muted-text">No history.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderTabLogistics(data){
  if(!data) return `<div class="panel-section"><p class="panel-note">No supplier/PO history yet.</p></div>`;
  const suppliers = data.suppliers || {};
  const lead = suppliers.leadTime || {};
  const alt = (suppliers.alternates || []).filter(Boolean).join(', ');
  const history = (data.procurementHistory || []).slice(0,5).map(po=>`
    <tr><td>${po.po || '—'}</td><td>${po.orderDate ? fmtDate(po.orderDate) : '—'}</td><td>${po.expected ? fmtDate(po.expected) : '—'}</td><td>${po.received ?? '—'}</td><td>${po.fillRate ?? '—'}</td><td>${po.variance ?? '—'}</td></tr>
  `).join('');
  const transit = (data.inTransit || []).map(po=>`
    <tr><td>${po.po || '—'}</td><td>${po.qty ?? '—'}</td><td>${po.expected ? fmtDate(po.expected) : '—'}</td><td><span class="status-chip ${po.risk === 'Late' ? 'warn' : 'success'}"><span class="dot"></span><span class="label">${po.risk || 'On Track'}</span></span></td></tr>
  `).join('');
  const canEdit = drawerState.role === 'admin';
  return `
    <div class="panel-section">
      <h3>Supplier Overview</h3>
      <div class="panel-list">
        <div class="panel-row logistic-row" data-field="preferred">
          <span>Preferred Supplier</span>
          <div class="edit-wrap"><strong>${suppliers.preferred || '—'}</strong>${canEdit ? '<input class="edit-input" type="text" style="display:none;" value="'+(suppliers.preferred||'')+'"><button type="button" class="muted-link edit-log" data-field="preferred">✎</button><button type="button" class="muted-link save-log" data-field="preferred" style="display:none;">Save</button>' : ''}</div>
        </div>
        <div class="panel-row"><span>Alternate Suppliers</span><strong>${alt || '—'}</strong></div>
        <div class="panel-row"><span>Lead Time (avg/min/max)</span><strong>${lead.avg ?? '—'}/${lead.min ?? '—'}/${lead.max ?? '—'}</strong></div>
        <div class="panel-row logistic-row" data-field="moq">
          <span>MOQ</span>
          <div class="edit-wrap"><strong>${suppliers.moq ?? '—'}</strong>${canEdit ? '<input class="edit-input" type="number" min="0" style="display:none;" value="'+(suppliers.moq ?? '')+'"><button type="button" class="muted-link edit-log" data-field="moq">✎</button><button type="button" class="muted-link save-log" data-field="moq" style="display:none;">Save</button>' : ''}</div>
        </div>
      </div>
    </div>
    <div class="panel-section">
      <h3>Procurement History (last 5)</h3>
      <div class="panel-table-wrap">
        <table class="drawer-table"><thead><tr><th>PO#</th><th>Order</th><th>Expected</th><th>Received</th><th>Fill Rate</th><th>Variance</th></tr></thead><tbody>${history || '<tr><td colspan="6" class="muted-text">No history.</td></tr>'}</tbody></table>
      </div>
    </div>
    <div class="panel-section">
      <h3>In Transit</h3>
      <div class="panel-table-wrap">
        <table class="drawer-table"><thead><tr><th>PO#</th><th>Qty</th><th>Expected</th><th>Risk</th></tr></thead><tbody>${transit || '<tr><td colspan="4" class="muted-text">No in-transit POs.</td></tr>'}</tbody></table>
      </div>
    </div>
  `;
}

function renderTabInsights(data){
  const velocity = data?.velocity || {};
  const perf = data?.performance || {};
  const risk = data?.risk || {};
  const doh = (Number.isFinite(perf.available) && Number.isFinite(velocity.avg30) && velocity.avg30 > 0)
    ? Math.round(perf.available / velocity.avg30)
    : '—';
  return `
    <div class="panel-section">
      <h3>Velocity</h3>
      <div class="panel-list">
        <div class="panel-row"><span>Avg Daily (7)</span><strong>${velocity.avg7 ?? '—'}</strong></div>
        <div class="panel-row"><span>Avg Daily (30)</span><strong>${velocity.avg30 ?? '—'}</strong></div>
        <div class="panel-row"><span>Avg Daily (90)</span><strong>${velocity.avg90 ?? '—'}</strong></div>
      </div>
    </div>
    <div class="panel-section">
      <h3>Performance</h3>
      <div class="panel-list">
        <div class="panel-row"><span>Days on Hand</span><strong>${doh}</strong></div>
        <div class="panel-row"><span>Dead Stock (90+)</span><strong>${perf.deadStock ? 'Yes' : 'No'}</strong></div>
        <div class="panel-row"><span>Slow Mover</span><strong>${perf.slowMover ? 'Yes' : 'No'}</strong></div>
      </div>
    </div>
    <div class="panel-section">
      <h3>Risk</h3>
      <div class="panel-list">
        <div class="panel-row"><span>Stockouts (90d)</span><strong>${risk.stockouts ?? '—'}</strong></div>
        <div class="panel-row"><span>Adjustments (30d)</span><strong>${risk.adjustments ?? '—'}</strong></div>
      </div>
    </div>
  `;
}

function renderTabSettings(data){
  const meta = data?.meta || {};
  return `
    <form id="drawerSettingsForm" class="panel-section">
      <h3>Identity</h3>
      <div class="form-row">
        <label style="flex:1;">Name<input name="name" value="${meta.name || ''}" required></label>
        <label style="flex:1;">Category<input name="category" value="${meta.category || ''}" required></label>
      </div>
      <div class="form-row">
        <label style="flex:1;">Description<input name="description" value="${meta.description || ''}"></label>
        <label style="flex:1;">Unit of Measure<input name="uom" value="${meta.uom || meta.unit || ''}" required></label>
      </div>
      <h3>Control Flags</h3>
      <div class="form-row">
        <label class="toggle-inline"><input type="checkbox" name="serialized" ${meta.serialized ? 'checked' : ''}> Serialized</label>
        <label class="toggle-inline"><input type="checkbox" name="lot" ${meta.lot ? 'checked' : ''}> Lot/Batch</label>
        <label class="toggle-inline"><input type="checkbox" name="expires" ${meta.expires ? 'checked' : ''}> Expiration</label>
      </div>
      <h3>Storage Defaults</h3>
      <div class="form-row">
        <label style="flex:1;">Warehouse<input name="warehouse" value="${meta.warehouse || ''}"></label>
        <label style="flex:1;">Zone<input name="zone" value="${meta.zone || ''}"></label>
        <label style="flex:1;">Bin<input name="bin" value="${meta.bin || ''}"></label>
      </div>
      <h3>Reorder Rules</h3>
      <div class="form-row">
        <label style="flex:1;">Reorder Point<input name="reorderPoint" type="number" min="0" value="${meta.reorderPoint ?? ''}"></label>
        <label style="flex:1;">Minimum Stock<input name="minStock" type="number" min="0" value="${meta.minStock ?? ''}"></label>
      </div>
      <div class="form-row" style="justify-content:flex-end;">
        <span id="drawerSettingsMsg" class="muted-text"></span>
        <button type="submit" class="action-btn primary">Save</button>
      </div>
    </form>
  `;
}

async function ensureTabData(tab){
  const code = drawerState.itemCode;
  if(!code) return;
  if(tab === 'activity'){
    if(drawerState.cache.activity && !drawerState.cache.activity.refresh) return;
    const existing = drawerState.cache.activity || { filters:{ range:'30', type:'', search:'', page:1 }, records:[], hasMore:false };
    drawerState.cache.activity = { ...existing, loading:true };
    const res = await loadActivity(code, existing.filters);
    drawerState.cache.activity = { ...existing, ...res, loading:false, refresh:false };
  }else if(tab === 'jobs'){
    if(drawerState.cache.jobs && !drawerState.cache.jobs.refresh) return;
    const filters = drawerState.cache.jobs?.filters || { status:'open', range:'30' };
    const res = await loadJobs(code, filters);
    drawerState.cache.jobs = { ...res, filters, refresh:false };
  }else if(tab === 'logistics'){
    if(drawerState.cache.logistics && !drawerState.cache.logistics.refresh) return;
    const res = await loadLogistics(code);
    drawerState.cache.logistics = res || null;
  }else if(tab === 'insights'){
    if(drawerState.cache.insights && !drawerState.cache.insights.refresh) return;
    const res = await loadInsights(code);
    drawerState.cache.insights = res || {};
  }else if(tab === 'settings'){
    if(drawerState.cache.settings && !drawerState.cache.settings.refresh) return;
    drawerState.cache.settings = { meta: drawerState.cache.overview?.meta || {}, item: drawerState.cache.overview?.item || {} };
  }
}

function bindTabEvents(tab){
  const els = getItemPanelEls();
  if(!els?.body) return;
  if(tab === 'overview'){
    els.body.querySelector('[data-action="view-activity"]')?.addEventListener('click',(e)=>{e.preventDefault(); setActiveTab('activity');});
  }else if(tab === 'activity'){
    const getFilters=()=>{
      const range = els.body.querySelector('#activity-range')?.value || '30';
      const type = els.body.querySelector('#activity-type')?.value || '';
      const search = els.body.querySelector('#activity-search')?.value || '';
      return { range, type, search, page:1 };
    };
    ['change','input'].forEach(ev=>{
      els.body.querySelector('#activity-range')?.addEventListener(ev, async ()=>{
        drawerState.cache.activity = { ...drawerState.cache.activity, filters: getFilters(), refresh:true };
        await setActiveTab('activity');
      });
      els.body.querySelector('#activity-type')?.addEventListener(ev, async ()=>{
        drawerState.cache.activity = { ...drawerState.cache.activity, filters: getFilters(), refresh:true };
        await setActiveTab('activity');
      });
    });
    els.body.querySelector('#activity-search')?.addEventListener('change', async ()=>{
      drawerState.cache.activity = { ...drawerState.cache.activity, filters: getFilters(), refresh:true };
      await setActiveTab('activity');
    });
    els.body.querySelector('#activity-loadMore')?.addEventListener('click', async ()=>{
      const filters = { ...(drawerState.cache.activity?.filters||{}), page:(drawerState.cache.activity?.filters?.page||1)+1 };
      const res = await loadActivity(drawerState.itemCode, filters);
      drawerState.cache.activity = {
        ...drawerState.cache.activity,
        filters,
        records: [...(drawerState.cache.activity?.records||[]), ...(res.records||[])],
        hasMore: res.hasMore
      };
      await setActiveTab('activity');
    });
  }else if(tab === 'jobs'){
    const body = els.body;
    body.querySelector('#jobs-status')?.addEventListener('change', async (e)=>{
      const filters = { ...(drawerState.cache.jobs?.filters||{}), status: e.target.value };
      drawerState.cache.jobs = { ...drawerState.cache.jobs, filters, refresh:true };
      await setActiveTab('jobs');
    });
    body.querySelector('#jobs-range')?.addEventListener('change', async (e)=>{
      const filters = { ...(drawerState.cache.jobs?.filters||{}), range: e.target.value };
      drawerState.cache.jobs = { ...drawerState.cache.jobs, filters, refresh:true };
      await setActiveTab('jobs');
    });
    body.querySelectorAll('.job-link').forEach(row=>{
      row.addEventListener('click', ()=>{
        const jobId = row.dataset.job;
        if(jobId) window.location.href = `job-creator.html#${encodeURIComponent(jobId)}`;
      });
    });
  }else if(tab === 'settings'){
    const form = els.body.querySelector('#drawerSettingsForm');
    if(form){
      form.addEventListener('input', ()=>{ drawerState.dirty = true; });
      form.addEventListener('submit', async (e)=>{
        e.preventDefault();
        const formData = new FormData(form);
        const payload = {};
        formData.forEach((val,key)=>{
          if(['serialized','lot','expires'].includes(key)) payload[key] = form.querySelector(`[name="${key}"]`).checked;
          else payload[key] = val;
        });
        if(!payload.name || !payload.category || !payload.uom){
          const msg = form.querySelector('#drawerSettingsMsg'); if(msg) msg.textContent = 'Name, category, and UOM are required.'; return;
        }
        const numFields = ['reorderPoint','minStock'];
        for(const f of numFields){
          if(payload[f] === '') continue;
          const n = Number(payload[f]);
          if(!Number.isFinite(n) || n < 0){
            const msg = form.querySelector('#drawerSettingsMsg'); if(msg) msg.textContent = `${f} must be 0 or greater.`; return;
          }
          payload[f] = n;
        }
        const ok = await saveSettings(drawerState.itemCode, payload);
        const msg = form.querySelector('#drawerSettingsMsg');
        if(ok){
          drawerState.dirty = false;
          drawerState.cache.settings = { ...drawerState.cache.settings, meta: { ...drawerState.cache.settings.meta, ...payload } };
          if(msg) msg.textContent = 'Saved';
        }else{
          if(msg) msg.textContent = 'Save failed';
        }
      });
    }
  }else if(tab === 'logistics' && drawerState.role === 'admin'){
    els.body.querySelectorAll('.edit-log').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const row = btn.closest('.logistic-row');
        if(!row) return;
        row.querySelector('strong').style.display = 'none';
        const input = row.querySelector('.edit-input'); if(input){ input.style.display='inline-block'; input.focus(); }
        btn.style.display = 'none';
        const save = row.querySelector('.save-log'); if(save) save.style.display='inline-block';
      });
    });
    els.body.querySelectorAll('.save-log').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const field = btn.dataset.field;
        const row = btn.closest('.logistic-row');
        const input = row?.querySelector('.edit-input');
        const value = input?.value || '';
        const ok = await saveLogistics(drawerState.itemCode, field, value);
        if(ok){
          drawerState.cache.logistics = drawerState.cache.logistics || { suppliers:{} };
          drawerState.cache.logistics.suppliers = drawerState.cache.logistics.suppliers || {};
          if(field === 'preferred') drawerState.cache.logistics.suppliers.preferred = value;
          if(field === 'moq') drawerState.cache.logistics.suppliers.moq = value === '' ? null : Number(value);
          drawerState.cache.logistics.refresh = true;
          await setActiveTab('logistics');
        }
      });
    });
  }
}

async function setActiveTab(key){
  const els = getItemPanelEls();
  if(!els?.tabs || !els?.body) return;
  const tabs = allowedTabsForRole(drawerState.role);
  const nextKey = tabs.includes(key) ? key : 'overview';
  drawerState.activeTab = nextKey;
  els.tabs.querySelectorAll('.drawer-tab').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === nextKey);
  });
  els.body.innerHTML = '<div class="muted-text" style="padding:12px 0;">Loading...</div>';
  await ensureTabData(nextKey);
  let content = '';
  if(nextKey === 'overview') content = renderTabOverview(drawerState.cache.overview);
  else if(nextKey === 'activity') content = renderTabActivity(drawerState.cache.activity);
  else if(nextKey === 'jobs') content = renderTabJobs(drawerState.cache.jobs);
  else if(nextKey === 'logistics') content = renderTabLogistics(drawerState.cache.logistics);
  else if(nextKey === 'insights') content = renderTabInsights(drawerState.cache.insights);
  else if(nextKey === 'settings') content = renderTabSettings(drawerState.cache.settings);
  els.body.innerHTML = content;
  bindTabEvents(nextKey);
}

async function loadActivity(code, filters){
  try{
    const params = new URLSearchParams();
    Object.entries(filters || {}).forEach(([k,v])=>{
      if(v !== undefined && v !== '') params.set(k, v);
    });
    const res = await fetch(`/api/items/${encodeURIComponent(code)}/activity?${params.toString()}`);
    if(!res.ok) throw new Error('load activity failed');
    const data = await res.json();
    const records = Array.isArray(data.records) ? data.records : Array.isArray(data) ? data : [];
    return { records, hasMore: data.hasMore || records.length === Number(filters.page || 1)*50 };
  }catch(e){
    return { records: [], hasMore:false };
  }
}

async function loadJobs(code, filters){
  try{
    const params = new URLSearchParams();
    Object.entries(filters || {}).forEach(([k,v])=>{
      if(v !== undefined && v !== '') params.set(k, v);
    });
    const res = await fetch(`/api/items/${encodeURIComponent(code)}/jobs?${params.toString()}`);
    if(!res.ok) throw new Error('load jobs failed');
    const data = await res.json();
    return { active: data.active || [], history: data.history || [], filters };
  }catch(e){
    return { active: [], history: [], filters };
  }
}

async function loadLogistics(code){
  try{
    const res = await fetch(`/api/items/${encodeURIComponent(code)}/logistics`);
    if(!res.ok) throw new Error('logistics');
    return await res.json();
  }catch(e){
    return null;
  }
}

async function loadInsights(code){
  try{
    const res = await fetch(`/api/items/${encodeURIComponent(code)}/insights`);
    if(!res.ok) throw new Error('insights');
    return await res.json();
  }catch(e){
    return {};
  }
}

async function saveLogistics(code, field, value){
  try{
    const payload = { [field]: value };
    const res = await fetch(`/api/items/${encodeURIComponent(code)}/logistics`,{
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    return res.ok;
  }catch(e){
    return false;
  }
}

async function saveSettings(code, payload){
  try{
    const res = await fetch(`/api/items/${encodeURIComponent(code)}`,{
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    return res.ok;
  }catch(e){
    return false;
  }
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
  const threshold = Number.isFinite(lowStockCfg?.threshold) ? lowStockCfg.threshold : (Number.isFinite(item.lowStockThreshold) ? item.lowStockThreshold : DEFAULT_LOW_STOCK_THRESHOLD);
  const lowStockEnabled = lowStockCfg?.enabled === true;
  const states = {
    onHand: Number.isFinite(item.onHand) ? item.onHand : (Number(item.available || 0) + Number(item.reserveQty || 0) + Number(item.checkedOut || 0)),
    available: item.available ?? 0,
    reserved: item.reserveQty ?? 0,
    checkedOut: item.checkedOut ?? 0,
    inTransit: item.inTransit ?? 0,
    damaged: item.damaged ?? 0,
    returned: item.returned ?? 0
  };
  const summary = {
    reorderPoint: threshold,
    minStock: meta.minStock ?? null,
    lastActivity: item.lastType || item.lastDate ? { type: item.lastType || 'Activity', timestamp: item.lastDate, user: item.lastUser } : null,
    lastCount: item.countedAt ? { date: item.countedAt, user: item.countedBy } : null,
    discrepancyUnits: item.discrepancy ?? null,
    discrepancyValue: item.discrepancyValue ?? null,
    avgDailyUsage: meta.avgDailyUsage ?? null
  };
  const role = getUserRole();
  drawerState.itemCode = item.code;
  drawerState.role = role;
  drawerState.dirty = false;
  drawerState.activeTab = 'overview';
  drawerState.cache = {
    overview: { item, states, summary, meta, tags: staticTags, threshold, lowStockEnabled },
    activity: null,
    jobs: null,
    logistics: null,
    insights: null,
    settings: null
  };
  renderDrawerHeader(item, meta, role, drawerState.cache.overview);
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
  return null;
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
    lowStockEnabled: false
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

function setItemsMetaFromRows(rows){
  itemMetaByCode = new Map();
  (rows || []).forEach(item=>{
    if(!item?.code) return;
    itemMetaByCode.set(item.code, item);
  });
  return itemMetaByCode;
}

function setCategoryRulesFromRows(rows){
  categoryRulesByName = new Map();
  (rows || []).forEach(cat=>{
    if(!cat?.name) return;
    categoryRulesByName.set(cat.name.toLowerCase(), normalizeCategoryRules(cat.rules));
  });
  return categoryRulesByName;
}

function setClosedJobsFromRows(rows){
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

function setCountsFromRows(rows){
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
  const enabled = itemEnabled === null ? (rules?.lowStockEnabled ?? false) : itemEnabled;
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
    tr.innerHTML=`<td colspan="12" style="text-align:center;color:#6b7280;">No inventory matches these filters</td>`;
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
    let statusLabel = 'In stock';
    let statusClass = 'status-ok';
    if(item.available <= 0){
      statusLabel = 'Out of stock';
      statusClass = 'status-out';
    }else if(item.lowStockEnabled !== false && item.available <= threshold){
      statusLabel = 'Low stock';
      statusClass = 'status-warn';
    }
    const location = item.location || FALLBACK;
    tr.innerHTML=`
      <td class="mobile-only">
        <div class="mobile-item-card">
          <div class="mobile-item-head">
            <span class="mobile-item-name">${item.name || item.code}</span>
            <span class="status-dot ${statusClass}" aria-hidden="true"></span>
          </div>
          <div class="mobile-item-row">Available: <strong>${item.available}</strong> <span class="mobile-divider">•</span> Loc: <span>${location}</span></div>
          <div class="mobile-item-row">Reserved: <strong>${item.reserveQty}</strong> <span class="mobile-divider">•</span> Out: <strong>${item.checkedOut}</strong></div>
        </div>
      </td>
      <td>${item.code}</td>
      <td>${item.name||''}</td>
      <td>${item.available}</td>
      <td>${item.reserveQty}</td>
      <td>${item.checkedOut}</td>
      <td>${location}</td>
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

function setInventoryTab(tab){
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.mode-content').forEach(panel=>{
    panel.classList.toggle('active', panel.id === `${tab}-tab`);
  });
}

function setupTabs(){
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> setInventoryTab(btn.dataset.tab));
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

function getFilterSheetEls(){
  return {
    sheet: document.getElementById('filterSheet'),
    backdrop: document.getElementById('filterSheetBackdrop'),
    close: document.getElementById('filterSheetClose'),
    apply: document.getElementById('filterSheetApply'),
    clear: document.getElementById('filterSheetClear'),
    open: document.getElementById('openFilterSheet'),
    quickOpen: document.getElementById('quickFiltersBtn'),
    low: document.getElementById('sheet-filter-low'),
    overdue: document.getElementById('sheet-filter-overdue'),
    project: document.getElementById('sheet-filter-project'),
    recent: document.getElementById('sheet-filter-recent'),
    count: document.getElementById('sheet-filter-count'),
    scan: document.getElementById('sheet-scan-mode')
  };
}

function syncFilterSheetFromMain(els){
  const low = document.getElementById('filter-low');
  const overdue = document.getElementById('filter-overdue');
  const project = document.getElementById('filter-project');
  const recent = document.getElementById('filter-recent');
  const count = document.getElementById('filter-count');
  const scan = document.getElementById('scanMode');
  if(els.low) els.low.checked = !!low?.checked;
  if(els.overdue) els.overdue.checked = !!overdue?.checked;
  if(els.project) els.project.checked = !!project?.checked;
  if(els.recent) els.recent.checked = !!recent?.checked;
  if(els.count) els.count.checked = !!count?.checked;
  if(els.scan) els.scan.checked = !!scan?.checked;
}

function applyFilterSheetToMain(els){
  const low = document.getElementById('filter-low');
  const overdue = document.getElementById('filter-overdue');
  const project = document.getElementById('filter-project');
  const recent = document.getElementById('filter-recent');
  const count = document.getElementById('filter-count');
  const scan = document.getElementById('scanMode');
  if(low && els.low) low.checked = els.low.checked;
  if(overdue && els.overdue) overdue.checked = els.overdue.checked;
  if(project && els.project) project.checked = els.project.checked;
  if(recent && els.recent) recent.checked = els.recent.checked;
  if(count && els.count) count.checked = els.count.checked;
  if(scan && els.scan) scan.checked = els.scan.checked;
  const scanToggle = document.getElementById('quickScanToggle');
  if(scanToggle && scan) scanToggle.classList.toggle('active', scan.checked);
  renderOnhand();
}

function setFilterSheetOpen(els, isOpen){
  if(!els.sheet || !els.backdrop) return;
  els.sheet.classList.toggle('open', isOpen);
  els.backdrop.classList.toggle('active', isOpen);
  els.sheet.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
}

function setupFilterSheet(){
  const els = getFilterSheetEls();
  if(!els.sheet) return;
  const openSheet = ()=>{
    syncFilterSheetFromMain(els);
    setFilterSheetOpen(els, true);
  };
  const closeSheet = ()=> setFilterSheetOpen(els, false);
  els.open?.addEventListener('click', openSheet);
  els.quickOpen?.addEventListener('click', openSheet);
  els.close?.addEventListener('click', closeSheet);
  els.backdrop?.addEventListener('click', closeSheet);
  els.apply?.addEventListener('click', ()=>{
    applyFilterSheetToMain(els);
    haptic('light');
    closeSheet();
  });
  els.clear?.addEventListener('click', ()=>{
    if(els.low) els.low.checked = false;
    if(els.overdue) els.overdue.checked = false;
    if(els.project) els.project.checked = false;
    if(els.recent) els.recent.checked = false;
    if(els.count) els.count.checked = false;
    if(els.scan) els.scan.checked = false;
    applyFilterSheetToMain(els);
    haptic('light');
    closeSheet();
  });
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && els.sheet.classList.contains('open')) closeSheet();
  });
}

function setupQuickbar(){
  const scanToggle = document.getElementById('quickScanToggle');
  const countToggle = document.getElementById('quickCountToggle');
  const scan = document.getElementById('scanMode');
  if(scanToggle && scan){
    scanToggle.classList.toggle('active', scan.checked);
  }
  if(countToggle){
    countToggle.classList.toggle('active', document.body.classList.contains('count-mode'));
  }
  if(scanToggle){
    scanToggle.addEventListener('click', ()=>{
      if(scan){
        scan.checked = !scan.checked;
        scanToggle.classList.toggle('active', scan.checked);
        haptic('light');
        renderOnhand();
      }
    });
  }
  if(countToggle){
    countToggle.addEventListener('click', ()=>{
      document.body.classList.toggle('count-mode');
      countToggle.classList.toggle('active', document.body.classList.contains('count-mode'));
      haptic('light');
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
        haptic('error');
        alert(res.error || 'Failed to save counts');
        return;
      }
      haptic('success');
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

async function fetchJson(url){
  try{
    const res = await fetch(url);
    if(!res.ok) return { ok: false, data: null };
    return { ok: true, data: await res.json() };
  }catch(e){
    return { ok: false, data: null };
  }
}

async function refreshAll(){
  const cached = readCache() || {};
  const [
    inventoryRes,
    ordersRes,
    countsRes,
    itemsRes,
    categoriesRes,
    jobsRes
  ] = await Promise.all([
    fetchJson('/api/inventory'),
    fetchJson('/api/inventory?type=ordered'),
    fetchJson('/api/inventory-counts'),
    fetchJson('/api/items'),
    fetchJson('/api/categories'),
    fetchJson('/api/jobs')
  ]);

  const inventory = inventoryRes.ok ? inventoryRes.data : (cached.inventory || []);
  const orders = ordersRes.ok ? ordersRes.data : (cached.orders || []);
  const counts = countsRes.ok ? countsRes.data : (cached.counts || []);
  const items = itemsRes.ok ? itemsRes.data : (cached.items || []);
  const categories = categoriesRes.ok ? categoriesRes.data : (cached.categories || []);
  const jobs = jobsRes.ok ? jobsRes.data : (cached.jobs || []);

  const offline = !(inventoryRes.ok && ordersRes.ok && countsRes.ok && itemsRes.ok && categoriesRes.ok && jobsRes.ok);
  if(!offline){
    lastSyncTs = Date.now();
    writeCache({ inventory, orders, counts, items, categories, jobs, ts: lastSyncTs });
  }else{
    lastSyncTs = cached.ts || lastSyncTs;
  }
  updateSyncStatus(offline, lastSyncTs);

  setCountsFromRows(counts);
  setItemsMetaFromRows(items);
  setCategoryRulesFromRows(categories);
  setClosedJobsFromRows(jobs);

  window.__cachedInventory = inventory;
  incomingBaseRows = buildIncomingRows(orders, inventory);
  onhandBaseRows = computeOnhandRows(inventory);
  overdueRows = buildOverdueRows(inventory);
  renderIncoming();
  renderOnhand();
  renderOverdue();
  updateSummary();
}

function applyQueryParams(){
  const params = new URLSearchParams(window.location.search);
  const search = params.get('search');
  const itemCode = params.get('item');
  const tab = params.get('tab');
  const activitySearch = params.get('activity');
  if(search){
    const searchBox = document.getElementById('searchBox');
    if(searchBox){
      searchBox.value = search;
      renderOnhand();
    }
  }
  if(itemCode){
    const normalized = itemCode.toLowerCase();
    let item = onhandBaseRows.find(r=> (r.code || '').toLowerCase() === normalized);
    if(!item){
      const meta = itemMetaByCode.get(itemCode) || itemMetaByCode.get(itemCode.toUpperCase());
      if(meta){
        item = {
          code: meta.code,
          name: meta.name || meta.code,
          category: meta.category,
          available: 0,
          reserveQty: 0,
          checkedOut: 0,
          inTransit: 0,
          damaged: 0,
          returned: 0
        };
      }
    }
    if(item){
      openItemPanel(item);
      if(tab === 'activity'){
        drawerState.cache.activity = {
          filters: { range:'30', type:'', search: activitySearch || '', page:1 },
          records: [],
          hasMore: false,
          refresh: true
        };
        setActiveTab('activity');
      }
    }
  }
}

document.addEventListener('DOMContentLoaded',async ()=>{
  setupTabs();
  setupFilters();
  setupActions();
  setupItemPanel();
  setupFilterSheet();
  setupQuickbar();
  updateSyncStatus(!navigator.onLine, lastSyncTs);
  window.addEventListener('online', ()=> updateSyncStatus(false, lastSyncTs));
  window.addEventListener('offline', ()=> updateSyncStatus(true, lastSyncTs));
  await refreshAll();
  applyQueryParams();

  const incomingSearchBox = document.getElementById('incomingSearchBox');
  if(incomingSearchBox) incomingSearchBox.addEventListener('input', renderIncoming);
});
