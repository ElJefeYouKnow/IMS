const SESSION_KEY = 'sessionUser';

function getSession(){
  try{
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  }catch(e){ return null; }
}

function setSession(next){
  localStorage.setItem(SESSION_KEY, JSON.stringify(next));
}

function updateUserChip(){
  if(window.utils){
    utils.setupUserChip?.();
  }
}

async function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadProfileFields(){
  const session = getSession();
  const nameInput = document.getElementById('adminProfileName');
  const avatarInput = document.getElementById('adminProfileAvatar');
  if(nameInput){
    nameInput.value = localStorage.getItem('profileName') || session?.name || '';
  }
  if(avatarInput){
    const fallback = session?.name ? session.name.slice(0,2).toUpperCase() : '';
    avatarInput.value = localStorage.getItem('profileAvatar') || fallback;
  }
}

function saveProfileFields(){
  const session = getSession();
  const nameInput = document.getElementById('adminProfileName');
  const avatarInput = document.getElementById('adminProfileAvatar');
  const msg = document.getElementById('adminProfileMsg');
  const nameVal = nameInput?.value.trim() || '';
  const avatarVal = avatarInput?.value.trim().toUpperCase() || '';
  if(nameVal) localStorage.setItem('profileName', nameVal);
  else localStorage.removeItem('profileName');
  if(avatarVal) localStorage.setItem('profileAvatar', avatarVal);
  else localStorage.removeItem('profileAvatar');
  if(session){
    const next = { ...session };
    if(nameVal) next.name = nameVal;
    setSession(next);
  }
  if(msg) msg.textContent = 'Profile saved';
  updateUserChip();
}

function clearProfileFields(){
  localStorage.removeItem('profileName');
  localStorage.removeItem('profileAvatar');
  localStorage.removeItem('profilePicData');
  const session = getSession();
  if(session){
    const next = { ...session };
    if(next.name && localStorage.getItem('profileName')) next.name = localStorage.getItem('profileName');
    setSession(next);
  }
  loadProfileFields();
  const msg = document.getElementById('adminProfileMsg');
  if(msg) msg.textContent = 'Profile cleared';
  updateUserChip();
}

function setupTabs(){
  const buttons = document.querySelectorAll('.tab-bar button');
  const panelUsers = document.getElementById('panelUsers');
  const panelProfile = document.getElementById('panelProfile');
  const show = (tab)=>{
    buttons.forEach(btn=> btn.classList.toggle('active', btn.dataset.tab === tab));
    if(panelUsers) panelUsers.style.display = tab === 'users' ? '' : 'none';
    if(panelProfile) panelProfile.style.display = tab === 'profile' ? '' : 'none';
  };
  buttons.forEach(btn=>{
    btn.addEventListener('click', ()=> show(btn.dataset.tab));
  });
  show('users');
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
  setupTabs();
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

  // Profile panel
  loadProfileFields();
  const profileForm = document.getElementById('adminProfileForm');
  const profilePic = document.getElementById('adminProfilePicture');
  const profileClear = document.getElementById('adminProfileClear');
  if(profileForm){
    profileForm.addEventListener('submit', ev=>{
      ev.preventDefault();
      saveProfileFields();
    });
  }
  if(profileClear) profileClear.addEventListener('click', clearProfileFields);
  if(profilePic){
    profilePic.addEventListener('change', async (e)=>{
      const file = e.target.files && e.target.files[0];
      if(!file) return;
      const data = await fileToDataUrl(file);
      localStorage.setItem('profilePicData', data);
      const msg = document.getElementById('adminProfileMsg');
      if(msg) msg.textContent = 'Profile picture updated';
      updateUserChip();
    });
  }
});
