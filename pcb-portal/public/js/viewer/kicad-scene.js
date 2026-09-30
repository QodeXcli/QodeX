// Builds a three.js scene graph from a parsed KiCad board model.
//
// Coordinate mapping: KiCad file space is (x right, y DOWN, mm). The board is
// built in a local XY plane with Y flipped (y → -y) and Z as board thickness,
// then the whole group is rotated so the board lies flat (Z-up → Y-up).
import * as THREE from 'three';

export const MASK_COLORS = {
  green: 0x145a2e,
  black: 0x111214,
  white: 0xe8e8e2,
  blue: 0x1d3f7a,
  red: 0x8a1c1c,
  yellow: 0xb99a13,
  purple: 0x4b2a6b,
  matte_black: 0x151515,
  matte_green: 0x24503a,
};

export const FINISH_COLORS = {
  enig: 0xd4a94c,
  hasl: 0xc9ccd1,
  lf_hasl: 0xc9ccd1,
  osp: 0xc27a47,
  immersion_silver: 0xdadde2,
  hard_gold: 0xe0b049,
};

const COPPER = 0xc8773f;
const FR4 = 0xbfa36a;
const SEG = 10; // segments per semicircle

// ── triangle accumulator ────────────────────────────────────────────────────
class TriBuffer {
  constructor() {
    this.pos = [];
  }
  tri(ax, ay, bx, by, cx, cy, z) {
    this.pos.push(ax, ay, z, bx, by, z, cx, cy, z);
  }
  /** capsule (track segment with round ends) in flipped space */
  capsule(x1, y1, x2, y2, w, z) {
    const r = w / 2;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const ux = len > 1e-9 ? dx / len : 1, uy = len > 1e-9 ? dy / len : 0;
    const nx = -uy * r, ny = ux * r;
    if (len > 1e-9) {
      this.tri(x1 + nx, y1 + ny, x1 - nx, y1 - ny, x2 - nx, y2 - ny, z);
      this.tri(x1 + nx, y1 + ny, x2 - nx, y2 - ny, x2 + nx, y2 + ny, z);
    }
    const a0 = Math.atan2(ny, nx);
    this.fan(x1, y1, r, a0, Math.PI, z);
    this.fan(x2, y2, r, a0 + Math.PI, Math.PI, z);
  }
  fan(cx, cy, r, a0, sweep, z, n = SEG) {
    for (let k = 0; k < n; k++) {
      const a = a0 + (sweep * k) / n, b = a0 + (sweep * (k + 1)) / n;
      this.tri(cx, cy, cx + r * Math.cos(a), cy + r * Math.sin(a), cx + r * Math.cos(b), cy + r * Math.sin(b), z);
    }
  }
  disc(cx, cy, r, z, n = 20) {
    this.fan(cx, cy, r, 0, Math.PI * 2, z, n);
  }
  /** polygon with optional holes; points are THREE.Vector2 */
  polygon(outer, holes, z) {
    if (outer.length < 3) return;
    const tris = THREE.ShapeUtils.triangulateShape(outer, holes || []);
    const all = holes && holes.length ? outer.concat(...holes) : outer;
    for (const [a, b, c] of tris) this.tri(all[a].x, all[a].y, all[b].x, all[b].y, all[c].x, all[c].y, z);
  }
  geometry() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals();
    // flat parts face +Z; make sure normals are consistent even for CW input
    const n = g.getAttribute('normal');
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 0, 1);
    return g;
  }
}

const V = (p) => new THREE.Vector2(p.x, -p.y);

function rotPt(x, y, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/** Pad outline in flipped (three) space as an array of Vector2 */
function padOutline(pad) {
  const { w, h } = pad;
  let local = [];
  const shape = pad.shape;
  if (shape === 'circle') {
    const r = w / 2;
    for (let k = 0; k < 24; k++) local.push([r * Math.cos((k / 24) * Math.PI * 2), r * Math.sin((k / 24) * Math.PI * 2)]);
  } else if (shape === 'oval' || shape === 'roundrect') {
    const rr = shape === 'oval' ? Math.min(w, h) / 2 : Math.min(w, h) * Math.min(0.5, pad.rratio ?? 0.25);
    local = roundedRect(w, h, rr);
  } else {
    local = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  }
  // KiCad y-down → flip then rotate CCW by pad angle
  return local.map(([x, y]) => {
    const [rx, ry] = rotPt(x, -y, pad.rot || 0);
    return new THREE.Vector2(pad.x + rx, -pad.y + ry);
  });
}

function roundedRect(w, h, r) {
  const pts = [];
  if (r <= 1e-6) return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  const cx = w / 2 - r, cy = h / 2 - r;
  const corners = [[cx, cy, 0], [-cx, cy, 90], [-cx, -cy, 180], [cx, -cy, 270]];
  for (const [x, y, a0] of corners) {
    for (let k = 0; k <= 6; k++) {
      const a = ((a0 + (90 * k) / 6) * Math.PI) / 180;
      pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
    }
  }
  return pts;
}

function holeOutline(x, y, drill, rot, n = 20) {
  // drill w/h slot → stadium; round → circle. Returned CW so it works as a hole.
  const pts = [];
  if (Math.abs(drill.w - drill.h) < 1e-6) {
    const r = drill.w / 2;
    for (let k = n - 1; k >= 0; k--) pts.push(new THREE.Vector2(x + r * Math.cos((k / n) * Math.PI * 2), -y + r * Math.sin((k / n) * Math.PI * 2)));
    return pts;
  }
  const local = roundedRect(drill.w, drill.h, Math.min(drill.w, drill.h) / 2).reverse();
  for (const [lx, ly] of local) {
    const [rx, ry] = rotPt(lx, -ly, rot || 0);
    pts.push(new THREE.Vector2(x + rx, -y + ry));
  }
  return pts;
}

const ensureCCW = (pts) => (THREE.ShapeUtils.isClockWise(pts) ? pts.slice().reverse() : pts);
const ensureCW = (pts) => (THREE.ShapeUtils.isClockWise(pts) ? pts : pts.slice().reverse());

/**
 * Build the board. Returns { group, layers: Map(name → Object3D), meta, setExplode(f), setMaskOpacity(o) }.
 * opts: { maskColor, finish, silkColor, showComponents }
 */
export function buildBoardScene(board, opts = {}) {
  const maskHex = MASK_COLORS[opts.maskColor] ?? MASK_COLORS.green;
  const finishHex = FINISH_COLORS[opts.finish] ?? FINISH_COLORS.enig;
  const silkHex = opts.silkColor === 'black' ? 0x151515 : 0xf4f4f0;
  const T = board.thickness || 1.6;
  const root = new THREE.Group();
  root.name = 'kicad-board';
  const boardGroup = new THREE.Group();
  root.add(boardGroup);
  const layerGroups = new Map();
  const copper = board.copperLayers;
  const nCu = copper.length;

  // Z position for each copper layer (evenly through the core, outer layers on the faces)
  const layerZ = new Map(copper.map((name, i) => [name, nCu === 1 ? T : T - (T * i) / (nCu - 1)]));

  // ── substrate with outline cut-outs and drilled holes ──
  const outer = ensureCCW(board.outline.outer.map(V));
  const shape = new THREE.Shape(outer);
  for (const h of board.outline.holes) shape.holes.push(new THREE.Path(ensureCW(h.map(V))));
  const drillHoles = [];
  for (const v of board.vias) drillHoles.push({ x: v.x, y: v.y, drill: { w: v.drill, h: v.drill }, rot: 0, plated: true });
  for (const p of board.pads) if (p.drill) drillHoles.push({ x: p.x, y: p.y, drill: p.drill, rot: p.rot, plated: p.type !== 'np_thru_hole' });
  const cutHoles = drillHoles.length <= 2500;
  if (cutHoles) for (const d of drillHoles) shape.holes.push(new THREE.Path(holeOutline(d.x, d.y, d.drill, d.rot, d.drill.w > 1.2 ? 28 : 14)));

  const substrateGeo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 12 });
  const maskMat = new THREE.MeshStandardMaterial({ color: maskHex, roughness: 0.45, metalness: 0.05, transparent: true, opacity: 1 });
  const fr4Mat = new THREE.MeshStandardMaterial({ color: FR4, roughness: 0.85, metalness: 0 });
  const substrate = new THREE.Mesh(substrateGeo, [maskMat, fr4Mat]);
  substrate.name = 'substrate';
  boardGroup.add(substrate);

  // ── per-layer copper ──
  const tint = new THREE.Color(maskHex).lerp(new THREE.Color(COPPER), 0.35);
  const underMaskMat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.4, metalness: 0.2, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const innerCuMat = new THREE.MeshStandardMaterial({ color: COPPER, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide });
  const padMat = new THREE.MeshStandardMaterial({ color: finishHex, roughness: 0.25, metalness: 0.85, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const silkMat = new THREE.MeshStandardMaterial({ color: silkHex, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });

  const EPS = 0.012;
  for (const name of copper) {
    const isTop = name === 'F.Cu', isBot = name === 'B.Cu';
    const outerLayer = isTop || isBot;
    const z0 = layerZ.get(name);
    const face = isBot ? -1 : 1;
    const zc = outerLayer ? z0 + face * EPS : z0;
    const cu = new TriBuffer();
    for (const t of board.tracks) {
      if (t.layer !== name) continue;
      for (let k = 0; k + 1 < t.pts.length; k++) cu.capsule(t.pts[k].x, -t.pts[k].y, t.pts[k + 1].x, -t.pts[k + 1].y, t.width, zc);
    }
    for (const zn of board.zones) {
      if (zn.layer !== name || zn.pts.length < 3) continue;
      cu.polygon(zn.pts.map(V), [], zc);
    }
    // via annular rings on every layer they span
    for (const v of board.vias) {
      const a = copper.indexOf(v.from), b = copper.indexOf(v.to), i = copper.indexOf(name);
      if (i >= Math.min(a, b) && i <= Math.max(a, b)) cu.disc(v.x, -v.y, v.size / 2, zc, 16);
    }
    const g = new THREE.Group();
    g.name = name;
    g.userData.baseZ = 0;
    const cuGeo = cu.geometry();
    if (cuGeo) {
      if (isBot) flipNormals(cuGeo);
      g.add(new THREE.Mesh(cuGeo, outerLayer ? underMaskMat : innerCuMat));
    }
    // exposed pads (outer layers) — sit on top of the mask
    const pads = new TriBuffer();
    const zp = outerLayer ? z0 + face * EPS * 2 : z0 + 0.001;
    for (const p of board.pads) {
      if (!p.layers.includes(name)) continue;
      if (p.type === 'np_thru_hole') continue;
      const holes = p.drill ? [holeOutline(p.x, p.y, p.drill, p.rot, 14)] : [];
      pads.polygon(ensureCCW(padOutline(p)), holes, zp);
    }
    const padGeo = pads.geometry();
    if (padGeo) {
      if (isBot) flipNormals(padGeo);
      g.add(new THREE.Mesh(padGeo, outerLayer ? padMat : innerCuMat));
    }
    layerGroups.set(name, g);
    boardGroup.add(g);
  }

  // ── plated barrels for vias & THT pads ──
  const barrels = drillHoles.filter((d) => d.plated && Math.abs(d.drill.w - d.drill.h) < 1e-6);
  if (barrels.length) {
    const cyl = new THREE.CylinderGeometry(0.5, 0.5, T, 16, 1, true);
    cyl.rotateX(Math.PI / 2);
    cyl.translate(0, 0, T / 2);
    const barrelMat = new THREE.MeshStandardMaterial({ color: finishHex, roughness: 0.3, metalness: 0.9, side: THREE.DoubleSide });
    const inst = new THREE.InstancedMesh(cyl, barrelMat, barrels.length);
    const m = new THREE.Matrix4();
    barrels.forEach((d, i) => {
      m.makeScale(d.drill.w, d.drill.w, 1).setPosition(d.x, -d.y, 0);
      inst.setMatrixAt(i, m);
    });
    inst.name = 'barrels';
    boardGroup.add(inst);
  }
  if (!cutHoles) {
    // too many holes to boolean-cut: paint them as dark discs instead
    for (const zf of [T + EPS * 3, -EPS * 3]) {
      const dots = new TriBuffer();
      for (const d of drillHoles) dots.disc(d.x, -d.y, d.drill.w / 2, zf, 10);
      const geo = dots.geometry();
      if (geo) boardGroup.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x050505, side: THREE.DoubleSide })));
    }
  }

  // ── silkscreen ──
  for (const [layer, z, bottom] of [['F.SilkS', T + EPS * 3, false], ['B.SilkS', -EPS * 3, true]]) {
    const silk = new TriBuffer();
    for (const gp of board.graphics) {
      if (gp.layer !== layer && gp.layer !== layer.replace('SilkS', 'Silkscreen')) continue;
      const pts = gp.closed ? gp.pts.concat([gp.pts[0]]) : gp.pts;
      if (gp.filled && gp.closed && gp.pts.length >= 3) silk.polygon(ensureCCW(gp.pts.map(V)), [], z);
      for (let k = 0; k + 1 < pts.length; k++) silk.capsule(pts[k].x, -pts[k].y, pts[k + 1].x, -pts[k + 1].y, Math.max(gp.width, 0.1), z);
    }
    const geo = silk.geometry();
    if (geo) {
      if (bottom) flipNormals(geo);
      const mesh = new THREE.Mesh(geo, silkMat);
      mesh.name = layer;
      layerGroups.set(layer, mesh);
      boardGroup.add(mesh);
    }
  }

  // ── component bodies (approximate boxes from the fab/courtyard outline) ──
  const components = new THREE.Group();
  components.name = 'components';
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.55, metalness: 0.1 });
  const passiveMat = new THREE.MeshStandardMaterial({ color: 0x6b5a45, roughness: 0.6, metalness: 0.05 });
  for (const fp of board.footprints) {
    if (/MountingHole|Fiducial|TestPoint|Logo|NetTie|Jumper/i.test(fp.lib) || fp.padCount === 0) continue;
    const bw = fp.local.maxX - fp.local.minX, bh = fp.local.maxY - fp.local.minY;
    if (bw <= 0 || bh <= 0) continue;
    const passive = /^(C|R|L|FB)\d/.test(fp.ref) || /_0[24-8]0[0-9]_/.test(fp.lib);
    const height = passive ? Math.min(0.9, Math.max(0.35, Math.min(bw, bh) * 0.55)) : Math.min(4, Math.max(0.8, Math.min(bw, bh) * 0.18 + 0.6));
    const box = new THREE.BoxGeometry(bw * (passive ? 0.7 : 1), bh * (passive ? 0.95 : 1), height);
    const mesh = new THREE.Mesh(box, passive ? passiveMat : bodyMat);
    const cx = (fp.local.minX + fp.local.maxX) / 2, cy = (fp.local.minY + fp.local.maxY) / 2;
    const [ox, oy] = rotPt(cx, -cy, fp.rot);
    const onBottom = fp.side === 'B';
    mesh.position.set(fp.x + ox, -fp.y + oy, onBottom ? -height / 2 - EPS * 4 : T + height / 2 + EPS * 4);
    mesh.rotation.z = (fp.rot * Math.PI) / 180;
    mesh.userData = { ref: fp.ref, value: fp.value, lib: fp.lib, baseZ: mesh.position.z };
    components.add(mesh);
  }
  components.visible = opts.showComponents !== false;
  boardGroup.add(components);

  // centre the board at the origin and lay it flat (Y-up world)
  const cx = (board.bbox.minX + board.bbox.maxX) / 2, cy = -(board.bbox.minY + board.bbox.maxY) / 2;
  boardGroup.position.set(-cx, -cy, -T / 2);
  root.rotation.x = -Math.PI / 2;

  function setExplode(f) {
    // separate the copper layers vertically so inner layers can be inspected
    copper.forEach((name, i) => {
      const g = layerGroups.get(name);
      if (!g) return;
      const offset = (nCu - 1) / 2 - i;
      g.position.z = offset * f * 6;
    });
    const top = layerGroups.get('F.SilkS');
    const bot = layerGroups.get('B.SilkS');
    if (top) top.position.z = ((nCu - 1) / 2) * f * 6;
    if (bot) bot.position.z = (-(nCu - 1) / 2) * f * 6;
    components.children.forEach((c) => {
      c.position.z = c.userData.baseZ + Math.sign(c.userData.baseZ) * ((nCu - 1) / 2) * f * 6;
    });
  }

  function setMaskOpacity(o) {
    maskMat.opacity = o;
    maskMat.depthWrite = o > 0.95;
    fr4Mat.transparent = o < 1;
    fr4Mat.opacity = o;
    fr4Mat.depthWrite = o > 0.95;
  }

  // ── net highlight overlay ──
  const highlightMat = new THREE.MeshBasicMaterial({ color: 0x2ce5e5, side: THREE.DoubleSide, transparent: true, opacity: 0.92, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10 });
  let highlightMeshes = [];
  function clearHighlight() {
    for (const m of highlightMeshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
    }
    highlightMeshes = [];
  }
  function highlightNet(net) {
    clearHighlight();
    if (!net) return 0;
    let count = 0;
    for (const name of copper) {
      const g = layerGroups.get(name);
      if (!g) continue;
      const isBot = name === 'B.Cu';
      const outerLayer = name === 'F.Cu' || isBot;
      const z = layerZ.get(name) + (outerLayer ? (isBot ? -1 : 1) * EPS * 3.5 : 0.002);
      const tb = new TriBuffer();
      for (const t of board.tracks) {
        if (t.layer !== name || t.net !== net) continue;
        for (let k = 0; k + 1 < t.pts.length; k++) tb.capsule(t.pts[k].x, -t.pts[k].y, t.pts[k + 1].x, -t.pts[k + 1].y, t.width, z);
        count++;
      }
      for (const zn of board.zones) if (zn.layer === name && zn.net === net && zn.pts.length >= 3) tb.polygon(zn.pts.map(V), [], z);
      for (const p of board.pads) {
        if (p.net !== net || !p.layers.includes(name) || p.type === 'np_thru_hole') continue;
        tb.polygon(ensureCCW(padOutline(p)), p.drill ? [holeOutline(p.x, p.y, p.drill, p.rot, 14)] : [], z);
        count++;
      }
      for (const v of board.vias) {
        if (v.net !== net) continue;
        const a = copper.indexOf(v.from), b = copper.indexOf(v.to), i = copper.indexOf(name);
        if (i >= Math.min(a, b) && i <= Math.max(a, b)) tb.disc(v.x, -v.y, v.size / 2, z, 16);
      }
      const geo = tb.geometry();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, highlightMat);
      mesh.renderOrder = 10;
      g.add(mesh);
      highlightMeshes.push(mesh);
    }
    return count;
  }

  // ── hit testing in KiCad file coordinates ──
  const netStats = new Map();
  for (const t of board.tracks) {
    if (!t.net) continue;
    const s = netStats.get(t.net) || { length: 0, tracks: 0, pads: 0, vias: 0 };
    for (let k = 0; k + 1 < t.pts.length; k++) s.length += Math.hypot(t.pts[k + 1].x - t.pts[k].x, t.pts[k + 1].y - t.pts[k].y);
    s.tracks++;
    netStats.set(t.net, s);
  }
  for (const p of board.pads) if (p.net) { const s = netStats.get(p.net) || { length: 0, tracks: 0, pads: 0, vias: 0 }; s.pads++; netStats.set(p.net, s); }
  for (const v of board.vias) if (v.net) { const s = netStats.get(v.net) || { length: 0, tracks: 0, pads: 0, vias: 0 }; s.vias++; netStats.set(v.net, s); }

  const segDist = (px, py, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  };
  const inPoly = (px, py, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

  /** Identify the copper / component under (x, y) on the given side ('F' | 'B'). */
  function pick(x, y, side = 'F') {
    const layer = side === 'B' ? 'B.Cu' : 'F.Cu';
    for (const p of board.pads) {
      if (!p.layers.includes(layer) && !p.drill) continue;
      const a = ((p.rot || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const dx = x - p.x, dy = y - p.y;
      const lx = c * dx - s * dy, ly = s * dx + c * dy;
      const hit = p.shape === 'circle' ? Math.hypot(dx, dy) <= p.w / 2 : Math.abs(lx) <= p.w / 2 && Math.abs(ly) <= p.h / 2;
      if (hit) return { kind: 'pad', net: p.net, footprint: p.footprint, pad: p, layer };
    }
    for (const v of board.vias) if (Math.hypot(x - v.x, y - v.y) <= v.size / 2) return { kind: 'via', net: v.net, via: v };
    for (const t of board.tracks) {
      if (t.layer !== layer) continue;
      for (let k = 0; k + 1 < t.pts.length; k++) if (segDist(x, y, t.pts[k], t.pts[k + 1]) <= t.width / 2) return { kind: 'track', net: t.net, track: t, layer };
    }
    for (const f of board.footprints) if (f.side === side && inPoly(x, y, f.corners)) return { kind: 'footprint', footprint: f.ref, fp: f };
    for (const z of board.zones) if (z.layer === layer && inPoly(x, y, z.pts)) return { kind: 'zone', net: z.net, layer };
    return null;
  }

  /** World point → KiCad file coordinates. */
  function toBoard(worldPoint) {
    const p = boardGroup.worldToLocal(worldPoint.clone());
    return { x: p.x, y: -p.y };
  }

  return {
    board,
    highlightNet,
    clearHighlight,
    pick,
    toBoard,
    netStats,
    thickness: T,
    object: root,
    layers: layerGroups,
    components,
    setExplode,
    setMaskOpacity,
    size: { x: board.bbox.maxX - board.bbox.minX, y: board.bbox.maxY - board.bbox.minY, z: T },
  };
}

function flipNormals(geo) {
  const n = geo.getAttribute('normal');
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 0, -1);
  // swap winding so the face is front-facing from below
  const p = geo.getAttribute('position');
  for (let i = 0; i < p.count; i += 3) {
    const bx = p.getX(i + 1), by = p.getY(i + 1), bz = p.getZ(i + 1);
    p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
    p.setXYZ(i + 2, bx, by, bz);
  }
}

