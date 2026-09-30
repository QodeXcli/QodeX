import { api, el, fmtDate, money } from '../app.js';

const box = document.getElementById('list');
const { customers } = await api('/admin/customers');
box.replaceChildren(el('table', { class: 'table' },
  el('thead', {}, el('tr', {}, ['Name', 'Email', 'Company', 'Country', 'Orders', 'Spent', 'Joined'].map((h) => el('th', {}, h)))),
  el('tbody', {}, customers.map((c) => el('tr', {},
    el('td', {}, c.name, c.role === 'admin' ? el('span', { class: 'badge badge--admin', style: 'margin-left:8px' }, 'admin') : null),
    el('td', { class: 'mono' }, el('a', { href: `mailto:${c.email}` }, c.email)),
    el('td', {}, c.company || '—'),
    el('td', {}, c.country || '—'),
    el('td', { class: 'mono' }, c.orders),
    el('td', { class: 'mono' }, money(c.spent)),
    el('td', { class: 'low nowrap' }, fmtDate(c.created_at, false)),
  )))));
