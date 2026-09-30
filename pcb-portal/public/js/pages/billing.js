import { api, el, fmtDate, money } from '../app.js';
import { providerName } from '../order-view.js';

const { payments } = await api('/payments');
const total = payments.reduce((s, p) => s + p.amount, 0);
const last = payments[0];
document.getElementById('stats').replaceChildren(
  ...[['Payments', payments.length], ['Total paid', money(total)], ['Last payment', last ? fmtDate(last.paidAt, false) : '—']]
    .map(([l, v]) => el('div', { class: 'card stat' }, el('div', { class: 'stat__value' }, String(v)), el('div', { class: 'stat__label' }, l))),
);
const list = document.getElementById('list');
if (!payments.length) {
  list.replaceChildren(el('p', { class: 'empty' }, 'No payments yet. Receipts will appear here after your first order.'));
} else {
  list.replaceChildren(el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
    el('thead', {}, el('tr', {}, ['Date', 'Order', 'Method', 'Reference', 'Amount', ''].map((h, i) => el('th', { class: i === 4 ? 'num' : '' }, h)))),
    el('tbody', {}, payments.map((p) => el('tr', {},
      el('td', { class: 'nowrap' }, fmtDate(p.paidAt)),
      el('td', {}, el('a', { class: 'rowlink', href: `/portal/orders/${p.orderCode}` }, p.orderCode), el('div', { class: 'low' }, p.orderTitle)),
      el('td', {}, providerName(p.provider)),
      el('td', { class: 'mono low' }, p.refId || '—'),
      el('td', { class: 'num' }, money(p.amount)),
      el('td', {}, el('a', { class: 'btn btn--sm', href: `/portal/receipts/${p.id}` }, 'Receipt')),
    ))),
  )));
}
