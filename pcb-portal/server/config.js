import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** All prices are stored and charged in US dollars (integer cents). */
export const CURRENCY = 'USD';

export const PAYMENT_PROVIDERS = ['stripe', 'paypal', 'mock'];

/** Minimal .env loader (KEY=VALUE, # comments, optional quotes). Real env wins. */
export function loadDotEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export function readConfig(env = process.env, overrides = {}) {
  const port = Number(env.PORT || 8787);
  const baseUrl = (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const providers = String(env.PAYMENT_PROVIDERS || env.PAYMENT_PROVIDER || 'mock')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  const cfg = {
    port,
    host: env.HOST || '0.0.0.0',
    baseUrl,
    dataDir: resolve(env.DATA_DIR || join(ROOT, 'data')),
    maxUploadMb: Number(env.MAX_UPLOAD_MB || 200),
    secureCookies: bool(env.SECURE_COOKIES, baseUrl.startsWith('https://')),
    trustProxy: bool(env.TRUST_PROXY, false),
    currency: CURRENCY,
    siteName: env.SITE_NAME || 'QodeX PCB',
    companyName: env.COMPANY_NAME || 'QodeX Systems Lab',
    supportEmail: env.SUPPORT_EMAIL || '',
    admin: { email: env.ADMIN_EMAIL || '', password: env.ADMIN_PASSWORD || '', name: env.ADMIN_NAME || 'QodeX Admin' },
    payment: {
      providers,
      stripe: {
        secretKey: env.STRIPE_SECRET_KEY || '',
        webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
      },
      paypal: {
        clientId: env.PAYPAL_CLIENT_ID || '',
        clientSecret: env.PAYPAL_CLIENT_SECRET || '',
        sandbox: bool(env.PAYPAL_SANDBOX, false),
      },
    },
    ...overrides,
  };

  if (!providers.length) throw new Error('PAYMENT_PROVIDERS must list at least one of: stripe, paypal, mock');
  for (const p of providers) {
    if (!PAYMENT_PROVIDERS.includes(p)) throw new Error(`Unknown payment provider "${p}" (allowed: ${PAYMENT_PROVIDERS.join(', ')})`);
  }
  if (providers.includes('stripe') && !cfg.payment.stripe.secretKey) throw new Error('STRIPE_SECRET_KEY is required when stripe is enabled');
  if (providers.includes('paypal') && (!cfg.payment.paypal.clientId || !cfg.payment.paypal.clientSecret)) {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required when paypal is enabled');
  }
  return cfg;
}
