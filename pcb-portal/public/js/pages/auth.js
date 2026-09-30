import { api, qs } from '../app.js';

const form = document.getElementById('form');
const next = qs('next');
const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
const alt = document.getElementById('alt');
if (alt && safeNext) alt.href += `?next=${encodeURIComponent(safeNext)}`;
const errorBox = document.getElementById('error');
const isRegister = form.dataset.mode === 'register';

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.hidden = true;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const { user } = await api(isRegister ? '/auth/register' : '/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    location.href = safeNext || (user.role === 'admin' ? '/admin' : '/portal');
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    btn.disabled = false;
  }
});
