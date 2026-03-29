function renderEmployeeList(id, rows, emptyText){
  const el = document.getElementById(id);
  if(!el) return;
  const items = Array.isArray(rows) ? rows : [];
  el.innerHTML = items.length
    ? items.map(row=> `<li><div class="worklist-main"><strong>${row.title || ''}</strong><span class="worklist-sub">${row.detail || ''}</span></div><a class="kpi-link" href="${row.href || '#'}">Open</a></li>`).join('')
    : `<li class="muted">${emptyText}</li>`;
}

async function renderEmployeeDashboard(){
  const workflow = await utils.fetchJsonSafe('/api/workflows/overview', { cacheTtlMs: 5000 }, {}) || {};
  const inbox = workflow?.inbox?.employee || {};
  renderEmployeeList('employeeInboundList', inbox.inbound, 'No inbound work assigned.');
}

document.addEventListener('DOMContentLoaded', ()=>{
  renderEmployeeDashboard();
});
