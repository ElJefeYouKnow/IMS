(function(global){
  const utils = {
    async fetchJsonSafe(url, options = {}, fallback = null){
      try{
        const res = await fetch(url, options);
        if(!res.ok) throw new Error(res.statusText);
        return await res.json();
      }catch(e){
        return fallback;
      }
    },
    attachItemLookup({ getItems, codeInputId, nameInputId, categoryInputId, priceInputId, suggestionsId }){
      const codeInput = document.getElementById(codeInputId);
      const suggestionsDiv = document.getElementById(suggestionsId);
      if(!codeInput || !suggestionsDiv) return;
      const fillFields = (item)=>{
        if(nameInputId) document.getElementById(nameInputId).value = item.name || '';
        if(categoryInputId) document.getElementById(categoryInputId).value = item.category || '';
        if(priceInputId) document.getElementById(priceInputId).value = item.unitPrice || '';
      };
      codeInput.addEventListener('input', ()=>{
        const val = codeInput.value.trim().toLowerCase();
        suggestionsDiv.innerHTML = '';
        if(!val) return;
        const items = (typeof getItems === 'function' ? getItems() : []) || [];
        const matches = items.filter(i=> i.code.toLowerCase().includes(val)).slice(0,5);
        matches.forEach(item=>{
          const div = document.createElement('div');
          div.textContent = item.code;
          div.style.padding = '8px';
          div.style.cursor = 'pointer';
          div.style.borderBottom = '1px solid #eee';
          div.addEventListener('click', ()=>{
            codeInput.value = item.code;
            fillFields(item);
            suggestionsDiv.innerHTML = '';
          });
          suggestionsDiv.appendChild(div);
        });
      });
    },
    setupLogout(){
      const btn = document.getElementById('logoutBtn');
      if(btn){
        btn.addEventListener('click', ()=>{
          localStorage.removeItem('sessionUser');
          fetch('/api/auth/logout',{method:'POST'}).finally(()=>{
            window.location.href='login.html';
          });
        });
      }
    },
    profileKey(suffix, userOverride){
      const user = userOverride || this.getSession?.();
      const tenant = (user?.tenantId || user?.tenantid || 'default').toLowerCase();
      const id = user?.id || user?.userid || user?.email || 'anon';
      return `profile.${tenant}.${id}.${suffix}`;
    },
    getProfileValue(suffix){
      const key = this.profileKey?.(suffix);
      let val = key ? localStorage.getItem(key) : null;
      if(val) return val;
      const legacyMap = { name: 'profileName', avatar: 'profileAvatar', pic: 'profilePicData' };
      const legacyKey = legacyMap[suffix];
      if(!legacyKey) return null;
      const legacyVal = localStorage.getItem(legacyKey);
      if(legacyVal && key){
        localStorage.setItem(key, legacyVal);
        localStorage.removeItem(legacyKey);
        return legacyVal;
      }
      return legacyVal;
    },
    setProfileValue(suffix, value){
      const key = this.profileKey?.(suffix);
      if(!key) return;
      if(value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    },
    clearProfileValues(){
      ['name','avatar','pic'].forEach(suffix=>{
        const key = this.profileKey?.(suffix);
        if(key) localStorage.removeItem(key);
      });
    },
    setupUserChip(){
      const chip = document.querySelector('.user-chip');
      if(!chip) return;
      if(!chip.dataset.bound){
        chip.dataset.bound = 'true';
        chip.addEventListener('click', ()=>{
          const user = this.getSession();
          if(user?.role === 'admin') window.location.href='settings.html';
          else window.location.href='settings-employee.html';
        });
      }
      const avatar = chip.querySelector('.avatar');
      const infoWrap = chip.querySelector('.user-info') || chip.querySelector('div:nth-child(2)');
      const name = infoWrap ? (infoWrap.querySelector('.user-name') || infoWrap.querySelector('div:nth-child(1)')) : null;
      const roleText = infoWrap ? (infoWrap.querySelector('.user-role') || infoWrap.querySelector('div:nth-child(2)')) : null;
      const user = this.getSession();
      const profileName = this.getProfileValue?.('name') || '';
      const profileAvatar = this.getProfileValue?.('avatar') || '';
      const profilePic = this.getProfileValue?.('pic') || '';
      const displayName = profileName || user?.name || user?.email || 'User';
      if(user){
        if(avatar){
          if(profilePic){
            avatar.textContent = '';
            avatar.style.backgroundImage = `url(${profilePic})`;
            avatar.style.backgroundSize = 'cover';
            avatar.style.backgroundPosition = 'center';
            avatar.classList.add('has-photo');
          }else{
            avatar.classList.remove('has-photo');
            avatar.style.backgroundImage = '';
            const initials = profileAvatar || displayName.slice(0,2);
            avatar.textContent = initials.toUpperCase();
          }
        }
        if(name) name.textContent = displayName;
        if(roleText) roleText.textContent = user.role ? user.role.charAt(0).toUpperCase()+user.role.slice(1) : 'User';
      }
    },
    requireSession(){
      const user = this.getSession();
      if(!user){
        window.location.href = 'login.html';
        return false;
      }
      return true;
    },
    getSession(){
      try{return JSON.parse(localStorage.getItem('sessionUser')||'null');}catch(e){return null;}
    },
    async initSession(){
      return this.getSession();
    },
    addAuthHeaders(options={}){
      const headers = options.headers ? {...options.headers} : {};
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      return { ...options, headers };
    },
    applyStoredTheme(){
      const theme = localStorage.getItem('theme') || 'light';
      this.setTheme(theme, false);
    },
    setTheme(theme, persist=true){
      const root = document.documentElement;
      if(theme === 'dark'){
        root.classList.add('dark');
      }else{
        root.classList.remove('dark');
      }
      if(persist) localStorage.setItem('theme', theme);
    },
    requireRole(role){
      const user = this.getSession();
      if(!user){
        window.location.href='login.html';
        return;
      }
      if(role === 'admin' && user.role !== 'admin'){
        window.location.href = 'employee-dashboard.html';
      }else if(role === 'employee' && user.role === 'admin'){
        window.location.href = 'dashboard.html';
      }
    },
    applyNavVisibility(){
      this.buildMobileNav?.();
      this.registerServiceWorker?.();
      const user = this.getSession();
      document.body.classList.remove('role-admin','role-employee','role-manager','role-none');
      if(!user){
        document.body.classList.add('role-none');
        return;
      }
      const role = (user.role || '').toLowerCase();
      const tenant = (user.tenantId || user.tenantid || '').toLowerCase();
      const isDev = role === 'dev' || tenant === 'dev';
      if(role === 'admin'){
        document.body.classList.add('role-admin');
      }else if(role === 'manager'){
        document.body.classList.add('role-manager');
        document.body.classList.add('role-employee'); // Inherit employee visibility by default
      }else{
        document.body.classList.add('role-employee');
      }
      document.querySelectorAll('[data-dev-only]').forEach(el=>{
        el.style.display = isDev ? '' : 'none';
      });
      if(isDev){
        const nav = document.querySelector('.sidebar nav');
        if(nav && !nav.querySelector('a[data-dev-only][href="seller-admin.html"]')){
          const link = document.createElement('a');
          link.href = 'seller-admin.html';
          link.dataset.devOnly = '';
          link.textContent = 'Seller Admin';
          nav.appendChild(link);
        }
      }
      this.setupUserChip?.();
    },
    buildMobileNav(){
      if(document.querySelector('.bottom-nav')) return;
      const sourceLinks = Array.from(document.querySelectorAll('.sidebar nav a'));
      if(!sourceLinks.length) return;
      let backdrop = document.querySelector('.bottom-nav-backdrop');
      if(!backdrop){
        backdrop = document.createElement('div');
        backdrop.className = 'bottom-nav-backdrop';
        document.body.appendChild(backdrop);
      }
      const nav = document.createElement('nav');
      nav.className = 'bottom-nav collapsed';
      const toggle = document.createElement('button');
      toggle.className = 'nav-toggle';
      toggle.type = 'button';
      toggle.textContent = 'Menu';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', 'mobileNavItems');
      const wrap = document.createElement('div');
      wrap.className = 'nav-items';
      wrap.id = 'mobileNavItems';
      const dedup = new Set();
      sourceLinks.forEach(l=>{
        const href = l.getAttribute('href');
        if(!href || dedup.has(href)) return;
        dedup.add(href);
        const a = document.createElement('a');
        a.href = href;
        a.textContent = l.textContent || href;
        if(l.dataset.role) a.dataset.role = l.dataset.role;
        if(window.location.pathname.endsWith(href)) a.classList.add('active');
        wrap.appendChild(a);
      });
      nav.appendChild(toggle);
      nav.appendChild(wrap);
      document.body.appendChild(nav);
      const setExpanded = (expanded)=>{
        nav.classList.toggle('expanded', expanded);
        nav.classList.toggle('collapsed', !expanded);
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggle.textContent = expanded ? 'Close Menu' : 'Menu';
        backdrop.classList.toggle('active', expanded);
      };
      setExpanded(false);
      toggle.addEventListener('click', ()=> setExpanded(!nav.classList.contains('expanded')));
      backdrop.addEventListener('click', ()=> setExpanded(false));
      wrap.addEventListener('click', (event)=>{
        if(event.target && event.target.tagName === 'A') setExpanded(false);
      });
      document.addEventListener('keydown', (event)=>{
        if(event.key === 'Escape') setExpanded(false);
      });
    },
    registerServiceWorker(){
      // Disabled to ensure UI changes are picked up immediately; re-enable if offline caching is required.
      return;
    },
    wrapFetchWithRole(){
      if(this._fetchWrapped) return;
      this._fetchWrapped = true;
      const self = this;
      const orig = window.fetch.bind(window);
      window.fetch = (url, options={})=>{
        const opts = {...options};
        opts.headers = new Headers(options.headers || {});
        const user = self.getSession();
        if(user?.role) opts.headers.set('x-user-role', user.role);
        return orig(url, opts);
      };
    },
    initClock(){
      if(this._clockInit) return;
      this._clockInit = true;
      const ensureClock = ()=>{
        if(document.querySelector('.clock-pill')) return;
        const target = document.querySelector('.topbar-right');
        const wrap = document.createElement('div');
        wrap.className = target ? 'clock-pill' : 'clock-pill corner-clock';
        wrap.innerHTML = '<span class="clock-label">Now</span><span class="clock-value"></span>';
        if(target) target.prepend(wrap);
        else document.body.appendChild(wrap);
      };
      const tick = ()=>{
        const label = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        document.querySelectorAll('.clock-value').forEach(el=>{ el.textContent = label; });
      };
      const start = ()=>{
        ensureClock();
        tick();
        setInterval(tick, 60000);
      };
      if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
      else start();
    }
  };

  // Date/time helpers
  utils.parseTs = function(val){
    if(val === undefined || val === null) return null;
    if(typeof val === 'number') return val;
    if(typeof val === 'string'){
      if(/^\d+$/.test(val)) return Number(val);
      const t = Date.parse(val);
      return Number.isNaN(t) ? null : t;
    }
    return null;
  };
  utils.formatDateTime = function(val){
    const ts = utils.parseTs(val);
    if(ts === null) return '';
    const d = new Date(ts);
    if(Number.isNaN(d.getTime())) return '';
    const opts = { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' };
    return d.toLocaleString([], opts);
  };
  utils.formatDateOnly = function(val){
    const ts = utils.parseTs(val);
    if(ts === null) return '';
    const d = new Date(ts);
    if(Number.isNaN(d.getTime())) return '';
    const opts = { year:'numeric', month:'short', day:'2-digit' };
    return d.toLocaleDateString([], opts);
  };

  global.utils = utils;
  utils.initClock?.();
})(window);
