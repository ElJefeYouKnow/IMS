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
      const profileAvatar = this.getProfileValue?.('avatar') || '';
      const profilePic = this.getProfileValue?.('pic') || '';
      const displayName = user?.name || user?.email || 'User';
      const roleLabel = (role)=>{
        const r = (role || '').toLowerCase();
        if(r === 'admin' || r === 'dev') return 'Admin';
        if(r === 'manager') return 'Manager';
        return 'Employee';
      };
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
        if(roleText) roleText.textContent = roleLabel(user.role);
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
    getDashboardHref(role){
      const r = (role || '').toLowerCase();
      if(r === 'admin' || r === 'dev') return 'dashboard.html';
      if(r === 'manager') return 'ops-dashboard.html';
      return 'employee-dashboard.html';
    },
    async refreshSession(){
      try{
        const res = await fetch('/api/auth/me');
        if(!res.ok) return null;
        const user = await res.json();
        if(user && user.id) localStorage.setItem('sessionUser', JSON.stringify(user));
        return user;
      }catch(e){
        return null;
      }
    },
    requireRole(role){
      const user = this.getSession();
      if(!user){
        window.location.href='login.html';
        return;
      }
      const isAllowed = (candidate)=>{
        const userRole = (candidate?.role || '').toLowerCase();
        const isAdmin = userRole === 'admin' || userRole === 'dev';
        if(role === 'admin') return isAdmin;
        if(role === 'manager') return userRole === 'manager';
        if(role === 'employee') return !(userRole === 'admin' || userRole === 'manager' || userRole === 'dev');
        return true;
      };
      if(isAllowed(user)) return;
      if(this._roleRefreshInFlight) return;
      this._roleRefreshInFlight = true;
      this.refreshSession?.().then(fresh=>{
        this._roleRefreshInFlight = false;
        const resolved = fresh || user;
        if(isAllowed(resolved)) return;
        const target = this.getDashboardHref(resolved?.role);
        window.location.href = target;
      }).catch(()=>{
        this._roleRefreshInFlight = false;
        window.location.href = this.getDashboardHref(user.role);
      });
    },
    applyNavVisibility(){
      this.ensureFleetNav?.();
      this.ensureLockedModules?.();
      this.buildMobileNav?.();
      this.registerServiceWorker?.();
      const applyForUser = (user)=>{
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
        this.ensureLockedModules?.();
        this.setupLockedModuleModal?.();
        this.setupUserChip?.();
      };

      const user = this.getSession();
      applyForUser(user);
      if(this._navRefreshInFlight) return;
      this._navRefreshInFlight = true;
      this.refreshSession?.().then(fresh=>{
        this._navRefreshInFlight = false;
        if(fresh && (!user || fresh.role !== user.role || fresh.id !== user.id)){
          applyForUser(fresh);
        }
      }).catch(()=>{ this._navRefreshInFlight = false; });
    },
    ensureFleetNav(){
      const nav = document.querySelector('.sidebar nav');
      if(!nav || nav.querySelector('a[href="fleet.html"]')) return;
      const link = document.createElement('a');
      link.href = 'fleet.html';
      link.textContent = 'Fleet & Equipment';
      if(window.location.pathname.endsWith('fleet.html')) link.classList.add('active');
      const anchor = nav.querySelector('a[href="inventory-list.html"]') || nav.lastElementChild;
      if(anchor && anchor.nextSibling){
        nav.insertBefore(link, anchor.nextSibling);
      }else{
        nav.appendChild(link);
      }
    },
    ensureLockedModules(){
      const nav = document.querySelector('.sidebar nav');
      if(!nav || nav.dataset.modulesInjected === 'true') return;
      nav.dataset.modulesInjected = 'true';
      const anchor = nav.querySelector('a[href="inventory-list.html"]') || nav.lastElementChild;
      const section = document.createElement('div');
      section.className = 'nav-section-label';
      section.textContent = 'Modules';
      if(anchor && anchor.nextSibling){
        nav.insertBefore(section, anchor.nextSibling);
      }else{
        nav.appendChild(section);
      }
      const fragment = document.createDocumentFragment();
      [
        { label: 'Orders', module: 'oms' },
        { label: 'People', module: 'bms' },
        { label: 'Finance', module: 'fms' }
      ].forEach((item)=>{
        const link = document.createElement('a');
        link.href = '#';
        link.textContent = item.label;
        link.className = 'nav-locked';
        link.dataset.locked = 'true';
        link.dataset.module = item.module;
        fragment.appendChild(link);
      });
      nav.insertBefore(fragment, section.nextSibling);
    },
    setupLockedModuleModal(){
      if(this._lockedModalReady) return;
      this._lockedModalReady = true;
      const ensureModal = ()=>{
        let modal = document.getElementById('lockedModuleModal');
        if(modal) return modal;
        modal = document.createElement('div');
        modal.id = 'lockedModuleModal';
        modal.className = 'locked-modal hidden';
        modal.innerHTML = `
          <div class="locked-modal-backdrop"></div>
          <div class="locked-modal-card" role="dialog" aria-modal="true">
            <h3>Coming soon</h3>
            <p>This module will be available as part of Modulr's modular expansion.</p>
            <button type="button" class="settings-action">Okay</button>
          </div>
        `;
        document.body.appendChild(modal);
        const close = ()=> modal.classList.add('hidden');
        modal.querySelector('.locked-modal-backdrop')?.addEventListener('click', close);
        modal.querySelector('button')?.addEventListener('click', close);
        return modal;
      };
      document.addEventListener('click', (event)=>{
        const link = event.target && event.target.closest && event.target.closest('[data-locked="true"]');
        if(!link) return;
        event.preventDefault();
        const modal = ensureModal();
        modal.classList.remove('hidden');
      });
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
      const main = document.createElement('div');
      main.className = 'nav-main';
      const makeIcon = (cls)=>{
        const span = document.createElement('span');
        span.className = `nav-icon ${cls}`.trim();
        span.setAttribute('aria-hidden', 'true');
        return span;
      };
      const makeLabel = (text)=>{
        const span = document.createElement('span');
        span.className = 'nav-label';
        span.textContent = text;
        return span;
      };
      const dashboardBtn = document.createElement('a');
      dashboardBtn.className = 'nav-main-btn';
      dashboardBtn.appendChild(makeIcon('icon-dashboard'));
      dashboardBtn.appendChild(makeLabel('Dashboard'));
      const opsBtn = document.createElement('a');
      opsBtn.className = 'nav-main-btn';
      opsBtn.appendChild(makeIcon('icon-ops'));
      opsBtn.appendChild(makeLabel('Ops'));
      const moreBtn = document.createElement('button');
      moreBtn.className = 'nav-main-btn nav-more';
      moreBtn.type = 'button';
      moreBtn.appendChild(makeIcon('icon-more'));
      moreBtn.appendChild(makeLabel('More'));
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.setAttribute('aria-controls', 'mobileNavItems');

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
        if(l.dataset.locked) a.dataset.locked = l.dataset.locked;
        if(l.dataset.module) a.dataset.module = l.dataset.module;
        if(l.classList.contains('nav-locked')) a.classList.add('nav-locked');
        if(window.location.pathname.endsWith(href)) a.classList.add('active');
        wrap.appendChild(a);
      });

      const role = (this.getSession?.()?.role || '').toLowerCase();
      dashboardBtn.href = this.getDashboardHref(role);
      opsBtn.href = 'inventory-operations.html';
      if(window.location.pathname.endsWith(dashboardBtn.href)) dashboardBtn.classList.add('active');
      if(window.location.pathname.endsWith(opsBtn.href)) opsBtn.classList.add('active');

      main.appendChild(dashboardBtn);
      main.appendChild(opsBtn);
      main.appendChild(moreBtn);
      nav.appendChild(main);
      nav.appendChild(wrap);
      document.body.appendChild(nav);

      const setExpanded = (expanded)=>{
        nav.classList.toggle('expanded', expanded);
        nav.classList.toggle('collapsed', !expanded);
        moreBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        const label = moreBtn.querySelector('.nav-label');
        if(label) label.textContent = expanded ? 'Close' : 'More';
        backdrop.classList.toggle('active', expanded);
      };
      setExpanded(false);
      moreBtn.addEventListener('click', ()=> setExpanded(!nav.classList.contains('expanded')));
      backdrop.addEventListener('click', ()=> setExpanded(false));
      wrap.addEventListener('click', (event)=>{
        if(event.target && event.target.tagName === 'A') setExpanded(false);
      });
      document.addEventListener('keydown', (event)=>{
        if(event.key === 'Escape') setExpanded(false);
      });
    },
    registerServiceWorker(){
      if(this._swRegistered) return;
      if(!('serviceWorker' in navigator)) return;
      this._swRegistered = true;
      window.addEventListener('load', ()=>{
        navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
      });
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
    },
    ensurePwaMeta(){
      if(this._pwaMetaInit) return;
      this._pwaMetaInit = true;
      const head = document.head;
      if(!head) return;
      const addMeta = (name, content)=>{
        if(head.querySelector(`meta[name="${name}"]`)) return;
        const meta = document.createElement('meta');
        meta.name = name;
        meta.content = content;
        head.appendChild(meta);
      };
      const addLink = (rel, href)=>{
        if(head.querySelector(`link[rel="${rel}"]`)) return;
        const link = document.createElement('link');
        link.rel = rel;
        link.href = href;
        head.appendChild(link);
      };
      addMeta('apple-mobile-web-app-capable', 'yes');
      addMeta('mobile-web-app-capable', 'yes');
      addMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
      addMeta('apple-mobile-web-app-title', 'IMS');
      addMeta('theme-color', '#132a24');
      addLink('manifest', 'manifest.json');
    },
    initGlobalSearch(){
      if(this._globalSearchInit) return;
      this._globalSearchInit = true;
      const init = ()=>{
        if(!document.querySelector('.app')) return;
        if(document.getElementById('globalSearchOverlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'globalSearchOverlay';
        overlay.className = 'search-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = `
          <div class="search-panel" role="dialog" aria-modal="true" aria-label="Global search">
            <div class="search-header">
              <input id="globalSearchInput" type="search" placeholder="Search items, projects, activity..." autocomplete="off" />
              <button class="search-close" type="button" aria-label="Close">Close</button>
            </div>
            <div id="globalSearchResults" class="search-results"></div>
            <div class="search-footer">Tip: Ctrl+K or /</div>
          </div>
        `;
        document.body.appendChild(overlay);

        const topbar = document.querySelector('.topbar-right');
        if(topbar && !topbar.querySelector('.search-trigger')){
          const trigger = document.createElement('button');
          trigger.type = 'button';
          trigger.className = 'search-trigger muted';
          trigger.textContent = 'Search';
          topbar.prepend(trigger);
          trigger.addEventListener('click', ()=> openSearch());
        }

        const main = document.querySelector('.main');
        const topbarWrap = main ? main.querySelector('.topbar') : document.querySelector('.topbar');
        let row = document.getElementById('globalSearchRow');
        if(!row){
          row = document.createElement('div');
          row.id = 'globalSearchRow';
          row.className = 'global-search-row';
          const trigger = document.createElement('button');
          trigger.type = 'button';
          trigger.className = 'search-trigger search-trigger-wide muted';
          trigger.textContent = 'Search items, projects, activity...';
          trigger.addEventListener('click', ()=> openSearch());
          row.appendChild(trigger);
        }
        if(topbarWrap && topbarWrap.parentElement){
          topbarWrap.insertAdjacentElement('afterend', row);
        }else if(main){
          main.insertAdjacentElement('afterbegin', row);
        }

        const input = overlay.querySelector('#globalSearchInput');
        const results = overlay.querySelector('#globalSearchResults');
        const closeBtn = overlay.querySelector('.search-close');
        let activeResults = [];
        let cache = { items: [], jobs: [], activity: [], ts: 0 };

        const escapeHtml = (value)=> String(value || '')
          .replace(/&/g,'&amp;')
          .replace(/</g,'&lt;')
          .replace(/>/g,'&gt;')
          .replace(/\"/g,'&quot;')
          .replace(/'/g,'&#39;');

        const isTyping = (target)=>{
          if(!target) return false;
          const tag = (target.tagName || '').toLowerCase();
          return tag === 'input' || tag === 'textarea' || target.isContentEditable;
        };

        const openSearch = async ()=>{
          overlay.classList.add('open');
          overlay.setAttribute('aria-hidden', 'false');
          if(input) input.focus();
          if(Date.now() - cache.ts > 60000 || !cache.ts){
            const [items, jobs, activity] = await Promise.all([
              this.fetchJsonSafe('/api/items', {}, []),
              this.fetchJsonSafe('/api/jobs', {}, []),
              this.fetchJsonSafe('/api/recent-activity', {}, [])
            ]);
            cache = {
              items: Array.isArray(items) ? items : [],
              jobs: Array.isArray(jobs) ? jobs : [],
              activity: Array.isArray(activity) ? activity : [],
              ts: Date.now()
            };
          }
          renderResults(input?.value || '');
        };

        const closeSearch = ()=>{
          overlay.classList.remove('open');
          overlay.setAttribute('aria-hidden', 'true');
        };

        const buildGroup = (title, items)=>{
          if(!items.length) return '';
          const rows = items.map((item, idx)=>`
            <button class="search-item" data-href="${item.href}" data-idx="${idx}">
              <div class="search-item-main">${escapeHtml(item.label)}</div>
              <div class="search-item-meta">${escapeHtml(item.meta || '')}</div>
            </button>
          `).join('');
          return `<div class="search-group"><div class="search-group-title">${title}</div>${rows}</div>`;
        };

        const renderResults = (query)=>{
          const q = (query || '').toLowerCase().trim();
          activeResults = [];
          if(!q){
            results.innerHTML = '<div class="search-empty">Type at least 2 characters to search.</div>';
            return;
          }
          if(q.length < 2){
            results.innerHTML = '<div class="search-empty">Keep typing to see results.</div>';
            return;
          }
          const itemMatches = cache.items.filter(i=>{
            const code = (i.code || '').toLowerCase();
            const name = (i.name || '').toLowerCase();
            return code.includes(q) || name.includes(q);
          }).slice(0,5).map(i=>{
            const label = `${i.code || ''} - ${i.name || 'Item'}`.trim();
            const meta = i.category ? `Category: ${i.category}` : '';
            return { label, meta, href: `inventory-list.html?item=${encodeURIComponent(i.code || '')}` };
          });
          const jobMatches = cache.jobs.filter(j=>{
            const code = (j.code || '').toLowerCase();
            const name = (j.name || '').toLowerCase();
            const location = (j.location || '').toLowerCase();
            const status = (j.status || '').toLowerCase();
            return code.includes(q) || name.includes(q) || location.includes(q) || status.includes(q);
          }).slice(0,5).map(j=>{
            const label = `${j.code || ''} - ${j.name || 'Project'}`.trim();
            const meta = j.status ? `Status: ${j.status}` : (j.location ? `Location: ${j.location}` : '');
            return { label, meta, href: `job-creator.html?search=${encodeURIComponent(j.code || '')}` };
          });
          const activityMatches = cache.activity.filter(a=>{
            const code = (a.code || a.itemCode || a.item || '').toLowerCase();
            const jobId = (a.jobId || a.project || '').toLowerCase();
            const user = (a.user || a.userEmail || '').toLowerCase();
            const reason = (a.reason || '').toLowerCase();
            return code.includes(q) || jobId.includes(q) || user.includes(q) || reason.includes(q);
          }).slice(0,5).map(a=>{
            const code = a.code || a.itemCode || a.item || '';
            const label = `${code || 'Item'} - ${(a.type || 'Activity').toString().toUpperCase()}`;
            const meta = a.jobId ? `Project: ${a.jobId}` : (a.reason ? a.reason : '');
            const search = a.jobId || a.reason || '';
            return { label, meta, href: `inventory-list.html?item=${encodeURIComponent(code)}&tab=activity&activity=${encodeURIComponent(search)}` };
          });

          activeResults = [...itemMatches, ...jobMatches, ...activityMatches];
          if(!activeResults.length){
            results.innerHTML = '<div class="search-empty">No results found.</div>';
            return;
          }
          results.innerHTML = [
            buildGroup('Items', itemMatches),
            buildGroup('Projects', jobMatches),
            buildGroup('Activity', activityMatches)
          ].join('');
          results.querySelectorAll('.search-item').forEach(btn=>{
            btn.addEventListener('click', ()=>{
              const href = btn.getAttribute('data-href');
              closeSearch();
              if(href) window.location.href = href;
            });
          });
        };

        input?.addEventListener('input', (e)=> renderResults(e.target.value));
        input?.addEventListener('keydown', (e)=>{
          if(e.key === 'Enter'){
            const first = results.querySelector('.search-item');
            if(first){
              first.click();
            }
          }
        });
        closeBtn?.addEventListener('click', closeSearch);
        overlay.addEventListener('click', (e)=>{
          if(e.target === overlay) closeSearch();
        });
        document.addEventListener('keydown', (e)=>{
          const key = (e.key || '').toLowerCase();
          if((e.ctrlKey || e.metaKey) && key === 'k'){
            e.preventDefault();
            openSearch();
            return;
          }
          if(key === '/' && !isTyping(e.target)){
            e.preventDefault();
            openSearch();
            return;
          }
          if(key === 'escape' && overlay.classList.contains('open')){
            closeSearch();
          }
        });
      };
      if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
    },
    initInstallPrompt(){
      if(this._installPromptInit) return;
      this._installPromptInit = true;
      const isStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
      if(isStandalone || window.navigator.standalone) return;
      let deferredPrompt = null;
      const dismissed = localStorage.getItem('installPromptDismissed') === '1';
      const showPrompt = ()=>{
        if(dismissed || !deferredPrompt || document.getElementById('installPrompt')) return;
        const banner = document.createElement('div');
        banner.id = 'installPrompt';
        banner.className = 'install-prompt';
        banner.innerHTML = `
          <span>Install the IMS app for faster access.</span>
          <div class="install-actions">
            <button type="button" class="install-btn">Install</button>
            <button type="button" class="install-dismiss muted">Not now</button>
          </div>
        `;
        document.body.appendChild(banner);
        banner.querySelector('.install-btn')?.addEventListener('click', async ()=>{
          if(!deferredPrompt) return;
          deferredPrompt.prompt();
          await deferredPrompt.userChoice;
          deferredPrompt = null;
          banner.remove();
        });
        banner.querySelector('.install-dismiss')?.addEventListener('click', ()=>{
          localStorage.setItem('installPromptDismissed','1');
          banner.remove();
        });
      };
      window.addEventListener('beforeinstallprompt', (e)=>{
        e.preventDefault();
        deferredPrompt = e;
        this._installPromptEvent = e;
        showPrompt();
      });
      window.addEventListener('appinstalled', ()=>{
        localStorage.setItem('installPromptDismissed','1');
        const banner = document.getElementById('installPrompt');
        if(banner) banner.remove();
        deferredPrompt = null;
        this._installPromptEvent = null;
      });
    },
    canPromptInstall(){
      return !!this._installPromptEvent;
    },
    async promptInstall(){
      const event = this._installPromptEvent;
      if(!event) return { ok:false, reason:'unavailable' };
      event.prompt();
      const choice = await event.userChoice;
      this._installPromptEvent = null;
      return { ok: choice.outcome === 'accepted', outcome: choice.outcome };
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
  utils.ensurePwaMeta?.();
  utils.initGlobalSearch?.();
  utils.initInstallPrompt?.();
})(window);
