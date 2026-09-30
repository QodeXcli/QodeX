// Private file storage for order attachments. Files live under DATA_DIR/files
// with random names and are only ever served through the authorised
// /api/files/:id route — never from a static directory.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, promises as fsp } from 'node:fs';
import { extname, join } from 'node:path';

export const ALLOWED_EXTENSIONS = new Set([
  // KiCad project
  'kicad_pcb', 'kicad_pro', 'kicad_sch', 'kicad_prl', 'kicad_dru', 'kicad_sym', 'kicad_mod', 'net',
  // 3D
  'glb', 'gltf', 'stl', 'obj', 'wrl', 'step', 'stp',
  // fabrication outputs
  'gbr', 'gtl', 'gbl', 'gto', 'gbo', 'gts', 'gbs', 'gtp', 'gbp', 'gko', 'gm1', 'g1', 'g2', 'g3', 'g4', 'drl', 'xln', 'ipc', 'pos', 'csv',
  // archives & documents
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'md', 'json', 'xlsx', 'xls', 'ods', 'html',
]);

export const VIEWER_KINDS = new Set(['kicad_pcb', 'glb', 'gltf', 'stl', 'obj', 'wrl']);

export function extensionOf(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'gz';
  return extname(lower).slice(1);
}

export function viewerKindOf(name) {
  const ext = extensionOf(name);
  return VIEWER_KINDS.has(ext) ? ext : null;
}

/** Strip path components and control characters; keep unicode (Persian names). */
export function safeFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'file').slice(0, 180);
}

export function createStorage(dataDir) {
  const dir = join(dataDir, 'files');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dataDir, 'tmp'), { recursive: true });
  return {
    dir,
    tmpDir: join(dataDir, 'tmp'),
    /** Move a multer temp upload into storage; returns stored metadata. */
    async saveFromTemp(tmpPath, originalName) {
      const id = randomBytes(16).toString('hex');
      const ext = extensionOf(originalName);
      const storedName = `${id}${ext ? '.' + ext : ''}`;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(tmpPath)) hash.update(chunk);
      const { size } = await fsp.stat(tmpPath);
      await fsp.rename(tmpPath, join(dir, storedName));
      return { id, storedName, size, sha256: hash.digest('hex') };
    },
    path(storedName) {
      return join(dir, storedName);
    },
    stream(storedName) {
      return createReadStream(join(dir, storedName));
    },
    async remove(storedName) {
      await fsp.rm(join(dir, storedName), { force: true });
    },
  };
}
