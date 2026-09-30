import { Router } from 'express';
import {
  createSession,
  destroySession,
  hashPassword,
  limiter,
  requireUser,
  sessionCookie,
  verifyPassword,
} from '../auth.js';
import { getSetting, logEvent } from '../db.js';
import { OPTIONS, SERVICES, SERVICE_DETAILS, computeQuote, normalizeSpecs } from '../pricing.js';
import {
  EMAIL_RE,
  HttpError,
  STATUS_LABELS,
  asyncH,
  boardMetaFromUploads,
  cleanText,
  cleanupTemp,
  newOrderCode,
  orderDTO,
  orderDetail,
  paymentDTO,
  storeUploads,
  uploader,
} from './shared.js';

export const INQUIRY_TOPICS = {
  sales: 'Sales & enterprise',
  engineering: 'Engineering question',
  security: 'Security & compliance',
  careers: 'Careers',
  other: 'Other',
};

export function apiRouter(ctx) {
  const { db, config, payments } = ctx;
  const r = Router();
  const upload = uploader(ctx);
  const authLimit = limiter({ windowMs: 10 * 60e3, limit: 20 });
  const contactLimit = limiter({ windowMs: 60 * 60e3, limit: 10 });
  r.use(limiter({ windowMs: 5 * 60e3, limit: 1000 }));

  const userDTO = (u) => u && { id: u.id, email: u.email, name: u.name, phone: u.phone, company: u.company, country: u.country, role: u.role };
  const setCookie = (res, s) => res.setHeader('Set-Cookie', sessionCookie(s.token, { secure: config.secureCookies, expires: s.expires }));

  // ── public config ──
  r.get('/config', (_req, res) => {
    const pricing = getSetting(db, 'pricing');
    res.json({
      siteName: config.siteName,
      currency: config.currency,
      paymentMethods: payments.methods(),
      maxUploadMb: config.maxUploadMb,
      autoQuote: !!pricing?.autoQuote,
      services: SERVICES,
      serviceDetails: SERVICE_DETAILS,
      options: OPTIONS,
      statusLabels: STATUS_LABELS,
      inquiryTopics: INQUIRY_TOPICS,
      supportEmail: config.supportEmail,
    });
  });

  // ── auth ──
  r.post('/auth/register', authLimit, asyncH(async (req, res) => {
    const email = cleanText(req.body?.email, 200).toLowerCase();
    const name = cleanText(req.body?.name, 120);
    const password = String(req.body?.password ?? '');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (name.length < 2) throw new HttpError(400, 'Enter your name.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (req.body?.acceptTerms !== true && req.body?.acceptTerms !== 'on') throw new HttpError(400, 'Please accept the Terms of Service and IP policy.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
    const info = db
      .prepare('INSERT INTO users (email, name, phone, company, country, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        email,
        name,
        cleanText(req.body?.phone, 30) || null,
        cleanText(req.body?.company, 160) || null,
        cleanText(req.body?.country, 60) || null,
        await hashPassword(password),
      );
    setCookie(res, createSession(db, info.lastInsertRowid));
    res.status(201).json({ user: userDTO(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
  }));

  r.post('/auth/login', authLimit, asyncH(async (req, res) => {
    const email = cleanText(req.body?.email, 200).toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = user && (await verifyPassword(String(req.body?.password ?? ''), user.password_hash));
    if (!ok) throw new HttpError(401, 'Incorrect email or password.');
    setCookie(res, createSession(db, user.id));
    res.json({ user: userDTO(user) });
  }));

  r.post('/auth/logout', (req, res) => {
    destroySession(db, req.sessionToken);
    res.setHeader('Set-Cookie', sessionCookie('', { secure: config.secureCookies }));
    res.json({ ok: true });
  });

  r.get('/auth/me', (req, res) => res.json({ user: userDTO(req.user) }));

  r.patch('/auth/me', requireUser, (req, res) => {
    const b = req.body || {};
    const name = cleanText(b.name ?? req.user.name, 120);
    if (name.length < 2) throw new HttpError(400, 'Enter your name.');
    db.prepare('UPDATE users SET name = ?, phone = ?, company = ?, country = ? WHERE id = ?').run(
      name,
      cleanText(b.phone ?? req.user.phone, 30) || null,
      cleanText(b.company ?? req.user.company, 160) || null,
      cleanText(b.country ?? req.user.country, 60) || null,
      req.user.id,
    );
    res.json({ user: userDTO(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  r.post('/auth/password', requireUser, authLimit, asyncH(async (req, res) => {
    const current = String(req.body?.currentPassword ?? '');
    const next = String(req.body?.newPassword ?? '');
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(current, u.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
    if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), req.user.id);
    // sign out every other session
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
    setCookie(res, createSession(db, req.user.id));
    res.json({ ok: true });
  }));

  // ── public: quote estimator + contact ──
  r.post('/quote', (req, res) => {
    const pricing = getSetting(db, 'pricing');
    const meta = req.body?.boardMeta && typeof req.body.boardMeta === 'object' ? { hasBGA: !!req.body.boardMeta.hasBGA } : null;
    const specs = normalizeSpecs(req.body?.specs || {}, null);
    res.json({ specs, quote: computeQuote(specs, pricing, meta) });
  });

  r.post('/contact', contactLimit, (req, res) => {
    const b = req.body || {};
    // honeypot field: real users never fill it
    if (b.website) return res.status(201).json({ ok: true });
    const name = cleanText(b.name, 120);
    const email = cleanText(b.email, 200).toLowerCase();
    const message = cleanText(b.message, 8000);
    const topic = INQUIRY_TOPICS[b.topic] ? b.topic : 'other';
    if (name.length < 2) throw new HttpError(400, 'Enter your name.');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (message.length < 10) throw new HttpError(400, 'Tell us a little more (at least 10 characters).');
    db.prepare('INSERT INTO inquiries (name, email, company, topic, message) VALUES (?, ?, ?, ?, ?)').run(name, email, cleanText(b.company, 160) || null, topic, message);
    res.status(201).json({ ok: true });
  });

  // ── orders (customer) ──
  const findOwnOrder = (req) => {
    const o = db.prepare('SELECT * FROM orders WHERE code = ?').get(String(req.params.code));
    if (!o || (o.user_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Order not found.');
    return o;
  };
  const detail = (req, o) => orderDetail(db, o, { admin: req.user.role === 'admin' });
  const touch = (id) => db.prepare("UPDATE orders SET updated_at = datetime('now') WHERE id = ?").run(id);

  r.get('/orders', requireUser, (req, res) => {
    const rows = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    const counts = db
      .prepare("SELECT order_id, COUNT(*) AS n FROM files WHERE source = 'admin' AND order_id IN (SELECT id FROM orders WHERE user_id = ?) GROUP BY order_id")
      .all(req.user.id);
    const msgs = db
      .prepare('SELECT order_id, COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE is_admin = 1 AND order_id IN (SELECT id FROM orders WHERE user_id = ?) GROUP BY order_id')
      .all(req.user.id);
    const delivered = new Map(counts.map((c) => [c.order_id, c.n]));
    const replies = new Map(msgs.map((m) => [m.order_id, m]));
    res.json({
      orders: rows.map((o) => {
        const dto = orderDTO(o);
        delete dto.adminNote;
        return { ...dto, deliveredFiles: delivered.get(o.id) || 0, engineerMessages: replies.get(o.id)?.n || 0, lastEngineerMessage: replies.get(o.id)?.last || null };
      }),
    });
  });

  r.post('/orders', requireUser, upload.array('files', 20), asyncH(async (req, res) => {
    try {
      let raw;
      try {
        raw = JSON.parse(req.body?.specs || '{}');
      } catch {
        throw new HttpError(400, 'Invalid order specification.');
      }
      const title = cleanText(req.body?.title, 160);
      if (title.length < 2) throw new HttpError(400, 'Give your project a title.');
      if (!req.files?.length) throw new HttpError(400, 'Upload at least one project file (ideally the .kicad_pcb).');
      const { meta, error: metaError } = await boardMetaFromUploads(req.files);
      const specs = normalizeSpecs(raw, meta);
      const pricing = getSetting(db, 'pricing');
      const quote = computeQuote(specs, pricing, meta);
      const auto = !!pricing.autoQuote;
      const code = newOrderCode();
      const info = db
        .prepare(`INSERT INTO orders (code, user_id, title, service, specs, board_meta, notes, price, currency, price_breakdown, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          code,
          req.user.id,
          title,
          specs.service,
          JSON.stringify(specs),
          meta ? JSON.stringify(meta) : null,
          cleanText(req.body?.notes, 5000) || null,
          auto ? quote.total : null,
          config.currency,
          JSON.stringify(quote.lines),
          auto ? 'awaiting_payment' : 'quote_pending',
        );
      const orderId = Number(info.lastInsertRowid);
      await storeUploads(ctx, req.files, { orderId, uploaderId: req.user.id, source: 'customer' });
      logEvent(db, orderId, req.user.id, 'created', { status: auto ? 'awaiting_payment' : 'quote_pending', price: auto ? quote.total : null });
      if (metaError) logEvent(db, orderId, null, 'parse_warning', { message: metaError });
      res.status(201).json(detail(req, db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)));
    } finally {
      await cleanupTemp(req.files);
    }
  }));

  r.get('/orders/:code', requireUser, (req, res) => {
    res.json(detail(req, findOwnOrder(req)));
  });

  r.post('/orders/:code/files', requireUser, upload.array('files', 20), asyncH(async (req, res) => {
    try {
      const o = findOwnOrder(req);
      if (['cancelled', 'completed'].includes(o.status)) throw new HttpError(409, 'This order is closed.');
      if (!req.files?.length) throw new HttpError(400, 'No file selected.');
      const source = req.user.role === 'admin' && o.user_id !== req.user.id ? 'admin' : 'customer';
      const rows = await storeUploads(ctx, req.files, { orderId: o.id, uploaderId: req.user.id, source, note: cleanText(req.body?.note, 500) });
      logEvent(db, o.id, req.user.id, 'files_added', { count: rows.length, source });
      touch(o.id);
      res.status(201).json(detail(req, o));
    } finally {
      await cleanupTemp(req.files);
    }
  }));

  r.post('/orders/:code/messages', requireUser, (req, res) => {
    const o = findOwnOrder(req);
    const body = cleanText(req.body?.body, 5000);
    if (!body) throw new HttpError(400, 'Message is empty.');
    db.prepare('INSERT INTO messages (order_id, user_id, is_admin, body) VALUES (?, ?, ?, ?)').run(o.id, req.user.id, req.user.role === 'admin' ? 1 : 0, body);
    touch(o.id);
    res.status(201).json(detail(req, o));
  });

  r.post('/orders/:code/cancel', requireUser, (req, res) => {
    const o = findOwnOrder(req);
    if (!['quote_pending', 'awaiting_payment'].includes(o.status)) throw new HttpError(409, 'Only unpaid orders can be cancelled.');
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(o.id);
    db.prepare("UPDATE payments SET status = 'failed', error = 'order cancelled' WHERE order_id = ? AND status = 'pending'").run(o.id);
    logEvent(db, o.id, req.user.id, 'status', { from: o.status, to: 'cancelled' });
    res.json(detail(req, db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id)));
  });

  r.post('/orders/:code/confirm', requireUser, (req, res) => {
    const o = findOwnOrder(req);
    if (o.status !== 'delivered') throw new HttpError(409, 'This order has not been delivered yet.');
    db.prepare("UPDATE orders SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(o.id);
    logEvent(db, o.id, req.user.id, 'status', { from: o.status, to: 'completed' });
    res.json(detail(req, db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id)));
  });

  // ── payments ──
  r.post('/orders/:code/pay', requireUser, asyncH(async (req, res) => {
    const o = findOwnOrder(req);
    if (o.user_id !== req.user.id) throw new HttpError(403, 'Only the order owner can pay for it.');
    if (o.status !== 'awaiting_payment' || !(o.price > 0)) throw new HttpError(409, 'This order is not ready for payment.');
    res.json(await payments.start(o, req.user, req.body?.method));
  }));

  r.get('/payments', requireUser, (req, res) => {
    const rows = db
      .prepare(`SELECT p.*, o.code, o.title FROM payments p JOIN orders o ON o.id = p.order_id
                WHERE o.user_id = ? AND p.status = 'paid' ORDER BY p.id DESC`)
      .all(req.user.id);
    res.json({ payments: rows.map((p) => ({ ...paymentDTO(p), orderCode: p.code, orderTitle: p.title })) });
  });

  r.get('/payments/:pid/receipt', requireUser, (req, res) => {
    const p = payments.byPublicId(req.params.pid);
    const o = p && db.prepare('SELECT * FROM orders WHERE id = ?').get(p.order_id);
    if (!p || !o || (o.user_id !== req.user.id && req.user.role !== 'admin') || p.status !== 'paid') throw new HttpError(404, 'Receipt not found.');
    const customer = db.prepare('SELECT name, email, company, country FROM users WHERE id = ?').get(o.user_id);
    res.json({
      payment: paymentDTO(p),
      order: { code: o.code, title: o.title, service: o.service, serviceLabel: SERVICES[o.service], lines: o.price_breakdown && !o.price_is_manual ? JSON.parse(o.price_breakdown) : null },
      customer,
      seller: { name: config.companyName, site: config.siteName, email: config.supportEmail, url: config.baseUrl },
    });
  });

  // Stripe / PayPal send the customer back here (browser redirect).
  r.get('/payments/:provider/return', asyncH(async (req, res) => {
    const payment = payments.byPublicId(req.query.pid);
    if (!payment || payment.provider !== req.params.provider || payment.provider === 'mock') throw new HttpError(404, 'Payment not found.');
    const { order, ok } = await payments.finalize(payment, { token: req.query.token ? String(req.query.token) : undefined });
    res.redirect(302, `/portal/orders/${order.code}?payment=${ok ? 'success' : 'failed'}`);
  }));

  // Test checkout (mock provider only)
  const mockPayment = (req) => {
    if (!ctx.providers.has('mock')) throw new HttpError(404, 'The test checkout is disabled.');
    const p = payments.byPublicId(req.params.pid);
    const o = p && db.prepare('SELECT * FROM orders WHERE id = ?').get(p.order_id);
    if (!p || p.provider !== 'mock' || !o || o.user_id !== req.user.id) throw new HttpError(404, 'Payment not found.');
    return { p, o };
  };
  r.get('/payments/mock/:pid', requireUser, (req, res) => {
    const { p, o } = mockPayment(req);
    res.json({ amount: p.amount, currency: p.currency, status: p.status, order: { code: o.code, title: o.title } });
  });
  r.post('/payments/mock/:pid', requireUser, asyncH(async (req, res) => {
    const { p, o } = mockPayment(req);
    const { ok } = await payments.finalize(p, { outcome: req.body?.outcome === 'OK' ? 'OK' : 'NOK' });
    res.json({ redirectUrl: `/portal/orders/${o.code}?payment=${ok ? 'success' : 'failed'}` });
  }));

  // ── file download (order owner or admin) ──
  const findFile = (req) => {
    const f = db
      .prepare('SELECT f.*, o.user_id, o.code, o.specs FROM files f JOIN orders o ON o.id = f.order_id WHERE f.id = ?')
      .get(String(req.params.id));
    if (!f || (f.user_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'File not found.');
    return f;
  };

  r.get('/files/:id', requireUser, (req, res, next) => {
    const f = findFile(req);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(f.size));
    res.setHeader('Cache-Control', 'private, no-store');
    const ascii = f.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
    const stream = ctx.storage.stream(f.stored_name);
    stream.on('error', next);
    stream.pipe(res);
  });

  r.get('/files/:id/meta', requireUser, (req, res) => {
    const f = findFile(req);
    const specs = JSON.parse(f.specs);
    res.json({
      id: f.id,
      name: f.original_name,
      size: f.size,
      sha256: f.sha256,
      viewerKind: f.viewer_kind,
      source: f.source,
      orderCode: f.code,
      look: { maskColor: specs.maskColor, finish: specs.finish, silkColor: specs.silkColor },
    });
  });

  return r;
}
