'use strict';

// Keep the mobile menu control outside the sticky header. Some mobile browsers
// can hit-test transformed/sticky descendants against the parent main element,
// making a visually visible nested button untappable. A fixed direct child of
// #app has an independent hit target and avoids that entire class of bugs.
(() => {
  function detachMenuButton() {
    const app = document.getElementById('app');
    const button = document.querySelector('.mobile-menu-btn');
    if (!app || !button) return false;
    if (button.parentElement !== app) app.appendChild(button);
    button.type = 'button';
    button.setAttribute('aria-label', 'باز کردن منو');
    button.onclick = () => app.classList.add('mobile-nav-open');
    return true;
  }

  const observer = new MutationObserver(() => {
    if (detachMenuButton()) observer.disconnect();
  });

  if (!detachMenuButton()) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  document.addEventListener('DOMContentLoaded', detachMenuButton, { once: true });
  window.addEventListener('resize', detachMenuButton, { passive: true });
})();
