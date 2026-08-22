/**
 * Process-wide handle to the live AgentLoop.
 *
 * Kept in its own module so slash commands like `/insights` can read session
 * metrics without importing the entire agent loop (that import was a 5s test
 * timeout on a cold start). Typed so `noImplicitAny` still holds at call sites.
 */
import type { SnapshotService } from '../safety/snapshot.js';
import type { InsightsSnapshot } from './insights.js';

export interface ActiveAgent {
  getInsights(sessionId: string): InsightsSnapshot;
  persistInsights(sessionId: string): void;
  resetInsights(sessionId: string): void;
  getSnapshotService(): SnapshotService | undefined;
  setAutoSnapshot(enabled: boolean): void;
  setSubagentMode(mode: 'off' | 'sequential' | 'parallel'): void;
}

let _active: ActiveAgent | null = null;

export function setActiveAgent(agent: ActiveAgent | null): void {
  _active = agent;
}

export function getActiveAgent(): ActiveAgent | null {
  return _active;
}
