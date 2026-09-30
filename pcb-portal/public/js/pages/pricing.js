import { api, dollars, el, getConfig, money } from '../app.js';

const cfg = await getConfig();
const form = document.getElementById('estimator');
const fill = (select, entries, value) => {
  for (const [v, label] of entries) select.append(el('option', { value: v, selected: v === value }, label));
};
fill(document.getElementById('service'), Object.entries(cfg.services), new URLSearchParams(location.search).get('service') || 'routing');
fill(document.getElementById('finish'), Object.entries(cfg.options.finish), 'enig');
fill(document.getElementById('turnaround'), Object.entries(cfg.options.turnaround), 'standard');
const layersOut = document.getElementById('layers-out');

const services = document.getElementById('services');
for (const [key, label] of Object.entries(cfg.services)) {
  const d = cfg.serviceDetails[key];
  services.append(el('div', { class: 'card feature' },
    el('h3', {}, label),
    el('p', {}, d.summary),
    el('ul', { class: 'checklist', style: 'margin-top:14px' }, d.deliverables.map((x) => el('li', {}, x))),
  ));
}

let timer;
async function update() {
  const f = new FormData(form);
  const layers = cfg.options.layers[Number(f.get('layersIdx'))];
  layersOut.textContent = `${layers}`;
  const specs = {
    service: f.get('service'),
    layers,
    widthMm: Number(f.get('widthMm')),
    heightMm: Number(f.get('heightMm')),
    quantity: Number(f.get('quantity')) || 1,
    nets: Number(f.get('nets')) || 0,
    pads: Number(f.get('pads')) || 0,
    finish: f.get('finish'),
    turnaround: f.get('turnaround'),
    impedanceControl: f.get('impedanceControl') === 'on',
  };
  try {
    const { quote } = await api('/quote', { method: 'POST', body: { specs, boardMeta: { hasBGA: f.get('hasBGA') === 'on' } } });
    document.getElementById('price').replaceChildren(money(quote.total), el('small', {}, 'USD'));
    document.getElementById('lines').replaceChildren(...quote.lines.map((l) => el('li', {}, el('span', {}, l.label), el('span', {}, dollars(l.amount)))));
  } catch (err) {
    document.getElementById('price').textContent = '—';
    document.getElementById('lines').replaceChildren(el('li', {}, el('span', {}, err.message)));
  }
}
form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 120); });
update();
