(function(){
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.site-nav');
  if (toggle && header && nav) {
    toggle.addEventListener('click', () => {
      const open = header.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', (event) => {
      if (event.target && event.target.tagName === 'A') {
        header.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  const links = document.querySelectorAll('[data-app-link]');
  if (links.length) {
    const root = document.documentElement;
    const hostOverride = root.dataset.appHost || document.body?.dataset.appHost;
    const pathOverride = root.dataset.appPath || 'login.html';
    const protocolOverride = root.dataset.appProtocol || '';
    const host = window.location.hostname || '';
    const base = host.replace(/^www\./, '');
    if (!base && !hostOverride) return;
    const port = window.location.port ? `:${window.location.port}` : '';
    const isLocal = base === 'localhost' || base === '127.0.0.1';
    const isDo = base.endsWith('.ondigitalocean.app');
    const appHost = hostOverride || ((isLocal || isDo) ? base : (base.startsWith('app.') ? base : `app.${base}`));
    const protocol = protocolOverride || (window.location.protocol === 'http:' ? 'http:' : 'https:');
    const path = pathOverride.startsWith('/') ? pathOverride : `/${pathOverride}`;
    const appUrl = `${protocol}//${appHost}${hostOverride ? '' : port}${path}`;
    links.forEach(link => link.setAttribute('href', appUrl));
  }
})();
