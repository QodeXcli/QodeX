/**
 * Memory injection selection (PURE) — the "Light Memory Mode" gate.
 *
 * By default QodeX injects ALL of a project's learned facts into the system prompt (`mode: 'full'`).
 * On a small local model that can blow the budget. `mode: 'lightweight'` keeps the injection cheap
 * WITHOUT losing what matters:
 *   - facts the user flagged `!important` are ALWAYS injected (no cap), and
 *   - the rest are added newest-first only until a token budget is hit; the overflow stays in the DB
 *     and loads on demand via the recall tool / `/memory`.
 *
 * The DB stays the source of truth (structure + scoping); this only decides what rides the prompt.
 * Pure + deterministic, so the budget logic is unit-tested without the agent.
 */
export type MemoryMode = 'full' | 'lightweight' | 'auto';

export interface MemorySelectOptions {
  /** 'full' injects everything; 'lightweight' caps non-important facts to a token budget. (Resolve
   *  'auto' with resolveMemoryMode before calling — this function only takes full/lightweight.) */
  mode?: 'full' | 'lightweight';
  /** Token ceiling for the non-important facts in lightweight mode. Default 2000. */
  injectMaxTokens?: number;
}

/** Below this context window, `auto` mode injects memory lightweight (a small local model). */
export const AUTO_LIGHTWEIGHT_BELOW = 48_000;

/**
 * Resolve the configured mode against the model's context window. 'auto' picks lightweight on a
 * small window (where every-fact injection would crowd out the task) and full on a roomy one. PURE.
 */
export function resolveMemoryMode(mode: MemoryMode | undefined, contextWindow: number | undefined, threshold = AUTO_LIGHTWEIGHT_BELOW): 'full' | 'lightweight' {
  if (mode === 'lightweight') return 'lightweight';
  if (mode === 'auto') return (contextWindow != null && contextWindow <= threshold) ? 'lightweight' : 'full';
  return 'full';
}

/** A fact is "important" (always injected) if it carries the `!important` marker (case-insensitive). */
export function isImportantFact(fact: string): boolean {
  return /(^|\s)!important\b/i.test(fact);
}

/** Rough token estimate — ~4 chars/token, the usual heuristic; good enough for a budget gate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Pick the facts to inject. `facts` are expected newest-first (as the store returns them).
 * In 'full' mode returns them unchanged. In 'lightweight' mode: every `!important` fact, then the
 * newest others until the token budget is exhausted — preserving the input order.
 */
export function selectInjectedFacts(facts: string[], opts: MemorySelectOptions = {}): string[] {
  if (opts.mode !== 'lightweight') return facts;
  const budget = opts.injectMaxTokens ?? 2000;
  const out: string[] = [];
  let spent = 0;
  // Important facts are always in and don't draw from the budget.
  for (const f of facts) if (isImportantFact(f)) out.push(f);
  // Fill the rest newest-first until the budget runs out, keeping the original ordering in the result.
  const kept = new Set(out);
  const filler: string[] = [];
  for (const f of facts) {
    if (kept.has(f)) continue;
    const cost = estimateTokens(f);
    if (spent + cost > budget) continue;
    spent += cost; filler.push(f); kept.add(f);
  }
  // Return in the original (newest-first) order, important + budgeted-filler interleaved as they appeared.
  return facts.filter(f => kept.has(f));
}
