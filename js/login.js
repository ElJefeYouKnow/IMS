document.addEventListener('DOMContentLoaded', ()=>{
  localStorage.removeItem('sessionUser');
  const form = document.getElementById('loginForm');
  const err = document.getElementById('login-error');
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    err.textContent = '';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const tenantCode = (document.getElementById('login-tenant').value.trim() || 'default').toLowerCase();
    if(!email || !password){ err.textContent = 'Email and password required'; return; }
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
