// PayPal Checkout — Orders v2 REST API (redirect flow, capture on return).
export function paypalProvider({ clientId, clientSecret, sandbox }, fetchImpl = fetch) {
  const api = sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  let token = null;
  let tokenExpires = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpires - 60_000) return token;
    const res = await fetchImpl(`${api}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error(`PayPal auth failed: ${json.error_description || res.status}`);
    token = json.access_token;
    tokenExpires = Date.now() + (Number(json.expires_in) || 300) * 1000;
    return token;
  }

  async function call(method, path, body, extraHeaders = {}) {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json };
  }

  const dollars = (cents) => (cents / 100).toFixed(2);

  function checkCapture(order, amount, currency, paymentPublicId) {
    const unit = order?.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    if (order?.status !== 'COMPLETED' || !capture || capture.status !== 'COMPLETED') {
      return { ok: false, error: 'The PayPal payment was not completed.' };
    }
    if (capture.amount?.currency_code !== currency || capture.amount?.value !== dollars(amount) || (unit.custom_id && unit.custom_id !== paymentPublicId)) {
      return { ok: false, error: 'Amount or reference does not match the order.' };
    }
    return { ok: true, refId: capture.id };
  }

  return {
    name: 'paypal',
    label: 'PayPal',

    async create({ amount, currency, description, returnUrl, cancelUrl, paymentPublicId, orderCode, brandName }) {
      const { ok, json } = await call(
        'POST',
        '/v2/checkout/orders',
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: orderCode,
              custom_id: paymentPublicId,
              description: description.slice(0, 127),
              amount: { currency_code: currency, value: dollars(amount) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: (brandName || 'QodeX PCB').slice(0, 127),
                user_action: 'PAY_NOW',
                shipping_preference: 'NO_SHIPPING',
                return_url: returnUrl,
                cancel_url: cancelUrl,
              },
            },
          },
        },
        { 'PayPal-Request-Id': paymentPublicId },
      );
      const link = json?.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
      if (!ok || !json.id || !link) throw new Error(`PayPal order creation failed: ${json?.message || json?.name || 'unknown error'}`);
      return { authority: json.id, redirectUrl: link.href };
    },

    async verify({ authority, amount, currency, paymentPublicId, query = {} }) {
      if (query.token && query.token !== authority) return { ok: false, error: 'PayPal token does not match this payment.' };
      const cap = await call('POST', `/v2/checkout/orders/${encodeURIComponent(authority)}/capture`, {}, { 'PayPal-Request-Id': `cap-${paymentPublicId}` });
      if (cap.ok) return checkCapture(cap.json, amount, currency, paymentPublicId);
      // Already captured (e.g. the customer refreshed the return page): read it back.
      if (cap.status === 422) {
        const got = await call('GET', `/v2/checkout/orders/${encodeURIComponent(authority)}`);
        if (got.ok) return checkCapture(got.json, amount, currency, paymentPublicId);
      }
      return { ok: false, error: cap.json?.details?.[0]?.description || cap.json?.message || 'PayPal capture failed.' };
    },
  };
}
