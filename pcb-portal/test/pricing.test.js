import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuote, defaultPricing, normalizeSpecs, validatePricing } from '../server/pricing.js';

const base = { service: 'routing', layers: 4, widthMm: 50, heightMm: 40, nets: 100, pads: 400 };

test('normalizeSpecs fills defaults and rounds odd layer counts up', () => {
  const s = normalizeSpecs({ ...base, layers: 3 });
  assert.equal(s.layers, 4);
  assert.equal(s.quantity, 5);
  assert.equal(s.finish, 'enig');
  assert.equal(s.impedanceControl, false);
});

test('normalizeSpecs rejects bad input', () => {
  assert.throws(() => normalizeSpecs({ ...base, service: 'nope' }), /service/i);
  assert.throws(() => normalizeSpecs({ ...base, widthMm: 1 }), /dimensions/);
  assert.throws(() => normalizeSpecs({ ...base, layers: 40 }), /Layer count/);
});

test('server-parsed board metadata overrides client-supplied geometry', () => {
  const meta = { copperLayerCount: 6, widthMm: 100, heightMm: 80, nets: 300, pads: 1200 };
  const s = normalizeSpecs({ service: 'routing', layers: 2, widthMm: 5, heightMm: 5, nets: 0, pads: 0 }, meta);
  assert.deepEqual([s.layers, s.widthMm, s.heightMm, s.nets, s.pads], [6, 100, 80, 300, 1200]);
  assert.equal(normalizeSpecs({ service: 'routing', layers: 8 }, meta).layers, 8, 'customer may ask for more layers');
});

test('routing quote in integer US cents', () => {
  const q = computeQuote(normalizeSpecs(base), defaultPricing());
  // 120 + 4*40 + 20cm²*0.6 + 100*0.15 + 400*0.02 = 120+160+12+15+8 = 315
  assert.equal(q.total, 31500);
  assert.equal(q.currency, 'USD');
});

test('multipliers: impedance, BGA and express stack', () => {
  const p = defaultPricing();
  const plain = computeQuote(normalizeSpecs(base), p).total;
  const hard = computeQuote(normalizeSpecs({ ...base, impedanceControl: true, turnaround: 'express' }), p, { hasBGA: true }).total;
  assert.equal(hard, Math.ceil((plain / 100) * 1.2 * 1.25 * 1.5) * 100);
});

test('fabrication is included only for fab services and scales with quantity', () => {
  const p = defaultPricing();
  const r = computeQuote(normalizeSpecs(base), p).total;
  const rf5 = computeQuote(normalizeSpecs({ ...base, service: 'routing_fab', quantity: 5 }), p).total;
  const rf50 = computeQuote(normalizeSpecs({ ...base, service: 'routing_fab', quantity: 50 }), p).total;
  assert.ok(rf5 > r && rf50 > rf5);
});

test('minimum order amount applies', () => {
  const p = defaultPricing();
  p.minimum = 200;
  const q = computeQuote(normalizeSpecs({ service: 'dfm_review', layers: 1, widthMm: 5, heightMm: 5 }), p);
  assert.equal(q.total, 20000);
  assert.ok(q.lines.some((l) => /Minimum/.test(l.label)));
});

test('validatePricing accepts defaults and rejects negatives', () => {
  assert.ok(validatePricing(defaultPricing()));
  const bad = defaultPricing();
  bad.services.routing.base = -1;
  assert.throws(() => validatePricing(bad));
});
