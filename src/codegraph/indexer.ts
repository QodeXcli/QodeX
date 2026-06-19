import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CodeGraphDB } from './schema.js';
import { extractSymbols } from './extractor.js';
import { detectLanguage } from '../tools/ast/parser.js';
import { isBinaryBuffer } from '../utils/binary.js';
import { logger } from '../utils/logger.js';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'target', 'vendor', '.gradle', '.dart_tool',
  '.venv', 'venv', 'env',
  'coverage', '.nyc_output',
  '.qodex',
]);

const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB — anything bigger is unlikely to be hand-written code

export interface IndexerOptions {
  /** Force re-index every file, ignoring mtime/hash cache. */
  force?: boolean;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Called periodically with progress info. */
  onProgress?: (info: { processed: number; total: number; currentFile?: string }) => void;
}

export interface IndexResult {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesRemoved: number;
  symbolCount: number;
  durationMs: number;
}

export class Indexer {
  constructor(private db: CodeGraphDB, private rootDir: string) {}

  async indexAll(opts: IndexerOptions = {}): Promise<IndexResult> {
    const start = Date.now();
    const filesOnDisk = new Set<string>();
    const candidates: string[] = [];

    await this.walk(this.rootDir, (file) => {
      filesOnDisk.add(file);
      candidates.push(file);
    });

    let scanned = 0;
    let indexed = 0;
    let skipped = 0;
    let totalSymbols = 0;
    const total = candidates.length;

    for (const filePath of candidates) {
      if (opts.signal?.aborted) {
        logger.info('Indexing cancelled by signal');
        break;
      }
      scanned++;
      opts.onProgress?.({ processed: scanned, total, currentFile: path.relative(this.rootDir, filePath) });

      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > MAX_FILE_SIZE) {
          skipped++;
          continue;
        }
        const lang = detectLanguage(filePath);
        if (!lang) {
          skipped++;
          continue;
        }

        // Quick skip: same mtime+size means content unchanged
        if (!opts.force && this.db.isFileFresh(filePath, stat.mtimeMs, stat.size, null)) {
          skipped++;
          continue;
        }

        // Read content + check binary
        const buf = await fs.readFile(filePath);
        if (isBinaryBuffer(buf)) {
          skipped++;
          continue;
        }
        const contentHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

        // Re-check freshness with hash now that we have it
        if (!opts.force && this.db.isFileFresh(filePath, stat.mtimeMs, stat.size, contentHash)) {
          skipped++;
          continue;
        }

        const source = buf.toString('utf-8');
        const symbols = await extractSymbols(filePath, source);

        this.db.replaceFileSymbols(
          filePath,
          lang,
          stat.mtimeMs,
          stat.size,
          contentHash,
          symbols,
        );
        indexed++;
        totalSymbols += symbols.length;
      } catch (e: any) {
        logger.debug('Indexer: skipping file due to error', { filePath, err: e.message });
        skipped++;
      }
    }

    // Remove DB entries for files no longer on disk
    let removed = 0;
    const dbFiles = this.db.db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>;
    for (const row of dbFiles) {
      if (!filesOnDisk.has(row.path)) {
        this.db.removeFile(row.path);
        removed++;
      }
    }

    this.db.setMeta('last_full_index', new Date().toISOString());

    const duration = Date.now() - start;
    logger.info('Indexing complete', { scanned, indexed, skipped, removed, symbols: totalSymbols, durationMs: duration });

    return {
      filesScanned: scanned,
      filesIndexed: indexed,
      filesSkipped: skipped,
      filesRemoved: removed,
      symbolCount: totalSymbols,
      durationMs: duration,
    };
  }

  /** Index just a single file (used for live updates after a write_file). */
  async indexFile(filePath: string): Promise<{ symbols: number } | null> {
    try {
      const stat = await fs.stat(filePath);
      const lang = detectLanguage(filePath);
      if (!lang || stat.size > MAX_FILE_SIZE) return null;
      const buf = await fs.readFile(filePath);
      if (isBinaryBuffer(buf)) return null;
      const contentHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
      const source = buf.toString('utf-8');
      const symbols = await extractSymbols(filePath, source);
      this.db.replaceFileSymbols(filePath, lang, stat.mtimeMs, stat.size, contentHash, symbols);
      return { symbols: symbols.length };
    } catch (e: any) {
      logger.debug('indexFile failed', { filePath, err: e.message });
      return null;
    }
  }

  private async walk(dir: string, onFile: (path: string) => void): Promise<void> {
    let entries: any[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') {
        // Allow .qodex through? no — it's in IGNORED_DIRS
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await this.walk(path.join(dir, entry.name), onFile);
      } else if (entry.isFile()) {
        // Only consider files we can actually extract symbols from. This keeps
        // non-source files (e.g. a sibling codegraph.db / .db-wal / .db-shm, lock
        // files, images) out of the scanned/skipped counts and off the removal scan.
        const full = path.join(dir, entry.name);
        if (detectLanguage(full)) onFile(full);
      }
    }
  }
}
