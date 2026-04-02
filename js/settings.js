const SESSION_KEY = 'sessionUser';

function getSession(){
  if(window.utils?.getSession) return utils.getSession();
  try{
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  }catch(e){ return null; }
}

function setSession(next){
  if(window.utils?.setSession){
    utils.setSession(next);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(next));
}

function updateUserChip(){
  if(window.utils){
    utils.setupUserChip?.();
  }
}

function normalizeNotificationPrefs(raw){
  const prefs = raw && typeof raw === 'object' ? raw : {};
  return {
    projectMaterialsReadyEmail: prefs.projectMaterialsReadyEmail !== false,
    lowStockEmail: prefs.lowStockEmail !== false
  };
}

function escapeMarkup(value){
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAdminSettingsMsg(){
  return document.getElementById('adminSettingsMsg');
}

let locationRowsCache = [];
let webhookRowsCache = [];
let webhookEventsCache = [];

function normalizeLocationRefInput(value, fallbackName = ''){
  const raw = String(value || fallbackName || '').trim().toLowerCase();
  if(!raw) return '';
  return raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function getLocationMsg(){
  return document.getElementById('locationMsg');
}

function resetLocationForm(){
  document.getElementById('locationForm')?.reset();
  const id = document.getElementById('locationId');
  const title = document.getElementById('locationFormTitle');
  const saveBtn = document.getElementById('locationSaveBtn');
  const active = document.getElementById('locationActive');
  const consumptionPoint = document.getElementById('locationConsumptionPoint');
  if(id) id.value = '';
  if(active) active.checked = true;
  if(consumptionPoint) consumptionPoint.checked = false;
  if(title) title.textContent = 'Create Location';
  if(saveBtn) saveBtn.textContent = 'Save Location';
  const msg = getLocationMsg();
  if(msg) msg.textContent = '';
  populateLocationParentSelect(locationRowsCache);
}

function populateLocationParentSelect(rows, selectedId = '', excludeId = ''){
  const select = document.getElementById('locationParent');
  if(!select) return;
  select.innerHTML = '<option value="">No parent</option>';
  (rows || []).forEach((row)=>{
    if(excludeId && row.id === excludeId) return;
    const option = document.createElement('option');
    option.value = row.id;
    option.textContent = `${'  '.repeat(Math.max(0, row.depth || 0))}${row.name}`;
    select.appendChild(option);
  });
  select.value = selectedId || '';
}

function updateLocationSummary(rows){
  const total = rows.length;
  const roots = rows.filter((row)=> !row.parentId).length;
  const bins = rows.filter((row)=> row.type === 'bin').length;
  const vehicles = rows.filter((row)=> row.type === 'vehicle').length;
  const consumptionPoints = rows.filter((row)=> row.isConsumptionPoint === true).length;
  const setText = (id, value)=>{
    const el = document.getElementById(id);
    if(el) el.textContent = `${value}`;
  };
  setText('locationTotal', total);
  setText('locationRoots', roots);
  setText('locationBins', bins);
  setText('locationVehicles', vehicles);
  setText('locationConsumptionPoints', consumptionPoints);
}

function renderLocationTree(rows){
  const wrap = document.getElementById('locationTree');
  if(!wrap) return;
  if(!rows.length){
    wrap.innerHTML = '<div class="muted-text">No managed locations yet.</div>';
    return;
  }
  wrap.innerHTML = rows.map((row)=>{
    const childrenLabel = row.parentName ? `Child of ${row.parentName}` : 'Top level';
    const consumptionBadge = row.isConsumptionPoint ? '<span class="badge success">Consumption Point</span>' : '';
    return `
      <div class="location-row-card" style="--location-depth:${Math.max(0, row.depth || 0)};">
        <div class="location-row-main">
          <div class="location-row-head">
            <strong>${row.name}</strong>
            <span class="badge ${row.type === 'writeoff' ? 'warn' : 'info'}">${row.typeLabel || row.type}</span>
            ${consumptionBadge}
          </div>
          <div class="location-row-meta">
            <span>${row.label}</span>
            <span>Ref: ${row.ref}</span>
            <span>${childrenLabel}</span>
          </div>
          ${row.notes ? `<p class="location-row-notes">${row.notes}</p>` : ''}
        </div>
        <div class="location-row-actions">
          <button type="button" class="action-btn edit-location" data-id="${row.id}">Edit</button>
          <button type="button" class="action-btn delete-location" data-id="${row.id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  wrap.querySelectorAll('.edit-location').forEach((button)=>{
    button.addEventListener('click', ()=>{
      const row = locationRowsCache.find((entry)=> entry.id === button.dataset.id);
      if(!row) return;
      document.getElementById('locationId').value = row.id;
      document.getElementById('locationName').value = row.name || '';
      document.getElementById('locationRef').value = row.ref || '';
      document.getElementById('locationType').value = row.type || 'warehouse';
      document.getElementById('locationSortOrder').value = row.sortOrder ?? 0;
      document.getElementById('locationNotes').value = row.notes || '';
      document.getElementById('locationActive').checked = row.isActive !== false;
      document.getElementById('locationConsumptionPoint').checked = row.isConsumptionPoint === true;
      document.getElementById('locationFormTitle').textContent = `Edit ${row.name}`;
      document.getElementById('locationSaveBtn').textContent = 'Update Location';
      populateLocationParentSelect(locationRowsCache, row.parentId || '', row.id);
      document.getElementById('locationParent').value = row.parentId || '';
      document.getElementById('locationName')?.focus();
      const msg = getLocationMsg();
      if(msg) msg.textContent = '';
    });
  });

  wrap.querySelectorAll('.delete-location').forEach((button)=>{
    button.addEventListener('click', async ()=>{
      const row = locationRowsCache.find((entry)=> entry.id === button.dataset.id);
      if(!row) return;
      if(!confirm(`Delete location "${row.name}"?`)) return;
      const msg = getLocationMsg();
      if(msg) msg.textContent = 'Deleting location...';
      try{
        const response = await fetch(`/api/locations/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
        const data = await response.json().catch(()=>({}));
        if(!response.ok) throw new Error(data.error || 'Unable to delete location');
        await loadLocations();
        resetLocationForm();
        if(msg) msg.textContent = 'Location deleted';
      }catch(e){
        if(msg) msg.textContent = e.message || 'Unable to delete location';
      }
    });
  });
}

async function loadLocations(){
  try{
    const response = await fetch('/api/locations');
    if(!response.ok) throw new Error('Unable to load locations');
    const rows = await response.json();
    locationRowsCache = Array.isArray(rows) ? rows : [];
    updateLocationSummary(locationRowsCache);
    populateLocationParentSelect(locationRowsCache);
    renderLocationTree(locationRowsCache);
  }catch(e){
    const wrap = document.getElementById('locationTree');
    if(wrap) wrap.innerHTML = '<div class="muted-text">Unable to load locations.</div>';
    const msg = getLocationMsg();
    if(msg) msg.textContent = 'Unable to load locations.';
  }
}

function initLocations(){
  const form = document.getElementById('locationForm');
  if(!form) return;
  const nameInput = document.getElementById('locationName');
  const refInput = document.getElementById('locationRef');
  const resetBtn = document.getElementById('locationResetBtn');
  const refreshBtn = document.getElementById('locationRefreshBtn');

  nameInput?.addEventListener('input', ()=>{
    if(!refInput || document.getElementById('locationId')?.value) return;
    refInput.value = normalizeLocationRefInput(refInput.value, nameInput.value);
  });
  refInput?.addEventListener('blur', ()=>{
    refInput.value = normalizeLocationRefInput(refInput.value, nameInput?.value || '');
  });

  form.addEventListener('submit', async (event)=>{
    event.preventDefault();
    const id = document.getElementById('locationId').value.trim();
    const payload = {
      name: document.getElementById('locationName').value.trim(),
      ref: normalizeLocationRefInput(document.getElementById('locationRef').value, document.getElementById('locationName').value),
      type: document.getElementById('locationType').value,
      parentId: document.getElementById('locationParent').value || '',
      sortOrder: Number(document.getElementById('locationSortOrder').value || 0),
      notes: document.getElementById('locationNotes').value.trim(),
      isActive: !!document.getElementById('locationActive').checked,
      isConsumptionPoint: !!document.getElementById('locationConsumptionPoint').checked
    };
    const msg = getLocationMsg();
    if(msg) msg.textContent = id ? 'Updating location...' : 'Creating location...';
    try{
      const response = await fetch(id ? `/api/locations/${encodeURIComponent(id)}` : '/api/locations', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(data.error || 'Unable to save location');
      await loadLocations();
      resetLocationForm();
      if(msg) msg.textContent = id ? 'Location updated' : 'Location created';
    }catch(e){
      if(msg) msg.textContent = e.message || 'Unable to save location';
    }
  });

  resetBtn?.addEventListener('click', resetLocationForm);
  refreshBtn?.addEventListener('click', loadLocations);
  loadLocations();
}

function setPilotText(id, value){
  const el = document.getElementById(id);
  if(el) el.textContent = `${value}`;
}

function parseDownloadFilename(disposition, fallback){
  const raw = String(disposition || '');
  const match = /filename="([^"]+)"/i.exec(raw) || /filename=([^;]+)/i.exec(raw);
  const name = match?.[1] ? match[1].trim() : '';
  return name || fallback;
}

function triggerBlobDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadPilotSummary(){
  const msg = document.getElementById('pilotSummaryMsg');
  if(msg) msg.textContent = 'Loading pilot readiness...';
  try{
    const response = await fetch('/api/dashboard/admin');
    if(!response.ok) throw new Error('Unable to load pilot readiness');
    const data = await response.json().catch(()=> ({}));
    const metrics = data?.metrics || {};
    const lowStock = Number(metrics.lowStockCount || 0);
    const openOrders = Number(metrics.openOrdersCount || 0);
    const overdue = Number(metrics.overdueCount || 0);
    const countsDue = Number(metrics.countDueCount || 0);
    setPilotText('pilotLowStockCount', lowStock);
    setPilotText('pilotOpenOrdersCount', openOrders);
    setPilotText('pilotOverdueCount', overdue);
    setPilotText('pilotCountDueCount', countsDue);
    const notices = [];
    if(overdue > 0) notices.push(`${overdue} overdue return${overdue === 1 ? '' : 's'}`);
    if(lowStock > 0) notices.push(`${lowStock} low-stock item${lowStock === 1 ? '' : 's'}`);
    if(countsDue > 0) notices.push(`${countsDue} item${countsDue === 1 ? '' : 's'} due for count`);
    if(msg) msg.textContent = notices.length ? `Attention today: ${notices.join(' | ')}` : 'Pilot status looks stable right now.';
  }catch(e){
    if(msg) msg.textContent = e.message || 'Unable to load pilot readiness.';
  }
}

async function downloadPilotSnapshot(){
  const msg = document.getElementById('pilotExportMsg');
  if(msg) msg.textContent = 'Preparing snapshot...';
  try{
    const response = await fetch('/api/export/pilot-snapshot');
    const errorData = !response.ok ? await response.json().catch(()=> ({})) : null;
    if(!response.ok) throw new Error(errorData?.error || 'Unable to download snapshot');
    const blob = await response.blob();
    const filename = parseDownloadFilename(response.headers.get('Content-Disposition'), `pilot-snapshot-${new Date().toISOString().slice(0, 10)}.json`);
    triggerBlobDownload(blob, filename);
    if(msg) msg.textContent = `Downloaded ${filename}`;
  }catch(e){
    if(msg) msg.textContent = e.message || 'Unable to download snapshot.';
  }
}

function exportPilotInventoryCsv(){
  const msg = document.getElementById('pilotExportMsg');
  const link = document.createElement('a');
  link.href = '/api/export/inventory';
  link.download = `inventory-all-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  if(msg) msg.textContent = 'Inventory CSV export started.';
}

function initPilotTools(){
  document.getElementById('pilotRefreshBtn')?.addEventListener('click', loadPilotSummary);
  document.getElementById('pilotDownloadSnapshotBtn')?.addEventListener('click', downloadPilotSnapshot);
  document.getElementById('pilotExportInventoryBtn')?.addEventListener('click', exportPilotInventoryCsv);
  loadPilotSummary();
}

function getWebhookMsg(){
  return document.getElementById('webhookMsg');
}

function formatWebhookDate(ts){
  const value = Number(ts);
  if(!Number.isFinite(value) || value <= 0) return 'Never';
  try{
    return new Date(value).toLocaleString();
  }catch(e){
    return 'Never';
  }
}

function resetWebhookForm(){
  document.getElementById('webhookForm')?.reset();
  const id = document.getElementById('webhookId');
  const title = document.getElementById('webhookFormTitle');
  const saveBtn = document.getElementById('webhookSaveBtn');
  const active = document.getElementById('webhookActive');
  if(id) id.value = '';
  if(active) active.checked = true;
  if(title) title.textContent = 'Create Inbound Webhook';
  if(saveBtn) saveBtn.textContent = 'Save Webhook';
  const msg = getWebhookMsg();
  if(msg) msg.textContent = '';
}

function hideWebhookSecretCard(){
  const card = document.getElementById('webhookSecretCard');
  if(card) card.style.display = 'none';
}

function showWebhookSecretCard(row){
  const card = document.getElementById('webhookSecretCard');
  const url = document.getElementById('webhookUrlValue');
  const secret = document.getElementById('webhookSecretValue');
  if(url) url.value = row?.receiveUrl || '';
  if(secret) secret.value = row?.secret || '';
  if(card) card.style.display = row?.secret ? '' : 'none';
}

function updateWebhookSummary(rows, events){
  const activeCount = (rows || []).filter((row)=> row.isActive !== false).length;
  const setText = (id, value)=>{
    const el = document.getElementById(id);
    if(el) el.textContent = value;
  };
  setText('webhookActiveCount', `${activeCount}`);
  setText('webhookTotalCount', `${(rows || []).length}`);
  setText('webhookEventCount', `${(events || []).length}`);
  setText('webhookLastReceived', formatWebhookDate((events || [])[0]?.receivedAt || 0));
}

function renderWebhookEndpointList(rows){
  const wrap = document.getElementById('webhookEndpointList');
  if(!wrap) return;
  if(!rows.length){
    wrap.innerHTML = '<div class="muted-text">No inbound webhook endpoints configured yet.</div>';
    return;
  }
  wrap.innerHTML = rows.map((row)=>`
    <div class="webhook-endpoint-card">
      <div class="webhook-endpoint-main">
        <div class="webhook-endpoint-head">
          <strong>${escapeMarkup(row.name)}</strong>
          <div class="webhook-chip-row">
            <span class="badge info">${escapeMarkup(row.source || 'generic')}</span>
            <span class="status-pill ${row.isActive !== false ? 'active' : 'closed'}">${row.isActive !== false ? 'active' : 'inactive'}</span>
          </div>
        </div>
        <div class="webhook-meta-line">URL: <span class="webhook-inline-code">${escapeMarkup(row.receiveUrl)}</span></div>
        <div class="webhook-meta-line">Secret: <span class="webhook-inline-code">${escapeMarkup(row.maskedSecret || 'Hidden')}</span></div>
        <div class="webhook-meta-grid">
          <span>Events: ${row.eventCount || 0}</span>
          <span>Last received: ${formatWebhookDate(row.lastReceivedAt)}</span>
        </div>
        ${row.notes ? `<p class="webhook-notes">${escapeMarkup(row.notes)}</p>` : ''}
      </div>
      <div class="webhook-actions">
        <button type="button" class="action-btn webhook-edit" data-id="${row.id}">Edit</button>
        <button type="button" class="action-btn webhook-rotate" data-id="${row.id}">Rotate Secret</button>
        <button type="button" class="action-btn webhook-delete" data-id="${row.id}">Delete</button>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('.webhook-edit').forEach((button)=>{
    button.addEventListener('click', ()=>{
      const row = webhookRowsCache.find((entry)=> entry.id === button.dataset.id);
      if(!row) return;
      document.getElementById('webhookId').value = row.id;
      document.getElementById('webhookName').value = row.name || '';
      document.getElementById('webhookSource').value = row.source || 'generic';
      document.getElementById('webhookNotes').value = row.notes || '';
      document.getElementById('webhookActive').checked = row.isActive !== false;
      document.getElementById('webhookFormTitle').textContent = `Edit ${row.name}`;
      document.getElementById('webhookSaveBtn').textContent = 'Update Webhook';
      hideWebhookSecretCard();
      document.getElementById('webhookName')?.focus();
      const msg = getWebhookMsg();
      if(msg) msg.textContent = '';
    });
  });

  wrap.querySelectorAll('.webhook-rotate').forEach((button)=>{
    button.addEventListener('click', async ()=>{
      const row = webhookRowsCache.find((entry)=> entry.id === button.dataset.id);
      if(!row) return;
      const msg = getWebhookMsg();
      if(msg) msg.textContent = `Rotating secret for ${row.name}...`;
      try{
        const response = await fetch(`/api/inbound-webhooks/${encodeURIComponent(row.id)}/rotate-secret`, { method:'POST' });
        const data = await response.json().catch(()=>({}));
        if(!response.ok) throw new Error(data.error || 'Unable to rotate secret');
        showWebhookSecretCard(data);
        await loadWebhookWorkspace();
        if(msg) msg.textContent = 'Webhook secret rotated';
      }catch(e){
        if(msg) msg.textContent = e.message || 'Unable to rotate secret';
      }
    });
  });

  wrap.querySelectorAll('.webhook-delete').forEach((button)=>{
    button.addEventListener('click', async ()=>{
      const row = webhookRowsCache.find((entry)=> entry.id === button.dataset.id);
      if(!row) return;
      if(!confirm(`Delete inbound webhook "${row.name}"?`)) return;
      const msg = getWebhookMsg();
      if(msg) msg.textContent = `Deleting ${row.name}...`;
      try{
        const response = await fetch(`/api/inbound-webhooks/${encodeURIComponent(row.id)}`, { method:'DELETE' });
        const data = await response.json().catch(()=>({}));
        if(!response.ok) throw new Error(data.error || 'Unable to delete webhook');
        hideWebhookSecretCard();
        await loadWebhookWorkspace();
        resetWebhookForm();
        if(msg) msg.textContent = 'Webhook deleted';
      }catch(e){
        if(msg) msg.textContent = e.message || 'Unable to delete webhook';
      }
    });
  });
}

function renderWebhookEvents(rows){
  const wrap = document.getElementById('webhookEventList');
  if(!wrap) return;
  if(!rows.length){
    wrap.innerHTML = '<div class="muted-text">No inbound webhook events received yet.</div>';
    return;
  }
  wrap.innerHTML = rows.map((row)=>`
    <div class="webhook-event-card">
      <div class="webhook-event-head">
        <strong>${escapeMarkup(row.eventType || 'generic.event')}</strong>
        <span class="badge info">${escapeMarkup(row.source || 'generic')}</span>
      </div>
      <div class="webhook-meta-grid">
        <span>Endpoint: ${escapeMarkup(row.endpointName || 'Webhook')}</span>
        <span>Status: ${escapeMarkup(row.status || 'accepted')}</span>
        <span>Received: ${formatWebhookDate(row.receivedAt)}</span>
        <span>Delivery ID: ${escapeMarkup(row.externalId || 'n/a')}</span>
      </div>
    </div>
  `).join('');
}

async function loadWebhookWorkspace(){
  try{
    const [endpointResponse, eventResponse] = await Promise.all([
      fetch('/api/inbound-webhooks'),
      fetch('/api/inbound-webhooks/events')
    ]);
    if(!endpointResponse.ok) throw new Error('Unable to load webhooks');
    if(!eventResponse.ok) throw new Error('Unable to load webhook events');
    webhookRowsCache = await endpointResponse.json();
    webhookEventsCache = await eventResponse.json();
    updateWebhookSummary(webhookRowsCache, webhookEventsCache);
    renderWebhookEndpointList(webhookRowsCache);
    renderWebhookEvents(webhookEventsCache);
  }catch(e){
    renderWebhookEndpointList([]);
    renderWebhookEvents([]);
    updateWebhookSummary([], []);
    const msg = getWebhookMsg();
    if(msg) msg.textContent = e.message || 'Unable to load inbound webhooks';
  }
}

function initWebhooks(){
  const form = document.getElementById('webhookForm');
  if(!form) return;
  const refreshBtn = document.getElementById('webhookRefreshBtn');
  const resetBtn = document.getElementById('webhookResetBtn');
  const copyUrlBtn = document.getElementById('copyWebhookUrlBtn');
  const copySecretBtn = document.getElementById('copyWebhookSecretBtn');

  form.addEventListener('submit', async (event)=>{
    event.preventDefault();
    const id = document.getElementById('webhookId').value.trim();
    const payload = {
      name: document.getElementById('webhookName').value.trim(),
      source: document.getElementById('webhookSource').value.trim(),
      notes: document.getElementById('webhookNotes').value.trim(),
      isActive: !!document.getElementById('webhookActive').checked
    };
    const msg = getWebhookMsg();
    if(msg) msg.textContent = id ? 'Updating webhook...' : 'Creating webhook...';
    try{
      const response = await fetch(id ? `/api/inbound-webhooks/${encodeURIComponent(id)}` : '/api/inbound-webhooks', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(data.error || 'Unable to save webhook');
      if(id) hideWebhookSecretCard();
      else showWebhookSecretCard(data);
      await loadWebhookWorkspace();
      resetWebhookForm();
      if(msg) msg.textContent = id ? 'Webhook updated' : 'Webhook created';
    }catch(e){
      if(msg) msg.textContent = e.message || 'Unable to save webhook';
    }
  });

  resetBtn?.addEventListener('click', ()=>{
    hideWebhookSecretCard();
    resetWebhookForm();
  });
  refreshBtn?.addEventListener('click', loadWebhookWorkspace);
  copyUrlBtn?.addEventListener('click', async ()=>{
    const value = document.getElementById('webhookUrlValue')?.value || '';
    if(!value) return;
    try{ await navigator.clipboard.writeText(value); }catch(e){}
  });
  copySecretBtn?.addEventListener('click', async ()=>{
    const value = document.getElementById('webhookSecretValue')?.value || '';
    if(!value) return;
    try{ await navigator.clipboard.writeText(value); }catch(e){}
  });

  hideWebhookSecretCard();
  loadWebhookWorkspace();
}

function renderNotificationPrefs(prefs){
  const resolved = normalizeNotificationPrefs(prefs);
  const projectToggle = document.getElementById('prefProjectMaterialsReadyEmail');
  const lowStockToggle = document.getElementById('prefLowStockEmail');
  if(projectToggle) projectToggle.checked = resolved.projectMaterialsReadyEmail;
  if(lowStockToggle) lowStockToggle.checked = resolved.lowStockEmail;
}

function readNotificationPrefs(){
  return normalizeNotificationPrefs({
    projectMaterialsReadyEmail: !!document.getElementById('prefProjectMaterialsReadyEmail')?.checked,
    lowStockEmail: !!document.getElementById('prefLowStockEmail')?.checked
  });
}

function updateSessionNotificationPrefs(prefs){
  const session = getSession();
  if(!session) return;
  setSession({ ...session, notificationPrefs: normalizeNotificationPrefs(prefs) });
}

async function loadNotificationPrefs(){
  try{
    const response = await fetch('/api/users/me/notifications');
    if(!response.ok) throw new Error('Failed to load notifications');
    const data = await response.json();
    const prefs = normalizeNotificationPrefs(data.notificationPrefs);
    renderNotificationPrefs(prefs);
    updateSessionNotificationPrefs(prefs);
  }catch(e){
    renderNotificationPrefs(getSession()?.notificationPrefs || {});
    const msg = getAdminSettingsMsg();
    if(msg) msg.textContent = 'Unable to load notification settings.';
  }
}

async function saveNotificationPrefs(){
  const msg = getAdminSettingsMsg();
  const button = document.getElementById('notificationPrefsSave');
  const prefs = readNotificationPrefs();
  if(button) button.disabled = true;
  if(msg) msg.textContent = 'Saving notification settings...';
  try{
    const response = await fetch('/api/users/me/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationPrefs: prefs })
    });
    if(!response.ok){
      const data = await response.json().catch(()=>({ error: 'Unable to save notification settings' }));
      throw new Error(data.error || 'Unable to save notification settings');
    }
    const user = await response.json();
    if(user?.id) setSession(user);
    else updateSessionNotificationPrefs(prefs);
    renderNotificationPrefs(user?.notificationPrefs || prefs);
    if(msg) msg.textContent = 'Notification settings saved';
  }catch(e){
    if(msg) msg.textContent = e.message || 'Unable to save notification settings';
  }finally{
    if(button) button.disabled = false;
  }
}

async function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadProfileFields(){
  const session = getSession();
  const nameInput = document.getElementById('adminProfileName');
  const avatarInput = document.getElementById('adminProfileAvatar');
  if(nameInput){
    nameInput.value = session?.name || '';
  }
  if(avatarInput){
    const fallback = session?.name ? session.name.slice(0,2).toUpperCase() : '';
    avatarInput.value = utils.getProfileValue?.('avatar') || fallback;
  }
}

function saveProfileFields(){
  const session = getSession();
  const nameInput = document.getElementById('adminProfileName');
  const avatarInput = document.getElementById('adminProfileAvatar');
  const msg = document.getElementById('adminProfileMsg');
  const nameVal = nameInput?.value.trim() || '';
  const avatarVal = avatarInput?.value.trim().toUpperCase() || '';
  if(avatarVal) utils.setProfileValue?.('avatar', avatarVal);
  else utils.setProfileValue?.('avatar', '');
  if(session) setSession(session);
  if(msg) msg.textContent = 'Profile saved';
  updateUserChip();
}

function clearProfileFields(){
  utils.clearProfileValues?.();
  const session = getSession();
  if(session){
    const next = { ...session };
    const storedName = utils.getProfileValue?.('name');
    if(next.name && storedName) next.name = storedName;
    setSession(next);
  }
  loadProfileFields();
  const msg = document.getElementById('adminProfileMsg');
  if(msg) msg.textContent = 'Profile cleared';
  updateUserChip();
}

function applyDensity(val){
  if(val === 'compact'){
    document.documentElement.classList.add('compact');
  }else{
    document.documentElement.classList.remove('compact');
  }
}

function applyFontSize(val){
  document.documentElement.style.setProperty('--font-scale', val === 'large' ? '1.1' : val === 'xlarge' ? '1.2' : '1');
  document.body.style.fontSize = `calc(16px * ${document.documentElement.style.getPropertyValue('--font-scale') || 1})`;
}

function initAppearanceSettings(){
  const themeSelect = document.getElementById('themeSelect');
  const densitySelect = document.getElementById('densitySelect');
  const fontSizeSelect = document.getElementById('fontSizeSelect');
  const languageSelect = document.getElementById('languageSelect');
  const timeFormatSelect = document.getElementById('timeFormatSelect');
  const shortcutToggles = document.querySelectorAll('.shortcut-toggle');
  const msg = document.getElementById('adminSettingsMsg');
  const appearanceSaveBtn = document.getElementById('appearanceSave');
  const shortcutsSaveBtn = document.getElementById('shortcutsSave');
  const localeSaveBtn = document.getElementById('localeSave');

  if(!themeSelect) return;

  const storedTheme = localStorage.getItem('theme') || 'light';
  themeSelect.value = storedTheme;
  const storedDensity = localStorage.getItem('density') || 'normal';
  densitySelect.value = storedDensity;
  const storedFontSize = localStorage.getItem('fontSize') || 'normal';
  fontSizeSelect.value = storedFontSize;
  const storedLang = localStorage.getItem('lang') || 'en-US';
  languageSelect.value = storedLang;
  const storedTimeFmt = localStorage.getItem('timeFmt') || '12h';
  timeFormatSelect.value = storedTimeFmt;

  const storedShortcuts = (localStorage.getItem('shortcuts') || '').split(',').filter(Boolean);
  shortcutToggles.forEach(cb=>{
    cb.checked = storedShortcuts.length === 0 ? true : storedShortcuts.includes(cb.value);
  });

  applyDensity(storedDensity);
  applyFontSize(storedFontSize);

  const saveAppearance = ()=>{
    const val = themeSelect.value;
    utils.setTheme?.(val);
    localStorage.setItem('density', densitySelect.value);
    applyDensity(densitySelect.value);
    localStorage.setItem('fontSize', fontSizeSelect.value);
    applyFontSize(fontSizeSelect.value);
    if(msg) msg.textContent = 'Appearance saved';
  };

  const saveLocale = ()=>{
    localStorage.setItem('lang', languageSelect.value);
    localStorage.setItem('timeFmt', timeFormatSelect.value);
    if(msg) msg.textContent = 'Language & time saved';
  };

  const saveShortcuts = ()=>{
    const enabled = Array.from(shortcutToggles).filter(x=>x.checked).map(x=>x.value);
    localStorage.setItem('shortcuts', enabled.join(','));
    if(msg) msg.textContent = 'Shortcuts saved';
  };

  themeSelect.addEventListener('change', saveAppearance);
  densitySelect.addEventListener('change', saveAppearance);
  fontSizeSelect.addEventListener('change', saveAppearance);
  languageSelect.addEventListener('change', saveLocale);
  timeFormatSelect.addEventListener('change', saveLocale);
  shortcutToggles.forEach(cb=>{
    cb.addEventListener('change', saveShortcuts);
  });

  appearanceSaveBtn?.addEventListener('click', saveAppearance);
  shortcutsSaveBtn?.addEventListener('click', saveShortcuts);
  localeSaveBtn?.addEventListener('click', saveLocale);
}

function initInstallLink(){
  const btn = document.getElementById('installAppBtn');
  const msg = document.getElementById('installAppMsg');
  if(!btn || !msg || !window.utils) return;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  const isStandalone = ()=> (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
  const update = ()=>{
    if(isStandalone()){
      msg.textContent = 'App already installed.';
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    if(utils.canPromptInstall?.()){
      msg.textContent = 'Ready to install.';
    }else if(isIos){
      msg.textContent = 'On iOS: Share > Add to Home Screen.';
    }else{
      msg.textContent = 'Use browser menu > Install app.';
    }
  };
  btn.addEventListener('click', async ()=>{
    if(isStandalone()){
      update();
      return;
    }
    const result = await utils.promptInstall?.();
    if(result?.outcome === 'accepted'){
      msg.textContent = 'Install started.';
    }else if(result?.outcome === 'dismissed'){
      msg.textContent = 'Install dismissed.';
    }else{
      msg.textContent = isIos ? 'On iOS: Share > Add to Home Screen.' : 'Install option not available yet.';
    }
  });
  window.addEventListener('beforeinstallprompt', ()=> setTimeout(update, 0));
  window.addEventListener('appinstalled', update);
  update();
}

function setupTabs(){
  const buttons = document.querySelectorAll('.settings-tab');
  const panels = {
    appearance: document.getElementById('panelAppearance'),
    profile: document.getElementById('panelProfile'),
    shortcuts: document.getElementById('panelShortcuts'),
    locale: document.getElementById('panelLocale'),
    notifications: document.getElementById('panelNotifications'),
    webhooks: document.getElementById('panelWebhooks'),
    locations: document.getElementById('panelLocations'),
    pilot: document.getElementById('panelPilot'),
    users: document.getElementById('panelUsers'),
    capabilities: document.getElementById('panelCapabilities')
  };
  const show = (tab)=>{
    buttons.forEach(btn=> btn.classList.toggle('active', btn.dataset.tab === tab));
    Object.keys(panels).forEach(key=>{
      if(panels[key]) panels[key].style.display = key === tab ? '' : 'none';
    });
  };
  buttons.forEach(btn=>{
    btn.addEventListener('click', ()=> show(btn.dataset.tab));
  });
  const hash = (window.location.hash || '').replace('#','');
  const startTab = panels[hash] ? hash : 'users';
  show(startTab);
}

const usersCache = [];
const capabilityLabels = {
  ims_enabled: 'Inventory Management System',
  oms_enabled: 'Order Management System',
  bms_enabled: 'Business Management System',
  fms_enabled: 'Financial Management System',
  automation_enabled: 'Automation Pack',
  insights_enabled: 'Insights Pack',
  audit_enabled: 'Audit & Compliance Pack',
  integration_enabled: 'Integration Pack',
  end_to_end_ops: 'End-to-End Operations Control',
  financial_accuracy: 'Financial Accuracy Engine',
  enterprise_governance: 'Enterprise Governance'
};

function renderCapabilities(caps){
  const enabledList = document.getElementById('capEnabled');
  const soonList = document.getElementById('capSoon');
  const plannedList = document.getElementById('capPlanned');
  if(!enabledList || !soonList || !plannedList) return;
  enabledList.innerHTML = '';
  soonList.innerHTML = '';
  plannedList.innerHTML = '';

  const addItem = (list, label, statusText, statusClass)=>{
    const li = document.createElement('li');
    li.className = 'cap-item';
    const title = document.createElement('span');
    title.textContent = label;
    const status = document.createElement('span');
    status.className = `cap-status ${statusClass || ''}`.trim();
    status.textContent = statusText;
    li.appendChild(title);
    li.appendChild(status);
    list.appendChild(li);
  };

  const imsEnabled = !!caps?.ims_enabled;
  addItem(enabledList, capabilityLabels.ims_enabled, imsEnabled ? 'Enabled' : 'Locked', imsEnabled ? 'on' : 'off');

  ['oms_enabled','bms_enabled','fms_enabled'].forEach(key=>{
    const enabled = !!caps?.[key];
    addItem(soonList, capabilityLabels[key], enabled ? 'Enabled' : 'Locked', enabled ? 'on' : 'off');
  });

  [
    'automation_enabled',
    'insights_enabled',
    'audit_enabled',
    'integration_enabled',
    'end_to_end_ops',
    'financial_accuracy',
    'enterprise_governance'
  ].forEach(key=>{
    const enabled = !!caps?.[key];
    addItem(plannedList, capabilityLabels[key], enabled ? 'Enabled' : 'Planned', enabled ? 'on' : 'planned');
  });

  const billIms = document.getElementById('billIms');
  const billOms = document.getElementById('billOms');
  const billBms = document.getElementById('billBms');
  const billFms = document.getElementById('billFms');
  const billTotal = document.getElementById('billTotal');
  if(billIms) billIms.textContent = imsEnabled ? '$49' : 'Not enabled';
  if(billOms) billOms.textContent = caps?.oms_enabled ? '$39' : 'Not enabled';
  if(billBms) billBms.textContent = caps?.bms_enabled ? '$29' : 'Not enabled';
  if(billFms) billFms.textContent = caps?.fms_enabled ? '$49' : 'Not enabled';
  const total = (imsEnabled ? 49 : 0)
    + (caps?.oms_enabled ? 39 : 0)
    + (caps?.bms_enabled ? 29 : 0)
    + (caps?.fms_enabled ? 49 : 0);
  if(billTotal) billTotal.textContent = `$${total}`;
}

async function loadCapabilities(){
  try{
    const r = await fetch('/api/capabilities');
    if(!r.ok) return;
    const data = await r.json();
    renderCapabilities(data);
  }catch(e){}
}

async function loadUsers(role){
  try{
    const r = await fetch('/api/users',{headers:{'x-admin-role': role}});
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

async function createUser(role, user){
  const r = await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json','x-admin-role':role},body:JSON.stringify(user)});
  return r;
}

async function inviteUser(role, user){
  const r = await fetch('/api/users/invite',{method:'POST',headers:{'Content-Type':'application/json','x-admin-role':role},body:JSON.stringify(user)});
  return r;
}

function generateTempPassword(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
  let pwd = '';
  for(let i=0;i<12;i++){
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

function formatDateTimeSafe(val){
  if(window.utils?.formatDateTime) return utils.formatDateTime(val);
  if(!val) return '';
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function formatRoleLabel(role){
  const r = (role || '').toLowerCase();
  if(r === 'admin') return 'Admin';
  if(r === 'manager') return 'Manager';
  return 'Employee';
}

function updateUserStats(allUsers, visibleUsers){
  const total = allUsers.length;
  const admins = allUsers.filter(u=> u.role === 'admin').length;
  const managers = allUsers.filter(u=> u.role === 'manager').length;
  const employees = allUsers.filter(u=> u.role !== 'admin' && u.role !== 'manager').length;
  const setText = (id, val)=>{
    const el = document.getElementById(id);
    if(el) el.textContent = `${val}`;
  };
  setText('userTotal', total);
  setText('userAdmins', admins);
  setText('userManagers', managers);
  setText('userEmployees', employees);
  setText('userShowing', visibleUsers.length);
}

function applyUserFilters(allUsers){
  const search = (document.getElementById('userSearch')?.value || '').toLowerCase();
  const roleFilter = document.getElementById('userRoleFilter')?.value || '';
  const sort = document.getElementById('userSort')?.value || 'az';
  let filtered = allUsers.slice();
  if(search){
    filtered = filtered.filter(u=>{
      const email = (u.email || '').toLowerCase();
      const name = (u.name || '').toLowerCase();
      return email.includes(search) || name.includes(search);
    });
  }
  if(roleFilter){
    filtered = filtered.filter(u=>{
      const role = (u.role || '').toLowerCase();
      if(roleFilter === 'employee'){
        return role === 'employee' || role === 'user' || (role !== 'admin' && role !== 'manager');
      }
      return role === roleFilter;
    });
  }
  if(sort === 'az'){
    filtered.sort((a,b)=> (a.email || '').localeCompare(b.email || ''));
  }else if(sort === 'za'){
    filtered.sort((a,b)=> (b.email || '').localeCompare(a.email || ''));
  }else if(sort === 'newest'){
    filtered.sort((a,b)=> (b.createdAt || 0) - (a.createdAt || 0));
  }else if(sort === 'oldest'){
    filtered.sort((a,b)=> (a.createdAt || 0) - (b.createdAt || 0));
  }
  updateUserStats(allUsers, filtered);
  return filtered;
}

async function updateUserRole(user, role){
  if(!user?.id) return false;
  try{
    const payload = { name: user.name || '', email: user.email || '', role };
    const r = await fetch(`/api/users/${user.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    return r.ok;
  }catch(e){
    return false;
  }
}

async function deleteUser(user){
  if(!user?.id) return false;
  try{
    const r = await fetch(`/api/users/${user.id}`,{method:'DELETE'});
    return r.ok;
  }catch(e){
    return false;
  }
}

function renderUsersTable(allUsers){
  const tbody=document.querySelector('#usersTable tbody');tbody.innerHTML='';
  const users = applyUserFilters(allUsers);
  if(!users.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="5" style="text-align:center;color:#6b7280;">No users yet</td>`;
    tbody.appendChild(tr);
    updateUserStats(allUsers, users);
    return;
  }
  users.forEach(u=>{
    const tr=document.createElement('tr');
    const dt = formatDateTimeSafe(u.createdAt);
    const rawRole = (u.role || '').toLowerCase();
    const normalizedRole = rawRole === 'user' || !rawRole ? 'employee' : rawRole;
    const roleSelect = `
      <select class="role-select" data-id="${u.id}">
        <option value="employee"${normalizedRole === 'employee' ? ' selected' : ''}>Employee</option>
        <option value="manager"${normalizedRole === 'manager' ? ' selected' : ''}>Manager</option>
        <option value="admin"${normalizedRole === 'admin' ? ' selected' : ''}>Admin</option>
      </select>
    `;
    const btn = `
      <button type="button" class="action-btn edit-user" data-id="${u.id}" data-email="${u.email}" data-name="${u.name||''}" data-role="${normalizedRole}">Edit</button>
      <button type="button" class="action-btn delete-user" data-id="${u.id}">Delete</button>
    `;
    tr.innerHTML=`<td>${u.email}</td><td>${u.name||''}</td><td>${roleSelect}</td><td>${dt}</td><td>${btn}</td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.role-select').forEach(select=>{
    select.addEventListener('change', async ()=>{
      const id = select.dataset.id;
      const user = allUsers.find(u=> u.id === id);
      if(!user) return;
      const session = getSession();
      const previousRole = (user.role || '').toLowerCase() === 'user' || !user.role ? 'employee' : (user.role || '').toLowerCase();
      const nextRole = select.value;
      if(session?.id === user.id && nextRole !== previousRole){
        const ok = confirm('You are changing your own role. You may lose access to admin settings. Continue?');
        if(!ok){
          select.value = previousRole;
          return;
        }
      }
      select.disabled = true;
      const ok = await updateUserRole(user, nextRole);
      select.disabled = false;
      if(!ok){
        alert('Failed to update role');
        select.value = previousRole;
        return;
      }
      user.role = nextRole;
      renderUsersTable(usersCache);
    });
  });
  tbody.querySelectorAll('.edit-user').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.getElementById('edit-userId').value = btn.dataset.id;
      document.getElementById('edit-userName').value = btn.dataset.name || '';
      document.getElementById('edit-userEmail').value = btn.dataset.email || '';
      const role = (btn.dataset.role || '').toLowerCase();
      document.getElementById('edit-userRole').value = role === 'user' ? 'employee' : (role || 'employee');
      document.getElementById('edit-userPassword').value = '';
      document.getElementById('edit-userError').textContent = '';
      const meta = document.getElementById('edit-userMeta');
      if(meta) meta.textContent = `Editing user: ${btn.dataset.email || ''}`;
      openEditUserModal();
    });
  });
  tbody.querySelectorAll('.delete-user').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.id;
      const user = allUsers.find(u=> u.id === id);
      const session = getSession();
      if(!user) return;
      if(session?.id === user.id){
        alert('You cannot delete your own account.');
        return;
      }
      if(!confirm(`Delete user ${user.email}? This cannot be undone.`)) return;
      const ok = await deleteUser(user);
      if(!ok) alert('Failed to delete user');
      if(ok){
        const idx = usersCache.findIndex(u=> u.id === user.id);
        if(idx !== -1) usersCache.splice(idx, 1);
        renderUsersTable(usersCache);
      }
      await refreshUsers();
    });
  });
}

async function refreshUsers(){
  const session = getSession();
  if(!session) return;
  const users = await loadUsers(session.role);
  usersCache.length = 0;
  usersCache.push(...users);
  renderUsersTable(usersCache);
}

function exportUsersCSV(){
  const rows = applyUserFilters(usersCache);
  if(!rows.length){alert('No users to export');return;}
  const hdr = ['email','name','role','createdAt'];
  const data = rows.map(u=>[u.email,u.name || '',u.role || '',u.createdAt || '']);
  const csv = [hdr.join(','),...data.map(r=>r.map(c=>`"${String(c ?? '').replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob = new Blob([csv],{type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'users.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openEditUserModal(){
  const modal = document.getElementById('editUserModal');
  if(modal) modal.classList.remove('hidden');
}

function closeEditUserModal(){
  const modal = document.getElementById('editUserModal');
  if(modal) modal.classList.add('hidden');
  const editForm = document.getElementById('editUserForm');
  if(editForm) editForm.reset();
  const editErr = document.getElementById('edit-userError');
  if(editErr) editErr.textContent = '';
  const meta = document.getElementById('edit-userMeta');
  if(meta) meta.textContent = 'Editing user:';
}

document.addEventListener('DOMContentLoaded', ()=>{
  const session = getSession();
  const guard = document.getElementById('admin-guard');
  const content = document.getElementById('settings-content');
  const role = (session?.role || '').toLowerCase();
  if(!session || (role !== 'admin' && role !== 'dev')){
    guard.style.display='block';
    if(content) content.style.display='none';
    return;
  }
  const refreshBtn = document.getElementById('refreshSessionBtn');
  refreshBtn?.addEventListener('click', async ()=>{
    const msg = document.getElementById('adminSettingsMsg');
    if(msg) msg.textContent = 'Refreshing access...';
    const fresh = await utils.refreshSession?.();
    if(!fresh){
      if(msg) msg.textContent = 'Unable to refresh access.';
      return;
    }
    setSession(fresh);
    utils.applyNavVisibility?.();
    if(fresh.role !== 'admin' && fresh.role !== 'dev'){
      window.location.href = utils.getDashboardHref?.(fresh.role) || 'employee-dashboard.html';
      return;
    }
    if(msg) msg.textContent = `Access refreshed as ${formatRoleLabel(fresh.role)}.`;
  });
  setupTabs();
  initAppearanceSettings();
  initInstallLink();
  loadNotificationPrefs();
  initWebhooks();
  initLocations();
  initPilotTools();
  refreshUsers();
  loadCapabilities();
  document.getElementById('notificationPrefsSave')?.addEventListener('click', saveNotificationPrefs);
  const form=document.getElementById('userForm');
  const err=document.getElementById('userError');
  const inviteBtn = document.getElementById('userInviteBtn');
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    err.textContent='';
    err.style.color = '#b91c1c';
    const name=document.getElementById('userName').value.trim();
    const email=document.getElementById('userEmail').value.trim();
    const password=document.getElementById('userPassword').value;
    const role=document.getElementById('userRole').value;
    if(!email || !password){err.textContent='Email and password required';return;}
    const r = await createUser(session.role,{name,email,password,role});
    if(!r.ok){
      const data = await r.json().catch(()=>({error:'Failed to create user'}));
      err.textContent = data.error || 'Failed to create user';
      return;
    }
    err.style.color = '#15803d';
    err.textContent = 'User created. Verification email sent.';
    form.reset();
    refreshUsers();
  });
  inviteBtn?.addEventListener('click', async ()=>{
    err.textContent = '';
    err.style.color = '#b91c1c';
    const name=document.getElementById('userName').value.trim();
    const email=document.getElementById('userEmail').value.trim();
    const role=document.getElementById('userRole').value;
    if(!email){ err.textContent = 'Email is required for invites.'; return; }
    const r = await inviteUser(session.role,{name,email,role});
    if(!r.ok){
      const data = await r.json().catch(()=>({error:'Failed to send invite'}));
      err.textContent = data.error || 'Failed to send invite';
      return;
    }
    err.style.color = '#15803d';
    err.textContent = 'Invite sent.';
    form.reset();
    refreshUsers();
  });
  document.getElementById('userClearBtn').addEventListener('click',()=>{form.reset();err.textContent='';});
  document.getElementById('userGeneratePwd')?.addEventListener('click', ()=>{
    const pwd = generateTempPassword();
    document.getElementById('userPassword').value = pwd;
    err.textContent = `Generated password: ${pwd}`;
  });

  // Edit user
  const editForm = document.getElementById('editUserForm');
  const editErr = document.getElementById('edit-userError');
  editForm.addEventListener('submit', async ev=>{
    ev.preventDefault();
    editErr.textContent='';
    const id = document.getElementById('edit-userId').value;
    if(!id){ editErr.textContent='Select a user from the table first.'; return; }
    const rawRole = document.getElementById('edit-userRole').value;
    const payload = {
      name: document.getElementById('edit-userName').value.trim(),
      email: document.getElementById('edit-userEmail').value.trim(),
      role: rawRole === 'user' ? 'employee' : rawRole
    };
    const pw = document.getElementById('edit-userPassword').value;
    if(pw) payload.password = pw;
    try{
      const r = await fetch(`/api/users/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!r.ok){
        const data = await r.json().catch(()=>({error:'Update failed'}));
        editErr.textContent = data.error || 'Update failed';
        return;
      }
      closeEditUserModal();
      await refreshUsers();
    }catch(e){
      editErr.textContent = 'Unable to update user';
    }
  });
  document.getElementById('edit-userClearBtn').addEventListener('click',()=>{editForm.reset();editErr.textContent='';});
  document.getElementById('edit-generatePassword')?.addEventListener('click', ()=>{
    const pwd = generateTempPassword();
    document.getElementById('edit-userPassword').value = pwd;
    editErr.textContent = `Temp password generated: ${pwd}`;
  });
  document.getElementById('editUserClose')?.addEventListener('click', closeEditUserModal);
  document.getElementById('edit-userCancel')?.addEventListener('click', closeEditUserModal);
  document.getElementById('editUserModal')?.addEventListener('click', ev=>{
    if(ev.target === ev.currentTarget) closeEditUserModal();
  });
  document.addEventListener('keydown', ev=>{
    const modal = document.getElementById('editUserModal');
    if(ev.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeEditUserModal();
  });

  document.getElementById('userSearch')?.addEventListener('input', ()=> renderUsersTable(usersCache));
  document.getElementById('userRoleFilter')?.addEventListener('change', ()=> renderUsersTable(usersCache));
  document.getElementById('userSort')?.addEventListener('change', ()=> renderUsersTable(usersCache));
  document.getElementById('userRefreshBtn')?.addEventListener('click', refreshUsers);
  document.getElementById('userExportBtn')?.addEventListener('click', exportUsersCSV);

  // Profile panel
  loadProfileFields();
  const profileForm = document.getElementById('adminProfileForm');
  const profilePic = document.getElementById('adminProfilePicture');
  const profileClear = document.getElementById('adminProfileClear');
  if(profileForm){
    profileForm.addEventListener('submit', ev=>{
      ev.preventDefault();
      saveProfileFields();
    });
  }
  if(profileClear) profileClear.addEventListener('click', clearProfileFields);
  if(profilePic){
    profilePic.addEventListener('change', async (e)=>{
      const file = e.target.files && e.target.files[0];
      if(!file) return;
      const data = await fileToDataUrl(file);
      utils.setProfileValue?.('pic', data);
      const msg = document.getElementById('adminProfileMsg');
      if(msg) msg.textContent = 'Profile picture updated';
      updateUserChip();
    });
  }
});
