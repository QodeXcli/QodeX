import { BudgetExceededError } from '../utils/errors.js';
import type { QodexConfig } from '../config/defaults.js';

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
  }

  incrementIteration(): void {
    this.iterations++;
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
      throw new BudgetExceededError(`Time budget exceeded: ${(wallMs / 1000).toFixed(0)}s/${this.maxWallSeconds}s`, 'time');
    }
    if (this.maxIterations > 0 && this.iterations > this.maxIterations) {
      throw new BudgetExceededError(`Iteration budget exceeded: ${this.iterations}/${this.maxIterations}`, 'iterations');
    }
  }

  getMaxIterations(): number {
    return this.maxIterations;
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

  getUsage(): BudgetUsage {
    return {
      tokens: this.tokens,
      costUsd: this.costUsd,
      wallTimeMs: Date.now() - this.startTime,
      iterations: this.iterations,
    };
  }
}
