import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { stripeProvider } from '../server/payments/stripe.js';
import { makeBoxGlb } from './make-glb.js';

const demo = readFileSync(new URL('../public/samples/demo-board.kicad_pcb', import.meta.url));

/** Boot an app on a random port with its own data dir. */
async function boot(env = {}, deps = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'qodex-pcb-test-'));
  const config = readConfig({
    DATA_DIR: dataDir,
    ADMIN_EMAIL: 'admin@test.io',
    ADMIN_PASSWORD: 'admin-password',
    PUBLIC_BASE_URL: 'http://127.0.0.1:1',
    ...env,
  });
  const { app, close } = await createApp(config, deps);
  const server = await new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      await new Promise((r) => server.close(r));
      close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Minimal cookie-keeping client. */
function client(base) {
  let cookie = '';
  async function call(method, path, { json, form, raw, headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (csrf) h['x-qodex-request'] = '1';
    let body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) body = form;
    else if (raw !== undefined) body = raw;
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : type.includes('text') || type.includes('xml') ? await res.text() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (p, o) => call('GET', p, o),
    post: (p, o) => call('POST', p, o),
    patch: (p, o) => call('PATCH', p, o),
    put: (p, o) => call('PUT', p, o),
  };
}

function orderForm(specs, files = [['demo.kicad_pcb', demo]], title = 'Test board') {
  const f = new FormData();
  f.append('title', title);
  f.append('specs', JSON.stringify(specs));
  for (const [name, buf] of files) f.append('files', new Blob([buf]), name);
  return f;
}

const register = (c, name, email) => c.post('/api/auth/register', { json: { name, email, password: `${name}-password`, acceptTerms: true } });

describe('portal API (mock checkout)', () => {
  let app, alice, bob, admin, order;

  before(async () => {
    app = await boot();
    alice = client(app.base);
    bob = client(app.base);
    admin = client(app.base);
    assert.equal((await register(alice, 'Alice', 'alice@test.io')).status, 201);
    assert.equal((await register(bob, 'Bob', 'bob@test.io')).status, 201);
    assert.equal((await admin.post('/api/auth/login', { json: { email: 'admin@test.io', password: 'admin-password' } })).status, 200);
  });
  after(() => app.stop());

  test('public pages render server-side with SEO metadata', async () => {
    const anon = client(app.base);
    for (const path of ['/', '/how-it-works', '/studio', '/pricing', '/use-cases', '/use-cases/rf-microwave', '/integrations', '/evidence-library', '/docs', '/trust-security', '/about', '/careers', '/contact', '/legal', '/login', '/register']) {
      const r = await anon.get(path);
      assert.equal(r.status, 200, path);
      assert.match(r.data, /<title>[^<]+<\/title>/, path);
      assert.match(r.data, /<link rel="canonical"/, path);
      assert.doesNotMatch(r.data, /[\u0600-\u06FF]/, `${path} contains non-English script`);
      assert.doesNotMatch(r.data, /\{\{/, `${path} has an unfilled placeholder`);
    }
    assert.equal((await anon.get('/use-cases/nope')).status, 404);
    const sitemap = await anon.get('/sitemap.xml');
    assert.match(sitemap.data, /\/use-cases\/hdi-microvia/);
    assert.match((await anon.get('/robots.txt')).data, /Disallow: \/portal/);
    assert.match((await anon.get('/llms.txt')).data, /KiCad/);
  });

  test('state-changing requests without the CSRF header are rejected', async () => {
    assert.equal((await alice.post('/api/orders/X/cancel', { csrf: false })).status, 403);
  });

  test('registration rules and wrong password', async () => {
    const c = client(app.base);
    assert.equal((await c.post('/api/auth/register', { json: { name: 'Al', email: 'ALICE@test.io', password: 'whatever12', acceptTerms: true } })).status, 409);
    assert.equal((await c.post('/api/auth/register', { json: { name: 'Carol', email: 'carol@test.io', password: 'whatever12' } })).status, 400, 'terms must be accepted');
    assert.equal((await c.post('/api/auth/login', { json: { email: 'alice@test.io', password: 'nope-nope' } })).status, 401);
  });

  test('portal and admin pages require the right role', async () => {
    const r = await fetch(app.base + '/portal', { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^\/login\?next=/);
    assert.equal((await alice.get('/admin')).status, 302);
    assert.equal((await alice.get('/portal')).status, 200);
  });

  test('config exposes USD and the enabled checkouts', async () => {
    const { data } = await alice.get('/api/config');
    assert.equal(data.currency, 'USD');
    assert.deepEqual(data.paymentMethods.map((m) => m.id), ['mock']);
  });

  test('create order: board is parsed server-side and auto-quoted in USD', async () => {
    const r = await alice.post('/api/orders', { form: orderForm({ service: 'routing_fab', quantity: 10, maskColor: 'black', layers: 2, widthMm: 5, heightMm: 5, nets: 0, pads: 0 }) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    order = r.data.order;
    assert.equal(order.status, 'awaiting_payment');
    assert.equal(order.currency, 'USD');
    assert.equal(order.boardMeta.copperLayerCount, 4);
    assert.equal(order.specs.layers, 4, 'layers taken from the board file');
    assert.equal(order.specs.widthMm, 64);
    assert.equal(order.specs.nets, 11);
    assert.ok(order.price >= 4900);
    assert.equal(r.data.files[0].viewerKind, 'kicad_pcb');
    assert.equal(order.adminNote, undefined, 'internal note is never sent to customers');
  });

  test('disallowed file types are rejected', async () => {
    assert.equal((await alice.post('/api/orders', { form: orderForm({ service: 'routing' }, [['evil.exe', Buffer.from('MZ')]]) })).status, 400);
  });

  test('other customers cannot see the order or its files', async () => {
    const fileId = (await alice.get(`/api/orders/${order.code}`)).data.files[0].id;
    assert.equal((await bob.get(`/api/orders/${order.code}`)).status, 404);
    assert.equal((await bob.get(`/api/files/${fileId}`)).status, 404);
    assert.equal((await client(app.base).get(`/api/files/${fileId}`)).status, 401);
    const own = await alice.get(`/api/files/${fileId}`);
    assert.equal(own.status, 200);
    assert.ok(Buffer.compare(own.data, demo) === 0, 'download is byte-identical');
    assert.equal((await bob.post(`/api/orders/${order.code}/pay`)).status, 404);
  });

  test('unknown payment method is refused', async () => {
    assert.equal((await alice.post(`/api/orders/${order.code}/pay`, { json: { method: 'bitcoin' } })).status, 400);
  });

  test('pay via the test checkout; replays are idempotent; receipt issued', async () => {
    const r = await alice.post(`/api/orders/${order.code}/pay`, { json: { method: 'mock' } });
    assert.equal(r.status, 200);
    const pid = r.data.redirectUrl.split('/').pop();
    assert.equal((await bob.post(`/api/payments/mock/${pid}`, { json: { outcome: 'OK' } })).status, 404);
    assert.match((await alice.post(`/api/payments/mock/${pid}`, { json: { outcome: 'OK' } })).data.redirectUrl, /payment=success/);
    assert.match((await alice.post(`/api/payments/mock/${pid}`, { json: { outcome: 'OK' } })).data.redirectUrl, /payment=success/);
    const d = (await alice.get(`/api/orders/${order.code}`)).data;
    assert.equal(d.order.status, 'paid');
    assert.equal(d.payments.filter((p) => p.status === 'paid').length, 1);
    assert.equal((await alice.post(`/api/orders/${order.code}/pay`)).status, 409, 'cannot pay twice');

    const list = (await alice.get('/api/payments')).data.payments;
    assert.equal(list.length, 1);
    const receipt = await alice.get(`/api/payments/${list[0].id}/receipt`);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.data.payment.amount, order.price);
    assert.equal((await bob.get(`/api/payments/${list[0].id}/receipt`)).status, 404);
  });

  test('admin cannot reprice a paid order; non-admins get 403', async () => {
    assert.equal((await admin.patch(`/api/admin/orders/${order.code}`, { json: { price: 1 } })).status, 409);
    assert.equal((await alice.get('/api/admin/orders')).status, 403);
  });

  test('admin delivers a GLB; the customer can list and download it', async () => {
    const glb = makeBoxGlb();
    const f = new FormData();
    f.append('files', new Blob([glb]), 'routed-board.glb');
    f.append('note', 'final routed board');
    f.append('markDelivered', 'true');
    const r = await admin.post(`/api/admin/orders/${order.code}/files`, { form: f });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.order.status, 'delivered');
    const d = (await alice.get(`/api/orders/${order.code}`)).data;
    const delivered = d.files.find((x) => x.source === 'admin');
    assert.equal(delivered.viewerKind, 'glb');
    assert.ok(Buffer.compare((await alice.get(`/api/files/${delivered.id}`)).data, glb) === 0);
    assert.equal((await alice.get(`/api/files/${delivered.id}/meta`)).data.look.maskColor, 'black');
  });

  test('messages thread and completion', async () => {
    await admin.post(`/api/orders/${order.code}/messages`, { json: { body: 'Routed, please review.' } });
    await alice.post(`/api/orders/${order.code}/messages`, { json: { body: 'Looks good!' } });
    const d = (await alice.get(`/api/orders/${order.code}`)).data;
    assert.deepEqual(d.messages.map((m) => m.isAdmin), [true, false]);
    assert.equal((await alice.post(`/api/orders/${order.code}/confirm`)).data.order.status, 'completed');
  });

  test('manual quoting: order waits for a price, then becomes payable', async () => {
    const settings = (await admin.get('/api/admin/settings/pricing')).data.pricing;
    settings.autoQuote = false;
    assert.equal((await admin.put('/api/admin/settings/pricing', { json: { pricing: settings } })).status, 200);
    const o = (await alice.post('/api/orders', { form: orderForm({ service: 'routing' }) })).data.order;
    assert.equal(o.status, 'quote_pending');
    assert.equal(o.price, null);
    assert.equal((await alice.post(`/api/orders/${o.code}/pay`)).status, 409);
    const p = await admin.patch(`/api/admin/orders/${o.code}`, { json: { price: 249.5, adminNote: 'tricky BGA' } });
    assert.equal(p.data.order.status, 'awaiting_payment');
    assert.equal(p.data.order.price, 24950);
    assert.equal((await alice.get(`/api/orders/${o.code}`)).data.order.adminNote, undefined);
    assert.equal((await alice.post(`/api/orders/${o.code}/pay`)).status, 200);
    await admin.patch(`/api/admin/orders/${o.code}`, { json: { price: 300 } });
    assert.equal((await alice.get(`/api/orders/${o.code}`)).data.payments[0].status, 'failed', 'repricing cancels the open checkout');
    assert.equal((await alice.post(`/api/orders/${o.code}/cancel`)).data.order.status, 'cancelled');
  });

  test('contact form: validation, honeypot, admin inbox', async () => {
    const anon = client(app.base);
    assert.equal((await anon.post('/api/contact', { json: { name: 'X', email: 'bad', message: 'hi' } })).status, 400);
    assert.equal((await anon.post('/api/contact', { json: { name: 'Spam', email: 's@x.io', message: 'buy stuff now please', website: 'http://spam' } })).status, 201);
    assert.equal((await anon.post('/api/contact', { json: { name: 'Dana', email: 'dana@corp.io', topic: 'sales', message: 'We need 20 boards routed per quarter.' } })).status, 201);
    const { inquiries } = (await admin.get('/api/admin/inquiries')).data;
    assert.equal(inquiries.length, 1, 'honeypot submission was dropped');
    assert.equal(inquiries[0].topic, 'sales');
    assert.equal((await admin.patch(`/api/admin/inquiries/${inquiries[0].id}`, { json: { status: 'handled' } })).status, 200);
  });
});

describe('PayPal + Stripe checkout', () => {
  let app, alice, calls, orderCode;
  const STRIPE_WHSEC = 'whsec_test_secret';
  let stripeSession = null;
  let ppCount = 0;

  const fakeFetch = async (url, init = {}) => {
    const body = init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    calls.push({ url, method: init.method, body, headers: init.headers });
    // PayPal
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    if (url.endsWith('/v2/checkout/orders') && init.method === 'POST') {
      ppCount++;
      if (ppCount > 1) return Response.json({ id: `PP-ORDER-${ppCount}`, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-${ppCount}` }] }, { status: 201 });
      return Response.json({ id: 'PP-ORDER-1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-1' }] }, { status: 201 });
    }
    const cap = /\/v2\/checkout\/orders\/(PP-ORDER-\d+)\/capture$/.exec(url);
    if (cap) {
      const id = cap[1];
      const created = calls.filter((c) => c.url.endsWith('/v2/checkout/orders'))[Number(id.split('-').pop()) - 1];
      const unit = created.body.purchase_units[0];
      return Response.json({ id, status: 'COMPLETED', purchase_units: [{ custom_id: unit.custom_id, payments: { captures: [{ id: 'CAPTURE-9', status: 'COMPLETED', amount: unit.amount }] } }] }, { status: 201 });
    }
    // Stripe
    if (url.endsWith('/v1/checkout/sessions') && init.method === 'POST') {
      const p = new URLSearchParams(init.body);
      stripeSession = { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', client_reference_id: p.get('client_reference_id'), amount_total: Number(p.get('line_items[0][price_data][unit_amount]')), currency: p.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', payment_intent: 'pi_1' };
      return Response.json(stripeSession);
    }
    if (url.includes('/v1/checkout/sessions/cs_test_1')) return Response.json(stripeSession);
    return new Response('not found', { status: 404 });
  };

  before(async () => {
    calls = [];
    app = await boot({
      PAYMENT_PROVIDERS: 'stripe,paypal',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: STRIPE_WHSEC,
      PAYPAL_CLIENT_ID: 'id',
      PAYPAL_CLIENT_SECRET: 'secret',
      PAYPAL_SANDBOX: 'true',
    }, { fetch: fakeFetch });
    alice = client(app.base);
    await register(alice, 'Alice', 'alice@test.io');
  });
  after(() => app.stop());

  test('PayPal: create order → approve redirect → capture on return', async () => {
    const o = (await alice.post('/api/orders', { form: orderForm({ service: 'routing' }) })).data.order;
    const pay = await alice.post(`/api/orders/${o.code}/pay`, { json: { method: 'paypal' } });
    assert.equal(pay.data.redirectUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-1');
    const create = calls.find((c) => c.url === 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
    assert.equal(create.body.purchase_units[0].amount.currency_code, 'USD');
    assert.equal(create.body.purchase_units[0].amount.value, (o.price / 100).toFixed(2));
    const returnUrl = new URL(create.body.payment_source.paypal.experience_context.return_url);
    const pid = returnUrl.searchParams.get('pid');

    const forged = await alice.get(`/api/payments/paypal/return?pid=${pid}&token=SOMEONE-ELSE`);
    assert.match(forged.headers.get('location'), /payment=failed/);
    assert.equal((await alice.get(`/api/orders/${o.code}`)).data.order.status, 'awaiting_payment', 'forged token must not mark the order paid');
  });

  test('PayPal: a genuine return captures and marks the order paid', async () => {
    const o = (await alice.post('/api/orders', { form: orderForm({ service: 'routing' }) })).data.order;
    orderCode = o.code;
    await alice.post(`/api/orders/${o.code}/pay`, { json: { method: 'paypal' } });
    const create = calls.filter((c) => c.url === 'https://api-m.sandbox.paypal.com/v2/checkout/orders').at(-1);
    const pid = new URL(create.body.payment_source.paypal.experience_context.return_url).searchParams.get('pid');
    const ret = await alice.get(`/api/payments/paypal/return?pid=${pid}&token=PP-ORDER-${ppCount}&PayerID=X`);
    assert.equal(ret.headers.get('location'), `/portal/orders/${o.code}?payment=success`);
    const d = (await alice.get(`/api/orders/${o.code}`)).data;
    assert.equal(d.order.status, 'paid');
    assert.equal(d.payments[0].refId, 'CAPTURE-9');
  });

  test('Stripe: unpaid session is not accepted; signed webhook finalises the payment', async () => {
    const o = (await alice.post('/api/orders', { form: orderForm({ service: 'dfm_review' }) })).data.order;
    const pay = await alice.post(`/api/orders/${o.code}/pay`, { json: { method: 'stripe' } });
    assert.equal(pay.data.redirectUrl, 'https://checkout.stripe.com/c/pay/cs_test_1');
    assert.equal(stripeSession.amount_total, o.price);
    assert.equal(stripeSession.currency, 'usd');
    const pid = stripeSession.client_reference_id;

    // webhook with a bad signature is refused
    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', client_reference_id: pid } } });
    const bad = await client(app.base).post('/api/payments/stripe/webhook', { raw: event, csrf: false, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=deadbeef` } });
    assert.equal(bad.status, 400);

    // the customer comes back before Stripe reports the session as paid
    stripeSession.payment_status = 'unpaid';
    // (not calling return here: it would mark the attempt failed)

    stripeSession.payment_status = 'paid';
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', STRIPE_WHSEC).update(`${t}.${event}`).digest('hex');
    const ok = await client(app.base).post('/api/payments/stripe/webhook', { raw: event, csrf: false, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` } });
    assert.equal(ok.status, 200);
    assert.equal((await alice.get(`/api/orders/${o.code}`)).data.order.status, 'paid');

    // the browser return afterwards is a harmless no-op
    const ret = await alice.get(`/api/payments/stripe/return?pid=${pid}`);
    assert.match(ret.headers.get('location'), /payment=success/);
    assert.ok(orderCode);
  });
});

test('Stripe verify rejects amount / reference mismatches', async () => {
  const fake = async () => Response.json({ payment_status: 'paid', amount_total: 999, currency: 'usd', client_reference_id: 'pid1', payment_intent: 'pi_1' });
  const s = stripeProvider({ secretKey: 'sk_test' }, fake);
  assert.equal((await s.verify({ authority: 'cs_1', amount: 999, currency: 'USD', paymentPublicId: 'pid1' })).ok, true);
  assert.equal((await s.verify({ authority: 'cs_1', amount: 1000, currency: 'USD', paymentPublicId: 'pid1' })).ok, false);
  assert.equal((await s.verify({ authority: 'cs_1', amount: 999, currency: 'USD', paymentPublicId: 'other' })).ok, false);
});

test('config validation', () => {
  assert.throws(() => readConfig({ PAYMENT_PROVIDERS: 'zarinpal' }), /Unknown payment provider/);
  assert.throws(() => readConfig({ PAYMENT_PROVIDERS: 'stripe' }), /STRIPE_SECRET_KEY/);
  assert.throws(() => readConfig({ PAYMENT_PROVIDERS: 'paypal', PAYPAL_CLIENT_ID: 'x' }), /PAYPAL_CLIENT_SECRET/);
  assert.equal(readConfig({}).currency, 'USD');
});
