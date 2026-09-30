import { api, badge, el, fmtDate, getConfig, toast } from '../app.js';

const cfg = await getConfig();
const box = document.getElementById('list');

async function load() {
  const { inquiries } = await api('/admin/inquiries');
  if (!inquiries.length) return box.replaceChildren(el('div', { class: 'card empty' }, 'No inquiries yet.'));
  box.replaceChildren(...inquiries.map((q) => el('div', { class: 'card' },
    el('div', { class: 'card__title' },
      el('div', {}, el('h3', {}, q.name, q.company ? el('span', { class: 'low' }, ` · ${q.company}`) : null), el('div', { class: 'low' }, `${cfg.inquiryTopics[q.topic] || q.topic} · ${fmtDate(q.created_at)}`)),
      badge(q.status, q.status === 'new' ? 'New' : 'Handled'),
    ),
    el('p', { style: 'white-space:pre-wrap' }, q.message),
    el('div', { class: 'row' },
      el('a', { class: 'btn btn--primary btn--sm', href: `mailto:${q.email}?subject=${encodeURIComponent(`Re: your message to ${cfg.siteName}`)}` }, `Reply to ${q.email}`),
      el('button', {
        type: 'button', class: 'btn btn--sm', onclick: async () => {
          try { await api(`/admin/inquiries/${q.id}`, { method: 'PATCH', body: { status: q.status === 'new' ? 'handled' : 'new' } }); load(); } catch (err) { toast(err.message, true); }
        },
      }, q.status === 'new' ? 'Mark handled' : 'Mark as new'),
    ),
  )));
}
load();
