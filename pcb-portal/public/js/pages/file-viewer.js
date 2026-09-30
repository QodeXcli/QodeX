import { api } from '../app.js';
import { createViewer } from '../viewer/viewer.js';

const id = location.pathname.split('/')[3];
const target = document.getElementById('viewer');
try {
  const meta = await api(`/files/${encodeURIComponent(id)}/meta`);
  document.title = `${meta.name} · 3D view | QodeX PCB`;
  const viewer = createViewer(target, { board: meta.look });
  await viewer.loadUrl(`/api/files/${encodeURIComponent(id)}`, meta.name);
} catch (err) {
  target.textContent = err.message;
}
