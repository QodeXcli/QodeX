/**
 * Atomic, crash-safe file writes.
 *
 * A plain `fs.writeFile` opens the target with O_TRUNC and then streams bytes:
 * a crash / SIGINT / power-loss between the truncate and the final byte leaves
 * the file half-written or empty — and for config.yaml, .env, the edit journal,
 * and artifact manifests that means lost API keys, wiped settings, or corrupt
 * source files.
 *
 * `writeFileAtomic` removes that window: write the full contents to a temp file
 * in the SAME directory, fsync it, then `rename` it over the target. POSIX
 * rename is atomic on the same filesystem, so a reader/observer sees either the
 * complete old file or the complete new file — never a partial one. Keeping the
 * temp file in the target's directory also avoids EXDEV (cross-device rename).
 *
 * Durability: we fsync the temp file before rename, and (best-effort) fsync the
 * containing directory after, so the rename itself survives power loss.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

let seq = 0;

export interface AtomicWriteOptions {
  /** File mode for the created file (e.g. 0o600 for secrets). Applied at create. */
  mode?: number;
  encoding?: BufferEncoding;
  /** fsync the containing directory after rename (durable rename). Default true. */
  fsyncDir?: boolean;
}

/**
 * Write `data` to `filePath` atomically (temp + fsync + rename). On any failure
 * the temp file is cleaned up and the original target is left untouched.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${seq++}`);
  const mode = opts.mode ?? 0o644;

  let fh: fs.FileHandle | undefined;
  try {
    // 'wx' → O_CREAT|O_EXCL: the temp name is unique, so this never clobbers.
    fh = await fs.open(tmp, 'wx', mode);
    await fh.writeFile(data, { encoding: opts.encoding ?? 'utf-8' });
    await fh.sync(); // flush contents to disk before the rename
    await fh.close();
    fh = undefined;

    await fs.rename(tmp, filePath); // atomic replace

    if (opts.fsyncDir !== false) {
      // Make the directory entry (the rename) durable. Not supported on every
      // platform/fs — best-effort, never fatal.
      let dh: fs.FileHandle | undefined;
      try {
        dh = await fs.open(dir, 'r');
        await dh.sync();
      } catch {
        /* directory fsync unsupported here — acceptable */
      } finally {
        await dh?.close().catch(() => {});
      }
    }
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {}); // don't leave a turd behind
    throw err;
  }
}
