(function(){
  const numFmt = new Intl.NumberFormat('en-US');
  const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const currencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const currencyFmtPrecise = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

  let analyticsState = {
    metrics: {},
    workflow: {},
    adminSnapshot: {},
    inventory: []
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

  function fmtCurrency(value, precise = false){
    if(value === null || value === undefined || Number.isNaN(value)) return 'N/A';
    return (precise ? currencyFmtPrecise : currencyFmt).format(value);
  }

  function fmtDuration(ms){
    if(!Number.isFinite(ms) || ms <= 0) return 'N/A';
    const mins = Math.round(ms / 60000);
    if(mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
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
    return d.toLocaleString([], { month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  }

  function formatDateLabel(val){
    const ts = parseTs(val);
    if(ts === null) return 'N/A';
    const d = new Date(ts);
    if(Number.isNaN(d.getTime())) return 'N/A';
    return d.toLocaleDateString([], { month:'short', day:'numeric' });
  }

  function typeLabel(type){
    if(type === 'in') return 'Check-In';
    if(type === 'out') return 'Check-Out';
    if(type === 'reserve') return 'Reserve';
    if(type === 'reserve_release') return 'Reserve Release';
    if(type === 'return') return 'Return';
    if(type === 'ordered') return 'Ordered';
    if(type === 'purchase') return 'Field Purchase';
    if(type === 'consume') return 'Consume';
    return type || 'Unknown';
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

  function renderInsights(metrics, workflow, adminSnapshot){
    const host = document.getElementById('analyticsInsights');
    if(!host) return;
    const insightRows = [
      {
        title: 'Inventory value trend',
        detail: metrics.inventoryTrend === null || metrics.inventoryTrend === undefined
          ? 'Not enough recent value history yet.'
          : `${metrics.inventoryTrend >= 0 ? 'Up' : 'Down'} ${fmtPct(Math.abs(metrics.inventoryTrend))} versus the prior 7-day baseline.`
      },
      {
        title: 'Lead time and delivery',
        detail: `${fmtDuration(metrics.avgLeadTime)} average lead time with ${fmtPct(metrics.onTimeRate)} on-time receipt performance.`
      },
      {
        title: 'Team throughput',
        detail: `${fmtNum(metrics.itemsPerEmployee)} units per active handler and ${fmtNum(metrics.ordersPerDay)} orders received per day in the last 7 days.`
      },
      {
        title: 'Workflow pressure',
        detail: `${fmtNum((workflow.procurementSuggestions || []).length)} procurement suggestions and ${fmtNum(adminSnapshot?.metrics?.countDueCount)} count-due items currently need admin attention.`
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
      { label: '80/20 SKU share', value: metrics.eightyTwenty === null || metrics.eightyTwenty === undefined ? 'N/A' : `${Math.round(metrics.eightyTwenty * 100)}%`, tone: 'static' },
      { label: 'Slow movers', value: fmtNum(metrics.slowMovingList?.length ?? null), tone: 'warn' },
      { label: 'Dead stock', value: fmtPct(metrics.totalItems ? metrics.deadStock / metrics.totalItems : null), tone: 'warn' },
      { label: 'Pending returns', value: fmtNum(metrics.pendingReturnsQty), tone: 'static' },
      { label: 'Inventory turns', value: fmtNum(metrics.turnover), tone: 'info' }
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

  function renderRiskList(metrics, workflow){
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
    setText('analytics-critical', fmtNum((workflow?.exceptions?.negativeAvailability || []).length + (workflow?.exceptions?.overdueReturns || []).length));
    setText('analytics-alerts', fmtNum(metrics.alertsCount));
  }

  function renderProcurementList(workflow){
    const rows = (workflow?.procurementSuggestions || []).slice(0, 6);
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

  function renderActivityList(adminSnapshot){
    const list = document.getElementById('analyticsActivityList');
    if(!list) return;
    const rows = Array.isArray(adminSnapshot?.activity) ? adminSnapshot.activity.slice(0, 6) : [];
    if(!rows.length){
      list.innerHTML = '<li class="muted">No recent activity.</li>';
      return;
    }
    list.innerHTML = rows.map((row)=> `
      <li>
        <div class="worklist-main">
          <strong>${escapeHtml(typeLabel(row.type))} ${escapeHtml(row.code || '')}</strong>
          <span class="worklist-sub">${escapeHtml(fmtNum(row.qty))}${row.jobId ? ` | ${escapeHtml(row.jobId)}` : ''}</span>
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
    setText('analytics-accuracy', fmtPct(metrics.accuracy));
    setText('analytics-discrepancy', fmtCurrency(metrics.discrepancyValue, true));
    setText('analytics-fill-rate', fmtPct(metrics.fillRate));
    setText('analytics-service-level', fmtPct(metrics.serviceLevel));
    setText('analytics-open-orders', fmtNum(adminSnapshot?.metrics?.openOrdersCount));
    setText('analytics-count-due', fmtNum(adminSnapshot?.metrics?.countDueCount));

    const criticalCount = (workflow?.exceptions?.negativeAvailability || []).length + (workflow?.exceptions?.overdueReturns || []).length;
    const healthTone = criticalCount > 0 || Number(metrics.alertsCount || 0) > 5 ? 'danger' : Number(metrics.alertsCount || 0) > 0 ? 'warn' : 'info';
    const healthLabel = criticalCount > 0 ? `${fmtNum(criticalCount)} critical` : Number(metrics.alertsCount || 0) > 0 ? `${fmtNum(metrics.alertsCount)} alerts` : 'Stable';
    setBadge('analyticsHealthBadge', healthTone, healthLabel);
    setFreshness(workflow?.generatedAt || Date.now());

    renderInsights(metrics, workflow, adminSnapshot);
    renderDemandSignals(metrics);
    renderRiskList(metrics, workflow);
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
    renderActivityList(adminSnapshot);
    renderCountDueList(adminSnapshot);
  }

  function buildAuditRows(){
    const search = (document.getElementById('histSearch')?.value || '').trim().toLowerCase();
    const type = document.getElementById('histType')?.value || '';
    let rows = Array.isArray(analyticsState.inventory) ? analyticsState.inventory.slice() : [];
    rows.sort((a, b)=> (parseTs(b.ts) || 0) - (parseTs(a.ts) || 0));

    if(search){
      rows = rows.filter((row)=>{
        const jobId = row.jobId || row.jobid || '';
        const userName = row.userName || row.username || '';
        const userEmail = row.userEmail || row.useremail || '';
        const notes = row.notes || row.reason || row.location || '';
        return [row.code, jobId, userName, userEmail, notes]
          .filter(Boolean)
          .some((value)=> String(value).toLowerCase().includes(search));
      });
    }

    if(type){
      rows = rows.filter((row)=> String(row.type || '').toLowerCase() === type);
    }
    return rows;
  }

  function renderAudit(){
    const rows = buildAuditRows();
    const tbody = document.querySelector('#historyTable tbody');
    if(!tbody) return;

    const summary = rows.reduce((acc, row)=>{
      const qty = Math.abs(Number(row.qty || 0) || 0);
      const type = String(row.type || '').toLowerCase();
      acc.total += 1;
      if(type === 'out') acc.issued += qty;
      if(type === 'in') acc.received += qty;
      if(type === 'return') acc.returned += qty;
      if(type === 'reserve') acc.reserved += qty;
      if(type === 'consume') acc.adjustments += qty;
      return acc;
    }, { total: 0, issued: 0, received: 0, returned: 0, reserved: 0, adjustments: 0 });

    setText('audit-total', fmtNum(summary.total));
    setText('audit-issued', fmtNum(summary.issued));
    setText('audit-received', fmtNum(summary.received));
    setText('audit-returned', fmtNum(summary.returned));
    setText('audit-reserved', fmtNum(summary.reserved));
    setText('audit-adjustments', fmtNum(summary.adjustments));
    setText('auditRangeBadge', document.getElementById('histType')?.value ? `${typeLabel(document.getElementById('histType').value)} only` : 'All activity');

    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#6b7280;">No history found.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((row)=>{
      const jobId = row.jobId || row.jobid || '';
      const userName = row.userName || row.username || '';
      const userEmail = row.userEmail || row.useremail || '';
      const user = userName ? `${userName}${userEmail ? ` (${userEmail})` : ''}` : (userEmail || '');
      const notes = row.notes || row.reason || row.location || '';
      return `
        <tr>
          <td>${escapeHtml(typeLabel(row.type))}</td>
          <td>${escapeHtml(row.status || '')}</td>
          <td>${escapeHtml(row.code || '')}</td>
          <td>${escapeHtml(fmtNum(row.qty))}</td>
          <td>${escapeHtml(jobId)}</td>
          <td>${escapeHtml(user)}</td>
          <td>${escapeHtml(formatWhen(row.ts))}</td>
          <td>${escapeHtml(notes)}</td>
        </tr>
      `;
    }).join('');
  }

  async function loadAnalytics(){
    const [metrics, workflow, adminSnapshot, inventory] = await Promise.all([
      utils.fetchJsonSafe('/api/dashboard/manager', { cacheTtlMs: 10000 }, {}) || {},
      utils.fetchJsonSafe('/api/workflows/overview', { cacheTtlMs: 5000 }, {}) || {},
      utils.fetchJsonSafe('/api/dashboard/admin', { cacheTtlMs: 10000 }, {}) || {},
      utils.fetchJsonSafe('/api/inventory', { cacheTtlMs: 5000 }, []) || []
    ]);

    analyticsState = {
      metrics: metrics || {},
      workflow: workflow || {},
      adminSnapshot: adminSnapshot || {},
      inventory: Array.isArray(inventory) ? inventory : []
    };

    renderOverview();
    renderAudit();
  }

  function bindUi(){
    const hash = (window.location.hash || '').replace('#', '').toLowerCase();
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

    document.getElementById('histSearch')?.addEventListener('input', renderAudit);
    document.getElementById('histType')?.addEventListener('change', renderAudit);
    window.addEventListener('hashchange', ()=>{
      const nextHash = (window.location.hash || '').replace('#', '').toLowerCase();
      setMode(nextHash === 'audit' ? 'audit' : 'overview');
    });
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    const tick = ()=> setText('analyticsClock', new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }));
    tick();
    setInterval(tick, 60000);
    bindUi();
    loadAnalytics().catch(()=>{
      setBadge('analyticsHealthBadge', 'warn', 'Unavailable');
      setText('analyticsFreshness', 'Load failed');
      renderAudit();
    });
  });
})();
