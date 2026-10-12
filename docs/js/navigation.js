// The shared menu remains usable without JavaScript.
const menu = document.querySelector('.site-menu');
if (menu) {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
  document.addEventListener('click', event => {
    if (!menu.contains(event.target)) menu.open = false;
  });
  menu.querySelectorAll('a').forEach(link => {
    if (link.pathname.replace(/\.html$/, '') === location.pathname.replace(/\.html$/, '')) link.setAttribute('aria-current', 'page');
  });
}

// Carry a non-personal campaign label through public pages to checkout.
// Match the server's channel/variant contract; no persistent storage.
(() => {
  const source = new URLSearchParams(location.search).get('from')?.trim().toLowerCase();
  if (!source || !/^(reels|tiktok|shorts|yt|direct)(-[a-z0-9]{1,12})?$/.test(source)) return;
  const pages = new Set(['/', '/index', '/buy', '/early-build', '/how-it-works', '/documents', '/agent', '/requirements', '/install', '/faq', '/privacy', '/EULA']);
  document.querySelectorAll('a[href]').forEach(link => {
    if (link.hasAttribute('download')) return;
    const url = new URL(link.getAttribute('href'), location.href);
    if (url.origin !== location.origin || !pages.has(url.pathname.replace(/\.html$/, ''))) return;
    url.searchParams.set('from', source);
    link.setAttribute('href', url.pathname + url.search + url.hash);
  });
})();
