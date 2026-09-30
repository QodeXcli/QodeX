import { api, dollars, el, fmtDate, money } from '../app.js';
import { providerName } from '../order-view.js';

document.getElementById('print').addEventListener('click', () => window.print());
const box = document.getElementById('receipt');
const pid = location.pathname.split('/').pop();
try {
  const r = await api(`/payments/${encodeURIComponent(pid)}/receipt`);
  document.title = `Receipt ${r.order.code} | QodeX PCB`;
  const lines = r.order.lines || [{ label: r.order.serviceLabel, amount: r.payment.amount / 100 }];
  box.replaceChildren(
    el('div', { class: 'row' }, el('div', {}, el('h1', { style: 'font-size:28px;margin:0' }, 'Receipt'), el('div', { class: 'muted mono' }, `${r.order.code} · ${r.payment.id}`)), el('span', { class: 'spacer' }), el('span', { class: 'paid-stamp' }, 'PAID')),
    el('div', { class: 'receipt__grid' },
      el('div', {}, el('div', { class: 'low' }, 'From'), el('strong', {}, r.seller.name), el('div', {}, r.seller.site), r.seller.email ? el('div', {}, r.seller.email) : null, el('div', { class: 'muted' }, r.seller.url)),
      el('div', {}, el('div', { class: 'low' }, 'Billed to'), el('strong', {}, r.customer.name), r.customer.company ? el('div', {}, r.customer.company) : null, el('div', {}, r.customer.email), r.customer.country ? el('div', {}, r.customer.country) : null),
    ),
    el('div', { class: 'receipt__grid' },
      el('div', {}, el('div', { class: 'low' }, 'Date paid'), el('div', {}, fmtDate(r.payment.paidAt))),
      el('div', {}, el('div', { class: 'low' }, 'Payment method'), el('div', {}, `${providerName(r.payment.provider)} · ref ${r.payment.refId || '—'}`)),
    ),
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, `${r.order.serviceLabel} — ${r.order.title}`), el('th', { class: 'num' }, 'Amount (USD)'))),
      el('tbody', {},
        lines.map((l) => el('tr', {}, el('td', {}, l.label), el('td', { class: 'num' }, dollars(l.amount)))),
        el('tr', { class: 'total' }, el('td', {}, 'Total paid'), el('td', { class: 'num' }, money(r.payment.amount))),
      ),
    ),
    el('p', { class: 'low' }, 'Line items may not sum exactly to the total because of rounding and minimum-order adjustments. Thank you for your order.'),
  );
} catch (err) {
  box.textContent = err.message;
}
