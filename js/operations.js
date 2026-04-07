let allItems = [];
let jobOptions = [];
let upcomingJobs = [];
let returnJobOptions = [];
let upcomingReservedCache = { jobId: '', items: [] };
let openOrders = [];
let openOrdersMap = new Map();
let openOrderGroups = [];
let openOrderGroupsMap = new Map();
let pendingCheckout = null;
let opsRefreshInFlight = null;
let inventoryLocationOptions = [];
let inventoryEntriesCache = [];
const FALLBACK = 'N/A';
const DEFAULT_CATEGORY_NAME = 'Uncategorized';
const MIN_LINES = 1;
const SESSION_KEY = 'sessionUser';
const OPS_DRAFTS_KEY = 'ims.ops.drafts.v1';
const OPS_DEFAULTS_KEY = 'ims.ops.defaults.v1';
let categoriesCache = [];
const FALLBACK_LOCATION_OPTIONS = [
  { id: 'loc:warehouse:main', name: 'Main Warehouse', label: 'Main Warehouse', type: 'warehouse', ref: 'main' },
  { id: 'loc:bin:primary', name: 'Primary Bin', label: 'Primary Bin', type: 'bin', ref: 'primary' },
  { id: 'loc:staging:default', name: 'Staging Area', label: 'Staging Area', type: 'staging', ref: 'default' },
  { id: 'loc:field:default', name: 'Field Stock', label: 'Field Stock', type: 'field', ref: 'default' },
  { id: 'loc:writeoff:default', name: 'Lost / Write-off', label: 'Lost / Write-off', type: 'writeoff', ref: 'default' }
];
const OPS_MODE_META = {
  checkout: {
    title: 'Pick Items',
    summary: 'Pull inventory for active projects and load reserved material when it is already planned.',
    helper: 'Best for project issue, allocation, and outbound movement.',
    badge: 'Check-Out'
  },
  checkin: {
    title: 'Receive Orders',
    summary: 'Bring incoming material into inventory from open orders and keep each line tied to its source.',
    helper: 'Best for warehouse receiving, delivery intake, and staged put-away.',
    badge: 'Check-In'
  },
  return: {
    title: 'Return Inventory',
    summary: 'Move issued inventory back into available stock with the return reason and destination captured.',
    helper: 'Best for unused material, overstock, and project closeout recovery.',
    badge: 'Returns'
  }
};
const OPS_FORM_FIELDS = {
  checkin: ['checkin-location', 'checkin-notes'],
  checkout: ['checkout-upcomingJob', 'checkout-jobId', 'checkout-location', 'checkout-notes'],
  return: ['return-jobId', 'return-reason', 'return-location', 'return-notes']
};
const OPS_DEFAULT_FIELDS = ['checkin-location', 'checkout-upcomingJob', 'checkout-jobId', 'checkout-location', 'return-jobId', 'return-reason', 'return-location'];
const OPS_MEANINGFUL_DRAFT_FIELDS = {
  checkin: ['checkin-notes'],
  checkout: ['checkout-upcomingJob', 'checkout-jobId', 'checkout-notes'],
  return: ['return-jobId', 'return-reason', 'return-notes']
};

function uid(){ return Math.random().toString(16).slice(2,8); }
function getSessionUser(){
  try{ return JSON.parse(localStorage.getItem(SESSION_KEY)||'null'); }catch(e){ return null; }
}
function setOpsFormMessage(id, message = '', tone = ''){
  const el = document.getElementById(id);
  if(!el) return;
  const cls = ['field-hint'];
  if(tone) cls.push(tone);
  el.className = cls.join(' ');
  el.textContent = message;
}
function getStableRequestBatchKey(formId, prefix){
  const form = document.getElementById(formId);
  if(!form) return utils?.makeRequestKey?.(prefix) || `${prefix}-${Date.now()}`;
  if(!form.dataset.requestBatchKey){
    form.dataset.requestBatchKey = utils?.makeRequestKey?.(prefix) || `${prefix}-${Date.now()}`;
  }
  return form.dataset.requestBatchKey;
}
function clearStableRequestBatchKey(formId){
  const form = document.getElementById(formId);
  if(form) delete form.dataset.requestBatchKey;
}
function buildLineRequestKey(batchKey, index){
  return `${batchKey}-line-${index + 1}`;
}
function readOpsStorage(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(e){
    return fallback;
  }
}
function writeOpsStorage(key, value){
  if(value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length){
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}
function getOpsDrafts(){
  return readOpsStorage(OPS_DRAFTS_KEY, {});
}
function getOpsDefaults(){
  return readOpsStorage(OPS_DEFAULTS_KEY, {});
}
function setOpsDrafts(next){
  writeOpsStorage(OPS_DRAFTS_KEY, next);
}
function setOpsDefaults(next){
  writeOpsStorage(OPS_DEFAULTS_KEY, next);
}
function getFieldValue(id){
  const el = document.getElementById(id);
  if(!el) return '';
  return typeof el.value === 'string' ? el.value.trim() : String(el.value || '').trim();
}
function setFieldValue(id, value){
  const el = document.getElementById(id);
  if(!el || value === undefined || value === null) return;
  el.value = String(value);
}
function buildLineDraft(row){
  const code = row.querySelector('input[name="code"]')?.value.trim() || '';
  const name = row.querySelector('input[name="name"]')?.value.trim() || '';
  const category = row.querySelector('select[name="category"]')?.value.trim() || '';
  const qty = parseInt(row.querySelector('input[name="qty"]')?.value || '0', 10) || 0;
  const sourceId = row.querySelector('input[name="sourceId"]')?.value.trim() || '';
  const sourceType = row.querySelector('input[name="sourceType"]')?.value.trim() || '';
  const jobId = (row.dataset.jobId || '').trim();
  const openQty = Number(row.dataset.openQty || 0) || 0;
  return { code, name, category, qty, sourceId, sourceType, jobId, openQty };
}
function lineDraftHasData(line){
  return !!(line?.code || line?.name || line?.sourceId || line?.jobId || Number(line?.qty || 0) > 1);
}
function collectLineDrafts(prefix){
  return [...document.querySelectorAll(`#${prefix}-lines .line-row`)]
    .map(buildLineDraft)
    .filter(lineDraftHasData);
}
function draftHasMeaningfulData(prefix, draft){
  if(!draft) return false;
  if(Array.isArray(draft.lines) && draft.lines.some(lineDraftHasData)) return true;
  const fields = draft.fields || {};
  return (OPS_MEANINGFUL_DRAFT_FIELDS[prefix] || []).some((id)=> !!fields[id]);
}
function countOpsDrafts(){
  return Object.entries(getOpsDrafts()).filter(([prefix, draft])=> draftHasMeaningfulData(prefix, draft)).length;
}
function updateOpsDraftStamp(message = ''){
  const el = document.getElementById('opsDraftStamp');
  if(!el) return;
  if(message){
    el.textContent = message;
    return;
  }
  const count = countOpsDrafts();
  el.textContent = count ? `${count} draft${count === 1 ? '' : 's'} saved` : 'No draft';
}
function captureOpsDefaults(){
  const next = getOpsDefaults();
  OPS_DEFAULT_FIELDS.forEach((id)=>{
    const value = getFieldValue(id);
    if(value) next[id] = value;
    else delete next[id];
  });
  setOpsDefaults(next);
}
function captureOpsDraft(prefix){
  const drafts = getOpsDrafts();
  const fields = {};
  (OPS_FORM_FIELDS[prefix] || []).forEach((id)=>{
    const value = getFieldValue(id);
    if(value) fields[id] = value;
  });
  const draft = {
    fields,
    lines: collectLineDrafts(prefix),
    updatedAt: Date.now()
  };
  if(draftHasMeaningfulData(prefix, draft)) drafts[prefix] = draft;
  else delete drafts[prefix];
  setOpsDrafts(drafts);
}
function persistOpsState(prefix){
  captureOpsDefaults();
  captureOpsDraft(prefix);
  updateOpsDraftStamp();
}
function clearOpsDraft(prefix){
  const drafts = getOpsDrafts();
  delete drafts[prefix];
  setOpsDrafts(drafts);
  updateOpsDraftStamp();
}
function clearOpsDraftsAndReapply(prefix){
  clearOpsDraft(prefix);
  applyOpsDefaultsForPrefix(prefix);
}
function applyLineDraft(row, prefix, draft = {}){
  const codeInput = row.querySelector('input[name="code"]');
  const nameInput = row.querySelector('input[name="name"]');
  const categorySelect = row.querySelector('select[name="category"]');
  const qtyInput = row.querySelector('input[name="qty"]');
  if(codeInput) codeInput.value = draft.code || '';
  if(nameInput) nameInput.value = draft.name || '';
  if(categorySelect){
    const target = draft.category || '';
    if(target && [...categorySelect.options].some((option)=> option.value === target)) categorySelect.value = target;
  }
  if(qtyInput) qtyInput.value = Number(draft.qty || 0) > 0 ? String(draft.qty) : '1';
  row.dataset.jobId = draft.jobId || '';
  if(prefix === 'checkin'){
    const sourceIdInput = row.querySelector('input[name="sourceId"]');
    const sourceTypeInput = row.querySelector('input[name="sourceType"]');
    if(sourceIdInput) sourceIdInput.value = draft.sourceId || '';
    if(sourceTypeInput) sourceTypeInput.value = draft.sourceType || '';
    if(Number(draft.openQty || 0) > 0) row.dataset.openQty = String(draft.openQty);
    else delete row.dataset.openQty;
    const locked = !!draft.sourceId;
    if(codeInput) codeInput.readOnly = locked;
    if(nameInput) nameInput.readOnly = locked;
  }
}
async function restoreOpsWorkspace(){
  const defaults = getOpsDefaults();
  Object.entries(defaults).forEach(([id, value])=> setFieldValue(id, value));
  const drafts = getOpsDrafts();
  ['checkin', 'checkout', 'return'].forEach((prefix)=>{
    const draft = drafts[prefix];
    if(!draftHasMeaningfulData(prefix, draft)) return;
    const container = document.getElementById(`${prefix}-lines`);
    if(!container) return;
    container.innerHTML = '';
    (draft.lines || []).forEach((line)=> addLine(prefix, line));
    if(prefix !== 'checkin' && !(draft.lines || []).length) addLine(prefix);
    Object.entries(draft.fields || {}).forEach(([id, value])=> setFieldValue(id, value));
    updateLineBadge(prefix);
  });
  refreshCheckoutLocationOptions(getFieldValue('checkout-location') || getOpsDefaults()['checkout-location'] || 'primary');
  const checkoutJobId = getFieldValue('checkout-jobId') || getFieldValue('checkout-upcomingJob');
  await refreshUpcomingMeta(checkoutJobId, { autoLoad: false, force: true });
  updateOpsDraftStamp(countOpsDrafts() ? 'Drafts restored' : 'No draft');
}
function applyOpsDefaultsForPrefix(prefix){
  const defaults = getOpsDefaults();
  const ids = {
    checkin: ['checkin-location'],
    checkout: ['checkout-upcomingJob', 'checkout-jobId', 'checkout-location'],
    return: ['return-jobId', 'return-reason', 'return-location']
  }[prefix] || [];
  ids.forEach((id)=> setFieldValue(id, defaults[id] || ''));
  if(prefix === 'checkout'){
    refreshCheckoutLocationOptions(getFieldValue('checkout-location') || defaults['checkout-location'] || 'primary');
    refreshUpcomingMeta(getFieldValue('checkout-jobId') || getFieldValue('checkout-upcomingJob'), { autoLoad: false, force: true });
  }
  updateOpsDraftStamp();
}
function hasUnsavedOpsDrafts(){
  return countOpsDrafts() > 0;
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
async function loadInventoryLocations(force = false){
  if(inventoryLocationOptions.length && !force) return inventoryLocationOptions;
  const rows = await utils.fetchJsonSafe('/api/inventory-locations', {}, []) || [];
  inventoryLocationOptions = (rows.length ? rows : FALLBACK_LOCATION_OPTIONS).map((row)=>({
    id: row.id || row.ref || row.name,
    name: row.name || row.label || 'Location',
    label: row.label || row.name || 'Location',
    type: row.type || '',
    ref: row.ref || row.id || ''
  }));
  return inventoryLocationOptions;
}
async function loadInventoryEntries(force = false){
  if(inventoryEntriesCache.length && !force) return inventoryEntriesCache;
  inventoryEntriesCache = await utils.fetchJsonSafe('/api/inventory', {}, []) || [];
  return inventoryEntriesCache;
}
function normalizeLocationValue(value){
  return String(value || '').trim().toLowerCase();
}
function resolveInventoryLocationOption(entry){
  const ref = normalizeLocationValue(entry?.locationRef || entry?.locationref || '');
  const rawLocation = normalizeLocationValue(entry?.location || '');
  return inventoryLocationOptions.find((option)=>{
    const optionId = normalizeLocationValue(option.id);
    const optionRef = normalizeLocationValue(option.ref);
    const optionName = normalizeLocationValue(option.name);
    const optionLabel = normalizeLocationValue(option.label);
    return (ref && (optionRef === ref || optionId === ref))
      || (rawLocation && (optionName === rawLocation || optionLabel === rawLocation || optionId === rawLocation));
  }) || null;
}
function getLocationStockDelta(entry){
  const type = String(entry?.type || '').trim().toLowerCase();
  const qty = Number(entry?.qty || 0) || 0;
  if(qty <= 0) return 0;
  if(type === 'in' || type === 'return') return qty;
  if(type === 'out' || type === 'consume') return -qty;
  return 0;
}
function getPickLocationIdsForCode(code){
  const normalizedCode = String(code || '').trim();
  const locationTotals = new Map();
  inventoryEntriesCache.forEach((entry)=>{
    if(String(entry?.code || '').trim() !== normalizedCode) return;
    const option = resolveInventoryLocationOption(entry);
    if(!option) return;
    const delta = getLocationStockDelta(entry);
    if(!delta) return;
    locationTotals.set(option.id, (locationTotals.get(option.id) || 0) + delta);
  });
  return new Set(
    [...locationTotals.entries()]
      .filter(([, qty])=> qty > 0)
      .map(([locationId])=> locationId)
  );
}
function populateInventoryLocationSelect(selectId, preferredId, allowedIds = null){
  const select = document.getElementById(selectId);
  if(!select) return;
  const current = select.value || preferredId || '';
  const hasFilter = Array.isArray(allowedIds);
  const options = hasFilter
    ? inventoryLocationOptions.filter((option)=> allowedIds.includes(option.id))
    : inventoryLocationOptions;
  select.disabled = false;
  select.innerHTML = '<option value="">Select location...</option>';
  if(hasFilter && !options.length){
    select.innerHTML = '<option value="">No matching locations</option>';
    select.disabled = true;
    return;
  }
  options.forEach((option)=>{
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.label || option.name;
    el.dataset.locationName = option.name || option.label || '';
    el.dataset.locationType = option.type || '';
    el.dataset.locationRef = option.ref || '';
    select.appendChild(el);
  });
  const matchByValue = [...select.options].find((option)=> option.value === current);
  const matchByRef = [...select.options].find((option)=> option.dataset.locationRef === current);
  const preferredByValue = [...select.options].find((option)=> option.value === preferredId);
  const preferredByRef = [...select.options].find((option)=> option.dataset.locationRef === preferredId);
  if(matchByValue){
    select.value = matchByValue.value;
  }else if(matchByRef){
    select.value = matchByRef.value;
  }else if(preferredByValue){
    select.value = preferredByValue.value;
  }else if(preferredByRef){
    select.value = preferredByRef.value;
  }else if(select.options.length > 1){
    select.selectedIndex = 1;
  }
}
function getInventoryLocationPayload(selectId){
  const select = document.getElementById(selectId);
  const option = select?.selectedOptions?.[0];
  return {
    location: option?.dataset.locationName || '',
    locationType: option?.dataset.locationType || '',
    locationRef: option?.dataset.locationRef || ''
  };
}
function refreshCheckoutLocationOptions(preferredId = ''){
  const selectedCodes = [...new Set(gatherLines('checkout').map((line)=> line.code).filter(Boolean))];
  const currentSelect = document.getElementById('checkout-location');
  const currentValue = currentSelect?.value || preferredId || 'primary';
  if(!selectedCodes.length){
    populateInventoryLocationSelect('checkout-location', currentValue || 'primary');
    return;
  }
  const locationSets = selectedCodes.map((code)=> getPickLocationIdsForCode(code));
  if(locationSets.some((set)=> !set.size)){
    populateInventoryLocationSelect('checkout-location', '', []);
    return;
  }
  const sharedIds = [...locationSets[0]].filter((locationId)=> locationSets.every((set)=> set.has(locationId)));
  populateInventoryLocationSelect('checkout-location', currentValue, sharedIds);
}
function getOrderBatchId(entry){
  const sourceMeta = entry?.sourceMeta || entry?.sourcemeta || {};
  if(sourceMeta.batchId) return sourceMeta.batchId;
  const tsBucket = Math.floor((Number(entry?.ts || 0) || 0) / 1000);
  const userKey = entry?.userEmail || entry?.useremail || entry?.userName || entry?.username || '';
  const jobKey = normalizeJobId(entry?.jobId || entry?.jobid || '');
  const etaKey = entry?.eta || '';
  const notesKey = entry?.notes || '';
  return `legacy:${userKey}|${jobKey}|${etaKey}|${notesKey}|${tsBucket}`;
}
const CLOSED_JOB_STATUSES = new Set(['complete','completed','closed','archived','cancelled','canceled']);
function parseDateValue(value){
  if(value === undefined || value === null) return null;
  if(typeof value === 'string'){
    const trimmed = value.trim();
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
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function normalizeJobRecord(job){
  if(!job) return null;
  const code = (job.code || '').toString().trim();
  if(!code) return null;
  const startDateRaw = job.startDate || job.startdate || job.scheduleDate || job.scheduledate || '';
  const endDateRaw = job.endDate || job.enddate || '';
  const updatedAtRaw = job.updatedAt || job.updatedat || '';
  return {
    code,
    name: job.name || '',
    startDate: parseDateValue(startDateRaw),
    endDate: parseDateValue(endDateRaw),
    updatedAt: parseDateValue(updatedAtRaw),
    status: (job.status || '').toString().trim().toLowerCase(),
    location: job.location || ''
  };
}
function isJobUpcoming(job, today){
  if(CLOSED_JOB_STATUSES.has(job.status)) return false;
  if(job.endDate && job.endDate.getTime() < today.getTime()) return false;
  return true;
}
function getJobCompletionTs(job){
  if(!job) return null;
  if(job.endDate) return job.endDate.getTime();
  if(job.updatedAt) return job.updatedAt.getTime();
  return null;
}
function isJobReturnEligible(job, today){
  if(!job) return false;
  if(isJobUpcoming(job, today)) return true;
  const completedTs = getJobCompletionTs(job);
  if(!completedTs) return false;
  const graceMs = 5 * 24 * 60 * 60 * 1000;
  return completedTs >= (today.getTime() - graceMs);
}
function jobSortValue(job, today){
  const todayMs = today.getTime();
  if(job.startDate && job.startDate.getTime() < todayMs && (!job.endDate || job.endDate.getTime() >= todayMs)) return todayMs;
  const target = job.startDate || job.endDate;
  return target ? target.getTime() : Number.MAX_SAFE_INTEGER;
}
function jobDateLabel(job){
  if(job.startDate && job.endDate) return `Start ${fmtD(job.startDate)} / End ${fmtD(job.endDate)}`;
  if(job.startDate) return `Start ${fmtD(job.startDate)}`;
  if(job.endDate) return `End ${fmtD(job.endDate)}`;
  return 'No dates';
}
function jobOptionLabel(job){
  const parts = [];
  if(job.name) parts.push(job.name);
  const dateLabel = jobDateLabel(job);
  if(dateLabel) parts.push(dateLabel);
  if(job.status) parts.push(job.status.toUpperCase());
  const suffix = parts.length ? ` - ${parts.join(' | ')}` : '';
  return `${job.code}${suffix}`;
}

function sortUniqueJobIds(values){
  return [...new Set((values || []).map((value)=> normalizeJobId(value)).filter(Boolean))]
    .sort((a, b)=> a.localeCompare(b));
}

// ===== SHARED UTILITIES =====
async function loadItems(){
  allItems = await utils.fetchJsonSafe('/api/items', {}, []) || [];
}

async function loadCategories(){
  categoriesCache = await utils.fetchJsonSafe('/api/categories', {}, []) || [];
  refreshCategorySelects();
}

function refreshCategorySelects(){
  document.querySelectorAll('select[name="category"]').forEach(select=>{
    const list = categoriesCache.length ? categoriesCache : [{ name: DEFAULT_CATEGORY_NAME }];
    const current = select.value;
    select.innerHTML = '';
    list.forEach(cat=>{
      const opt = document.createElement('option');
      opt.value = cat.name;
      opt.textContent = cat.name;
      select.appendChild(opt);
    });
    if(current && list.some(c=> c.name === current)){
      select.value = current;
    }else if(list.length){
      const def = list.find(c=> c.name === DEFAULT_CATEGORY_NAME);
      select.value = def ? def.name : list[0].name;
    }
  });
}
function addItemLocally(item){
  if(!item || !item.code) return;
  const exists = allItems.find(i=> i.code === item.code);
  if(!exists){
    allItems.push(item);
  }
}

async function loadJobOptions(){
  const [jobs, checkouts, returns] = await Promise.all([
    utils.fetchJsonSafe('/api/jobs', {}, []),
    loadCheckouts(),
    loadReturns()
  ]);
  const today = new Date();
  today.setHours(0,0,0,0);
  const records = (jobs || []).map(normalizeJobRecord).filter(Boolean);
  const upcoming = records.filter(job=> isJobUpcoming(job, today));
  const outstandingReturnJobs = getOutstandingCheckouts(checkouts, returns)
    .map((row)=> getEntryJobId(row.entry));
  jobOptions = sortUniqueJobIds(upcoming.map((job)=> job.code));
  returnJobOptions = sortUniqueJobIds(outstandingReturnJobs);
  upcomingJobs = upcoming
    .slice()
    .sort((a,b)=> jobSortValue(a, today) - jobSortValue(b, today) || a.code.localeCompare(b.code));
  applyJobOptions();
  applyUpcomingJobs();
}

function applyJobOptions(){
  const configs = [
    { id: 'checkout-jobId', options: jobOptions },
    { id: 'return-jobId', options: returnJobOptions }
  ];
  configs.forEach(({ id, options })=>{
    const sel = document.getElementById(id);
    if(!sel) return;
    const current = sel.value;
    const isRequired = sel.hasAttribute('required');
    sel.innerHTML = isRequired ? '<option value="">Select job...</option>' : '<option value="">General Inventory</option>';
    options.forEach(job=>{
      const opt=document.createElement('option');
      opt.value=job; opt.textContent=job;
      sel.appendChild(opt);
    });
    if(current && options.includes(current)) sel.value=current;
  });
}

function applyUpcomingJobs(){
  const sel = document.getElementById('checkout-upcomingJob');
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Select upcoming project...</option>';
  upcomingJobs.forEach(job=>{
    const opt = document.createElement('option');
    opt.value = job.code;
    opt.textContent = jobOptionLabel(job);
    sel.appendChild(opt);
  });
  if(current) sel.value=current;
}

function ensureJobOption(jobId){
  const id = (jobId||'').trim();
  if(!id) return;
  if(!jobOptions.includes(id)) return; // only allow known, non-expired jobs
}

function makeSessionId(){
  if(window.crypto?.randomUUID) return crypto.randomUUID();
  return `ops_${Date.now()}_${Math.random().toString(16).slice(2,8)}`;
}

function timerKey(type){
  return `ops.timer.${type}`;
}

function readTimer(type){
  try{
    return JSON.parse(localStorage.getItem(timerKey(type)) || 'null');
  }catch(e){
    return null;
  }
}

function writeTimer(type, state){
  if(state) localStorage.setItem(timerKey(type), JSON.stringify(state));
  else localStorage.removeItem(timerKey(type));
}

function timerLabel(state){
  if(!state || !state.startTs) return 'Not running';
  const mins = Math.max(0, Math.floor((Date.now() - state.startTs) / 60000));
  return mins ? `Running ${mins}m` : 'Running';
}

function updateSyncStamp(label){
  const el = document.getElementById('opsSyncStamp');
  if(el) el.textContent = label || fmtDT(Date.now());
}

function updateLineBadge(prefix){
  const badge = document.getElementById(`${prefix}LineCount`);
  if(!badge) return;
  const container = document.getElementById(`${prefix}-lines`);
  const rowCount = container ? container.querySelectorAll('.line-row').length : 0;
  const lines = gatherLines(prefix);
  const qty = lines.reduce((sum, line)=> sum + (Number(line.qty) || 0), 0);
  if(!rowCount){
    badge.textContent = '0 lines';
  } else if(!lines.length){
    badge.textContent = `${rowCount} line${rowCount === 1 ? '' : 's'}`;
  } else {
    badge.textContent = `${lines.length} line${lines.length === 1 ? '' : 's'} · ${qty} units`;
  }
}

function updateHistoryCount(id, total){
  const badge = document.getElementById(id);
  if(badge) badge.textContent = `${total} row${total === 1 ? '' : 's'}`;
}

function updateOpsModeState(mode){
  const meta = OPS_MODE_META[mode] || OPS_MODE_META.checkout;
  const title = document.getElementById('opsModeTitle');
  const summary = document.getElementById('opsModeSummary');
  const helper = document.getElementById('opsModeHelper');
  const badge = document.getElementById('opsModeBadge');
  if(title) title.textContent = meta.title;
  if(summary) summary.textContent = meta.summary;
  if(helper) helper.textContent = meta.helper;
  if(badge) badge.textContent = meta.badge;
  document.body.dataset.opsMode = mode;
}

function normalizeOpsCopy(){
  const labels = [
    ['#checkin-mode .ops-history-card .ops-section-copy p', "This week's received inventory activity."],
    ['#checkout-mode .ops-history-card .ops-section-copy p', "This week's outbound inventory movement."],
    ['#return-mode .ops-history-card .ops-section-copy p', "This week's stock coming back into inventory."]
  ];
  labels.forEach(([selector, text])=>{
    const el = document.querySelector(selector);
    if(el) el.textContent = text;
  });
}

async function logOpsEvent(type, stage, payload = {}){
  try{
    await fetch('/api/ops-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, stage, ...payload })
    });
  }catch(e){}
}

function getLineSummary(prefix){
  const lines = gatherLines(prefix);
  const qty = lines.reduce((sum, line)=> sum + (Number(line.qty) || 0), 0);
  return { lines: lines.length, qty };
}

function initTimerControls(type, { startBtnId, finishBtnId, valueId, prefix }){
  const startBtn = document.getElementById(startBtnId);
  const finishBtn = document.getElementById(finishBtnId);
  const valueEl = document.getElementById(valueId);
  if(!startBtn || !finishBtn || !valueEl) return;

  const refresh = ()=>{
    const state = readTimer(type);
    valueEl.textContent = timerLabel(state);
    finishBtn.disabled = !state;
    startBtn.disabled = !!state;
  };
  refresh();

  startBtn.addEventListener('click', async ()=>{
    const state = readTimer(type);
    if(state) return;
    const next = { sessionId: makeSessionId(), startTs: Date.now() };
    writeTimer(type, next);
    await logOpsEvent(type, 'start', { sessionId: next.sessionId });
    refresh();
  });
  finishBtn.addEventListener('click', async ()=>{
    const state = readTimer(type);
    if(!state) return;
    const durationMs = Date.now() - state.startTs;
    const summary = getLineSummary(prefix);
    await logOpsEvent(type, 'finish', {
      sessionId: state.sessionId,
      durationMs,
      qty: summary.qty,
      lines: summary.lines
    });
    writeTimer(type, null);
    refresh();
  });

  setInterval(refresh, 60000);
}

function addLine(prefix, preset = null){
  const container = document.getElementById(`${prefix}-lines`);
  if(!container) return;
  const codeId = `${prefix}-code-${uid()}`;
  const nameId = `${prefix}-name-${uid()}`;
  const categoryId = `${prefix}-category-${uid()}`;
  const qtyId = `${prefix}-qty-${uid()}`;
  const suggId = `${codeId}-s`;
  const sourceFields = prefix === 'checkin' ? `<input type="hidden" name="sourceId"><input type="hidden" name="sourceType">` : '';
  const row = document.createElement('div');
  row.className = 'form-row line-row';
  row.innerHTML = `
    <label>Item Code
      <input id="${codeId}" name="code" required placeholder="SKU, part number or barcode">
      <div id="${suggId}" class="suggestions"></div>
    </label>
    <label>Item Name<input id="${nameId}" name="name" placeholder="Enter name if new"></label>
    <label>Category<select id="${categoryId}" name="category"></select></label>
    <label style="max-width:120px;">Qty<input id="${qtyId}" name="qty" type="number" min="1" value="1" required></label>
    <button type="button" class="muted remove-line">Remove</button>
    ${sourceFields}
  `;
  container.appendChild(row);
  refreshCategorySelects();
  row.querySelector('.remove-line').addEventListener('click', ()=>{
    const minLines = prefix === 'checkin' ? 0 : MIN_LINES;
    if(container.querySelectorAll('.line-row').length > minLines){
      row.remove();
      updateLineBadge(prefix);
      if(prefix === 'checkout') refreshCheckoutLocationOptions();
      persistOpsState(prefix);
    }
  });
  utils.attachItemLookup({
    getItems: ()=> allItems,
    codeInputId: codeId,
    nameInputId: nameId,
    categoryInputId: categoryId,
    suggestionsId: suggId
  });
  if(preset) applyLineDraft(row, prefix, preset);
  updateLineBadge(prefix);
  if(prefix === 'checkout') refreshCheckoutLocationOptions();
}

function resetLines(prefix){
  const container = document.getElementById(`${prefix}-lines`);
  if(!container) return;
  container.innerHTML = '';
  if(prefix !== 'checkin') addLine(prefix);
  updateLineBadge(prefix);
}

function gatherLines(prefix){
  const rows=[...document.querySelectorAll(`#${prefix}-lines .line-row`)];
  const items=[];
  rows.forEach(r=>{
    const code = r.querySelector('input[name="code"]')?.value.trim() || '';
    const name = r.querySelector('input[name="name"]')?.value.trim() || '';
    const category = r.querySelector('select[name="category"]')?.value.trim() || '';
    const qty = parseInt(r.querySelector('input[name="qty"]')?.value || '0', 10) || 0;
    if(code && qty>0){
      const sourceId = r.querySelector('input[name="sourceId"]')?.value || '';
      const sourceType = r.querySelector('input[name="sourceType"]')?.value || '';
      const jobId = r.dataset.jobId || '';
      items.push({code,name,category,qty,sourceId,sourceType,jobId});
    }
  });
  return items;
}

function getOutstandingCheckouts(checkouts, returns){
  const map = new Map(); // key -> {qty, last}
  const sum = (list, sign)=>{
    list.forEach(e=>{
      const jobId = getEntryJobId(e);
      const key = `${e.code}|${jobId}`;
      const qty = Number(e.qty)||0;
      if(!map.has(key)) map.set(key,{qty:0,last:0,entry:{...e, jobId}});
      const rec = map.get(key);
      rec.qty += sign*qty;
      if((e.ts||0) > rec.last){ rec.last = e.ts||0; rec.entry = {...e, jobId}; }
    });
  };
  sum(checkouts, 1);
  sum(returns, -1);
  return Array.from(map.entries())
    .filter(([,v])=> v.qty > 0)
    .map(([key,v])=>({key, outstanding:v.qty, entry:v.entry}));
}

function wireSelectAll(tableId){
  const master = document.querySelector(`input[data-select-all="${tableId}"]`);
  if(!master) return;
  master.addEventListener('change', ()=>{
    document.querySelectorAll(`#${tableId} tbody .row-select`).forEach(cb=> cb.checked = master.checked);
  });
}

function fmtDT(val){
  if(window.utils?.formatDateTime) return utils.formatDateTime(val);
  if(!val) return '';
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function fmtD(val){
  if(window.utils?.formatDateOnly) return utils.formatDateOnly(val);
  if(!val) return '';
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { year:'numeric', month:'short', day:'2-digit' });
}
function getCurrentWeekStartTs(){
  const now = new Date();
  const start = new Date(now);
  start.setHours(0,0,0,0);
  start.setDate(start.getDate() - start.getDay());
  return start.getTime();
}
function filterToCurrentWeek(entries){
  const weekStart = getCurrentWeekStartTs();
  return (entries || []).filter(entry=> (Number(entry?.ts || 0) || 0) >= weekStart);
}

async function refreshReturnDropdown(select){
  const checkouts = await loadCheckouts();
  const returns = await loadReturns();
  const outstanding = getOutstandingCheckouts(checkouts, returns);
  const allowedReturnJobs = new Set(returnJobOptions);
  select.innerHTML = '<option value="">-- Manual Entry --</option>';
  outstanding
    .filter(item=>{
      const jobId = getEntryJobId(item.entry);
      return !jobId || allowedReturnJobs.has(jobId);
    })
    .slice(-20)
    .reverse()
    .forEach(item=>{
    const co = item.entry;
    const jobId = getEntryJobId(co);
    const opt = document.createElement('option');
    opt.value = JSON.stringify({...co, jobId, qty: item.outstanding});
    opt.textContent = `${co.code} (Job: ${jobId||FALLBACK}, Qty left: ${item.outstanding})`;
    select.appendChild(opt);
  });
  select.onchange = ()=>{
    if(!select.value) return;
    const co = JSON.parse(select.value);
    const row = document.querySelector('#return-lines .line-row');
    if(row){
      row.querySelector('input[name="code"]').value = co.code;
      row.querySelector('input[name="name"]').value = co.name || '';
      row.querySelector('input[name="qty"]').value = co.qty;
      row.dataset.jobId = (co.jobId || '').trim();
    }
    document.getElementById('return-jobId').value = co.jobId || '';
    document.getElementById('return-reason').value = 'unused';
    persistOpsState('return');
  };
}

// ===== CHECK-IN MODE =====
async function loadCheckins(){
  return await utils.fetchJsonSafe('/api/inventory?type=in', {}, []) || [];
}
async function loadOrders(){
  const rows = await utils.fetchJsonSafe('/api/inventory?type=ordered', {}, []) || [];
  return rows.filter(row=>{
    const status = String(row.status || '').toLowerCase();
    return status !== 'cancelled' && status !== 'canceled';
  });
}

async function loadOpenOrders(){
  const [orders, inventory] = await Promise.all([
    loadOrders(),
    utils.fetchJsonSafe('/api/inventory', {}, [])
  ]);
  const map = new Map();
  (orders||[]).forEach(o=>{
    const sourceId = o.sourceId || o.id;
    const jobId = normalizeJobId(o.jobId || o.jobid || '');
    map.set(sourceId, {
      sourceId,
      sourceType: 'order',
      code: o.code,
      name: o.name || '',
      jobId,
      eta: o.eta || '',
      sourceMeta: o.sourceMeta || o.sourcemeta || {},
      batchId: getOrderBatchId(o),
      ordered: Number(o.qty || 0),
      checkedIn: 0
    });
  });
  (inventory||[]).filter(e=> e.type === 'in' && e.sourceId).forEach(ci=>{
    const sourceId = ci.sourceId;
    if(!map.has(sourceId)) return;
    const rec = map.get(sourceId);
    rec.checkedIn += Number(ci.qty || 0);
  });
  // Fallback: allocate unlinked check-ins by code + project so fully received orders disappear.
  const unlinked = (inventory || []).filter(e=> e.type === 'in' && !e.sourceId);
  unlinked.forEach(ci=>{
    const code = ci.code;
    if(!code) return;
    const jobId = normalizeJobId(ci.jobId || ci.jobid || '');
    let qtyLeft = Number(ci.qty || 0);
    if(qtyLeft <= 0) return;
    const candidates = Array.from(map.values())
      .filter(r=> r.code === code && (r.jobId || '') === (jobId || ''))
      .sort((a,b)=> (a.eta || '').localeCompare(b.eta || '') || (a.sourceId || '').localeCompare(b.sourceId || ''));
    candidates.forEach(rec=>{
      if(qtyLeft <= 0) return;
      const open = Math.max(0, rec.ordered - rec.checkedIn);
      if(open <= 0) return;
      const useQty = Math.min(open, qtyLeft);
      rec.checkedIn += useQty;
      qtyLeft -= useQty;
    });
  });
  openOrders = [];
  openOrdersMap = new Map();
  map.forEach(rec=>{
    const openQty = Math.max(0, rec.ordered - rec.checkedIn);
    if(openQty <= 0) return;
    const row = { ...rec, openQty, batchId: rec.batchId || rec.sourceId };
    openOrders.push(row);
    openOrdersMap.set(rec.sourceId, row);
  });
  openOrders.sort((a,b)=> (a.eta || '').localeCompare(b.eta || '') || a.code.localeCompare(b.code));
  openOrderGroups = [];
  openOrderGroupsMap = new Map();
  openOrders.forEach(order=>{
    const batchId = order.batchId || order.sourceId;
    const existing = openOrderGroupsMap.get(batchId) || {
      batchId,
      lines: [],
      totalQty: 0,
      eta: order.eta || '',
      jobId: order.jobId || '',
      mixedJob: false,
      mixedEta: false
    };
    existing.lines.push(order);
    existing.totalQty += Number(order.openQty || 0);
    if(existing.jobId !== (order.jobId || '')) existing.mixedJob = true;
    if(existing.eta !== (order.eta || '')) existing.mixedEta = true;
    openOrderGroupsMap.set(batchId, existing);
  });
  openOrderGroups = Array.from(openOrderGroupsMap.values()).sort((a,b)=>{
    const aEta = a.eta || '';
    const bEta = b.eta || '';
    if(aEta !== bEta) return aEta.localeCompare(bEta);
    return a.batchId.localeCompare(b.batchId);
  });
  return openOrders;
}

async function renderCheckinTable(){
  const tbody=document.querySelector('#checkinTable tbody');tbody.innerHTML='';
  const entries = filterToCurrentWeek(await loadCheckins());
  updateHistoryCount('checkinHistoryCount', entries.length);
  if(!entries.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="7" style="text-align:center;color:#6b7280;">No check-ins this week</td>`;
    tbody.appendChild(tr);
    wireSelectAll('checkinTable');
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const jobId = getEntryJobId(e);
    const tr=document.createElement('tr');
    tr.innerHTML=`<td><input type="checkbox" class="row-select" data-payload='${JSON.stringify({code:e.code,name:e.name,qty:e.qty,location:e.location,jobId,ts:e.ts})}'></td><td>${e.code}</td><td>${e.name||''}</td><td>${e.qty}</td><td>${e.location||''}</td><td>${jobId||FALLBACK}</td><td>${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
  wireSelectAll('checkinTable');
}

function populateOrderSelect(){
  const sel = document.getElementById('checkin-orderSelect');
  if(!sel) return;
  sel.innerHTML = '<option value="">Select incoming order...</option>';
  if(!openOrders.length){
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No open orders';
    sel.appendChild(opt);
    return;
  }
  openOrderGroups.forEach(group=>{
    const jobLabel = group.mixedJob ? 'Mixed' : (group.jobId || 'General');
    const etaLabel = group.mixedEta ? 'Mixed' : (group.eta || 'N/A');
    const lineLabel = group.lines.length === 1 ? '1 line' : `${group.lines.length} lines`;
    const opt = document.createElement('option');
    opt.value = group.batchId;
    opt.textContent = `${lineLabel} | ${jobLabel} | Open ${group.totalQty} | ETA ${etaLabel}`;
    sel.appendChild(opt);
  });
}

function hasCheckinSourceLine(sourceId){
  return [...document.querySelectorAll('#checkin-lines .line-row input[name="sourceId"]')]
    .some(input=> (input.value || '').trim() === sourceId);
}

function addOrderLine(sourceId){
  const order = openOrdersMap.get(sourceId);
  if(!order) return;
  if(hasCheckinSourceLine(order.sourceId)) return;
  addLine('checkin');
  const container = document.getElementById('checkin-lines');
  const row = container.lastElementChild;
  if(!row) return;
  row.querySelector('input[name="code"]').value = order.code;
  row.querySelector('input[name="name"]').value = order.name || '';
  const meta = allItems.find(i=> i.code === order.code);
  const catSelect = row.querySelector('select[name="category"]');
  if(catSelect) catSelect.value = meta?.category || DEFAULT_CATEGORY_NAME;
  row.querySelector('input[name="qty"]').value = order.openQty;
  row.querySelector('input[name="sourceId"]').value = order.sourceId;
  row.querySelector('input[name="sourceType"]').value = order.sourceType;
  row.dataset.jobId = order.jobId || '';
  row.dataset.openQty = String(order.openQty);
  row.querySelector('input[name="code"]').readOnly = true;
  row.querySelector('input[name="name"]').readOnly = true;
  updateLineBadge('checkin');
}

function addOrderGroup(batchId){
  const group = openOrderGroupsMap.get(batchId);
  if(!group || !group.lines?.length) return;
  const container = document.getElementById('checkin-lines');
  const hasOnlyBlankLine = container
    && container.querySelectorAll('.line-row').length === 1
    && !container.querySelector('.line-row input[name="code"]')?.value.trim()
    && !container.querySelector('.line-row input[name="sourceId"]')?.value.trim();
  if(hasOnlyBlankLine){
    container.innerHTML = '';
  }
  group.lines.forEach(line=> addOrderLine(line.sourceId));
  persistOpsState('checkin');
}

async function addCheckin(e){
  const result = await utils.requestJson('/api/inventory', {
    method: 'POST',
    fallbackError: 'Failed to receive inventory.',
    json: { ...e, type: 'in' }
  });
  if(result.ok){
    await renderCheckinTable();
    return { ok:true, deduped: !!result.data?.deduped };
  }
  return { ok:false, error: result.error || 'Failed to receive inventory.' };
}

async function clearCheckins(){
  try{ await fetch('/api/inventory',{method:'DELETE'}); }catch(e){}
  await renderCheckinTable();
}

function exportCheckinCSV(){
  exportCSV('checkin');
}

// ===== CHECK-OUT MODE =====
async function loadCheckouts(){
  return await utils.fetchJsonSafe('/api/inventory?type=out', {}, []) || [];
}

async function renderCheckoutTable(){
  const tbody=document.querySelector('#checkoutTable tbody');tbody.innerHTML='';
  const entries = filterToCurrentWeek(await loadCheckouts());
  updateHistoryCount('checkoutHistoryCount', entries.length);
  if(!entries.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:#6b7280;">No check-outs this week</td>`;
    tbody.appendChild(tr);
    wireSelectAll('checkoutTable');
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const jobId = getEntryJobId(e);
    const tr=document.createElement('tr');
    tr.innerHTML=`<td><input type="checkbox" class="row-select" data-payload='${JSON.stringify({code:e.code,jobId,qty:e.qty,name:e.name,ts:e.ts})}'></td><td>${e.code}</td><td>${e.name||''}</td><td>${jobId||FALLBACK}</td><td>${e.qty}</td><td class="mobile-hide">${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
  wireSelectAll('checkoutTable');
}

async function addCheckout(e){
  const result = await utils.requestJson('/api/inventory-checkout', {
    method: 'POST',
    fallbackError: 'Failed to check out inventory.',
    json: e
  });
  if(result.ok){
    await renderCheckoutTable();
    return { ok:true, deduped: !!result.data?.deduped };
  }
  return { ok:false, error: result.error || 'Failed to check out inventory.' };
}

async function clearCheckouts(){
  try{ await fetch('/api/inventory-checkout',{method:'DELETE'}); }catch(e){}
  await renderCheckoutTable();
}

function exportCheckoutCSV(){
  exportCSV('checkout');
}
function checkoutLinesHaveData(){
  return [...document.querySelectorAll('#checkout-lines input[name="code"]')]
    .some(input => (input.value || '').trim());
}
function fillCheckoutLines(items, { force } = {}){
  const container = document.getElementById('checkout-lines');
  if(!container) return;
  const hasData = checkoutLinesHaveData();
  if(hasData && !force){
    const ok = confirm('Replace current lines with reserved items for this project?');
    if(!ok) return;
  }
  container.innerHTML = '';
  items.forEach(item=>{
    addLine('checkout');
    const row = container.lastElementChild;
    if(!row) return;
    const meta = allItems.find(i=> i.code === item.code);
    row.querySelector('input[name="code"]').value = item.code;
    row.querySelector('input[name="name"]').value = item.name || meta?.name || '';
    row.querySelector('select[name="category"]').value = meta?.category || DEFAULT_CATEGORY_NAME;
    row.querySelector('input[name="qty"]').value = item.qty;
  });
  updateLineBadge('checkout');
  refreshCheckoutLocationOptions();
  persistOpsState('checkout');
}
async function loadReservedForJob(jobId, { force } = {}){
  if(!jobId) return [];
  if(!force && upcomingReservedCache.jobId === jobId) return upcomingReservedCache.items;
  const entries = await utils.fetchJsonSafe('/api/inventory', {}, []) || [];
  const map = new Map();
  entries.forEach(e=>{
    const type = e.type;
    if(type !== 'reserve' && type !== 'reserve_release') return;
    const entryJobId = normalizeJobId(e.jobId || e.jobid || '');
    if(entryJobId !== jobId) return;
    const code = (e.code || '').trim();
    if(!code) return;
    const qty = Number(e.qty || 0);
    if(!qty) return;
    const delta = type === 'reserve' ? qty : -qty;
    const rec = map.get(code) || { code, name: e.name || '', qty: 0 };
    rec.qty += delta;
    if(!rec.name && e.name) rec.name = e.name;
    map.set(code, rec);
  });
  const items = Array.from(map.values()).filter(i=> i.qty > 0);
  items.forEach(item=>{
    if(!item.name){
      const meta = allItems.find(i=> i.code === item.code);
      item.name = meta?.name || '';
    }
  });
  items.sort((a,b)=> a.code.localeCompare(b.code));
  upcomingReservedCache = { jobId, items };
  return items;
}
async function refreshUpcomingMeta(jobId, { autoLoad, force } = {}){
  const meta = document.getElementById('checkout-upcomingMeta');
  if(!meta) return;
  if(!jobId){
    meta.textContent = 'Choose a project to auto-fill reserved pick lists.';
    return;
  }
  const items = await loadReservedForJob(jobId, { force });
  if(!items.length){
    meta.textContent = 'No reserved items for this project yet. Add lines manually.';
    return;
  }
  const totalQty = items.reduce((sum, item)=> sum + (Number(item.qty) || 0), 0);
  meta.textContent = `${items.length} reserved items ready (${totalQty} units).`;
  if(autoLoad){
    if(!checkoutLinesHaveData() || force){
      fillCheckoutLines(items, { force });
      meta.textContent = `Loaded ${items.length} reserved items (${totalQty} units).`;
    }else{
      meta.textContent += ' Click "Load Reserved Items" to replace current lines.';
    }
  }
}

function buildCheckoutDisplayLines(lines){
  return lines.map(line=>{
    const match = allItems.find(i=> i.code === line.code);
    return {
      code: line.code,
      name: line.name || match?.name || '',
      qty: line.qty
    };
  });
}

function openCheckoutConfirm(lines, jobId, notes){
  const modal = document.getElementById('checkoutConfirmModal');
  const tbody = document.querySelector('#checkoutConfirmTable tbody');
  const summary = document.getElementById('checkoutConfirmSummary');
  if(!modal || !tbody || !summary) return;

  const displayLines = buildCheckoutDisplayLines(lines);
  const totalQty = displayLines.reduce((sum, line)=> sum + (Number(line.qty) || 0), 0);
  const summaryParts = [
    `Project: ${jobId || FALLBACK}`,
    `Lines: ${displayLines.length}`,
    `Units: ${totalQty}`
  ];
  if(notes) summaryParts.push(`Notes: ${notes}`);
  summary.textContent = summaryParts.join(' · ');

  tbody.innerHTML = '';
  displayLines.forEach(line=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${line.code}</td><td>${line.name || ''}</td><td>${line.qty}</td>`;
    tbody.appendChild(tr);
  });

  pendingCheckout = { lines, jobId, notes };
  modal.classList.remove('hidden');
}

function closeCheckoutConfirm(){
  const modal = document.getElementById('checkoutConfirmModal');
  if(modal) modal.classList.add('hidden');
  pendingCheckout = null;
}
function getSelectedPayloads(tableId){
  const rows = document.querySelectorAll(`#${tableId} tbody .row-select:checked`);
  const out = [];
  rows.forEach(cb=>{
    try{
      const data = JSON.parse(cb.dataset.payload || '{}');
      out.push(data);
    }catch(e){}
  });
  return out;
}
function exportSelected(tableId, headers, mapFn, filename){
  const selected = getSelectedPayloads(tableId);
  if(!selected.length){ alert('Select at least one row first'); return; }
  const rows = selected.map(mapFn);
  const csv=[headers.join(','),...rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename || 'export.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ===== RESERVE MODE =====
async function loadReservations(){
  return await utils.fetchJsonSafe('/api/inventory-reserve', {}, []) || [];
}

async function renderReserveTable(){
  const tbody=document.querySelector('#reserveTable tbody');
  if(!tbody) return;
  tbody.innerHTML='';
  const entries = await loadReservations();
  if(!entries.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:#6b7280;">No reservations yet</td>`;
    tbody.appendChild(tr);
    wireSelectAll('reserveTable');
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const tr=document.createElement('tr');
    const returnDate = fmtD(e.returnDate) || FALLBACK;
    tr.innerHTML=`<td><input type="checkbox" class="row-select" data-payload='${JSON.stringify({code:e.code,jobId:e.jobId,qty:e.qty,returnDate:e.returnDate,ts:e.ts})}'></td><td>${e.code}</td><td>${e.jobId}</td><td>${e.qty}</td><td class="mobile-hide">${returnDate}</td><td class="mobile-hide">${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
  wireSelectAll('reserveTable');
}

async function addReservation(e){
  const result = await utils.requestJson('/api/inventory-reserve', {
    method: 'POST',
    fallbackError: 'Failed to reserve inventory.',
    json: e
  });
  if(result.ok){
    await renderReserveTable();
    return { ok:true, deduped: !!result.data?.deduped };
  }
  return { ok:false, error: result.error || 'Failed to reserve inventory.' };
}

async function clearReservations(){
  try{ await fetch('/api/inventory-reserve',{method:'DELETE'}); }catch(e){}
  await renderReserveTable();
}

function exportReserveCSV(){
  exportCSV('reserve');
}

// ===== RETURN MODE =====
async function loadReturns(){
  return await utils.fetchJsonSafe('/api/inventory-return', {}, []) || [];
}

async function renderReturnTable(){
  const tbody=document.querySelector('#returnTable tbody');tbody.innerHTML='';
  const entries = filterToCurrentWeek(await loadReturns());
  updateHistoryCount('returnHistoryCount', entries.length);
  if(!entries.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="7" style="text-align:center;color:#6b7280;">No returns this week</td>`;
    tbody.appendChild(tr);
    wireSelectAll('returnTable');
    return;
  }
  entries.slice().reverse().forEach(e=>{
    const jobId = getEntryJobId(e);
    const tr=document.createElement('tr');
    tr.innerHTML=`<td><input type="checkbox" class="row-select" data-payload='${JSON.stringify({code:e.code,qty:e.qty,jobId,reason:e.reason,location:e.location,ts:e.ts})}'></td><td>${e.code}</td><td>${e.qty}</td><td>${jobId||FALLBACK}</td><td>${e.reason||FALLBACK}</td><td class="mobile-hide">${e.location||FALLBACK}</td><td class="mobile-hide">${fmtDT(e.ts)}</td>`;
    tbody.appendChild(tr);
  });
  wireSelectAll('returnTable');
}

function setMetric(id,val){
  const el = document.getElementById(id);
  if(el) el.textContent = val ?? '-';
}

async function updateOpsMetrics(){
  const metrics = await utils.fetchJsonSafe('/api/metrics', {}, {});
  if(metrics){
    setMetric('ops-available', metrics.availableUnits);
    setMetric('ops-reserved', metrics.reservedUnits);
    setMetric('ops-out', metrics.txLast7 ?? '—');
  }
  const checkouts = await loadCheckouts();
  const returns = await loadReturns();
  const outstanding = getOutstandingCheckouts(checkouts, returns);
  setMetric('ops-due', outstanding.length);
}

async function addReturn(e){
  const result = await utils.requestJson('/api/inventory-return', {
    method: 'POST',
    fallbackError: 'Failed to return inventory.',
    json: e
  });
  if(result.ok){
    await renderReturnTable();
    return { ok:true, deduped: !!result.data?.deduped };
  }
  return { ok:false, error: result.error || 'Failed to return inventory.' };
}

async function clearReturns(){
  try{ await fetch('/api/inventory-return',{method:'DELETE'}); }catch(e){}
  await renderReturnTable();
}

function exportReturnCSV(){
  exportCSV('return');
}

// ===== EXPORT CSV HELPER =====
async function exportCSV(mode){
  let entries = [];
  let hdr = [];
  let filename = '';
  
  if(mode === 'checkin'){
    entries = await loadCheckins();
    hdr = ['code','name','qty','location','jobId','timestamp'];
    filename = 'checkin.csv';
  }else if(mode === 'checkout'){
    entries = await loadCheckouts();
    hdr = ['code','jobId','qty','timestamp'];
    filename = 'checkout.csv';
  }else if(mode === 'reserve'){
    entries = await loadReservations();
    hdr = ['code','jobId','qty','returnDate','timestamp'];
    filename = 'reservations.csv';
  }else if(mode === 'return'){
    entries = await loadReturns();
    hdr = ['code','qty','jobId','reason','location','timestamp'];
    filename = 'returns.csv';
  }
  
  if(!entries.length){alert(`No ${mode} entries to export`);return}
  
  let rows;
  if(mode === 'checkin'){
    rows = entries.map(r=>[r.code,r.name,r.qty,r.location,getEntryJobId(r),new Date(r.ts).toISOString()]);
  }else if(mode === 'checkout'){
    rows = entries.map(r=>[r.code,r.jobId,r.qty,new Date(r.ts).toISOString()]);
  }else if(mode === 'reserve'){
    rows = entries.map(r=>[r.code,r.jobId,r.qty,r.returnDate||'',new Date(r.ts).toISOString()]);
  }else if(mode === 'return'){
    rows = entries.map(r=>[r.code,r.qty,r.jobId,r.reason,r.location,new Date(r.ts).toISOString()]);
  }
  
  const csv=[hdr.join(','),...rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ===== MODE SWITCHING =====
function switchMode(mode){
  // Hide all modes
  ['checkin','checkout','reserve','return'].forEach(m=>{
    const el = document.getElementById(`${m}-mode`);
    if(el) el.classList.remove('active');
  });
  
  // Remove active from all buttons
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));

  // Show selected mode
  const target = document.getElementById(`${mode}-mode`);
  if(target) target.classList.add('active');
  const btn = document.querySelector(`[data-mode="${mode}"]`);
  if(btn) btn.classList.add('active');
  updateOpsModeState(mode);
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  window.history.replaceState({}, '', url);
}

async function refreshOperationsWorkspace(){
  if(opsRefreshInFlight) return opsRefreshInFlight;
  const refreshBtn = document.getElementById('opsRefreshBtn');
  opsRefreshInFlight = (async ()=>{
    try{
      if(refreshBtn){
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Refreshing...';
      }
      await loadItems();
      await loadInventoryEntries(true);
      await loadInventoryLocations();
      await loadCategories();
      await loadJobOptions();
      await loadOpenOrders();
      populateInventoryLocationSelect('checkin-location', 'main');
      populateInventoryLocationSelect('checkout-location', 'primary');
      populateInventoryLocationSelect('return-location', 'main');
      refreshCheckoutLocationOptions('primary');
      populateOrderSelect();
      await updateOpsMetrics();
      await renderCheckinTable();
      await renderCheckoutTable();
      await renderReserveTable();
      await renderReturnTable();
      const returnSelect = document.getElementById('return-fromCheckout');
      if(returnSelect) await refreshReturnDropdown(returnSelect);
      ['checkin', 'checkout', 'return'].forEach(updateLineBadge);
      updateSyncStamp(fmtDT(Date.now()));
      updateOpsDraftStamp();
    }finally{
      if(refreshBtn){
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';
      }
      opsRefreshInFlight = null;
    }
  })();
  return opsRefreshInFlight;
}

// ===== DOM READY =====
document.addEventListener('DOMContentLoaded', async ()=>{
  const initialMode = new URLSearchParams(window.location.search).get('mode') || 'checkout';
  if(window.utils && utils.setupLogout) utils.setupLogout();
  normalizeOpsCopy();
  // adjust available modes based on DOM
  const availableModes = ['checkin','checkout','return'].filter(m=> document.getElementById(`${m}-mode`));
  // Initialize line items
  resetLines('checkin');
  resetLines('checkout');
  resetLines('return');
  ['checkin','checkout','return'].forEach(prefix=>{
    const btn = document.getElementById(`${prefix}-addLine`);
    if(btn) btn.addEventListener('click', ()=> addLine(prefix));
    document.getElementById(`${prefix}-lines`)?.addEventListener('input', ()=>{
      updateLineBadge(prefix);
      if(prefix === 'checkout') refreshCheckoutLocationOptions();
      persistOpsState(prefix);
    });
    document.getElementById(`${prefix}-lines`)?.addEventListener('change', ()=>{
      updateLineBadge(prefix);
      if(prefix === 'checkout') refreshCheckoutLocationOptions();
      persistOpsState(prefix);
    });
    const form = document.getElementById(`${prefix}Form`);
    form?.addEventListener('input', ()=> persistOpsState(prefix));
    form?.addEventListener('change', ()=> persistOpsState(prefix));
  });
  switchMode(availableModes.includes(initialMode) ? initialMode : 'checkout');
  initTimerControls('checkin', { startBtnId: 'checkinStartBtn', finishBtnId: 'checkinFinishBtn', valueId: 'checkinTimerValue', prefix: 'checkin' });
  initTimerControls('pick', { startBtnId: 'pickStartBtn', finishBtnId: 'pickFinishBtn', valueId: 'pickTimerValue', prefix: 'checkout' });
  document.getElementById('opsRefreshBtn')?.addEventListener('click', refreshOperationsWorkspace);
  await refreshOperationsWorkspace();
  await restoreOpsWorkspace();
  captureOpsDefaults();
  updateOpsDraftStamp();
  window.addEventListener('beforeunload', (event)=>{
    if(!hasUnsavedOpsDrafts()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  const upcomingSelect = document.getElementById('checkout-upcomingJob');
  const upcomingLoadBtn = document.getElementById('checkout-loadReserved');
  const checkoutJobSelect = document.getElementById('checkout-jobId');
  if(upcomingSelect){
    upcomingSelect.addEventListener('change', async ()=>{
      const jobId = upcomingSelect.value.trim();
      if(checkoutJobSelect) checkoutJobSelect.value = jobId;
      await refreshUpcomingMeta(jobId, { autoLoad: true });
      persistOpsState('checkout');
    });
  }
  if(upcomingLoadBtn){
    upcomingLoadBtn.addEventListener('click', async ()=>{
      const jobId = (upcomingSelect?.value || checkoutJobSelect?.value || '').trim();
      if(!jobId){ alert('Select a project first'); return; }
      if(checkoutJobSelect) checkoutJobSelect.value = jobId;
      await refreshUpcomingMeta(jobId, { autoLoad: true, force: true });
      persistOpsState('checkout');
    });
  }
  if(checkoutJobSelect && upcomingSelect){
    checkoutJobSelect.addEventListener('change', async ()=>{
      const jobId = checkoutJobSelect.value.trim();
      const hasOption = !!upcomingSelect.querySelector(`option[value="${jobId}"]`);
      upcomingSelect.value = hasOption ? jobId : '';
      await refreshUpcomingMeta(jobId, { autoLoad: false, force: true });
      persistOpsState('checkout');
    });
  }

  const addOrderBtn = document.getElementById('checkin-addOrderBtn');
  if(addOrderBtn){
    addOrderBtn.addEventListener('click', ()=>{
      const sel = document.getElementById('checkin-orderSelect');
      if(!sel || !sel.value) return;
      addOrderGroup(sel.value);
      sel.value = '';
      updateLineBadge('checkin');
      persistOpsState('checkin');
    });
  }
  const refreshOrdersBtn = document.getElementById('checkin-refreshOrders');
  if(refreshOrdersBtn){
    refreshOrdersBtn.addEventListener('click', async ()=>{
      await loadOpenOrders();
      populateOrderSelect();
      updateSyncStamp(fmtDT(Date.now()));
    });
  }

  // Mode switching
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', async ()=>{
      switchMode(btn.dataset.mode);
      // Auto-load checkouts when switching to return mode
      if(btn.dataset.mode === 'return'){
        const select = document.getElementById('return-fromCheckout');
        await refreshReturnDropdown(select);
      }
    });
  });

  // Export selected buttons
  const checkinSelBtn = document.getElementById('checkin-export-selected');
  if(checkinSelBtn){
    checkinSelBtn.addEventListener('click', ()=>{
      exportSelected('checkinTable', ['code','name','qty','location','jobId','timestamp'], r=>[r.code,r.name||'',r.qty||'',r.location||'',r.jobId||'', r.ts ? new Date(r.ts).toISOString() : ''], 'checkin-selected.csv');
    });
  }
  const checkoutSelBtn = document.getElementById('checkout-export-selected');
  if(checkoutSelBtn){
    checkoutSelBtn.addEventListener('click', ()=>{
      exportSelected('checkoutTable', ['code','jobId','qty','timestamp'], r=>[r.code,r.jobId||'',r.qty||'', r.ts ? new Date(r.ts).toISOString() : ''], 'checkout-selected.csv');
    });
  }
  const returnSelBtn = document.getElementById('return-export-selected');
  if(returnSelBtn){
    returnSelBtn.addEventListener('click', ()=>{
      exportSelected('returnTable', ['code','qty','jobId','reason','location','timestamp'], r=>[r.code,r.qty||'',r.jobId||'',r.reason||'',r.location||'', r.ts ? new Date(r.ts).toISOString() : ''], 'return-selected.csv');
    });
  }

  // ===== RETURN CHECKOUT LOADER (manual refresh option) =====
  const returnLoadBtn = document.getElementById('return-loadCheckoutBtn');
  if(returnLoadBtn){
    returnLoadBtn.addEventListener('click', async ()=>{
      const select = document.getElementById('return-fromCheckout');
      const checkouts = await loadCheckouts();
      if(!checkouts.length){alert('No recent checkouts found'); return}
      await refreshReturnDropdown(select);
      if(select.options.length <= 1){alert('No available checkouts (all have been returned)');}
    });
  }
  
  // ===== CHECK-IN FORM =====
  const checkinForm = document.getElementById('checkinForm');
  checkinForm.addEventListener('submit', async ev=>{
    ev.preventDefault();
    const submitBtn = document.getElementById('checkinBtn');
    const lines = gatherLines('checkin');
    const locationPayload = getInventoryLocationPayload('checkin-location');
    const notes = document.getElementById('checkin-notes').value.trim();
    const user = getSessionUser();
    setOpsFormMessage('checkinMsg');
    if(!lines.length){ setOpsFormMessage('checkinMsg', 'Add at least one incoming order line before receiving.', 'error'); return; }
    const missingSource = lines.find(l=> !l.sourceId || !l.sourceType);
    if(missingSource){ setOpsFormMessage('checkinMsg', 'Each check-in line must be linked to an incoming order.', 'error'); return; }
    const overLimit = [...document.querySelectorAll('#checkin-lines .line-row')].find(row=>{
      const qty = parseInt(row.querySelector('input[name="qty"]')?.value || '0', 10) || 0;
      const open = Number(row.dataset.openQty || 0);
      return open > 0 && qty > open;
    });
    if(overLimit){ setOpsFormMessage('checkinMsg', 'Check-in quantity exceeds the remaining open order quantity.', 'error'); return; }
    const batchKey = getStableRequestBatchKey('checkinForm', 'ops-checkin');
    if(submitBtn){
      submitBtn.disabled = true;
      submitBtn.textContent = 'Receiving...';
    }
    let okAll=true;
    const errors = [];
    let dedupedCount = 0;
    try{
      for(let index = 0; index < lines.length; index += 1){
        const line = lines[index];
        const result = await addCheckin({
          code: line.code,
          name: line.name,
          qty: line.qty,
          ...locationPayload,
          jobId: line.jobId,
          notes,
          ts: Date.now(),
          userEmail: user?.email,
          userName: user?.name,
          category: line.category,
          sourceType: line.sourceType,
          sourceId: line.sourceId,
          requestKey: buildLineRequestKey(batchKey, index)
        });
        if(result.ok){
          if(result.deduped) dedupedCount += 1;
          addItemLocally({code: line.code, name: line.name, category: line.category});
        }else{
          okAll = false;
          if(result.error) errors.push(`${line.code}: ${result.error}`);
        }
      }
      if(!okAll){
        setOpsFormMessage('checkinMsg', errors.join(' ') || 'Some items failed to check in.', 'error');
        return;
      }
      checkinForm.reset();
      clearStableRequestBatchKey('checkinForm');
      resetLines('checkin');
      clearOpsDraft('checkin');
      applyOpsDefaultsForPrefix('checkin');
      await loadOpenOrders();
      populateOrderSelect();
      await loadInventoryEntries(true);
      refreshCheckoutLocationOptions();
      await updateOpsMetrics();
      updateSyncStamp(fmtDT(Date.now()));
      setOpsFormMessage(
        'checkinMsg',
        dedupedCount
          ? `Receive saved. ${dedupedCount} line${dedupedCount === 1 ? '' : 's'} were already logged and were not duplicated.`
          : 'Inventory received successfully.',
        'ok'
      );
    }finally{
      if(submitBtn){
        submitBtn.disabled = false;
        submitBtn.textContent = 'Receive to Inventory';
      }
    }
  });
  
  document.getElementById('checkin-clearBtn').addEventListener('click', async ()=>{
    if(confirm('Clear all check-in entries?')){
      clearStableRequestBatchKey('checkinForm');
      setOpsFormMessage('checkinMsg');
      await clearCheckins();
    }
  });
  document.getElementById('checkin-exportBtn').addEventListener('click', exportCheckinCSV);
  
  // ===== CHECK-OUT FORM =====
  const checkoutForm = document.getElementById('checkoutForm');
  const executeCheckout = async (lines, jobId, notes)=>{
    const user = getSessionUser();
    const locationPayload = getInventoryLocationPayload('checkout-location');
    let okAll=true;
    const errors=[];
    let dedupedCount = 0;
    const batchKey = getStableRequestBatchKey('checkoutForm', 'ops-checkout');
    for(let index = 0; index < lines.length; index += 1){
      const line = lines[index];
      const res = await addCheckout({
        code: line.code,
        jobId,
        qty: line.qty,
        ...locationPayload,
        notes,
        ts: Date.now(),
        type: 'out',
        userEmail: user?.email,
        userName: user?.name,
        requestKey: buildLineRequestKey(batchKey, index)
      });
      if(!res.ok){
        okAll=false;
        if(res.error) errors.push(`${line.code}: ${res.error}`);
      }else if(res.deduped){
        dedupedCount += 1;
      }
    }
    if(!okAll){
      setOpsFormMessage('checkoutMsg', errors.join(' ') || 'Some items failed to check out.', 'error');
      return false;
    }
    checkoutForm.reset();
    clearStableRequestBatchKey('checkoutForm');
    resetLines('checkout');
    clearOpsDraft('checkout');
    applyOpsDefaultsForPrefix('checkout');
    ensureJobOption(jobId);
    await loadInventoryEntries(true);
    refreshCheckoutLocationOptions();
    await updateOpsMetrics();
    updateSyncStamp(fmtDT(Date.now()));
    setOpsFormMessage(
      'checkoutMsg',
      dedupedCount
        ? `Pick saved. ${dedupedCount} line${dedupedCount === 1 ? '' : 's'} were already logged and were not duplicated.`
        : 'Inventory checked out successfully.',
      'ok'
    );
    return okAll;
  };

  checkoutForm.addEventListener('submit', async ev=>{
    ev.preventDefault();
    setOpsFormMessage('checkoutMsg');
    const lines = gatherLines('checkout');
    const jobId = document.getElementById('checkout-jobId').value.trim();
    const notes = document.getElementById('checkout-notes').value.trim();
    
    if(!jobId){ setOpsFormMessage('checkoutMsg', 'Project ID is required.', 'error'); return; }
    if(!lines.length){ setOpsFormMessage('checkoutMsg', 'Add at least one line with code and quantity.', 'error'); return; }
    const missing = lines.find(l=> !allItems.find(i=> i.code === l.code));
    if(missing){ setOpsFormMessage('checkoutMsg', `Item ${missing.code} does not exist. Receive it first or add it through receiving.`, 'error'); return; }
    
    openCheckoutConfirm(lines, jobId, notes);
  });

  const checkoutConfirmClose = document.getElementById('checkoutConfirmClose');
  const checkoutConfirmCancel = document.getElementById('checkoutConfirmCancel');
  const checkoutConfirmAction = document.getElementById('checkoutConfirmAction');
  checkoutConfirmClose?.addEventListener('click', closeCheckoutConfirm);
  checkoutConfirmCancel?.addEventListener('click', closeCheckoutConfirm);
  checkoutConfirmAction?.addEventListener('click', async ()=>{
    if(!pendingCheckout) return;
    checkoutConfirmAction.disabled = true;
    const ok = await executeCheckout(pendingCheckout.lines, pendingCheckout.jobId, pendingCheckout.notes);
    checkoutConfirmAction.disabled = false;
    if(ok) closeCheckoutConfirm();
  });
  
  document.getElementById('checkout-clearBtn').addEventListener('click', async ()=>{
    if(confirm('Clear all check-out entries?')){
      clearStableRequestBatchKey('checkoutForm');
      setOpsFormMessage('checkoutMsg');
      await clearCheckouts();
    }
  });
  document.getElementById('checkout-exportBtn').addEventListener('click', exportCheckoutCSV);
  const devBtn = document.getElementById('devResetBtn');
  const sessionDev = utils.getSession?.();
  if(devBtn && sessionDev && sessionDev.email === 'dev@example.com'){
    devBtn.style.display = 'inline-block';
    devBtn.addEventListener('click', async ()=>{
      const token = prompt('Enter dev reset token to TRUNCATE all data. This is destructive.');
      if(!token) return;
      if(!confirm('Are you sure? This clears all data.')) return;
      const res = await fetch('/api/dev/reset',{method:'POST',headers:{'Content-Type':'application/json','x-dev-reset':token}});
      if(res.ok){ alert('Reset complete. Reloading.'); window.location.reload(); }
      else{
        const data = await res.json().catch(()=>({error:'Reset failed'}));
        alert(data.error || 'Reset failed');
      }
    });
  }
  
  // ===== RESERVE FORM (if present) =====
  const reserveForm = document.getElementById('reserveForm');
  if(reserveForm){
    reserveForm.addEventListener('submit', async ev=>{
      ev.preventDefault();
      const reserveMsgEl = document.getElementById('reserveMsg');
      const reserveBtn = document.getElementById('reserveBtn');
      const lines = gatherLines('reserve');
      const jobId = document.getElementById('reserve-jobId').value.trim();
      const returnDate = document.getElementById('reserve-returnDate').value;
      const notes = document.getElementById('reserve-notes').value.trim();
      const user = getSessionUser();
      const locationPayload = getInventoryLocationPayload('checkout-location');
      
      if(reserveMsgEl){ reserveMsgEl.className = 'field-hint'; reserveMsgEl.textContent = ''; }
      if(!jobId){ if(reserveMsgEl){ reserveMsgEl.className = 'field-hint error'; reserveMsgEl.textContent = 'Project ID is required.'; } return; }
      if(!lines.length){ if(reserveMsgEl){ reserveMsgEl.className = 'field-hint error'; reserveMsgEl.textContent = 'Add at least one line with code and quantity.'; } return; }
      const missing = lines.find(l=> !allItems.find(i=> i.code === l.code));
      if(missing){ if(reserveMsgEl){ reserveMsgEl.className = 'field-hint error'; reserveMsgEl.textContent = `Item ${missing.code} does not exist. Receive it first or add it through receiving.`; } return; }
      
      const batchKey = getStableRequestBatchKey('reserveForm', 'ops-reserve');
      if(reserveBtn){
        reserveBtn.disabled = true;
        reserveBtn.textContent = 'Reserving...';
      }
      let okAll=true;
      const errors = [];
      let dedupedCount = 0;
      try{
        for(let index = 0; index < lines.length; index += 1){
          const line = lines[index];
          const result = await addReservation({
            code: line.code,
            jobId,
            qty: line.qty,
            ...locationPayload,
            returnDate,
            notes,
            ts: Date.now(),
            type: 'reserve',
            userEmail: user?.email,
            userName: user?.name,
            requestKey: buildLineRequestKey(batchKey, index)
          });
          if(!result.ok){
            okAll = false;
            if(result.error) errors.push(`${line.code}: ${result.error}`);
          }else if(result.deduped){
            dedupedCount += 1;
          }
        }
        if(!okAll){
          if(reserveMsgEl){ reserveMsgEl.className = 'field-hint error'; reserveMsgEl.textContent = errors.join(' ') || 'Some items failed to reserve.'; }
          return;
        }
        reserveForm.reset();
        clearStableRequestBatchKey('reserveForm');
        resetLines('reserve');
        ensureJobOption(jobId);
        await loadInventoryEntries(true);
        refreshCheckoutLocationOptions();
        await updateOpsMetrics();
        if(reserveMsgEl){
          reserveMsgEl.className = 'field-hint ok';
          reserveMsgEl.textContent = dedupedCount
            ? `Reservation saved. ${dedupedCount} line${dedupedCount === 1 ? '' : 's'} were already reserved and were not duplicated.`
            : 'Inventory reserved successfully.';
        }
      }finally{
        if(reserveBtn){
          reserveBtn.disabled = false;
          reserveBtn.textContent = 'Reserve';
        }
      }
    });
    
    const reserveClearBtn = document.getElementById('reserve-clearBtn');
    reserveClearBtn?.addEventListener('click', async ()=>{
      if(confirm('Clear all reservations?')){
        clearStableRequestBatchKey('reserveForm');
        const reserveMsgEl = document.getElementById('reserveMsg');
        if(reserveMsgEl){
          reserveMsgEl.className = 'field-hint';
          reserveMsgEl.textContent = '';
        }
        await clearReservations();
      }
    });
    document.getElementById('reserve-exportBtn')?.addEventListener('click', exportReserveCSV);
  }
  
  // ===== RETURN FORM =====
  const returnForm = document.getElementById('returnForm');
  if(returnForm){
    returnForm.addEventListener('submit', async ev=>{
      ev.preventDefault();
      const returnBtn = document.getElementById('returnBtn');
      const jobId = document.getElementById('return-jobId').value.trim();
      const reason = document.getElementById('return-reason').value.trim();
      const locationPayload = getInventoryLocationPayload('return-location');
      const notes = document.getElementById('return-notes').value.trim();
      const user = getSessionUser();
      
      const lines = gatherLines('return');
      setOpsFormMessage('returnMsg');
      if(!lines.length){ setOpsFormMessage('returnMsg', 'Add at least one line with code and quantity.', 'error'); return; }
      if(!reason){ setOpsFormMessage('returnMsg', 'Return reason is required.', 'error'); return; }
      const missing = lines.find(l=> !allItems.find(i=> i.code === l.code));
      if(missing){ setOpsFormMessage('returnMsg', `Item ${missing.code} does not exist. Receive it first before returning it.`, 'error'); return; }
      
      const batchKey = getStableRequestBatchKey('returnForm', 'ops-return');
      if(returnBtn){
        returnBtn.disabled = true;
        returnBtn.textContent = 'Returning...';
      }
      let okAll=true;
      const errors=[];
      let dedupedCount = 0;
      try{
        for(let index = 0; index < lines.length; index += 1){
          const line = lines[index];
          const lineJobId = line.jobId || jobId;
          const res = await addReturn({
            code: line.code,
            jobId: lineJobId,
            qty: line.qty,
            reason,
            ...locationPayload,
            notes,
            ts: Date.now(),
            type: 'return',
            userEmail: user?.email,
            userName: user?.name,
            requestKey: buildLineRequestKey(batchKey, index)
          });
          if(!res.ok){
            okAll=false;
            if(res.error) errors.push(`${line.code}: ${res.error}`);
          }else if(res.deduped){
            dedupedCount += 1;
          }
        }
        if(!okAll){
          setOpsFormMessage('returnMsg', errors.join(' ') || 'Some items failed to return.', 'error');
          return;
        }
        returnForm.reset();
        clearStableRequestBatchKey('returnForm');
        resetLines('return');
        clearOpsDraft('return');
        applyOpsDefaultsForPrefix('return');
        const select = document.getElementById('return-fromCheckout');
        if(select) await refreshReturnDropdown(select);
        ensureJobOption(jobId);
        await loadInventoryEntries(true);
        refreshCheckoutLocationOptions();
        await updateOpsMetrics();
        updateSyncStamp(fmtDT(Date.now()));
        setOpsFormMessage(
          'returnMsg',
          dedupedCount
            ? `Return saved. ${dedupedCount} line${dedupedCount === 1 ? '' : 's'} were already returned and were not duplicated.`
            : 'Inventory returned successfully.',
          'ok'
        );
      }finally{
        if(returnBtn){
          returnBtn.disabled = false;
          returnBtn.textContent = 'Return to Inventory';
        }
      }
    });
  }
  
  const returnClearBtn = document.getElementById('return-clearBtn');
  if(returnClearBtn){
    returnClearBtn.addEventListener('click', async ()=>{
      if(confirm('Clear all returns?')){
        clearStableRequestBatchKey('returnForm');
        setOpsFormMessage('returnMsg');
        await clearReturns();
      }
    });
  }
  
  const returnExportBtn = document.getElementById('return-exportBtn');
  if(returnExportBtn){
    returnExportBtn.addEventListener('click', exportReturnCSV);
  }
});
