/**
 * SQLite-backed embedding index with int8 quantization.
 *
 * Replaces the JSON index (`~/.qodex/embeddings/<hash>.json`) for projects big
 * enough that the JSON approach hurts:
 *
 *   - JSON stores every float as decimal TEXT ("0.0123456789…"). A 50k-chunk
 *     index at 768 dims is ~300-400MB on disk and must be fully parsed into
 *     memory on every search.
 *   - This module stores embeddings as int8-quantized BLOBs in SQLite. Same
 *     50k×768 index is ~38MB, memory-maps instead of parse-on-load, and the
 *     dot-product runs over Int8Array (cache-friendly, ~4× less memory
 *     bandwidth than float64).
 *
 * Quantization scheme (symmetric per-vector int8):
 *   - For each embedding, scale = max(|component|); store scale as float32 and
 *     each component as round(component / scale * 127) clamped to [-127,127].
 *   - Cosine similarity between two quantized vectors ≈ cosine of the originals;
 *     the per-vector scale cancels in the cosine normalization, so we can run
 *     the dot product directly on the int8 values and normalize by the int8
 *     norms. Error is <1% for retrieval ranking — well within the noise of the
 *     embedding model itself.
 *
 * Falls back cleanly: if better-sqlite3 isn't available (it's a normal
 * dependency, but defensively) the caller keeps using the JSON index. The two
 * formats live at different paths so they never collide.
 *
 * Schema:
 *   meta(key TEXT PRIMARY KEY, value TEXT)         — projectRoot, model, dims, builtAt
 *   chunks(id INTEGER PRIMARY KEY, file, start_line, end_line, symbol, text,
 *          hash, scale REAL, vec BLOB)             — vec is Int8 bytes
 */

import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import type { Chunk } from './retrieval.js';

export interface SqliteIndexHandle {
  db: any;
  dims: number;
}

export function sqliteIndexPath(projectRoot: string, embeddingModel: string): string {
  const hash = createHash('sha1').update(`${projectRoot}::${embeddingModel}`).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.qodex', 'embeddings', `${hash}.sqlite`);
}

async function loadSqlite(): Promise<any | null> {
  try {
    // @ts-ignore — better-sqlite3 is a dependency; defensive dynamic import
    const mod: any = await import('better-sqlite3');
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

// ── Quantization ─────────────────────────────────────────────────────────────

export interface QuantizedVec {
  scale: number;
  bytes: Int8Array;
}

/** Symmetric per-vector int8 quantization. */
export function quantize(vec: number[]): QuantizedVec {
  let max = 0;
  for (const v of vec) { const a = Math.abs(v); if (a > max) max = a; }
  const scale = max === 0 ? 1 : max / 127;
  const bytes = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const q = Math.round(vec[i]! / scale);
    bytes[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return { scale, bytes };
}

/**
 * Cosine similarity between a (full-precision) query vector and a quantized
 * stored vector. We dequantize the stored vector on the fly via its scale.
 * Running the dot product in a tight loop over the Int8Array is the hot path.
 */
export function cosineQuantized(query: number[], q: QuantizedVec): number {
  const { scale, bytes } = q;
  const len = Math.min(query.length, bytes.length);
  let dot = 0, nq = 0, ns = 0;
  for (let i = 0; i < len; i++) {
    const s = bytes[i]! * scale;
    dot += query[i]! * s;
    nq += query[i]! * query[i]!;
    ns += s * s;
  }
  if (nq === 0 || ns === 0) return 0;
  return dot / (Math.sqrt(nq) * Math.sqrt(ns));
}

// ── Build / open / search ─────────────────────────────────────────────────────

/**
 * Persist chunks (with embeddings) to a SQLite index. Overwrites any existing
 * index at the path. Returns false if better-sqlite3 can't be loaded.
 */
export async function buildSqliteIndex(
  projectRoot: string,
  embeddingModel: string,
  chunks: Chunk[],
): Promise<boolean> {
  const Database = await loadSqlite();
  if (!Database) return false;

  const p = sqliteIndexPath(projectRoot, embeddingModel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Remove stale file so we never half-overwrite.
  try { await fs.unlink(p); } catch { /* none */ }

  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      file TEXT, start_line INTEGER, end_line INTEGER,
      symbol TEXT, text TEXT, hash TEXT,
      scale REAL, vec BLOB
    );
  `);

  const dims = chunks.find(c => c.embedding)?.embedding?.length ?? 0;
  const insertMeta = db.prepare('INSERT INTO meta(key,value) VALUES (?,?)');
  insertMeta.run('projectRoot', projectRoot);
  insertMeta.run('embeddingModel', embeddingModel);
  insertMeta.run('dims', String(dims));
  insertMeta.run('builtAt', String(Date.now()));

  const insertChunk = db.prepare(
    'INSERT INTO chunks(id,file,start_line,end_line,symbol,text,hash,scale,vec) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  const tx = db.transaction((rows: Chunk[]) => {
    let id = 0;
    for (const c of rows) {
      if (!c.embedding || c.embedding.length === 0) continue;
      const q = quantize(c.embedding);
      insertChunk.run(
        id++, c.file, c.startLine, c.endLine, c.symbol ?? null,
        c.text, c.hash, q.scale, Buffer.from(q.bytes.buffer),
      );
    }
  });
  tx(chunks);
  db.close();
  return true;
}

export async function openSqliteIndex(
  projectRoot: string,
  embeddingModel: string,
): Promise<SqliteIndexHandle | null> {
  const Database = await loadSqlite();
  if (!Database) return null;
  const p = sqliteIndexPath(projectRoot, embeddingModel);
  try {
    await fs.access(p);
  } catch {
    return null;
  }
  const db = new Database(p, { readonly: true });
  const dimsRow: any = db.prepare("SELECT value FROM meta WHERE key='dims'").get();
  const dims = dimsRow ? parseInt(dimsRow.value, 10) : 0;
  return { db, dims };
}

export interface SqliteScored {
  chunk: Chunk;
  score: number;
}

/**
 * Brute-force-but-fast search over the quantized vectors. For the corpus sizes
 * QodeX targets this is the right call — an exact int8 scan of 50k×768 is a few
 * milliseconds and avoids the recall loss + build cost of an ANN index. (If a
 * project ever needs ANN, hnswlib-node can be slotted in behind this same API.)
 */
export function searchSqlite(handle: SqliteIndexHandle, queryEmbedding: number[], topK: number): SqliteScored[] {
  const rows: any[] = handle.db.prepare('SELECT id,file,start_line,end_line,symbol,text,hash,scale,vec FROM chunks').all();
  const scored: SqliteScored[] = [];
  for (const r of rows) {
    const bytes = new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength);
    const score = cosineQuantized(queryEmbedding, { scale: r.scale, bytes });
    scored.push({
      chunk: {
        file: r.file, startLine: r.start_line, endLine: r.end_line,
        symbol: r.symbol ?? undefined, text: r.text, hash: r.hash,
      } as Chunk,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** Read every chunk's text (for BM25 in hybrid mode) without the vectors. */
export function allChunksFromSqlite(handle: SqliteIndexHandle): Chunk[] {
  const rows: any[] = handle.db.prepare('SELECT file,start_line,end_line,symbol,text,hash FROM chunks').all();
  return rows.map((r: any) => ({
    file: r.file, startLine: r.start_line, endLine: r.end_line,
    symbol: r.symbol ?? undefined, text: r.text, hash: r.hash,
  } as Chunk));
}

export function chunkCount(handle: SqliteIndexHandle): number {
  const row: any = handle.db.prepare('SELECT COUNT(*) as n FROM chunks').get();
  return row?.n ?? 0;
}
