const FALLBACK = 'N/A';
let jobCache = [];
let isAdmin = false;
let editingCode = null;

function normalizeJobRow(row){
  const safe = row || {};
  const schedule = safe.scheduleDate || safe.scheduledate || '';
  return {
    code: safe.code || '',
    name: safe.name || '',
    status: safe.status || '',
    startDate: safe.startDate || safe.startdate || schedule || '',
    endDate: safe.endDate || safe.enddate || '',
    location: safe.location || '',
    notes: safe.notes || '',
    updatedAt: safe.updatedAt || safe.updatedat || ''
  };
}

async function loadJobs(){
  try{
    const r = await fetch('/api/jobs',{credentials:'include'});
    if(r.status === 401){ window.location.href='login.html'; return []; }
    if(r.ok){
      const data = await r.json();
      const rows = Array.isArray(data) ? data : [];
      jobCache = rows.map(normalizeJobRow);
      return jobCache;
    }
  }catch(e){}
  jobCache = [];
  return [];
}

function formatDate(val){
  const d = parseDateValue(val);
  if(!d) return FALLBACK;
  return d.toLocaleDateString();
}

function formatDateTime(val){
  if(!val) return FALLBACK;
  if(window.utils && utils.formatDateTime) return utils.formatDateTime(val);
  const d = parseDateValue(val);
  if(!d) return FALLBACK;
  return d.toLocaleString();
}

function formatStatus(val){
  const raw = (val || '').toString().trim();
  if(!raw) return FALLBACK;
  return raw.replace(/-/g,' ').replace(/\b\w/g, c=> c.toUpperCase());
}

function escapeHtml(value){
  return String(value || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/\"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function formatNotes(val){
  const note = (val || '').toString().trim();
  if(!note) return '';
  if(note.length <= 60) return note;
  return note.slice(0,57) + '...';
}

function parseDateValue(val){
  if(val === undefined || val === null) return null;
  if(typeof val === 'string'){
    const trimmed = val.trim();
    if(!trimmed) return null;
    if(/^\d+$/.test(trimmed)){
      const num = Number(trimmed);
      const d = new Date(num);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if(match){
      const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getEntryJobId(entry){
  const raw = entry?.jobId || entry?.jobid || '';
  const val = (raw || '').toString().trim();
  if(!val) return '';
  const lowered = val.toLowerCase();
  if(['general','general inventory','none','unassigned'].includes(lowered)) return '';
  return val;
}

function setEditMode(project){
  if(!project) return;
  editingCode = project.code;
  const codeInput = document.getElementById('jobEditCode');
  const nameInput = document.getElementById('jobEditName');
  const statusInput = document.getElementById('jobEditStatus');
  const startInput = document.getElementById('jobEditStartDate');
  const endInput = document.getElementById('jobEditEndDate');
  const locationInput = document.getElementById('jobEditLocation');
  const notesInput = document.getElementById('jobEditNotes');
  if(codeInput){
    codeInput.value = project.code || '';
    codeInput.readOnly = true;
  }
  if(nameInput) nameInput.value = project.name || '';
  if(statusInput) statusInput.value = project.status || 'planned';
  if(startInput) startInput.value = project.startDate || '';
  if(endInput) endInput.value = project.endDate || '';
  if(locationInput) locationInput.value = project.location || '';
  if(notesInput) notesInput.value = project.notes || '';

  const meta = document.getElementById('jobEditMeta');
  if(meta) meta.textContent = `Editing project: ${project.code}`;
  const modal = document.getElementById('jobEditModal');
  if(modal) modal.classList.remove('hidden');
}

function clearEditMode(){
  editingCode = null;
  const form = document.getElementById('jobEditForm');
  if(form) form.reset();
  const statusInput = document.getElementById('jobEditStatus');
  if(statusInput) statusInput.value = 'planned';
  const modal = document.getElementById('jobEditModal');
  if(modal) modal.classList.add('hidden');
}

function resetAddForm(){
  const form = document.getElementById('jobForm');
  if(form) form.reset();
  const statusInput = document.getElementById('jobStatus');
  if(statusInput) statusInput.value = 'planned';
  const codeInput = document.getElementById('jobCode');
  if(codeInput) codeInput.disabled = false;
}

async function saveProject(project){
  if(!isAdmin) return { ok:false, error:'Admin only' };
  try{
    const r = await fetch('/api/jobs',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      credentials:'include',
      body:JSON.stringify(project)
    });
    if(r.status === 401){ return { ok:false, error:'Unauthorized. Please log in again.' }; }
    if(!r.ok){
      const data = await r.json().catch(()=>({}));
      return { ok:false, error: data.error || r.statusText || 'Failed to save project' };
    }
    return { ok:true };
  }catch(e){
    return { ok:false, error: e.message || 'Failed to save project' };
  }
}

async function deleteProjectApi(code){
  if(!isAdmin) return false;
  try{
    const r = await fetch(`/api/jobs/${code}`,{method:'DELETE',credentials:'include'});
    if(r.status === 401){ window.location.href='login.html'; return false; }
    return r.ok;
  }catch(e){return false;}
}

async function renderProjects(){
  const tbody = document.querySelector('#projectTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const jobs = await loadJobs();
  const search = (document.getElementById('projectSearchBox')?.value || '').toLowerCase();
  let filtered = jobs.slice();
  if(search){
    filtered = filtered.filter(j=>{
      const code = (j.code || '').toLowerCase();
      const name = (j.name || '').toLowerCase();
      const location = (j.location || '').toLowerCase();
      const status = (j.status || '').toLowerCase();
      const notes = (j.notes || '').toLowerCase();
      return code.includes(search) || name.includes(search) || location.includes(search) || status.includes(search) || notes.includes(search);
    });
  }
  filtered.sort((a,b)=> (a.code || '').localeCompare(b.code || ''));

  const countBadge = document.getElementById('projectCount');
  if(countBadge) countBadge.textContent = `${filtered.length}`;

  const actionsHeader = document.getElementById('projectActionsHeader');
  if(actionsHeader) actionsHeader.style.display = isAdmin ? '' : 'none';

  const colCount = isAdmin ? 9 : 8;
  if(!filtered.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="${colCount}" style="text-align:center;color:#6b7280;">No projects found</td>`;
    tbody.appendChild(tr);
    return;
  }

  filtered.forEach(project=>{
    const tr = document.createElement('tr');
    const statusLabel = formatStatus(project.status);
    const startLabel = formatDate(project.startDate);
    const endLabel = formatDate(project.endDate);
    const locationLabel = project.location || '';
    const notesLabel = formatNotes(project.notes);
    const updatedLabel = formatDateTime(project.updatedAt);
    const actionCell = isAdmin ? `<td><button class="action-btn edit-btn" data-code="${project.code}">Edit</button><button class="action-btn delete-btn" data-code="${project.code}">Delete</button></td>` : '';
    tr.innerHTML = `<td>${escapeHtml(project.code)}</td><td>${escapeHtml(project.name || '')}</td><td>${escapeHtml(statusLabel)}</td><td>${startLabel}</td><td>${endLabel}</td><td>${escapeHtml(locationLabel)}</td><td title="${escapeHtml(project.notes || '')}">${escapeHtml(notesLabel)}</td><td>${updatedLabel}</td>${actionCell}`;
    tbody.appendChild(tr);
  });

  if(isAdmin){
    document.querySelectorAll('.edit-btn').forEach(btn=>{
      btn.addEventListener('click', ev=>{
        const code = ev.target.dataset.code;
        const project = jobCache.find(j=> (j.code || '') === code);
        if(project) setEditMode(project);
      });
    });
    document.querySelectorAll('.delete-btn').forEach(btn=>{
      btn.addEventListener('click', async ev=>{
        const code = ev.target.dataset.code;
        if(!confirm(`Delete project "${code}"?`)) return;
        const ok = await deleteProjectApi(code);
        if(!ok) alert('Failed to delete project');
        else {
          if(editingCode === code) clearEditMode();
          await renderProjects();
        }
      });
    });
  }
}

function initProjectForm(){
  const form = document.getElementById('jobForm');
  if(!form) return;
  if(!isAdmin){
    form.addEventListener('submit', ev=>{
      ev.preventDefault();
      alert('Admin only');
    });
    return;
  }
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    const code = document.getElementById('jobCode').value.trim();
    const name = document.getElementById('jobName').value.trim();
    const status = document.getElementById('jobStatus')?.value || 'planned';
    const startDate = document.getElementById('jobStartDate')?.value || '';
    const endDate = document.getElementById('jobEndDate')?.value || '';
    const location = document.getElementById('jobLocation')?.value.trim() || '';
    const notes = document.getElementById('jobNotes')?.value.trim() || '';
    if(!code){alert('Project code required');return;}
    const result = await saveProject({code,name,status,startDate,endDate,location,notes});
    if(!result.ok){
      alert(result.error || 'Failed to save project (check permissions or server)');
    }else{
      resetAddForm();
      await renderProjects();
    }
  });
  document.getElementById('jobClearBtn')?.addEventListener('click', resetAddForm);

  const editForm = document.getElementById('jobEditForm');
  if(editForm){
    editForm.addEventListener('submit', async ev=>{
      ev.preventDefault();
      const code = editingCode || document.getElementById('jobEditCode')?.value.trim() || '';
      const name = document.getElementById('jobEditName')?.value.trim() || '';
      const status = document.getElementById('jobEditStatus')?.value || 'planned';
      const startDate = document.getElementById('jobEditStartDate')?.value || '';
      const endDate = document.getElementById('jobEditEndDate')?.value || '';
      const location = document.getElementById('jobEditLocation')?.value.trim() || '';
      const notes = document.getElementById('jobEditNotes')?.value.trim() || '';
      if(!code){alert('Project code required');return;}
      const result = await saveProject({code,name,status,startDate,endDate,location,notes});
      if(!result.ok){
        alert(result.error || 'Failed to save project (check permissions or server)');
      }else{
        clearEditMode();
        await renderProjects();
      }
    });
  }
  document.getElementById('jobEditCancel')?.addEventListener('click', clearEditMode);
  document.getElementById('jobEditClose')?.addEventListener('click', clearEditMode);
  document.getElementById('jobEditModal')?.addEventListener('click', ev=>{
    if(ev.target === ev.currentTarget) clearEditMode();
  });
  document.addEventListener('keydown', ev=>{
    const modal = document.getElementById('jobEditModal');
    if(ev.key === 'Escape' && modal && !modal.classList.contains('hidden')) clearEditMode();
  });
}

function initTabs(){
  const buttons = document.querySelectorAll('.mode-btn');
  const contents = document.querySelectorAll('.mode-content');
  const setTab = (tab)=>{
    buttons.forEach(b=> b.classList.toggle('active', b.dataset.tab === tab));
    contents.forEach(c=> c.classList.toggle('active', c.id === `${tab}-tab`));
    if(history.replaceState) history.replaceState(null, '', `#${tab}`);
  };
  buttons.forEach(btn=>{
    btn.addEventListener('click', ()=> setTab(btn.dataset.tab));
  });
  const hash = (window.location.hash || '').replace('#','');
  const startTab = (hash === 'report' || hash === 'projects') ? hash : (isAdmin ? 'projects' : 'report');
  setTab(startTab);
}

async function loadEntries(){
  try{
    const r = await fetch('/api/inventory');
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

function aggregateByProject(entries){
  const projects = {};
  entries.forEach(e=>{
    const projectId = getEntryJobId(e) || 'General';
    const key = `${projectId}|${e.code}`;
    if(!projects[key]) projects[key] = { projectId, code: e.code, inQty: 0, outQty: 0, reserveQty: 0 };
    const qty = Number(e.qty || 0);
    if(e.type === 'in' || e.type === 'return') projects[key].inQty += qty;
    else if(e.type === 'out') projects[key].outQty += qty;
    else if(e.type === 'reserve') projects[key].reserveQty += qty;
    else if(e.type === 'reserve_release') projects[key].reserveQty -= qty;
  });
  return Object.values(projects).map(p=>({
    ...p, netUsage: p.inQty - p.outQty
  }));
}

const GENERAL_LABEL = 'General';
const reportDetailMap = new Map();
let reportExpanded = false;

function isGeneralProject(value){
  const lowered = (value || '').toString().trim().toLowerCase();
  return lowered === 'general' || lowered === 'general inventory';
}

function encodeKey(value){
  return encodeURIComponent(value || '');
}

function decodeKey(value){
  try{ return decodeURIComponent(value || ''); }catch(e){ return value || ''; }
}

function getProjectMeta(projectId){
  const match = jobCache.find(j=> (j.code || '').toLowerCase() === projectId.toLowerCase());
  if(match) return match;
  return { code: projectId, status: isGeneralProject(projectId) ? 'general' : '', startDate: '', endDate: '', location: '', notes: '' };
}

function buildProjectSummary(items){
  const map = new Map();
  items.forEach(item=>{
    const pid = item.projectId;
    if(!map.has(pid)) map.set(pid, { projectId: pid, inQty: 0, outQty: 0, reserveQty: 0, netUsage: 0, items: [] });
    const rec = map.get(pid);
    rec.inQty += item.inQty;
    rec.outQty += item.outQty;
    rec.reserveQty += item.reserveQty;
    rec.netUsage += item.netUsage;
    rec.items.push(item);
  });
  return Array.from(map.values());
}

function applyReportFilters(projects){
  const search = (document.getElementById('reportSearchBox')?.value || '').toLowerCase();
  const statusFilter = (document.getElementById('reportStatusFilter')?.value || '').toLowerCase();
  const locationFilter = (document.getElementById('reportLocationFilter')?.value || '').toLowerCase();
  const windowFilter = (document.getElementById('reportWindowFilter')?.value || '').toLowerCase();
  const includeGeneral = document.getElementById('reportIncludeGeneral')?.checked !== false;
  const hasActivity = document.getElementById('reportHasActivity')?.checked;
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return projects.filter(p=>{
    if(!includeGeneral && isGeneralProject(p.projectId)) return false;
    const meta = getProjectMeta(p.projectId);
    const statusVal = (meta.status || '').toLowerCase();
    if(statusFilter && statusVal !== statusFilter) return false;
    if(locationFilter){
      const locationVal = (meta.location || '').toLowerCase();
      if(!locationVal.includes(locationFilter)) return false;
    }
    if(hasActivity){
      const active = (p.inQty || 0) + (p.outQty || 0) + (p.reserveQty || 0);
      if(active <= 0) return false;
    }
    if(windowFilter){
      const startTs = meta.startDate ? parseDateValue(meta.startDate)?.getTime() : null;
      const endTs = meta.endDate ? parseDateValue(meta.endDate)?.getTime() : null;
      if(windowFilter === 'upcoming7'){
        const windowEnd = todayStart + (7 * 24 * 60 * 60 * 1000);
        if(!startTs || startTs < todayStart || startTs > windowEnd) return false;
      }else if(windowFilter === 'upcoming30'){
        const windowEnd = todayStart + (30 * 24 * 60 * 60 * 1000);
        if(!startTs || startTs < todayStart || startTs > windowEnd) return false;
      }else if(windowFilter === 'overdue'){
        if(!endTs || endTs >= todayStart) return false;
      }else if(windowFilter === 'missingdates'){
        if(startTs || endTs) return false;
      }
    }
    if(search){
      const location = (meta.location || '').toLowerCase();
      const notes = (meta.notes || '').toLowerCase();
      const projectText = p.projectId.toLowerCase();
      if(!(projectText.includes(search) || statusVal.includes(search) || location.includes(search) || notes.includes(search))){
        return false;
      }
    }
    return true;
  }).map(p=>({ ...p, meta: getProjectMeta(p.projectId) }));
}

function updateReportSummary(list){
  const totalProjects = list.length;
  const activeProjects = list.filter(p=> (p.meta.status || '').toLowerCase() === 'active').length;
  const checkedOut = list.reduce((sum,p)=> sum + (Number(p.outQty)||0), 0);
  const reserved = list.reduce((sum,p)=> sum + (Number(p.reserveQty)||0), 0);
  const setText = (id, val)=>{
    const el = document.getElementById(id);
    if(el) el.textContent = `${val}`;
  };
  setText('reportTotalProjects', totalProjects);
  setText('reportActiveProjects', activeProjects);
  setText('reportCheckedOut', checkedOut);
  setText('reportReserved', reserved);
}

function buildReportSummary(items){
  const summaryMap = new Map();
  jobCache.forEach(job=>{
    if(!job.code) return;
    summaryMap.set(job.code, { projectId: job.code, inQty: 0, outQty: 0, reserveQty: 0, netUsage: 0, items: [] });
  });
  items.forEach(item=>{
    const pid = item.projectId;
    if(!summaryMap.has(pid)){
      summaryMap.set(pid, { projectId: pid, inQty: 0, outQty: 0, reserveQty: 0, netUsage: 0, items: [] });
    }
    const rec = summaryMap.get(pid);
    rec.inQty += item.inQty;
    rec.outQty += item.outQty;
    rec.reserveQty += item.reserveQty;
    rec.netUsage += item.netUsage;
    rec.items.push(item);
  });
  return Array.from(summaryMap.values());
}

function buildDetailTable(items){
  if(!items.length) return '<div style="color:#6b7280;">No items</div>';
  const rows = items.slice().sort((a,b)=> (a.code || '').localeCompare(b.code || '')).map(item=>{
    const onHand = (item.inQty || 0) - (item.outQty || 0);
    return `<tr><td>${escapeHtml(item.code || '')}</td><td>${item.inQty}</td><td>${item.outQty}</td><td>${item.reserveQty}</td><td>${onHand}</td><td>${item.netUsage}</td></tr>`;
  }).join('');
  return `<table class="detail-table">
    <thead><tr><th>Code</th><th>Checked In</th><th>Checked Out</th><th>Reserved</th><th>On Hand</th><th>Net Usage</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function openProjectDetail(btn){
  const key = btn.dataset.project;
  const row = btn.closest('tr');
  if(!row) return;
  let detailRow = row.nextElementSibling;
  if(detailRow && detailRow.classList.contains('report-detail') && detailRow.dataset.project === key){
    detailRow.style.display = '';
    btn.textContent = 'Hide Items';
    return;
  }
  const items = reportDetailMap.get(key) || [];
  detailRow = document.createElement('tr');
  detailRow.className = 'report-detail';
  detailRow.dataset.project = key;
  const colCount = isAdmin ? 11 : 10;
  detailRow.innerHTML = `<td colspan="${colCount}">${buildDetailTable(items)}</td>`;
  row.parentNode.insertBefore(detailRow, row.nextSibling);
  btn.textContent = 'Hide Items';
}

function closeProjectDetail(btn){
  const row = btn.closest('tr');
  const detailRow = row?.nextElementSibling;
  if(detailRow && detailRow.classList.contains('report-detail')){
    detailRow.style.display = 'none';
  }
  btn.textContent = 'View Items';
}

function toggleProjectDetail(btn){
  const row = btn.closest('tr');
  const detailRow = row?.nextElementSibling;
  if(detailRow && detailRow.classList.contains('report-detail') && detailRow.style.display !== 'none'){
    closeProjectDetail(btn);
  }else{
    openProjectDetail(btn);
  }
}

function setExpandAllState(expand){
  reportExpanded = expand;
  const expandBtn = document.getElementById('reportExpandAll');
  if(expandBtn) expandBtn.textContent = expand ? 'Collapse All' : 'Expand All';
}

async function renderReport(){
  const tbody = document.querySelector('#reportTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  await loadJobs();
  const entries = await loadEntries();
  const items = aggregateByProject(entries);
  const summary = buildReportSummary(items);
  const filtered = applyReportFilters(summary);
  updateReportSummary(filtered);

  reportDetailMap.clear();
  filtered.forEach(p=>{
    const key = encodeKey(p.projectId);
    reportDetailMap.set(key, p.items || []);
  });

  const actionsHeader = document.getElementById('reportActionsHeader');
  if(actionsHeader) actionsHeader.style.display = isAdmin ? '' : 'none';
  const colCount = isAdmin ? 11 : 10;
  if(!filtered.length){
    const tr = document.createElement('tr');
    const message = (jobCache.length === 0 && items.length === 0) ? 'No projects created yet' : 'No matching projects';
    tr.innerHTML = `<td colspan="${colCount}" style="text-align:center;color:#6b7280;">${message}</td>`;
    tbody.appendChild(tr);
    setExpandAllState(false);
    return;
  }

  const rows = filtered.sort((a,b)=> a.projectId.localeCompare(b.projectId));
  rows.forEach(project=>{
    const meta = project.meta || {};
    const onHand = (project.inQty || 0) - (project.outQty || 0);
    const statusLabel = meta.status ? formatStatus(meta.status) : (isGeneralProject(project.projectId) ? GENERAL_LABEL : FALLBACK);
    const startLabel = formatDate(meta.startDate);
    const endLabel = formatDate(meta.endDate);
    const locationLabel = meta.location || '';
    const key = encodeKey(project.projectId);
    const statusRaw = (meta.status || '').toLowerCase();
    const isComplete = ['complete','completed','closed','archived'].includes(statusRaw);
    let actionCell = '';
    if(isAdmin){
      if(isGeneralProject(project.projectId)){
        actionCell = `<td>${FALLBACK}</td>`;
      }else if(isComplete){
        actionCell = `<td><span class="badge info">Completed</span></td>`;
      }else{
        actionCell = `<td><button class="action-btn complete-btn" data-code="${key}">Mark Complete</button></td>`;
      }
    }
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(project.projectId)}</td>
      <td>${escapeHtml(statusLabel)}</td>
      <td>${startLabel}</td>
      <td>${endLabel}</td>
      <td>${escapeHtml(locationLabel)}</td>
      <td>${onHand}</td>
      <td>${project.outQty}</td>
      <td>${project.reserveQty}</td>
      <td>${project.netUsage}</td>
      <td><button class="action-btn report-toggle" data-project="${key}">View Items</button></td>
      ${actionCell}
    `;
    tbody.appendChild(tr);
  });

  document.querySelectorAll('.report-toggle').forEach(btn=>{
    btn.addEventListener('click', ()=> toggleProjectDetail(btn));
  });
  if(isAdmin){
    document.querySelectorAll('.complete-btn').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const code = decodeKey(btn.dataset.code || '');
        if(!code) return;
        if(!confirm(`Mark project "${code}" complete?`)) return;
        const meta = getProjectMeta(code);
        const result = await saveProject({
          code: meta.code || code,
          name: meta.name || '',
          status: 'complete',
          startDate: meta.startDate || '',
          endDate: meta.endDate || '',
          location: meta.location || '',
          notes: meta.notes || ''
        });
        if(!result.ok){
          alert(result.error || 'Failed to update project');
          return;
        }
        await renderProjects();
        await renderReport();
      });
    });
  }
  setExpandAllState(false);
}

async function exportReportCSV(){
  await loadJobs();
  const entries = await loadEntries();
  const items = aggregateByProject(entries);
  const summary = buildReportSummary(items);
  const filtered = applyReportFilters(summary);
  if(!filtered.length){alert('No project data to export');return;}
  const hdr = ['projectId','status','startDate','endDate','location','code','checkedIn','checkedOut','reserved','netUsage'];
  const rows = [];
  filtered.forEach(p=>{
    const meta = getProjectMeta(p.projectId);
    if(!p.items || p.items.length === 0){
      rows.push([
        p.projectId,
        meta.status || '',
        meta.startDate || '',
        meta.endDate || '',
        meta.location || '',
        '',
        0,
        0,
        0,
        0
      ]);
      return;
    }
    p.items.forEach(r=>{
      rows.push([
        p.projectId,
        meta.status || '',
        meta.startDate || '',
        meta.endDate || '',
        meta.location || '',
        r.code,
        r.inQty,
        r.outQty,
        r.reserveQty,
        r.netUsage
      ]);
    });
  });
  const csv = [hdr.join(','),...rows.map(r=>r.map(c=>`"${String(c ?? '').replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob = new Blob([csv],{type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'project-report.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded', async ()=>{
  if(window.utils){
    if(!utils.requireSession?.()) return;
    utils.wrapFetchWithRole?.();
    utils.applyStoredTheme?.();
    utils.applyNavVisibility?.();
    utils.setupLogout?.();
  }
  const user = window.utils?.getSession?.();
  isAdmin = user?.role === 'admin';

  const adminOnly = document.querySelector('.admin-only');
  if(adminOnly && !isAdmin) adminOnly.style.display = 'none';

  initTabs();
  initProjectForm();
  await renderProjects();
  await renderReport();

  document.getElementById('projectSearchBox')?.addEventListener('input', renderProjects);
  document.getElementById('reportSearchBox')?.addEventListener('input', renderReport);
  document.getElementById('reportStatusFilter')?.addEventListener('change', renderReport);
  document.getElementById('reportLocationFilter')?.addEventListener('input', renderReport);
  document.getElementById('reportWindowFilter')?.addEventListener('change', renderReport);
  document.getElementById('reportIncludeGeneral')?.addEventListener('change', renderReport);
  document.getElementById('reportHasActivity')?.addEventListener('change', renderReport);
  document.getElementById('reportExportBtn')?.addEventListener('click', exportReportCSV);
  document.getElementById('reportExpandAll')?.addEventListener('click', ()=>{
    const toggles = document.querySelectorAll('.report-toggle');
    if(!toggles.length) return;
    if(reportExpanded){
      toggles.forEach(btn=> closeProjectDetail(btn));
      setExpandAllState(false);
    }else{
      toggles.forEach(btn=> openProjectDetail(btn));
      setExpandAllState(true);
    }
  });
});
