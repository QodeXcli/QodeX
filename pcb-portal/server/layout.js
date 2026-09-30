// Server-side page layout. Pages live in /views as HTML fragments that start
// with a metadata comment:
//
//   <!--meta {"title": "...", "description": "...", "script": "home", "shell": "site"} -->
//
// `shell` is "site" (marketing chrome), "app" (portal/admin sidebar) or "bare".
// Fragments may use {{name}} (HTML-escaped) and {{{name}}} (raw) placeholders.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { USE_CASES } from './content.js';

const VIEWS = join(ROOT, 'views');

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const cache = new Map();
function loadView(file) {
  if (cache.has(file) && process.env.NODE_ENV === 'production') return cache.get(file);
  const text = readFileSync(join(VIEWS, file), 'utf8');
  const m = /^<!--meta\s+([\s\S]*?)-->\s*/.exec(text);
  const view = { meta: m ? JSON.parse(m[1]) : {}, body: m ? text.slice(m[0].length) : text };
  cache.set(file, view);
  return view;
}

function fill(template, vars) {
  return template
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, k) => (vars[k] ?? '').toString())
    .replace(/\{\{(\w+)\}\}/g, (_, k) => esc(vars[k]));
}

const ICON = {
  logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="qxg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb076"/><stop offset=".6" stop-color="#df8244"/><stop offset="1" stop-color="#5e3519"/></linearGradient></defs><rect width="32" height="32" rx="7" fill="url(#qxg)"/><path d="M8 11h9a4 4 0 0 1 0 8h-3m0 0 3 3m-3-3 3-3M8 16h3M8 21h3" stroke="#140a03" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

function siteHeader(user, active) {
  const a = (href, label, key) => `<a href="${href}"${key === active ? ' class="is-active" aria-current="page"' : ''}>${esc(label)}</a>`;
  const useCases = USE_CASES.map((u) => `<a href="/use-cases/${u.slug}"><strong>${esc(u.name)}</strong><span>${esc(u.menu)}</span></a>`).join('');
  const account = user
    ? `<a href="/portal" class="btn btn--ghost btn--sm">Portal</a>${user.role === 'admin' ? '<a href="/admin" class="btn btn--ghost btn--sm">Admin</a>' : ''}<button type="button" class="btn btn--sm" data-logout>Sign out</button>`
    : `<a href="/login" class="nav-signin">Sign in</a><a href="/portal/new" class="btn btn--primary btn--sm">Start an order</a>`;
  return `
<header class="site-header">
  <div class="container site-header__row">
    <a href="/" class="brand" aria-label="QodeX PCB home">${ICON.logo}<span>QodeX<em>PCB</em></span></a>
    <button type="button" class="nav-toggle" aria-label="Open menu" aria-expanded="false" data-nav-toggle>${ICON.menu}</button>
    <nav class="nav" aria-label="Primary" data-nav>
      <div class="nav__group">
        <button type="button" class="nav__trigger${['how', 'studio', 'integrations', 'evidence'].includes(active) ? ' is-active' : ''}">Product</button>
        <div class="nav__menu">
          <a href="/how-it-works"><strong>How it works</strong><span>The four-stage routing pipeline</span></a>
          <a href="/studio"><strong>Studio</strong><span>Inspect any board in 3D, in your browser</span></a>
          <a href="/integrations"><strong>KiCad integration</strong><span>Lossless round-trip, Git-friendly</span></a>
          <a href="/evidence-library"><strong>Evidence library</strong><span>What a delivery dossier contains</span></a>
        </div>
      </div>
      <div class="nav__group">
        <button type="button" class="nav__trigger${active === 'use-cases' ? ' is-active' : ''}">Use cases</button>
        <div class="nav__menu nav__menu--wide">${useCases}</div>
      </div>
      ${a('/pricing', 'Pricing', 'pricing')}
      ${a('/docs', 'Docs', 'docs')}
      ${a('/trust-security', 'Trust', 'trust')}
      <div class="nav__account">${account}</div>
    </nav>
  </div>
</header>`;
}

function siteFooter(config) {
  const year = new Date().getFullYear();
  const col = (title, links) => `<div><h4>${esc(title)}</h4>${links.map(([h, l]) => `<a href="${h}">${esc(l)}</a>`).join('')}</div>`;
  return `
<footer class="site-footer">
  <div class="container site-footer__grid">
    <div class="site-footer__brand">
      <a href="/" class="brand">${ICON.logo}<span>QodeX<em>PCB</em></span></a>
      <p>Autonomous topological routing, impedance matching and DFM polishing for KiCad boards. Intent in. Evidence out.</p>
    </div>
    ${col('Product', [['/how-it-works', 'How it works'], ['/studio', '3D Studio'], ['/integrations', 'KiCad integration'], ['/pricing', 'Pricing & estimator'], ['/evidence-library', 'Evidence library']])}
    ${col('Use cases', USE_CASES.map((u) => [`/use-cases/${u.slug}`, u.name]))}
    ${col('Company', [['/about', 'About'], ['/careers', 'Careers'], ['/contact', 'Contact'], ['/docs', 'Docs & DFM academy'], ['/trust-security', 'Trust & security']])}
    ${col('Legal', [['/legal#terms', 'Terms of service'], ['/legal#privacy', 'Privacy policy'], ['/legal#ip', 'IP & confidentiality'], ['/legal#dpa', 'Data processing'], ['/legal#export', 'Export compliance']])}
  </div>
  <div class="container site-footer__base">
    <span>© ${year} ${esc(config.companyName)}. All rights reserved.</span>
    <span class="mono">All prices in USD</span>
    ${config.supportEmail ? `<a href="mailto:${esc(config.supportEmail)}">${esc(config.supportEmail)}</a>` : ''}
  </div>
</footer>`;
}

function appSidebar(user, active) {
  const link = (href, label, key, icon) =>
    `<a href="${href}"${key === active ? ' class="is-active" aria-current="page"' : ''}><span class="side__icon" aria-hidden="true">${icon}</span>${esc(label)}</a>`;
  const admin =
    user?.role === 'admin'
      ? `<div class="side__label">Operations</div>
         ${link('/admin', 'Order queue', 'admin', '▤')}
         ${link('/admin/customers', 'Customers', 'admin-customers', '◎')}
         ${link('/admin/inquiries', 'Inquiries', 'admin-inquiries', '✉')}
         ${link('/admin/settings', 'Pricing', 'admin-settings', '$')}`
      : '';
  return `
<aside class="side" aria-label="Workspace">
  <div class="side__label">Workspace</div>
  ${link('/portal', 'Dashboard', 'portal', '◧')}
  ${link('/portal/new', 'New order', 'new', '+')}
  ${link('/portal/billing', 'Billing & receipts', 'billing', '¤')}
  ${link('/portal/settings', 'Account settings', 'settings', '⚙')}
  ${link('/studio', '3D Studio', 'studio', '◇')}
  ${admin}
  <div class="side__foot">
    <div class="side__user"><strong>${esc(user?.name || '')}</strong><span>${esc(user?.email || '')}</span></div>
  </div>
</aside>`;
}

/**
 * Render a view into a full HTML document.
 * opts: { user, config, path, vars, importMapTag, status }
 */
export function renderView(file, { user, config, path, vars = {}, importMapTag }) {
  const view = loadView(file);
  const meta = { ...view.meta, ...(vars.__meta || {}) };
  const title = meta.title ? fill(meta.title, vars) : config.siteName;
  const description = meta.description ? fill(meta.description, vars) : '';
  const canonical = `${config.baseUrl}${path}`;
  const body = fill(view.body, { ...vars, siteName: config.siteName, supportEmail: config.supportEmail || 'hello@example.com' });
  const shell = meta.shell || 'site';
  const robots = meta.robots || (shell === 'site' ? 'index,follow' : 'noindex,nofollow');
  const jsonLd = meta.jsonLd ? `<script type="application/ld+json">${JSON.stringify(fillDeep(meta.jsonLd, { ...vars, baseUrl: config.baseUrl, siteName: config.siteName, companyName: config.companyName })).replace(/</g, '\\u003c')}</script>` : '';
  const script = meta.script ? `<script type="module" src="/js/pages/${meta.script}.js"></script>` : '';
  const userJson = JSON.stringify(user ? { name: user.name, email: user.email, role: user.role } : null).replace(/</g, '\\u003c');

  let content;
  if (shell === 'app') {
    content = `${siteHeader(user, meta.nav)}<div class="app"><div class="app__side">${appSidebar(user, meta.nav)}</div><main class="app__main" id="main">${body}</main></div>`;
  } else if (shell === 'bare') {
    content = `${siteHeader(user, meta.nav)}<main id="main" class="bare">${body}</main>`;
  } else {
    content = `${siteHeader(user, meta.nav)}<main id="main">${body}</main>${siteFooter(config)}`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}" />` : ''}
<meta name="robots" content="${robots}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${esc(config.siteName)}" />
<meta property="og:title" content="${esc(title)}" />
${description ? `<meta property="og:description" content="${esc(description)}" />` : ''}
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${esc(config.baseUrl)}/og-image.svg" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="theme-color" content="#08090a" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600&display=swap" />
<link rel="stylesheet" href="/css/app.css" />
${importMapTag}
<script type="application/json" id="qx-user">${userJson}</script>
${jsonLd}
<script type="module" src="/js/chrome.js"></script>
${script}
</head>
<body class="shell-${shell}">
<a class="skip" href="#main">Skip to content</a>
${content}
</body>
</html>`;
}

function fillDeep(v, vars) {
  if (typeof v === 'string') return v.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, vars)]));
  return v;
}
