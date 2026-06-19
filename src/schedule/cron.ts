/**
 * Tiny cron expression parser + matcher. Five fields, standard semantics:
 *   minute (0-59)  hour (0-23)  day-of-month (1-31)  month (1-12)  day-of-week (0-6, Sun=0)
 *
 * Supported syntax (per field):
 *   *                — any
 *   N                — exact value
 *   N-M              — inclusive range
 *   N,M,K            — list
 *   *​/S or N-M/S    — step
 *
 * Day-of-month and day-of-week have OR semantics when BOTH are restricted
 * (matches Vixie cron), AND when only one is restricted. This matches what
 * everyone expects from a line like `0 0 1 * 0`.
 *
 * Convenience aliases:
 *   "@hourly"  → "0 * * * *"
 *   "@daily"   → "0 0 * * *"  (a.k.a. "@midnight")
 *   "@weekly"  → "0 0 * * 0"
 *   "@monthly" → "0 0 1 * *"
 *
 * We deliberately do NOT support seconds-precision, predefined "@reboot",
 * or named months/days. Those aren't worth the complexity for an in-app
 * scheduler that ticks every minute anyway.
 */

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // dom
  [1, 12], // month
  [0, 6],  // dow
];

export interface CronExpression {
  raw: string;
  fields: Set<number>[];
}

export function parseCron(expr: string): CronExpression {
  const trimmed = expr.trim();
  const aliased = ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const parts = aliased.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expr}" — expected 5 fields, got ${parts.length}`);
  }
  const fields = parts.map((p, i) => parseField(p, FIELD_RANGES[i]!, i));
  return { raw: expr, fields };
}

function parseField(field: string, [min, max]: [number, number], idx: number): Set<number> {
  const out = new Set<number>();
  for (const segment of field.split(',')) {
    let step = 1;
    let body = segment;
    if (segment.includes('/')) {
      const [b, s] = segment.split('/');
      body = b!;
      step = parseInt(s!, 10);
      if (!Number.isFinite(step) || step <= 0) throw new Error(`Invalid step in cron field ${idx}: "${segment}"`);
    }
    let lo: number, hi: number;
    if (body === '*') {
      lo = min; hi = max;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-');
      lo = parseInt(a!, 10); hi = parseInt(b!, 10);
    } else {
      lo = hi = parseInt(body, 10);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error(`Invalid cron field ${idx}: "${segment}"`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`Cron field ${idx} out of range [${min},${max}]: "${segment}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Does the given Date match the cron expression at minute precision? */
export function matches(cron: CronExpression, when: Date): boolean {
  const [min, hr, dom, mon, dow] = cron.fields;
  if (!min!.has(when.getMinutes())) return false;
  if (!hr!.has(when.getHours())) return false;
  if (!mon!.has(when.getMonth() + 1)) return false;
  // dom/dow OR semantics: if both are restricted, match if EITHER matches.
  // "Restricted" means the set is not the full range.
  const domFull = dom!.size === (FIELD_RANGES[2]![1] - FIELD_RANGES[2]![0] + 1);
  const dowFull = dow!.size === (FIELD_RANGES[4]![1] - FIELD_RANGES[4]![0] + 1);
  const domMatch = dom!.has(when.getDate());
  const dowMatch = dow!.has(when.getDay());
  if (domFull && dowFull) return true;
  if (domFull) return dowMatch;
  if (dowFull) return domMatch;
  return domMatch || dowMatch;
}

/**
 * Compute the next matching Date strictly after `after`. Walks minute by minute
 * up to a 2-year horizon — adequate for cron, and bounded so a malformed
 * expression can't lock the scheduler.
 */
export function nextAfter(cron: CronExpression, after: Date): Date | null {
  const limit = 60 * 24 * 366 * 2;
  const probe = new Date(after.getTime());
  // Round up to next minute boundary so we don't yield `after` itself.
  probe.setSeconds(0, 0);
  probe.setMinutes(probe.getMinutes() + 1);
  for (let i = 0; i < limit; i++) {
    if (matches(cron, probe)) return probe;
    probe.setMinutes(probe.getMinutes() + 1);
  }
  return null;
}
