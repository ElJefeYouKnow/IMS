const SESSION_KEY='sessionUser';

function getSession(){
  try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch(e){return null;}
}

async function loadJobs(){
  try{
    const jobs = await utils.fetchJsonSafe('/api/jobs', {}, []);
    const sel = document.getElementById('orderJob');
    const current = sel.value;
    sel.innerHTML = '<option value="">General Inventory</option>';
    (jobs||[]).forEach(j=>{
      const opt = document.createElement('option');
      opt.value = j.code;
      opt.textContent = j.code;
      sel.appendChild(opt);
    });
    if(current) sel.value = current;
  }catch(e){}
}

let itemsCache = [];
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
  const recent = orders.sort((a,b)=> (b.ts||0)-(a.ts||0)).slice(0,8);
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

document.addEventListener('DOMContentLoaded', ()=>{
  const form=document.getElementById('orderForm');
  const msg=document.getElementById('orderMsg');
  const clearBtn=document.getElementById('orderClearBtn');
  const addAnotherBtn = document.getElementById('orderAddAnother');
  const stickJob = document.getElementById('order-stick-job');
  loadJobs();
  loadItems();
  renderRecentOrders();

  const codeInput=document.getElementById('orderCode');
  const nameInput=document.getElementById('orderName');
  codeInput.addEventListener('blur', ()=> fillNameIfKnown(codeInput, nameInput));
  codeInput.addEventListener('change', ()=> fillNameIfKnown(codeInput, nameInput));

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
      for(const parts of lines){
        const [code,name,qty,eta,jobId] = parts.map(p=> (p||'').trim());
        if(!code || !qty){ msg.style.color='#b91c1c'; msg.textContent=`Line skipped: code/qty required (${parts.join(',')})`; continue; }
        document.getElementById('orderCode').value = code;
        document.getElementById('orderName').value = name || '';
        document.getElementById('orderQty').value = qty;
        if(eta) document.getElementById('orderEta').value = eta;
        document.getElementById('orderJob').value = jobId || (stickJob?.checked ? document.getElementById('orderJob').value : '');
        await submitOrder(true);
      }
    });
  }
  clearBtn.addEventListener('click',()=>{form.reset();msg.textContent='';document.getElementById('orderQty').value='1';});
});
