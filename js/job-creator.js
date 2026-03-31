const FALLBACK = 'N/A';
let jobCache = [];
let itemsCache = [];
let suppliersCache = [];
let isAdmin = false;
let editingCode = null;
let projectMaterialsReportCache = new Map();
let workflowOverviewCache = null;
const REPORT_SORT_DEFAULT = 'closestUpcoming';
const CLOSED_PROJECT_STATUSES = new Set(['complete','completed','closed','archived','cancelled','canceled']);

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

async function loadItems(){
  try{
    itemsCache = await utils.fetchJsonSafe('/api/items', {}, []) || [];
  }catch(e){
    itemsCache = [];
  }
  return itemsCache;
}

async function loadSuppliers(){
  try{
    suppliersCache = await utils.fetchJsonSafe('/api/suppliers', {}, []) || [];
  }catch(e){
    suppliersCache = [];
  }
  ['job-material-lines','job-edit-material-lines'].forEach(refreshMaterialSupplierOptions);
  return suppliersCache;
}

function refreshMaterialSupplierOptions(containerId){
  document.querySelectorAll(`#${containerId} .order-line select[name="supplierId"]`).forEach(select=>{
    const current = select.value;
    select.innerHTML = '<option value="">Unassigned supplier</option>';
    suppliersCache
      .slice()
      .sort((a,b)=> (a.name || '').localeCompare(b.name || ''))
      .forEach(supplier=>{
        const opt = document.createElement('option');
        opt.value = supplier.id;
        opt.textContent = supplier.name || FALLBACK;
        select.appendChild(opt);
      });
    if(current && suppliersCache.some(s=> s.id === current)) select.value = current;
  });
}

function formatDate(val){
  if(window.utils?.formatDateOnly) return utils.formatDateOnly(val);
  const d = parseDateValue(val);
  if(!d) return FALLBACK;
  return Number.isNaN(d.getTime()) ? FALLBACK : d.toLocaleDateString([], { year:'numeric', month:'short', day:'2-digit' });
}

function formatDateTime(val){
  if(!val) return FALLBACK;
  if(window.utils?.formatDateTime) return utils.formatDateTime(val);
  const d = parseDateValue(val);
  if(!d) return FALLBACK;
  return Number.isNaN(d.getTime()) ? FALLBACK : d.toLocaleString([], { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
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

function formatProjectDates(meta){
  const startLabel = formatDate(meta.startDate);
  const endLabel = formatDate(meta.endDate);
  if(startLabel !== FALLBACK && endLabel !== FALLBACK) return `Start ${startLabel} / End ${endLabel}`;
  if(startLabel !== FALLBACK) return `Start ${startLabel}`;
  if(endLabel !== FALLBACK) return `End ${endLabel}`;
  return FALLBACK;
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

async function setEditMode(project){
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
  const materials = await loadProjectMaterials(project.code);
  resetMaterialLines('job-edit-material-lines', materials);

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
  resetMaterialLines('job-edit-material-lines');
  const editBulk = document.getElementById('jobEditMaterialBulk');
  if(editBulk) editBulk.value = '';
  const modal = document.getElementById('jobEditModal');
  if(modal) modal.classList.add('hidden');
}

function todayStartTs(){
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function getProjectDisplaySort(project){
  const todayTs = todayStartTs();
  const status = (project?.status || '').toString().trim().toLowerCase();
  const startTs = parseDateValue(project?.startDate)?.getTime() || 0;
  const endTs = parseDateValue(project?.endDate)?.getTime() || 0;
  const updatedTs = parseDateValue(project?.updatedAt)?.getTime() || 0;
  const isClosed = CLOSED_PROJECT_STATUSES.has(status);
  const isActive = !isClosed && (
    status === 'active' ||
    ((startTs && startTs <= todayTs) && (!endTs || endTs >= todayTs))
  );
  const isUpcoming = !isClosed && !isActive && startTs && startTs >= todayTs;

  if(isActive){
    return { bucket: 0, sortValue: endTs && endTs >= todayTs ? endTs : (startTs || todayTs) };
  }
  if(isUpcoming){
    return { bucket: 1, sortValue: startTs };
  }
  return { bucket: 2, sortValue: -(updatedTs || endTs || startTs || 0) };
}

function compareProjectsForDisplay(a, b){
  const aSort = getProjectDisplaySort(a);
  const bSort = getProjectDisplaySort(b);
  if(aSort.bucket !== bSort.bucket) return aSort.bucket - bSort.bucket;
  if(aSort.sortValue !== bSort.sortValue) return aSort.sortValue - bSort.sortValue;
  const aCode = (a?.code || a?.projectId || '').toString();
  const bCode = (b?.code || b?.projectId || '').toString();
  return aCode.localeCompare(bCode);
}

function dayDiffFromToday(ts){
  if(!ts) return null;
  return Math.round((ts - todayStartTs()) / (24 * 60 * 60 * 1000));
}

function getTimelineMeta(meta){
  const todayTs = todayStartTs();
  const startTs = parseDateValue(meta?.startDate)?.getTime() || 0;
  const endTs = parseDateValue(meta?.endDate)?.getTime() || 0;
  const status = (meta?.status || '').toString().trim().toLowerCase();
  const isClosed = CLOSED_PROJECT_STATUSES.has(status);
  if(isClosed){
    return { tone:'static', label:'Closed project', detail:endTs ? `Closed with end date ${formatDate(meta.endDate)}` : 'Closed or archived project' };
  }
  if(endTs && endTs < todayTs){
    const overdueDays = Math.abs(dayDiffFromToday(endTs));
    return { tone:'danger', label: overdueDays <= 1 ? 'Past due' : `${overdueDays} days overdue`, detail: `End date ${formatDate(meta.endDate)}` };
  }
  if(startTs && startTs > todayTs){
    const daysUntil = dayDiffFromToday(startTs);
    if(daysUntil === 0) return { tone:'warn', label:'Starts today', detail:`Start date ${formatDate(meta.startDate)}` };
    if(daysUntil === 1) return { tone:'warn', label:'Starts tomorrow', detail:`Start date ${formatDate(meta.startDate)}` };
    return { tone: daysUntil <= 7 ? 'warn' : 'info', label:`Starts in ${daysUntil} days`, detail:`Start date ${formatDate(meta.startDate)}` };
  }
  if(startTs && startTs <= todayTs){
    if(endTs){
      const daysLeft = dayDiffFromToday(endTs);
      if(daysLeft === 0) return { tone:'warn', label:'Ends today', detail:`End date ${formatDate(meta.endDate)}` };
      if(daysLeft === 1) return { tone:'warn', label:'Ends tomorrow', detail:`End date ${formatDate(meta.endDate)}` };
      if(daysLeft > 1) return { tone:'low', label:`Active • ${daysLeft} days left`, detail:`End date ${formatDate(meta.endDate)}` };
    }
    return { tone:'low', label:'Active now', detail:startTs ? `Started ${formatDate(meta.startDate)}` : 'Currently in progress' };
  }
  if(startTs){
    return { tone:'info', label:`Scheduled ${formatDate(meta.startDate)}`, detail:endTs ? `Ends ${formatDate(meta.endDate)}` : 'Start date set' };
  }
  return { tone:'static', label:'Schedule not set', detail:'Add start or end dates to improve planning order' };
}

function getProjectScheduleProfile(project){
  const meta = project?.meta || {};
  const todayTs = todayStartTs();
  const startTs = parseDateValue(meta.startDate)?.getTime() || 0;
  const endTs = parseDateValue(meta.endDate)?.getTime() || 0;
  const updatedTs = parseDateValue(meta.updatedAt)?.getTime() || 0;
  const lastActivityTs = Number(project?.lastActivityTs || 0) || 0;
  const status = (meta.status || '').toString().trim().toLowerCase();
  const isClosed = CLOSED_PROJECT_STATUSES.has(status);
  const isOverdue = !isClosed && !!endTs && endTs < todayTs;
  const isActive = !isClosed && !isOverdue && (
    status === 'active' ||
    ((!!startTs && startTs <= todayTs) && (!endTs || endTs >= todayTs))
  );
  const isUpcoming = !isClosed && !isActive && !isOverdue && !!startTs && startTs >= todayTs;
  const isScheduled = !!startTs || !!endTs;
  const outstandingLines = Number(project?.materialStats?.outstandingLines || 0);
  const openQty = Math.max(0, Number(project?.materialStats?.totalRequired || 0) - Number(project?.materialStats?.totalReceived || 0) - Number(project?.materialStats?.totalAllocated || 0));
  const urgencyScore = (outstandingLines * 1000) + openQty;
  return {
    todayTs,
    startTs,
    endTs,
    updatedTs,
    lastActivityTs,
    isClosed,
    isOverdue,
    isActive,
    isUpcoming,
    isScheduled,
    urgencyScore
  };
}

function compareReportProjects(a, b){
  const mode = document.getElementById('reportSortSelect')?.value || REPORT_SORT_DEFAULT;
  const aProfile = getProjectScheduleProfile(a);
  const bProfile = getProjectScheduleProfile(b);
  const textFallback = ()=> compareProjectsForDisplay(a, b);

  if(mode === 'projectCode'){
    const diff = String(a?.projectId || '').localeCompare(String(b?.projectId || ''));
    return diff || textFallback();
  }

  if(mode === 'recentlyUpdated'){
    const aRecent = -(aProfile.lastActivityTs || aProfile.updatedTs || aProfile.endTs || aProfile.startTs || 0);
    const bRecent = -(bProfile.lastActivityTs || bProfile.updatedTs || bProfile.endTs || bProfile.startTs || 0);
    if(aRecent !== bRecent) return aRecent - bRecent;
    return textFallback();
  }

  if(mode === 'urgency'){
    const aBucket = aProfile.isOverdue ? 0 : aProfile.isActive ? 1 : aProfile.isUpcoming ? 2 : aProfile.isScheduled ? 3 : aProfile.isClosed ? 5 : 4;
    const bBucket = bProfile.isOverdue ? 0 : bProfile.isActive ? 1 : bProfile.isUpcoming ? 2 : bProfile.isScheduled ? 3 : bProfile.isClosed ? 5 : 4;
    if(aBucket !== bBucket) return aBucket - bBucket;
    if(aProfile.urgencyScore !== bProfile.urgencyScore) return bProfile.urgencyScore - aProfile.urgencyScore;
    if(aProfile.endTs !== bProfile.endTs) return (aProfile.endTs || Number.MAX_SAFE_INTEGER) - (bProfile.endTs || Number.MAX_SAFE_INTEGER);
    if(aProfile.startTs !== bProfile.startTs) return (aProfile.startTs || Number.MAX_SAFE_INTEGER) - (bProfile.startTs || Number.MAX_SAFE_INTEGER);
    return textFallback();
  }

  if(mode === 'activeWindow'){
    const aBucket = aProfile.isActive ? 0 : aProfile.isUpcoming ? 1 : aProfile.isOverdue ? 2 : aProfile.isScheduled ? 3 : aProfile.isClosed ? 5 : 4;
    const bBucket = bProfile.isActive ? 0 : bProfile.isUpcoming ? 1 : bProfile.isOverdue ? 2 : bProfile.isScheduled ? 3 : bProfile.isClosed ? 5 : 4;
    if(aBucket !== bBucket) return aBucket - bBucket;
    if(aBucket === 0 && aProfile.endTs !== bProfile.endTs) return (aProfile.endTs || Number.MAX_SAFE_INTEGER) - (bProfile.endTs || Number.MAX_SAFE_INTEGER);
    if(aBucket === 1 && aProfile.startTs !== bProfile.startTs) return (aProfile.startTs || Number.MAX_SAFE_INTEGER) - (bProfile.startTs || Number.MAX_SAFE_INTEGER);
    return textFallback();
  }

  const aBucket = aProfile.isUpcoming ? 0 : aProfile.isActive ? 1 : aProfile.isOverdue ? 2 : aProfile.isScheduled ? 3 : aProfile.isClosed ? 5 : 4;
  const bBucket = bProfile.isUpcoming ? 0 : bProfile.isActive ? 1 : bProfile.isOverdue ? 2 : bProfile.isScheduled ? 3 : bProfile.isClosed ? 5 : 4;
  if(aBucket !== bBucket) return aBucket - bBucket;
  if(aBucket === 0 && aProfile.startTs !== bProfile.startTs) return (aProfile.startTs || Number.MAX_SAFE_INTEGER) - (bProfile.startTs || Number.MAX_SAFE_INTEGER);
  if(aBucket === 1 && aProfile.endTs !== bProfile.endTs) return (aProfile.endTs || Number.MAX_SAFE_INTEGER) - (bProfile.endTs || Number.MAX_SAFE_INTEGER);
  if(aBucket === 2 && aProfile.endTs !== bProfile.endTs) return (aProfile.endTs || Number.MAX_SAFE_INTEGER) - (bProfile.endTs || Number.MAX_SAFE_INTEGER);
  if(aBucket === 3 && aProfile.startTs !== bProfile.startTs) return (aProfile.startTs || Number.MAX_SAFE_INTEGER) - (bProfile.startTs || Number.MAX_SAFE_INTEGER);
  return textFallback();
}

function addMaterialLine(containerId, prefill = {}){
  const container = document.getElementById(containerId);
  if(!container) return;
  const codeId = `job-material-code-${Math.random().toString(16).slice(2,8)}`;
  const nameId = `job-material-name-${Math.random().toString(16).slice(2,8)}`;
  const qtyId = `job-material-qty-${Math.random().toString(16).slice(2,8)}`;
  const notesId = `job-material-notes-${Math.random().toString(16).slice(2,8)}`;
  const suggId = `${codeId}-s`;
  const row = document.createElement('div');
  row.className = 'form-row line-row order-line';
  row.innerHTML = `
    <input type="hidden" name="materialId">
    <label class="with-suggest">Item Code
      <input id="${codeId}" name="code" placeholder="SKU/part" required>
      <div id="${suggId}" class="suggestions"></div>
    </label>
    <label>Item Name<input id="${nameId}" name="name" placeholder="Required for new codes"></label>
    <label>Supplier
      <select name="supplierId"></select>
    </label>
    <label style="max-width:120px;">Qty Needed<input id="${qtyId}" name="qty" type="number" min="1" value="1" required></label>
    <label style="flex:1">Notes<input id="${notesId}" name="notes" placeholder="Optional notes"></label>
    <button type="button" class="muted remove-line">Remove</button>
  `;
  container.appendChild(row);
  const codeInput = row.querySelector('input[name="code"]');
  const nameInput = row.querySelector('input[name="name"]');
  const supplierSelect = row.querySelector('select[name="supplierId"]');
  const idInput = row.querySelector('input[name="materialId"]');
  if(idInput) idInput.value = prefill.id || '';
  if(prefill.code) codeInput.value = prefill.code;
  if(prefill.name) nameInput.value = prefill.name;
  if(prefill.qtyRequired || prefill.qty) row.querySelector('input[name="qty"]').value = prefill.qtyRequired || prefill.qty;
  if(prefill.notes) row.querySelector('input[name="notes"]').value = prefill.notes;
  refreshMaterialSupplierOptions(containerId);
  if(prefill.supplierId || prefill.supplierid) supplierSelect.value = prefill.supplierId || prefill.supplierid;
  utils.attachItemLookup?.({
    getItems: ()=> itemsCache,
    codeInputId: codeId,
    nameInputId: nameId,
    suggestionsId: suggId
  });
  const syncKnownItemMeta = ()=>{
    const match = itemsCache.find(item => (item.code || '').toLowerCase() === (codeInput.value || '').trim().toLowerCase());
    if(match){
      nameInput.value = nameInput.value || match.name || '';
      supplierSelect.value = match.supplierId || match.supplierid || '';
    }
  };
  codeInput.addEventListener('input', syncKnownItemMeta);
  codeInput.addEventListener('blur', syncKnownItemMeta);
  codeInput.addEventListener('change', syncKnownItemMeta);
  syncKnownItemMeta();
  row.querySelector('.remove-line')?.addEventListener('click', ()=>{
    row.remove();
    if(!container.querySelector('.order-line')) addMaterialLine(containerId);
  });
}

function resetMaterialLines(containerId, materials = []){
  const container = document.getElementById(containerId);
  if(!container) return;
  container.innerHTML = '';
  if(Array.isArray(materials) && materials.length){
    materials.forEach(material=> addMaterialLine(containerId, material));
    return;
  }
  addMaterialLine(containerId);
}

function collectMaterialLines(containerId){
  return Array.from(document.querySelectorAll(`#${containerId} .order-line`))
    .map((row, index)=>({
      id: row.querySelector('input[name="materialId"]')?.value.trim() || '',
      code: row.querySelector('input[name="code"]')?.value.trim() || '',
      name: row.querySelector('input[name="name"]')?.value.trim() || '',
      supplierId: row.querySelector('select[name="supplierId"]')?.value.trim() || '',
      qtyRequired: Number(row.querySelector('input[name="qty"]')?.value || 0),
      notes: row.querySelector('input[name="notes"]')?.value.trim() || '',
      sortOrder: index
    }))
    .filter(line=> line.code && line.qtyRequired > 0);
}

function parseMaterialBulkText(text){
  return String(text || '')
    .split(/\r?\n/)
    .map(line=> line.trim())
    .filter(Boolean)
    .map((line, index)=>{
      const [code, name, qty, notes] = line.split(',').map(part=> (part || '').trim());
      return { code, name, qtyRequired: Number(qty || 0), notes, sortOrder: index };
    })
    .filter(line=> line.code && line.qtyRequired > 0);
}

function bindMaterialComposer({ containerId, addBtnId, bulkInputId, bulkLoadBtnId, bulkClearBtnId }){
  document.getElementById(addBtnId)?.addEventListener('click', (ev)=>{
    ev.preventDefault();
    addMaterialLine(containerId);
  });
  document.getElementById(bulkLoadBtnId)?.addEventListener('click', (ev)=>{
    ev.preventDefault();
    const bulk = document.getElementById(bulkInputId);
    const rows = parseMaterialBulkText(bulk?.value || '');
    if(!rows.length){
      alert('No valid material rows found');
      return;
    }
    resetMaterialLines(containerId, rows);
  });
  document.getElementById(bulkClearBtnId)?.addEventListener('click', (ev)=>{
    ev.preventDefault();
    const bulk = document.getElementById(bulkInputId);
    if(bulk) bulk.value = '';
  });
}

async function loadProjectMaterials(code){
  if(!code) return [];
  if(projectMaterialsReportCache.has(code)) return projectMaterialsReportCache.get(code) || [];
  try{
    const rows = await utils.fetchJsonSafe(`/api/jobs/${encodeURIComponent(code)}/materials`, {}, []) || [];
    projectMaterialsReportCache.set(code, rows);
    return rows;
  }catch(e){
    return [];
  }
}

function resetAddForm(){
  const form = document.getElementById('jobForm');
  if(form) form.reset();
  const statusInput = document.getElementById('jobStatus');
  if(statusInput) statusInput.value = 'planned';
  const codeInput = document.getElementById('jobCode');
  if(codeInput) codeInput.disabled = false;
  resetMaterialLines('job-material-lines');
  const bulk = document.getElementById('jobMaterialBulk');
  if(bulk) bulk.value = '';
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
    if(project?.code) projectMaterialsReportCache.delete(project.code);
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
  filtered.sort(compareProjectsForDisplay);

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
      btn.addEventListener('click', async ev=>{
        const code = ev.target.dataset.code;
        const project = jobCache.find(j=> (j.code || '') === code);
        if(project) await setEditMode(project);
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
    const materials = collectMaterialLines('job-material-lines');
    if(!code){alert('Project code required');return;}
    const catalogResult = await ensureCatalogItemsForMaterials(materials);
    if(!catalogResult.ok){
      alert(catalogResult.error || 'Failed to add project materials to catalog');
      return;
    }
    const result = await saveProject({code,name,status,startDate,endDate,location,notes,materials});
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
      const materials = collectMaterialLines('job-edit-material-lines');
      if(!code){alert('Project code required');return;}
      const catalogResult = await ensureCatalogItemsForMaterials(materials);
      if(!catalogResult.ok){
        alert(catalogResult.error || 'Failed to add project materials to catalog');
        return;
      }
      const result = await saveProject({code,name,status,startDate,endDate,location,notes,materials});
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
  const refreshActiveTab = (tab)=>{
    if(tab === 'projects') renderProjects();
    else if(tab === 'report') renderReport();
  };
  const setTab = (tab)=>{
    buttons.forEach(b=> b.classList.toggle('active', b.dataset.tab === tab));
    contents.forEach(c=> c.classList.toggle('active', c.id === `${tab}-tab`));
    if(history.replaceState) history.replaceState(null, '', `#${tab}`);
    refreshActiveTab(tab);
  };
  buttons.forEach(btn=>{
    btn.addEventListener('click', ()=> setTab(btn.dataset.tab));
  });
  const hash = (window.location.hash || '').replace('#','');
  const startTab = (hash === 'report' || hash === 'projects') ? hash : (isAdmin ? 'projects' : 'report');
  setTab(startTab);
  window.addEventListener('hashchange', ()=>{
    const next = (window.location.hash || '').replace('#','');
    if(next === 'report' || next === 'projects') setTab(next);
  });
  window.addEventListener('pageshow', ()=>{
    const active = document.querySelector('.mode-btn.active')?.dataset.tab || '';
    if(active) refreshActiveTab(active);
  });
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState !== 'visible') return;
    const active = document.querySelector('.mode-btn.active')?.dataset.tab || '';
    if(active) refreshActiveTab(active);
  });
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
    if(!projects[key]) projects[key] = { projectId, code: e.code, inQty: 0, outQty: 0, reserveQty: 0, returnQty: 0 };
    const qty = Number(e.qty || 0);
    if(e.type === 'in') projects[key].inQty += qty;
    else if(e.type === 'return'){ projects[key].inQty += qty; projects[key].returnQty += qty; }
    else if(e.type === 'out') projects[key].outQty += qty;
    else if(e.type === 'reserve') projects[key].reserveQty += qty;
    else if(e.type === 'reserve_release') projects[key].reserveQty -= qty;
  });
  return Object.values(projects).map(p=>({
    ...p, netUsage: p.inQty - p.outQty
  }));
}

const GENERAL_LABEL = 'General';
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
    if(!map.has(pid)) map.set(pid, { projectId: pid, inQty: 0, outQty: 0, reserveQty: 0, returnQty: 0, netUsage: 0, items: [] });
    const rec = map.get(pid);
    rec.inQty += item.inQty;
    rec.outQty += item.outQty;
    rec.reserveQty += item.reserveQty;
    rec.returnQty += item.returnQty || 0;
    rec.netUsage += item.netUsage;
    rec.items.push(item);
  });
  return Array.from(map.values());
}

function getProjectCheckedOut(project){
  const items = project.items || [];
  return items.reduce((sum, item)=>{
    const outQty = Number(item.outQty || 0);
    const returnQty = Number(item.returnQty || 0);
    return sum + Math.max(0, outQty - returnQty);
  }, 0);
}

function getProjectReserved(project){
  const items = project.items || [];
  return items.reduce((sum, item)=> sum + Math.max(0, Number(item.reserveQty || 0)), 0);
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
  const outstanding = list.reduce((sum,p)=> sum + Number(p.materialStats?.outstandingLines || 0), 0);
  const readyProjects = list.filter(p=> Number(p.materialStats?.totalLines || 0) > 0 && Number(p.materialStats?.outstandingLines || 0) === 0).length;
  const setText = (id, val)=>{
    const el = document.getElementById(id);
    if(el) el.textContent = `${val}`;
  };
  setText('reportTotalProjects', totalProjects);
  setText('reportActiveProjects', activeProjects);
  setText('reportCheckedOut', outstanding);
  setText('reportReserved', readyProjects);
  setText('reportShowingCount', `${list.length} showing`);
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

function getMaterialStatusLabel(status){
  const map = {
    ready: 'Ready',
    partially_received: 'Partially Covered',
    ordered: 'Ordered',
    partially_ordered: 'In Progress',
    not_ordered: 'Not Ordered'
  };
  return map[status] || 'Not Ordered';
}

function getMaterialStatusClass(status){
  const map = {
    ready: 'low',
    partially_received: 'open',
    ordered: 'info',
    partially_ordered: 'warn',
    not_ordered: 'danger'
  };
  return map[status] || 'static';
}

function summarizeProjectMaterials(materials){
  const rows = Array.isArray(materials) ? materials : [];
  const stats = {
    totalLines: rows.length,
    totalRequired: 0,
    totalOrdered: 0,
    totalAllocated: 0,
    totalReceived: 0,
    outstandingLines: 0,
    readyLines: 0,
    status: rows.length ? 'not_ordered' : 'none',
    statusLabel: rows.length ? 'Not Started' : 'No Material Plan'
  };
  rows.forEach(row=>{
    const required = Number(row.qtyRequired || 0) || 0;
    const ordered = Number(row.qtyOrdered || 0) || 0;
    const allocated = Number(row.qtyAllocated || 0) || 0;
    const received = Number(row.qtyReceived || 0) || 0;
    const outstanding = Number(row.outstandingQty || 0) || 0;
    stats.totalRequired += required;
    stats.totalOrdered += ordered;
    stats.totalAllocated += allocated;
    stats.totalReceived += received;
    if(outstanding > 0) stats.outstandingLines += 1;
    if(String(row.status || '') === 'ready') stats.readyLines += 1;
  });
  if(!rows.length){
    stats.status = 'none';
    stats.statusLabel = 'No Material Plan';
  }else if(stats.readyLines === rows.length){
    stats.status = 'ready';
    stats.statusLabel = 'Ready';
  }else if(stats.totalReceived > 0 || stats.totalAllocated > 0){
    stats.status = 'partially_received';
    stats.statusLabel = 'Partially Covered';
  }else if(stats.totalOrdered > 0 || stats.totalAllocated > 0){
    stats.status = 'partially_ordered';
    stats.statusLabel = 'In Progress';
  }
  return stats;
}

function buildDetailTable(items){
  if(!items.length) return '<div style="color:#6b7280;">No items</div>';
  const rows = items
    .map(item=>{
      const inQty = Number(item.inQty || 0);
      const outQty = Number(item.outQty || 0);
      const returnQty = Number(item.returnQty || 0);
      const reserved = Math.max(0, Number(item.reserveQty || 0));
      const checkedOut = Math.max(0, outQty - returnQty);
      const onHand = Math.max(0, inQty - outQty);
      return { code: item.code || '', checkedOut, reserved, onHand };
    })
    .filter(item=> item.checkedOut > 0 || item.reserved > 0)
    .sort((a,b)=> a.code.localeCompare(b.code))
    .map(item=> `<tr><td>${escapeHtml(item.code)}</td><td>${item.checkedOut}</td><td>${item.reserved}</td><td>${item.onHand}</td></tr>`)
    .join('');
  if(!rows) return '<div style="color:#6b7280;">No current items for this project.</div>';
  return `<table class="detail-table">
    <thead><tr><th>Code</th><th>Checked Out</th><th>Reserved</th><th>On Hand</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildMaterialsTable(materials){
  if(!materials.length) return '<div style="color:#6b7280;">No material plan for this project.</div>';
  const rows = materials
    .slice()
    .sort((a,b)=> (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.code || '').localeCompare(String(b.code || '')))
    .map(item=>{
      const status = String(item.status || '');
      return `<tr>
        <td>${escapeHtml(item.code || '')}</td>
        <td>${escapeHtml(item.name || '')}</td>
        <td>${Number(item.qtyRequired || 0)}</td>
        <td>${Number(item.qtyOrdered || 0)}</td>
        <td>${Number(item.qtyAllocated || 0)}</td>
        <td>${Number(item.qtyReceived || 0)}</td>
        <td>${Number(item.outstandingQty || 0)}</td>
        <td><span class="badge ${getMaterialStatusClass(status)}">${escapeHtml(getMaterialStatusLabel(status))}</span></td>
        <td title="${escapeHtml(item.notes || '')}">${escapeHtml(formatNotes(item.notes || ''))}</td>
      </tr>`;
    })
    .join('');
  return `<table class="detail-table">
    <thead><tr><th>Code</th><th>Name</th><th>Needed</th><th>Ordered</th><th>Allocated</th><th>Received</th><th>Open</th><th>Status</th><th>Notes</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function closestReportCard(node){
  let cur = node;
  while(cur && cur !== document.body){
    if(cur.classList && cur.classList.contains('report-card')) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function getReportDetail(btn){
  const card = closestReportCard(btn);
  if(!card) return { card: null, detail: null };
  const detail = card.querySelector('.report-detail');
  return { card, detail };
}

function openProjectDetail(btn){
  const { card, detail } = getReportDetail(btn);
  if(detail){
    detail.style.display = '';
    card?.classList.add('expanded');
    btn.textContent = 'Hide Project Detail';
  }
}

async function ensureCatalogItemsForMaterials(materials){
  if(!isAdmin) return { ok:false, error:'Admin only' };
  const existingCodes = new Set((itemsCache || []).map(item => (item.code || '').trim().toLowerCase()).filter(Boolean));
  const missingByCode = new Map();
  for(const line of materials || []){
    const code = (line?.code || '').trim();
    if(!code) continue;
    const key = code.toLowerCase();
    if(existingCodes.has(key) || missingByCode.has(key)) continue;
    const name = (line?.name || '').trim();
    if(!name) return { ok:false, error:`Name required to add new catalog item: ${code}` };
    missingByCode.set(key, {
      code,
      name,
      supplierId: (line?.supplierId || '').trim() || null
    });
  }
  if(!missingByCode.size) return { ok:true, created:0 };
  try{
    const response = await fetch('/api/items/bulk', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      credentials:'include',
      body: JSON.stringify({ items: Array.from(missingByCode.values()) })
    });
    const data = await response.json().catch(()=> ({}));
    if(!response.ok) return { ok:false, error:data.error || 'Failed to add project materials to catalog' };
    await loadItems();
    await loadSuppliers();
    ['job-material-lines','job-edit-material-lines'].forEach(refreshMaterialSupplierOptions);
    return { ok:true, created:Number(data.count || missingByCode.size) || missingByCode.size };
  }catch(e){
    return { ok:false, error:e.message || 'Failed to add project materials to catalog' };
  }
}

function closeProjectDetail(btn){
  const { card, detail } = getReportDetail(btn);
  if(detail){
    detail.style.display = 'none';
    card?.classList.remove('expanded');
    btn.textContent = 'View Project Detail';
  }
}

function toggleProjectDetail(btn){
  const { detail } = getReportDetail(btn);
  if(detail && detail.style.display !== 'none') closeProjectDetail(btn);
  else openProjectDetail(btn);
}

function setExpandAllState(expand){
  reportExpanded = expand;
  const expandBtn = document.getElementById('reportExpandAll');
  if(expandBtn) expandBtn.textContent = expand ? 'Collapse All' : 'Expand All';
}

async function loadWorkflowOverview(force = false){
  if(!force && workflowOverviewCache) return workflowOverviewCache;
  workflowOverviewCache = await utils.fetchJsonSafe('/api/workflows/overview', { cacheTtlMs: 5000 }, {}) || {};
  return workflowOverviewCache;
}

function workflowPrimaryAction(project){
  const code = encodeURIComponent(project?.code || '');
  switch(project?.nextAction){
    case 'order_materials':
      return { href: `order-register.html?project=${code}&loadMaterials=1#order`, label: 'Open Procurement' };
    case 'reserve_stock':
      return { href: `order-register.html?mode=reserve&job=${code}#reserve`, label: 'Reserve Stock' };
    case 'assign_suppliers':
      return { href: 'item-master.html#suppliers', label: 'Assign Suppliers' };
    case 'close_returns':
      return { href: 'inventory-operations.html?mode=return', label: 'Process Returns' };
    case 'plan_materials':
      return { href: '#projects', label: 'Edit Project' };
    default:
      return { href: '#report', label: 'Review Project' };
  }
}

function renderFulfillmentBoard(summaryRows){
  const container = document.getElementById('fulfillmentBoard');
  if(!container) return;
  const rows = Array.isArray(summaryRows) ? summaryRows : [];
  if(!rows.length){
    container.innerHTML = '<div class="report-empty">No active fulfillment work.</div>';
    return;
  }
  container.innerHTML = rows.slice(0, 6).map(project=>{
    const action = workflowPrimaryAction(project);
    const tone = project.shortageQty > 0
      ? 'danger'
      : project.missingSupplierLines > 0
        ? 'warn'
        : project.outstandingLines > 0
          ? 'open'
          : 'low';
    return `
      <article class="workflow-row">
        <div class="workflow-main">
          <div class="workflow-title-row">
            <strong>${escapeHtml(project.code || '')}</strong>
            <span class="badge ${tone}">${escapeHtml(project.nextActionLabel || 'Review')}</span>
          </div>
          <div class="workflow-sub">${escapeHtml(project.name || formatStatus(project.status || 'Project'))}</div>
          <div class="workflow-metrics">
            <span>Open lines: <strong>${Number(project.outstandingLines || 0)}</strong></span>
            <span>Shortage: <strong>${Number(project.shortageQty || 0)}</strong></span>
            <span>Missing suppliers: <strong>${Number(project.missingSupplierLines || 0)}</strong></span>
            <span>Received / Needed: <strong>${Number(project.totalReceived || 0)} / ${Number(project.totalRequired || 0)}</strong></span>
          </div>
        </div>
        <div class="workflow-actions">
          <a class="action-btn" href="${action.href}">${escapeHtml(action.label)}</a>
          <a class="muted action-btn" href="#report">Report</a>
        </div>
      </article>
    `;
  }).join('');
}

function renderProjectProcurementSuggestions(suggestions){
  const container = document.getElementById('projectProcurementSuggestions');
  if(!container) return;
  const rows = (Array.isArray(suggestions) ? suggestions : []).slice(0, 8);
  if(!rows.length){
    container.innerHTML = '<div class="report-empty">No open shortages. Projects can be covered from stock or are already ready.</div>';
    return;
  }
  container.innerHTML = rows.map(row=>{
    const tone = Number(row.shortageQty || 0) > 0 ? 'danger' : 'low';
    const href = `order-register.html?project=${encodeURIComponent(row.jobId || '')}&loadMaterials=1#order`;
    return `
      <article class="workflow-row compact">
        <div class="workflow-main">
          <div class="workflow-title-row">
            <strong>${escapeHtml(row.code || '')}</strong>
            <span class="badge ${tone}">${Number(row.shortageQty || 0) > 0 ? 'Order' : 'Reserve'}</span>
          </div>
          <div class="workflow-sub">${escapeHtml(row.name || '')} ${row.jobId ? `· ${escapeHtml(row.jobId)}` : ''}</div>
          <div class="workflow-metrics">
            <span>Open: <strong>${Number(row.outstandingQty || 0)}</strong></span>
            <span>Available: <strong>${Number(row.availableQty || 0)}</strong></span>
            <span>Shortage: <strong>${Number(row.shortageQty || 0)}</strong></span>
            <span>Supplier: <strong>${escapeHtml(row.supplierName || 'Unassigned')}</strong></span>
          </div>
        </div>
        <div class="workflow-actions">
          <a class="action-btn" href="${href}">${Number(row.shortageQty || 0) > 0 ? 'Procure' : 'Allocate'}</a>
        </div>
      </article>
    `;
  }).join('');
}

async function renderReport(){
  const list = document.getElementById('reportCards');
  if(!list) return;
  list.innerHTML = '';
  projectMaterialsReportCache = new Map();
  workflowOverviewCache = null;
  await loadJobs();
  const workflow = await loadWorkflowOverview(true);
  renderFulfillmentBoard(workflow.fulfillmentBoard || []);
  renderProjectProcurementSuggestions(workflow.procurementSuggestions || []);
  const entries = await loadEntries();
  const items = aggregateByProject(entries);
  const summary = buildReportSummary(items);
  const filtered = applyReportFilters(summary);

  const lastActivityMap = new Map();
  (entries || []).forEach(e=>{
    const projectId = getEntryJobId(e) || 'General';
    const ts = Number(e.ts || 0);
    if(ts > (lastActivityMap.get(projectId) || 0)) lastActivityMap.set(projectId, ts);
  });

  if(!filtered.length){
    const message = (jobCache.length === 0 && items.length === 0) ? 'No projects created yet' : 'No matching projects';
    list.innerHTML = `<div class="report-empty">${message}</div>`;
    updateReportSummary([]);
    setExpandAllState(false);
    return;
  }

  const enriched = await Promise.all(filtered.map(async project=>({
    ...project,
    materials: isGeneralProject(project.projectId) ? [] : await loadProjectMaterials(project.projectId),
  })));
  const rows = enriched
    .map(project=> ({ ...project, materialStats: summarizeProjectMaterials(project.materials || []), lastActivityTs: lastActivityMap.get(project.projectId) || 0 }))
    .sort(compareReportProjects);
  updateReportSummary(rows);
  rows.forEach(project=>{
    const meta = project.meta || {};
    const timeline = getTimelineMeta(meta);
    const statusLabel = meta.status ? formatStatus(meta.status) : (isGeneralProject(project.projectId) ? GENERAL_LABEL : FALLBACK);
    const datesLabel = formatProjectDates(meta);
    const locationLabel = meta.location || FALLBACK;
    const notesLabel = (meta.notes || '').toString().trim();
    const key = encodeKey(project.projectId);
    const statusRaw = (meta.status || '').toLowerCase();
    const isComplete = ['complete','completed','closed','archived'].includes(statusRaw);
    let actionButton = '';
    if(isAdmin){
      if(!isGeneralProject(project.projectId) && !isComplete){
          actionButton = `<button type="button" class="action-btn complete-btn" data-code="${key}">Mark Complete</button>`;
      }
    }
    const lastActivityTs = project.lastActivityTs || 0;
    const lastActivityLabel = lastActivityTs ? formatDateTime(lastActivityTs) : FALLBACK;
    const nameLabel = (meta.name || '').toString().trim();
    const checkedOutQty = getProjectCheckedOut(project);
    const reservedQty = getProjectReserved(project);
    const materialStats = project.materialStats || summarizeProjectMaterials([]);
    const materialStatusClass = materialStats.status === 'ready'
      ? 'low'
      : materialStats.status === 'partially_received'
        ? 'open'
        : materialStats.status === 'partially_ordered'
          ? 'warn'
          : materialStats.status === 'none'
            ? 'static'
            : 'danger';
    const totalOpenQty = Math.max(0, Number(materialStats.totalRequired || 0) - Number(materialStats.totalReceived || 0) - Number(materialStats.totalAllocated || 0));
    const card = document.createElement('div');
    card.className = 'report-card';
    card.innerHTML = `
      <div class="report-card-header">
        <div>
          <div class="report-card-eyebrow">
            <span class="badge ${timeline.tone}">${escapeHtml(timeline.label)}</span>
            ${timeline.detail ? `<span class="report-card-eyebrow-text">${escapeHtml(timeline.detail)}</span>` : ''}
          </div>
          <div class="report-card-title">${escapeHtml(project.projectId)}</div>
          ${nameLabel ? `<div class="report-card-sub">${escapeHtml(nameLabel)}</div>` : ''}
        </div>
        <div class="report-card-controls">
          <span class="badge info">${escapeHtml(statusLabel)}</span>
          <span class="badge ${materialStatusClass}">${escapeHtml(materialStats.statusLabel)}</span>
          ${actionButton}
        </div>
      </div>
      <div class="report-card-grid compact">
        <div class="report-chip"><span>Schedule</span><strong>${escapeHtml(datesLabel)}</strong></div>
        <div class="report-chip"><span>Location</span><strong>${escapeHtml(locationLabel)}</strong></div>
      </div>
      <div class="report-compact-stats">
        <div class="report-compact-stat">
          <span>Open lines</span>
          <strong>${materialStats.outstandingLines}</strong>
        </div>
        <div class="report-compact-stat">
          <span>Open qty</span>
          <strong>${totalOpenQty}</strong>
        </div>
        <div class="report-compact-stat">
          <span>Reserved</span>
          <strong>${reservedQty}</strong>
        </div>
        <div class="report-compact-stat">
          <span>Checked out</span>
          <strong>${checkedOutQty}</strong>
        </div>
      </div>
      <div class="report-card-meta-line">Last activity: <strong>${escapeHtml(lastActivityLabel)}</strong></div>
        <div class="report-card-actions">
          <button type="button" class="action-btn report-toggle" data-project="${key}">View Project Detail</button>
        </div>
      <div class="report-detail" data-project="${key}" style="display:none;">
        <div class="report-notes"><strong>Notes:</strong> ${escapeHtml(notesLabel || FALLBACK)}</div>
        <div class="subhead">Material Plan</div>
        ${buildMaterialsTable(project.materials || [])}
        <div class="subhead">Current Inventory Use</div>
        ${buildDetailTable(project.items || [])}
      </div>
    `;
    list.appendChild(card);
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
  projectMaterialsReportCache = new Map();
  await loadJobs();
  const entries = await loadEntries();
  const items = aggregateByProject(entries);
  const summary = buildReportSummary(items);
  const filtered = applyReportFilters(summary);
  if(!filtered.length){alert('No project data to export');return;}
  const enriched = await Promise.all(filtered.map(async project=>({
    ...project,
    materials: isGeneralProject(project.projectId) ? [] : await loadProjectMaterials(project.projectId)
  })));
  const sorted = enriched
    .map(project=> ({ ...project, meta: project.meta || getProjectMeta(project.projectId), materialStats: summarizeProjectMaterials(project.materials || []) }))
    .sort(compareReportProjects);
  const hdr = ['projectId','status','startDate','endDate','location','materialStatus','materialLines','outstandingMaterialLines','code','checkedIn','checkedOut','reserved','netUsage','qtyRequired','qtyOrdered','qtyAllocated','qtyReceived','qtyOpen'];
  const rows = [];
  sorted.forEach(p=>{
    const meta = p.meta || getProjectMeta(p.projectId);
    const materialStats = p.materialStats || summarizeProjectMaterials(p.materials || []);
    if((!p.items || p.items.length === 0) && !(p.materials || []).length){
      rows.push([
        p.projectId,
        meta.status || '',
        meta.startDate || '',
        meta.endDate || '',
        meta.location || '',
        materialStats.statusLabel,
        materialStats.totalLines,
        materialStats.outstandingLines,
        '',
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ]);
      return;
    }
    const itemMap = new Map((p.items || []).map(r=> [String(r.code || ''), r]));
    const materialMap = new Map((p.materials || []).map(m=> [String(m.code || ''), m]));
    const allCodes = Array.from(new Set([...itemMap.keys(), ...materialMap.keys()])).sort((a,b)=> a.localeCompare(b));
    allCodes.forEach(code=>{
      const r = itemMap.get(code) || {};
      const material = materialMap.get(code) || {};
      rows.push([
        p.projectId,
        meta.status || '',
        meta.startDate || '',
        meta.endDate || '',
        meta.location || '',
        materialStats.statusLabel,
        materialStats.totalLines,
        materialStats.outstandingLines,
        code,
        r.inQty || 0,
        Math.max(0, Number(r.outQty || 0) - Number(r.returnQty || 0)),
        Math.max(0, Number(r.reserveQty || 0)),
        r.netUsage || 0,
        material.qtyRequired || 0,
        material.qtyOrdered || 0,
        material.qtyAllocated || 0,
        material.qtyReceived || 0,
        material.outstandingQty || 0
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

  await loadItems();
  await loadSuppliers();
  resetMaterialLines('job-material-lines');
  resetMaterialLines('job-edit-material-lines');
  bindMaterialComposer({
    containerId: 'job-material-lines',
    addBtnId: 'jobMaterialAddBtn',
    bulkInputId: 'jobMaterialBulk',
    bulkLoadBtnId: 'jobMaterialBulkLoad',
    bulkClearBtnId: 'jobMaterialBulkClear'
  });
  bindMaterialComposer({
    containerId: 'job-edit-material-lines',
    addBtnId: 'jobEditMaterialAddBtn',
    bulkInputId: 'jobEditMaterialBulk',
    bulkLoadBtnId: 'jobEditMaterialBulkLoad',
    bulkClearBtnId: 'jobEditMaterialBulkClear'
  });
  initTabs();
  initProjectForm();
  await renderProjects();
  await renderReport();

  const searchParam = new URLSearchParams(window.location.search).get('search');
  const projectSearch = document.getElementById('projectSearchBox');
  if(searchParam && projectSearch){
    projectSearch.value = searchParam;
    await renderProjects();
  }

  document.getElementById('projectSearchBox')?.addEventListener('input', renderProjects);
  document.getElementById('reportSearchBox')?.addEventListener('input', renderReport);
  document.getElementById('reportSortSelect')?.addEventListener('change', renderReport);
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
