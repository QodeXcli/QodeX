// Order detail view shared by the customer portal and the admin panel.
import { api, badge, dollars, el, extBadge, fmtDate, fmtSize, money, openViewerModal, toast, uploadForm } from './app.js';

const FLOW = ['Placed', 'Quote & payment', 'Engineering', 'Delivered', 'Completed'];
const FLOW_INDEX = { quote_pending: 1, awaiting_payment: 1, paid: 2, in_progress: 2, delivered: 3, completed: 4 };

const EVENT_TEXT = {
  created: 'Order placed',
  status: (d, labels) => `Status: ${labels[d.from] || d.from} → ${labels[d.to] || d.to}${d.manual ? ' (payment recorded manually)' : ''}`,
  price: (d) => `Price set to ${money(d.to)}`,
  files_added: (d) => `${d.count} file${d.count === 1 ? '' : 's'} added by ${d.source === 'admin' ? 'QodeX' : 'customer'}`,
  file_deleted: (d) => `File "${d.name}" removed`,
  payment_started: (d) => `Checkout started (${providerName(d.provider)})`,
  payment_succeeded: (d) => `Payment confirmed — ${providerName(d.provider)} ref ${d.refId || '—'}`,
  payment_failed: (d) => `Payment not completed (${providerName(d.provider)})`,
  payment_attention: (d) => d.message,
  parse_warning: (d) => d.message,
};

export function providerName(p) {
  return { stripe: 'Stripe', paypal: 'PayPal', mock: 'Test checkout' }[p] || p;
}

export function renderOrder(root, detail, { admin = false, cfg, reload }) {
  const { order, files, messages, payments, events } = detail;
  const labels = cfg.statusLabels;
  const look = { maskColor: order.specs.maskColor, finish: order.specs.finish, silkColor: order.specs.silkColor };
  root.replaceChildren();

  // ── header ──
  root.append(el('div', { class: 'page-head' },
    el('div', {},
      el('div', { class: 'low mono' }, order.code),
      el('h1', {}, order.title),
      el('div', { class: 'row', style: 'margin-top:8px' },
        badge(order.status, order.statusLabel),
        el('span', { class: 'low' }, `Placed ${fmtDate(order.createdAt)}`),
        admin && order.customer ? el('span', { class: 'low' }, `· ${order.customer.name} · ${order.customer.email}${order.customer.company ? ` · ${order.customer.company}` : ''}`) : null),
    ),
    el('a', { class: 'btn btn--sm', href: admin ? '/admin' : '/portal' }, admin ? '← Order queue' : '← All orders'),
  ));

  const flag = new URLSearchParams(location.search).get('payment');
  if (flag && !admin) {
    const ok = flag === 'success';
    root.append(el('div', { class: ok ? 'form-ok' : flag === 'cancelled' ? 'form-warn' : 'form-error', style: 'margin-bottom:18px' },
      ok ? 'Payment confirmed. Your board is in the engineering queue — we will post updates here.'
        : flag === 'cancelled' ? 'Checkout was cancelled. You can try again whenever you are ready.'
          : 'The payment could not be confirmed. If you were charged, contact us and we will resolve it.'));
    history.replaceState(null, '', location.pathname);
  }

  if (order.status !== 'cancelled') {
    const idx = FLOW_INDEX[order.status] ?? 0;
    root.append(el('div', { class: 'steps' }, FLOW.map((label, i) => el('span', { class: i < idx ? 'done' : i === idx ? 'now' : '' }, label))));
  }

  const main = el('div', { class: 'stack-cards' });
  const side = el('aside', { class: 'stack-cards' });
  root.append(el('div', { class: 'split' }, main, side));

  // ── files ──
  const fileTable = (list, emptyText) =>
    list.length
      ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('tbody', {}, list.map((f) => el('tr', {},
          el('td', { style: 'width:1%' }, extBadge(f.name)),
          el('td', { class: 'name-cell' }, f.name, f.note ? el('div', { class: 'low', style: 'font-family:var(--font)' }, f.note) : null),
          el('td', { class: 'low nowrap' }, fmtSize(f.size)),
          el('td', { class: 'low nowrap' }, fmtDate(f.createdAt)),
          el('td', {}, el('div', { class: 'row row--end', style: 'flex-wrap:nowrap' },
            f.viewerKind ? el('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => openViewerModal(f, look) }, 'View 3D') : null,
            el('a', { class: 'btn btn--sm', href: `/api/files/${f.id}` }, 'Download'),
            admin ? el('button', { type: 'button', class: 'btn btn--sm btn--danger', 'aria-label': `Delete ${f.name}`, onclick: () => deleteFile(f) }, 'Delete') : null,
          )),
        )))))
      : el('p', { class: 'muted', style: 'margin:0' }, emptyText);

  async function deleteFile(f) {
    if (!confirm(`Delete "${f.name}"? This cannot be undone.`)) return;
    try {
      await api(`/admin/files/${f.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      toast(err.message, true);
    }
  }

  main.append(el('section', { class: 'card' },
    el('div', { class: 'card__title' }, el('h2', {}, 'Deliverables'), el('span', { class: 'low' }, 'Routed board, 3D model, fab outputs, reports')),
    fileTable(files.filter((f) => f.source === 'admin'), admin ? 'Nothing sent to the customer yet.' : 'When your board is ready, the routed files appear here — open any of them in 3D.'),
    admin ? uploadBox(true) : null,
  ));
  main.append(el('section', { class: 'card' },
    el('div', { class: 'card__title' }, el('h2', {}, admin ? 'Customer files' : 'Your files')),
    fileTable(files.filter((f) => f.source === 'customer'), 'No files.'),
    !admin && !['cancelled', 'completed'].includes(order.status) ? uploadBox(false) : null,
  ));

  function uploadBox(isAdmin) {
    const input = el('input', { type: 'file', multiple: true, 'aria-label': 'Choose files' });
    const note = el('input', { type: 'text', placeholder: isAdmin ? 'Note for the customer (optional), e.g. "Final routed board, rev B"' : 'Note (optional)', maxlength: 500 });
    const deliver = el('input', { type: 'checkbox' });
    const status = el('span', { class: 'low' });
    const btn = el('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, isAdmin ? 'Send to customer' : 'Add files');
    const form = el('form', { class: 'stack upload-box' },
      input,
      note,
      isAdmin && ['paid', 'in_progress'].includes(order.status) ? el('label', { class: 'check' }, deliver, el('span', {}, 'Mark the order as delivered')) : null,
      el('div', { class: 'row' }, btn, status),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.files.length) return toast('Choose at least one file.', true);
      const fd = new FormData();
      for (const f of input.files) fd.append('files', f, f.name);
      fd.append('note', note.value);
      if (deliver.checked) fd.append('markDelivered', 'true');
      btn.disabled = true;
      try {
        await uploadForm(isAdmin ? `/admin/orders/${order.code}/files` : `/orders/${order.code}/files`, fd, (p) => { status.textContent = `Uploading… ${Math.round(p * 100)}%`; });
        toast('Files uploaded.');
        reload();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        status.textContent = '';
      }
    });
    return form;
  }

  // ── messages ──
  const thread = el('div', { class: 'thread' }, messages.length
    ? messages.map((m) => el('div', { class: `msg ${m.isAdmin === admin ? 'msg--me' : 'msg--other'}` }, m.body,
        el('span', { class: 'msg__meta' }, `${m.isAdmin ? 'QodeX engineer · ' : ''}${m.author} · ${fmtDate(m.createdAt)}`)))
    : el('p', { class: 'muted', style: 'margin:0' }, admin ? 'No messages yet.' : 'Questions or extra requirements? Message your engineer directly.'));
  const textarea = el('textarea', { placeholder: 'Write a message…', maxlength: 5000, required: true, 'aria-label': 'Message' });
  const sendBtn = el('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, 'Send');
  const msgForm = el('form', { class: 'stack', style: 'margin-top:14px' }, textarea, el('div', { class: 'row' }, sendBtn, el('span', { class: 'low' }, 'Ctrl/⌘ + Enter to send')));
  textarea.addEventListener('keydown', (e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && msgForm.requestSubmit());
  msgForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!textarea.value.trim()) return;
    sendBtn.disabled = true;
    try {
      await api(`/orders/${order.code}/messages`, { method: 'POST', body: { body: textarea.value } });
      reload();
    } catch (err) {
      toast(err.message, true);
      sendBtn.disabled = false;
    }
  });
  main.append(el('section', { class: 'card' }, el('div', { class: 'card__title' }, el('h2', {}, admin ? 'Conversation with customer' : 'Your engineer')), thread, msgForm));
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });

  // ── price / payment ──
  const payCard = el('section', { class: 'card', id: 'pay' },
    el('span', { class: 'eyebrow' }, 'Order total'),
    el('div', { class: 'price-big' }, order.price ? money(order.price) : 'Awaiting quote', order.price ? el('small', {}, 'USD') : null),
    order.priceBreakdown && !order.priceIsManual
      ? el('ul', { class: 'price-lines' }, order.priceBreakdown.map((l) => el('li', {}, el('span', {}, l.label), el('span', {}, dollars(l.amount)))))
      : order.priceIsManual ? el('p', { class: 'low', style: 'margin:10px 0 0' }, 'Quoted by your engineer.') : null,
  );
  side.append(payCard);

  if (!admin) {
    if (order.status === 'awaiting_payment') {
      const methods = cfg.paymentMethods;
      const radios = el('div', { class: 'pay-methods', role: 'radiogroup', 'aria-label': 'Payment method' },
        methods.map((m, i) => el('label', { class: 'pay-method' }, el('input', { type: 'radio', name: 'method', value: m.id, checked: i === 0 }), el('span', {}, m.label))));
      const payBtn = el('button', { type: 'button', class: 'btn btn--primary btn--lg btn--block', style: 'margin-top:14px' }, `Pay ${money(order.price)}`);
      payBtn.addEventListener('click', async () => {
        const method = radios.querySelector('input:checked')?.value;
        payBtn.disabled = true;
        payBtn.textContent = 'Redirecting to secure checkout…';
        try {
          const { redirectUrl } = await api(`/orders/${order.code}/pay`, { method: 'POST', body: { method } });
          location.href = redirectUrl;
        } catch (err) {
          toast(err.message, true);
          payBtn.disabled = false;
          payBtn.textContent = `Pay ${money(order.price)}`;
        }
      });
      payCard.append(radios, payBtn, el('p', { class: 'low', style: 'margin:10px 0 0' }, 'You will be redirected to the provider’s secure page. We never see your card details.'));
      if (new URLSearchParams(location.search).get('pay') === '1') requestAnimationFrame(() => payCard.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    } else if (order.status === 'quote_pending') {
      payCard.append(el('p', { class: 'muted', style: 'margin:12px 0 0' }, 'An engineer is reviewing your board and will set the price shortly. You will be able to pay here.'));
    } else if (order.paidAt) {
      const paid = payments.find((p) => p.status === 'paid');
      payCard.append(el('div', { class: 'form-ok', style: 'margin-top:14px' }, `Paid ${fmtDate(order.paidAt)}`),
        paid ? el('a', { class: 'btn btn--sm', style: 'margin-top:10px', href: `/portal/receipts/${paid.id}` }, 'View receipt') : null);
    }
    if (['quote_pending', 'awaiting_payment'].includes(order.status)) {
      payCard.append(el('button', {
        type: 'button', class: 'btn btn--ghost btn--sm', style: 'margin-top:12px',
        onclick: async () => {
          if (!confirm('Cancel this order?')) return;
          try { await api(`/orders/${order.code}/cancel`, { method: 'POST' }); reload(); } catch (err) { toast(err.message, true); }
        },
      }, 'Cancel order'));
    }
    if (order.status === 'delivered') {
      side.append(el('section', { class: 'card' },
        el('h3', {}, 'Happy with the result?'),
        el('p', { class: 'muted' }, 'Confirm once you have reviewed the deliverables. You can still download them afterwards.'),
        el('button', {
          type: 'button', class: 'btn btn--primary', onclick: async () => {
            try { await api(`/orders/${order.code}/confirm`, { method: 'POST' }); reload(); } catch (err) { toast(err.message, true); }
          },
        }, 'Confirm & close order')));
    }
  }

  if (admin) side.append(adminControls(order, cfg, reload));

  // ── specification ──
  const s = order.specs;
  const o = cfg.options;
  const fab = ['routing_fab', 'fab_only'].includes(s.service)
    ? [['Quantity', s.quantity], ['Thickness', `${s.thickness} mm`], ['Copper', `${s.copperOz} oz`], ['Finish', o.finish[s.finish]], ['Solder mask', o.maskColor[s.maskColor]], ['Silkscreen', o.silkColor[s.silkColor]]]
    : [];
  side.append(el('section', { class: 'card' }, el('div', { class: 'card__title' }, el('h3', {}, 'Specification')),
    el('dl', { class: 'kv' }, [
      ['Service', cfg.services[s.service]], ['Layers', s.layers], ['Size', `${s.widthMm} × ${s.heightMm} mm`], ...fab,
      ['Target fab', o.fabHouse[s.fabHouse]], ['Turnaround', o.turnaround[s.turnaround]], ['Controlled impedance', s.impedanceControl ? 'Yes' : 'No'],
      ...(order.boardMeta ? [['Nets / pads', `${order.boardMeta.nets} / ${order.boardMeta.pads}`], ['Footprints', order.boardMeta.footprints], ['KiCad', order.boardMeta.kicadVersion]] : []),
    ].flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v ?? '—'))])),
    order.notes ? el('div', { style: 'margin-top:16px' }, el('div', { class: 'low' }, 'Notes'), el('p', { style: 'white-space:pre-wrap;font-size:14px;margin:4px 0 0' }, order.notes)) : null,
  ));

  if (payments.length) {
    side.append(el('section', { class: 'card' }, el('div', { class: 'card__title' }, el('h3', {}, 'Transactions')),
      el('ul', { class: 'price-lines' }, payments.map((p) => el('li', {},
        el('span', {}, `${providerName(p.provider)} · `, badge(p.status === 'paid' ? 'completed' : p.status === 'pending' ? 'pending' : 'failed', p.status), p.refId ? el('span', { class: 'low mono' }, ` ${p.refId}`) : null),
        el('span', {}, money(p.amount)))))));
  }

  side.append(el('section', { class: 'card' }, el('div', { class: 'card__title' }, el('h3', {}, 'Activity')),
    el('ul', { class: 'timeline' }, events.map((e) => {
      const t = EVENT_TEXT[e.type];
      const text = typeof t === 'function' ? t(e.data || {}, labels) : t || e.type;
      return el('li', {}, el('time', {}, fmtDate(e.createdAt)), text);
    }))));
}

function adminControls(order, cfg, reload) {
  const statusSel = el('select', { 'aria-label': 'Status' }, Object.entries(cfg.statusLabels).map(([v, l]) => el('option', { value: v, selected: v === order.status }, l)));
  const locked = ['paid', 'in_progress', 'delivered', 'completed'].includes(order.status);
  const priceIn = el('input', { type: 'number', min: 0, step: '0.01', value: order.price ? (order.price / 100).toFixed(2) : '', disabled: locked, placeholder: 'e.g. 249.00' });
  const noteIn = el('textarea', { placeholder: 'Internal note — never shown to the customer' }, order.adminNote || '');
  const btn = el('button', { type: 'submit', class: 'btn btn--primary' }, 'Save changes');
  const form = el('form', { class: 'card stack' },
    el('div', { class: 'card__title' }, el('h3', {}, 'Manage order'), el('span', { class: 'badge badge--admin' }, 'Admin')),
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Price (USD)'), priceIn,
      el('span', { class: 'field__hint' }, locked ? 'Locked — the order is paid.' : 'Setting a price moves "Awaiting quote" to "Awaiting payment". Any open checkout is cancelled.')),
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Status'), statusSel,
      el('span', { class: 'field__hint' }, 'For payments received off-site (wire transfer, invoice), set the status to "Paid" manually.')),
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Internal note'), noteIn),
    btn,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { adminNote: noteIn.value };
    if (statusSel.value !== order.status) body.status = statusSel.value;
    if (!locked && priceIn.value !== '' && Math.round(Number(priceIn.value) * 100) !== order.price) body.price = Number(priceIn.value);
    btn.disabled = true;
    try {
      await api(`/admin/orders/${order.code}`, { method: 'PATCH', body });
      toast('Saved.');
      reload();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
  return form;
}
