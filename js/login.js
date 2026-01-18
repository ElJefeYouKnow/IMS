document.addEventListener('DOMContentLoaded', ()=>{
  localStorage.removeItem('sessionUser');
  const form = document.getElementById('loginForm');
  const err = document.getElementById('login-error');
  const staySignedIn = document.getElementById('login-remember-session');
  const resendBtn = document.getElementById('resendVerify');
  const backBtn = document.getElementById('backToMarketing');
  const urlParams = new URLSearchParams(window.location.search || '');
  const tenantCodeParam = (urlParams.get('tenant') || '').trim();
  if(backBtn){
    const protocol = window.location.protocol === 'http:' ? 'http:' : 'https:';
    const hostname = window.location.hostname || '';
    const port = window.location.port ? `:${window.location.port}` : '';
    let baseHost = hostname;
    if(baseHost.startsWith('app.')) baseHost = baseHost.slice(4);
    const target = baseHost ? `${protocol}//${baseHost}${port}/index.html` : 'index.html';
    backBtn.addEventListener('click', ()=>{ window.location.href = target; });
  }
  if(resendBtn){
    resendBtn.addEventListener('click', async ()=>{
      const email = document.getElementById('login-email').value.trim();
      if(!email){
        err.textContent = 'Enter your email to resend verification.';
        return;
      }
      resendBtn.disabled = true;
      const label = resendBtn.textContent;
      resendBtn.textContent = 'Sending...';
      try{
        const payload = { email };
        if(tenantCodeParam) payload.tenantCode = tenantCodeParam;
        const r = await fetch('/api/auth/verify/resend', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
        if(r.ok){
          err.textContent = 'Verification email sent.';
        }else{
          err.textContent = 'Unable to send verification email.';
        }
      }catch(e){
        err.textContent = 'Unable to send verification email.';
      }finally{
        resendBtn.disabled = false;
        resendBtn.textContent = label;
      }
    });
  }
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    err.textContent = '';
    if(resendBtn) resendBtn.classList.add('hidden');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const remember = !!staySignedIn?.checked;
    if(!email || !password){ err.textContent = 'Email and password required'; return; }
    try{
      const payload = { email, password, remember };
      if(tenantCodeParam) payload.tenantCode = tenantCodeParam;
      const r = await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!r.ok){
        const data = await r.json().catch(()=>({error:'Login failed'}));
        err.textContent = data.error || 'Login failed';
        if(data.code === 'email_not_verified' && resendBtn){
          resendBtn.classList.remove('hidden');
        }
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
