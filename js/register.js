const SESSION_KEY = 'sessionUser';

function saveSession(user){
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}

document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.getElementById('registerForm');
  const err = document.getElementById('reg-error');
  const modeBtns = document.querySelectorAll('.tab-toggle button');
  const adminRow = document.getElementById('admin-key-row');
  const subtitle = document.getElementById('reg-subtitle');
  const adminNote = document.getElementById('admin-note');
  let mode = 'user';

  modeBtns.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      modeBtns.forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      mode = btn.dataset.mode;
      const isAdmin = mode === 'admin';
      adminRow.style.display = isAdmin ? 'block' : 'none';
      adminNote.style.display = isAdmin ? 'block' : 'none';
      subtitle.textContent = isAdmin ? 'Create an admin account (requires admin key).' : 'Register to start using the app.';
    });
  });

  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    err.textContent='';
    const tenantCode=document.getElementById('reg-tenant').value.trim()||'default';
    const name=document.getElementById('reg-name').value.trim();
    const email=document.getElementById('reg-email').value.trim();
    const password=document.getElementById('reg-password').value;
    const adminKey=document.getElementById('reg-adminkey').value;
    if(!email || !password){err.textContent='Email and password required';return;}
    const payload = {name,email,password,tenantCode};
    if(mode === 'admin'){
      payload.role = 'admin';
      if(adminKey) payload.adminKey = adminKey;
    }
    try{
      const headers = {'Content-Type':'application/json'};
      if(mode === 'admin' && adminKey) headers['x-admin-signup'] = adminKey;
      const r = await fetch('/api/auth/register',{method:'POST',headers,body:JSON.stringify(payload)});
      if(!r.ok){
        const data = await r.json().catch(()=>({error:'Registration failed'}));
        err.textContent = data.error || 'Registration failed';
        return;
      }
      const data = await r.json();
      if(data.status === 'verify'){
        err.style.color = '#15803d';
        err.textContent = 'Check your email to verify your account, then sign in.';
        setTimeout(()=>{ window.location.href = 'login.html'; }, 1800);
        return;
      }
      saveSession(data);
      window.location.href = 'dashboard.html';
    }catch(e){
      err.textContent = 'Unable to register';
    }
  });
});
