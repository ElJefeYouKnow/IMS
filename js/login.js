document.addEventListener('DOMContentLoaded', ()=>{
  localStorage.removeItem('sessionUser');
  const form = document.getElementById('loginForm');
  const err = document.getElementById('login-error');
  const staySignedIn = document.getElementById('login-remember-session');
  const backBtn = document.getElementById('backToMarketing');
  if(backBtn){
    const protocol = window.location.protocol === 'http:' ? 'http:' : 'https:';
    const hostname = window.location.hostname || '';
    const port = window.location.port ? `:${window.location.port}` : '';
    let baseHost = hostname;
    if(baseHost.startsWith('app.')) baseHost = baseHost.slice(4);
    const target = baseHost ? `${protocol}//${baseHost}${port}/index.html` : 'index.html';
    backBtn.addEventListener('click', ()=>{ window.location.href = target; });
  }
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    err.textContent = '';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const remember = !!staySignedIn?.checked;
    if(!email || !password){ err.textContent = 'Email and password required'; return; }
    try{
      const r = await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,remember})});
      if(!r.ok){
        const data = await r.json().catch(()=>({error:'Login failed'}));
        err.textContent = data.error || 'Login failed';
        return;
      }
      const user = await r.json();
      localStorage.setItem('sessionUser', JSON.stringify(user));
      const role = (user.role || '').toLowerCase();
      let target = 'employee-dashboard.html';
      if(role === 'admin' || role === 'dev') target = 'dashboard.html';
      else if(role === 'manager') target = 'ops-dashboard.html';
      window.location.href = target;
    }catch(e){
      err.textContent = 'Unable to login';
    }
  });
});
