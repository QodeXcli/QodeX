import { toast } from '../app.js';
import { createViewer, viewerKindFor } from '../viewer/viewer.js';

const mask = document.getElementById('mask');
const finish = document.getElementById('finish');
const fname = document.getElementById('fname');
const viewer = createViewer(document.getElementById('viewer'));
let lastBuffer = null;
let lastName = 'demo-board.kicad_pcb';

async function show(buffer, name) {
  lastBuffer = buffer;
  lastName = name;
  fname.textContent = name;
  await viewer.loadBuffer(buffer.slice(0), name, { maskColor: mask.value, finish: finish.value });
}

fetch('/samples/demo-board.kicad_pcb')
  .then((r) => r.arrayBuffer())
  .then((b) => show(b, 'demo-board.kicad_pcb'))
  .catch(() => {});

async function open(file) {
  if (!file) return;
  if (!viewerKindFor(file.name)) return toast('Unsupported format. Open .kicad_pcb, .glb, .gltf, .stl, .obj or .wrl.', true);
  try {
    await show(await file.arrayBuffer(), file.name);
  } catch (err) {
    toast(err.message, true);
  }
}
for (const sel of [mask, finish]) sel.addEventListener('change', () => lastBuffer && lastName.endsWith('.kicad_pcb') && show(lastBuffer, lastName).catch(() => {}));
document.getElementById('file').addEventListener('change', (e) => open(e.target.files[0]));
const drop = document.getElementById('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-drag'); });
drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('is-drag'); });
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('is-drag');
  open(e.dataTransfer.files[0]);
});
