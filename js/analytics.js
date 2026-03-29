(function(){
  const RANGE_OPTIONS = [7, 30, 90];
  const numFmt = new Intl.NumberFormat('en-US');
  const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const currencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const currencyFmtPrecise = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

  let analyticsState = {
    rangeDays: 30,
    metrics: {},
    workflow: {},
    adminSnapshot: {},
    auditRows: [],
    auditActions: [],
    generatedAt: null
  };

  function setText(id, value){
    const el = document.getElementById(id);
    if(el) el.textContent = value;
  }

  function fmtNum(value){
    if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
    return numFmt.format(value);
  }

  function fmtPct(value){
    if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
    return pctFmt.format(Math.max(0, Math.min(1, value)));
  }

  function fmtSignedPct(value){
    if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
    return `${value >= 0 ? '+' : '-'}${Math.abs(value * 100).toFixed(1)}%`;
  }

  function fmtCurrency(value, precise = false){
    if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
    return (precise ? currencyFmtPrecise : currencyFmt).format(value);
  }

  function fmtDuration(ms){
    if(!Number.isFinite(ms) || ms <= 0) return 'N/A';
    const mins = Math.round(ms / 60000);
    if(mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if(hrs < 24) return `${hrs}h ${mins % 60}m`;
    return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
  }

  function parseTs(val){
    if(val === undefined || val === null || val === '') return null;
    if(typeof val === 'number') return val;
    const num = Number(val);
    if(Number.isFinite(num)) return num;
    const ts = Date.parse(val);
    return Number.isNaN(ts) ? null : ts;
  }

  function formatWhen(val){
    const ts = parseTs(val);
    if(ts === null) return 'N/A';
    const d = new Date(ts);
    if(Number.isNaN(d.getTime())) return 'N/A';
    return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function formatDateLabel(val){
    const ts = parseTs(val);
    if(ts === null) return 'N/A';
    const d = new Date(ts);
    if(Number.isNaN(d.getTime())) return 'N/A';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function escapeHtml(value){
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setMode(mode){
    document.querySelectorAll('.mode-btn').forEach((btn)=>{
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    document.querySelectorAll('.mode-content').forEach((panel)=>{
      panel.classList.toggle('active', panel.id === `${mode}-mode`);
    });
  }

  function setBadge(id, tone, label){
    const el = document.getElementById(id);
    if(!el) return;
    el.className = 'badge';
    if(tone) el.classList.add(tone);
    el.textContent = label;
  }

  function setFreshness(ts){
    if(!ts){
      setText('analyticsFreshness', 'Live');
      return;
    }
    const diffMs = Math.max(0, Date.now() - ts);
    const diffMin = Math.round(diffMs / 60000);
    if(diffMin < 1){
      setText('analyticsFreshness', 'Updated just now');
      return;
    }
    if(diffMin < 60){
      setText('analyticsFreshness', `Updated ${diffMin}m ago`);
      return;
    }
    const hrs = Math.round(diffMin / 60);
    setText('analyticsFreshness', `Updated ${hrs}h ago`);
  }

  function setLoadingState(loading){
    document.querySelectorAll('.analytics-range-btn').forEach((btn)=>{
      btn.disabled = loading;
    });
    const refreshBtn = document.getElementById('analyticsRefreshBtn');
    if(refreshBtn){
      refreshBtn.disabled = loading;
      refreshBtn.textContent = loading ? 'Refreshing...' : 'Refresh';
    }
    if(loading) setText('analyticsRangeMeta', `Refreshing ${analyticsState.rangeDays}d`);
  }

  function setRangeUi(){
    document.querySelectorAll('.analytics-range-btn').forEach((btn)=>{
      btn.classList.toggle('active', Number(btn.dataset.range) === analyticsState.rangeDays);
    });
    setText('analyticsWindowTitle', `${analyticsState.rangeDays}-day reporting window`);
    setText('analyticsHeroCopy', `Core service, accuracy, and exception metrics for the last ${analyticsState.rangeDays} days.`);
    setText('analyticsUsageWindowBadge', `${analyticsState.rangeDays}d`);
    setText('analyticsSlowWindowBadge', `${analyticsState.rangeDays}d`);
  }

  function renderInsights(metrics, workflow, adminSnapshot){
    const host = document.getElementById('analyticsInsights');
    if(!host) return;
    const suggestions = Array.isArray(workflow?.procurementSuggestions) ? workflow.procurementSuggestions.length : 0;
    const countDue = Number(adminSnapshot?.metrics?.countDueCount || 0);
    const insightRows = [
      {
        title: 'Inventory Value Trend',
        detail: metrics.inventoryTrend === null || metrics.inventoryTrend === undefined
          ? 'Not enough recent value history yet.'
          : `${metrics.inventoryTrend >= 0 ? 'Up' : 'Down'} ${fmtSignedPct(metrics.inventoryTrend)} versus the prior window baseline.`
      },
      {
        title: 'Lead Time And Delivery',
        detail: `${fmtDuration(metrics.avgLeadTime)} average lead time with ${fmtPct(metrics.onTimeRate)} on-time receipt performance.`
      },
      {
        title: 'Operational Pace',
        detail: `${fmtDuration(metrics.avgPickTime)} average pick completion and ${fmtDuration(metrics.avgCheckinTime)} average check-in completion in the last ${analyticsState.rangeDays} days.`
      },
      {
        title: 'Control Pressure',
        detail: `${fmtNum(suggestions)} procurement suggestions and ${fmtNum(countDue)} count-due items currently need review.`
      }
    ];
    host.innerHTML = insightRows.map((row)=> `
      <article class="analytics-insight-card">
        <strong>${escapeHtml(row.title)}</strong>
        <p>${escapeHtml(row.detail)}</p>
      </article>
    `).join('');
  }

  function renderDemandSignals(metrics){
    const host = document.getElementById('analyticsDemandSignals');
    if(!host) return;
    const signals = [
      { label: 'Top usage qty', value: fmtNum(metrics.topUsage?.[0]?.qty ?? null), tone: 'info' },
      { label: '80 / 20 SKU share', value: metrics.eightyTwenty === null || metrics.eightyTwenty === undefined ? 'N/A' : `${Math.round(metrics.eightyTwenty * 100)}%`, tone: 'static' },
      { label: 'Slow movers', value: fmtNum(metrics.slowMovingList?.length ?? null), tone: 'warn' },
      { label: 'Dead stock', value: fmtPct(metrics.totalItems ? metrics.deadStock / metrics.totalItems : null), tone: 'warn' },
      { label: 'Pending returns', value: fmtNum(metrics.pendingReturnsQty), tone: 'static' },
      { label: 'Inventory turns', value: fmtNum(metrics.turnover), tone: 'info' },
      { label: 'Avg pick time', value: fmtDuration(metrics.avgPickTime), tone: 'info' },
      { label: 'Avg check-in', value: fmtDuration(metrics.avgCheckinTime), tone: 'info' }
    ];
    host.innerHTML = signals.map((signal)=> `
      <div class="analytics-chip ${signal.tone}">
        <span>${escapeHtml(signal.label)}</span>
        <strong>${escapeHtml(signal.value)}</strong>
      </div>
    `).join('');
  }

  function renderWorkflowList(id, rows, emptyText, makeHtml){
    const host = document.getElementById(id);
    if(!host) return;
    if(!rows.length){
      host.innerHTML = `<div class="report-empty">${escapeHtml(emptyText)}</div>`;
      return;
    }
    host.innerHTML = rows.map(makeHtml).join('');
  }

  function renderRiskList(workflow){
    const overdue = (workflow?.exceptions?.overdueReturns || []).slice(0, 2).map((row)=>({
      title: row.code,
      badge: `${fmtNum(row.outstanding)} overdue`,
      meta: row.jobId ? `Return overdue for ${row.jobId}` : 'Return overdue',
      href: 'inventory-operations.html?mode=return',
      tone: 'danger'
    }));
    const negative = (workflow?.exceptions?.negativeAvailability || []).slice(0, 2).map((row)=>({
      title: row.code,
      badge: `${fmtNum(row.available)} available`,
      meta: 'Negative availability detected',
      href: 'inventory-list.html#negative',
      tone: 'danger'
    }));
    const reorder = (workflow?.exceptions?.missingReorderRule || []).slice(0, 2).map((row)=>({
      title: row.code,
      badge: 'Rule missing',
      meta: row.name || 'Low-stock item missing reorder point',
      href: 'item-master.html',
      tone: 'warn'
    }));
    const rows = [...overdue, ...negative, ...reorder].slice(0, 6);
    renderWorkflowList('analyticsRiskList', rows, 'No supply risks at the moment.', (row)=> `
      <article class="workflow-row compact">
        <div class="workflow-main">
          <div class="workflow-title-row">
            <strong>${escapeHtml(row.title)}</strong>
            <span class="badge ${escapeHtml(row.tone)}">${escapeHtml(row.badge)}</span>
          </div>
          <div class="workflow-sub">${escapeHtml(row.meta)}</div>
        </div>
        <div class="workflow-actions">
          <a class="action-btn" href="${escapeHtml(row.href)}">Open</a>
        </div>
      </article>
    `);
  }

  function renderProcurementList(workflow){
    const rows = (workflow?.procurementSuggestions || []).slice(0, 8);
    renderWorkflowList('analyticsProcurementList', rows, 'No procurement actions pending.', (row)=> `
      <article class="workflow-row compact">
        <div class="workflow-main">
          <div class="workflow-title-row">
            <strong>${escapeHtml(row.code)}</strong>
            <span class="badge ${Number(row.shortageQty || 0) > 0 ? 'danger' : 'info'}">${Number(row.shortageQty || 0) > 0 ? 'Shortage' : 'Order'}</span>
          </div>
          <div class="workflow-sub">${escapeHtml(row.name || '')}${row.jobId ? ` | ${escapeHtml(row.jobId)}` : ''}</div>
          <div class="workflow-metrics">
            <span>Open: <strong>${escapeHtml(fmtNum(row.outstandingQty))}</strong></span>
            <span>Available: <strong>${escapeHtml(fmtNum(row.availableQty))}</strong></span>
            <span>Supplier: <strong>${escapeHtml(row.supplierName || 'Unassigned')}</strong></span>
          </div>
        </div>
        <div class="workflow-actions">
          <a class="action-btn" href="order-register.html?project=${encodeURIComponent(row.jobId || '')}&loadMaterials=1#order">Open</a>
        </div>
      </article>
    `);
  }

  function renderTable(tableId, rows, columns, emptyText){
    const body = document.querySelector(`#${tableId} tbody`);
    if(!body) return;
    if(!rows.length){
      body.innerHTML = `<tr><td colspan="${columns.length}" style="text-align:center;color:#6b7280;">${escapeHtml(emptyText)}</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((row)=> `
      <tr>${columns.map((column)=> `<td>${escapeHtml(column(row))}</td>`).join('')}</tr>
    `).join('');
  }

  function formatAuditActor(row){
    if(row.userName && row.userEmail) return `${row.userName} (${row.userEmail})`;
    return row.userName || row.userEmail || 'System';
  }

  function renderActivityList(){
    const list = document.getElementById('analyticsActivityList');
    if(!list) return;
    const rows = Array.isArray(analyticsState.auditRows) ? analyticsState.auditRows.slice(0, 6) : [];
    if(!rows.length){
      list.innerHTML = '<li class="muted">No recent activity.</li>';
      return;
    }
    list.innerHTML = rows.map((row)=> `
      <li>
        <div class="worklist-main">
          <strong>${escapeHtml(row.label || row.action || 'Activity')}</strong>
          <span class="worklist-sub">${escapeHtml(row.summary || row.reference || row.code || 'No detail')}</span>
        </div>
        <span class="badge static">${escapeHtml(formatWhen(row.ts))}</span>
      </li>
    `).join('');
  }

  function renderCountDueList(adminSnapshot){
    const rows = Array.isArray(adminSnapshot?.countDue) ? adminSnapshot.countDue.slice(0, 6) : [];
    renderWorkflowList('analyticsCountDueList', rows, 'No cycle count backlog.', (row)=> `
      <article class="workflow-row compact">
        <div class="workflow-main">
          <div class="workflow-title-row">
            <strong>${escapeHtml(row.code)}</strong>
            <span class="badge warn">${row.lastCounted ? `Last ${escapeHtml(formatDateLabel(row.lastCounted))}` : 'Never counted'}</span>
          </div>
          <div class="workflow-sub">${escapeHtml(row.name || '')}</div>
          <div class="workflow-metrics">
            <span>Available: <strong>${escapeHtml(fmtNum(row.available))}</strong></span>
          </div>
        </div>
        <div class="workflow-actions">
          <a class="action-btn" href="inventory-list.html">Review</a>
        </div>
      </article>
    `);
  }

  function renderOverview(){
    const { metrics, workflow, adminSnapshot } = analyticsState;
    const criticalCount = (workflow?.exceptions?.negativeAvailability || []).length + (workflow?.exceptions?.overdueReturns || []).length;
    setRangeUi();
    setText('analytics-accuracy', fmtPct(metrics.accuracy));
    setText('analytics-discrepancy', fmtCurrency(metrics.discrepancyValue, true));
    setText('analytics-fill-rate', fmtPct(metrics.fillRate));
    setText('analytics-service-level', fmtPct(metrics.serviceLevel));
    setText('analytics-open-orders', fmtNum(adminSnapshot?.metrics?.openOrdersCount));
    setText('analytics-count-due', fmtNum(adminSnapshot?.metrics?.countDueCount));
    setText('analytics-critical', fmtNum(criticalCount));
    setText('analytics-alerts', fmtNum(metrics.alertsCount));

    const healthTone = criticalCount > 0 || Number(metrics.alertsCount || 0) > 5 ? 'danger' : Number(metrics.alertsCount || 0) > 0 ? 'warn' : 'info';
    const healthLabel = criticalCount > 0 ? `${fmtNum(criticalCount)} critical` : Number(metrics.alertsCount || 0) > 0 ? `${fmtNum(metrics.alertsCount)} alerts` : 'Stable';
    setBadge('analyticsHealthBadge', healthTone, healthLabel);
    setFreshness(Math.max(parseTs(metrics.generatedAt) || 0, parseTs(analyticsState.generatedAt) || 0));

    renderInsights(metrics, workflow, adminSnapshot);
    renderDemandSignals(metrics);
    renderRiskList(workflow);
    renderProcurementList(workflow);
    renderTable(
      'analyticsTopUsageTable',
      Array.isArray(metrics.topUsage) ? metrics.topUsage : [],
      [
        (row)=> row.code,
        (row)=> row.name || '',
        (row)=> fmtNum(row.qty),
        (row)=> fmtPct(row.share)
      ],
      'No usage data yet.'
    );
    renderTable(
      'analyticsSlowMovingTable',
      Array.isArray(metrics.slowMovingList) ? metrics.slowMovingList : [],
      [
        (row)=> row.code,
        (row)=> row.name || '',
        (row)=> fmtNum(row.moves),
        (row)=> fmtNum(row.available)
      ],
      'No slow movers found.'
    );
    renderActivityList();
    renderCountDueList(adminSnapshot);
  }

  function searchAuditRow(row){
    return [
      row.area,
      row.areaKey,
      row.label,
      row.action,
      row.code,
      row.reference,
      row.jobId,
      row.summary,
      row.userName,
      row.userEmail
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function buildAuditRows(){
    const search = (document.getElementById('histSearch')?.value || '').trim().toLowerCase();
    const area = (document.getElementById('histArea')?.value || '').trim().toLowerCase();
    const action = (document.getElementById('histAction')?.value || '').trim().toLowerCase();
    let rows = Array.isArray(analyticsState.auditRows) ? analyticsState.auditRows.slice() : [];
    rows.sort((a, b)=> (parseTs(b.ts) || 0) - (parseTs(a.ts) || 0));
    if(area){
      rows = rows.filter((row)=> String(row.areaKey || '').toLowerCase() === area);
    }
    if(action){
      rows = rows.filter((row)=> String(row.action || '').toLowerCase() === action);
    }
    if(search){
      rows = rows.filter((row)=> searchAuditRow(row).includes(search));
    }
    return rows;
  }

  function renderAuditBreakdown(rows){
    const host = document.getElementById('auditBreakdown');
    if(!host) return;
    const counts = new Map();
    rows.forEach((row)=>{
      const key = String(row.areaKey || '').toLowerCase() || 'system';
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const cards = [
      { key: 'inventory', label: 'Inventory', tone: 'info' },
      { key: 'operations', label: 'Operations', tone: 'static' },
      { key: 'procurement', label: 'Procurement', tone: 'warn' },
      { key: 'catalog', label: 'Catalog', tone: 'static' },
      { key: 'suppliers', label: 'Suppliers', tone: 'static' },
      { key: 'projects', label: 'Projects', tone: 'static' },
      { key: 'access', label: 'Access', tone: 'info' }
    ].filter((card)=> counts.has(card.key));
    if(!cards.length){
      host.innerHTML = '<div class="report-empty">No audit activity in this window.</div>';
      return;
    }
    host.innerHTML = cards.map((card)=> `
      <div class="analytics-chip ${card.tone}">
        <span>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(fmtNum(counts.get(card.key) || 0))}</strong>
      </div>
    `).join('');
  }

  function setAuditActionOptions(){
    const select = document.getElementById('histAction');
    if(!select) return;
    const current = select.value;
    const optionMap = new Map();
    (Array.isArray(analyticsState.auditRows) ? analyticsState.auditRows : []).forEach((row)=>{
      if(row?.action && !optionMap.has(row.action)){
        optionMap.set(row.action, row.label || row.action);
      }
    });
    const options = Array.from(optionMap.entries()).sort((a, b)=> a[1].localeCompare(b[1]));
    select.innerHTML = ['<option value="">All actions</option>']
      .concat(options.map(([action, label])=> `<option value="${escapeHtml(action)}">${escapeHtml(label)}</option>`))
      .join('');
    if(optionMap.has(current)) select.value = current;
  }

  function auditAreaTagClass(areaKey){
    const key = String(areaKey || '').toLowerCase();
    if(['inventory', 'operations', 'procurement', 'catalog', 'suppliers', 'projects', 'access'].includes(key)) return key;
    return 'system';
  }

  function renderAudit(){
    setAuditActionOptions();
    const rows = buildAuditRows();
    const tbody = document.querySelector('#historyTable tbody');
    const summary = rows.reduce((acc, row)=>{
      acc.total += 1;
      if(row.areaKey === 'inventory') acc.inventory += 1;
      if(row.areaKey === 'operations') acc.operations += 1;
      if(['catalog', 'suppliers', 'projects'].includes(row.areaKey)) acc.configuration += 1;
      if(row.userEmail || row.userName) acc.users.add(row.userEmail || row.userName);
      if(row.code) acc.items.add(row.code);
      return acc;
    }, {
      total: 0,
      inventory: 0,
      operations: 0,
      configuration: 0,
      users: new Set(),
      items: new Set()
    });

    const areaLabel = document.getElementById('histArea')?.selectedOptions?.[0]?.textContent || 'All areas';
    const actionLabel = document.getElementById('histAction')?.selectedOptions?.[0]?.textContent || 'All actions';
    const rangeLabel = `${analyticsState.rangeDays}d`;
    setText('audit-total', fmtNum(summary.total));
    setText('audit-issued', fmtNum(summary.inventory));
    setText('audit-received', fmtNum(summary.operations));
    setText('audit-returned', fmtNum(summary.configuration));
    setText('audit-reserved', fmtNum(summary.users.size));
    setText('audit-adjustments', fmtNum(summary.items.size));
    setText('auditRangeBadge', `${rangeLabel} | ${actionLabel !== 'All actions' ? actionLabel : areaLabel}`);
    renderAuditBreakdown(rows);

    if(!tbody) return;
    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#6b7280;">No audit activity found.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((row)=>{
      const primaryRef = row.code || row.reference || row.jobId || 'System';
      const secondaryRef = row.code && row.reference ? row.reference : (!row.code && row.jobId && row.jobId !== row.reference ? row.jobId : '');
      const qty = row.qty === null || row.qty === undefined || Number.isNaN(Number(row.qty)) ? '-' : fmtNum(row.qty);
      return `
        <tr>
          <td><span class="audit-area-tag ${escapeHtml(auditAreaTagClass(row.areaKey))}">${escapeHtml(row.area || 'System')}</span></td>
          <td>
            <div class="analytics-audit-action">
              <strong>${escapeHtml(row.label || row.action || 'Activity')}</strong>
              <span>${escapeHtml(row.action || '')}</span>
            </div>
          </td>
          <td>
            <div class="analytics-audit-ref">
              <strong>${escapeHtml(primaryRef)}</strong>
              ${secondaryRef ? `<span>${escapeHtml(secondaryRef)}</span>` : ''}
            </div>
          </td>
          <td>${escapeHtml(qty)}</td>
          <td>${escapeHtml(formatAuditActor(row))}</td>
          <td>${escapeHtml(formatWhen(row.ts))}</td>
          <td>
            <div class="analytics-audit-summary">
              <strong>${escapeHtml(row.summary || row.label || 'No detail')}</strong>
              ${row.jobId && !(row.summary || '').includes(row.jobId) ? `<span>Job: ${escapeHtml(row.jobId)}</span>` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function csvEscape(value){
    const text = String(value ?? '');
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportAuditCsv(){
    const rows = buildAuditRows();
    if(!rows.length) return;
    const headers = ['Area', 'Action', 'Item', 'Reference', 'Qty', 'User', 'When', 'Summary'];
    const lines = [headers.join(',')].concat(rows.map((row)=> [
      row.area || '',
      row.label || row.action || '',
      row.code || '',
      row.reference || row.jobId || '',
      row.qty ?? '',
      formatAuditActor(row),
      formatWhen(row.ts),
      row.summary || ''
    ].map(csvEscape).join(',')));
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `audit-${analyticsState.rangeDays}d-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function loadAnalytics({ force = false } = {}){
    setLoadingState(true);
    const days = analyticsState.rangeDays;
    try {
      const [metrics, workflow, adminSnapshot, auditData] = await Promise.all([
        utils.fetchJsonSafe(`/api/dashboard/manager?days=${days}`, { cacheTtlMs: 10000, forceRefresh: force }, {}) || {},
        utils.fetchJsonSafe('/api/workflows/overview', { cacheTtlMs: 5000, forceRefresh: force }, {}) || {},
        utils.fetchJsonSafe('/api/dashboard/admin', { cacheTtlMs: 10000, forceRefresh: force }, {}) || {},
        utils.fetchJsonSafe(`/api/analytics/audit?days=${days}&limit=600`, { cacheTtlMs: 5000, forceRefresh: force }, {}) || {}
      ]);

      analyticsState = {
        ...analyticsState,
        metrics: metrics || {},
        workflow: workflow || {},
        adminSnapshot: adminSnapshot || {},
        auditRows: Array.isArray(auditData?.events) ? auditData.events : [],
        auditActions: Array.isArray(auditData?.actions) ? auditData.actions : [],
        generatedAt: parseTs(auditData?.generatedAt) || Date.now()
      };

      setText('analyticsRangeMeta', `${days}d live view`);
      renderOverview();
      renderAudit();
    } catch (e) {
      analyticsState = {
        ...analyticsState,
        metrics: {},
        workflow: {},
        adminSnapshot: {},
        auditRows: [],
        auditActions: [],
        generatedAt: Date.now()
      };
      setBadge('analyticsHealthBadge', 'warn', 'Unavailable');
      setText('analyticsFreshness', 'Load failed');
      setText('analyticsRangeMeta', 'Retry needed');
      renderOverview();
      renderAudit();
    } finally {
      setLoadingState(false);
    }
  }

  function bindUi(){
    const hash = (window.location.hash || '').replace('#', '').toLowerCase();
    setRangeUi();
    setMode(hash === 'audit' ? 'audit' : 'overview');

    document.querySelectorAll('.mode-btn').forEach((btn)=>{
      btn.addEventListener('click', ()=>{
        const mode = btn.dataset.mode;
        setMode(mode);
        if(mode === 'audit'){
          window.location.hash = 'audit';
        }else{
          history.replaceState(null, '', window.location.pathname);
        }
      });
    });

    document.querySelectorAll('.analytics-range-btn').forEach((btn)=>{
      btn.addEventListener('click', ()=>{
        const nextRange = Number(btn.dataset.range);
        if(!RANGE_OPTIONS.includes(nextRange) || nextRange === analyticsState.rangeDays) return;
        analyticsState.rangeDays = nextRange;
        setRangeUi();
        loadAnalytics().catch(()=>{});
      });
    });

    document.getElementById('analyticsRefreshBtn')?.addEventListener('click', ()=>{
      loadAnalytics({ force: true }).catch(()=>{});
    });

    document.getElementById('histSearch')?.addEventListener('input', renderAudit);
    document.getElementById('histArea')?.addEventListener('change', renderAudit);
    document.getElementById('histAction')?.addEventListener('change', renderAudit);
    document.getElementById('auditExportBtn')?.addEventListener('click', exportAuditCsv);

    window.addEventListener('hashchange', ()=>{
      const nextHash = (window.location.hash || '').replace('#', '').toLowerCase();
      setMode(nextHash === 'audit' ? 'audit' : 'overview');
    });
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    const tick = ()=> setText('analyticsClock', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    tick();
    setInterval(tick, 60000);
    bindUi();
    loadAnalytics().catch(()=>{
      setBadge('analyticsHealthBadge', 'warn', 'Unavailable');
      setText('analyticsFreshness', 'Load failed');
      setText('analyticsRangeMeta', 'Retry needed');
      renderOverview();
      renderAudit();
    });
  });
})();
