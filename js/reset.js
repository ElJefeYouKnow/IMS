document.addEventListener('DOMContentLoaded', ()=>{
  const params = new URLSearchParams(window.location.search || '');
  const token = params.get('token');
  const tenant = (params.get('tenant') || '').trim();
  const requestWrap = document.getElementById('resetRequest');
  const resetWrap = document.getElementById('resetFormWrap');
  const status = document.getElementById('resetStatus');
  const requestForm = document.getElementById('resetRequestForm');
  const resetForm = document.getElementById('resetForm');

  if(token){
    requestWrap.classList.add('hidden');
    resetWrap.classList.remove('hidden');
  }

  requestForm?.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    status.textContent = '';
    status.style.color = '#b91c1c';
    const email = document.getElementById('resetEmail').value.trim();
    if(!email){ status.textContent = 'Email is required.'; return; }
    try{
      const payload = { email };
      if(tenant) payload.tenantCode = tenant;
      const r = await fetch('/api/auth/password/request', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      if(!r.ok){
        const data = await r.json().catch(()=>({}));
        status.textContent = data.error || 'Unable to send reset email.';
        return;
      }
      status.style.color = '#15803d';
      status.textContent = 'If the email exists, a reset link has been sent.';
    }catch(e){
      status.textContent = 'Unable to send reset email.';
    }
  });

  resetForm?.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    status.textContent = '';
    status.style.color = '#b91c1c';
    const password = document.getElementById('resetPassword').value;
    const confirm = document.getElementById('resetPasswordConfirm').value;
    if(!password){ status.textContent = 'Password is required.'; return; }
    if(password.length < 10){ status.textContent = 'Password must be at least 10 characters.'; return; }
    if(password !== confirm){ status.textContent = 'Passwords do not match.'; return; }
    try{
      const r = await fetch('/api/auth/password/reset', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token, password })
      });
      const data = await r.json().catch(()=>({}));
      if(!r.ok){
        status.textContent = data.error || 'Unable to reset password.';
        return;
      }
      status.style.color = '#15803d';
      status.textContent = 'Password updated. Redirecting to login...';
      setTimeout(()=>{ window.location.href = 'login.html'; }, 1500);
    }catch(e){
      status.textContent = 'Unable to reset password.';
    }
  });
});
