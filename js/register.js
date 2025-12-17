const SESSION_KEY = 'sessionUser';

function saveSession(user){
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}

document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.getElementById('registerForm');
  const err = document.getElementById('reg-error');
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    err.textContent='';
    const name=document.getElementById('reg-name').value.trim();
    const email=document.getElementById('reg-email').value.trim();
    const password=document.getElementById('reg-password').value;
    if(!email || !password){err.textContent='Email and password required';return;}
    try{
      const r = await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,email,password})});
      if(!r.ok){
        const data = await r.json().catch(()=>({error:'Registration failed'}));
        err.textContent = data.error || 'Registration failed';
        return;
      }
      const user = await r.json();
      saveSession(user);
      window.location.href = 'dashboard.html';
    }catch(e){
      err.textContent = 'Unable to register';
    }
  });
});
