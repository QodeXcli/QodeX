import { api, badge, currentUser, el, fmtDate, getConfig, money } from '../app.js';

const me = currentUser();
if (me) document.getElementById('hello').textContent = `Welcome back, ${me.name.split(' ')[0]}`;
const box = document.getElementById('orders');
const [{ orders }, cfg] = await Promise.all([api('/orders'), getConfig()]);

const open = orders.filter((o) => !['completed', 'cancelled'].includes(o.status));
const spent = orders.filter((o) => ['paid', 'in_progress', 'delivered', 'completed'].includes(o.status)).reduce((s, o) => s + (o.price || 0), 0);
const tiles = [
  ['Open orders', open.length],
  ['Awaiting your payment', orders.filter((o) => o.status === 'awaiting_payment').length],
  ['Ready to review', orders.filter((o) => o.status === 'delivered').length],
  ['Total spent', money(spent)],
];
document.getElementById('stats').replaceChildren(...tiles.map(([l, v]) => el('div', { class: 'card stat' }, el('div', { class: 'stat__value' }, String(v)), el('div', { class: 'stat__label' }, l))));

if (!orders.length) {
  box.replaceChildren(el('div', { class: 'empty' },
    el('div', { class: 'dropzone__icon' }, 'PCB'),
    el('h3', {}, 'No orders yet'),
    el('p', {}, 'Drop a placed .kicad_pcb to get an instant quote and a 3D preview.'),
    el('a', { class: 'btn btn--primary', href: '/portal/new' }, 'Start your first order')));
} else {
  box.replaceChildren(el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
    el('thead', {}, el('tr', {}, ['Order', 'Project', 'Service', 'Total', 'Status', 'Updates', 'Placed', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, orders.map((o) => el('tr', {},
      el('td', {}, el('a', { class: 'rowlink', href: `/portal/orders/${o.code}` }, o.code)),
      el('td', {}, o.title),
      el('td', { class: 'muted' }, cfg.services[o.service] || o.service),
      el('td', { class: 'mono' }, money(o.price)),
      el('td', {}, badge(o.status, o.statusLabel)),
      el('td', { class: 'low' }, [o.deliveredFiles ? `${o.deliveredFiles} file${o.deliveredFiles === 1 ? '' : 's'}` : null, o.engineerMessages ? `${o.engineerMessages} msg` : null].filter(Boolean).join(' · ') || '—'),
      el('td', { class: 'low nowrap' }, fmtDate(o.createdAt, false)),
      el('td', {}, o.status === 'awaiting_payment'
        ? el('a', { class: 'btn btn--primary btn--sm', href: `/portal/orders/${o.code}?pay=1` }, 'Pay now')
        : el('a', { class: 'btn btn--sm', href: `/portal/orders/${o.code}` }, 'Open')),
    ))),
  )));
}
