// Site chrome behaviour: mobile navigation and sign-out. Loaded on every page.
import { api } from './app.js';

const toggle = document.querySelector('[data-nav-toggle]');
const nav = document.querySelector('[data-nav]');
toggle?.addEventListener('click', () => {
  const open = nav.classList.toggle('is-open');
  toggle.setAttribute('aria-expanded', String(open));
});

for (const btn of document.querySelectorAll('[data-logout]')) {
  btn.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  });
}
