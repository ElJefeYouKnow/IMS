(function(){
  const FALLBACK = 'N/A';
  const SERVICE_SOON_DAYS = 30;

  const state = {
    equipmentRows: [],
    vehicleRows: [],
    activeTab: 'equipment',
    selectedType: null,
    selectedId: null,
    drawerTab: 'summary',
    isAdmin: false,
    createMode: false
  };

  function qs(id){
    return document.getElementById(id);
  }

  function setPageStatus(message, tone){
    const el = qs('fleetStatus');
    if(!el) return;
    el.textContent = message || '';
    el.style.color = tone === 'error' ? '#b91c1c' : tone === 'ok' ? '#15803d' : '';
  }

  function setEditorStatus(message, tone){
    const el = qs('fleetEditorStatus');
    if(!el) return;
    el.textContent = message || '';
    el.style.color = tone === 'error' ? '#b91c1c' : tone === 'ok' ? '#15803d' : '';
  }

  function parseTs(value){
    if(value === undefined || value === null || value === '') return null;
    if(typeof value === 'number') return value;
    const num = Number(value);
    if(Number.isFinite(num)) return num;
    if(/^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) return Date.parse(`${String(value).trim()}T12:00:00Z`);
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? null : ts;
  }

  function fmtDate(value){
    const ts = parseTs(value);
    if(ts === null){
      const text = String(value ?? '').trim();
      return text || FALLBACK;
    }
    return new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });
  }

  function fmtDateInput(value){
    const ts = parseTs(value);
    if(ts === null){
      const text = String(value ?? '').trim();
      if(/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
      return '';
    }
    return new Date(ts).toISOString().slice(0, 10);
  }

  function fmtNumber(value){
    const num = Number(value);
    return Number.isFinite(num) ? num.toLocaleString() : FALLBACK;
  }

  function escapeHtml(value){
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeTags(tags){
    if(!tags) return [];
    if(Array.isArray(tags)) return tags.map((tag)=> String(tag).trim()).filter(Boolean);
    try{
      const parsed = JSON.parse(tags);
      if(Array.isArray(parsed)) return parsed.map((tag)=> String(tag).trim()).filter(Boolean);
    }catch(e){}
    return String(tags).split(/[,;|]/).map((tag)=> tag.trim()).filter(Boolean);
  }

  function getRowsForTab(tab = state.activeTab){
    return tab === 'vehicles' ? state.vehicleRows : state.equipmentRows;
  }

  function activeAssetType(){
    return state.activeTab === 'vehicles' ? 'vehicle' : 'equipment';
  }

  function isOperationalStatus(status){
    const text = String(status || '').trim().toLowerCase();
    if(!text) return true;
    return !['maintenance', 'repair', 'out', 'down', 'retired', 'inactive'].includes(text);
  }

  function serviceMeta(item){
    const nextTs = parseTs(item.nextserviceat || item.nextServiceAt);
    if(!nextTs) return { key: 'untracked', label: 'Untracked', tone: 'static' };
    const today = Date.now();
    const diffDays = Math.ceil((nextTs - today) / (24 * 60 * 60 * 1000));
    if(diffDays <= 0) return { key: 'due', label: 'Due now', tone: 'danger' };
    if(diffDays <= SERVICE_SOON_DAYS) return { key: 'soon', label: `Due in ${diffDays}d`, tone: 'warn' };
    return { key: 'current', label: 'Current', tone: 'info' };
  }

  function buildTags(tags){
    const list = normalizeTags(tags);
    if(!list.length) return '<span class="badge static">No tags</span>';
    return list.map((tag)=> `<span class="badge static">${escapeHtml(tag)}</span>`).join('');
  }

  function populateStatusOptions(){
    const select = qs('fleetStatusFilter');
    if(!select) return;
    const current = select.value;
    const statuses = Array.from(new Set(getRowsForTab().map((row)=> String(row.status || '').trim()).filter(Boolean))).sort((a, b)=> a.localeCompare(b));
    select.innerHTML = '<option value="">All statuses</option>' + statuses.map((status)=> `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join('');
    if(statuses.includes(current)) select.value = current;
  }

  function updateActionLabels(){
    const createBtn = qs('fleetCreateBtn');
    if(createBtn){
      createBtn.textContent = state.activeTab === 'vehicles' ? 'Add Vehicle' : 'Add Equipment';
      createBtn.style.display = state.isAdmin ? '' : 'none';
    }
    const editTab = qs('fleetPanelEditTab');
    if(editTab){
      editTab.style.display = state.isAdmin ? '' : 'none';
    }
  }

  function filterRows(rows){
    const search = (qs('fleetSearch')?.value || '').trim().toLowerCase();
    const statusFilter = (qs('fleetStatusFilter')?.value || '').trim().toLowerCase();
    const serviceFilter = (qs('fleetServiceFilter')?.value || '').trim().toLowerCase();
    return rows.filter((row)=>{
      const haystack = [
        row.code,
        row.name,
        row.category,
        row.location,
        row.status,
        row.assignedproject || row.assignedProject,
        row.plate,
        row.make,
        row.model,
        row.serial,
        row.vin
      ].filter(Boolean).join(' ').toLowerCase();
      if(search && !haystack.includes(search)) return false;
      if(statusFilter && String(row.status || '').trim().toLowerCase() !== statusFilter) return false;
      if(serviceFilter && serviceMeta(row).key !== serviceFilter) return false;
      return true;
    });
  }

  function renderSummary(rows){
    const total = rows.length;
    const active = rows.filter((row)=> isOperationalStatus(row.status)).length;
    const due = rows.filter((row)=> ['due', 'soon'].includes(serviceMeta(row).key)).length;
    const assigned = rows.filter((row)=> String(row.assignedproject || row.assignedProject || '').trim()).length;
    qs('fleetSummaryTotal').textContent = total.toLocaleString();
    qs('fleetSummaryActive').textContent = active.toLocaleString();
    qs('fleetSummaryDue').textContent = due.toLocaleString();
    qs('fleetSummaryAssigned').textContent = assigned.toLocaleString();
  }

  function renderEquipment(rows){
    const tbody = qs('equipmentTableBody');
    const badge = qs('equipmentCountBadge');
    if(badge) badge.textContent = `${rows.length} assets`;
    if(!tbody) return;
    tbody.innerHTML = '';
    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#6b7280;">No equipment found</td></tr>';
      return;
    }
    rows.forEach((item)=>{
      const service = serviceMeta(item);
      const project = item.assignedproject || item.assignedProject || FALLBACK;
      const nextService = item.nextserviceat || item.nextServiceAt;
      const tr = document.createElement('tr');
      tr.className = 'fleet-row';
      tr.dataset.type = 'equipment';
      tr.dataset.id = item.id;
      tr.innerHTML = `
        <td>${escapeHtml(item.code || FALLBACK)}</td>
        <td>${escapeHtml(item.name || FALLBACK)}</td>
        <td>${escapeHtml(item.category || FALLBACK)}</td>
        <td>${escapeHtml(item.location || FALLBACK)}</td>
        <td><span class="badge ${isOperationalStatus(item.status) ? 'info' : 'warn'}">${escapeHtml(item.status || 'active')}</span></td>
        <td>${escapeHtml(project)}</td>
        <td>${escapeHtml(fmtNumber(item.usagehours || item.usageHours))}</td>
        <td><div class="fleet-service-cell"><strong>${escapeHtml(fmtDate(nextService))}</strong><span class="badge ${escapeHtml(service.tone)}">${escapeHtml(service.label)}</span></div></td>
        <td>${escapeHtml(fmtDate(item.lastactivityat || item.lastActivityAt))}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderVehicles(rows){
    const tbody = qs('vehicleTableBody');
    const badge = qs('vehicleCountBadge');
    if(badge) badge.textContent = `${rows.length} assets`;
    if(!tbody) return;
    tbody.innerHTML = '';
    if(!rows.length){
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#6b7280;">No vehicles found</td></tr>';
      return;
    }
    rows.forEach((item)=>{
      const make = [item.make, item.model].filter(Boolean).join(' ') || FALLBACK;
      const project = item.assignedproject || item.assignedProject || FALLBACK;
      const service = serviceMeta(item);
      const nextService = item.nextserviceat || item.nextServiceAt;
      const tr = document.createElement('tr');
      tr.className = 'fleet-row';
      tr.dataset.type = 'vehicle';
      tr.dataset.id = item.id;
      tr.innerHTML = `
        <td>${escapeHtml(item.code || FALLBACK)}</td>
        <td>${escapeHtml(make)}</td>
        <td>${escapeHtml(item.plate || FALLBACK)}</td>
        <td>${escapeHtml(item.location || FALLBACK)}</td>
        <td><span class="badge ${isOperationalStatus(item.status) ? 'info' : 'warn'}">${escapeHtml(item.status || 'active')}</span></td>
        <td>${escapeHtml(project)}</td>
        <td>${escapeHtml(fmtNumber(item.mileage))}</td>
        <td><div class="fleet-service-cell"><strong>${escapeHtml(fmtDate(nextService))}</strong><span class="badge ${escapeHtml(service.tone)}">${escapeHtml(service.label)}</span></div></td>
        <td>${escapeHtml(fmtDate(item.lastactivityat || item.lastActivityAt))}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderTables(){
    const equipmentRows = filterRows(state.equipmentRows);
    const vehicleRows = filterRows(state.vehicleRows);
    renderEquipment(equipmentRows);
    renderVehicles(vehicleRows);
    renderSummary(state.activeTab === 'vehicles' ? vehicleRows : equipmentRows);
  }

  function setTab(tab){
    state.activeTab = tab;
    document.querySelectorAll('.mode-btn').forEach((btn)=>{
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    qs('equipmentSection').style.display = tab === 'equipment' ? '' : 'none';
    qs('vehicleSection').style.display = tab === 'vehicles' ? '' : 'none';
    populateStatusOptions();
    updateActionLabels();
    renderTables();
  }

  function findAsset(type, id){
    const list = type === 'vehicle' ? state.vehicleRows : state.equipmentRows;
    return list.find((row)=> row.id === id) || null;
  }

  function toggleDrawerTab(tab){
    state.drawerTab = tab;
    const summaryTab = qs('fleetPanelSummaryTab');
    const editTab = qs('fleetPanelEditTab');
    if(summaryTab) summaryTab.classList.toggle('active', tab === 'summary');
    if(editTab) editTab.classList.toggle('active', tab === 'edit');
    const summaryBody = qs('fleetPanelBody');
    const editBody = qs('fleetEditorBody');
    if(summaryBody) summaryBody.hidden = tab !== 'summary';
    if(editBody) editBody.hidden = tab !== 'edit';
  }

  function buildSummaryRows(type, item){
    const isVehicle = type === 'vehicle';
    const rows = [
      ['Code', item.code || FALLBACK],
      ['Location', item.location || FALLBACK],
      ['Status', item.status || 'active'],
      ['Assigned Project', item.assignedproject || item.assignedProject || FALLBACK]
    ];
    if(isVehicle){
      rows.push(['Make', item.make || FALLBACK]);
      rows.push(['Model', item.model || FALLBACK]);
      rows.push(['Year', item.year || FALLBACK]);
      rows.push(['Plate', item.plate || FALLBACK]);
      rows.push(['VIN', item.vin || FALLBACK]);
    }else{
      rows.push(['Category', item.category || FALLBACK]);
      rows.push(['Serial', item.serial || FALLBACK]);
      rows.push(['Model', item.model || FALLBACK]);
      rows.push(['Manufacturer', item.manufacturer || FALLBACK]);
      rows.push(['Warranty End', fmtDate(item.warrantyend || item.warrantyEnd)]);
    }
    rows.push(['Purchase Date', fmtDate(item.purchasedate || item.purchaseDate)]);
    return rows;
  }

  function renderSummaryPanel(type, item){
    const body = qs('fleetPanelBody');
    if(!body) return;
    const isVehicle = type === 'vehicle';
    const service = serviceMeta(item);
    const metrics = isVehicle
      ? [
        ['Mileage', fmtNumber(item.mileage)],
        ['Last Service', fmtDate(item.lastserviceat || item.lastServiceAt)],
        ['Next Service', fmtDate(item.nextserviceat || item.nextServiceAt)],
        ['Service State', service.label]
      ]
      : [
        ['Usage Hours', fmtNumber(item.usagehours || item.usageHours)],
        ['Last Service', fmtDate(item.lastserviceat || item.lastServiceAt)],
        ['Next Service', fmtDate(item.nextserviceat || item.nextServiceAt)],
        ['Service State', service.label]
      ];
    body.innerHTML = `
      <section class="panel-section">
        <h3>Details</h3>
        <div class="panel-list">
          ${buildSummaryRows(type, item).map(([label, value])=> `<div class="panel-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || FALLBACK)}</strong></div>`).join('')}
        </div>
      </section>
      <section class="panel-section">
        <h3>Health &amp; Utilization</h3>
        <div class="panel-metrics">
          ${metrics.map(([label, value])=> `<div class="panel-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || FALLBACK)}</strong></div>`).join('')}
          <div class="panel-metric"><span>Last Activity</span><strong>${escapeHtml(fmtDate(item.lastactivityat || item.lastActivityAt))}</strong></div>
        </div>
      </section>
      <section class="panel-section">
        <h3>Notes</h3>
        <p class="panel-note">${escapeHtml(item.notes || 'No notes yet.')}</p>
      </section>
    `;
  }

  function inputValue(item, ...keys){
    for(const key of keys){
      if(item[key] !== undefined && item[key] !== null) return item[key];
    }
    return '';
  }

  function renderEditorPanel(type, item){
    const body = qs('fleetEditorBody');
    if(!body) return;
    if(!state.isAdmin){
      body.innerHTML = '<div class="report-empty">Only admins can edit fleet assets.</div>';
      return;
    }
    const isVehicle = type === 'vehicle';
    const title = state.createMode ? `Create ${isVehicle ? 'vehicle' : 'equipment'}` : `Update ${isVehicle ? 'vehicle' : 'equipment'}`;
    body.innerHTML = `
      <section class="panel-section">
        <h3>${escapeHtml(title)}</h3>
        <div id="fleetEditorStatus" class="muted-text"></div>
      </section>
      <form id="fleetAssetForm" class="inventory-form">
        ${isVehicle ? `
          <div class="form-row">
            <label>Code<input name="code" required value="${escapeHtml(inputValue(item, 'code'))}" /></label>
            <label>Name<input name="name" required value="${escapeHtml(inputValue(item, 'name'))}" /></label>
          </div>
          <div class="form-row">
            <label>Make<input name="make" value="${escapeHtml(inputValue(item, 'make'))}" /></label>
            <label>Model<input name="model" value="${escapeHtml(inputValue(item, 'model'))}" /></label>
          </div>
          <div class="form-row">
            <label>Year<input name="year" type="number" min="0" value="${escapeHtml(inputValue(item, 'year'))}" /></label>
            <label>Plate<input name="plate" value="${escapeHtml(inputValue(item, 'plate'))}" /></label>
          </div>
          <div class="form-row">
            <label>VIN<input name="vin" value="${escapeHtml(inputValue(item, 'vin'))}" /></label>
            <label>Location<input name="location" value="${escapeHtml(inputValue(item, 'location'))}" /></label>
          </div>
          <div class="form-row">
            <label>Status<input name="status" value="${escapeHtml(inputValue(item, 'status') || 'active')}" /></label>
            <label>Assigned Project<input name="assignedProject" value="${escapeHtml(inputValue(item, 'assignedProject', 'assignedproject'))}" /></label>
          </div>
          <div class="form-row">
            <label>Mileage<input name="mileage" type="number" min="0" value="${escapeHtml(inputValue(item, 'mileage'))}" /></label>
            <label>Tags<input name="tags" value="${escapeHtml(normalizeTags(item.tags).join(', '))}" placeholder="truck, service, field" /></label>
          </div>
          <div class="form-row">
            <label>Last Service<input name="lastServiceAt" type="date" value="${escapeHtml(fmtDateInput(inputValue(item, 'lastServiceAt', 'lastserviceat')))}" /></label>
            <label>Next Service<input name="nextServiceAt" type="date" value="${escapeHtml(fmtDateInput(inputValue(item, 'nextServiceAt', 'nextserviceat')))}" /></label>
          </div>
          <div class="form-row">
            <label>Last Activity<input name="lastActivityAt" type="date" value="${escapeHtml(fmtDateInput(inputValue(item, 'lastActivityAt', 'lastactivityat')))}" /></label>
            <label>Notes<textarea name="notes" rows="4">${escapeHtml(inputValue(item, 'notes'))}</textarea></label>
          </div>
        ` : `
          <div class="form-row">
            <label>Code<input name="code" required value="${escapeHtml(inputValue(item, 'code'))}" /></label>
            <label>Name<input name="name" required value="${escapeHtml(inputValue(item, 'name'))}" /></label>
          </div>
          <div class="form-row">
            <label>Category<input name="category" value="${escapeHtml(inputValue(item, 'category'))}" /></label>
            <label>Status<input name="status" value="${escapeHtml(inputValue(item, 'status') || 'active')}" /></label>
          </div>
          <div class="form-row">
            <label>Location<input name="location" value="${escapeHtml(inputValue(item, 'location'))}" /></label>
            <label>Assigned Project<input name="assignedProject" value="${escapeHtml(inputValue(item, 'assignedProject', 'assignedproject'))}" /></label>
          </div>
          <div class="form-row">
            <label>Serial<input name="serial" value="${escapeHtml(inputValue(item, 'serial'))}" /></label>
            <label>Manufacturer<input name="manufacturer" value="${escapeHtml(inputValue(item, 'manufacturer'))}" /></label>
          </div>
          <div class="form-row">
            <label>Model<input name="model" value="${escapeHtml(inputValue(item, 'model'))}" /></label>
            <label>Usage Hours<input name="usageHours" type="number" min="0" value="${escapeHtml(inputValue(item, 'usageHours', 'usagehours'))}" /></label>
          </div>
          <div class="form-row">
            <label>Purchase Date<input name="purchaseDate" type="date" value="${escapeHtml(fmtDateInput(inputValue(item, 'purchaseDate', 'purchasedate')))}" /></label>
            <label>Warranty End<input name="warrantyEnd" type="date" value="${escapeHtml(fmtDateInput(inputValue(item, 'warrantyEnd', 'warrantyend')))}" /></label>
          </div>
          <div class="form-row">
            <label>Last Service<input name="lastServiceAt" type="date" value="${escapeHtml(fmtDateInput(inputValue(item, 'lastServiceAt', 'lastserviceat')))}" /></label>
            <label>Next Service<input name="nextServiceAt" type="date" value="${escapeHtml(fmtDateInput(inputValue(item, 'nextServiceAt', 'nextserviceat')))}" /></label>
          </div>
          <div class="form-row">
            <label>Last Activity<input name="lastActivityAt" type="date" value="${escapeHtml(fmtDateInput(inputValue(item, 'lastActivityAt', 'lastactivityat')))}" /></label>
            <label>Tags<input name="tags" value="${escapeHtml(normalizeTags(item.tags).join(', '))}" placeholder="generator, yard, service" /></label>
          </div>
          <div class="form-row">
            <label>Notes<textarea name="notes" rows="4">${escapeHtml(inputValue(item, 'notes'))}</textarea></label>
          </div>
        `}
        <div class="drawer-actions">
          <button type="submit" class="action-btn primary">${state.createMode ? 'Create Asset' : 'Save Changes'}</button>
          ${state.createMode ? '' : '<button type="button" id="fleetDeleteBtn" class="action-btn outline">Delete</button>'}
          <button type="button" id="fleetCancelEditBtn" class="action-btn">Cancel</button>
        </div>
      </form>
    `;

    qs('fleetAssetForm')?.addEventListener('submit', (event)=>{
      event.preventDefault();
      saveAsset(type, item.id || null);
    });
    qs('fleetDeleteBtn')?.addEventListener('click', ()=> deleteAsset(type, item.id));
    qs('fleetCancelEditBtn')?.addEventListener('click', ()=>{
      if(state.createMode){
        closeDrawer();
        return;
      }
      toggleDrawerTab('summary');
    });
  }

  function renderDrawer(type, item){
    const isVehicle = type === 'vehicle';
    const title = state.createMode ? `New ${isVehicle ? 'Vehicle' : 'Equipment'}` : (item.name || item.code || 'Asset');
    const subtitleParts = [
      isVehicle ? [item.make, item.model].filter(Boolean).join(' ') : (item.category || 'Equipment'),
      item.location || FALLBACK,
      item.status || 'active'
    ].filter(Boolean);
    qs('fleetPanelKicker').textContent = isVehicle ? 'Vehicle' : 'Equipment';
    qs('fleetPanelTitle').textContent = title;
    qs('fleetPanelTags').innerHTML = state.createMode ? '<span class="badge info">New asset</span>' : buildTags(item.tags);
    qs('fleetPanelSub').textContent = subtitleParts.join(' | ');
    renderSummaryPanel(type, item);
    renderEditorPanel(type, item);
    updateActionLabels();
    toggleDrawerTab(state.createMode && state.isAdmin ? 'edit' : state.drawerTab);
  }

  function openDrawer(type, id, tab = 'summary'){
    const item = findAsset(type, id);
    if(!item) return;
    state.selectedType = type;
    state.selectedId = id;
    state.createMode = false;
    state.drawerTab = tab;
    renderDrawer(type, item);
    qs('fleetPanel')?.classList.add('open');
    qs('fleetPanelBackdrop')?.classList.add('active');
    document.body.classList.add('panel-open');
    qs('fleetPanel')?.setAttribute('aria-hidden', 'false');
  }

  function openCreateDrawer(){
    const type = activeAssetType();
    state.selectedType = type;
    state.selectedId = null;
    state.createMode = true;
    state.drawerTab = 'edit';
    const item = type === 'vehicle'
      ? { status: 'active', tags: [] }
      : { status: 'active', tags: [] };
    renderDrawer(type, item);
    qs('fleetPanel')?.classList.add('open');
    qs('fleetPanelBackdrop')?.classList.add('active');
    document.body.classList.add('panel-open');
    qs('fleetPanel')?.setAttribute('aria-hidden', 'false');
  }

  function closeDrawer(){
    qs('fleetPanel')?.classList.remove('open');
    qs('fleetPanelBackdrop')?.classList.remove('active');
    document.body.classList.remove('panel-open');
    qs('fleetPanel')?.setAttribute('aria-hidden', 'true');
    state.selectedId = null;
    state.createMode = false;
    state.drawerTab = 'summary';
  }

  async function requestJson(url, options = {}){
    const init = window.utils?.addAuthHeaders
      ? utils.addAuthHeaders({ credentials: 'include', ...options })
      : { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...options };
    const res = await fetch(url, init);
    let data = null;
    try{
      data = await res.json();
    }catch(e){
      data = null;
    }
    if(!res.ok){
      throw new Error(data?.error || res.statusText || 'Request failed');
    }
    return data;
  }

  function syncDrawerAfterRefresh(){
    const panel = qs('fleetPanel');
    if(!panel || !panel.classList.contains('open')) return;
    if(state.createMode){
      openCreateDrawer();
      return;
    }
    if(!state.selectedType || !state.selectedId) return;
    const item = findAsset(state.selectedType, state.selectedId);
    if(!item){
      closeDrawer();
      return;
    }
    renderDrawer(state.selectedType, item);
  }

  async function loadData({ force = false } = {}){
    try{
      if(force) window.utils?.invalidateApiCache?.('/api/fleet/');
      const [equipment, vehicles] = await Promise.all([
        window.utils?.fetchJsonSafe ? utils.fetchJsonSafe('/api/fleet/equipment', { cacheTtlMs: 5000, forceRefresh: force }, []) : fetch('/api/fleet/equipment').then((r)=> r.ok ? r.json() : []),
        window.utils?.fetchJsonSafe ? utils.fetchJsonSafe('/api/fleet/vehicles', { cacheTtlMs: 5000, forceRefresh: force }, []) : fetch('/api/fleet/vehicles').then((r)=> r.ok ? r.json() : [])
      ]);
      state.equipmentRows = Array.isArray(equipment) ? equipment : [];
      state.vehicleRows = Array.isArray(vehicles) ? vehicles : [];
      populateStatusOptions();
      renderTables();
      syncDrawerAfterRefresh();
      setPageStatus(`Loaded ${state.equipmentRows.length + state.vehicleRows.length} fleet assets.`, 'ok');
    }catch(e){
      setPageStatus(e.message || 'Unable to load fleet data.', 'error');
    }
  }

  async function saveAsset(type, id){
    try{
      setEditorStatus('Saving...', '');
      const form = qs('fleetAssetForm');
      if(!form) return;
      const payload = Object.fromEntries(new FormData(form).entries());
      const isVehicle = type === 'vehicle';
      const base = isVehicle ? '/api/fleet/vehicles' : '/api/fleet/equipment';
      const method = id ? 'PUT' : 'POST';
      const url = id ? `${base}/${encodeURIComponent(id)}` : base;
      const saved = await requestJson(url, { method, body: JSON.stringify(payload) });
      window.utils?.invalidateApiCache?.('/api/fleet/');
      state.createMode = false;
      state.selectedType = type;
      state.selectedId = saved.id;
      await loadData({ force: true });
      openDrawer(type, saved.id, 'summary');
      setPageStatus(`${isVehicle ? 'Vehicle' : 'Equipment'} saved.`, 'ok');
    }catch(e){
      setEditorStatus(e.message || 'Unable to save asset.', 'error');
    }
  }

  async function deleteAsset(type, id){
    if(!id) return;
    const confirmed = window.confirm('Delete this asset? This cannot be undone.');
    if(!confirmed) return;
    try{
      const base = type === 'vehicle' ? '/api/fleet/vehicles' : '/api/fleet/equipment';
      await requestJson(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      window.utils?.invalidateApiCache?.('/api/fleet/');
      closeDrawer();
      await loadData({ force: true });
      setPageStatus(`${type === 'vehicle' ? 'Vehicle' : 'Equipment'} deleted.`, 'ok');
    }catch(e){
      setEditorStatus(e.message || 'Unable to delete asset.', 'error');
    }
  }

  function bindStaticEvents(){
    document.querySelectorAll('.mode-btn').forEach((btn)=>{
      btn.addEventListener('click', ()=> setTab(btn.dataset.tab));
    });
    qs('fleetSearch')?.addEventListener('input', renderTables);
    qs('fleetStatusFilter')?.addEventListener('change', renderTables);
    qs('fleetServiceFilter')?.addEventListener('change', renderTables);
    qs('fleetRefreshBtn')?.addEventListener('click', ()=> loadData({ force: true }));
    qs('fleetCreateBtn')?.addEventListener('click', openCreateDrawer);
    qs('equipmentTableBody')?.addEventListener('click', (event)=>{
      const row = event.target.closest('.fleet-row');
      if(row) openDrawer(row.dataset.type, row.dataset.id, 'summary');
    });
    qs('vehicleTableBody')?.addEventListener('click', (event)=>{
      const row = event.target.closest('.fleet-row');
      if(row) openDrawer(row.dataset.type, row.dataset.id, 'summary');
    });
    qs('fleetPanelClose')?.addEventListener('click', closeDrawer);
    qs('fleetPanelBackdrop')?.addEventListener('click', closeDrawer);
    qs('fleetPanelSummaryTab')?.addEventListener('click', ()=> toggleDrawerTab('summary'));
    qs('fleetPanelEditTab')?.addEventListener('click', ()=>{
      if(state.isAdmin) toggleDrawerTab('edit');
    });
    document.addEventListener('keydown', (event)=>{
      if(event.key === 'Escape') closeDrawer();
    });
  }

  function applyRoleState(){
    const role = (window.utils?.getSession?.()?.role || '').toLowerCase();
    state.isAdmin = role === 'admin' || role === 'dev';
    updateActionLabels();
  }

  document.addEventListener('DOMContentLoaded', async ()=>{
    if(window.utils){
      if(!utils.requireSession?.()) return;
      utils.wrapFetchWithRole?.();
      utils.applyStoredTheme?.();
      utils.buildMobileNav?.();
      utils.applyNavVisibility?.();
      utils.registerServiceWorker?.();
      utils.setupLogout?.();
    }
    const tick = ()=> {
      const clock = qs('fleetClock');
      if(clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    tick();
    setInterval(tick, 60000);
    applyRoleState();
    bindStaticEvents();
    setTab('equipment');
    await loadData();
  });
})();
