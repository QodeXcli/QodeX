/**
 * Process-wide handle to the live AgentLoop.
 *
 * Kept in its own module so slash commands like `/insights` can read session
 * metrics without importing the entire agent loop (that import was a 5s test
 * timeout on a cold start).
 */
let _active: any = null;

export function setActiveAgent(agent: any): void {
  _active = agent;
}

export function getActiveAgent(): any {
  return _active;
}
