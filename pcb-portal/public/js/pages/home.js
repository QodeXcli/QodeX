import { createViewer } from '../viewer/viewer.js';

// ── hero: live render of the demo board ──
const hero = createViewer(document.getElementById('hero-viewer'), {
  autoRotate: true,
  transparent: true,
  hideGrid: true,
  board: { maskColor: 'green', finish: 'enig' },
  onLoad(current) {
    if (current?.kind !== 'kicad_pcb') return;
    const s = current.board.stats;
    let length = 0;
    for (const v of current.boardScene.netStats.values()) length += v.length;
    animateTo('nets', s.nets);
    animateTo('pads', s.pads);
    animateTo('vias', s.vias);
    animateTo('length', Math.round(length));
  },
});
hero.loadUrl('/samples/demo-board.kicad_pcb', 'demo-board.kicad_pcb').catch(() => {});

function animateTo(key, target) {
  const dd = document.querySelector(`#telemetry [data-k="${key}"]`);
  if (!dd) return;
  const unit = dd.querySelector('small');
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / 1100);
    const v = Math.round(target * (1 - Math.pow(1 - t, 3)));
    dd.textContent = v.toLocaleString('en-US');
    if (unit) dd.append(unit);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── studio teaser: second view, lazily created ──
const teaser = document.getElementById('studio-teaser');
new IntersectionObserver((entries, io) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  io.disconnect();
  const v = createViewer(teaser, { board: { maskColor: 'matte_black', finish: 'enig' } });
  v.loadUrl('/samples/demo-board.kicad_pcb', 'demo-board.kicad_pcb').then(() => v.setView('top')).catch(() => {});
}).observe(teaser);

// ── before / after DFM comparison (procedural 2D drawing) ──
const box = document.getElementById('compare');
const before = document.getElementById('compare-before');
const after = document.getElementById('compare-after-canvas');
const afterWrap = document.getElementById('compare-after');
const handle = document.getElementById('compare-handle');

function drawBoard(canvas, polished) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = box.clientWidth, h = box.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = polished ? '#0f2a1b' : '#1a1f16';
  c.fillRect(0, 0, w, h);
  // fine grid
  c.strokeStyle = 'rgba(255,255,255,0.035)';
  c.lineWidth = 1;
  for (let x = 0; x < w; x += 20) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  for (let y = 0; y < h; y += 20) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }

  const s = Math.min(w / 640, h / 400);
  const X = (v) => v * s + (w - 640 * s) / 2;
  const Y = (v) => v * s + (h - 400 * s) / 2;
  const copper = polished ? '#d99a55' : '#b7793f';
  const traps = [];

  // IC body + pads
  c.fillStyle = '#16171a';
  c.fillRect(X(70), Y(110), 150 * s, 180 * s);
  const pins = [];
  for (let i = 0; i < 8; i++) pins.push({ x: 220, y: 130 + i * 20 });
  // connector pads on the right
  const conn = [];
  for (let i = 0; i < 8; i++) conn.push({ x: 560, y: 70 + i * 36 });

  c.lineCap = polished ? 'round' : 'butt';
  c.lineJoin = polished ? 'round' : 'miter';
  c.strokeStyle = copper;
  c.lineWidth = 7 * s;
  pins.forEach((p, i) => {
    const q = conn[i];
    const midX = 300 + i * 22;
    c.beginPath();
    c.moveTo(X(p.x), Y(p.y));
    if (!polished) {
      // right-angle dog-legs
      c.lineTo(X(midX), Y(p.y));
      c.lineTo(X(midX), Y(q.y));
      c.lineTo(X(q.x), Y(q.y));
      traps.push([midX, p.y], [midX, q.y]);
    } else {
      // 45° mitred path
      const dy = q.y - p.y;
      const run = Math.abs(dy);
      const x1 = midX - run / 2;
      c.lineTo(X(Math.max(p.x + 10, x1)), Y(p.y));
      c.lineTo(X(Math.max(p.x + 10, x1) + run), Y(q.y));
      c.lineTo(X(q.x), Y(q.y));
    }
    c.stroke();
  });
  // a branching net: acute T-junction (acid trap) vs. clean perpendicular entry
  c.beginPath();
  if (!polished) {
    c.moveTo(X(420), Y(360));
    c.lineTo(X(470), Y(340));
    c.moveTo(X(420), Y(360));
    c.lineTo(X(600), Y(360));
    traps.push([432, 356]);
  } else {
    c.moveTo(X(420), Y(360));
    c.lineTo(X(600), Y(360));
    c.moveTo(X(470), Y(360));
    c.quadraticCurveTo(X(470), Y(345), X(485), Y(340));
  }
  c.stroke();

  // pads (+ teardrops when polished)
  c.fillStyle = polished ? '#e7c07a' : '#c49a5c';
  for (const p of pins) {
    c.fillRect(X(p.x - 8), Y(p.y - 5), 16 * s, 10 * s);
    if (polished) teardrop(c, X(p.x + 8), Y(p.y), 16 * s, 7 * s, copper);
  }
  for (const q of conn) {
    c.beginPath();
    c.arc(X(q.x), Y(q.y), 11 * s, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#0b0d10';
    c.beginPath();
    c.arc(X(q.x), Y(q.y), 4.5 * s, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = polished ? '#e7c07a' : '#c49a5c';
    if (polished) teardrop(c, X(q.x - 10), Y(q.y), -16 * s, 7 * s, copper);
  }
  // DRC markers
  if (!polished) {
    c.strokeStyle = '#e5484d';
    c.lineWidth = 1.6;
    c.setLineDash([4, 3]);
    for (const [x, y] of traps.slice(0, 7)) {
      c.beginPath();
      c.arc(X(x), Y(y), 12 * s, 0, Math.PI * 2);
      c.stroke();
    }
    c.setLineDash([]);
  } else {
    c.fillStyle = 'rgba(51, 209, 122, 0.9)';
    c.font = `${12 * s}px "Geist Mono", monospace`;
    c.fillText('DRC 0 · DFM 0', X(26), Y(385));
  }
}

function teardrop(c, x, y, len, half, color) {
  c.save();
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(x, y - half);
  c.quadraticCurveTo(x + len * 0.35, y - half * 0.2, x + len, y);
  c.quadraticCurveTo(x + len * 0.35, y + half * 0.2, x, y + half);
  c.closePath();
  c.fill();
  c.restore();
}

function redraw() {
  drawBoard(before, false);
  drawBoard(after, true);
}
function setSplit(frac) {
  const f = Math.max(0.02, Math.min(0.98, frac));
  afterWrap.style.clipPath = `inset(0 0 0 ${f * 100}%)`;
  handle.style.left = `${f * 100}%`;
  box.setAttribute('aria-valuenow', String(Math.round(f * 100)));
}
let dragging = false;
const fromEvent = (e) => {
  const r = box.getBoundingClientRect();
  setSplit((e.clientX - r.left) / r.width);
};
box.addEventListener('pointerdown', (e) => { dragging = true; box.setPointerCapture(e.pointerId); fromEvent(e); });
box.addEventListener('pointermove', (e) => dragging && fromEvent(e));
box.addEventListener('pointerup', () => { dragging = false; });
box.addEventListener('keydown', (e) => {
  const now = Number(box.getAttribute('aria-valuenow')) / 100;
  if (e.key === 'ArrowLeft') setSplit(now - 0.05);
  if (e.key === 'ArrowRight') setSplit(now + 0.05);
});
new ResizeObserver(redraw).observe(box);
redraw();
setSplit(0.5);
