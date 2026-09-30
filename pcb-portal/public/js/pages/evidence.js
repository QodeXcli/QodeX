import { el } from '../app.js';
import { createViewer } from '../viewer/viewer.js';

const viewer = createViewer(document.getElementById('viewer'), {
  board: { maskColor: 'black', finish: 'enig' },
  onLoad(current) {
    if (current?.kind !== 'kicad_pcb') return;
    const { board, boardScene } = current;
    const s = board.stats;
    let total = 0;
    for (const v of boardScene.netStats.values()) total += v.length;
    document.getElementById('summary').replaceChildren(
      ...[
        ['Board', `${s.widthMm} × ${s.heightMm} mm, ${s.copperLayerCount} layers`],
        ['Thickness', `${s.thickness} mm`],
        ['Footprints / pads', `${s.footprints} / ${s.pads}`],
        ['Nets', String(s.nets)],
        ['Vias', String(s.vias)],
        ['Routed copper', `${total.toFixed(1)} mm`],
        ['KiCad format', s.kicadVersion],
      ].flatMap(([k, v]) => [el('dt', {}, k), el('dd', { class: 'mono' }, v)]),
    );
    const segs = new Map();
    for (const t of board.tracks) if (t.net) segs.set(t.net, (segs.get(t.net) || 0) + t.pts.length - 1);
    const rows = [...boardScene.netStats.entries()].sort((a, b) => b[1].length - a[1].length);
    document.querySelector('#nets tbody').replaceChildren(
      ...rows.map(([net, st]) =>
        el('tr', {},
          el('td', {}, el('a', { href: '#viewer', class: 'mono', onclick: (e) => { e.preventDefault(); boardScene.highlightNet(net); document.getElementById('viewer').scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, net)),
          el('td', { class: 'num' }, `${st.length.toFixed(2)} mm`),
          el('td', { class: 'num' }, st.pads),
          el('td', { class: 'num' }, st.vias),
          el('td', { class: 'num' }, segs.get(net) || 0),
        ),
      ),
    );
  },
});
viewer.loadUrl('/samples/demo-board.kicad_pcb', 'demo-board.kicad_pcb').catch(() => {});
