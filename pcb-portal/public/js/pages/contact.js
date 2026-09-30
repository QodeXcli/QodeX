import { api, el, getConfig, qs } from '../app.js';

const cfg = await getConfig();
const topic = document.getElementById('topic');
const wanted = qs('topic');
for (const [v, label] of Object.entries(cfg.inquiryTopics)) topic.append(el('option', { value: v, selected: v === wanted }, label));

const form = document.getElementById('contact-form');
const error = document.getElementById('error');
const ok = document.getElementById('ok');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('/contact', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    form.reset();
    ok.hidden = false;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
