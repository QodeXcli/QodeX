/**
 * $.store — a JSON key-value store per mod, kept between sessions in
 * ~/.qodex/mods-store/<name>.json (4 MiB of JSON in total). Writes are atomic
 * (temp file + rename) and serialized per mod, so two quick set() calls never interleave
 * and a crash never leaves half a file. Several QodeX processes share the file: the
 * last writer wins for the whole document (reads re-load it when it changed on disk).
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { modsStoreDir } from './paths.js';
import { MOD_LIMITS } from './types.js';

interface Doc { data: Record<string, unknown>; mtimeMs: number }

const cache = new Map<string, Doc>();
const queues = new Map<string, Promise<unknown>>();

export function modStoreFile(name: string): string {
  return path.join(modsStoreDir(), `${name}.json`);
}

async function load(name: string): Promise<Doc> {
  const file = modStoreFile(name);
  let mtimeMs = 0;
  try { mtimeMs = (await fs.stat(file)).mtimeMs; } catch { /* no file yet */ }
  const cached = cache.get(name);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  let data: Record<string, unknown> = {};
  if (mtimeMs) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch { /* a corrupt store reads as empty; the next set() rewrites it */ }
  }
  const doc = { data, mtimeMs };
  cache.set(name, doc);
  return doc;
}

/** Serialize work on one mod's store. */
function queued<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(name) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(name, run.catch(() => undefined));
  return run;
}

async function save(name: string, data: Record<string, unknown>): Promise<void> {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, 'utf-8') > MOD_LIMITS.storeBytes) {
    throw new Error(`$.store of ${name} would exceed ${MOD_LIMITS.storeBytes} bytes`);
  }
  await fs.mkdir(modsStoreDir(), { recursive: true });
  const file = modStoreFile(name);
  await writeFileAtomic(file, text, { fsyncDir: false });
  let mtimeMs = 0;
  try { mtimeMs = (await fs.stat(file)).mtimeMs; } catch { /* */ }
  cache.set(name, { data, mtimeMs });
}

function jsonValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error(`$.store.set("${key}"): the value is not JSON`);
  }
}

export function createModStore(name: string): ModStoreApi {
  return {
    get: (key) => queued(name, async () => {
      const doc = await load(name);
      const v = doc.data[String(key)];
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    }),
    set: (key, value) => queued(name, async () => {
      const v = jsonValue(String(key), value);
      const doc = await load(name);
      const data = { ...doc.data };
      if (v === undefined) delete data[String(key)];
      else data[String(key)] = v;
      await save(name, data);
    }),
    delete: (key) => queued(name, async () => {
      const doc = await load(name);
      if (!(String(key) in doc.data)) return;
      const data = { ...doc.data };
      delete data[String(key)];
      await save(name, data);
    }),
    keys: () => queued(name, async () => Object.keys((await load(name)).data)),
  };
}

export interface ModStoreApi {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Tests: forget cached documents. */
export function resetModStoreCacheForTesting(): void {
  cache.clear();
  queues.clear();
}
