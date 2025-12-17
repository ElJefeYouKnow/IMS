document.addEventListener('DOMContentLoaded', ()=>{
  if(window.utils){
    utils.requireRole?.('employee');
    utils.applyNavVisibility?.();
    utils.setupLogout?.();
    utils.applyStoredTheme?.();
  }
  const themeSelect = document.getElementById('themeSelect');
  const densitySelect = document.getElementById('densitySelect');
  const msg = document.getElementById('empSettingsMsg');

  // Load stored prefs
  const storedTheme = localStorage.getItem('theme') || 'light';
  themeSelect.value = storedTheme;
  const storedDensity = localStorage.getItem('density') || 'normal';
  densitySelect.value = storedDensity;
  applyDensity(storedDensity);

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
});

function applyDensity(val){
  if(val === 'compact'){
    document.documentElement.classList.add('compact');
  }else{
    document.documentElement.classList.remove('compact');
  }
}
