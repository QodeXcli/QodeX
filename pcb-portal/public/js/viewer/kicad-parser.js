// KiCad .kicad_pcb parser — pure JS, no DOM / three.js dependency.
//
// Shared by the browser (3D viewer) and the server (board metadata for quoting).
// Handles KiCad 5 (`module`) through KiCad 9 (`footprint`) boards. All
// coordinates are returned in KiCad file space: millimetres, +Y pointing DOWN.
// Angles are degrees, counter-clockwise as seen on screen.

/** Tokenise + parse an S-expression into nested arrays of strings. */
export function parseSExpr(text) {
  const len = text.length;
  let i = 0;
  const stack = [];
  let current = null;
  let root = null;

  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === 40 /* ( */) {
      const list = [];
      if (current) current.push(list);
      stack.push(current);
      current = list;
      i++;
    } else if (c === 41 /* ) */) {
      if (!current) throw new SExprError('Unexpected ")"', text, i);
      const done = current;
      current = stack.pop();
      if (!current && root === null) root = done;
      i++;
      if (!current && root) break;
    } else if (c === 34 /* " */) {
      let j = i + 1;
      let out = '';
      while (j < len) {
        const d = text.charCodeAt(j);
        if (d === 92 /* \ */ && j + 1 < len) {
          const n = text[j + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else if (d === 34) break;
        else { out += text[j]; j++; }
      }
      if (j >= len) throw new SExprError('Unterminated string', text, i);
      if (!current) throw new SExprError('String outside of a list', text, i);
      current.push(out);
      i = j + 1;
    } else if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
    } else {
      let j = i;
      while (j < len) {
        const d = text.charCodeAt(j);
        if (d === 40 || d === 41 || d === 32 || d === 9 || d === 10 || d === 13) break;
        j++;
      }
      if (!current) throw new SExprError('Atom outside of a list', text, i);
      current.push(text.slice(i, j));
      i = j;
    }
  }
  if (current || stack.length) throw new SExprError('Unbalanced parentheses: missing ")"', text, len - 1);
  if (!root) throw new SExprError('Empty document', text, 0);
  return root;
}

export class SExprError extends Error {
  constructor(message, text, offset) {
    let line = 1;
    for (let k = 0; k < offset && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
    super(`${message} (line ${line})`);
    this.name = 'SExprError';
    this.line = line;
  }
}

// ── small helpers over the nested-array tree ────────────────────────────────
const isList = (n) => Array.isArray(n);
const head = (n) => (isList(n) ? n[0] : undefined);
const child = (n, name) => n.find((c) => isList(c) && c[0] === name);
const children = (n, name) => n.filter((c) => isList(c) && c[0] === name);
const num = (v, d = 0) => {
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : d;
};
const xy = (n) => (n ? { x: num(n[1]), y: num(n[2]) } : null);
const layerOf = (n) => {
  const l = child(n, 'layer');
  return l ? l[1] : undefined;
};
const widthOf = (n) => {
  const w = child(n, 'width');
  if (w) return num(w[1]);
  const s = child(n, 'stroke');
  if (s) {
    const sw = child(s, 'width');
    if (sw) return num(sw[1]);
  }
  return 0.15;
};

const DEG = Math.PI / 180;

/** Rotate a local point by `deg` (KiCad convention, Y-down) and translate. */
export function kicadTransform(lx, ly, ox, oy, deg) {
  if (!deg) return { x: ox + lx, y: oy + ly };
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return { x: ox + lx * c + ly * s, y: oy - lx * s + ly * c };
}

/** Points along a circular arc through start → mid → end (KiCad 6+ form). */
export function arcThrough(p1, p2, p3, maxSegLen = 0.5) {
  const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [p1, p3];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a1 = Math.atan2(ay - uy, ax - ux);
  const a2 = Math.atan2(by - uy, bx - ux);
  const a3 = Math.atan2(cy - uy, cx - ux);
  // choose sweep direction that passes through the mid point
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(a3 - a1);
  if (norm(a2 - a1) > sweep) sweep -= 2 * Math.PI;
  return arcPoints(ux, uy, r, a1, sweep, maxSegLen);
}

/** KiCad 5 style arc: centre, start point, sweep angle in degrees. */
export function arcFromCentre(centre, start, angleDeg, maxSegLen = 0.5) {
  const r = Math.hypot(start.x - centre.x, start.y - centre.y);
  const a1 = Math.atan2(start.y - centre.y, start.x - centre.x);
  // In Y-down space a positive KiCad angle is clockwise on screen → +atan2 direction.
  return arcPoints(centre.x, centre.y, r, a1, angleDeg * DEG, maxSegLen);
}

function arcPoints(cx, cy, r, a1, sweep, maxSegLen) {
  const n = Math.max(2, Math.min(128, Math.ceil((Math.abs(sweep) * r) / maxSegLen)));
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const a = a1 + (sweep * k) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function circlePoints(cx, cy, r, n = 48) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/**
 * Convert one graphic primitive (gr_* / fp_*) into polylines.
 * `tf` maps local → board coordinates (identity for board-level graphics).
 * Returns { layer, width, closed, filled, pts[] } or null.
 */
function graphicToPolyline(node, tf) {
  const kind = head(node).replace(/^(gr|fp)_/, '');
  const layer = layerOf(node);
  const width = widthOf(node);
  const fillNode = child(node, 'fill');
  const filled = !!fillNode && (fillNode[1] === 'solid' || fillNode[1] === 'yes');
  const P = (n) => {
    const p = xy(n);
    return p ? tf(p.x, p.y) : null;
  };
  switch (kind) {
    case 'line': {
      const a = P(child(node, 'start'));
      const b = P(child(node, 'end'));
      return a && b ? { layer, width, closed: false, filled: false, pts: [a, b] } : null;
    }
    case 'rect': {
      const s = xy(child(node, 'start'));
      const e = xy(child(node, 'end'));
      if (!s || !e) return null;
      const pts = [tf(s.x, s.y), tf(e.x, s.y), tf(e.x, e.y), tf(s.x, e.y)];
      return { layer, width, closed: true, filled, pts };
    }
    case 'circle': {
      const c = xy(child(node, 'center'));
      const e = xy(child(node, 'end'));
      if (!c || !e) return null;
      const r = Math.hypot(e.x - c.x, e.y - c.y);
      const pts = circlePoints(c.x, c.y, r).map((p) => tf(p.x, p.y));
      return { layer, width, closed: true, filled, pts };
    }
    case 'arc': {
      const mid = child(node, 'mid');
      let local;
      if (mid) {
        local = arcThrough(xy(child(node, 'start')), xy(mid), xy(child(node, 'end')));
      } else {
        // KiCad 5: (start = centre) (end = arc start) (angle)
        const ang = child(node, 'angle');
        local = arcFromCentre(xy(child(node, 'start')), xy(child(node, 'end')), num(ang && ang[1]));
      }
      return { layer, width, closed: false, filled: false, pts: local.map((p) => tf(p.x, p.y)) };
    }
    case 'poly': {
      const ptsNode = child(node, 'pts');
      if (!ptsNode) return null;
      const pts = collectPts(ptsNode).map((p) => tf(p.x, p.y));
      return { layer, width, closed: true, filled: filled || !fillNode, pts };
    }
    case 'curve': {
      const ptsNode = child(node, 'pts');
      if (!ptsNode) return null;
      const cp = collectPts(ptsNode);
      if (cp.length !== 4) return { layer, width, closed: false, filled: false, pts: cp.map((p) => tf(p.x, p.y)) };
      const pts = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        pts.push({
          x: u * u * u * cp[0].x + 3 * u * u * t * cp[1].x + 3 * u * t * t * cp[2].x + t * t * t * cp[3].x,
          y: u * u * u * cp[0].y + 3 * u * u * t * cp[1].y + 3 * u * t * t * cp[2].y + t * t * t * cp[3].y,
        });
      }
      return { layer, width, closed: false, filled: false, pts: pts.map((p) => tf(p.x, p.y)) };
    }
    default:
      return null;
  }
}

/** Collect (xy ..) and (arc ..) entries of a (pts ...) node into a flat point list. */
function collectPts(ptsNode) {
  const out = [];
  for (const c of ptsNode) {
    if (!isList(c)) continue;
    if (c[0] === 'xy') out.push({ x: num(c[1]), y: num(c[2]) });
    else if (c[0] === 'arc') {
      const pts = arcThrough(xy(child(c, 'start')), xy(child(c, 'mid')), xy(child(c, 'end')));
      out.push(...pts);
    }
  }
  return out;
}

const COPPER_ORDER = (name) => {
  if (name === 'F.Cu') return -1;
  if (name === 'B.Cu') return 1000;
  const m = /^In(\d+)\.Cu$/.exec(name);
  return m ? Number(m[1]) : 500;
};

/** Expand a pad/via layer list (supports `*.Cu`, `F&B.Cu`) against the board's copper layers. */
function expandLayers(list, copper) {
  const out = new Set();
  for (const l of list) {
    if (l === '*.Cu') copper.forEach((c) => out.add(c));
    else if (l === 'F&B.Cu') { out.add('F.Cu'); out.add('B.Cu'); }
    else if (l === '*.Mask') { out.add('F.Mask'); out.add('B.Mask'); }
    else out.add(l);
  }
  return [...out];
}

/** Chain loose outline segments into closed loops. */
export function chainLoops(polys, tol = 0.02) {
  const closed = [];
  const open = [];
  for (const p of polys) {
    if (p.closed) closed.push(p.pts.slice());
    else if (p.pts.length >= 2) open.push(p.pts.slice());
  }
  const near = (a, b) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
  while (open.length) {
    let chain = open.pop();
    let progressed = true;
    while (progressed && !near(chain[0], chain[chain.length - 1])) {
      progressed = false;
      const end = chain[chain.length - 1];
      for (let k = 0; k < open.length; k++) {
        const s = open[k];
        if (near(s[0], end)) chain = chain.concat(s.slice(1));
        else if (near(s[s.length - 1], end)) chain = chain.concat(s.slice(0, -1).reverse());
        else continue;
        open.splice(k, 1);
        progressed = true;
        break;
      }
    }
    if (chain.length >= 3 && near(chain[0], chain[chain.length - 1])) {
      chain.pop();
      closed.push(chain);
    }
  }
  return closed;
}

export function polygonArea(pts) {
  let a = 0;
  for (let k = 0, n = pts.length; k < n; k++) {
    const p = pts[k], q = pts[(k + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function bboxOf(points, bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }) {
  for (const p of points) {
    if (p.x < bb.minX) bb.minX = p.x;
    if (p.y < bb.minY) bb.minY = p.y;
    if (p.x > bb.maxX) bb.maxX = p.x;
    if (p.y > bb.maxY) bb.maxY = p.y;
  }
  return bb;
}

/**
 * Parse a .kicad_pcb document into a flat, render-ready board model.
 * Throws SExprError / Error with a readable message on malformed input.
 */
export function parseKiCadPcb(text) {
  const root = parseSExpr(text);
  if (head(root) !== 'kicad_pcb') throw new Error('Not a KiCad PCB file: root element is "' + head(root) + '"');

  const version = child(root, 'version');
  const generator = child(root, 'generator');
  const general = child(root, 'general');
  const thicknessNode = general && child(general, 'thickness');
  const thickness = thicknessNode ? num(thicknessNode[1], 1.6) : 1.6;

  // ── layers ──
  const layersNode = child(root, 'layers');
  const layers = [];
  if (layersNode) {
    for (const l of layersNode.slice(1)) {
      if (isList(l)) layers.push({ ordinal: num(l[0]), name: l[1], type: l[2], user: l[3] });
    }
  }
  let copperLayers = layers.filter((l) => /\.Cu$/.test(l.name)).map((l) => l.name);
  if (!copperLayers.length) copperLayers = ['F.Cu', 'B.Cu'];
  copperLayers.sort((a, b) => COPPER_ORDER(a) - COPPER_ORDER(b));

  // ── stackup (optional) ──
  const setup = child(root, 'setup');
  const stackupNode = setup && child(setup, 'stackup');
  const stackup = [];
  if (stackupNode) {
    for (const l of children(stackupNode, 'layer')) {
      const t = child(l, 'thickness');
      const type = child(l, 'type');
      const mat = child(l, 'material');
      const color = child(l, 'color');
      stackup.push({ name: l[1], type: type && type[1], thickness: t ? num(t[1]) : 0, material: mat && mat[1], color: color && color[1] });
    }
  }

  const netNodes = children(root, 'net');
  const nets = netNodes.length;
  const netNames = new Map(netNodes.map((n) => [String(n[1]), n[2] ?? '']));
  // (net 3) → "GND"; newer files may carry (net "GND") directly
  const netOf = (node) => {
    const n = child(node, 'net');
    if (!n) return null;
    if (n[2] !== undefined) return n[2] || null;
    return netNames.has(String(n[1])) ? netNames.get(String(n[1])) || null : String(n[1]);
  };
  const edge = [];
  const graphics = [];
  const tracks = [];
  const vias = [];
  const pads = [];
  const zones = [];
  const footprints = [];
  const identity = (x, y) => ({ x, y });

  for (const n of root) {
    if (!isList(n)) continue;
    const h = n[0];
    if (/^gr_(line|rect|circle|arc|poly|curve)$/.test(h)) {
      const p = graphicToPolyline(n, identity);
      if (!p) continue;
      if (p.layer === 'Edge.Cuts') edge.push(p);
      else graphics.push(p);
    } else if (h === 'segment') {
      const a = xy(child(n, 'start')), b = xy(child(n, 'end'));
      if (a && b) tracks.push({ layer: layerOf(n), width: widthOf(n), pts: [a, b], net: netOf(n) });
    } else if (h === 'arc') {
      const pts = arcThrough(xy(child(n, 'start')), xy(child(n, 'mid')), xy(child(n, 'end')), 0.3);
      tracks.push({ layer: layerOf(n), width: widthOf(n), pts, net: netOf(n) });
    } else if (h === 'via') {
      const at = xy(child(n, 'at'));
      const size = child(n, 'size');
      const drill = child(n, 'drill');
      const lnode = child(n, 'layers');
      const vl = lnode ? expandLayers(lnode.slice(1), copperLayers) : ['F.Cu', 'B.Cu'];
      const idx = vl.map((l) => copperLayers.indexOf(l)).filter((k) => k >= 0);
      const from = idx.length ? copperLayers[Math.min(...idx)] : 'F.Cu';
      const to = idx.length ? copperLayers[Math.max(...idx)] : 'B.Cu';
      const typeAtom = n.find((c) => c === 'blind' || c === 'micro');
      if (at) vias.push({ x: at.x, y: at.y, size: num(size && size[1], 0.6), drill: num(drill && drill[1], 0.3), from, to, type: typeAtom || 'through', net: netOf(n) });
    } else if (h === 'zone') {
      for (const fp of children(n, 'filled_polygon')) {
        const layer = layerOf(fp) || layerOf(n);
        const ptsNode = child(fp, 'pts');
        if (ptsNode) zones.push({ layer, pts: collectPts(ptsNode), net: netOf(n) || (child(n, 'net_name') || [])[1] || null });
      }
    } else if (h === 'footprint' || h === 'module') {
      parseFootprint(n, copperLayers, footprints, pads, graphics, edge);
    }
  }

  // ── board outline ──
  let loops = chainLoops(edge);
  let bbox;
  if (loops.length) {
    loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
    bbox = bboxOf(loops[0]);
  } else {
    bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const t of tracks) bboxOf(t.pts, bbox);
    for (const p of pads) bboxOf([{ x: p.x, y: p.y }], bbox);
    for (const f of footprints) bboxOf(f.corners, bbox);
    if (!Number.isFinite(bbox.minX)) bbox = { minX: 0, minY: 0, maxX: 50, maxY: 50 };
    const m = 2;
    bbox = { minX: bbox.minX - m, minY: bbox.minY - m, maxX: bbox.maxX + m, maxY: bbox.maxY + m };
    loops = [[{ x: bbox.minX, y: bbox.minY }, { x: bbox.maxX, y: bbox.minY }, { x: bbox.maxX, y: bbox.maxY }, { x: bbox.minX, y: bbox.maxY }]];
  }

  const widthMm = +(bbox.maxX - bbox.minX).toFixed(2);
  const heightMm = +(bbox.maxY - bbox.minY).toFixed(2);
  const hasBGA = footprints.some((f) => /BGA/i.test(f.lib)) || footprints.some((f) => f.padCount >= 64 && f.gridPads);

  return {
    version: version ? version[1] : null,
    generator: generator ? generator[1] : null,
    thickness,
    layers,
    copperLayers,
    stackup,
    outline: { outer: loops[0], holes: loops.slice(1) },
    bbox,
    tracks,
    vias,
    pads,
    zones,
    graphics,
    footprints,
    stats: {
      copperLayerCount: copperLayers.length,
      widthMm,
      heightMm,
      areaCm2: +((Math.abs(polygonArea(loops[0])) - loops.slice(1).reduce((s, l) => s + Math.abs(polygonArea(l)), 0)) / 100).toFixed(2),
      footprints: footprints.length,
      pads: pads.length,
      tracks: tracks.length,
      vias: vias.length,
      nets: Math.max(0, nets - 1),
      zones: zones.length,
      hasBGA,
      thickness,
      kicadVersion: kicadVersionLabel(version && version[1]),
    },
  };
}

function kicadVersionLabel(v) {
  const n = Number(v);
  if (!n) return 'unknown';
  if (n >= 20241229) return '9.x';
  if (n >= 20240108) return '8.x';
  if (n >= 20221018) return '7.x';
  if (n >= 20211014) return '6.x';
  return '5.x';
}

function parseFootprint(n, copperLayers, footprints, pads, graphics, edge) {
  const at = child(n, 'at');
  const fx = num(at && at[1]), fy = num(at && at[2]), frot = num(at && at[3]);
  const layer = layerOf(n) || 'F.Cu';
  const side = layer === 'B.Cu' ? 'B' : 'F';
  const tf = (x, y) => kicadTransform(x, y, fx, fy, frot);

  // reference / value (KiCad 5–7: fp_text reference; KiCad 8+: property "Reference")
  let ref = '', value = '';
  for (const t of children(n, 'fp_text')) {
    if (t[1] === 'reference') ref = t[2];
    if (t[1] === 'value') value = t[2];
  }
  for (const p of children(n, 'property')) {
    if (p[1] === 'Reference') ref = p[2];
    if (p[1] === 'Value') value = p[2];
  }

  // body extents in local coordinates, preferring the fabrication outline
  const local = { fab: [], crtyd: [], pads: [] };
  for (const g of n) {
    if (!isList(g) || !/^fp_(line|rect|circle|arc|poly|curve)$/.test(g[0])) continue;
    const lp = graphicToPolyline(g, identityTf);
    if (!lp) continue;
    if (/\.Fab$/.test(lp.layer)) local.fab.push(...lp.pts);
    else if (/\.CrtYd$/.test(lp.layer)) local.crtyd.push(...lp.pts);
    const wp = { ...lp, pts: lp.pts.map((p) => tf(p.x, p.y)) };
    if (lp.layer === 'Edge.Cuts') edge.push(wp);
    else if (/\.(SilkS|Silkscreen)$/.test(lp.layer)) graphics.push(wp);
  }

  let padCount = 0;
  const padXs = new Set();
  for (const p of children(n, 'pad')) {
    const pat = child(p, 'at');
    const px = num(pat && pat[1]), py = num(pat && pat[2]);
    // pad angle in the file already includes the footprint orientation
    const prot = pat && pat[3] !== undefined ? num(pat[3]) : frot;
    const size = child(p, 'size');
    const w = num(size && size[1], 1), hgt = num(size && size[2], w);
    const drillNode = child(p, 'drill');
    let drill = null;
    if (drillNode) {
      if (drillNode[1] === 'oval') drill = { w: num(drillNode[2]), h: num(drillNode[3], num(drillNode[2])) };
      else if (drillNode[1] !== undefined && !isList(drillNode[1])) drill = { w: num(drillNode[1]), h: num(drillNode[1]) };
      if (drill && drill.w <= 0) drill = null;
    }
    const lnode = child(p, 'layers');
    const plist = lnode ? expandLayers(lnode.slice(1), copperLayers) : [];
    const rr = child(p, 'roundrect_rratio');
    const world = tf(px, py);
    const netNode = child(p, 'net');
    pads.push({
      number: p[1],
      x: world.x,
      y: world.y,
      rot: prot,
      type: p[2],
      shape: p[3],
      w,
      h: hgt,
      rratio: rr ? num(rr[1]) : 0.25,
      drill,
      layers: plist,
      net: netNode ? netNode[2] || netNode[1] : null,
      footprint: ref,
    });
    padCount++;
    padXs.add(px.toFixed(2));
    local.pads.push({ x: px - w / 2, y: py - hgt / 2 }, { x: px + w / 2, y: py + hgt / 2 });
  }

  const src = local.fab.length ? local.fab : local.crtyd.length ? local.crtyd : local.pads;
  let bb = src.length ? bboxOf(src) : { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 };
  const corners = [
    { x: bb.minX, y: bb.minY }, { x: bb.maxX, y: bb.minY },
    { x: bb.maxX, y: bb.maxY }, { x: bb.minX, y: bb.maxY },
  ].map((p) => tf(p.x, p.y));

  const libNode = n[1];
  footprints.push({
    lib: typeof libNode === 'string' ? libNode : '',
    ref,
    value,
    x: fx,
    y: fy,
    rot: frot,
    side,
    local: bb,
    corners,
    padCount,
    gridPads: padCount >= 16 && padXs.size >= 4 && padXs.size * padXs.size >= padCount * 0.6,
    smdOnly: children(n, 'pad').every((p) => p[2] === 'smd'),
    hasModel: !!child(n, 'model'),
  });
}

function identityTf(x, y) {
  return { x, y };
}

/** Lightweight summary for quoting (no geometry arrays). */
export function summarizeKiCadPcb(text) {
  const b = parseKiCadPcb(text);
  return { ...b.stats, copperLayers: b.copperLayers };
}
