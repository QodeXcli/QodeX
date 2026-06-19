/**
 * Speculative-decoding orchestration.
 *
 * IMPORTANT — what this is and isn't:
 *
 * The actual speculative decoding (draft model proposes tokens, target model
 * verifies in parallel, accepts the matching prefix) happens INSIDE the
 * inference engine — MLX or llama.cpp in LM Studio, or Ollama's runner. A chat
 * client like QodeX cannot reimplement it: it has no access to per-token logits
 * or the accept/reject step, only the streamed text. Anyone claiming to do
 * "client-side speculative decoding" over an HTTP streaming API is mistaken.
 *
 * What QodeX CAN add — and what this module is — is the ORCHESTRATION the engine
 * doesn't do for you:
 *
 *   1. Auto-pick a compatible draft model from the same family as the target,
 *      so the user doesn't have to know that qwen3-coder-30b pairs with
 *      qwen3-coder-0.5b. A mismatched-vocabulary pair silently fails or slows
 *      down; we only suggest within-family pairs.
 *
 *   2. Measure realized acceptance / throughput. The engine gives us
 *      tokens-and-latency in the usage stream; from consecutive turns we can
 *      estimate whether spec decoding is actually HELPING. Per LM Studio's own
 *      docs, a low acceptance rate makes generation SLOWER, not faster — so a
 *      blind `draft_model` flag can backfire. We track tok/s with and without
 *      the draft and surface a warning when it regresses.
 *
 *   3. Recommend the lookahead depth (number of draft tokens) based on task:
 *      high for code (very predictable — closing braces, imports, boilerplate
 *      repeat verbatim, so acceptance is high), low for prose.
 *
 * The draft-model selection is heuristic over the model id string (families
 * encode size in the name). It's deliberately conservative: when unsure, return
 * null and let the user configure `draftModel` explicitly.
 */

import { logger } from '../utils/logger.js';

/** Known draft↔target family rules. Each: a matcher on the target id and the
 *  preferred small sibling substrings, largest-acceptable first. */
interface FamilyRule {
  family: string;
  /** target id matches this (case-insensitive substring or regex). */
  match: RegExp;
  /** candidate draft id fragments, smallest/fastest first. */
  draftHints: string[];
}

const FAMILY_RULES: FamilyRule[] = [
  // Qwen 2.5 / 3 coder — the user's stack. 0.5B/1.5B drafts pair with the big coder.
  { family: 'qwen-coder', match: /qwen.*coder|qwen3.*coder|qwen2\.5.*coder/i, draftHints: ['0.5b', '1.5b', '3b'] },
  { family: 'qwen', match: /qwen3|qwen2\.5|qwen2/i, draftHints: ['0.5b', '1.5b'] },
  { family: 'llama', match: /llama.?3|llama-3/i, draftHints: ['1b', '3b'] },
  { family: 'deepseek-coder', match: /deepseek.*coder/i, draftHints: ['1.3b', '1.5b'] },
  { family: 'codestral', match: /codestral|mistral/i, draftHints: ['mamba', '7b'] },
  { family: 'gemma', match: /gemma.?2|gemma-2/i, draftHints: ['2b'] },
];

export interface DraftSuggestion {
  family: string;
  /** Hints to look for among locally available models, smallest first. */
  draftHints: string[];
  reason: string;
}

/**
 * Suggest a draft-model family for a target model id. Returns null if the
 * target is unknown (no safe pairing) — caller should not force a draft then.
 */
export function suggestDraftFamily(targetModelId: string): DraftSuggestion | null {
  for (const rule of FAMILY_RULES) {
    if (rule.match.test(targetModelId)) {
      return {
        family: rule.family,
        draftHints: rule.draftHints,
        reason: `${targetModelId} is in the ${rule.family} family; a same-family model containing one of [${rule.draftHints.join(', ')}] makes a compatible (shared-vocabulary) draft.`,
      };
    }
  }
  return null;
}

/**
 * Given the target id and a list of locally-available model ids, pick the best
 * draft: same family, smallest size hint present, and NOT the target itself.
 * Returns null when nothing compatible is available.
 */
export function pickDraftModel(targetModelId: string, availableModelIds: string[]): string | null {
  const suggestion = suggestDraftFamily(targetModelId);
  if (!suggestion) return null;

  const lowerTarget = targetModelId.toLowerCase();
  // For each size hint (smallest first), find a same-family model that contains it.
  for (const hint of suggestion.draftHints) {
    for (const id of availableModelIds) {
      const lower = id.toLowerCase();
      if (lower === lowerTarget) continue; // never the target itself
      // Must share the family root and contain the size hint.
      const familyRule = FAMILY_RULES.find(r => r.family === suggestion.family)!;
      if (familyRule.match.test(id) && lower.includes(hint)) {
        logger.info('Auto-selected draft model', { target: targetModelId, draft: id, family: suggestion.family });
        return id;
      }
    }
  }
  return null;
}

/**
 * Recommended draft lookahead (number of speculative tokens per step) by task.
 * Code is highly predictable — long runs of tokens (braces, imports, repeated
 * identifiers) are accepted verbatim — so a deeper window pays off. Prose is
 * less predictable; a shallow window avoids wasted draft compute.
 */
export function recommendedLookahead(taskClass: string): number {
  switch (taskClass) {
    case 'code-generation':
    case 'refactor':
    case 'feature':
      return 5; // code: deep window, high acceptance
    case 'debug':
    case 'review':
      return 4;
    case 'explain':
    case 'general':
      return 3; // prose-ish: shallow
    default:
      return 4;
  }
}

/**
 * Rolling throughput tracker to detect when speculative decoding is actually
 * regressing performance (acceptance too low). Feed it (outputTokens, latencyMs)
 * per turn, tagged with whether a draft was active; it compares the medians.
 */
export class SpecDecodeMonitor {
  private withDraft: number[] = [];
  private withoutDraft: number[] = [];
  private warned = false;

  record(outputTokens: number, latencyMs: number, draftActive: boolean): void {
    if (outputTokens <= 0 || latencyMs <= 0) return;
    const tps = (outputTokens / latencyMs) * 1000;
    const arr = draftActive ? this.withDraft : this.withoutDraft;
    arr.push(tps);
    if (arr.length > 20) arr.shift(); // rolling window
  }

  private median(arr: number[]): number | null {
    if (arr.length < 3) return null; // need a few samples
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }

  /**
   * Returns a warning string if speculative decoding appears to be HURTING
   * throughput (draft-on median meaningfully below draft-off median), else null.
   * Warns at most once per session to avoid nagging.
   */
  checkRegression(): string | null {
    if (this.warned) return null;
    const on = this.median(this.withDraft);
    const off = this.median(this.withoutDraft);
    if (on === null || off === null) return null;
    // 10% slower with the draft on → it's not helping for this workload.
    if (on < off * 0.9) {
      this.warned = true;
      return `Speculative decoding looks counterproductive here: ~${on.toFixed(1)} tok/s with the draft vs ~${off.toFixed(1)} without. ` +
        `Acceptance is likely low for this task. Consider a smaller/faster draft model, or disable it.`;
    }
    return null;
  }

  stats(): { withDraftTps: number | null; withoutDraftTps: number | null } {
    return { withDraftTps: this.median(this.withDraft), withoutDraftTps: this.median(this.withoutDraft) };
  }
}

/**
 * Adaptive lookahead controller (AIMD — additive-increase / multiplicative-
 * decrease, the control law behind TCP congestion control).
 *
 * The draft window (how many tokens the draft proposes per step) has a sweet
 * spot that's workload-dependent: too shallow wastes the draft's potential, too
 * deep wastes compute on tokens the target rejects. We don't have per-token
 * acceptance from an HTTP API, but we DO have throughput per turn — so we treat
 * throughput as the reward signal and adjust the window to climb it:
 *
 *   - After a turn whose throughput IMPROVED vs the running baseline → the
 *     current window is paying off → nudge it UP by 1 (additive increase).
 *   - After a turn that REGRESSED → the window is too deep for this workload →
 *     cut it (multiplicative decrease, ×0.6) to back off fast.
 *
 * Clamped to [min, max]. This converges toward the depth that maximizes
 * realized tok/s for the CURRENT session's mix of tasks, starting from the
 * task-class default. The output is advisory: it's sent to servers that accept
 * a draft-window hint, and ignored by those that don't.
 */
export class AdaptiveLookahead {
  private window: number;
  private baseline: number | null = null;

  constructor(
    initial: number,
    private min = 2,
    private max = 8,
  ) {
    this.window = Math.max(min, Math.min(max, initial));
  }

  current(): number { return this.window; }

  /** Feed the last turn's realized throughput (tok/s). Returns the new window. */
  update(throughputTps: number): number {
    if (throughputTps <= 0) return this.window;
    if (this.baseline === null) {
      this.baseline = throughputTps;
      return this.window;
    }
    if (throughputTps >= this.baseline * 1.02) {
      // Improved (≥2%) → additive increase.
      this.window = Math.min(this.max, this.window + 1);
    } else if (throughputTps < this.baseline * 0.95) {
      // Regressed (>5%) → multiplicative decrease.
      this.window = Math.max(this.min, Math.round(this.window * 0.6));
    }
    // EWMA baseline so it tracks a drifting workload.
    this.baseline = this.baseline * 0.7 + throughputTps * 0.3;
    return this.window;
  }

  /** Reset to a new task-class default (e.g. when the task class changes). */
  retarget(initial: number): void {
    this.window = Math.max(this.min, Math.min(this.max, initial));
    this.baseline = null;
  }
}

/**
 * Build the request-body extras that enable speculative decoding on a given
 * local server. Different OpenAI-compatible servers expose the knob under
 * different field names; sending the wrong one is harmless (servers ignore
 * unknown fields), but sending the RIGHT one is what actually turns it on.
 *
 *   - LM Studio          → `draft_model: "<id>"`
 *   - llama.cpp server   → `model_draft: "<id>"` (+ optional `n_draft`/`draft_max`)
 *   - vLLM               → `num_speculative_tokens: <n>` (draft model is a
 *                          server launch flag, not per-request; we send the
 *                          token count which vLLM honors per-request)
 *   - TGI / generic      → no standardized per-request field; rely on server
 *                          config. We still send LM Studio's field as the most
 *                          common case.
 *
 * `serverHint` lets config declare the backend; when unknown we send the union
 * of the harmless fields so it works across LM Studio and llama.cpp without the
 * user having to know which they're running.
 */
export type SpecServerKind = 'lmstudio' | 'llamacpp' | 'vllm' | 'auto';

export function buildSpecDecodeExtras(
  draftModel: string | undefined,
  lookahead: number,
  serverHint: SpecServerKind = 'auto',
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  switch (serverHint) {
    case 'lmstudio':
      if (draftModel) extras.draft_model = draftModel;
      break;
    case 'llamacpp':
      if (draftModel) extras.model_draft = draftModel;
      extras.n_draft = lookahead;
      break;
    case 'vllm':
      extras.num_speculative_tokens = lookahead;
      break;
    case 'auto':
    default:
      // Union of harmless fields — each server reads its own, ignores the rest.
      if (draftModel) {
        extras.draft_model = draftModel;   // LM Studio
        extras.model_draft = draftModel;   // llama.cpp
      }
      extras.n_draft = lookahead;             // llama.cpp
      extras.num_speculative_tokens = lookahead; // vLLM
      break;
  }
  return extras;
}
