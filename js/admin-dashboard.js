const adminNumFmt = new Intl.NumberFormat('en-US');
const adminPctFmt = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const adminCurrencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const adminCurrencyPreciseFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

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
  return `${hrs}h ${mins % 60}m`;
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
}

function renderAdminInbox(workflow){
  const inboxList = document.getElementById('adminInboxList');
  if(inboxList){
    const inbox = workflow?.inbox?.admin || {};
    const entries = [
      ...(inbox.projectsMissingMaterials || []).map((row)=>({
        title: row.code,
        detail: 'Project missing material plan',
        href: 'job-creator.html#projects'
      })),
      ...(inbox.missingSupplier || []).map((row)=>({
        title: row.code,
        detail: `Supplier missing${row.demandQty ? ` | demand ${row.demandQty}` : ''}`,
        href: 'item-master.html#suppliers'
      })),
      ...(inbox.missingReorderRule || []).map((row)=>({
        title: row.code,
        detail: 'Low-stock enabled without item reorder rule',
        href: 'item-master.html'
      })),
      ...(inbox.openOrders || []).map((row)=>({
        title: row.code,
        detail: `${row.openQty} inbound${row.jobId ? ` | ${row.jobId}` : ''}`,
        href: 'order-register.html'
      })),
    ].slice(0, 8);

    inboxList.innerHTML = entries.length
      ? entries.map((entry)=> `<li><div class="worklist-main"><strong>${entry.title}</strong><span class="worklist-sub">${entry.detail}</span></div><a class="kpi-link" href="${entry.href}">Open</a></li>`).join('')
      : '<li class="muted">No admin follow-ups.</li>';
  }

  const exceptionList = document.getElementById('adminExceptionList');
  if(exceptionList){
    const exceptions = workflow?.exceptions || {};
    const entries = [
      ...(exceptions.negativeAvailability || []).map((row)=>({
        title: row.code,
        detail: `Negative availability ${row.available}`,
        href: 'inventory-list.html#negative'
      })),
      ...(exceptions.overdueReturns || []).map((row)=>({
        title: row.code,
        detail: `${row.outstanding} overdue${row.jobId ? ` | ${row.jobId}` : ''}`,
        href: 'inventory-operations.html?mode=return'
      })),
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

  const priorityList = document.getElementById('adminPriorityList');
  if(priorityList){
    const rows = [
      ...((workflow?.procurementSuggestions || []).filter((row)=> Number(row.shortageQty || 0) > 0).slice(0, 2).map((row)=>({
        title: row.code,
        badge: `Short ${adminFmtNum(row.shortageQty)}`,
        detail: `${row.name || ''}${row.jobId ? ` | ${row.jobId}` : ''}`,
        href: `order-register.html?project=${encodeURIComponent(row.jobId || '')}&loadMaterials=1#order`,
        tone: 'danger'
      }))),
      ...((workflow?.exceptions?.missingSupplier || []).slice(0, 2).map((row)=>({
        title: row.code,
        badge: 'Supplier missing',
        detail: row.name || 'Item requires supplier assignment',
        href: 'item-master.html#suppliers',
        tone: 'warn'
      }))),
      ...((adminSnapshot?.countDue || []).slice(0, 2).map((row)=>({
        title: row.code,
        badge: row.lastCounted ? `Last ${new Date(row.lastCounted).toLocaleDateString([], { month:'short', day:'numeric' })}` : 'Never counted',
        detail: row.name || 'Cycle count overdue',
        href: 'inventory-list.html',
        tone: 'info'
      })))
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

  const activityList = document.getElementById('adminActivityList');
  if(activityList){
    const rows = Array.isArray(adminSnapshot?.activity) ? adminSnapshot.activity.slice(0, 6) : [];
    activityList.innerHTML = rows.length
      ? rows.map((row)=> `<li><div class="worklist-main"><strong>${row.code}</strong><span class="worklist-sub">${row.type} | ${adminFmtNum(row.qty)}</span></div><span class="badge static">${new Date(row.ts).toLocaleString([], { month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' })}</span></li>`).join('')
      : '<li class="muted">No recent activity.</li>';
  }
}

async function renderAdminDashboard(){
  const [metrics, workflow, adminSnapshot] = await Promise.all([
    utils.fetchJsonSafe('/api/dashboard/manager', { cacheTtlMs: 10000 }, {}) || {},
    utils.fetchJsonSafe('/api/workflows/overview', { cacheTtlMs: 5000 }, {}) || {},
    utils.fetchJsonSafe('/api/dashboard/admin', { cacheTtlMs: 10000 }, {}) || {}
  ]);

  adminSetText('kpi-accuracy', adminFmtPct(metrics.accuracy));
  adminSetText('kpi-adjustment', adminFmtPct(metrics.adjustmentRate));
  adminSetText('kpi-discrepancy', adminFmtCurrency(metrics.discrepancyValue, true));
  adminSetText('kpi-not-counted', adminFmtNum(metrics.notCounted));
  adminSetText('kpi-shrinkage', adminFmtPct(metrics.shrinkage));
  adminSetText('kpi-damaged', adminFmtPct(metrics.damaged));
  adminSetText('kpi-writeoffs', adminFmtNum(metrics.writeOffs));
  adminSetText('kpi-lost-value', adminFmtCurrency(metrics.lostValue, true));
  adminSetText('kpi-usage-trend', adminFmtNum(metrics.topUsage?.[0]?.qty ?? null));
  adminSetText('kpi-8020', metrics.eightyTwenty !== null && metrics.eightyTwenty !== undefined ? `${Math.round(metrics.eightyTwenty * 100)}%` : 'N/A');
  adminSetText('kpi-dead-stock', adminFmtPct(metrics.totalItems ? metrics.deadStock / metrics.totalItems : null));
  adminSetText('kpi-slow-moving', adminFmtNum(metrics.slowMovingList?.length ?? null));
  adminSetText('kpi-fill-rate', adminFmtPct(metrics.fillRate));
  adminSetText('kpi-service-level', adminFmtPct(metrics.serviceLevel));
  adminSetText('kpi-lead-time', adminFmtDuration(metrics.avgLeadTime));
  adminSetText('kpi-on-time', adminFmtPct(metrics.onTimeRate));

  renderAdminTables(metrics);
  renderAdminInbox(workflow);
  renderAdminExecutiveSummary(metrics, workflow, adminSnapshot);
}

document.addEventListener('DOMContentLoaded', ()=>{
  const tick = ()=> adminSetText('clockOps', new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }));
  tick();
  setInterval(tick, 60000);
  renderAdminDashboard();
});
