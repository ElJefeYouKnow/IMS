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
    nameInput.value = utils.getProfileValue?.('name') || session?.name || '';
  }
  if(avatarInput){
    const fallback = session?.name ? session.name.slice(0,2).toUpperCase() : '';
    avatarInput.value = utils.getProfileValue?.('avatar') || fallback;
  }
}

function saveProfileFields(){
  const session = getSession();
  const nameInput = document.getElementById('adminProfileName');
  const avatarInput = document.getElementById('adminProfileAvatar');
  const msg = document.getElementById('adminProfileMsg');
  const nameVal = nameInput?.value.trim() || '';
  const avatarVal = avatarInput?.value.trim().toUpperCase() || '';
  if(nameVal) utils.setProfileValue?.('name', nameVal);
  else utils.setProfileValue?.('name', '');
  if(avatarVal) utils.setProfileValue?.('avatar', avatarVal);
  else utils.setProfileValue?.('avatar', '');
  if(session){
    const next = { ...session };
    if(nameVal) next.name = nameVal;
    setSession(next);
  }
  if(msg) msg.textContent = 'Profile saved';
  updateUserChip();
}

function clearProfileFields(){
  utils.clearProfileValues?.();
  const session = getSession();
  if(session){
    const next = { ...session };
    const storedName = utils.getProfileValue?.('name');
    if(next.name && storedName) next.name = storedName;
    setSession(next);
  }
  loadProfileFields();
  const msg = document.getElementById('adminProfileMsg');
  if(msg) msg.textContent = 'Profile cleared';
  updateUserChip();
}

function applyDensity(val){
  if(val === 'compact'){
    document.documentElement.classList.add('compact');
  }else{
    document.documentElement.classList.remove('compact');
  }
}

function applyFontSize(val){
  document.documentElement.style.setProperty('--font-scale', val === 'large' ? '1.1' : val === 'xlarge' ? '1.2' : '1');
  document.body.style.fontSize = `calc(16px * ${document.documentElement.style.getPropertyValue('--font-scale') || 1})`;
}

function initAppearanceSettings(){
  const themeSelect = document.getElementById('themeSelect');
  const densitySelect = document.getElementById('densitySelect');
  const fontSizeSelect = document.getElementById('fontSizeSelect');
  const languageSelect = document.getElementById('languageSelect');
  const timeFormatSelect = document.getElementById('timeFormatSelect');
  const shortcutToggles = document.querySelectorAll('.shortcut-toggle');
  const msg = document.getElementById('adminSettingsMsg');
  const appearanceSaveBtn = document.getElementById('appearanceSave');
  const shortcutsSaveBtn = document.getElementById('shortcutsSave');
  const localeSaveBtn = document.getElementById('localeSave');

  if(!themeSelect) return;

  const storedTheme = localStorage.getItem('theme') || 'light';
  themeSelect.value = storedTheme;
  const storedDensity = localStorage.getItem('density') || 'normal';
  densitySelect.value = storedDensity;
  const storedFontSize = localStorage.getItem('fontSize') || 'normal';
  fontSizeSelect.value = storedFontSize;
  const storedLang = localStorage.getItem('lang') || 'en-US';
  languageSelect.value = storedLang;
  const storedTimeFmt = localStorage.getItem('timeFmt') || '12h';
  timeFormatSelect.value = storedTimeFmt;

  const storedShortcuts = (localStorage.getItem('shortcuts') || '').split(',').filter(Boolean);
  shortcutToggles.forEach(cb=>{
    cb.checked = storedShortcuts.length === 0 ? true : storedShortcuts.includes(cb.value);
  });

  applyDensity(storedDensity);
  applyFontSize(storedFontSize);

  const saveAppearance = ()=>{
    const val = themeSelect.value;
    utils.setTheme?.(val);
    localStorage.setItem('density', densitySelect.value);
    applyDensity(densitySelect.value);
    localStorage.setItem('fontSize', fontSizeSelect.value);
    applyFontSize(fontSizeSelect.value);
    if(msg) msg.textContent = 'Appearance saved';
  };

  const saveLocale = ()=>{
    localStorage.setItem('lang', languageSelect.value);
    localStorage.setItem('timeFmt', timeFormatSelect.value);
    if(msg) msg.textContent = 'Language & time saved';
  };

  const saveShortcuts = ()=>{
    const enabled = Array.from(shortcutToggles).filter(x=>x.checked).map(x=>x.value);
    localStorage.setItem('shortcuts', enabled.join(','));
    if(msg) msg.textContent = 'Shortcuts saved';
  };

  themeSelect.addEventListener('change', saveAppearance);
  densitySelect.addEventListener('change', saveAppearance);
  fontSizeSelect.addEventListener('change', saveAppearance);
  languageSelect.addEventListener('change', saveLocale);
  timeFormatSelect.addEventListener('change', saveLocale);
  shortcutToggles.forEach(cb=>{
    cb.addEventListener('change', saveShortcuts);
  });

  appearanceSaveBtn?.addEventListener('click', saveAppearance);
  shortcutsSaveBtn?.addEventListener('click', saveShortcuts);
  localeSaveBtn?.addEventListener('click', saveLocale);
}

function initInstallLink(){
  const btn = document.getElementById('installAppBtn');
  const msg = document.getElementById('installAppMsg');
  if(!btn || !msg || !window.utils) return;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  const isStandalone = ()=> (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
  const update = ()=>{
    if(isStandalone()){
      msg.textContent = 'App already installed.';
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    if(utils.canPromptInstall?.()){
      msg.textContent = 'Ready to install.';
    }else if(isIos){
      msg.textContent = 'On iOS: Share > Add to Home Screen.';
    }else{
      msg.textContent = 'Use browser menu > Install app.';
    }
  };
  btn.addEventListener('click', async ()=>{
    if(isStandalone()){
      update();
      return;
    }
    const result = await utils.promptInstall?.();
    if(result?.outcome === 'accepted'){
      msg.textContent = 'Install started.';
    }else if(result?.outcome === 'dismissed'){
      msg.textContent = 'Install dismissed.';
    }else{
      msg.textContent = isIos ? 'On iOS: Share > Add to Home Screen.' : 'Install option not available yet.';
    }
  });
  window.addEventListener('beforeinstallprompt', ()=> setTimeout(update, 0));
  window.addEventListener('appinstalled', update);
  update();
}

function setupTabs(){
  const buttons = document.querySelectorAll('.settings-tab');
  const panels = {
    appearance: document.getElementById('panelAppearance'),
    profile: document.getElementById('panelProfile'),
    shortcuts: document.getElementById('panelShortcuts'),
    locale: document.getElementById('panelLocale'),
    users: document.getElementById('panelUsers')
  };
  const show = (tab)=>{
    buttons.forEach(btn=> btn.classList.toggle('active', btn.dataset.tab === tab));
    Object.keys(panels).forEach(key=>{
      if(panels[key]) panels[key].style.display = key === tab ? '' : 'none';
    });
  };
  buttons.forEach(btn=>{
    btn.addEventListener('click', ()=> show(btn.dataset.tab));
  });
  const hash = (window.location.hash || '').replace('#','');
  const startTab = panels[hash] ? hash : 'users';
  show(startTab);
}

const usersCache = [];

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

function generateTempPassword(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
  let pwd = '';
  for(let i=0;i<12;i++){
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

function formatDateTimeSafe(val){
  if(window.utils?.formatDateTime) return utils.formatDateTime(val);
  if(!val) return '';
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function formatRoleLabel(role){
  const r = (role || '').toLowerCase();
  if(r === 'admin') return 'Admin';
  if(r === 'manager') return 'Manager';
  return 'Employee';
}

function updateUserStats(allUsers, visibleUsers){
  const total = allUsers.length;
  const admins = allUsers.filter(u=> u.role === 'admin').length;
  const managers = allUsers.filter(u=> u.role === 'manager').length;
  const employees = allUsers.filter(u=> u.role !== 'admin' && u.role !== 'manager').length;
  const setText = (id, val)=>{
    const el = document.getElementById(id);
    if(el) el.textContent = `${val}`;
  };
  setText('userTotal', total);
  setText('userAdmins', admins);
  setText('userManagers', managers);
  setText('userEmployees', employees);
  setText('userShowing', visibleUsers.length);
}

function applyUserFilters(allUsers){
  const search = (document.getElementById('userSearch')?.value || '').toLowerCase();
  const roleFilter = document.getElementById('userRoleFilter')?.value || '';
  const sort = document.getElementById('userSort')?.value || 'az';
  let filtered = allUsers.slice();
  if(search){
    filtered = filtered.filter(u=>{
      const email = (u.email || '').toLowerCase();
      const name = (u.name || '').toLowerCase();
      return email.includes(search) || name.includes(search);
    });
  }
  if(roleFilter){
    filtered = filtered.filter(u=>{
      const role = (u.role || '').toLowerCase();
      if(roleFilter === 'employee'){
        return role === 'employee' || role === 'user' || (role !== 'admin' && role !== 'manager');
      }
      return role === roleFilter;
    });
  }
  if(sort === 'az'){
    filtered.sort((a,b)=> (a.email || '').localeCompare(b.email || ''));
  }else if(sort === 'za'){
    filtered.sort((a,b)=> (b.email || '').localeCompare(a.email || ''));
  }else if(sort === 'newest'){
    filtered.sort((a,b)=> (b.createdAt || 0) - (a.createdAt || 0));
  }else if(sort === 'oldest'){
    filtered.sort((a,b)=> (a.createdAt || 0) - (b.createdAt || 0));
  }
  updateUserStats(allUsers, filtered);
  return filtered;
}

async function updateUserRole(user, role){
  if(!user?.id) return false;
  try{
    const payload = { name: user.name || '', email: user.email || '', role };
    const r = await fetch(`/api/users/${user.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    return r.ok;
  }catch(e){
    return false;
  }
}

async function deleteUser(user){
  if(!user?.id) return false;
  try{
    const r = await fetch(`/api/users/${user.id}`,{method:'DELETE'});
    return r.ok;
  }catch(e){
    return false;
  }
}

function renderUsersTable(allUsers){
  const tbody=document.querySelector('#usersTable tbody');tbody.innerHTML='';
  const users = applyUserFilters(allUsers);
  if(!users.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="5" style="text-align:center;color:#6b7280;">No users yet</td>`;
    tbody.appendChild(tr);
    updateUserStats(allUsers, users);
    return;
  }
  users.forEach(u=>{
    const tr=document.createElement('tr');
    const dt = formatDateTimeSafe(u.createdAt);
    const rawRole = (u.role || '').toLowerCase();
    const normalizedRole = rawRole === 'user' || !rawRole ? 'employee' : rawRole;
    const roleLabel = formatRoleLabel(normalizedRole);
    const roleToggle = normalizedRole === 'admin' ? 'Demote to Employee' : 'Make Admin';
    const btn = `
      <button type="button" class="action-btn edit-user" data-id="${u.id}" data-email="${u.email}" data-name="${u.name||''}" data-role="${normalizedRole}">Edit</button>
      <button type="button" class="action-btn role-user" data-id="${u.id}">${roleToggle}</button>
      <button type="button" class="action-btn delete-user" data-id="${u.id}">Delete</button>
    `;
    tr.innerHTML=`<td>${u.email}</td><td>${u.name||''}</td><td>${roleLabel}</td><td>${dt}</td><td>${btn}</td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.edit-user').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.getElementById('edit-userId').value = btn.dataset.id;
      document.getElementById('edit-userName').value = btn.dataset.name || '';
      document.getElementById('edit-userEmail').value = btn.dataset.email || '';
      const role = (btn.dataset.role || '').toLowerCase();
      document.getElementById('edit-userRole').value = role === 'user' ? 'employee' : (role || 'employee');
      document.getElementById('edit-userPassword').value = '';
      document.getElementById('edit-userError').textContent = '';
      const meta = document.getElementById('edit-userMeta');
      if(meta) meta.textContent = `Editing user: ${btn.dataset.email || ''}`;
      openEditUserModal();
    });
  });
  tbody.querySelectorAll('.role-user').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.id;
      const user = allUsers.find(u=> u.id === id);
      if(!user) return;
      const currentRole = (user.role || '').toLowerCase();
      const normalizedRole = currentRole === 'user' || !currentRole ? 'employee' : currentRole;
      const nextRole = normalizedRole === 'admin' ? 'employee' : 'admin';
      if(!confirm(`Change role for ${user.email} to ${nextRole}?`)) return;
      const ok = await updateUserRole(user, nextRole);
      if(!ok) alert('Failed to update role');
      await refreshUsers();
    });
  });
  tbody.querySelectorAll('.delete-user').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.id;
      const user = allUsers.find(u=> u.id === id);
      const session = getSession();
      if(!user) return;
      if(session?.id === user.id){
        alert('You cannot delete your own account.');
        return;
      }
      if(!confirm(`Delete user ${user.email}? This cannot be undone.`)) return;
      const ok = await deleteUser(user);
      if(!ok) alert('Failed to delete user');
      await refreshUsers();
    });
  });
}

async function refreshUsers(){
  const session = getSession();
  if(!session) return;
  const users = await loadUsers(session.role);
  usersCache.length = 0;
  usersCache.push(...users);
  renderUsersTable(usersCache);
}

function exportUsersCSV(){
  const rows = applyUserFilters(usersCache);
  if(!rows.length){alert('No users to export');return;}
  const hdr = ['email','name','role','createdAt'];
  const data = rows.map(u=>[u.email,u.name || '',u.role || '',u.createdAt || '']);
  const csv = [hdr.join(','),...data.map(r=>r.map(c=>`"${String(c ?? '').replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob = new Blob([csv],{type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'users.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openEditUserModal(){
  const modal = document.getElementById('editUserModal');
  if(modal) modal.classList.remove('hidden');
}

function closeEditUserModal(){
  const modal = document.getElementById('editUserModal');
  if(modal) modal.classList.add('hidden');
  const editForm = document.getElementById('editUserForm');
  if(editForm) editForm.reset();
  const editErr = document.getElementById('edit-userError');
  if(editErr) editErr.textContent = '';
  const meta = document.getElementById('edit-userMeta');
  if(meta) meta.textContent = 'Editing user:';
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
  const refreshBtn = document.getElementById('refreshSessionBtn');
  refreshBtn?.addEventListener('click', async ()=>{
    const msg = document.getElementById('adminSettingsMsg');
    if(msg) msg.textContent = 'Refreshing access...';
    const fresh = await utils.refreshSession?.();
    if(!fresh){
      if(msg) msg.textContent = 'Unable to refresh access.';
      return;
    }
    setSession(fresh);
    utils.applyNavVisibility?.();
    if(fresh.role !== 'admin'){
      window.location.href = utils.getDashboardHref?.(fresh.role) || 'employee-dashboard.html';
      return;
    }
    if(msg) msg.textContent = `Access refreshed as ${formatRoleLabel(fresh.role)}.`;
  });
  setupTabs();
  initAppearanceSettings();
  initInstallLink();
  refreshUsers();
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
    refreshUsers();
  });
  document.getElementById('userClearBtn').addEventListener('click',()=>{form.reset();err.textContent='';});
  document.getElementById('userGeneratePwd')?.addEventListener('click', ()=>{
    const pwd = generateTempPassword();
    document.getElementById('userPassword').value = pwd;
    err.textContent = `Generated password: ${pwd}`;
  });

  // Edit user
  const editForm = document.getElementById('editUserForm');
  const editErr = document.getElementById('edit-userError');
  editForm.addEventListener('submit', async ev=>{
    ev.preventDefault();
    editErr.textContent='';
    const id = document.getElementById('edit-userId').value;
    if(!id){ editErr.textContent='Select a user from the table first.'; return; }
    const rawRole = document.getElementById('edit-userRole').value;
    const payload = {
      name: document.getElementById('edit-userName').value.trim(),
      email: document.getElementById('edit-userEmail').value.trim(),
      role: rawRole === 'user' ? 'employee' : rawRole
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
      closeEditUserModal();
      await refreshUsers();
    }catch(e){
      editErr.textContent = 'Unable to update user';
    }
  });
  document.getElementById('edit-userClearBtn').addEventListener('click',()=>{editForm.reset();editErr.textContent='';});
  document.getElementById('edit-generatePassword')?.addEventListener('click', ()=>{
    const pwd = generateTempPassword();
    document.getElementById('edit-userPassword').value = pwd;
    editErr.textContent = `Temp password generated: ${pwd}`;
  });
  document.getElementById('editUserClose')?.addEventListener('click', closeEditUserModal);
  document.getElementById('edit-userCancel')?.addEventListener('click', closeEditUserModal);
  document.getElementById('editUserModal')?.addEventListener('click', ev=>{
    if(ev.target === ev.currentTarget) closeEditUserModal();
  });
  document.addEventListener('keydown', ev=>{
    const modal = document.getElementById('editUserModal');
    if(ev.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeEditUserModal();
  });

  document.getElementById('userSearch')?.addEventListener('input', ()=> renderUsersTable(usersCache));
  document.getElementById('userRoleFilter')?.addEventListener('change', ()=> renderUsersTable(usersCache));
  document.getElementById('userSort')?.addEventListener('change', ()=> renderUsersTable(usersCache));
  document.getElementById('userRefreshBtn')?.addEventListener('click', refreshUsers);
  document.getElementById('userExportBtn')?.addEventListener('click', exportUsersCSV);

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
      utils.setProfileValue?.('pic', data);
      const msg = document.getElementById('adminProfileMsg');
      if(msg) msg.textContent = 'Profile picture updated';
      updateUserChip();
    });
  }
});
