/**
 * Smart work partitioning for parallel fan-out.
 *
 * Given a flat list of work items, split them into balanced, NON-OVERLAPPING
 * partitions so each can be handed to one parallel sub-agent. This is the
 * algorithm behind the `fanout` tool — the same reasoning a human uses when
 * they eyeball "204 catches in tools/, 54 in agent/…" and hand each worker a
 * roughly equal share.
 *
 * Two properties matter and both are guaranteed here:
 *
 *  1. BALANCE — partitions should have roughly equal total weight, so no single
 *     sub-agent becomes the long pole. We use Longest-Processing-Time-first
 *     (LPT) greedy bin-packing: sort units heaviest-first, drop each onto the
 *     currently-lightest partition. LPT is a classic 4/3-approximation for
 *     minimizing makespan — simple, fast, and good enough that the slowest
 *     partition is never far from optimal.
 *
 *  2. COUPLING — items that MUST be processed together (e.g. a return-type
 *     change in `git-sandbox.ts` and its caller in `loop.ts`) share a
 *     `coupledKey` and are guaranteed to land in the SAME partition. We coalesce
 *     them into a single unit (summed weight) before bin-packing, so coupling is
 *     never broken by the balancer.
 *
 * The function is PURE and DETERMINISTIC: no clock, no randomness, stable
 * tie-breaks by id and original index. Same input → same partitions, always.
 */

export interface WorkItem<T = unknown> {
  /** Stable identifier (file path, directory, task title…). Used for tie-breaks. */
  id: string;
  /** Relative cost. Non-finite or ≤0 is treated as 1. Default 1. */
  weight?: number;
  /** Items sharing a non-empty coupledKey are forced into the same partition. */
  coupledKey?: string;
  /** Arbitrary caller payload, carried through untouched. */
  payload?: T;
}

export interface Partition<T = unknown> {
  index: number;
  items: WorkItem<T>[];
  totalWeight: number;
}

export interface PartitionOptions {
  /** Hard cap on the number of partitions produced. */
  maxPartitions?: number;
  /** Upper bound from the runtime (e.g. CPU-derived concurrency). Default 16. */
  concurrencyCeiling?: number;
  /** When maxPartitions is absent, derive K so each partition ≈ this weight. */
  targetWeightPerPartition?: number;
  /** Don't over-split: keep at least this many coupling-units per partition. Default 1. */
  minUnitsPerPartition?: number;
}

/** A coupling-unit: one standalone item, or several coupled items fused together. */
interface Unit<T> {
  key: string;            // coupledKey, or the lone item's id
  weight: number;
  members: WorkItem<T>[];
  order: number;          // first-appearance index, for deterministic tie-breaks
}

function sanitizeWeight(w: number | undefined): number {
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1;
}

/** Coalesce coupled items into units, preserving first-appearance order. */
function buildUnits<T>(items: WorkItem<T>[]): Unit<T>[] {
  const byKey = new Map<string, Unit<T>>();
  const units: Unit<T>[] = [];
  items.forEach((item, i) => {
    const w = sanitizeWeight(item.weight);
    const key = item.coupledKey && item.coupledKey.length > 0 ? item.coupledKey : null;
    if (key === null) {
      units.push({ key: item.id, weight: w, members: [item], order: i });
      return;
    }
    const existing = byKey.get(key);
    if (existing) {
      existing.weight += w;
      existing.members.push(item);
    } else {
      const unit: Unit<T> = { key, weight: w, members: [item], order: i };
      byKey.set(key, unit);
      units.push(unit);
    }
  });
  return units;
}

/** Decide how many partitions to create, clamped to every relevant bound. */
function chooseK<T>(units: Unit<T>[], totalWeight: number, opts: PartitionOptions): number {
  const u = units.length;
  if (u <= 1) return u; // 0 → 0, 1 → 1
  const ceiling = Math.max(1, Math.floor(opts.concurrencyCeiling ?? 16));
  const minUnits = Math.max(1, Math.floor(opts.minUnitsPerPartition ?? 1));

  let k: number;
  if (opts.maxPartitions !== undefined) {
    k = Math.floor(opts.maxPartitions);
  } else if (opts.targetWeightPerPartition && opts.targetWeightPerPartition > 0) {
    k = Math.ceil(totalWeight / opts.targetWeightPerPartition);
  } else {
    k = ceiling; // default: spread as wide as the ceiling allows
  }

  // Never more partitions than units, than the ceiling, or than minUnits permits.
  k = Math.min(k, u, ceiling, Math.max(1, Math.floor(u / minUnits)));
  return Math.max(1, k);
}

/**
 * Partition `items` into balanced, non-overlapping groups.
 * Returns at most `min(units, ceiling, maxPartitions)` partitions, each non-empty,
 * coupled items kept together, total weight balanced via LPT.
 */
export function partitionWork<T = unknown>(
  items: WorkItem<T>[],
  opts: PartitionOptions = {},
): Partition<T>[] {
  if (!items || items.length === 0) return [];

  const units = buildUnits(items);
  const totalWeight = units.reduce((s, x) => s + x.weight, 0);
  const k = chooseK(units, totalWeight, opts);
  if (k <= 1) {
    // Single partition: keep original input order.
    const all = units.flatMap((un) => un.members);
    return [{ index: 0, items: all, totalWeight }];
  }

  // LPT: heaviest unit first; tie-break by first-appearance order then key for stability.
  const sorted = [...units].sort((a, b) =>
    b.weight - a.weight || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const bins: Array<{ weight: number; units: Unit<T>[] }> = Array.from({ length: k }, () => ({
    weight: 0,
    units: [],
  }));

  for (const unit of sorted) {
    // Assign to the currently-lightest bin; tie-break by lowest bin index.
    let best = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i]!.weight < bins[best]!.weight) best = i;
    }
    bins[best]!.units.push(unit);
    bins[best]!.weight += unit.weight;
  }

  // Flatten each bin back to items, restoring original input order within the partition.
  return bins.map((bin, index) => {
    const flat = bin.units.flatMap((un) => un.members);
    flat.sort((a, b) => items.indexOf(a) - items.indexOf(b));
    return { index, items: flat, totalWeight: bin.weight };
  });
}

/**
 * Convenience: build WorkItems from plain string ids plus optional parallel
 * weight / coupling arrays (the shape the `fanout` tool receives from the model).
 * Mismatched-length arrays are tolerated (missing entries fall back to defaults).
 */
export function toWorkItems(
  ids: string[],
  weights?: number[],
  groups?: string[],
): WorkItem<string>[] {
  return ids.map((id, i) => {
    const item: WorkItem<string> = { id, payload: id };
    const w = weights?.[i];
    if (typeof w === 'number') item.weight = w;
    const g = groups?.[i];
    if (typeof g === 'string' && g.length > 0) item.coupledKey = g;
    return item;
  });
}
