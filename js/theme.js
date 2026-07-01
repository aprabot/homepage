/* ============================================================
   APRABot — Theme toggle (dark ↔ light)
   Include AFTER the inline <head> snippet that reads localStorage.
============================================================ */

(function () {
  'use strict';

  const STORAGE_KEY = 'apraTheme';
  const html = document.documentElement;

  function current() {
    return html.dataset.theme || 'dark';
  }

  function apply(theme) {
    html.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
    updateBtn(theme);
  }

  function toggle() {
    apply(current() === 'dark' ? 'light' : 'dark');
  }

  /* Sun icon — shown in dark mode (click to go light) */
  const SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="4.5"/>
    <line x1="12" y1="2" x2="12" y2="4.5"/>
    <line x1="12" y1="19.5" x2="12" y2="22"/>
    <line x1="4.93" y1="4.93" x2="6.7" y2="6.7"/>
    <line x1="17.3" y1="17.3" x2="19.07" y2="19.07"/>
    <line x1="2" y1="12" x2="4.5" y2="12"/>
    <line x1="19.5" y1="12" x2="22" y2="12"/>
    <line x1="4.93" y1="19.07" x2="6.7" y2="17.3"/>
    <line x1="17.3" y1="6.7" x2="19.07" y2="4.93"/>
  </svg>`;

  /* Moon icon — shown in light mode (click to go dark) */
  const MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>`;

  function updateBtn(theme) {
    const btn = document.getElementById('theme-tg');
    if (!btn) return;
    const isDark = theme === 'dark';
    btn.innerHTML    = isDark ? SUN : MOON;
    btn.title        = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', btn.title);
  }

  function inject() {
    if (document.getElementById('theme-tg')) return; // already there
    const navCta = document.querySelector('.nav-cta');
    if (!navCta) return;

    const btn = document.createElement('button');
    btn.id        = 'theme-tg';
    btn.className = 'theme-tg';
    btn.addEventListener('click', toggle);

    /* Place it before the Sign-in / first child */
    navCta.insertBefore(btn, navCta.firstChild);
    updateBtn(current());
  }

  /* ── Scroll progress bar ── */
  function injectProgress() {
    if (document.getElementById('scroll-progress')) return;
    const bar = document.createElement('div');
    bar.id = 'scroll-progress';
    document.body.prepend(bar);

    function update() {
      const scrolled = window.scrollY;
      const total    = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = total > 0 ? (scrolled / total * 100) + '%' : '0%';
    }

    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { inject(); injectProgress(); });
  } else {
    inject();
    injectProgress();
  }
})();
