import { Router } from 'express';
import { limiter, requireAdmin } from '../auth.js';
import { getSetting, logEvent, setSetting } from '../db.js';
import { defaultPricing, validatePricing } from '../pricing.js';
import { HttpError, STATUS_LABELS, asyncH, cleanText, cleanupTemp, orderDTO, orderDetail, storeUploads, uploader } from './shared.js';

const ORDER_JOIN = `SELECT o.*, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone, u.company AS customer_company
  FROM orders o JOIN users u ON u.id = o.user_id`;

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function adminRouter(ctx) {
  const { db, config } = ctx;
  const r = Router();
  const upload = uploader(ctx, 30);
  r.use(limiter({ windowMs: 5 * 60e3, limit: 1000 }), requireAdmin);

  const findOrder = (code) => {
    const o = db.prepare(`${ORDER_JOIN} WHERE o.code = ?`).get(String(code));
    if (!o) throw new HttpError(404, 'Order not found.');
    return o;
  };

  r.get('/stats', (_req, res) => {
    const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map((x) => [x.status, x.n]));
    const revenue = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status = 'paid'").get().s;
    const revenue30 = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status = 'paid' AND paid_at >= datetime('now','-30 days')").get().s;
    const customers = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").get().n;
    const newInquiries = db.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'new'").get().n;
    res.json({ byStatus, revenue, revenue30, currency: config.currency, customers, newInquiries });
  });

  r.get('/orders', (req, res) => {
    const status = String(req.query.status || '');
    const q = cleanText(req.query.q, 100);
    const where = [];
    const params = [];
    if (status && STATUS_LABELS[status]) {
      where.push('o.status = ?');
      params.push(status);
    } else if (status === 'open') {
      where.push("o.status NOT IN ('completed','cancelled')");
    }
    if (q) {
      where.push('(o.code LIKE ? OR o.title LIKE ? OR u.email LIKE ? OR u.name LIKE ?)');
      params.push(...Array(4).fill(`%${q.replace(/[%_]/g, '')}%`));
    }
    const rows = db.prepare(`${ORDER_JOIN} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT 500`).all(...params);
    res.json({ orders: rows.map(orderDTO) });
  });

  r.get('/orders/:code', (req, res) => {
    res.json(orderDetail(db, findOrder(req.params.code), { admin: true }));
  });

  /** Update price / status / internal note. */
  r.patch('/orders/:code', (req, res) => {
    const o = findOrder(req.params.code);
    const body = req.body || {};
    const updates = {};
    const paidOrLater = ['paid', 'in_progress', 'delivered', 'completed'].includes(o.status);

    if (body.price !== undefined && body.price !== null && body.price !== '') {
      if (paidOrLater) throw new HttpError(409, 'The price of a paid order cannot be changed.');
      const dollars = Number(body.price);
      if (!(dollars > 0)) throw new HttpError(400, 'Price must be greater than zero.');
      updates.price = Math.round(dollars * 100);
      updates.price_is_manual = 1;
      if (o.status === 'quote_pending' && body.status === undefined) updates.status = 'awaiting_payment';
    }
    if (body.status !== undefined && body.status !== o.status) {
      if (!STATUS_LABELS[body.status]) throw new HttpError(400, 'Unknown status.');
      const price = updates.price ?? o.price;
      if (body.status === 'awaiting_payment' && !(price > 0)) throw new HttpError(400, 'Set a price first.');
      updates.status = body.status;
      if (body.status === 'paid' && !o.paid_at) updates.paid_at = sqlNow();
    }
    if (body.adminNote !== undefined) updates.admin_note = cleanText(body.adminNote, 5000) || null;
    if (!Object.keys(updates).length) return res.json(orderDetail(db, o, { admin: true }));

    db.transaction(() => {
      const sets = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE orders SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: o.id });
      if (updates.price !== undefined && updates.price !== o.price) {
        // a changed price invalidates any checkout that is still open
        db.prepare("UPDATE payments SET status = 'failed', error = 'price changed by admin' WHERE order_id = ? AND status = 'pending'").run(o.id);
        logEvent(db, o.id, req.user.id, 'price', { from: o.price, to: updates.price });
      }
      if (updates.status) {
        logEvent(db, o.id, req.user.id, 'status', { from: o.status, to: updates.status, ...(updates.status === 'paid' ? { manual: true } : {}) });
      }
    })();
    res.json(orderDetail(db, findOrder(o.code), { admin: true }));
  });

  /** Upload deliverables (routed .kicad_pcb, .glb previews, gerbers, reports). */
  r.post('/orders/:code/files', upload.array('files', 30), asyncH(async (req, res) => {
    try {
      const o = findOrder(req.params.code);
      if (!req.files?.length) throw new HttpError(400, 'No file selected.');
      const rows = await storeUploads(ctx, req.files, { orderId: o.id, uploaderId: req.user.id, source: 'admin', note: cleanText(req.body?.note, 500) });
      logEvent(db, o.id, req.user.id, 'files_added', { count: rows.length, source: 'admin', names: rows.map((x) => x.original_name) });
      if (req.body?.markDelivered === 'true' && ['paid', 'in_progress'].includes(o.status)) {
        db.prepare("UPDATE orders SET status = 'delivered', updated_at = datetime('now') WHERE id = ?").run(o.id);
        logEvent(db, o.id, req.user.id, 'status', { from: o.status, to: 'delivered' });
      } else {
        db.prepare("UPDATE orders SET updated_at = datetime('now') WHERE id = ?").run(o.id);
      }
      res.status(201).json(orderDetail(db, findOrder(o.code), { admin: true }));
    } finally {
      await cleanupTemp(req.files);
    }
  }));

  r.delete('/files/:id', asyncH(async (req, res) => {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(String(req.params.id));
    if (!f) throw new HttpError(404, 'File not found.');
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    await ctx.storage.remove(f.stored_name);
    logEvent(db, f.order_id, req.user.id, 'file_deleted', { name: f.original_name });
    res.json({ ok: true });
  }));

  r.get('/customers', (_req, res) => {
    const rows = db
      .prepare(`SELECT u.id, u.email, u.name, u.phone, u.company, u.country, u.role, u.created_at,
                  COUNT(o.id) AS orders,
                  COALESCE(SUM(CASE WHEN o.status IN ('paid','in_progress','delivered','completed') THEN o.price END), 0) AS spent
                FROM users u LEFT JOIN orders o ON o.user_id = u.id
                GROUP BY u.id ORDER BY u.id DESC LIMIT 1000`)
      .all();
    res.json({ customers: rows, currency: config.currency });
  });

  r.get('/inquiries', (_req, res) => {
    res.json({ inquiries: db.prepare('SELECT * FROM inquiries ORDER BY id DESC LIMIT 500').all() });
  });

  r.patch('/inquiries/:id', (req, res) => {
    const status = req.body?.status === 'handled' ? 'handled' : 'new';
    const info = db.prepare('UPDATE inquiries SET status = ? WHERE id = ?').run(status, Number(req.params.id));
    if (!info.changes) throw new HttpError(404, 'Inquiry not found.');
    res.json({ ok: true });
  });

  r.get('/settings/pricing', (_req, res) => {
    res.json({ pricing: getSetting(db, 'pricing'), currency: config.currency, defaults: defaultPricing() });
  });

  r.put('/settings/pricing', (req, res) => {
    const pricing = validatePricing(req.body?.pricing);
    setSetting(db, 'pricing', pricing);
    res.json({ pricing });
  });

  return r;
}
