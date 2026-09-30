import { stripeProvider } from './stripe.js';
import { paypalProvider } from './paypal.js';

/**
 * Development-only gateway: sends the customer to an internal test checkout
 * page and never touches real money.
 */
function mockProvider() {
  return {
    name: 'mock',
    label: 'Test checkout (development only)',
    async create({ paymentPublicId }) {
      return { authority: `mock_${paymentPublicId}`, redirectUrl: `/pay/mock/${paymentPublicId}` };
    },
    async verify({ query }) {
      return query?.outcome === 'OK' ? { ok: true, refId: `MOCK-${Date.now().toString(36).toUpperCase()}` } : { ok: false, error: 'Test payment was cancelled.' };
    },
  };
}

/** Returns a Map(name → provider) for every enabled gateway, in configured order. */
export function createPaymentProviders(paymentCfg, fetchImpl = globalThis.fetch) {
  const map = new Map();
  for (const name of paymentCfg.providers) {
    if (name === 'stripe') map.set(name, stripeProvider(paymentCfg.stripe, fetchImpl));
    else if (name === 'paypal') map.set(name, paypalProvider(paymentCfg.paypal, fetchImpl));
    else if (name === 'mock') map.set(name, mockProvider());
  }
  return map;
}
