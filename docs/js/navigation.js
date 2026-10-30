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

// Carry a non-personal label through public pages to checkout, matching the
// server's contract (supabase/functions/_shared/labels.mjs). An advertisement's
// channel/variant label is carried in links only and never stored. An
// affiliate's aff-<code> label is also kept in this browser for 30 days, so a
// referral still counts when the buyer comes back later without the link; the
// newest affiliate link replaces any earlier one, and an expired one is removed
// on the next page view. buy.js reads it back with the same key and age.
(() => {
  const AFFILIATE = /^aff-[a-z0-9-]{2,32}$/;
  const REFERRAL_KEY = 'wavread-referral';
  const REFERRAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const freshReferral = raw => {
    try {
      const saved = JSON.parse(raw);
      const age = Date.now() - saved.savedAt;
      return AFFILIATE.test(saved.label) && age >= 0 && age < REFERRAL_MAX_AGE_MS ? saved.label : null;
    } catch { return null; }
  };
  const source = new URLSearchParams(location.search).get('from')?.trim().toLowerCase();
  const affiliate = !!source && AFFILIATE.test(source);
  try {
    if (affiliate) {
      localStorage.setItem(REFERRAL_KEY, JSON.stringify({label: source, savedAt: Date.now()}));
    } else {
      const raw = localStorage.getItem(REFERRAL_KEY);
      if (raw !== null && !freshReferral(raw)) localStorage.removeItem(REFERRAL_KEY);
    }
  } catch { /* storage blocked: the link still carries the label on this visit */ }
  if (!source || !(affiliate || /^(reels|tiktok|shorts|yt|direct)(-[a-z0-9]{1,12})?$/.test(source))) return;
  const pages = new Set(['/', '/index', '/buy', '/early-build', '/how-it-works', '/documents', '/agent', '/requirements', '/install', '/faq', '/privacy', '/EULA']);
  document.querySelectorAll('a[href]').forEach(link => {
    if (link.hasAttribute('download')) return;
    const url = new URL(link.getAttribute('href'), location.href);
    if (url.origin !== location.origin || !pages.has(url.pathname.replace(/\.html$/, ''))) return;
    url.searchParams.set('from', source);
    link.setAttribute('href', url.pathname + url.search + url.hash);
  });
})();

// Signed in on this browser: the header's "Sign in" becomes "Account". This
// only looks for the session the account pages keep (supabase-js, under the
// dashboard's storage key); it stores nothing, and the account page checks the
// session properly before showing anything.
(() => {
  const link = document.querySelector('.header a.sign-in[href="/signin.html"]');
  if (!link) return;
  try {
    const saved = JSON.parse(localStorage.getItem('wavread-beta-session') || 'null');
    if (!saved || !saved.refresh_token) return;
  } catch { return; }
  link.textContent = 'Account';
  link.setAttribute('href', '/account.html');
})();
