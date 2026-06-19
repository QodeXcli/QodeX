/**
 * Tool result cache (within a single turn).
 *
 * If the agent calls `read_file path="X"` twice in the same turn (often
 * happens when it does an analysis pass and then re-reads to edit), the
 * second call returns the cached result instead of re-reading from disk.
 *
 * Scope: per turn. Reset between turns so the agent sees fresh state if
 * something on disk changed (which can happen via bash or external tools).
 *
 * Eligibility: only READ-ONLY tools. We never cache mutating tools.
 *
 * Cache key: `toolName + JSON(sortedArgs)`. Args are sorted by key to make
 * `{a:1, b:2}` and `{b:2, a:1}` hit the same entry.
 *
 * Memory bound: max 100 entries per turn, max 1MB per entry, max 10MB total.
 */

interface CacheEntry {
  result: string;
  size: number;
  hits: number;
}

export class ToolResultCache {
  private cache = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private readonly maxEntries = 100;
  private readonly maxBytesPerEntry = 1_048_576;
  private readonly maxTotalBytes = 10_485_760;
  private hits = 0;
  private misses = 0;

  private keyFor(toolName: string, args: any): string {
    if (args === null || args === undefined) return toolName;
    if (typeof args !== 'object') return `${toolName}:${String(args)}`;
    const sortedKeys = Object.keys(args).sort();
    const ordered: any = {};
    for (const k of sortedKeys) ordered[k] = args[k];
    return `${toolName}:${JSON.stringify(ordered)}`;
  }

  get(toolName: string, args: any): string | null {
    const key = this.keyFor(toolName, args);
    const entry = this.cache.get(key);
    if (entry) {
      entry.hits++;
      this.hits++;
      return entry.result;
    }
    this.misses++;
    return null;
  }

  set(toolName: string, args: any, result: string): void {
    if (typeof result !== 'string') return;
    const size = result.length;
    if (size > this.maxBytesPerEntry) return;
    if (this.totalBytes + size > this.maxTotalBytes) this.evictOldest();
    if (this.cache.size >= this.maxEntries) this.evictOldest();
    const key = this.keyFor(toolName, args);
    this.cache.set(key, { result, size, hits: 0 });
    this.totalBytes += size;
  }

  private evictOldest(): void {
    const first = this.cache.keys().next();
    if (!first.done) {
      const entry = this.cache.get(first.value);
      if (entry) this.totalBytes -= entry.size;
      this.cache.delete(first.value);
    }
  }

  reset(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }

  stats(): { entries: number; bytes: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      bytes: this.totalBytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }
}
