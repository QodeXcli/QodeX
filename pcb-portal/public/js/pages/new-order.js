import { api, dollars, el, extBadge, fmtSize, getConfig, money, qs, uploadForm } from '../app.js';

const cfg = await getConfig();
const form = document.getElementById('order-form');
const $ = (id) => document.getElementById(id);
const FAB_SERVICES = new Set(['routing_fab', 'fab_only']);
$('max-mb').textContent = cfg.maxUploadMb;

// ── selects ──
const fill = (select, entries, value) => {
  select.replaceChildren(...entries.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value) }, label)));
};
fill($('service'), Object.entries(cfg.services), qs('service') || 'routing');
fill($('layers'), cfg.options.layers.map((l) => [l, `${l} layer${l === 1 ? '' : 's'}`]), 2);
fill($('thickness'), cfg.options.thickness.map((t) => [t, `${t.toFixed(1)} mm`]), 1.6);
fill($('copperOz'), cfg.options.copperOz.map((c) => [c, `${c} oz`]), 1);
fill($('finish'), Object.entries(cfg.options.finish), 'enig');
fill($('maskColor'), Object.entries(cfg.options.maskColor), 'green');
fill($('silkColor'), Object.entries(cfg.options.silkColor), 'white');
fill($('turnaround'), Object.entries(cfg.options.turnaround), 'standard');
fill($('fabHouse'), Object.entries(cfg.options.fabHouse), 'any');

// ── files ──
let files = [];
let analyzed = null;
let boardMeta = null;
let boardBuffer = null;
let viewer = null;

const drop = $('drop');
const input = $('files');
drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.click()));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-drag'); addFiles(e.dataTransfer.files); });
input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'u' && !e.ctrlKey && !e.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) input.click();
});

function addFiles(list) {
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  for (const f of list) {
    if (f.size > maxBytes) { showError(`"${f.name}" is larger than ${cfg.maxUploadMb} MB.`); continue; }
    if (!files.some((x) => x.name === f.name && x.size === f.size)) files.push(f);
  }
  renderFiles();
  const pcb = files.find((f) => f.name.toLowerCase().endsWith('.kicad_pcb'));
  if (pcb && pcb !== analyzed) analyze(pcb);
}

function renderFiles() {
  $('file-list').replaceChildren(...files.map((f) => el('li', {},
    extBadge(f.name),
    el('span', { class: 'name' }, f.name),
    el('span', { class: 'low mono' }, fmtSize(f.size)),
    el('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'aria-label': `Remove ${f.name}`, onclick: () => removeFile(f) }, 'Remove'))));
}

function removeFile(f) {
  files = files.filter((x) => x !== f);
  if (f === analyzed) {
    analyzed = null;
    boardMeta = null;
    boardBuffer = null;
    $('meta-card').hidden = true;
    $('preview-card').hidden = true;
    viewer?.dispose();
    viewer = null;
  }
  renderFiles();
  requestQuote();
}

async function analyze(file) {
  analyzed = file;
  $('parse-error').hidden = true;
  try {
    const { parseKiCadPcb } = await import('../viewer/kicad-parser.js');
    boardBuffer = await file.arrayBuffer();
    const board = parseKiCadPcb(new TextDecoder().decode(boardBuffer));
    boardMeta = board.stats;
    const s = board.stats;
    $('layers').value = String(cfg.options.layers.find((l) => l >= s.copperLayerCount) ?? 16);
    form.widthMm.value = s.widthMm;
    form.heightMm.value = s.heightMm;
    const nearest = cfg.options.thickness.reduce((a, b) => (Math.abs(b - s.thickness) < Math.abs(a - s.thickness) ? b : a));
    $('thickness').value = String(nearest);
    if (!form.title.value) form.title.value = file.name.replace(/\.kicad_pcb$/i, '');
    $('meta').replaceChildren(...[
      ['KiCad format', s.kicadVersion], ['Copper layers', s.copperLayerCount], ['Size', `${s.widthMm} × ${s.heightMm} mm`],
      ['Area', `${s.areaCm2} cm²`], ['Footprints', s.footprints], ['Pads', s.pads], ['Nets', s.nets],
      ['Existing tracks', s.tracks], ['Vias', s.vias], ['BGA packages', s.hasBGA ? 'Yes' : 'No'],
    ].flatMap(([k, v]) => [el('dt', {}, k), el('dd', { class: 'mono' }, String(v))]));
    $('meta-card').hidden = false;
    $('preview-card').hidden = false;
    await renderPreview();
    requestQuote();
  } catch (err) {
    boardMeta = null;
    $('parse-error').textContent = `We couldn't analyse ${file.name} in the browser (${err.message}). You can still place the order — an engineer will review the file.`;
    $('parse-error').hidden = false;
  }
}

async function renderPreview() {
  if (!boardBuffer) return;
  const { createViewer } = await import('../viewer/viewer.js');
  viewer ??= createViewer($('preview'));
  await viewer.loadBuffer(boardBuffer.slice(0), 'board.kicad_pcb', { maskColor: form.maskColor.value, finish: form.finish.value, silkColor: form.silkColor.value });
}
for (const id of ['maskColor', 'finish', 'silkColor']) $(id).addEventListener('change', () => renderPreview().catch(() => {}));

// ── specs + live quote ──
function specs() {
  const f = new FormData(form);
  return {
    service: f.get('service'),
    layers: Number(f.get('layers')),
    widthMm: Number(f.get('widthMm')),
    heightMm: Number(f.get('heightMm')),
    quantity: Number(f.get('quantity') || 1),
    thickness: Number(f.get('thickness')),
    copperOz: Number(f.get('copperOz')),
    finish: f.get('finish'),
    maskColor: f.get('maskColor'),
    silkColor: f.get('silkColor'),
    turnaround: f.get('turnaround'),
    fabHouse: f.get('fabHouse'),
    impedanceControl: f.get('impedanceControl') === 'on',
    nets: boardMeta?.nets ?? 0,
    pads: boardMeta?.pads ?? 0,
  };
}

function syncService() {
  $('fab-fields').hidden = !FAB_SERVICES.has(form.service.value);
  $('service-hint').textContent = cfg.serviceDetails[form.service.value]?.summary || '';
}

let quoteTimer;
function requestQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    const s = specs();
    if (!(s.widthMm > 0 && s.heightMm > 0)) {
      $('price').textContent = '—';
      $('price-lines').replaceChildren();
      $('quote-note').textContent = 'Drop your .kicad_pcb (or enter the board size) to see a price.';
      return;
    }
    try {
      const { quote } = await api('/quote', { method: 'POST', body: { specs: s, boardMeta: boardMeta ? { hasBGA: boardMeta.hasBGA } : null } });
      $('price').replaceChildren(money(quote.total), el('small', {}, 'USD'));
      $('price-lines').replaceChildren(...quote.lines.map((l) => el('li', {}, el('span', {}, l.label), el('span', {}, dollars(l.amount)))));
      $('quote-note').textContent = quote.autoQuote
        ? boardMeta ? 'Computed from your board file. This is the price you will pay.' : 'Upload the .kicad_pcb for an exact price based on nets and pads.'
        : 'Preliminary estimate — an engineer confirms the final price before payment.';
      $('submit').textContent = quote.autoQuote ? 'Place order & continue to payment' : 'Place order & request quote';
    } catch (err) {
      $('price').textContent = '—';
      $('quote-note').textContent = err.message;
    }
  }, 200);
}
form.addEventListener('input', requestQuote);
form.addEventListener('change', () => { syncService(); requestQuote(); });
syncService();
requestQuote();

// ── submit ──
function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  if (!files.length) return showError('Add at least one project file — ideally the .kicad_pcb.');
  if (form.title.value.trim().length < 2) return showError('Give the project a title.');
  const fd = new FormData();
  fd.append('title', form.title.value.trim());
  fd.append('notes', form.notes.value);
  fd.append('specs', JSON.stringify(specs()));
  for (const f of files) fd.append('files', f, f.name);
  const btn = $('submit');
  btn.disabled = true;
  const prog = $('progress');
  prog.hidden = false;
  try {
    const res = await uploadForm('/orders', fd, (p) => { prog.textContent = `Uploading… ${Math.round(p * 100)}%`; });
    prog.textContent = 'Order placed. Redirecting…';
    location.href = `/portal/orders/${res.order.code}${res.order.status === 'awaiting_payment' ? '?pay=1' : ''}`;
  } catch (err) {
    showError(err.message);
    prog.hidden = true;
    btn.disabled = false;
  }
});
