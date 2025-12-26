const SESSION_KEY='sessionUser';

function getSession(){
  try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch(e){return null;}
}

let itemsCache = [];

async function loadJobs(){
  try{
    const jobs = await utils.fetchJsonSafe('/api/jobs', {}, []);
    const selects = ['orderJob','reserve-jobId'].map(id=> document.getElementById(id)).filter(Boolean);
    selects.forEach(sel=>{
      const current = sel.value;
      sel.innerHTML = '<option value="">General Inventory</option>';
      (jobs||[]).forEach(j=>{
        const opt = document.createElement('option');
        opt.value = j.code;
        opt.textContent = j.code;
        sel.appendChild(opt);
      });
      if(current) sel.value = current;
    });
  }catch(e){}
}

async function loadItems(){
  try{
    itemsCache = await utils.fetchJsonSafe('/api/items', {}, []) || [];
  }catch(e){}
}

function fillNameIfKnown(codeInput, nameInput){
  const val = codeInput.value.trim();
  if(!val) return;
  const match = itemsCache.find(i=> i.code.toLowerCase() === val.toLowerCase());
  if(match){
    nameInput.value = match.name || '';
    nameInput.dataset.existing = 'true';
  }else{
    nameInput.dataset.existing = 'false';
  }
}

function setEtaDays(days){
  const eta = document.getElementById('orderEta');
  const d = new Date();
  d.setDate(d.getDate()+days);
  eta.value = d.toISOString().slice(0,10);
}

function setEtaNextMonday(){
  const eta = document.getElementById('orderEta');
  const d = new Date();
  const day = d.getDay();
  const add = ((8 - day) % 7) || 7;
  d.setDate(d.getDate()+add);
  eta.value = d.toISOString().slice(0,10);
}

async function renderRecentOrders(){
  const tbody = document.querySelector('#recentOrdersTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  const orders = await utils.fetchJsonSafe('/api/inventory?type=ordered', {}, []) || [];
  const filter = (document.getElementById('orderFilter')?.value || '').toLowerCase();
  const filtered = orders.filter(o=>{
    const job = (o.jobId||'').toLowerCase();
    return !filter || o.code.toLowerCase().includes(filter) || job.includes(filter);
  });
  const recent = filtered.sort((a,b)=> (b.ts||0)-(a.ts||0)).slice(0,12);
  if(!recent.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:#6b7280;">No orders yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  recent.forEach(o=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${o.code}</td><td>${o.name||''}</td><td>${o.qty}</td><td>${o.jobId||'General'}</td><td>${o.eta||''}</td><td>${o.ts ? new Date(o.ts).toLocaleString() : ''}</td>`;
    tbody.appendChild(tr);
  });
}

function initTabs(){
  const tabs = document.querySelectorAll('.mode-btn');
  tabs.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      tabs.forEach(b=> b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      document.querySelectorAll('.mode-content').forEach(div=> div.classList.remove('active'));
      const tgt = document.getElementById(`${mode}-mode`);
      if(tgt) tgt.classList.add('active');
    });
  });
}

function initOrders(){
  const form=document.getElementById('orderForm');
  const msg=document.getElementById('orderMsg');
  const clearBtn=document.getElementById('orderClearBtn');
  const addAnotherBtn = document.getElementById('orderAddAnother');
  const stickJob = document.getElementById('order-stick-job');
  if(!form) return;

  const codeInput=document.getElementById('orderCode');
  const nameInput=document.getElementById('orderName');
  codeInput.addEventListener('blur', ()=> fillNameIfKnown(codeInput, nameInput));
  codeInput.addEventListener('change', ()=> fillNameIfKnown(codeInput, nameInput));
  // suggestions dropdown
  utils.attachItemLookup?.({
    getItems: ()=>itemsCache,
    codeInputId:'orderCode',
    nameInputId:'orderName',
    suggestionsId:'orderCodeSuggest'
  });

  const presets = document.querySelectorAll('#etaPresets button');
  presets.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(btn.dataset.nextMonday) setEtaNextMonday();
      else setEtaDays(Number(btn.dataset.days||0));
    });
  });

  async function submitOrder(clearAll){
    msg.textContent='';
    const session=getSession();
    if(!session || session.role!=='admin'){msg.style.color='#b91c1c';msg.textContent='Admin only';return false;}
    const code=codeInput.value.trim();
    const name=nameInput.value.trim();
    const qty=parseInt(document.getElementById('orderQty').value,10)||0;
    const eta=document.getElementById('orderEta').value;
    const jobId=document.getElementById('orderJob').value.trim();
    const notes=document.getElementById('orderNotes').value.trim();
    const known = itemsCache.find(i=> i.code.toLowerCase() === code.toLowerCase());
    if(!code||qty<=0){msg.style.color='#b91c1c';msg.textContent='Code and positive quantity required';return false;}
    if(!known && !name){msg.style.color='#b91c1c';msg.textContent='Name is required for new codes';return false;}
    if(!eta){msg.style.color='#b91c1c';msg.textContent='ETA is required';return false;}
    try{
      const r=await fetch('/api/inventory-order',{method:'POST',headers:{'Content-Type':'application/json','x-admin-role':session.role},body:JSON.stringify({code,name,qty,eta,notes,jobId,userEmail:session.email,userName:session.name})});
      if(!r.ok){
        const data=await r.json().catch(()=>({error:'Failed'}));
        msg.style.color='#b91c1c';msg.textContent=data.error||'Failed to register order';
        return false;
      }
      msg.style.color='#15803d';msg.textContent='Order registered';
      await renderRecentOrders();
      const keepJob = stickJob?.checked;
      if(clearAll){
        form.reset();document.getElementById('orderQty').value='1';
        nameInput.dataset.existing='false';
      }else{
        codeInput.value=''; document.getElementById('orderQty').value='1'; nameInput.value=''; codeInput.focus();
      }
      if(keepJob){
        document.getElementById('orderJob').value = jobId;
      }
      return true;
    }catch(e){
      msg.style.color='#b91c1c';msg.textContent='Failed to register order';
      return false;
    }
  }

  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    await submitOrder(true);
  });
  addAnotherBtn.addEventListener('click', async ()=>{
    await submitOrder(false);
  });
  const bulkBtn = document.getElementById('order-bulk-apply');
  if(bulkBtn){
    bulkBtn.addEventListener('click', async ()=>{
      const text = document.getElementById('order-bulk').value.trim();
      if(!text){ msg.textContent=''; return; }
      const lines = text.split('\n').map(l=> l.split(','));
      const orders = [];
      for(const parts of lines){
        const [code,name,qty,eta,jobId] = parts.map(p=> (p||'').trim());
        if(!code || !qty){ continue; }
        orders.push({ code, name, qty:Number(qty), eta, jobId });
      }
      if(!orders.length){ msg.style.color='#b91c1c'; msg.textContent='No valid lines found'; return; }
      const session=getSession();
      if(!session || session.role!=='admin'){msg.style.color='#b91c1c';msg.textContent='Admin only';return;}
      try{
        const r = await fetch('/api/inventory-order/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orders,userEmail:session.email,userName:session.name})});
        const data = await r.json().catch(()=>({}));
        if(!r.ok){ msg.style.color='#b91c1c'; msg.textContent=data.error||'Bulk failed'; return; }
        msg.style.color='#15803d'; msg.textContent=`Registered ${data.count} orders`;
        form.reset(); document.getElementById('orderQty').value='1'; document.getElementById('order-bulk').value='';
        await renderRecentOrders();
      }catch(e){ msg.style.color='#b91c1c'; msg.textContent='Bulk failed'; }
    });
    const clearBulk = document.getElementById('order-bulk-clear');
    clearBulk?.addEventListener('click', ()=>{ document.getElementById('order-bulk').value=''; });
  }
  clearBtn.addEventListener('click',()=>{form.reset();msg.textContent='';document.getElementById('orderQty').value='1';});
}

function initReserve(){
  const reserveLines = document.getElementById('reserve-lines');
  if(!reserveLines) return;
  function addReserveLine(){
    const codeId = `reserve-code-${Math.random().toString(16).slice(2,8)}`;
    const qtyId = `reserve-qty-${Math.random().toString(16).slice(2,8)}`;
    const row = document.createElement('div');
    row.className = 'form-row line-row';
    row.innerHTML = `
      <label>Item Code<input id="${codeId}" name="code" required placeholder="SKU/part"></label>
      <label style="max-width:120px;">Qty<input id="${qtyId}" name="qty" type="number" min="1" value="1" required></label>
      <button type="button" class="muted remove-line">Remove</button>
    `;
    reserveLines.appendChild(row);
    row.querySelector('.remove-line').addEventListener('click', ()=>{ row.remove(); if(!reserveLines.querySelector('.line-row')) addReserveLine(); });
  }
  function gatherReserve(){
    const rows = [...reserveLines.querySelectorAll('.line-row')];
    const out=[];
    rows.forEach(r=>{
      const code=r.querySelector('input[name="code"]')?.value.trim()||'';
      const qty=parseInt(r.querySelector('input[name="qty"]')?.value||'0',10)||0;
      if(code && qty>0) out.push({code,qty});
    });
    return out;
  }
  addReserveLine();
  const addBtn = document.getElementById('reserve-addLine');
  if(addBtn) addBtn.addEventListener('click', addReserveLine);
  const reserveForm = document.getElementById('reserveForm');
  const reserveMsg = document.getElementById('reserveMsg');
  const reserveTable = document.querySelector('#reserveTable tbody');
async function renderReserves(){
    if(!reserveTable) return;
    reserveTable.innerHTML='';
    const rows = await utils.fetchJsonSafe('/api/inventory-reserve', {}, []) || [];
    const filter = (document.getElementById('reserveFilter')?.value || '').toLowerCase();
    const filtered = rows.filter(r=>{
      const job=(r.jobId||'').toLowerCase();
      return !filter || r.code.toLowerCase().includes(filter) || job.includes(filter);
    });
    if(!filtered.length){
      const tr=document.createElement('tr');
      tr.innerHTML=`<td colspan="5" style="text-align:center;color:#6b7280;">No reservations</td>`;
      reserveTable.appendChild(tr);
      return;
    }
    filtered.slice().reverse().forEach(e=>{
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${e.code}</td><td>${e.jobId||''}</td><td>${e.qty}</td><td class="mobile-hide">${e.returnDate||''}</td><td class="mobile-hide">${e.ts ? new Date(e.ts).toLocaleString() : ''}</td>`;
      reserveTable.appendChild(tr);
    });
  }
  reserveForm?.addEventListener('submit', async ev=>{
    ev.preventDefault();
    reserveMsg.textContent='';
    const session=getSession();
    if(!session || session.role!=='admin'){reserveMsg.style.color='#b91c1c';reserveMsg.textContent='Admin only';return;}
    const jobId=document.getElementById('reserve-jobId').value.trim();
    const returnDate=document.getElementById('reserve-returnDate').value;
    const notes=document.getElementById('reserve-notes').value.trim();
    const lines=gatherReserve();
    if(!jobId){reserveMsg.style.color='#b91c1c';reserveMsg.textContent='Job is required';return;}
    if(!lines.length){reserveMsg.style.color='#b91c1c';reserveMsg.textContent='Add at least one line';return;}
    let okAll=true;
    for(const line of lines){
      const r=await fetch('/api/inventory-reserve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:line.code,jobId,qty:line.qty,returnDate,notes,userEmail:session.email,userName:session.name})});
      if(!r.ok){
        const data=await r.json().catch(()=>({error:'Failed'}));
        okAll=false;
        reserveMsg.style.color='#b91c1c';
        reserveMsg.textContent=data.error||'Failed to reserve';
        break;
      }
    }
    if(okAll){
      reserveMsg.style.color='#15803d';reserveMsg.textContent='Reserved';
      reserveForm.reset(); reserveLines.innerHTML=''; addReserveLine(); renderReserves();
    }
  });
  renderReserves();

  const reserveFilter = document.getElementById('reserveFilter');
  reserveFilter?.addEventListener('input', renderReserves);

  // Bulk reserve paste (code,qty per line)
  const reserveBulkBtn = document.getElementById('reserve-bulk-apply');
  const reserveBulkArea = document.getElementById('reserve-bulk');
  if(reserveBulkBtn && reserveBulkArea){
    reserveBulkBtn.addEventListener('click', async ()=>{
      reserveMsg.textContent='';
      const session=getSession();
      if(!session || session.role!=='admin'){reserveMsg.style.color='#b91c1c';reserveMsg.textContent='Admin only';return;}
      const jobId=document.getElementById('reserve-jobId').value.trim();
      if(!jobId){reserveMsg.style.color='#b91c1c';reserveMsg.textContent='Job is required';return;}
      const returnDate=document.getElementById('reserve-returnDate').value;
      const notes=document.getElementById('reserve-notes').value.trim();
      const text = reserveBulkArea.value.trim();
      if(!text){reserveMsg.textContent='';return;}
      const lines = text.split('\n').map(l=> l.split(','));
      const payload = [];
      for(const parts of lines){
        const [code,qty] = parts.map(p=> (p||'').trim());
        if(!code || !qty) continue;
        payload.push({code, qty:Number(qty)});
      }
      if(!payload.length){reserveMsg.style.color='#b91c1c';reserveMsg.textContent='No valid lines';return;}
      try{
        const r = await fetch('/api/inventory-reserve/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId,returnDate,notes,lines:payload,userEmail:session.email,userName:session.name})});
        const data = await r.json().catch(()=>({}));
        if(!r.ok){reserveMsg.style.color='#b91c1c';reserveMsg.textContent=data.error||'Bulk reserve failed';return;}
        reserveMsg.style.color='#15803d';reserveMsg.textContent=`Reserved ${data.count} lines`;
        reserveForm.reset(); reserveLines.innerHTML=''; addReserveLine(); reserveBulkArea.value=''; renderReserves();
      }catch(e){reserveMsg.style.color='#b91c1c';reserveMsg.textContent='Bulk reserve failed';}
    });
    const clearReserveBulk = document.getElementById('reserve-bulk-clear');
    clearReserveBulk?.addEventListener('click', ()=>{ reserveBulkArea.value=''; });
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  loadJobs();
  loadItems();
  renderRecentOrders();
  initTabs();
  initOrders();
  initReserve();
  document.getElementById('orderFilter')?.addEventListener('input', renderRecentOrders);
});
