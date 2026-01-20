const FALLBACK = '—';

let equipmentRows = [];
let vehicleRows = [];
let activeTab = 'equipment';

function fmtDate(value){
  if(!value) return FALLBACK;
  const num = Number(value);
  const date = Number.isFinite(num) ? new Date(num) : new Date(value);
  if(Number.isNaN(date.getTime())) return FALLBACK;
  return date.toLocaleDateString([], { year:'numeric', month:'short', day:'2-digit' });
}

function fmtNumber(value){
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString() : FALLBACK;
}

function normalizeTags(tags){
  if(!tags) return [];
  if(Array.isArray(tags)) return tags.filter(Boolean);
  try{
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  }catch(e){
    return tags.toString().split(/[,;|]/).map(t=>t.trim()).filter(Boolean);
  }
}

function filterRows(rows, search){
  if(!search) return rows;
  const term = search.toLowerCase();
  return rows.filter(row=>{
    const hay = [
      row.code,
      row.name,
      row.category,
      row.location,
      row.status,
      row.assignedproject || row.assignedProject,
      row.plate,
      row.make,
      row.model
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(term);
  });
}

function setTab(tab){
  activeTab = tab;
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('equipmentSection').style.display = tab === 'equipment' ? '' : 'none';
  document.getElementById('vehicleSection').style.display = tab === 'vehicles' ? '' : 'none';
  renderTables();
}

function renderTables(){
  const search = document.getElementById('fleetSearch')?.value.trim() || '';
  renderEquipment(filterRows(equipmentRows, search));
  renderVehicles(filterRows(vehicleRows, search));
}

function renderEquipment(rows){
  const tbody = document.getElementById('equipmentTableBody');
  if(!tbody) return;
  tbody.innerHTML = '';
  if(!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="8" style="text-align:center;color:#6b7280;">No equipment found</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.forEach(item=>{
    const tr = document.createElement('tr');
    tr.className = 'fleet-row';
    tr.dataset.type = 'equipment';
    tr.dataset.id = item.id;
    tr.innerHTML = `
      <td>${item.code || FALLBACK}</td>
      <td>${item.name || FALLBACK}</td>
      <td>${item.category || FALLBACK}</td>
      <td>${item.location || FALLBACK}</td>
      <td>${item.status || 'Active'}</td>
      <td>${fmtNumber(item.usagehours || item.usageHours)}</td>
      <td>${fmtDate(item.lastserviceat || item.lastServiceAt)}</td>
      <td>${fmtDate(item.lastactivityat || item.lastActivityAt)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderVehicles(rows){
  const tbody = document.getElementById('vehicleTableBody');
  if(!tbody) return;
  tbody.innerHTML = '';
  if(!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="8" style="text-align:center;color:#6b7280;">No vehicles found</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.forEach(item=>{
    const make = [item.make, item.model].filter(Boolean).join(' ') || FALLBACK;
    const tr = document.createElement('tr');
    tr.className = 'fleet-row';
    tr.dataset.type = 'vehicle';
    tr.dataset.id = item.id;
    tr.innerHTML = `
      <td>${item.code || FALLBACK}</td>
      <td>${make}</td>
      <td>${item.plate || FALLBACK}</td>
      <td>${item.location || FALLBACK}</td>
      <td>${item.status || 'Active'}</td>
      <td>${fmtNumber(item.mileage)}</td>
      <td>${fmtDate(item.lastserviceat || item.lastServiceAt)}</td>
      <td>${fmtDate(item.lastactivityat || item.lastActivityAt)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function findItem(type, id){
  const list = type === 'vehicle' ? vehicleRows : equipmentRows;
  return list.find(row=> row.id === id) || null;
}

function buildTags(tags){
  const list = normalizeTags(tags);
  if(!list.length) return '<span class="badge static">No tags</span>';
  return list.map(tag=>`<span class="badge static">${tag}</span>`).join('');
}

function renderDrawer(type, item){
  const panel = document.getElementById('fleetPanel');
  if(!panel || !item) return;
  const kicker = document.getElementById('fleetPanelKicker');
  const title = document.getElementById('fleetPanelTitle');
  const tags = document.getElementById('fleetPanelTags');
  const sub = document.getElementById('fleetPanelSub');
  const body = document.getElementById('fleetPanelBody');

  const isVehicle = type === 'vehicle';
  const name = item.name || item.code || 'Asset';
  const category = item.category || (isVehicle ? 'Vehicle' : 'Equipment');
  const location = item.location || FALLBACK;
  const status = item.status || 'Active';
  const assignedProject = item.assignedproject || item.assignedProject || FALLBACK;

  if(kicker) kicker.textContent = isVehicle ? 'Vehicle' : 'Equipment';
  if(title) title.textContent = name;
  if(tags) tags.innerHTML = buildTags(item.tags);
  if(sub) sub.textContent = `${category} • ${location} • ${status}`;

  const staticRows = [
    ['Code', item.code || FALLBACK],
    ['Category', category],
    ['Location', location],
    ['Assigned Project', assignedProject]
  ];
  if(isVehicle){
    staticRows.push(['Make', item.make || FALLBACK]);
    staticRows.push(['Model', item.model || FALLBACK]);
    staticRows.push(['Year', item.year || FALLBACK]);
    staticRows.push(['Plate', item.plate || FALLBACK]);
    staticRows.push(['VIN', item.vin || FALLBACK]);
  }else{
    staticRows.push(['Serial', item.serial || FALLBACK]);
    staticRows.push(['Model', item.model || FALLBACK]);
    staticRows.push(['Manufacturer', item.manufacturer || FALLBACK]);
    staticRows.push(['Warranty End', item.warrantyend || item.warrantyEnd || FALLBACK]);
  }
  staticRows.push(['Purchase Date', item.purchasedate || item.purchaseDate || FALLBACK]);

  const metrics = isVehicle
    ? [
      ['Mileage', fmtNumber(item.mileage)],
      ['Last Service', fmtDate(item.lastserviceat || item.lastServiceAt)],
      ['Next Service', fmtDate(item.nextserviceat || item.nextServiceAt)]
    ]
    : [
      ['Usage Hours', fmtNumber(item.usagehours || item.usageHours)],
      ['Last Service', fmtDate(item.lastserviceat || item.lastServiceAt)],
      ['Next Service', fmtDate(item.nextserviceat || item.nextServiceAt)]
    ];

  const lastActivity = fmtDate(item.lastactivityat || item.lastActivityAt);
  const notes = item.notes || '';

  body.innerHTML = `
    <section class="panel-section">
      <h3>Details</h3>
      <div class="panel-list">
        ${staticRows.map(([label,val])=>`<div class="panel-row"><span>${label}</span><strong>${val || FALLBACK}</strong></div>`).join('')}
      </div>
    </section>
    <section class="panel-section">
      <h3>Health &amp; Utilization</h3>
      <div class="panel-metrics">
        ${metrics.map(([label,val])=>`<div class="panel-metric"><span>${label}</span><strong>${val}</strong></div>`).join('')}
        <div class="panel-metric"><span>Last Activity</span><strong>${lastActivity}</strong></div>
      </div>
    </section>
    <section class="panel-section">
      <h3>Notes</h3>
      <p class="panel-note">${notes || 'No notes yet.'}</p>
    </section>
  `;
}

function openDrawer(type, id){
  const item = findItem(type, id);
  if(!item) return;
  renderDrawer(type, item);
  const panel = document.getElementById('fleetPanel');
  const backdrop = document.getElementById('fleetPanelBackdrop');
  panel?.classList.add('open');
  backdrop?.classList.add('active');
  document.body.classList.add('panel-open');
  panel?.setAttribute('aria-hidden', 'false');
}

function closeDrawer(){
  const panel = document.getElementById('fleetPanel');
  const backdrop = document.getElementById('fleetPanelBackdrop');
  panel?.classList.remove('open');
  backdrop?.classList.remove('active');
  document.body.classList.remove('panel-open');
  panel?.setAttribute('aria-hidden', 'true');
}

async function loadData(){
  const equipment = (window.utils && utils.fetchJsonSafe)
    ? await utils.fetchJsonSafe('/api/fleet/equipment', {}, [])
    : await fetch('/api/fleet/equipment').then(r=> r.ok ? r.json() : []);
  const vehicles = (window.utils && utils.fetchJsonSafe)
    ? await utils.fetchJsonSafe('/api/fleet/vehicles', {}, [])
    : await fetch('/api/fleet/vehicles').then(r=> r.ok ? r.json() : []);
  equipmentRows = Array.isArray(equipment) ? equipment : [];
  vehicleRows = Array.isArray(vehicles) ? vehicles : [];
  renderTables();
}

document.addEventListener('DOMContentLoaded', async ()=>{
  if(window.utils){
    if(!utils.requireSession?.()) return;
    utils.applyStoredTheme?.();
    utils.applyNavVisibility?.();
    utils.setupLogout?.();
  }
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> setTab(btn.dataset.tab));
  });
  document.getElementById('fleetSearch')?.addEventListener('input', renderTables);
  document.getElementById('equipmentTableBody')?.addEventListener('click', (event)=>{
    const row = event.target.closest('.fleet-row');
    if(row) openDrawer(row.dataset.type, row.dataset.id);
  });
  document.getElementById('vehicleTableBody')?.addEventListener('click', (event)=>{
    const row = event.target.closest('.fleet-row');
    if(row) openDrawer(row.dataset.type, row.dataset.id);
  });
  document.getElementById('fleetPanelClose')?.addEventListener('click', closeDrawer);
  document.getElementById('fleetPanelBackdrop')?.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event)=>{
    if(event.key === 'Escape') closeDrawer();
  });
  await loadData();
});
