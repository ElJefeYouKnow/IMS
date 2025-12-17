const SESSION_KEY='sessionUser';

function getSession(){
  try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch(e){return null;}
}

document.addEventListener('DOMContentLoaded', ()=>{
  const form=document.getElementById('orderForm');
  const msg=document.getElementById('orderMsg');
  const clearBtn=document.getElementById('orderClearBtn');
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    msg.textContent='';
    const session=getSession();
    if(!session || session.role!=='admin'){msg.style.color='#b91c1c';msg.textContent='Admin only';return;}
    const code=document.getElementById('orderCode').value.trim();
    const name=document.getElementById('orderName').value.trim();
    const qty=parseInt(document.getElementById('orderQty').value,10)||0;
    const eta=document.getElementById('orderEta').value;
    const notes=document.getElementById('orderNotes').value.trim();
    if(!code||qty<=0){msg.style.color='#b91c1c';msg.textContent='Code and positive quantity required';return;}
    try{
      const r=await fetch('/api/inventory-order',{method:'POST',headers:{'Content-Type':'application/json','x-admin-role':session.role},body:JSON.stringify({code,name,qty,eta,notes,userEmail:session.email,userName:session.name})});
      if(!r.ok){
        const data=await r.json().catch(()=>({error:'Failed'}));
        msg.style.color='#b91c1c';msg.textContent=data.error||'Failed to register order';
        return;
      }
      msg.style.color='#15803d';msg.textContent='Order registered';
      form.reset();document.getElementById('orderQty').value='1';
    }catch(e){
      msg.style.color='#b91c1c';msg.textContent='Failed to register order';
    }
  });
  clearBtn.addEventListener('click',()=>{form.reset();msg.textContent='';document.getElementById('orderQty').value='1';});
});
