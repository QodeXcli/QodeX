import { api, toast } from '../app.js';

const profile = document.getElementById('profile');
const pw = document.getElementById('password');
const { user } = await api('/auth/me');
for (const k of ['email', 'name', 'company', 'country', 'phone']) profile.elements[k].value = user?.[k] || '';

profile.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(profile));
  try {
    await api('/auth/me', { method: 'PATCH', body: data });
    toast('Profile saved.');
  } catch (err) {
    toast(err.message, true);
  }
});
pw.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(pw)) });
    pw.reset();
    toast('Password changed. Other sessions were signed out.');
  } catch (err) {
    toast(err.message, true);
  }
});
