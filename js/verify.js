document.addEventListener('DOMContentLoaded', async ()=>{
  const status = document.getElementById('verifyStatus');
  const token = new URLSearchParams(window.location.search || '').get('token');
  if(!token){
    status.textContent = 'Missing verification token.';
    return;
  }
  status.textContent = 'Verifying...';
  try{
    const r = await fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`);
    const data = await r.json().catch(()=>({}));
    if(!r.ok){
      status.textContent = data.error || 'Verification failed.';
      return;
    }
    status.style.color = '#15803d';
    status.textContent = 'Email verified. You can sign in.';
    setTimeout(()=>{ window.location.href = 'login.html'; }, 1500);
  }catch(e){
    status.textContent = 'Verification failed.';
  }
});
