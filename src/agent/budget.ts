import { BudgetExceededError } from '../utils/errors.js';
import type { QodexConfig } from '../config/defaults.js';
import { MIN_WRAP_UP_WALL_SECONDS, type BudgetKind, type WrapUpConfig, type WrapUpGrant } from './budget-wrapup.js';

export interface BudgetUsage {
  tokens: number;
  costUsd: number;
  wallTimeMs: number;
  iterations: number;
}

export class BudgetTracker {
  private startTime = Date.now();
  private tokens = 0;
  private costUsd = 0;
  private iterations = 0;
  private iterationWarned = false;
  /** Bumped on every consume() (= a completed model call). Slow ≠ runaway: the wall-time
   *  ceiling only fires when the task is ALSO stalled, judged against this timestamp. */
  private lastProgressAt = Date.now();
  /** The one wrap-up allowance of this run, once granted (budget-wrapup.ts). */
  private wrapUp: WrapUpGrant | null = null;

  constructor(
    private maxTokens: number,
    private maxCostUsd: number,
    private maxWallSeconds: number,
    private maxIterations: number,
  ) {}

  static fromConfig(config: QodexConfig): BudgetTracker {
    return new BudgetTracker(
      config.budget.perTaskMaxTokens,
      config.budget.perTaskLimitUsd,
      config.budget.perTaskMaxWallSeconds,
      config.defaults.maxIterations,
    );
  }

  consume(usage: { tokens?: number; costUsd?: number }): void {
    this.tokens += usage.tokens ?? 0;
    this.costUsd += usage.costUsd ?? 0;
    this.lastProgressAt = Date.now();
  }

  incrementIteration(): void {
    this.iterations++;
  }

  /** Record non-model progress (a completed TOOL call). A 5-minute shell command is work,
   *  not a stall — without this, the wall ceiling read long tool runs as 'stalled' and
   *  killed the task right after the tool returned (live: 808s/600s, stalled 300s). */
  noteProgress(): void {
    this.lastProgressAt = Date.now();
  }

  checkpoint(): void {
    const wallMs = Date.now() - this.startTime;
    // A value of 0 (or negative) on any limit means "no limit" — useful for local
    // models where token/cost budgets are meaningless. Set perTaskMaxTokens: 0 in
    // config.budget to disable the token cap entirely.
    if (this.maxTokens > 0 && this.tokens > this.maxTokens) {
      throw new BudgetExceededError(`Token budget exceeded: ${this.tokens}/${this.maxTokens}`, 'tokens');
    }
    if (this.maxCostUsd > 0 && this.costUsd > this.maxCostUsd) {
      throw new BudgetExceededError(`Cost budget exceeded: $${this.costUsd.toFixed(4)}/$${this.maxCostUsd}`, 'cost');
    }
    if (this.maxWallSeconds > 0 && wallMs > this.maxWallSeconds * 1000) {
      // Slow ≠ runaway. checkpoint() runs right AFTER a completed model call, so in the
      // old form this ceiling could ONLY ever kill a task that was actively working
      // (live: "Time budget exceeded: 608s/600s" mid-edit on a local model) — a hung
      // task never reaches a checkpoint at all. The ceiling now fires only when the
      // task is ALSO stalled (no completed call in the last 2 minutes); true runaways
      // stay bounded by the iteration and token caps.
      const idleMs = Date.now() - this.lastProgressAt;
      if (idleMs > 120_000) {
        throw new BudgetExceededError(
          `Time budget exceeded: ${(wallMs / 1000).toFixed(0)}s/${this.maxWallSeconds}s (stalled ${(idleMs / 1000).toFixed(0)}s)`, 'time');
      }
    }
    // Iteration count is NOT a hard stop here. See iteration-pressure.ts — the
    // cap is a fuse: the loop extends it while the task is making progress.
  }

  getMaxIterations(): number {
    return this.maxIterations;
  }

  getIterations(): number {
    return this.iterations;
  }

  /** True when a finite cap is set and we have just crossed it. */
  atIterationCap(): boolean {
    return this.maxIterations > 0 && this.iterations > this.maxIterations;
  }

  /** Raise the fuse and allow another 80% warning against the new number. */
  extendIterations(newMax: number): void {
    this.maxIterations = Math.max(this.maxIterations, Math.floor(newMax));
    this.iterationWarned = false;
  }

  /** Override the iteration cap at runtime (0 = unlimited). Used by /unlimited and /iterations. */
  setMaxIterations(value: number): void {
    this.maxIterations = Math.max(0, Math.floor(value));
    this.iterationWarned = false; // allow a fresh warning against the new cap
  }

  /**
   * Returns true exactly ONCE — when iterations first cross ~80% of the cap — so the
   * agent loop can warn the user before the hard stop instead of cutting off abruptly.
   */
  shouldWarnIterations(): boolean {
    if (this.maxIterations <= 0 || this.iterationWarned) return false;
    if (this.iterations >= Math.ceil(this.maxIterations * 0.8)) {
      this.iterationWarned = true;
      return true;
    }
    return false;
  }

  /**
   * Grant the ONE wrap-up allowance after `hit` (a cap that was just crossed): every finite cap
   * moves to what is used now plus max(percent of the cap, minimum) — so a second cap can't end
   * the wrap-up right away — and the iteration cap covers `maxIterations` more model calls,
   * this one included. Null when disabled or already granted (the caller then hard-stops).
   */
  grantWrapUp(hit: { message: string; budgetType: BudgetKind }, cfg: WrapUpConfig): WrapUpGrant | null {
    if (!cfg.enabled || this.wrapUp) return null;
    const pct = cfg.percent / 100;
    const steps = Math.max(1, Math.floor(cfg.maxIterations));
    const g: WrapUpGrant = { budgetType: hit.budgetType, message: hit.message, grantedAt: this.iterations, steps };
    if (this.maxTokens > 0) {
      g.tokens = Math.max(Math.round(this.maxTokens * pct), cfg.minTokens);
      this.maxTokens = Math.max(this.maxTokens, this.tokens) + g.tokens;
    }
    if (this.maxCostUsd > 0) {
      g.usd = Math.max(this.maxCostUsd * pct, cfg.minUsd);
      this.maxCostUsd = Math.max(this.maxCostUsd, this.costUsd) + g.usd;
    }
    if (this.maxWallSeconds > 0) {
      g.wallSeconds = Math.max(Math.round(this.maxWallSeconds * pct), MIN_WRAP_UP_WALL_SECONDS);
      this.maxWallSeconds = Math.max(this.maxWallSeconds, Math.ceil((Date.now() - this.startTime) / 1000)) + g.wallSeconds;
    }
    if (this.maxIterations > 0) this.maxIterations = Math.max(this.maxIterations, this.iterations + steps - 1);
    this.wrapUp = g;
    return g;
  }

  /** The granted allowance, if any. */
  getWrapUp(): WrapUpGrant | null {
    return this.wrapUp;
  }

  /** True once the allowance's model calls are used up (checked at the start of an iteration). */
  wrapUpExhausted(): boolean {
    return !!this.wrapUp && this.iterations - this.wrapUp.grantedAt >= this.wrapUp.steps;
  }

  /** True on the allowance's last model call (sent without tools, so it ends with a summary). */
  wrapUpLastStep(): boolean {
    return !!this.wrapUp && this.iterations - this.wrapUp.grantedAt === this.wrapUp.steps - 1;
  }

  getUsage(): BudgetUsage {
    return {
      tokens: this.tokens,
      costUsd: this.costUsd,
      wallTimeMs: Date.now() - this.startTime,
      iterations: this.iterations,
    };
  }
}
