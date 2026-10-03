/**
 * Suite registry — the lookup a CLI/runner uses to name a suite instead of importing it.
 *
 * `harness` is layer (a): free, offline, deterministic, no LLM. It is the DEFAULT for a
 * reason — a run of it costs nothing and takes seconds, so there is no excuse for a
 * harness change to land unmeasured.
 */

import type { EvalSuite } from '../types.js';
import { createHarnessSuite } from './harness.js';

export interface SuiteEntry {
  name: string;
  /** `false` when running it needs a real model (and therefore money + noise). */
  free: boolean;
  description: string;
  build(): EvalSuite;
}

export const SUITES: SuiteEntry[] = [
  {
    name: 'harness',
    free: true,
    description:
      'Deterministic harness assertions — tool surface, system prompt, cache layout, ' +
      'history invariants and recovery detectors. No LLM, no network, no cost.',
    build: () => createHarnessSuite(),
  },
];

export function listSuites(): SuiteEntry[] {
  return SUITES.slice();
}

/** Build a suite by name. Returns null for an unknown name — callers report it honestly. */
export function getSuite(name: string): EvalSuite | null {
  return SUITES.find(s => s.name === name)?.build() ?? null;
}

export {
  createHarnessSuite, harnessSuite, realProbes,
  DEFAULT_BUDGETS, CONTRADICTION_PAIRS, GATING_SCENARIOS,
} from './harness.js';
export type {
  ContradictionPair, GatingScenario, HarnessBudgets, HarnessProbes,
  HarnessSuiteOptions, PruneProbe,
} from './harness.js';
