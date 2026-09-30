import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chainLoops, parseKiCadPcb, parseSExpr, summarizeKiCadPcb } from '../public/js/viewer/kicad-parser.js';

const demo = readFileSync(new URL('../public/samples/demo-board.kicad_pcb', import.meta.url), 'utf8');

test('parseSExpr handles strings, escapes and nesting', () => {
  const t = parseSExpr('(a "b c" (d 1.5 "e\\"f") g)');
  assert.deepEqual(t, ['a', 'b c', ['d', '1.5', 'e"f'], 'g']);
});

test('parseSExpr reports the line of an unbalanced document', () => {
  assert.throws(() => parseSExpr('(kicad_pcb\n (version 1)\n (layers'), /Unbalanced parentheses.*line/);
});

test('demo board: layers, outline, counts', () => {
  const b = parseKiCadPcb(demo);
  assert.deepEqual(b.copperLayers, ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
  assert.equal(b.stats.widthMm, 64);
  assert.equal(b.stats.heightMm, 42);
  assert.equal(b.outline.holes.length, 1, 'slot cut-out becomes an inner loop');
  // 64x42 minus 4 rounded corners (r=3) minus the 8x4 slot
  assert.ok(Math.abs(b.stats.areaCm2 - 26.48) < 0.05, `area ${b.stats.areaCm2}`);
  assert.equal(b.stats.footprints, 15);
  assert.equal(b.stats.nets, 11);
  assert.equal(b.stats.kicadVersion, '8.x');
  assert.equal(b.zones.length, 2);
  assert.ok(b.tracks.some((t) => t.pts.length > 2), 'track arcs are tessellated');
});

test('footprint rotation is applied to pad positions', () => {
  const b = parseKiCadPcb(demo);
  // C1 at (122, 92) rotated 90°: local pad 1 at (-0.8, 0) → (122, 92.8) in KiCad Y-down space
  const pad = b.pads.find((p) => p.footprint === 'C1' && Math.abs(p.x - 122) < 1e-6);
  assert.ok(pad, 'C1 pad found on the rotated axis');
  assert.ok([92.8, 91.2].some((y) => Math.abs(pad.y - y) < 1e-6));
  const pads = b.pads.filter((p) => p.footprint === 'C1').map((p) => +p.y.toFixed(3)).sort();
  assert.deepEqual(pads, [91.2, 92.8]);
});

test('bottom-side footprints and through-hole pads', () => {
  const b = parseKiCadPcb(demo);
  assert.equal(b.footprints.find((f) => f.ref === 'D1').side, 'B');
  const tht = b.pads.filter((p) => p.type === 'thru_hole');
  assert.equal(tht.length, 8);
  assert.ok(tht.every((p) => p.layers.includes('In1.Cu') && p.drill.w === 1), '*.Cu expands to every copper layer');
  assert.equal(b.pads.filter((p) => p.type === 'np_thru_hole').length, 4);
});

test('KiCad 5 legacy (module / gr_arc with angle) parses', () => {
  const legacy = `(kicad_pcb (version 20171130) (host pcbnew 5.1.9)
    (general (thickness 1.2))
    (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))
    (net 0 "") (net 1 GND)
    (gr_line (start 0 0) (end 20 0) (layer Edge.Cuts) (width 0.1))
    (gr_line (start 20 0) (end 20 10) (layer Edge.Cuts) (width 0.1))
    (gr_line (start 20 10) (end 0 10) (layer Edge.Cuts) (width 0.1))
    (gr_line (start 0 10) (end 0 0) (layer Edge.Cuts) (width 0.1))
    (module R_0603 (layer F.Cu) (at 10 5 90)
      (fp_text reference R1 (at 0 0) (layer F.SilkS))
      (pad 1 smd rect (at -0.8 0 90) (size 0.9 0.9) (layers F.Cu F.Paste F.Mask) (net 1 GND))
      (pad 2 smd rect (at 0.8 0 90) (size 0.9 0.9) (layers F.Cu F.Paste F.Mask)))
    (segment (start 1 1) (end 5 1) (width 0.25) (layer F.Cu) (net 1))
  )`;
  const s = summarizeKiCadPcb(legacy);
  assert.equal(s.copperLayerCount, 2);
  assert.equal(s.widthMm, 20);
  assert.equal(s.heightMm, 10);
  assert.equal(s.footprints, 1);
  assert.equal(s.pads, 2);
  assert.equal(s.thickness, 1.2);
  assert.equal(s.kicadVersion, '5.x');
});

test('board without Edge.Cuts falls back to a padded bounding box', () => {
  const s = summarizeKiCadPcb('(kicad_pcb (version 20240108) (segment (start 0 0) (end 10 0) (width 0.2) (layer "F.Cu")))');
  assert.equal(s.widthMm, 14);
});

test('chainLoops joins reversed segments', () => {
  const loops = chainLoops([
    { closed: false, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
    { closed: false, pts: [{ x: 1, y: 1 }, { x: 1, y: 0 }] },
    { closed: false, pts: [{ x: 1, y: 1 }, { x: 0, y: 1 }] },
    { closed: false, pts: [{ x: 0, y: 1 }, { x: 0, y: 0 }] },
  ]);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 4);
});

test('rejects non-PCB documents', () => {
  assert.throws(() => parseKiCadPcb('(kicad_sch (version 1))'), /Not a KiCad PCB/);
});

test('copper items carry resolved net names', () => {
  const b = parseKiCadPcb(demo);
  assert.ok(b.tracks.every((t) => typeof t.net === 'string' && t.net.length > 0));
  assert.ok(b.tracks.some((t) => t.net === 'USB_D+'));
  assert.ok(b.vias.filter((v) => v.net === 'GND').length >= 18);
  assert.ok(b.zones.every((z) => z.net === 'GND'));
  assert.equal(b.pads.find((p) => p.footprint === 'U1' && p.number === '33').net, 'GND');
});
