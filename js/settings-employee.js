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

  profileName.value = localStorage.getItem('profileName') || '';
  profileAvatar.value = localStorage.getItem('profileAvatar') || '';
  // Load picture (we only keep the latest as data URL)
  const storedPic = localStorage.getItem('profilePicData');
  if(profilePicture && storedPic){
    profilePicture.setAttribute('data-preview','loaded');
  }

  applyDensity(storedDensity);
  applyFontSize(storedFontSize);

  themeSelect.addEventListener('change', ()=>{
    const val = themeSelect.value;
    utils.setTheme?.(val);
    msg.textContent = `Theme set to ${val}`;
  });

  densitySelect.addEventListener('change', ()=>{
    const val = densitySelect.value;
    localStorage.setItem('density', val);
    applyDensity(val);
    msg.textContent = `Density set to ${val}`;
  });

  fontSizeSelect.addEventListener('change', ()=>{
    const val = fontSizeSelect.value;
    localStorage.setItem('fontSize', val);
    applyFontSize(val);
    msg.textContent = `Font size set to ${val}`;
  });

  languageSelect.addEventListener('change', ()=>{
    localStorage.setItem('lang', languageSelect.value);
    msg.textContent = `Language/region set to ${languageSelect.value}`;
  });

  timeFormatSelect.addEventListener('change', ()=>{
    localStorage.setItem('timeFmt', timeFormatSelect.value);
    msg.textContent = `Time format set to ${timeFormatSelect.value}`;
  });

  shortcutToggles.forEach(cb=>{
    cb.addEventListener('change', ()=>{
      const enabled = Array.from(shortcutToggles).filter(x=>x.checked).map(x=>x.value);
      localStorage.setItem('shortcuts', enabled.join(','));
      msg.textContent = 'Shortcuts updated';
    });
  });

  profileName.addEventListener('change', ()=>{
    localStorage.setItem('profileName', profileName.value.trim());
    msg.textContent = 'Profile name saved';
  });
  profileAvatar.addEventListener('change', ()=>{
    localStorage.setItem('profileAvatar', profileAvatar.value.trim().toUpperCase());
    msg.textContent = 'Avatar initials saved';
  });

  if(profilePicture){
    profilePicture.addEventListener('change', async (e)=>{
      const file = e.target.files && e.target.files[0];
      if(!file) return;
      const data = await fileToDataUrl(file);
      // Only store the newest picture
      localStorage.setItem('profilePicData', data);
      msg.textContent = 'Profile picture updated';
    });
  }

  // Tabs
  setupTabs();
});

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
    locale: document.getElementById('panelLocale')
  };
  const buttons = {
    appearance: document.getElementById('tabAppearance'),
    profile: document.getElementById('tabProfile'),
    shortcuts: document.getElementById('tabShortcuts'),
    locale: document.getElementById('tabLocale')
  };
  const show = (key)=>{
    Object.keys(panels).forEach(k=>{
      panels[k].style.display = k === key ? '' : 'none';
      if(buttons[k]) buttons[k].classList.toggle('active', k === key);
    });
  };
  if(buttons.appearance) buttons.appearance.addEventListener('click',()=>show('appearance'));
  if(buttons.profile) buttons.profile.addEventListener('click',()=>show('profile'));
  if(buttons.shortcuts) buttons.shortcuts.addEventListener('click',()=>show('shortcuts'));
  if(buttons.locale) buttons.locale.addEventListener('click',()=>show('locale'));
  show('appearance');
}
