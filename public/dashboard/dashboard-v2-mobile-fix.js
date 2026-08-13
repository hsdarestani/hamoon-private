'use strict';

// Keep one mobile menu control outside the sticky header. Some mobile browsers
// can hit-test transformed/sticky descendants against the parent main element,
// making a visually visible nested button untappable. The original v2 shell can
// re-run its enhancer after login, so this reconciler also removes duplicates.
(() => {
  let reconciling = false;

  function reconcileMenuButton() {
    if (reconciling) return false;
    const app = document.getElementById('app');
    if (!app) return false;
    const buttons = [...document.querySelectorAll('.mobile-menu-btn')];
    if (!buttons.length) return false;

    reconciling = true;
    try {
      const keep = buttons.find(button => button.parentElement === app) || buttons[0];
      if (keep.parentElement !== app) app.appendChild(keep);
      for (const button of buttons) {
        if (button !== keep) button.remove();
      }
      keep.type = 'button';
      keep.setAttribute('aria-label', 'باز کردن منو');
      keep.onclick = () => app.classList.add('mobile-nav-open');
      return true;
    } finally {
      reconciling = false;
    }
  }

  let queued = false;
  const scheduleReconcile = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      reconcileMenuButton();
    });
  };

  const observer = new MutationObserver(scheduleReconcile);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  reconcileMenuButton();
  document.addEventListener('DOMContentLoaded', reconcileMenuButton, { once: true });
  window.addEventListener('resize', reconcileMenuButton, { passive: true });
})();
