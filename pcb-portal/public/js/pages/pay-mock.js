import { api, el, money, toast } from '../app.js';

const pid = location.pathname.split('/').pop();
const info = document.getElementById('info');
try {
  const p = await api(`/payments/mock/${encodeURIComponent(pid)}`);
  for (const [k, v] of [['Order', `${p.order.code} — ${p.order.title}`], ['Amount', money(p.amount)], ['Status', p.status]]) info.append(el('dt', {}, k), el('dd', {}, v));
} catch (err) {
  info.textContent = err.message;
}
for (const [id, outcome] of [['ok', 'OK'], ['nok', 'NOK']]) {
  document.getElementById(id).addEventListener('click', async () => {
    try {
      const { redirectUrl } = await api(`/payments/mock/${encodeURIComponent(pid)}`, { method: 'POST', body: { outcome } });
      location.href = redirectUrl;
    } catch (err) {
      toast(err.message, true);
    }
  });
}
