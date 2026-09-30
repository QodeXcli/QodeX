import { api, badge, el, fmtDate, getConfig, money } from '../app.js';

const cfg = await getConfig();
const statusSel = document.getElementById('status');
const q = document.getElementById('q');
statusSel.append(el('option', { value: 'open' }, 'Open orders'), el('option', { value: '' }, 'All orders'),
  ...Object.entries(cfg.statusLabels).map(([v, l]) => el('option', { value: v }, l)));

async function loadStats() {
  const s = await api('/admin/stats');
  const n = (k) => s.byStatus[k] || 0;
  const tiles = [
    ['Awaiting quote', n('quote_pending')],
    ['To route (paid / in progress)', n('paid') + n('in_progress')],
    ['Revenue, last 30 days', money(s.revenue30)],
    ['New inquiries', s.newInquiries],
  ];
  document.getElementById('stats').replaceChildren(...tiles.map(([label, value]) => el('div', { class: 'card stat' }, el('div', { class: 'stat__value' }, String(value)), el('div', { class: 'stat__label' }, label))));
}

async function load() {
  const params = new URLSearchParams({ status: statusSel.value, q: q.value.trim() });
  const { orders } = await api(`/admin/orders?${params}`);
  const box = document.getElementById('orders');
  if (!orders.length) return box.replaceChildren(el('p', { class: 'empty' }, 'No orders match.'));
  box.replaceChildren(el('table', { class: 'table' },
    el('thead', {}, el('tr', {}, ['Order', 'Project', 'Customer', 'Service', 'Layers', 'Total', 'Status', 'Updated'].map((h) => el('th', {}, h)))),
    el('tbody', {}, orders.map((o) => el('tr', {},
      el('td', {}, el('a', { class: 'rowlink', href: `/admin/orders/${o.code}` }, o.code)),
      el('td', {}, o.title),
      el('td', {}, o.customer?.name, el('div', { class: 'low mono' }, o.customer?.email)),
      el('td', { class: 'muted' }, cfg.services[o.service]),
      el('td', { class: 'mono' }, o.specs.layers),
      el('td', { class: 'mono' }, money(o.price)),
      el('td', {}, badge(o.status, o.statusLabel)),
      el('td', { class: 'low nowrap' }, fmtDate(o.updatedAt)),
    )))));
}

let t;
q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
statusSel.addEventListener('change', load);
loadStats();
load();
setInterval(() => { loadStats(); load(); }, 60_000);
