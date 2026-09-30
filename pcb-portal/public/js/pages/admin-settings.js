import { api, el, toast } from '../app.js';

const { pricing, defaults } = await api('/admin/settings/pricing');
const box = document.getElementById('form');
const SERVICE_NAMES = { routing: 'Routing + DFM polish', routing_fab: 'Routing + fabrication', dfm_review: 'DFM / DRC review', fab_only: 'Fabrication only' };
const FIELD_NAMES = { base: 'Base ($)', perLayer: 'Per layer ($)', perCm2: 'Per cm² ($)', perNet: 'Per net ($)', perPad: 'Per pad ($)' };
let state = structuredClone(pricing);

function num(path, label, hint) {
  const get = () => path.reduce((o, k) => o?.[k], state);
  const input = el('input', { type: 'number', step: 'any', min: 0, value: get() ?? 0 });
  input.addEventListener('input', () => {
    let o = state;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path.at(-1)] = input.value === '' ? 0 : Number(input.value);
  });
  return el('label', { class: 'field' }, el('span', { class: 'field__label' }, label), input, hint ? el('span', { class: 'field__hint' }, hint) : null);
}

function render() {
  const auto = el('input', { type: 'checkbox', checked: !!state.autoQuote });
  auto.addEventListener('change', () => { state.autoQuote = auto.checked; });
  const save = el('button', { type: 'button', class: 'btn btn--primary' }, 'Save pricing');
  save.addEventListener('click', async () => {
    try {
      state = (await api('/admin/settings/pricing', { method: 'PUT', body: { pricing: state } })).pricing;
      toast('Pricing saved.');
    } catch (err) {
      toast(err.message, true);
    }
  });
  const reset = el('button', { type: 'button', class: 'btn btn--ghost' }, 'Load defaults');
  reset.addEventListener('click', () => {
    if (!confirm('Load the default tariffs into the form? Nothing changes until you save.')) return;
    state = structuredClone(defaults);
    render();
  });
  box.replaceChildren(
    el('label', { class: 'check' }, auto, el('span', {}, 'Automatic quotes — customers can pay immediately after placing an order')),
    el('div', { class: 'grid grid--2' }, num(['minimum'], 'Minimum order ($)'), num(['roundTo'], 'Round up to ($)', 'e.g. 1 for whole dollars, 5 for $5 steps')),
    ...Object.keys(SERVICE_NAMES).flatMap((key) => [
      el('h3', { style: 'margin-top:14px' }, SERVICE_NAMES[key]),
      el('div', { class: 'grid grid--3' }, Object.entries(FIELD_NAMES).map(([f, l]) => num(['services', key, f], l))),
    ]),
    el('h3', { style: 'margin-top:14px' }, 'Fabrication'),
    el('div', { class: 'grid grid--3' },
      num(['fab', 'setup'], 'Setup ($)'),
      num(['fab', 'perCm2'], 'Per cm² per board ($)', 'Multiplied by the layer factor'),
      num(['fab', 'colorExtra'], 'Non-green mask surcharge', 'Fraction, 0.05 = 5 %')),
    el('h4', {}, 'Layer factor'),
    el('div', { class: 'grid grid--4' }, Object.keys(state.fab.layerFactor).map((l) => num(['fab', 'layerFactor', l], `${l} layer${l === '1' ? '' : 's'}`))),
    el('h4', {}, 'Copper weight factor'),
    el('div', { class: 'grid grid--3' }, Object.keys(state.fab.copperOzFactor).map((l) => num(['fab', 'copperOzFactor', l], `${l} oz`))),
    el('h4', {}, 'Surface finish surcharge (fraction)'),
    el('div', { class: 'grid grid--3' }, Object.keys(state.fab.finishExtra).map((l) => num(['fab', 'finishExtra', l], l.toUpperCase().replace('_', ' ')))),
    el('h3', { style: 'margin-top:14px' }, 'Multipliers'),
    el('div', { class: 'grid grid--3' },
      num(['multipliers', 'express'], 'Express turnaround', 'e.g. 1.5'),
      num(['multipliers', 'impedanceControl'], 'Controlled impedance', 'e.g. 1.2'),
      num(['multipliers', 'bga'], 'Board with BGA', 'e.g. 1.25')),
    el('div', { class: 'row', style: 'margin-top:14px' }, save, reset),
  );
}
render();
