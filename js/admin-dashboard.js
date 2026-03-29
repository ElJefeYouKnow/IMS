const DAY_MS = 24 * 60 * 60 * 1000;

const adminNumFmt = new Intl.NumberFormat('en-US');
const adminPctFmt = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const adminCurrencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const adminCurrencyPreciseFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const adminState = {
  rangeDays: 7,
  focus: 'overview'
};

function adminSetText(id, value){
  const el = document.getElementById(id);
  if(el) el.textContent = value;
}

function adminFmtNum(value){
  if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return adminNumFmt.format(value);
}

function adminFmtPct(value){
  if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return adminPctFmt.format(Math.max(0, Math.min(1, value)));
}

function adminFmtCurrency(value, precise = false){
  if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return (precise ? adminCurrencyPreciseFmt : adminCurrencyFmt).format(value);
}

function adminFmtDuration(ms){
  if(!Number.isFinite(ms) || ms <= 0) return 'N/A';
  const mins = Math.round(ms / 60000);
  if(mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if(hrs < 24) return `${hrs}h ${rem}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function adminFetchManagerMetrics(days, untilTs){
  const params = new URLSearchParams({ days: String(days) });
  if(untilTs) params.set('until', String(untilTs));
  return utils.fetchJsonSafe(`/api/dashboard/manager?${params.toString()}`, { cacheTtlMs: 5000 }, {}) || {};
}

function renderAdminTables(metrics){
  const slowBody = document.querySelector('#slowMovingTable tbody');
  if(slowBody){
    const rows = Array.isArray(metrics.slowMovingList) ? metrics.slowMovingList : [];
    slowBody.innerHTML = rows.length
      ? rows.map((row)=> `<tr><td>${row.code}</td><td>${row.name || ''}</td><td>${adminFmtNum(row.moves)}</td><td>${adminFmtNum(row.available)}</td></tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:#6b7280;">No slow movers found.</td></tr>';
  }

  const usageBody = document.querySelector('#topUsageTable tbody');
  if(usageBody){
    const rows = Array.isArray(metrics.topUsage) ? metrics.topUsage : [];
    usageBody.innerHTML = rows.length
      ? rows.map((row)=> `<tr><td>${row.code}</td><td>${row.name || ''}</td><td>${adminFmtNum(row.qty)}</td><td>${adminFmtPct(row.share)}</td></tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:#6b7280;">No usage data yet.</td></tr>';
  }

  adminSetText('slowMovingTitle', `Slow Moving Inventory (${adminState.rangeDays}d)`);
  adminSetText('topUsageTitle', `Top Usage Items (${adminState.rangeDays}d)`);
}

function renderAdminWorklists(workflow){
  const inboxList = document.getElementById('adminInboxList');
  if(inboxList){
    const inbox = workflow?.inbox?.admin || {};
    const entries = [
      ...(inbox.projectsMissingMaterials || []).map((row)=>({ title: row.code, detail: 'Project missing material plan', href: 'job-creator.html#projects' })),
      ...(inbox.missingSupplier || []).map((row)=>({ title: row.code, detail: `Supplier missing${row.demandQty ? ` | demand ${row.demandQty}` : ''}`, href: 'item-master.html#suppliers' })),
      ...(inbox.missingReorderRule || []).map((row)=>({ title: row.code, detail: 'Low-stock enabled without item reorder rule', href: 'item-master.html' })),
      ...(inbox.openOrders || []).map((row)=>({ title: row.code, detail: `${row.openQty} inbound${row.jobId ? ` | ${row.jobId}` : ''}`, href: 'order-register.html' }))
    ].slice(0, 8);

    inboxList.innerHTML = entries.length
      ? entries.map((entry)=> `<li><div class="worklist-main"><strong>${entry.title}</strong><span class="worklist-sub">${entry.detail}</span></div><a class="kpi-link" href="${entry.href}">Open</a></li>`).join('')
      : '<li class="muted">No admin follow-ups.</li>';
  }

  const exceptionList = document.getElementById('adminExceptionList');
  if(exceptionList){
    const exceptions = workflow?.exceptions || {};
    const entries = [
      ...(exceptions.negativeAvailability || []).map((row)=>({ title: row.code, detail: `Negative availability ${row.available}`, href: 'inventory-list.html#negative' })),
      ...(exceptions.overdueReturns || []).map((row)=>({ title: row.code, detail: `${row.outstanding} overdue${row.jobId ? ` | ${row.jobId}` : ''}`, href: 'inventory-operations.html?mode=return' }))
    ].slice(0, 8);

    exceptionList.innerHTML = entries.length
      ? entries.map((entry)=> `<li><div class="worklist-main"><strong>${entry.title}</strong><span class="worklist-sub">${entry.detail}</span></div><a class="kpi-link" href="${entry.href}">Resolve</a></li>`).join('')
      : '<li class="muted">No critical exceptions.</li>';
  }

  const suggestionBox = document.getElementById('adminProcurementSuggestions');
  if(suggestionBox){
    const rows = workflow?.procurementSuggestions || [];
    suggestionBox.innerHTML = rows.length
      ? rows.map((row)=> `
        <article class="workflow-row compact">
          <div class="workflow-main">
            <div class="workflow-title-row">
              <strong>${row.code}</strong>
              <span class="badge ${Number(row.shortageQty || 0) > 0 ? 'danger' : 'low'}">${Number(row.shortageQty || 0) > 0 ? 'Shortage' : 'Reserve'}</span>
            </div>
            <div class="workflow-sub">${row.name || ''}${row.jobId ? ` | ${row.jobId}` : ''}</div>
            <div class="workflow-metrics">
              <span>Open: <strong>${adminFmtNum(row.outstandingQty)}</strong></span>
              <span>Available: <strong>${adminFmtNum(row.availableQty)}</strong></span>
              <span>Supplier: <strong>${row.supplierName || 'Unassigned'}</strong></span>
            </div>
          </div>
          <div class="workflow-actions">
            <a class="action-btn" href="order-register.html?project=${encodeURIComponent(row.jobId || '')}&loadMaterials=1#order">Open</a>
          </div>
        </article>
      `).join('')
      : '<div class="report-empty">No procurement suggestions.</div>';
  }
}

function renderAdminExecutiveSummary(metrics, workflow, adminSnapshot){
  const adminMetrics = adminSnapshot?.metrics || {};
  const shortageCount = (workflow?.procurementSuggestions || []).filter((row)=> Number(row.shortageQty || 0) > 0).length;
  const criticalCount = (workflow?.exceptions?.negativeAvailability || []).length + (workflow?.exceptions?.overdueReturns || []).length;

  adminSetText('admin-alerts', adminFmtNum(metrics.alertsCount));
  adminSetText('admin-open-orders', adminFmtNum(adminMetrics.openOrdersCount));
  adminSetText('admin-count-due', adminFmtNum(adminMetrics.countDueCount));
  adminSetText('admin-shortages', adminFmtNum(shortageCount));

  const healthBadge = document.getElementById('adminHealthBadge');
  if(healthBadge){
    healthBadge.className = 'badge';
    if(criticalCount > 0){
      healthBadge.classList.add('danger');
      healthBadge.textContent = `${adminFmtNum(criticalCount)} critical`;
    }else if(Number(metrics.alertsCount || 0) > 0){
      healthBadge.classList.add('warn');
      healthBadge.textContent = `${adminFmtNum(metrics.alertsCount)} alerts`;
    }else{
      healthBadge.classList.add('info');
      healthBadge.textContent = 'Stable';
    }
  }
}

function renderAdminPriorityList(workflow, adminSnapshot){
  const priorityList = document.getElementById('adminPriorityList');
  if(!priorityList) return;
  const rows = [
    ...((workflow?.procurementSuggestions || []).filter((row)=> Number(row.shortageQty || 0) > 0).slice(0, 2).map((row)=>({ title: row.code, badge: `Short ${adminFmtNum(row.shortageQty)}`, detail: `${row.name || ''}${row.jobId ? ` | ${row.jobId}` : ''}`, href: `order-register.html?project=${encodeURIComponent(row.jobId || '')}&loadMaterials=1#order`, tone: 'danger' }))),
    ...((workflow?.exceptions?.missingSupplier || []).slice(0, 2).map((row)=>({ title: row.code, badge: 'Supplier missing', detail: row.name || 'Item requires supplier assignment', href: 'item-master.html#suppliers', tone: 'warn' }))),
    ...((adminSnapshot?.countDue || []).slice(0, 2).map((row)=>({ title: row.code, badge: row.lastCounted ? `Last ${new Date(row.lastCounted).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : 'Never counted', detail: row.name || 'Cycle count overdue', href: 'inventory-list.html', tone: 'info' })))
  ].slice(0, 6);

  priorityList.innerHTML = rows.length
    ? rows.map((row)=> `
      <article class="workflow-row compact">
        <div class="workflow-main">
          <div class="workflow-title-row">
            <strong>${row.title}</strong>
            <span class="badge ${row.tone}">${row.badge}</span>
          </div>
          <div class="workflow-sub">${row.detail}</div>
        </div>
        <div class="workflow-actions">
          <a class="action-btn" href="${row.href}">Open</a>
        </div>
      </article>
    `).join('')
    : '<div class="report-empty">No immediate admin priorities.</div>';
}

function renderAdminActivity(adminSnapshot){
  const activityList = document.getElementById('adminActivityList');
  if(!activityList) return;
  const rows = Array.isArray(adminSnapshot?.activity) ? adminSnapshot.activity.slice(0, 8) : [];
  activityList.innerHTML = rows.length
    ? rows.map((row)=> `<li><div class="worklist-main"><strong>${row.code}</strong><span class="worklist-sub">${row.type} | ${adminFmtNum(row.qty)}</span></div><span class="badge static">${new Date(row.ts).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></li>`).join('')
    : '<li class="muted">No recent activity.</li>';
}

function ensureSummaryMeta(id){
  const valueEl = document.getElementById(id);
  const item = valueEl?.closest('.summary-item');
  if(!valueEl || !item) return null;
  item.classList.add('has-chip');
  let meta = item.querySelector('.summary-meta');
  if(!meta){
    meta = document.createElement('div');
    meta.className = 'summary-meta';
    meta.innerHTML = `<span id="${id}-chip" class="kpi-chip ok">OK</span><span id="${id}-trend" class="summary-trend">Current view</span>`;
    item.appendChild(meta);
  }
  return { chip: document.getElementById(`${id}-chip`), trend: document.getElementById(`${id}-trend`) };
}

function metricTone(value, config){
  if(value === null || value === undefined || Number.isNaN(value)) return { tone: 'static', label: 'No data' };
  if(config.mode === 'info') return { tone: 'info', label: config.goodLabel || 'Info' };
  if(config.mode === 'high'){
    if(value < config.critical) return { tone: 'critical', label: 'Critical' };
    if(value < config.warn) return { tone: 'warn', label: config.warnLabel || 'Watch' };
    return { tone: 'ok', label: config.goodLabel || 'Strong' };
  }
  if(value > config.critical) return { tone: 'critical', label: 'Critical' };
  if(value > config.warn) return { tone: 'warn', label: config.warnLabel || 'Watch' };
  return { tone: 'ok', label: config.goodLabel || 'Stable' };
}

function formatMetric(value, format){
  if(format === 'pct') return adminFmtPct(value);
  if(format === 'currency-precise') return adminFmtCurrency(value, true);
  if(format === 'duration') return adminFmtDuration(value);
  return adminFmtNum(value);
}

function formatDelta(current, previous, format){
  if(current === null || current === undefined || Number.isNaN(current) || previous === null || previous === undefined || Number.isNaN(previous)) return 'No prior baseline';
  const diff = current - previous;
  if(Math.abs(diff) < 0.000001) return 'Flat vs prior';
  if(format === 'pct') return `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(1)} pts vs prior`;
  if(format === 'currency-precise') return `${diff > 0 ? '+' : '-'}${adminFmtCurrency(Math.abs(diff), true)} vs prior`;
  if(format === 'duration') return `${diff > 0 ? '+' : '-'}${adminFmtDuration(Math.abs(diff))} vs prior`;
  return `${diff > 0 ? '+' : ''}${adminFmtNum(diff)} vs prior`;
}

function renderMetric(id, value, previous, config){
  adminSetText(id, formatMetric(value, config.format));
  const meta = ensureSummaryMeta(id);
  if(!meta) return;
  const status = metricTone(value, config);
  meta.chip.className = `kpi-chip ${status.tone}`;
  meta.chip.textContent = status.label;
  const deltaText = formatDelta(value, previous, config.format);
  meta.trend.className = 'summary-trend';
  meta.trend.textContent = deltaText;
  meta.trend.classList.add(deltaText.startsWith('+') ? 'up' : deltaText.startsWith('-') ? 'down' : 'flat');
}

function renderAdminKpis(metrics, previousMetrics){
  const map = {
    'kpi-accuracy': { value: metrics.accuracy, previous: previousMetrics.accuracy, mode: 'high', warn: 0.96, critical: 0.9, format: 'pct', goodLabel: 'Tight', warnLabel: 'Watch' },
    'kpi-adjustment': { value: metrics.adjustmentRate, previous: previousMetrics.adjustmentRate, mode: 'low', warn: 0.05, critical: 0.1, format: 'pct', goodLabel: 'Clean', warnLabel: 'Rising' },
    'kpi-discrepancy': { value: metrics.discrepancyValue, previous: previousMetrics.discrepancyValue, mode: 'low', warn: 500, critical: 2500, format: 'currency-precise', goodLabel: 'Contained', warnLabel: 'Review' },
    'kpi-not-counted': { value: metrics.notCounted, previous: previousMetrics.notCounted, mode: 'low', warn: 5, critical: 15, format: 'num', goodLabel: 'Current', warnLabel: 'Due' },
    'kpi-shrinkage': { value: metrics.shrinkage, previous: previousMetrics.shrinkage, mode: 'low', warn: 0.02, critical: 0.05, format: 'pct', goodLabel: 'Low', warnLabel: 'Watch' },
    'kpi-damaged': { value: metrics.damaged, previous: previousMetrics.damaged, mode: 'low', warn: 0.01, critical: 0.03, format: 'pct', goodLabel: 'Low', warnLabel: 'Rising' },
    'kpi-writeoffs': { value: metrics.writeOffs, previous: previousMetrics.writeOffs, mode: 'low', warn: 3, critical: 8, format: 'num', goodLabel: 'Low', warnLabel: 'Review' },
    'kpi-lost-value': { value: metrics.lostValue, previous: previousMetrics.lostValue, mode: 'low', warn: 1000, critical: 5000, format: 'currency-precise', goodLabel: 'Contained', warnLabel: 'Rising' },
    'kpi-usage-trend': { value: metrics.topUsage?.[0]?.qty ?? null, previous: previousMetrics.topUsage?.[0]?.qty ?? null, mode: 'info', format: 'num', goodLabel: 'Lead item' },
    'kpi-8020': { value: metrics.eightyTwenty, previous: previousMetrics.eightyTwenty, mode: 'info', format: 'pct', goodLabel: 'Pattern' },
    'kpi-dead-stock': { value: metrics.totalItems ? metrics.deadStock / metrics.totalItems : null, previous: previousMetrics.totalItems ? previousMetrics.deadStock / previousMetrics.totalItems : null, mode: 'low', warn: 0.2, critical: 0.35, format: 'pct', goodLabel: 'Healthy', warnLabel: 'Aging' },
    'kpi-slow-moving': { value: metrics.slowMovingList?.length ?? null, previous: previousMetrics.slowMovingList?.length ?? null, mode: 'low', warn: 5, critical: 12, format: 'num', goodLabel: 'Lean', warnLabel: 'Accumulating' },
    'kpi-fill-rate': { value: metrics.fillRate, previous: previousMetrics.fillRate, mode: 'high', warn: 0.9, critical: 0.75, format: 'pct', goodLabel: 'Strong', warnLabel: 'Watch' },
    'kpi-service-level': { value: metrics.serviceLevel, previous: previousMetrics.serviceLevel, mode: 'high', warn: 0.95, critical: 0.85, format: 'pct', goodLabel: 'Strong', warnLabel: 'Watch' },
    'kpi-lead-time': { value: metrics.avgLeadTime, previous: previousMetrics.avgLeadTime, mode: 'low', warn: 7 * DAY_MS, critical: 14 * DAY_MS, format: 'duration', goodLabel: 'Stable', warnLabel: 'Longer' },
    'kpi-on-time': { value: metrics.onTimeRate, previous: previousMetrics.onTimeRate, mode: 'high', warn: 0.9, critical: 0.75, format: 'pct', goodLabel: 'Reliable', warnLabel: 'Watch' }
  };

  Object.entries(map).forEach(([id, config])=> renderMetric(id, config.value, config.previous, config));
}

function applyAdminTab(targetTab){
  adminState.focus = targetTab;
  document.querySelectorAll('.kpi-tab').forEach((btn)=> btn.classList.toggle('active', btn.dataset.tab === targetTab));
  document.querySelectorAll('.admin-focus-btn').forEach((btn)=> btn.classList.toggle('active', btn.dataset.focus === targetTab));
  document.querySelectorAll('.kpi-panel').forEach((panel)=> panel.classList.toggle('active', panel.id === `${targetTab}-panel`));
}

function initAdminTabs(){
  document.querySelectorAll('.kpi-tab').forEach((tab)=> tab.addEventListener('click', ()=> applyAdminTab(tab.dataset.tab)));
  document.querySelectorAll('.admin-focus-btn').forEach((btn)=> btn.addEventListener('click', ()=> applyAdminTab(btn.dataset.focus)));
}

function initAdminCollapsibles(){
  document.querySelectorAll('.card.collapsible').forEach((card)=>{
    const toggle = card.querySelector('.collapse-toggle');
    if(!toggle) return;
    toggle.addEventListener('click', ()=>{
      const collapsed = card.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.textContent = collapsed ? 'Expand' : 'Collapse';
    });
  });
  document.querySelectorAll('[data-collapse-table]').forEach((toggle)=>{
    const target = document.getElementById(toggle.dataset.collapseTable);
    if(!target) return;
    toggle.addEventListener('click', ()=>{
      const hidden = target.hasAttribute('hidden');
      if(hidden) target.removeAttribute('hidden');
      else target.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', hidden ? 'true' : 'false');
      toggle.textContent = hidden ? 'Collapse' : 'Expand';
    });
  });
}

function initAdminRangeButtons(){
  document.querySelectorAll('.admin-range-btn').forEach((btn)=>{
    btn.addEventListener('click', ()=>{
      const nextRange = Number(btn.dataset.range);
      if(!Number.isFinite(nextRange) || nextRange === adminState.rangeDays) return;
      adminState.rangeDays = nextRange;
      document.querySelectorAll('.admin-range-btn').forEach((node)=> node.classList.toggle('active', node === btn));
      renderAdminDashboard();
    });
  });
}

function applyAdminDensityMode(){
  document.body.classList.toggle('density-compact', window.innerWidth <= 900);
}

async function renderAdminDashboard(){
  const currentUntil = Date.now();
  const previousUntil = currentUntil - (adminState.rangeDays * DAY_MS);
  const [metrics, previousMetrics, workflow, adminSnapshot] = await Promise.all([
    adminFetchManagerMetrics(adminState.rangeDays, currentUntil),
    adminFetchManagerMetrics(adminState.rangeDays, previousUntil),
    utils.fetchJsonSafe('/api/workflows/overview', { cacheTtlMs: 5000 }, {}) || {},
    utils.fetchJsonSafe('/api/dashboard/admin', { cacheTtlMs: 10000 }, {}) || {}
  ]);

  renderAdminExecutiveSummary(metrics, workflow, adminSnapshot);
  renderAdminWorklists(workflow);
  renderAdminPriorityList(workflow, adminSnapshot);
  renderAdminActivity(adminSnapshot);
  renderAdminKpis(metrics, previousMetrics);
  renderAdminTables(metrics);

  adminSetText('adminRangeBadge', `${adminState.rangeDays} day view`);
  adminSetText('adminLastRefresh', `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
}

document.addEventListener('DOMContentLoaded', ()=>{
  const tick = ()=> adminSetText('clockOps', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  tick();
  setInterval(tick, 60000);
  initAdminTabs();
  initAdminCollapsibles();
  initAdminRangeButtons();
  applyAdminDensityMode();
  window.addEventListener('resize', applyAdminDensityMode);
  renderAdminDashboard();
});
