// Stripe Checkout (hosted payment page) via the REST API — no SDK needed.
// Cards, Apple Pay, Google Pay and Link are all offered by Checkout itself.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function stripeProvider({ secretKey, webhookSecret }, fetchImpl = fetch) {
  async function call(method, path, params) {
    const res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: params ? new URLSearchParams(params).toString() : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Stripe error: ${json?.error?.message || res.status}`);
    return json;
  }

  return {
    name: 'stripe',
    label: 'Card, Apple Pay, Google Pay (Stripe)',

    async create({ amount, currency, description, returnUrl, cancelUrl, email, paymentPublicId, orderCode }) {
      const session = await call('POST', '/checkout/sessions', {
        mode: 'payment',
        success_url: returnUrl,
        cancel_url: cancelUrl,
        client_reference_id: paymentPublicId,
        'metadata[payment_id]': paymentPublicId,
        'metadata[order_code]': orderCode,
        'payment_intent_data[description]': description,
        ...(email ? { customer_email: email } : {}),
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(amount),
        'line_items[0][price_data][product_data][name]': description,
      });
      return { authority: session.id, redirectUrl: session.url };
    },

    async verify({ authority, amount, currency, paymentPublicId }) {
      const s = await call('GET', `/checkout/sessions/${encodeURIComponent(authority)}`);
      if (s.payment_status !== 'paid') return { ok: false, error: 'The Stripe checkout was not completed.' };
      if (s.amount_total !== amount || String(s.currency).toUpperCase() !== currency || s.client_reference_id !== paymentPublicId) {
        return { ok: false, error: 'Amount or reference does not match the order.' };
      }
      return { ok: true, refId: String(s.payment_intent || s.id) };
    },

    /**
     * Validate a webhook delivery (Stripe-Signature: t=..,v1=..) and return the
     * parsed event, or null when the signature is missing/invalid/stale.
     */
    parseWebhook(rawBody, signatureHeader, toleranceSec = 300) {
      if (!webhookSecret || !signatureHeader) return null;
      const parts = Object.fromEntries(
        String(signatureHeader)
          .split(',')
          .map((kv) => kv.split('='))
          .filter((kv) => kv.length === 2 && kv[0] === 't'),
      );
      const t = Number(parts.t);
      if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return null;
      const expected = createHmac('sha256', webhookSecret).update(`${t}.${rawBody.toString('utf8')}`).digest();
      const candidates = String(signatureHeader)
        .split(',')
        .filter((kv) => kv.startsWith('v1='))
        .map((kv) => Buffer.from(kv.slice(3), 'hex'));
      const ok = candidates.some((c) => c.length === expected.length && timingSafeEqual(c, expected));
      if (!ok) return null;
      try {
        return JSON.parse(rawBody.toString('utf8'));
      } catch {
        return null;
      }
    },
  };
}
