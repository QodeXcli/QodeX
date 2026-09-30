# QodeX PCB — website, customer portal and 3D Studio

The public website and ordering portal for the QodeX PCB routing service. **Routing does not run on the website** — the QodeX engine runs offline on your own workstation. The site takes care of everything around it:

- **Marketing site** (server-rendered, SEO-ready): home, how it works, 3D Studio, six use-case pages, KiCad integration, pricing estimator, evidence library, docs & DFM academy, trust & security, about, careers, contact, legal. Canonical URLs, Open Graph, JSON-LD, `sitemap.xml`, `robots.txt` and `llms.txt` are generated.
- **Ordering:** customers drop a `.kicad_pcb` (plus any project files). The board is parsed in the browser for an instant 3D preview and quote, and parsed again on the server, whose geometry is authoritative for pricing.
- **Payments in USD:** Stripe Checkout (cards, Apple Pay, Google Pay, Link) and PayPal (Orders v2). Customers choose at checkout. Payments are verified server-to-server, callbacks are idempotent, and a signed Stripe webhook covers customers who close the tab. Printable receipts in the portal.
- **3D Studio / viewer:** `.kicad_pcb` (KiCad 5–9), `.glb`, `.gltf`, `.stl`, `.obj`, `.wrl`. Layer toggles, solder-mask transparency, exploded stack, **inspect** (hover to identify pads/vias/tracks/parts, click to highlight a whole net with its routed length), **measure** (distance, ΔX/ΔY, mils), auto-rotate, screenshot, fullscreen.
- **Customer portal:** dashboard, new order, order detail (status steps, deliverables with 3D view, engineer message thread, activity log), billing & receipts, account settings.
- **Admin panel:** order queue with stats and search, pricing/status/internal notes, deliverable upload (optionally marking the order delivered), customers, contact-form inbox, tariff editor.

## Your workflow

```
Customer uploads board + pays (USD) ─► Admin queue: "Paid — queued"
                                         │
      download customer files ◄──────────┘
      route on your workstation with the QodeX engine
      upload deliverables (.kicad_pcb, .glb, gerber zip, dossier.pdf) + tick "Mark as delivered"
                                         │
Customer: 3D review, download, confirm ◄─┘
```

Generate a GLB from a routed board with KiCad 8/9: `kicad-cli pcb export glb -o board.glb board.kicad_pcb` (the `.kicad_pcb` itself also opens directly in the viewer).

## Setup

Requires Node.js 20+.

```bash
cd pcb-portal
npm install
cp .env.example .env      # then edit it
npm start                 # http://localhost:8787
```

| Variable | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | Public URL of the site; payment providers redirect back here. Use `https://` in production. |
| `SITE_NAME`, `COMPANY_NAME`, `SUPPORT_EMAIL` | Shown in the header, footer, receipts and legal pages. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin account (created on startup). Or later: `npm run create-admin -- email password "Name"`. |
| `PAYMENT_PROVIDERS` | Comma-separated: `stripe`, `paypal`, `mock`. `mock` is a development-only test checkout. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe API key and the signing secret of the webhook endpoint below. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_SANDBOX` | PayPal REST app credentials; `PAYPAL_SANDBOX=true` for testing. |
| `DATA_DIR` | SQLite database and uploaded files. **Back this folder up.** |
| `MAX_UPLOAD_MB`, `TRUST_PROXY` | Upload limit; set `TRUST_PROXY=true` behind nginx / Cloudflare. |

### Stripe

1. Create a restricted or secret key and set `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint `https://<your-domain>/api/payments/stripe/webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Enable Apple Pay / Google Pay in the Stripe dashboard if you want them offered in Checkout.

### PayPal

Create a REST app in the PayPal developer dashboard, set `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`, and test with `PAYPAL_SANDBOX=true` before switching to live credentials.

### Pricing

After signing in as admin, open **Pricing** and set your tariffs (the defaults are starting points). Turn off automatic quotes if you prefer to price every order by hand: orders then wait in "Awaiting quote" until you set a price. Off-site payments (wire transfer, invoice) can be recorded by setting the order status to "Paid".

### Production

- Run behind a TLS reverse proxy (nginx, Caddy, Cloudflare Tunnel). With an `https://` base URL, cookies become `Secure` and HSTS is sent.
- Allow request bodies at least as large as `MAX_UPLOAD_MB` in the proxy.
- `NODE_ENV=production npm start` under pm2 / systemd / launchd.
- Remove `mock` from `PAYMENT_PROVIDERS`.
- Have the legal pages (`views/site/legal.html`) reviewed by counsel for your jurisdiction and company.

## Order statuses

Awaiting quote → Awaiting payment → Paid — queued → In progress → Delivered → Completed (or Cancelled).

## Security

- Files are stored under random names outside any public directory and served only through `/api/files/:id` to the order owner and admins.
- scrypt password hashing; HttpOnly + SameSite session cookies; CSRF guard via a required custom header; rate limits on auth and contact endpoints; strict CSP with no third-party scripts.
- Orders are marked paid only after server-side verification with the provider (amount, currency and reference must match). Repricing an order cancels any open checkout. Internal admin notes are never sent to customers.
- Upload extension allow-list, size cap and SHA-256 per file.

## Layout

```
pcb-portal/
├── server/
│   ├── app.js           routes, page rendering, SEO files, Stripe webhook, CSP
│   ├── layout.js        server-side layout (header, footer, sidebar, meta, JSON-LD)
│   ├── content.js       use-case page content
│   ├── routes/          api.js (auth, orders, files, payments, contact) · admin.js
│   ├── payments/        stripe.js · paypal.js · service.js (verify + finalise) · index.js (mock)
│   └── pricing.js       spec validation and USD quote calculation
├── views/               site/, portal/, admin/ page fragments
├── public/
│   ├── css/app.css      design system
│   ├── js/viewer/       kicad-parser.js (shared with the server) · kicad-scene.js · viewer.js
│   ├── js/pages/        one script per page
│   └── samples/         open demo board (scripts/make-demo-board.js)
└── test/                node --test (npm test)
```

## Tests

```bash
npm test
```

Covers the KiCad parser (KiCad 5 legacy through 9, rotations, THT/NPTH, arcs, nets), pricing, every public page (rendered, no unfilled placeholders), the full order/payment/delivery API including access control, the contact inbox, and PayPal and Stripe flows (including webhook signatures) against stubbed providers.
