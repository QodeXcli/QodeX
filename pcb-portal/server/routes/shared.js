import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { ALLOWED_EXTENSIONS, extensionOf, safeFileName, viewerKindOf } from '../storage.js';
import { summarizeKiCadPcb } from '../../public/js/viewer/kicad-parser.js';

export const STATUS_LABELS = {
  quote_pending: 'Awaiting quote',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid — queued',
  in_progress: 'In progress',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Multer instance writing to DATA_DIR/tmp with an extension allow-list. */
export function uploader(ctx, maxFiles = 20) {
  return multer({
    dest: ctx.storage.tmpDir,
    limits: { fileSize: ctx.config.maxUploadMb * 1024 * 1024, files: maxFiles, fields: 50, fieldSize: 256 * 1024 },
    fileFilter(_req, file, cb) {
      file.originalname = fixEncoding(file.originalname);
      const ext = extensionOf(file.originalname);
      if (!ALLOWED_EXTENSIONS.has(ext)) return cb(new HttpError(400, `File type not allowed: "${safeFileName(file.originalname)}".`));
      cb(null, true);
    },
  });
}

/** busboy reports non-ASCII filenames as latin1; recover UTF-8. */
function fixEncoding(name) {
  try {
    const utf8 = Buffer.from(name, 'latin1').toString('utf8');
    return utf8.includes('�') ? name : utf8;
  } catch {
    return name;
  }
}

/** Store uploaded files for an order, returning the inserted DB rows. */
export async function storeUploads(ctx, files, { orderId, uploaderId, source, note }) {
  const insert = ctx.db.prepare(`INSERT INTO files (id, order_id, uploader_id, source, original_name, stored_name, size, sha256, viewer_kind, note)
    VALUES (@id, @order_id, @uploader_id, @source, @original_name, @stored_name, @size, @sha256, @viewer_kind, @note)`);
  const rows = [];
  for (const f of files || []) {
    const saved = await ctx.storage.saveFromTemp(f.path, f.originalname);
    const row = {
      id: saved.id,
      order_id: orderId,
      uploader_id: uploaderId,
      source,
      original_name: safeFileName(f.originalname),
      stored_name: saved.storedName,
      size: saved.size,
      sha256: saved.sha256,
      viewer_kind: viewerKindOf(f.originalname),
      note: note || null,
    };
    insert.run(row);
    rows.push(row);
  }
  return rows;
}

export async function cleanupTemp(files) {
  for (const f of files || []) if (f.path) await fsp.rm(f.path, { force: true }).catch(() => {});
}

/** Parse the first .kicad_pcb among uploads (before they are moved). */
export async function boardMetaFromUploads(files) {
  const pcb = (files || []).find((f) => extensionOf(f.originalname) === 'kicad_pcb');
  if (!pcb || pcb.size > 80 * 1024 * 1024) return { meta: null, error: null };
  try {
    const text = await fsp.readFile(pcb.path, 'utf8');
    return { meta: summarizeKiCadPcb(text), error: null };
  } catch (err) {
    return { meta: null, error: `${safeFileName(pcb.originalname)} could not be analysed: ${err.message}` };
  }
}

export function newOrderCode() {
  const d = new Date();
  const ym = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `QX-${ym}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

export function orderDTO(o) {
  if (!o) return null;
  return {
    id: o.id,
    code: o.code,
    title: o.title,
    service: o.service,
    specs: JSON.parse(o.specs),
    boardMeta: o.board_meta ? JSON.parse(o.board_meta) : null,
    notes: o.notes,
    price: o.price,
    currency: o.currency,
    priceBreakdown: o.price_breakdown ? JSON.parse(o.price_breakdown) : null,
    priceIsManual: !!o.price_is_manual,
    status: o.status,
    statusLabel: STATUS_LABELS[o.status] || o.status,
    adminNote: o.admin_note,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    paidAt: o.paid_at,
    ...(o.customer_email ? { customer: { name: o.customer_name, email: o.customer_email, phone: o.customer_phone, company: o.customer_company } } : {}),
  };
}

export function fileDTO(f) {
  return {
    id: f.id,
    name: f.original_name,
    size: f.size,
    sha256: f.sha256,
    source: f.source,
    viewerKind: f.viewer_kind,
    note: f.note,
    createdAt: f.created_at,
  };
}

export function paymentDTO(p) {
  return { id: p.public_id, provider: p.provider, amount: p.amount, currency: p.currency, status: p.status, refId: p.ref_id, error: p.error, createdAt: p.created_at, paidAt: p.paid_at };
}

/** Full order detail (files, messages, payments, events). Admin notes are stripped for customers. */
export function orderDetail(db, order, { admin = false } = {}) {
  const files = db.prepare('SELECT * FROM files WHERE order_id = ? ORDER BY created_at, rowid').all(order.id).map(fileDTO);
  const messages = db
    .prepare('SELECT m.id, m.body, m.is_admin, m.created_at, u.name AS author FROM messages m JOIN users u ON u.id = m.user_id WHERE m.order_id = ? ORDER BY m.id')
    .all(order.id)
    .map((m) => ({ id: m.id, body: m.body, isAdmin: !!m.is_admin, author: m.author, createdAt: m.created_at }));
  const payments = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC').all(order.id).map(paymentDTO);
  const events = db
    .prepare('SELECT type, data, created_at FROM order_events WHERE order_id = ? ORDER BY id')
    .all(order.id)
    .map((e) => ({ type: e.type, data: e.data ? JSON.parse(e.data) : null, createdAt: e.created_at }));
  const dto = orderDTO(order);
  if (!admin) delete dto.adminNote;
  return { order: dto, files, messages, payments, events };
}

export function cleanText(v, max) {
  return String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
