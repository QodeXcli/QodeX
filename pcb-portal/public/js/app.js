// Shared client helpers: API calls, formatting, safe DOM building.

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = { 'X-Qodex-Request': '1' };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Multipart upload with progress (fetch has no upload progress events). */
export function uploadForm(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.setRequestHeader('X-Qodex-Request', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Connection lost during upload.'));
    xhr.send(form);
  });
}

/** Tiny hyperscript: el('a', { href, class: 'x', onclick }, 'text', child). Text is never parsed as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);

let configPromise;
export function getConfig() {
  configPromise ??= api('/config');
  return configPromise;
}

/** The signed-in user embedded by the server (no extra request). */
export function currentUser() {
  try {
    return JSON.parse(document.getElementById('qx-user')?.textContent || 'null');
  } catch {
    return null;
  }
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Format integer cents as US dollars. */
export function money(cents) {
  if (cents === null || cents === undefined) return '—';
  return usd.format(cents / 100);
}

/** Format a dollar amount (quote breakdown lines). */
export function dollars(amount) {
  return usd.format(amount);
}

export function fmtDate(sqlDate, withTime = true) {
  if (!sqlDate) return '—';
  const d = new Date(sqlDate.includes('T') ? sqlDate : `${sqlDate.replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat('en-US', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function badge(status, label) {
  return el('span', { class: `badge badge--${status}` }, label || status);
}

export function toast(message, isError = false) {
  const t = el('div', { class: `toast${isError ? ' is-error' : ''}`, role: 'status' }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 4200);
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

export function fileExt(name) {
  return String(name).toLowerCase().split('.').pop();
}

const VIEWABLE = new Set(['kicad_pcb', 'glb', 'gltf', 'stl', 'obj', 'wrl']);
export function extBadge(name) {
  const ext = fileExt(name);
  return el('span', { class: `file-ext${VIEWABLE.has(ext) ? ' file-ext--3d' : ''}` }, ext.slice(0, 9));
}

/** Open a full-screen modal with the 3D viewer for an order file. */
export async function openViewerModal(file, look = {}) {
  const { createViewer } = await import('./viewer/viewer.js');
  const body = el('div', { class: 'modal__body' });
  let viewer = null;
  const close = () => {
    viewer?.dispose();
    modal.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && !document.querySelector('.qx-viewer.is-measuring, .qx-viewer.is-inspecting') && close();
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `3D view of ${file.name}` },
    el('div', { class: 'modal__box' },
      el('div', { class: 'modal__head' },
        extBadge(file.name),
        el('span', { class: 'name' }, file.name),
        el('a', { class: 'btn btn--sm', href: `/portal/files/${file.id}/view`, target: '_blank', rel: 'noopener' }, 'Open in new tab'),
        el('a', { class: 'btn btn--sm', href: `/api/files/${file.id}` }, 'Download'),
        el('button', { class: 'btn btn--sm', type: 'button', onclick: close, 'aria-label': 'Close' }, 'Close'),
      ),
      body,
    ),
  );
  document.body.append(modal);
  document.addEventListener('keydown', onKey);
  viewer = createViewer(body, { board: look });
  viewer.loadUrl(`/api/files/${file.id}`, file.name).catch(() => {});
}
