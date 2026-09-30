// QodeX 3D board viewer — KiCad (.kicad_pcb), glTF (.glb/.gltf), STL, OBJ, VRML (.wrl).
//
//   const v = createViewer(containerEl, { board: { maskColor: 'black', finish: 'enig' } });
//   await v.loadUrl('/api/files/abc', 'board.kicad_pcb');   // or v.loadFile(File)
//   v.dispose();
//
// Tools: inspect (hover + click to highlight a whole net), measure (two clicks),
// layer visibility, solder-mask transparency, exploded stack, auto-rotate.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { parseKiCadPcb } from './kicad-parser.js';
import { buildBoardScene } from './kicad-scene.js';

export const VIEWABLE_EXTENSIONS = ['kicad_pcb', 'glb', 'gltf', 'stl', 'obj', 'wrl'];

export function viewerKindFor(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return VIEWABLE_EXTENSIONS.includes(ext) ? ext : null;
}

const LAYER_SWATCH = { 'F.Cu': '#e0543f', 'In1.Cu': '#c9b43a', 'In2.Cu': '#3ec96a', 'In3.Cu': '#3aa7c9', 'In4.Cu': '#9b6ad6', 'B.Cu': '#3f7de0', 'F.SilkS': '#f4f4f0', 'B.SilkS': '#b8b8c8' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function createViewer(container, options = {}) {
  container.classList.add('qx-viewer');
  container.replaceChildren();

  const canvasWrap = el('div', 'qx-viewer__canvas');
  container.appendChild(canvasWrap);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: !!options.transparent });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  canvasWrap.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '3D board view');

  const scene = new THREE.Scene();
  if (!options.transparent) scene.background = new THREE.Color(options.background ?? 0x0b0d10);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  camera.position.set(60, 70, 90);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.autoRotate = !!options.autoRotate;
  controls.autoRotateSpeed = 0.8;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(1, 2, 1.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffb076, 0.45);
  rim.position.set(-1.5, 0.6, -1);
  scene.add(rim);

  const grid = new THREE.GridHelper(400, 80, 0x1f2630, 0x141820);
  grid.material.transparent = true;
  grid.material.opacity = options.hideGrid ? 0 : 0.55;
  scene.add(grid);

  // measurement graphics
  const measureGroup = new THREE.Group();
  scene.add(measureGroup);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xffb076, depthTest: false });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffb076, depthTest: false });

  // ── overlay UI ──
  const overlay = el('div', 'qx-viewer__overlay');
  const status = el('div', 'qx-viewer__status');
  const toolbar = el('div', 'qx-viewer__toolbar');
  const panel = el('div', 'qx-viewer__panel');
  const tip = el('div', 'qx-viewer__tip');
  const inspectBox = el('div', 'qx-viewer__inspect');
  const hint = el('div', 'qx-viewer__hint');
  panel.hidden = true;
  tip.hidden = true;
  inspectBox.hidden = true;
  hint.hidden = true;
  container.append(overlay, status, toolbar, panel, tip, inspectBox, hint);
  if (options.minimalUi) toolbar.hidden = true;

  let current = null; // { object, kind, board?, boardScene? }
  let fitRadius = 50;
  let disposed = false;
  let mode = 'orbit'; // orbit | inspect | measure
  const measurePts = [];

  const group = () => {
    const g = el('div', 'qx-viewer__group');
    toolbar.appendChild(g);
    return g;
  };
  function button(g, label, onClick, title) {
    const b = el('button', 'qx-viewer__btn', label);
    b.type = 'button';
    b.title = title || label;
    b.addEventListener('click', onClick);
    g.appendChild(b);
    return b;
  }
  const gView = group();
  button(gView, 'Iso', () => setView('iso'), 'Isometric view');
  button(gView, 'Top', () => setView('top'), 'Top view');
  button(gView, 'Bottom', () => setView('bottom'), 'Bottom view');
  const gTools = group();
  const inspectBtn = button(gTools, 'Inspect', () => setMode(mode === 'inspect' ? 'orbit' : 'inspect'), 'Hover to identify copper; click to highlight a net');
  const measureBtn = button(gTools, 'Measure', () => setMode(mode === 'measure' ? 'orbit' : 'measure'), 'Click two points to measure distance');
  const layersBtn = button(gTools, 'Layers', () => {
    panel.hidden = !panel.hidden;
    layersBtn.classList.toggle('is-on', !panel.hidden);
  });
  const gMisc = group();
  const spinBtn = button(gMisc, 'Rotate', () => {
    controls.autoRotate = !controls.autoRotate;
    spinBtn.classList.toggle('is-on', controls.autoRotate);
  }, 'Auto-rotate');
  spinBtn.classList.toggle('is-on', controls.autoRotate);
  button(gMisc, 'PNG', screenshot, 'Save a screenshot');
  button(gMisc, 'Full', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else container.requestFullscreen?.();
  }, 'Fullscreen');

  function setMode(m) {
    mode = m;
    inspectBtn.classList.toggle('is-on', m === 'inspect');
    measureBtn.classList.toggle('is-on', m === 'measure');
    container.classList.toggle('is-inspecting', m === 'inspect');
    container.classList.toggle('is-measuring', m === 'measure');
    tip.hidden = true;
    if (m !== 'measure') clearMeasure();
    hint.hidden = m === 'orbit';
    hint.textContent = m === 'measure' ? 'Click two points on the model · Esc to exit' : m === 'inspect' ? 'Hover to identify · click to highlight the net · Esc to clear' : '';
    if (m === 'orbit') clearSelection();
  }

  function resize() {
    const w = canvasWrap.clientWidth || 300, h = canvasWrap.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvasWrap);
  resize();

  function loop() {
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function setView(which) {
    const r = fitRadius;
    const d = (r / Math.sin((camera.fov * Math.PI) / 360)) * 1.02;
    controls.target.set(0, 0, 0);
    if (which === 'top') camera.position.set(0, d, 0.001);
    else if (which === 'bottom') camera.position.set(0, -d, 0.001);
    else camera.position.set(d * 0.42, d * 0.6, d * 0.68);
    camera.near = Math.max(0.01, d / 1000);
    camera.far = d * 20;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function frame(object) {
    const box = new THREE.Box3().setFromObject(object);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    fitRadius = Math.max(sphere.radius, 0.001);
    grid.position.y = box.min.y - fitRadius * 0.04;
    grid.scale.setScalar(Math.max(0.05, fitRadius / 20));
    setView('iso');
  }

  function clear() {
    panel.hidden = true;
    panel.replaceChildren();
    overlay.replaceChildren();
    clearSelection();
    clearMeasure();
    if (!current) return;
    scene.remove(current.object);
    current.object.traverse((o) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      mats.forEach((m) => {
        m.map?.dispose?.();
        m.dispose?.();
      });
    });
    current = null;
  }

  function setStatus(text, isError = false) {
    status.textContent = text || '';
    status.hidden = !text;
    status.classList.toggle('is-error', !!isError);
  }

  function showStats(rows) {
    const dl = el('dl');
    for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, v));
    overlay.replaceChildren(dl);
  }

  // ── picking ──
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pointerRay(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return r;
  }
  /** Surface point under the pointer: the board face for KiCad, mesh hit otherwise. */
  function surfacePoint(ev) {
    pointerRay(ev);
    if (current?.kind === 'kicad_pcb') {
      const fromBelow = camera.position.y < 0;
      const y = (fromBelow ? -1 : 1) * (current.boardScene.thickness / 2);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
      const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      return hit ? { point: hit, side: fromBelow ? 'B' : 'F' } : null;
    }
    if (!current) return null;
    const hits = raycaster.intersectObject(current.object, true);
    return hits.length ? { point: hits[0].point, object: hits[0].object } : null;
  }

  function describe(hit) {
    if (!hit) return null;
    switch (hit.kind) {
      case 'pad':
        return { title: `${hit.footprint || '?'} · pad ${hit.pad.number ?? ''}`.trim(), net: hit.net, rows: [['Type', hit.pad.type], ['Shape', hit.pad.shape], ['Size', `${hit.pad.w} × ${hit.pad.h} mm`], ...(hit.pad.drill ? [['Drill', `${hit.pad.drill.w} mm`]] : [])] };
      case 'via':
        return { title: 'Via', net: hit.net, rows: [['Size / drill', `${hit.via.size} / ${hit.via.drill} mm`], ['Span', `${hit.via.from} → ${hit.via.to}`], ['Type', hit.via.type]] };
      case 'track':
        return { title: `Track on ${hit.layer}`, net: hit.net, rows: [['Width', `${hit.track.width} mm`]] };
      case 'zone':
        return { title: `Copper pour on ${hit.layer}`, net: hit.net, rows: [] };
      case 'footprint':
        return { title: hit.fp.ref || 'Footprint', net: null, rows: [['Value', hit.fp.value || '—'], ['Footprint', (hit.fp.lib || '').split(':').pop()], ['Side', hit.fp.side === 'B' ? 'Bottom' : 'Top'], ['Pads', String(hit.fp.padCount)]] };
      default:
        return null;
    }
  }

  let hoverQueued = false;
  let lastMove = null;
  renderer.domElement.addEventListener('pointermove', (ev) => {
    lastMove = ev;
    if (hoverQueued || mode === 'orbit') return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      const e = lastMove;
      if (mode === 'measure' || !current) {
        tip.hidden = true;
        return;
      }
      const s = surfacePoint(e);
      let text = null;
      if (s && current.kind === 'kicad_pcb') {
        const b = current.boardScene.toBoard(s.point);
        const d = describe(current.boardScene.pick(b.x, b.y, s.side));
        if (d) text = [d.title, d.net ? `net ${d.net}` : null];
      } else if (s?.object) {
        text = [s.object.name || s.object.parent?.name || 'Mesh', null];
      }
      if (!text) {
        tip.hidden = true;
        return;
      }
      const r = container.getBoundingClientRect();
      tip.replaceChildren(el('b', null, text[0]));
      if (text[1]) tip.append(document.createTextNode('  '), el('i', null, text[1]));
      tip.style.left = `${e.clientX - r.left}px`;
      tip.style.top = `${e.clientY - r.top}px`;
      tip.hidden = false;
    });
  });
  renderer.domElement.addEventListener('pointerleave', () => { tip.hidden = true; });

  // distinguish clicks from orbit drags
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return;
    downAt = null;
    if (mode === 'measure') onMeasureClick(ev);
    else if (mode === 'inspect') onInspectClick(ev);
  });
  const onKey = (e) => {
    if (e.key === 'Escape' && mode !== 'orbit') setMode('orbit');
  };
  window.addEventListener('keydown', onKey);

  function clearSelection() {
    inspectBox.hidden = true;
    current?.boardScene?.clearHighlight();
  }

  function onInspectClick(ev) {
    if (!current) return;
    const s = surfacePoint(ev);
    if (!s) return clearSelection();
    if (current.kind !== 'kicad_pcb') {
      showInspect({ title: s.object?.name || 'Mesh', net: null, rows: [['Triangles', String(triCount(s.object))]] });
      return;
    }
    const b = current.boardScene.toBoard(s.point);
    const d = describe(current.boardScene.pick(b.x, b.y, s.side));
    if (!d) return clearSelection();
    current.boardScene.clearHighlight();
    const rows = [...d.rows, ['Position', `${b.x.toFixed(2)}, ${b.y.toFixed(2)}`]];
    if (d.net) {
      current.boardScene.highlightNet(d.net);
      const st = current.boardScene.netStats.get(d.net);
      if (st) rows.push(['Net pads / vias', `${st.pads} / ${st.vias}`], ['Routed length', `${st.length.toFixed(2)} mm`]);
    }
    showInspect(d, rows);
  }

  function showInspect(d, rows = d.rows) {
    const h = el('h5', null, d.net ? `Net · ${d.net}` : 'Selection');
    const close = el('button', null, '×');
    close.type = 'button';
    close.title = 'Clear selection';
    close.addEventListener('click', clearSelection);
    h.append(close);
    const dl = el('dl');
    dl.append(el('dt', null, 'Item'), el('dd', null, d.title));
    for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, v));
    inspectBox.replaceChildren(h, dl);
    inspectBox.hidden = false;
  }

  function triCount(obj) {
    const g = obj?.geometry;
    if (!g) return 0;
    return Math.round(g.index ? g.index.count / 3 : g.getAttribute('position').count / 3);
  }

  function onMeasureClick(ev) {
    const s = surfacePoint(ev);
    if (!s) return;
    if (measurePts.length === 2) clearMeasure();
    measurePts.push(s.point.clone());
    const size = fitRadius * 0.008;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), markerMat);
    dot.position.copy(s.point);
    dot.renderOrder = 20;
    measureGroup.add(dot);
    if (measurePts.length === 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(measurePts);
      const line = new THREE.Line(geo, lineMat);
      line.renderOrder = 20;
      measureGroup.add(line);
      const [a, b] = measurePts;
      let dx, dy;
      if (current?.kind === 'kicad_pcb') {
        const pa = current.boardScene.toBoard(a), pb = current.boardScene.toBoard(b);
        dx = Math.abs(pb.x - pa.x);
        dy = Math.abs(pb.y - pa.y);
      } else {
        dx = Math.abs(b.x - a.x);
        dy = Math.abs(b.z - a.z);
      }
      const dist = a.distanceTo(b);
      showInspect({ title: 'Measurement', net: null, rows: [] }, [['Distance', `${dist.toFixed(3)} mm`], ['ΔX', `${dx.toFixed(3)} mm`], ['ΔY', `${dy.toFixed(3)} mm`], ['In mils', `${(dist / 0.0254).toFixed(1)} mil`]]);
    }
  }

  function clearMeasure() {
    measurePts.length = 0;
    for (const c of [...measureGroup.children]) {
      measureGroup.remove(c);
      c.geometry?.dispose();
    }
    if (mode === 'measure') inspectBox.hidden = true;
  }

  // ── layer panel ──
  function buildKiCadPanel(bs, board) {
    panel.replaceChildren();
    panel.append(el('h4', null, 'Copper & silk'));
    const addToggle = (label, obj, checked = true, swatch) => {
      const row = el('label', 'qx-viewer__row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      obj.visible = checked;
      cb.addEventListener('change', () => { obj.visible = cb.checked; });
      row.append(cb);
      if (swatch) {
        const sw = el('span', 'qx-viewer__swatch');
        sw.style.background = swatch;
        row.append(sw);
      }
      row.append(el('span', null, label));
      panel.appendChild(row);
    };
    for (const name of [...board.copperLayers, 'F.SilkS', 'B.SilkS']) {
      const g = bs.layers.get(name);
      if (g) addToggle(name, g, true, LAYER_SWATCH[name] || '#888');
    }
    panel.append(el('h4', null, 'Assembly'));
    addToggle('Components', bs.components, bs.components.visible);

    const slider = (label, min, max, step, value, onInput) => {
      const row = el('label', 'qx-viewer__row qx-viewer__row--slider');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = value;
      input.addEventListener('input', () => onInput(parseFloat(input.value)));
      row.append(el('span', null, label), input);
      panel.appendChild(row);
      return input;
    };
    panel.append(el('h4', null, 'Stack'));
    slider('Solder-mask opacity', 0, 1, 0.01, 1, (v) => bs.setMaskOpacity(v));
    slider('Layer explode', 0, 1, 0.01, 0, (v) => bs.setExplode(v));
  }

  async function loadKiCad(text, opts = {}) {
    const board = parseKiCadPcb(text);
    const bs = buildBoardScene(board, { ...options.board, ...opts });
    scene.add(bs.object);
    current = { object: bs.object, kind: 'kicad_pcb', board, boardScene: bs };
    frame(bs.object);
    buildKiCadPanel(bs, board);
    layersBtn.hidden = false;
    inspectBtn.hidden = false;
    const s = board.stats;
    showStats([
      ['Size', `${s.widthMm} × ${s.heightMm} mm`],
      ['Copper layers', String(s.copperLayerCount)],
      ['Thickness', `${s.thickness} mm`],
      ['Footprints', String(s.footprints)],
      ['Pads', String(s.pads)],
      ['Vias', String(s.vias)],
      ['Nets', String(s.nets)],
      ['KiCad', s.kicadVersion],
    ]);
    return board;
  }

  async function loadMesh(kind, buffer) {
    let object;
    if (kind === 'glb' || kind === 'gltf') {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buffer, '', res, rej));
      object = gltf.scene || gltf.scenes?.[0];
    } else if (kind === 'stl') {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      const geo = new STLLoader().parse(buffer);
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: geo.hasAttribute('color') ? 0xffffff : 0x2f7a4c, vertexColors: geo.hasAttribute('color'), roughness: 0.5, metalness: 0.2 });
      object = new THREE.Mesh(geo, mat);
      object.rotation.x = -Math.PI / 2;
    } else if (kind === 'obj') {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      object = new OBJLoader().parse(new TextDecoder().decode(buffer));
    } else if (kind === 'wrl') {
      const { VRMLLoader } = await import('three/addons/loaders/VRMLLoader.js');
      object = new VRMLLoader().parse(new TextDecoder().decode(buffer), '');
      object.rotation.x = -Math.PI / 2; // KiCad VRML export is Z-up
    } else {
      throw new Error(`Unsupported format: ${kind}`);
    }
    const wrapper = new THREE.Group();
    wrapper.add(object);
    const box = new THREE.Box3().setFromObject(wrapper);
    object.position.sub(box.getCenter(new THREE.Vector3()));
    scene.add(wrapper);
    current = { object: wrapper, kind };
    frame(wrapper);
    layersBtn.hidden = true;
    inspectBtn.hidden = false;
    let tris = 0, meshes = 0;
    wrapper.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        tris += triCount(o);
      }
    });
    const size = box.getSize(new THREE.Vector3());
    showStats([
      ['Format', kind.toUpperCase()],
      ['Bounds', `${size.x.toFixed(1)} × ${size.z.toFixed(1)} × ${size.y.toFixed(1)}`],
      ['Meshes', String(meshes)],
      ['Triangles', tris.toLocaleString('en-US')],
    ]);
    return object;
  }

  async function loadBuffer(buffer, name, opts) {
    const kind = viewerKindFor(name);
    if (!kind) throw new Error(`This format cannot be shown in 3D: ${name}`);
    clear();
    setStatus('Building 3D model…');
    // let the status paint before heavy synchronous work
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    try {
      if (kind === 'kicad_pcb') await loadKiCad(new TextDecoder().decode(buffer), opts);
      else await loadMesh(kind, buffer);
      setStatus('');
      options.onLoad?.(current);
    } catch (err) {
      console.error(err);
      setStatus(`Could not display this file: ${err?.message || err}`, true);
      throw err;
    }
  }

  async function loadUrl(url, name, opts) {
    setStatus('Downloading…');
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      setStatus(`Download failed (HTTP ${res.status})`, true);
      throw new Error(`HTTP ${res.status}`);
    }
    return loadBuffer(await res.arrayBuffer(), name, opts);
  }

  async function loadFile(file, opts) {
    return loadBuffer(await file.arrayBuffer(), file.name, opts);
  }

  function screenshot() {
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.href = renderer.domElement.toDataURL('image/png');
    a.download = 'qodex-board.png';
    a.click();
  }

  function dispose() {
    disposed = true;
    ro.disconnect();
    window.removeEventListener('keydown', onKey);
    clear();
    controls.dispose();
    pmrem.dispose();
    renderer.dispose();
    container.replaceChildren();
  }

  layersBtn.hidden = true;
  inspectBtn.hidden = true;
  setStatus('');
  return {
    loadUrl,
    loadFile,
    loadBuffer,
    dispose,
    setView,
    setMode,
    controls,
    get current() {
      return current;
    },
    renderer,
    scene,
    camera,
  };
}
