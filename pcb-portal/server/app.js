import express from 'express';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { openDb, getSetting, setSetting } from './db.js';
import { csrfGuard, hashPassword, sessionMiddleware } from './auth.js';
import { createStorage } from './storage.js';
import { createPaymentProviders } from './payments/index.js';
import { createPaymentService } from './payments/service.js';
import { defaultPricing } from './pricing.js';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';
import { esc, renderView } from './layout.js';
import { USE_CASES, USE_CASE_BY_SLUG } from './content.js';

const PUBLIC = join(ROOT, 'public');

// [route, view, auth, sitemap priority]
const PAGES = [
  ['/', 'site/home.html', null, 1.0],
  ['/how-it-works', 'site/how-it-works.html', null, 0.9],
  ['/studio', 'site/studio.html', null, 0.9],
  ['/use-cases', 'site/use-cases.html', null, 0.8],
  ['/integrations', 'site/integrations.html', null, 0.8],
  ['/pricing', 'site/pricing.html', null, 0.9],
  ['/evidence-library', 'site/evidence.html', null, 0.7],
  ['/docs', 'site/docs.html', null, 0.8],
  ['/trust-security', 'site/trust.html', null, 0.7],
  ['/about', 'site/about.html', null, 0.5],
  ['/careers', 'site/careers.html', null, 0.4],
  ['/contact', 'site/contact.html', null, 0.6],
  ['/legal', 'site/legal.html', null, 0.3],
  ['/login', 'site/login.html', null, null],
  ['/register', 'site/register.html', null, null],
  ['/portal', 'portal/dashboard.html', 'user'],
  ['/portal/new', 'portal/new-order.html', 'user'],
  ['/portal/orders/:code', 'portal/order.html', 'user'],
  ['/portal/files/:id/view', 'portal/file-viewer.html', 'user'],
  ['/portal/billing', 'portal/billing.html', 'user'],
  ['/portal/receipts/:pid', 'portal/receipt.html', 'user'],
  ['/portal/settings', 'portal/settings.html', 'user'],
  ['/pay/mock/:pid', 'portal/pay-mock.html', 'user'],
  ['/admin', 'admin/orders.html', 'admin'],
  ['/admin/orders/:code', 'admin/order.html', 'admin'],
  ['/admin/customers', 'admin/customers.html', 'admin'],
  ['/admin/inquiries', 'admin/inquiries.html', 'admin'],
  ['/admin/settings', 'admin/settings.html', 'admin'],
];

const IMPORT_MAP = JSON.stringify({
  imports: {
    three: '/vendor/three/build/three.module.js',
    'three/addons/': '/vendor/three/examples/jsm/',
  },
});
const IMPORT_MAP_TAG = `<script type="importmap">${IMPORT_MAP}</script>`;
const IMPORT_MAP_HASH = createHash('sha256').update(IMPORT_MAP).digest('base64');

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'sha256-${IMPORT_MAP_HASH}'`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * Build the express app. `deps.fetch` lets tests stub the payment gateways.
 * Returns { app, db, close }.
 */
export async function createApp(config, deps = {}) {
  const db = openDb(config.dataDir);
  const storage = createStorage(config.dataDir);
  const providers = createPaymentProviders(config.payment, deps.fetch || globalThis.fetch);
  const ctx = { db, storage, config, providers };
  ctx.payments = createPaymentService(ctx);

  if (!getSetting(db, 'pricing')) setSetting(db, 'pricing', defaultPricing());
  await ensureAdmin(db, config.admin);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', CSP);
    if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Stripe webhook needs the raw body for signature verification, so it is
  // mounted before the JSON parser and outside the CSRF guard.
  app.post('/api/payments/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const stripe = providers.get('stripe');
    const event = stripe?.parseWebhook(req.body, req.get('stripe-signature'));
    if (!event) return res.status(400).json({ error: 'Invalid signature.' });
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data?.object || {};
      const payment = ctx.payments.byPublicId(session.client_reference_id);
      if (payment && payment.provider === 'stripe' && payment.authority === session.id) {
        await ctx.payments.finalize(payment).catch((err) => console.error('[stripe webhook]', err));
      }
    }
    res.json({ received: true });
  });

  app.use(sessionMiddleware(db));

  app.use('/api', express.json({ limit: '1mb' }), csrfGuard, apiRouter(ctx));
  app.use('/api/admin', adminRouter(ctx));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // static assets
  app.use('/vendor/three', express.static(join(ROOT, 'node_modules', 'three'), { maxAge: '7d', index: false }));
  app.use(express.static(PUBLIC, { index: false, redirect: false, maxAge: '1h' }));

  const render = (req, res, view, vars = {}, status = 200) => {
    res.status(status).type('html').setHeader('Cache-Control', 'no-store');
    res.send(renderView(view, { user: req.user, config, path: req.path, vars, importMapTag: IMPORT_MAP_TAG }));
  };

  for (const [route, view, auth] of PAGES) {
    app.get(route, (req, res) => {
      if (auth && !req.user) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      if (auth === 'admin' && req.user.role !== 'admin') return res.redirect(302, '/portal');
      render(req, res, view, pageVars(route));
    });
  }

  app.get('/use-cases/:slug', (req, res, next) => {
    const uc = USE_CASE_BY_SLUG.get(req.params.slug);
    if (!uc) return next();
    render(req, res, 'site/use-case.html', useCaseVars(uc));
  });

  app.get('/viewer', (_req, res) => res.redirect(301, '/studio'));

  // ── machine-readable SEO surfaces ──
  const publicPaths = () => [
    ...PAGES.filter((p) => p[3] != null).map((p) => [p[0], p[3]]),
    ...USE_CASES.map((u) => [`/use-cases/${u.slug}`, 0.8]),
  ];
  app.get('/robots.txt', (_req, res) => {
    res.type('text').send(`User-agent: *\nAllow: /\nDisallow: /portal\nDisallow: /admin\nDisallow: /api\nDisallow: /pay\n\nSitemap: ${config.baseUrl}/sitemap.xml\n`);
  });
  app.get('/sitemap.xml', (_req, res) => {
    const urls = publicPaths()
      .map(([p, pr]) => `  <url><loc>${esc(config.baseUrl + p)}</loc><priority>${pr.toFixed(1)}</priority></url>`)
      .join('\n');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });
  app.get('/llms.txt', (_req, res) => {
    res.type('text').send(`# ${config.siteName}
> ${config.siteName} is an autonomous topological routing and DFM polishing service for KiCad printed circuit boards. Customers upload a placed .kicad_pcb, pay online in USD, and receive a routed board, a 3D model, fabrication outputs and a DFM/DRC evidence dossier.

## Capabilities
- Lossless S-expression round-trip for KiCad 6, 7, 8 and 9 boards
- Constraint-driven routing: differential pairs, length-matched groups, controlled impedance (IPC-2141A)
- BGA escape routing with through, blind, buried and microvias (IPC-2226)
- DFM polish: acid-trap removal, teardrops, sliver and annular-ring checks against the chosen fab's capability table
- In-browser 3D inspection of .kicad_pcb, .glb, .gltf, .stl, .obj and .wrl files
- Customer files are never used to train models; routing runs on dedicated offline hardware

## Pages
${publicPaths().map(([p]) => `- ${config.baseUrl}${p}`).join('\n')}
`);
  });

  app.use((req, res) => render(req, res, 'site/404.html', {}, 404));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File is larger than the ${config.maxUploadMb} MB limit.`
        : status >= 500
          ? 'Internal server error.'
          : err.message;
    if (req.path.startsWith('/api')) res.status(status).json({ error: message });
    else res.status(status).type('text').send(message);
  });

  return { app, db, close: () => db.close() };
}

/** Per-page template variables. */
function pageVars(route) {
  if (route === '/use-cases' || route === '/') {
    return {
      useCaseCards: USE_CASES.map(
        (u) => `<a class="card card--link uc-card" href="/use-cases/${u.slug}">
          <span class="eyebrow">${esc(u.standard)}</span>
          <h3>${esc(u.name)}</h3>
          <p>${esc(u.intro)}</p>
          <span class="link-arrow">Explore ${esc(u.name.toLowerCase())}</span>
        </a>`,
      ).join(''),
    };
  }
  return {};
}

function useCaseVars(u) {
  const others = USE_CASES.filter((x) => x.slug !== u.slug);
  return {
    __meta: {
      title: `${u.title} | QodeX PCB`,
      description: `${u.headline} ${u.intro}`.slice(0, 300),
    },
    ucName: u.name,
    ucTitle: u.title,
    ucHeadline: u.headline,
    ucIntro: u.intro,
    ucStandard: u.standard,
    ucSlug: u.slug,
    ucChallenges: u.challenges.map(([t, b], i) => `<div class="card feature"><span class="feature__num">0${i + 1}</span><h3>${esc(t)}</h3><p>${esc(b)}</p></div>`).join(''),
    ucApproach: u.approach.map((a) => `<li>${esc(a)}</li>`).join(''),
    ucSpecs: u.specs.map(([k, v]) => `<div class="spec"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join(''),
    ucFaq: u.faq.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join(''),
    ucFaqJson: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: u.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    }).replace(/</g, '\\u003c'),
    ucOthers: others.map((o) => `<a class="chip" href="/use-cases/${o.slug}">${esc(o.name)}</a>`).join(''),
  };
}

async function ensureAdmin(db, admin) {
  if (!admin.email || !admin.password) return;
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(admin.email.toLowerCase());
  if (existing) {
    if (existing.role !== 'admin') db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
    return;
  }
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'admin')").run(
    admin.email.toLowerCase(),
    admin.name,
    await hashPassword(admin.password),
  );
  console.log(`[qodex-pcb] admin account created: ${admin.email}`);
}
