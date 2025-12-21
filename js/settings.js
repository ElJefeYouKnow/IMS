const SESSION_KEY = 'sessionUser';

function getSession(){
  try{
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  }catch(e){ return null; }
}

async function loadUsers(role){
  try{
    const r = await fetch('/api/users',{headers:{'x-admin-role': role}});
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

async function createUser(role, user){
  const r = await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json','x-admin-role':role},body:JSON.stringify(user)});
  return r;
}

async function renderUsers(role){
  const tbody=document.querySelector('#usersTable tbody');tbody.innerHTML='';
  const users = await loadUsers(role);
  if(!users.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="4" style="text-align:center;color:#6b7280;">No users yet</td>`;
    tbody.appendChild(tr);
    return;
  }
  users.sort((a,b)=> a.email.localeCompare(b.email));
  users.forEach(u=>{
    const tr=document.createElement('tr');
    const dt = u.createdAt ? new Date(u.createdAt).toLocaleString() : '';
    const btn = `<button type="button" class="muted edit-user" data-id="${u.id}" data-email="${u.email}" data-name="${u.name||''}" data-role="${u.role}">Edit</button>`;
    tr.innerHTML=`<td>${u.email}</td><td>${u.name||''}</td><td>${u.role}</td><td>${dt}</td><td>${btn}</td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.edit-user').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.getElementById('edit-userId').value = btn.dataset.id;
      document.getElementById('edit-userName').value = btn.dataset.name || '';
      document.getElementById('edit-userEmail').value = btn.dataset.email || '';
      document.getElementById('edit-userRole').value = btn.dataset.role || 'user';
      document.getElementById('edit-userPassword').value = '';
      document.getElementById('edit-userError').textContent = '';
    });
  });
}

document.addEventListener('DOMContentLoaded', ()=>{
  const session = getSession();
  const guard = document.getElementById('admin-guard');
  const content = document.getElementById('settings-content');
  if(!session || session.role !== 'admin'){
    guard.style.display='block';
    if(content) content.style.display='none';
    return;
  }
  renderUsers(session.role);
  const form=document.getElementById('userForm');
  const err=document.getElementById('userError');
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    err.textContent='';
    const name=document.getElementById('userName').value.trim();
    const email=document.getElementById('userEmail').value.trim();
    const password=document.getElementById('userPassword').value;
    const role=document.getElementById('userRole').value;
    if(!email || !password){err.textContent='Email and password required';return;}
    const r = await createUser(session.role,{name,email,password,role});
    if(!r.ok){
      const data = await r.json().catch(()=>({error:'Failed to create user'}));
      err.textContent = data.error || 'Failed to create user';
      return;
    }
    form.reset();
    renderUsers(session.role);
  });
  document.getElementById('userClearBtn').addEventListener('click',()=>{form.reset();err.textContent='';});

  // Edit user
  const editForm = document.getElementById('editUserForm');
  const editErr = document.getElementById('edit-userError');
  editForm.addEventListener('submit', async ev=>{
    ev.preventDefault();
    editErr.textContent='';
    const id = document.getElementById('edit-userId').value;
    if(!id){ editErr.textContent='Select a user from the table first.'; return; }
    const payload = {
      name: document.getElementById('edit-userName').value.trim(),
      email: document.getElementById('edit-userEmail').value.trim(),
      role: document.getElementById('edit-userRole').value
    };
    const pw = document.getElementById('edit-userPassword').value;
    if(pw) payload.password = pw;
    try{
      const r = await fetch(`/api/users/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!r.ok){
        const data = await r.json().catch(()=>({error:'Update failed'}));
        editErr.textContent = data.error || 'Update failed';
        return;
      }
      editForm.reset();
      await renderUsers(session.role);
    }catch(e){
      editErr.textContent = 'Unable to update user';
    }
  });
  document.getElementById('edit-userClearBtn').addEventListener('click',()=>{editForm.reset();editErr.textContent='';});
});
