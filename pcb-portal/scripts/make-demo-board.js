#!/usr/bin/env node
// Generates public/samples/demo-board.kicad_pcb — a small 4-layer KiCad 8 board
// (MCU + passives + header + mounting holes + GND pour) used by the landing-page
// 3D demo and by the test-suite. Deterministic output; re-run after edits.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const W = 64, H = 42, OX = 100, OY = 80, R = 3; // board size / origin / corner radius
const f = (v) => +v.toFixed(4);
const out = [];
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
})();

out.push(`(kicad_pcb
  (version 20240108)
  (generator "qodex_demo")
  (generator_version "8.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (1 "In1.Cu" power)
    (2 "In2.Cu" signal)
    (31 "B.Cu" signal)
    (36 "B.SilkS" user "B.Silkscreen")
    (37 "F.SilkS" user "F.Silkscreen")
    (38 "B.Mask" user)
    (39 "F.Mask" user)
    (44 "Edge.Cuts" user)
    (46 "B.CrtYd" user "B.Courtyard")
    (47 "F.CrtYd" user "F.Courtyard")
    (48 "B.Fab" user)
    (49 "F.Fab" user)
  )
  (setup
    (stackup
      (layer "F.SilkS" (type "Top Silk Screen"))
      (layer "F.Mask" (type "Top Solder Mask") (color "Green") (thickness 0.01))
      (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 1" (type "prepreg") (thickness 0.2104) (material "FR4") (epsilon_r 4.4))
      (layer "In1.Cu" (type "copper") (thickness 0.0152))
      (layer "dielectric 2" (type "core") (thickness 1.065) (material "FR4") (epsilon_r 4.6))
      (layer "In2.Cu" (type "copper") (thickness 0.0152))
      (layer "dielectric 3" (type "prepreg") (thickness 0.2104) (material "FR4") (epsilon_r 4.4))
      (layer "B.Cu" (type "copper") (thickness 0.035))
      (layer "B.Mask" (type "Bottom Solder Mask") (color "Green") (thickness 0.01))
      (copper_finish "ENIG")
    )
    (pad_to_mask_clearance 0)
  )`);

const nets = ['', 'GND', '+3V3', 'VBUS', 'SWDIO', 'SWCLK', 'NRST', 'USB_D+', 'USB_D-', 'LED', 'TX', 'RX'];
nets.forEach((n, i) => out.push(`  (net ${i} "${n}")`));
const netId = (name) => nets.indexOf(name);

// ── outline: rounded rectangle from 4 lines + 4 arcs ──
const x0 = OX, y0 = OY, x1 = OX + W, y1 = OY + H;
const line = (a, b, layer = 'Edge.Cuts', w = 0.1) =>
  out.push(`  (gr_line (start ${f(a[0])} ${f(a[1])}) (end ${f(b[0])} ${f(b[1])}) (stroke (width ${w}) (type default)) (layer "${layer}") (uuid "${uuid()}"))`);
const arc = (s, m, e) =>
  out.push(`  (gr_arc (start ${f(s[0])} ${f(s[1])}) (mid ${f(m[0])} ${f(m[1])}) (end ${f(e[0])} ${f(e[1])}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "${uuid()}"))`);
const k = R * (1 - Math.SQRT1_2);
line([x0 + R, y0], [x1 - R, y0]);
arc([x1 - R, y0], [x1 - k, y0 + k], [x1, y0 + R]);
line([x1, y0 + R], [x1, y1 - R]);
arc([x1, y1 - R], [x1 - k, y1 - k], [x1 - R, y1]);
line([x1 - R, y1], [x0 + R, y1]);
arc([x0 + R, y1], [x0 + k, y1 - k], [x0, y1 - R]);
line([x0, y1 - R], [x0, y0 + R]);
arc([x0, y0 + R], [x0 + k, y0 + k], [x0 + R, y0]);
// internal slot cut-out
out.push(`  (gr_rect (start ${x0 + 50} ${y0 + 30}) (end ${x0 + 58} ${y0 + 34}) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts") (uuid "${uuid()}"))`);
// board title on silkscreen
line([x0 + 4, y1 - 3], [x0 + 24, y1 - 3], 'F.SilkS', 0.15);

// ── footprints ──
function footprint({ lib, ref, value, x, y, rot = 0, side = 'F', pads, body }) {
  const L = (l) => (side === 'B' ? l.replace(/^F\./, 'B.') : l);
  const lines = [];
  lines.push(`  (footprint "${lib}" (layer "${L('F.Cu')}") (uuid "${uuid()}") (at ${f(x)} ${f(y)}${rot ? ' ' + rot : ''})`);
  lines.push(`    (property "Reference" "${ref}" (at 0 ${f(-body[1] / 2 - 1)} ${rot || 0}) (layer "${L('F.SilkS')}") (effects (font (size 1 1) (thickness 0.15))))`);
  lines.push(`    (property "Value" "${value}" (at 0 ${f(body[1] / 2 + 1)} ${rot || 0}) (layer "${L('F.Fab')}") (effects (font (size 1 1) (thickness 0.15))))`);
  const [bw, bh] = body;
  lines.push(`    (fp_rect (start ${f(-bw / 2)} ${f(-bh / 2)}) (end ${f(bw / 2)} ${f(bh / 2)}) (stroke (width 0.1) (type default)) (fill none) (layer "${L('F.Fab')}") (uuid "${uuid()}"))`);
  lines.push(`    (fp_rect (start ${f(-bw / 2 - 0.25)} ${f(-bh / 2 - 0.25)}) (end ${f(bw / 2 + 0.25)} ${f(bh / 2 + 0.25)}) (stroke (width 0.05) (type default)) (fill none) (layer "${L('F.CrtYd')}") (uuid "${uuid()}"))`);
  lines.push(`    (fp_line (start ${f(-bw / 2 - 0.2)} ${f(-bh / 2 - 0.2)}) (end ${f(bw / 2 + 0.2)} ${f(-bh / 2 - 0.2)}) (stroke (width 0.12) (type default)) (layer "${L('F.SilkS')}") (uuid "${uuid()}"))`);
  for (const p of pads) {
    const ang = (rot || 0) + (p.rot || 0);
    const net = p.net ? ` (net ${netId(p.net)} "${p.net}")` : '';
    if (p.tht) {
      lines.push(`    (pad "${p.n}" thru_hole ${p.shape || 'circle'} (at ${f(p.x)} ${f(p.y)}${ang ? ' ' + ang : ''}) (size ${p.w} ${p.h}) (drill ${p.drill}) (layers "*.Cu" "*.Mask")${net} (uuid "${uuid()}"))`);
    } else if (p.npth) {
      lines.push(`    (pad "" np_thru_hole circle (at ${f(p.x)} ${f(p.y)}) (size ${p.w} ${p.w}) (drill ${p.w}) (layers "*.Cu" "*.Mask") (uuid "${uuid()}"))`);
    } else {
      lines.push(`    (pad "${p.n}" smd ${p.shape || 'roundrect'} (at ${f(p.x)} ${f(p.y)}${ang ? ' ' + ang : ''}) (size ${p.w} ${p.h}) (layers "${L('F.Cu')}" "${L('F.Paste')}" "${L('F.Mask')}") (roundrect_rratio 0.25)${net} (uuid "${uuid()}"))`);
    }
  }
  lines.push('  )');
  out.push(lines.join('\n'));
}

// MCU — LQFP-32, 7x7 body, 0.8 mm pitch
const qfpPads = [];
const qfpNets = ['+3V3', 'GND', 'NRST', 'LED', 'TX', 'RX', 'USB_D-', 'USB_D+', 'SWDIO', 'SWCLK'];
for (let side = 0; side < 4; side++) {
  for (let i = 0; i < 8; i++) {
    const t = -2.8 + i * 0.8;
    const n = side * 8 + i + 1;
    const net = qfpNets[n % qfpNets.length];
    if (side === 0) qfpPads.push({ n, x: -4.25, y: t, w: 1.5, h: 0.5, net });
    if (side === 1) qfpPads.push({ n, x: t, y: 4.25, w: 0.5, h: 1.5, net });
    if (side === 2) qfpPads.push({ n, x: 4.25, y: -t, w: 1.5, h: 0.5, net });
    if (side === 3) qfpPads.push({ n, x: -t, y: -4.25, w: 0.5, h: 1.5, net });
  }
}
qfpPads.push({ n: 33, x: 0, y: 0, w: 3.5, h: 3.5, net: 'GND', shape: 'rect' });
const U1 = { x: OX + 30, y: OY + 20 };
footprint({ lib: 'Package_QFP:LQFP-32_7x7mm_P0.8mm', ref: 'U1', value: 'STM32G031K8', ...U1, pads: qfpPads, body: [7, 7] });

// passives 0603 around the MCU
const passives = [
  { ref: 'C1', value: '100nF', x: OX + 22, y: OY + 12, rot: 90, nets: ['+3V3', 'GND'] },
  { ref: 'C2', value: '100nF', x: OX + 38, y: OY + 12, rot: 90, nets: ['+3V3', 'GND'] },
  { ref: 'C3', value: '4.7uF', x: OX + 22, y: OY + 28, rot: 0, nets: ['+3V3', 'GND'] },
  { ref: 'R1', value: '10k', x: OX + 38, y: OY + 28, rot: 0, nets: ['NRST', '+3V3'] },
  { ref: 'R2', value: '330R', x: OX + 46, y: OY + 20, rot: 90, nets: ['LED', 'GND'] },
  { ref: 'R3', value: '22R', x: OX + 14, y: OY + 17, rot: 0, nets: ['USB_D+', 'USB_D+'] },
  { ref: 'R4', value: '22R', x: OX + 14, y: OY + 23, rot: 0, nets: ['USB_D-', 'USB_D-'] },
];
for (const p of passives) {
  footprint({
    lib: p.ref.startsWith('C') ? 'Capacitor_SMD:C_0603_1608Metric' : 'Resistor_SMD:R_0603_1608Metric',
    ref: p.ref, value: p.value, x: p.x, y: p.y, rot: p.rot,
    pads: [{ n: 1, x: -0.8, y: 0, w: 0.9, h: 0.95, net: p.nets[0] }, { n: 2, x: 0.8, y: 0, w: 0.9, h: 0.95, net: p.nets[1] }],
    body: [1.6, 0.8],
  });
}
// LED on the bottom side
footprint({
  lib: 'LED_SMD:LED_0805_2012Metric', ref: 'D1', value: 'GREEN', x: OX + 52, y: OY + 20, rot: 90, side: 'B',
  pads: [{ n: 1, x: -1, y: 0, w: 1, h: 1.2, net: 'LED' }, { n: 2, x: 1, y: 0, w: 1, h: 1.2, net: 'GND' }],
  body: [2, 1.25],
});
// 1x4 pin header (SWD) and USB-ish 1x4 header
for (const [ref, x, y, netsH] of [['J1', OX + 30, OY + 36, ['+3V3', 'SWDIO', 'SWCLK', 'GND']], ['J2', OX + 5, OY + 20, ['VBUS', 'USB_D-', 'USB_D+', 'GND']]]) {
  const vertical = ref === 'J2';
  footprint({
    lib: 'Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical', ref, value: ref === 'J1' ? 'SWD' : 'USB', x, y, rot: vertical ? 90 : 0,
    pads: netsH.map((net, i) => ({ n: i + 1, x: -3.81 + i * 2.54, y: 0, w: 1.7, h: 1.7, drill: 1, tht: true, shape: i === 0 ? 'rect' : 'oval', net })),
    body: [10.16, 2.54],
  });
}
// mounting holes
for (const [i, mx, my] of [[1, OX + 4, OY + 4], [2, OX + W - 4, OY + 4], [3, OX + 4, OY + H - 4], [4, OX + W - 4, OY + H - 4]]) {
  footprint({ lib: 'MountingHole:MountingHole_3.2mm_M3', ref: `H${i}`, value: 'M3', x: mx, y: my, pads: [{ npth: true, x: 0, y: 0, w: 3.2 }], body: [6, 6] });
}

// ── tracks ──
const seg = (a, b, w, layer, net) =>
  out.push(`  (segment (start ${f(a[0])} ${f(a[1])}) (end ${f(b[0])} ${f(b[1])}) (width ${w}) (layer "${layer}") (net ${netId(net)}) (uuid "${uuid()}"))`);
const via = (p, net, size = 0.6, drill = 0.3) =>
  out.push(`  (via (at ${f(p[0])} ${f(p[1])}) (size ${size}) (drill ${drill}) (layers "F.Cu" "B.Cu") (net ${netId(net)}) (uuid "${uuid()}"))`);
const tArc = (s, m, e, w, layer, net) =>
  out.push(`  (arc (start ${f(s[0])} ${f(s[1])}) (mid ${f(m[0])} ${f(m[1])}) (end ${f(e[0])} ${f(e[1])}) (width ${w}) (layer "${layer}") (net ${netId(net)}) (uuid "${uuid()}"))`);

// USB diff pair from J2 → R3/R4 → MCU (F.Cu)
seg([OX + 5, OY + 17.46], [OX + 9, OY + 17], 0.3, 'F.Cu', 'USB_D+');
seg([OX + 9, OY + 17], [OX + 13.2, OY + 17], 0.3, 'F.Cu', 'USB_D+');
seg([OX + 5, OY + 20 + 1.27 - 1.27 + 2.54 - 2.54], [OX + 9, OY + 23], 0.3, 'F.Cu', 'USB_D-');
seg([OX + 9, OY + 23], [OX + 13.2, OY + 23], 0.3, 'F.Cu', 'USB_D-');
seg([OX + 14.8, OY + 17], [OX + 20, OY + 17], 0.3, 'F.Cu', 'USB_D+');
tArc([OX + 20, OY + 17], [OX + 21.8, OY + 17.8], [OX + 22.6, OY + 19.6], 0.3, 'F.Cu', 'USB_D+');
seg([OX + 22.6, OY + 19.6], [OX + 25.75, OY + 19.6], 0.3, 'F.Cu', 'USB_D+');
seg([OX + 14.8, OY + 23], [OX + 20, OY + 23], 0.3, 'F.Cu', 'USB_D-');
tArc([OX + 20, OY + 23], [OX + 21.8, OY + 22.2], [OX + 22.6, OY + 20.4], 0.3, 'F.Cu', 'USB_D-');
seg([OX + 22.6, OY + 20.4], [OX + 25.75, OY + 20.4], 0.3, 'F.Cu', 'USB_D-');
// power rails
seg([OX + 22, OY + 11.2], [OX + 22, OY + 8], 0.5, 'F.Cu', '+3V3');
seg([OX + 22, OY + 8], [OX + 38, OY + 8], 0.5, 'F.Cu', '+3V3');
seg([OX + 38, OY + 8], [OX + 38, OY + 11.2], 0.5, 'F.Cu', '+3V3');
seg([OX + 30, OY + 8], [OX + 30, OY + 15.75], 0.4, 'F.Cu', '+3V3');
via([OX + 22, OY + 14], 'GND');
via([OX + 38, OY + 14], 'GND');
seg([OX + 22, OY + 12.8], [OX + 22, OY + 14], 0.4, 'F.Cu', 'GND');
seg([OX + 38, OY + 12.8], [OX + 38, OY + 14], 0.4, 'F.Cu', 'GND');
// LED net to the bottom side through a via
seg([OX + 34.25, OY + 20], [OX + 45.2, OY + 20], 0.25, 'F.Cu', 'LED');
seg([OX + 46, OY + 19.2], [OX + 49, OY + 19.2], 0.25, 'F.Cu', 'LED');
via([OX + 49, OY + 19.2], 'LED');
seg([OX + 49, OY + 19.2], [OX + 52, OY + 19], 0.25, 'B.Cu', 'LED');
// SWD lines down to J1 on B.Cu
for (const [i, net] of [[1, 'SWDIO'], [2, 'SWCLK']]) {
  const vx = OX + 28 + i * 2;
  via([vx, OY + 26.5], net);
  seg([vx, OY + 24.25], [vx, OY + 26.5], 0.25, 'F.Cu', net);
  seg([vx, OY + 26.5], [OX + 30 - 3.81 + i * 2.54, OY + 33], 0.25, 'B.Cu', net);
  seg([OX + 30 - 3.81 + i * 2.54, OY + 33], [OX + 30 - 3.81 + i * 2.54, OY + 36], 0.25, 'B.Cu', net);
}
// stitching vias
for (let i = 0; i < 12; i++) via([OX + 8 + i * 4.2, OY + 39], 'GND', 0.5, 0.25);
for (let i = 0; i < 6; i++) via([OX + 60, OY + 8 + i * 4.5], 'GND', 0.5, 0.25);
// inner-layer power distribution
seg([OX + 8, OY + 6], [OX + 47, OY + 6], 1.0, 'In1.Cu', '+3V3');
seg([OX + 47, OY + 6], [OX + 47, OY + 36], 1.0, 'In1.Cu', '+3V3');
seg([OX + 10, OY + 30], [OX + 46, OY + 30], 0.2, 'In2.Cu', 'TX');
seg([OX + 10, OY + 31], [OX + 46, OY + 31], 0.2, 'In2.Cu', 'RX');

// ── GND pour on B.Cu (with a filled polygon, as KiCad saves it) ──
const m = 1;
const pour = [[x0 + m, y0 + m], [x1 - m, y0 + m], [x1 - m, y1 - m], [x0 + m, y1 - m]];
const pts = (list) => list.map((p) => `(xy ${f(p[0])} ${f(p[1])})`).join(' ');
out.push(`  (zone (net ${netId('GND')}) (net_name "GND") (layer "B.Cu") (uuid "${uuid()}") (hatch edge 0.5)
    (connect_pads (clearance 0.3)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts ${pts(pour)}))
    (filled_polygon (layer "B.Cu") (pts ${pts([[x0 + 1.5, y0 + 1.5], [x1 - 1.5, y0 + 1.5], [x1 - 1.5, y0 + 28.5], [x0 + 49.5, y0 + 28.5], [x0 + 49.5, y0 + 35.5], [x1 - 1.5, y0 + 35.5], [x1 - 1.5, y1 - 1.5], [x0 + 1.5, y1 - 1.5]])}))
  )`);
out.push(`  (zone (net ${netId('GND')}) (net_name "GND") (layer "In2.Cu") (uuid "${uuid()}") (hatch edge 0.5)
    (polygon (pts ${pts([[x0 + 30, y0 + 2], [x1 - 2, y0 + 2], [x1 - 2, y0 + 26], [x0 + 30, y0 + 26]])}))
    (filled_polygon (layer "In2.Cu") (pts ${pts([[x0 + 30, y0 + 2], [x1 - 2, y0 + 2], [x1 - 2, y0 + 26], [x0 + 30, y0 + 26]])}))
  )`);
out.push(')\n');

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples', 'demo-board.kicad_pcb');
writeFileSync(dest, out.join('\n'));
console.log('wrote', dest);
