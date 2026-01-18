document.addEventListener('DOMContentLoaded', ()=>{
  const params = new URLSearchParams(window.location.search || '');
  const token = params.get('token');
  const status = document.getElementById('inviteStatus');
  const form = document.getElementById('inviteForm');

  if(!token){
    status.textContent = 'Missing invite token.';
    return;
  }

  form?.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    status.textContent = '';
    status.style.color = '#b91c1c';
    const name = document.getElementById('inviteName').value.trim();
    const password = document.getElementById('invitePassword').value;
    const confirm = document.getElementById('invitePasswordConfirm').value;
    if(!password){ status.textContent = 'Password is required.'; return; }
    if(password.length < 10){ status.textContent = 'Password must be at least 10 characters.'; return; }
    if(password !== confirm){ status.textContent = 'Passwords do not match.'; return; }
    try{
      const r = await fetch('/api/auth/invite/accept', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token, password, name })
      });
      const data = await r.json().catch(()=>({}));
      if(!r.ok){
        status.textContent = data.error || 'Unable to accept invite.';
        return;
      }
      status.style.color = '#15803d';
      status.textContent = 'Account activated. Redirecting to login...';
      setTimeout(()=>{ window.location.href = 'login.html'; }, 1500);
    }catch(e){
      status.textContent = 'Unable to accept invite.';
    }
  });
});
