/**
 * Forward AgentLoop events onto the agent bus so the control center timeline,
 * Telegram notifications and mission attach can follow what an agent is doing.
 *
 * The compaction itself lives in the control server (agentEventToBus), next to
 * the dashboard that renders it, so there is exactly one mapping. Events always
 * land in the bus's small history ring, so a control center opened mid-task
 * still shows recent activity. Never throws.
 */

import { publishAgentEvent } from './server.js';

export function forwardAgentEvent(source: string, event: { type: string; data?: unknown }): void {
  publishAgentEvent(source, event);
}
