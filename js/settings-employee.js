document.addEventListener('DOMContentLoaded', ()=>{
  if(window.utils){
    utils.requireRole?.('employee');
    utils.applyNavVisibility?.();
    utils.setupLogout?.();
    utils.applyStoredTheme?.();
  }
  const themeSelect = document.getElementById('themeSelect');
  const densitySelect = document.getElementById('densitySelect');
  const fontSizeSelect = document.getElementById('fontSizeSelect');
  const languageSelect = document.getElementById('languageSelect');
  const timeFormatSelect = document.getElementById('timeFormatSelect');
  const shortcutToggles = document.querySelectorAll('.shortcut-toggle');
  const profileName = document.getElementById('profileName');
  const profileAvatar = document.getElementById('profileAvatar');
  const profilePicture = document.getElementById('profilePicture');
  const msg = document.getElementById('empSettingsMsg');
  const appearanceSaveBtn = document.getElementById('appearanceSave');
  const profileSaveBtn = document.getElementById('profileSave');
  const shortcutsSaveBtn = document.getElementById('shortcutsSave');
  const localeSaveBtn = document.getElementById('localeSave');
  const refreshBtn = document.getElementById('refreshSessionBtn');
  const session = window.utils?.getSession?.();

  // Load stored prefs
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

  profileName.value = session?.name || '';
  const avatarFallback = session?.name ? session.name.slice(0,2).toUpperCase() : '';
  profileAvatar.value = utils.getProfileValue?.('avatar') || avatarFallback;
  // Load picture (we only keep the latest as data URL)
  const storedPic = utils.getProfileValue?.('pic');
  if(profilePicture && storedPic){
    profilePicture.setAttribute('data-preview','loaded');
  }

  applyDensity(storedDensity);
  applyFontSize(storedFontSize);

  const saveAppearance = ()=>{
    const val = themeSelect.value;
    utils.setTheme?.(val);
    localStorage.setItem('density', densitySelect.value);
    applyDensity(densitySelect.value);
    localStorage.setItem('fontSize', fontSizeSelect.value);
    applyFontSize(fontSizeSelect.value);
    msg.textContent = 'Appearance saved';
  };

  const saveLocale = ()=>{
    localStorage.setItem('lang', languageSelect.value);
    localStorage.setItem('timeFmt', timeFormatSelect.value);
    msg.textContent = 'Language & time saved';
  };

  const saveShortcuts = ()=>{
    const enabled = Array.from(shortcutToggles).filter(x=>x.checked).map(x=>x.value);
    localStorage.setItem('shortcuts', enabled.join(','));
    msg.textContent = 'Shortcuts saved';
  };

  const saveProfile = ()=>{
    const nameVal = profileName.value.trim();
    const avatarVal = profileAvatar.value.trim().toUpperCase();
    utils.setProfileValue?.('avatar', avatarVal);
    updateUserChip();
    msg.textContent = 'Profile saved';
  };

  themeSelect.addEventListener('change', saveAppearance);
  densitySelect.addEventListener('change', saveAppearance);
  fontSizeSelect.addEventListener('change', saveAppearance);
  languageSelect.addEventListener('change', saveLocale);
  timeFormatSelect.addEventListener('change', saveLocale);
  shortcutToggles.forEach(cb=>{
    cb.addEventListener('change', saveShortcuts);
  });
  profileName.addEventListener('change', saveProfile);
  profileAvatar.addEventListener('change', saveProfile);

  if(profilePicture){
    profilePicture.addEventListener('change', async (e)=>{
      const file = e.target.files && e.target.files[0];
      if(!file) return;
      const data = await fileToDataUrl(file);
      // Only store the newest picture
      utils.setProfileValue?.('pic', data);
      msg.textContent = 'Profile picture saved';
      updateUserChip();
    });
  }

  appearanceSaveBtn?.addEventListener('click', saveAppearance);
  localeSaveBtn?.addEventListener('click', saveLocale);
  shortcutsSaveBtn?.addEventListener('click', saveShortcuts);
  profileSaveBtn?.addEventListener('click', saveProfile);
  refreshBtn?.addEventListener('click', async ()=>{
    msg.textContent = 'Refreshing access...';
    const fresh = await utils.refreshSession?.();
    if(!fresh){
      msg.textContent = 'Unable to refresh access.';
      return;
    }
    utils.applyNavVisibility?.();
    const roleLabel = (role)=>{
      const r = (role || '').toLowerCase();
      if(r === 'admin' || r === 'dev') return 'Admin';
      if(r === 'manager') return 'Manager';
      return 'Employee';
    };
    msg.textContent = `Access refreshed as ${roleLabel(fresh.role)}.`;
    const target = utils.getDashboardHref?.(fresh.role);
    if(target && !window.location.pathname.endsWith('settings-employee.html') && !window.location.pathname.endsWith(target)){
      window.location.href = target;
    }
  });

  // Tabs
  setupTabs();
  initInstallLink();
});

function updateSessionName(name){
  if(!name) return;
  try{
    const raw = localStorage.getItem('sessionUser');
    if(!raw) return;
    const session = JSON.parse(raw);
    session.name = name;
    localStorage.setItem('sessionUser', JSON.stringify(session));
  }catch(e){}
}

function updateUserChip(){
  if(window.utils){
    utils.setupUserChip?.();
  }
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

async function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function setupTabs(){
  const panels = {
    appearance: document.getElementById('panelAppearance'),
    profile: document.getElementById('panelProfile'),
    shortcuts: document.getElementById('panelShortcuts'),
    locale: document.getElementById('panelLocale'),
    users: document.getElementById('panelUsers')
  };
  const buttons = {
    appearance: document.getElementById('tabAppearance'),
    profile: document.getElementById('tabProfile'),
    shortcuts: document.getElementById('tabShortcuts'),
    locale: document.getElementById('tabLocale'),
    users: document.getElementById('tabUsers')
  };
  const show = (key)=>{
    Object.keys(panels).forEach(k=>{
      if(panels[k]) panels[k].style.display = k === key ? '' : 'none';
      if(buttons[k]) buttons[k].classList.toggle('active', k === key);
    });
  };
  if(buttons.appearance) buttons.appearance.addEventListener('click',()=>show('appearance'));
  if(buttons.profile) buttons.profile.addEventListener('click',()=>show('profile'));
  if(buttons.shortcuts) buttons.shortcuts.addEventListener('click',()=>show('shortcuts'));
  if(buttons.locale) buttons.locale.addEventListener('click',()=>show('locale'));
  show('appearance');
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
