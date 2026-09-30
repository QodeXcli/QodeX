// Payment orchestration shared by the checkout routes, gateway return URLs and
// the Stripe webhook. A payment is only marked paid after the gateway itself
// confirms it (server-to-server verify), and finalisation is idempotent.
import { randomBytes } from 'node:crypto';
import { logEvent } from '../db.js';
import { HttpError } from '../routes/shared.js';

export function createPaymentService(ctx) {
  const { db, config, providers } = ctx;

  function provider(name) {
    const p = providers.get(name);
    if (!p) throw new HttpError(400, 'That payment method is not available.');
    return p;
  }

  /** Create a checkout with the chosen gateway; returns { redirectUrl }. */
  async function start(order, user, providerName) {
    const gw = provider(providerName || [...providers.keys()][0]);
    const publicId = randomBytes(12).toString('base64url');
    const info = db
      .prepare('INSERT INTO payments (public_id, order_id, provider, amount, currency) VALUES (?, ?, ?, ?, ?)')
      .run(publicId, order.id, gw.name, order.price, order.currency);
    let created;
    try {
      created = await gw.create({
        amount: order.price,
        currency: order.currency,
        description: `${config.siteName} order ${order.code} — ${order.title}`.slice(0, 250),
        returnUrl: `${config.baseUrl}/api/payments/${gw.name}/return?pid=${publicId}`,
        cancelUrl: `${config.baseUrl}/portal/orders/${order.code}?payment=cancelled`,
        email: user.email,
        paymentPublicId: publicId,
        orderCode: order.code,
        brandName: config.siteName,
      });
    } catch (err) {
      db.prepare("UPDATE payments SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 500), info.lastInsertRowid);
      console.error(`[payments] ${gw.name} create failed:`, err.message);
      throw new HttpError(502, 'Could not reach the payment provider. Please try again.');
    }
    db.prepare('UPDATE payments SET authority = ? WHERE id = ?').run(created.authority, info.lastInsertRowid);
    logEvent(db, order.id, user.id, 'payment_started', { provider: gw.name, amount: order.price });
    return { redirectUrl: created.redirectUrl };
  }

  /** Verify with the gateway and record the outcome. Returns { order, ok }. */
  async function finalize(payment, query = {}) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
    const current = db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id);
    if (current.status === 'paid') return { order, ok: true };
    if (current.status === 'failed') return { order, ok: false };
    let result;
    try {
      result = await provider(payment.provider).verify({
        authority: payment.authority,
        amount: payment.amount,
        currency: payment.currency,
        paymentPublicId: payment.public_id,
        query,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    let ok = false;
    db.transaction(() => {
      // Re-check inside the transaction so concurrent return + webhook calls
      // record the payment exactly once.
      const again = db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id);
      if (again.status !== 'pending') {
        ok = again.status === 'paid';
        return;
      }
      if (result.ok) {
        ok = true;
        db.prepare("UPDATE payments SET status = 'paid', ref_id = ?, paid_at = datetime('now') WHERE id = ?").run(result.refId || null, payment.id);
        const fresh = db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id);
        if (fresh.status === 'awaiting_payment' || fresh.status === 'quote_pending') {
          db.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(order.id);
        } else {
          logEvent(db, order.id, null, 'payment_attention', { message: `Payment received while the order was "${fresh.status}". Manual review needed.` });
        }
        logEvent(db, order.id, null, 'payment_succeeded', { provider: payment.provider, amount: payment.amount, refId: result.refId });
      } else {
        db.prepare("UPDATE payments SET status = 'failed', error = ? WHERE id = ?").run(String(result.error || 'failed').slice(0, 500), payment.id);
        logEvent(db, order.id, null, 'payment_failed', { provider: payment.provider, error: result.error });
      }
    })();
    return { order, ok };
  }

  const byPublicId = (pid) => db.prepare('SELECT * FROM payments WHERE public_id = ?').get(String(pid || ''));

  return {
    start,
    finalize,
    byPublicId,
    methods: () => [...providers.values()].map((p) => ({ id: p.name, label: p.label })),
  };
}
