document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.getElementById('tenantForm');
  const err = document.getElementById('tenant-error');
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    err.textContent = '';
    const name = document.getElementById('tenant-name').value.trim();
    const code = document.getElementById('tenant-code').value.trim();
    const adminName = document.getElementById('admin-name').value.trim();
    const adminEmail = document.getElementById('admin-email').value.trim();
    const adminPassword = document.getElementById('admin-password').value;
    if(!code || !name || !adminEmail || !adminPassword){
      err.textContent = 'All fields are required';
      return;
    }
    try{
      const r = await fetch('/api/tenants',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,name,adminEmail,adminPassword,adminName})});
      if(!r.ok){
        const data = await r.json().catch(()=>({error:'Could not create business'}));
        err.textContent = data.error || 'Could not create business';
        return;
      }
      const data = await r.json();
      localStorage.setItem('sessionUser', JSON.stringify(data.admin));
      window.location.href = 'dashboard.html';
    }catch(e){
      err.textContent = 'Unable to create business';
    }
  });
});
