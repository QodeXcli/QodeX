import { api, getConfig } from '../app.js';
import { renderOrder } from '../order-view.js';

const root = document.getElementById('app');
const code = decodeURIComponent(location.pathname.split('/').pop());
const cfg = await getConfig();

async function load() {
  try {
    const detail = await api(`/admin/orders/${encodeURIComponent(code)}`);
    document.title = `${detail.order.code} · ${detail.order.title} | QodeX admin`;
    renderOrder(root, detail, { admin: true, cfg, reload: load });
  } catch (err) {
    root.textContent = err.message;
  }
}
load();
