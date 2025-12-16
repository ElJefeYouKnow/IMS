const STORAGE_KEY = 'inventoryEntries_v1';
const FALLBACK = 'N/A';
let allItems = [];
let jobOptions = [];

function loadEntriesLocal(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]')}catch(e){return []}}
function saveEntriesLocal(entries){localStorage.setItem(STORAGE_KEY,JSON.stringify(entries))}

async function loadItems(){
  allItems = await utils.fetchJsonSafe('/api/items', {}, []) || [];
}

async function loadJobOptions(){
  const jobs = await utils.fetchJsonSafe('/api/jobs', {}, []);
  const today = new Date();
  jobOptions = (jobs || [])
    .filter(j=> !j.scheduleDate || new Date(j.scheduleDate) >= today)
    .map(j=> j.code)
    .filter(Boolean)
    .sort();
  applyJobOptions();
}

function applyJobOptions(){
  const sel = document.getElementById('jobId');
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">General Inventory</option>';
  jobOptions.forEach(j=>{
    const opt=document.createElement('option');
    opt.value=j; opt.textContent=j;
    sel.appendChild(opt);
  });
  if(current) sel.value=current;
}

function ensureJobOption(jobId){
  const id=(jobId||'').trim();
  if(!id) return;
  if(!jobOptions.includes(id)) return; // only allow known, non-expired jobs
}

async function apiAvailable(){
  try{const r=await fetch('/api/inventory'); return r.ok;}catch(e){return false}
}

async function loadEntries(){
  const serverEntries = await utils.fetchJsonSafe('/api/inventory', {}, null);
  if(serverEntries) return serverEntries;
  return loadEntriesLocal();
}

async function addEntryToApi(entry){
  try{
    const r = await fetch('/api/inventory',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...entry, type:'in'})
    });
    return r.ok;
  }catch(e){return false}
}

async function renderTable(){
  const tbody=document.querySelector('#invTable tbody');tbody.innerHTML='';
  const entries = await loadEntries();
  const visible = entries.filter(e=> e.type === 'in');
  if(!visible.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:#6b7280;">No check-ins yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  visible.slice().reverse().forEach(e=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${e.code}</td><td>${e.name||''}</td><td>${e.qty}</td><td>${e.location||''}</td><td>${e.jobId||FALLBACK}</td><td>${new Date(e.ts).toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
}

async function addEntry(e){
  const ok = await addEntryToApi(e);
  if(!ok){
    const entries = loadEntriesLocal(); entries.push(e); saveEntriesLocal(entries);
  }
  await renderTable();
}

async function clearEntries(){
  try{ await fetch('/api/inventory',{method:'DELETE'}); }catch(e){ localStorage.removeItem(STORAGE_KEY); }
  await renderTable();
}

async function exportCSV(){
  const entries = await loadEntries();
  if(!entries.length){alert('No entries to export');return}
  const hdr=['code','name','qty','location','timestamp'];
  const rows=entries.map(r=>[r.code,r.name,r.qty,r.location,new Date(r.ts).toISOString()]);
  const csv=[hdr.join(','),...rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='inventory.csv';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded',async ()=>{
  await loadItems();
  await loadJobOptions();
  renderTable();
  
  utils.attachItemLookup({
    getItems: ()=> allItems,
    codeInputId: 'itemCode',
    nameInputId: 'itemName',
    categoryInputId: 'itemCategory',
    priceInputId: 'itemUnitPrice',
    suggestionsId: 'itemCodeSuggestions'
  });
  
  const form=document.getElementById('checkinForm');
  form.addEventListener('submit',async ev=>{
    ev.preventDefault();
    const code=document.getElementById('itemCode').value.trim();
    const name=document.getElementById('itemName').value.trim();
    const qty=parseInt(document.getElementById('qty').value,10)||0;
    const location=document.getElementById('location').value.trim();
    const jobId=document.getElementById('jobId').value.trim();
    const notes=document.getElementById('notes').value.trim();
    if(!code||qty<=0){alert('Please provide an item code and a positive quantity');return}
    const entry = {code,name,qty,location,jobId,notes,ts:Date.now()};
    await addEntry(entry);
    ensureJobOption(jobId);
    form.reset();document.getElementById('qty').value='1';
  });
  document.getElementById('clearBtn').addEventListener('click',async ()=>{if(confirm('Clear all saved entries?')) await clearEntries();});
  document.getElementById('exportBtn').addEventListener('click',exportCSV);
});
