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
          window.location.href='login.html';
        });
      }
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
      const selector = '.sidebar nav a, .mobile-nav a, .bottom-nav a';
      const links = document.querySelectorAll(selector);
      links.forEach(a=>{
        const role = a.dataset.role;
        // Keep dashboard/settings links always visible to avoid accidental hiding
        const label = (a.textContent || '').toLowerCase();
        const alwaysVisible = label.includes('dashboard') || label.includes('settings');
        if(!role){
          // non-role links stay visible regardless of auth
          return;
        }
        if(alwaysVisible){
          a.style.display = '';
          return;
        }
        if(!user){
          a.style.display = 'none';
          return;
        }
        const isAdmin = user.role === 'admin';
        const isEmployee = !isAdmin; // treat non-admin as employee/user
        if(role === 'admin' && !isAdmin) a.style.display='none';
        else if(role === 'employee' && !isEmployee) a.style.display='none';
        else a.style.display='';
      });
    },
    buildMobileNav(){
      // repurpose to build bottom nav if not present
      if(document.querySelector('.bottom-nav')) return;
      const sourceLinks = Array.from(document.querySelectorAll('.sidebar nav a'));
      if(!sourceLinks.length) return;
      const nav = document.createElement('nav');
      nav.className = 'bottom-nav collapsed';
      const toggle = document.createElement('button');
      toggle.className = 'nav-toggle';
      toggle.type = 'button';
      toggle.textContent = 'Menu';
      const wrap = document.createElement('div');
      wrap.className = 'nav-items';
      const dedup = new Set();
      sourceLinks.forEach(l=>{
        const href = l.getAttribute('href');
        if(!href || dedup.has(href)) return;
        dedup.add(href);
        const a = document.createElement('a');
        a.href = href;
        a.textContent = l.textContent || href;
        if(l.dataset.role) a.dataset.role = l.dataset.role;
        if(l.classList.contains('always-visible')) a.classList.add('always-visible');
        if(window.location.pathname.endsWith(href)) a.classList.add('active');
        wrap.appendChild(a);
      });
      nav.appendChild(toggle);
      nav.appendChild(wrap);
      document.body.appendChild(nav);
      toggle.addEventListener('click', ()=> nav.classList.toggle('collapsed'));
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
    }
  };
  global.utils = utils;
})(window);
