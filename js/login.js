document.addEventListener('DOMContentLoaded', ()=>{
  localStorage.removeItem('sessionUser');
  const form = document.getElementById('loginForm');
  const err = document.getElementById('login-error');
  const tenantInput = document.getElementById('login-tenant');
  const rememberToggle = document.getElementById('login-remember-tenant');
  const storedTenant = localStorage.getItem('rememberTenantCode') || '';
  if(tenantInput && storedTenant){
    tenantInput.value = storedTenant;
    if(rememberToggle) rememberToggle.checked = true;
  }
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    err.textContent = '';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const tenantCode = (tenantInput?.value.trim() || 'default').toLowerCase();
    if(!email || !password){ err.textContent = 'Email and password required'; return; }
    if(rememberToggle?.checked){
      localStorage.setItem('rememberTenantCode', tenantCode);
    }else{
      localStorage.removeItem('rememberTenantCode');
    }
    try{
      const r = await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,tenantCode})});
      if(!r.ok){
        const data = await r.json().catch(()=>({error:'Login failed'}));
        err.textContent = data.error || 'Login failed';
        return;
      }
      const user = await r.json();
      localStorage.setItem('sessionUser', JSON.stringify(user));
      window.location.href = 'dashboard.html';
    }catch(e){
      err.textContent = 'Unable to login';
    }
  });
});
