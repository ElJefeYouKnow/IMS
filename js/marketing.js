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
    const host = window.location.hostname || '';
    const base = host.replace(/^www\./, '');
    if (!base) return;
    const port = window.location.port ? `:${window.location.port}` : '';
    const isLocal = base === 'localhost' || base === '127.0.0.1';
    const appHost = isLocal ? base : (base.startsWith('app.') ? base : `app.${base}`);
    const protocol = window.location.protocol === 'http:' ? 'http:' : 'https:';
    const appUrl = `${protocol}//${appHost}${port}/login.html`;
    links.forEach(link => link.setAttribute('href', appUrl));
  }
})();
