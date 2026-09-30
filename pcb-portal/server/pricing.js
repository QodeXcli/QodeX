// Order specification validation + quote calculation.
//
// Tariff numbers live in the `pricing` settings row (editable from the admin
// panel) and are expressed in US dollars. Final prices are stored as integer
// cents.

export const SERVICES = {
  routing: 'Routing + DFM polish',
  routing_fab: 'Routing + fabrication',
  dfm_review: 'DFM / DRC review',
  fab_only: 'Fabrication only',
};

export const SERVICE_DETAILS = {
  routing: {
    summary: 'Full topological routing of your placed KiCad board: BGA fan-out, length and impedance matching, return-path aware planes and a DFM polish pass.',
    deliverables: ['Routed .kicad_pcb (lossless round-trip)', 'GLB 3D model', 'Gerber + drill package', 'DFM / DRC evidence dossier (PDF)'],
  },
  routing_fab: {
    summary: 'Everything in Routing, then we release the board to the fabricator of your choice and ship the bare PCBs.',
    deliverables: ['Everything in Routing', 'Fab-house CAM check', 'Bare boards shipped worldwide'],
  },
  dfm_review: {
    summary: 'Your board is already routed. We run a full DRC/DFM inspection against your fab house capability table and return an annotated report.',
    deliverables: ['Annotated DFM / DRC report', 'Acid-trap, sliver and annular-ring findings', 'Fix list ordered by severity'],
  },
  fab_only: {
    summary: 'Production-ready files in, bare boards out. We sanity-check the package before it goes to the fab.',
    deliverables: ['CAM sanity check', 'Bare boards shipped worldwide'],
  },
};

export const OPTIONS = {
  layers: [1, 2, 4, 6, 8, 10, 12, 14, 16],
  thickness: [0.4, 0.6, 0.8, 1.0, 1.2, 1.6, 2.0, 2.4],
  copperOz: [1, 2, 3],
  finish: { hasl: 'HASL', lf_hasl: 'Lead-free HASL', enig: 'ENIG', osp: 'OSP', immersion_silver: 'Immersion silver', hard_gold: 'Hard gold' },
  maskColor: { green: 'Green', black: 'Black', matte_black: 'Matte black', matte_green: 'Matte green', blue: 'Blue', red: 'Red', white: 'White', yellow: 'Yellow', purple: 'Purple' },
  silkColor: { white: 'White', black: 'Black' },
  turnaround: { standard: 'Standard', express: 'Express' },
  fabHouse: { any: 'QodeX selects', jlcpcb: 'JLCPCB', pcbway: 'PCBWay', eurocircuits: 'Eurocircuits', sierra: 'Sierra Circuits', other: 'Other (specify in notes)' },
};

export function defaultPricing() {
  // Starting tariffs — tune them in /admin/settings.
  return {
    autoQuote: true,
    roundTo: 1,
    minimum: 49,
    services: {
      routing: { base: 120, perLayer: 40, perCm2: 0.6, perNet: 0.15, perPad: 0.02, includesFab: false },
      routing_fab: { base: 120, perLayer: 40, perCm2: 0.6, perNet: 0.15, perPad: 0.02, includesFab: true },
      dfm_review: { base: 60, perLayer: 10, perCm2: 0.1, perNet: 0, perPad: 0, includesFab: false },
      fab_only: { base: 0, perLayer: 0, perCm2: 0, perNet: 0, perPad: 0, includesFab: true },
    },
    fab: {
      setup: 25,
      perCm2: 0.03,
      layerFactor: { 1: 0.8, 2: 1, 4: 2.2, 6: 3.4, 8: 4.8, 10: 6.2, 12: 7.6, 14: 9, 16: 10.5 },
      copperOzFactor: { 1: 1, 2: 1.35, 3: 1.7 },
      finishExtra: { hasl: 0, lf_hasl: 0.05, enig: 0.25, osp: 0, immersion_silver: 0.15, hard_gold: 0.6 },
      colorExtra: 0.05,
    },
    multipliers: { express: 1.5, impedanceControl: 1.2, bga: 1.25 },
  };
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/** Normalise and validate raw order specs from the client. */
export function normalizeSpecs(raw = {}, boardMeta = null) {
  const service = pick(raw.service, Object.keys(SERVICES), null);
  if (!service) throw new ValidationError('Choose a service.');
  if (boardMeta) {
    // Geometry parsed server-side from the uploaded board is authoritative: the
    // client may not shrink the board, drop layers or under-report nets/pads.
    raw = {
      ...raw,
      layers: Math.max(Number(raw.layers) || 0, boardMeta.copperLayerCount || 0),
      widthMm: boardMeta.widthMm,
      heightMm: boardMeta.heightMm,
      nets: boardMeta.nets,
      pads: boardMeta.pads,
    };
  }
  let layers = Number(raw.layers || 2);
  if (!OPTIONS.layers.includes(layers)) {
    // round odd layer counts up to the next manufacturable stack
    layers = OPTIONS.layers.find((l) => l >= layers) ?? NaN;
  }
  if (!Number.isFinite(layers)) throw new ValidationError('Layer count must be between 1 and 16.');
  const widthMm = Number(raw.widthMm);
  const heightMm = Number(raw.heightMm);
  if (!(widthMm >= 3 && widthMm <= 1000) || !(heightMm >= 3 && heightMm <= 1000)) {
    throw new ValidationError('Board dimensions must be between 3 and 1000 mm.');
  }
  const quantity = Math.round(Number(raw.quantity ?? 5));
  if (!(quantity >= 1 && quantity <= 100000)) throw new ValidationError('Quantity must be between 1 and 100,000.');
  const thickness = Number(raw.thickness ?? 1.6);
  if (!OPTIONS.thickness.includes(thickness)) throw new ValidationError('Invalid board thickness.');
  const copperOz = Number(raw.copperOz ?? 1);
  if (!OPTIONS.copperOz.includes(copperOz)) throw new ValidationError('Invalid copper weight.');
  return {
    service,
    layers,
    widthMm: +widthMm.toFixed(2),
    heightMm: +heightMm.toFixed(2),
    quantity,
    thickness,
    copperOz,
    finish: pick(raw.finish, Object.keys(OPTIONS.finish), 'enig'),
    maskColor: pick(raw.maskColor, Object.keys(OPTIONS.maskColor), 'green'),
    silkColor: pick(raw.silkColor, Object.keys(OPTIONS.silkColor), 'white'),
    turnaround: pick(raw.turnaround, Object.keys(OPTIONS.turnaround), 'standard'),
    fabHouse: pick(raw.fabHouse, Object.keys(OPTIONS.fabHouse), 'any'),
    impedanceControl: raw.impedanceControl === true || raw.impedanceControl === 'true' || raw.impedanceControl === 'on',
    nets: clampInt(raw.nets, 0, 1e6),
    pads: clampInt(raw.pads, 0, 1e7),
  };
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
}

const roundUp = (v, step) => (step > 0 ? Math.ceil(v / step - 1e-9) * step : v);

/**
 * Compute a quote. Returns { total (cents), currency, lines[], autoQuote }.
 * `lines` amounts are in dollars for display.
 */
export function computeQuote(specs, pricing, boardMeta = null) {
  const svc = pricing.services[specs.service];
  if (!svc) throw new ValidationError('Unknown service.');
  const areaCm2 = (specs.widthMm * specs.heightMm) / 100;
  const lines = [];
  let design = 0;
  const parts = [
    ['Service base', svc.base],
    [`${specs.layers} copper layers`, svc.perLayer * specs.layers],
    [`Board area ${areaCm2.toFixed(1)} cm²`, svc.perCm2 * areaCm2],
    [`${specs.nets} nets`, svc.perNet * specs.nets],
    [`${specs.pads} pads`, svc.perPad * specs.pads],
  ];
  for (const [label, amount] of parts) {
    if (amount > 0) {
      lines.push({ label, amount });
      design += amount;
    }
  }
  if (design > 0 && specs.impedanceControl) {
    const extra = design * (pricing.multipliers.impedanceControl - 1);
    lines.push({ label: 'Controlled impedance', amount: extra });
    design += extra;
  }
  if (design > 0 && boardMeta?.hasBGA) {
    const extra = design * (pricing.multipliers.bga - 1);
    lines.push({ label: 'BGA escape routing', amount: extra });
    design += extra;
  }
  let fab = 0;
  if (svc.includesFab) {
    const f = pricing.fab;
    const lf = f.layerFactor[specs.layers] ?? specs.layers * 0.7;
    const boards = f.perCm2 * areaCm2 * specs.quantity * lf;
    const cu = f.copperOzFactor[specs.copperOz] ?? 1;
    const extras = (f.finishExtra[specs.finish] ?? 0) + (specs.maskColor === 'green' ? 0 : f.colorExtra);
    fab = (f.setup + boards) * cu * (1 + extras);
    lines.push({ label: `Fabrication, ${specs.quantity} pcs`, amount: fab });
  }
  let subtotal = design + fab;
  if (specs.turnaround === 'express') {
    const extra = subtotal * (pricing.multipliers.express - 1);
    lines.push({ label: 'Express turnaround', amount: extra });
    subtotal += extra;
  }
  const rounded = roundUp(subtotal, pricing.roundTo);
  const dollars = Math.max(pricing.minimum, rounded);
  if (dollars > rounded) lines.push({ label: 'Minimum order top-up', amount: dollars - subtotal });
  return {
    total: Math.round(dollars * 100),
    currency: 'USD',
    lines: lines.map((l) => ({ label: l.label, amount: Math.round(l.amount * 100) / 100 })),
    autoQuote: !!pricing.autoQuote,
  };
}

/** Validate an admin-edited pricing sheet (shape + non-negative numbers). */
export function validatePricing(p) {
  const base = defaultPricing();
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!p || typeof p !== 'object') throw new ValidationError('Invalid pricing sheet.');
  if (!isNum(p.minimum) || !isNum(p.roundTo)) throw new ValidationError('minimum and roundTo must be non-negative numbers.');
  for (const key of Object.keys(base.services)) {
    const s = p.services?.[key];
    if (!s) throw new ValidationError(`Service "${key}" is missing from the pricing sheet.`);
    for (const k of ['base', 'perLayer', 'perCm2', 'perNet', 'perPad']) if (!isNum(s[k])) throw new ValidationError(`services.${key}.${k} must be a non-negative number.`);
    s.includesFab = !!s.includesFab;
  }
  if (!p.fab || !isNum(p.fab.setup) || !isNum(p.fab.perCm2) || !isNum(p.fab.colorExtra)) throw new ValidationError('The fab section is invalid.');
  for (const k of ['layerFactor', 'copperOzFactor', 'finishExtra']) {
    if (!p.fab[k] || typeof p.fab[k] !== 'object' || !Object.values(p.fab[k]).every(isNum)) throw new ValidationError(`fab.${k} is invalid.`);
  }
  for (const k of ['express', 'impedanceControl', 'bga']) if (!isNum(p.multipliers?.[k])) throw new ValidationError(`multipliers.${k} must be a number.`);
  p.autoQuote = !!p.autoQuote;
  return p;
}
