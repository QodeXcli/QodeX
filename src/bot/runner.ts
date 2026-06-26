/**
 * The real AgentRunner — bridges the bot gateway to QodeX's AgentLoop.
 *
 * Mirrors src/cli/modes/headless.ts (the canonical programmatic driver): one fresh AgentLoop
 * per turn (so concurrent chats never share per-session state), a durable SessionStore session
 * per conversation, thinking/tool syntax filtered out of the stream, and the final answer
 * de-duplicated against what was already streamed (the long-standing double-print guard).
 */
import { AgentLoop } from '../agent/loop.js';
import type { ModelRouter } from '../llm/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PermissionEngine } from '../security/permissions.js';
import type { QodexConfig } from '../config/defaults.js';
import { getSessionStore } from '../session/store.js';
import { StreamDisplayFilter } from '../llm/thinking.js';
import { dedupeFinalAgainstStreamed, dedupeSelfRepeatedText } from '../cli/modes/final-dedupe.js';
import { logger } from '../utils/logger.js';
import type { AgentRunner, TurnSink } from './types.js';
import { SessionMap } from './session-map.js';

export interface RunnerDeps {
  config: QodexConfig;
  router: ModelRouter;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  cwd: string;
}

export class QodexAgentRunner implements AgentRunner {
  private map = new SessionMap();
  constructor(private deps: RunnerDeps) {}

  async reset(convKey: string): Promise<void> {
    await this.map.clear(convKey);
  }

  async runTurn(convKey: string, userText: string, sink: TurnSink, signal: AbortSignal): Promise<string> {
    const store = getSessionStore();
    const agent = new AgentLoop({
      router: this.deps.router,
      registry: this.deps.registry,
      permissions: this.deps.permissions,
      config: this.deps.config,
      cwd: this.deps.cwd,
    });

    // Resolve (or create) the durable session for this conversation.
    let sessionId = await this.map.get(convKey);
    const existing = sessionId ? store.loadSession(sessionId) : null;
    let messages;
    if (existing) {
      messages = [...existing.messages, { role: 'user' as const, content: userText }];
    } else {
      sessionId = store.createSession(this.deps.cwd, this.deps.config.defaults.model);
      await this.map.set(convKey, sessionId);
      messages = await agent.buildInitialMessages(userText, 'normal', this.deps.config.defaults.model);
    }
    const sid: string = sessionId!; // always set by the branch above
    store.recordTurn(sid, [{ role: 'user', content: userText }], { input: 0, output: 0, costUsd: 0 });

    const askUser = async (prompt: string, options: string[] = ['yes', 'no']): Promise<string> => sink.ask(prompt, options);

    const display = new StreamDisplayFilter();
    let streamed = '';

    for await (const ev of agent.run(messages, sid, { askUser, signal })) {
      switch (ev.type) {
        case 'text_delta': {
          const visible = display.push(ev.data?.delta ?? '');
          if (visible) { streamed += visible; await sink.onDelta(visible); }
          break;
        }
        case 'thinking_done': {
          const tail = display.flush();
          if (tail) { streamed += tail; await sink.onDelta(tail); }
          break;
        }
        case 'tool_call_executing':
          await sink.onStatus(`🔧 ${ev.data?.name ?? 'tool'}`);
          break;
        case 'notice':
          if (ev.data?.message) await sink.onStatus(String(ev.data.message));
          break;
        case 'error':
          throw new Error(ev.data?.message ?? 'agent error');
        case 'final': {
          const content = dedupeSelfRepeatedText(ev.data?.content ?? '');
          const decision = dedupeFinalAgainstStreamed(content, streamed);
          if (decision.emit) { streamed += decision.emit; await sink.onDelta(decision.emit); }
          break;
        }
      }
    }

    logger.info('bot turn complete', { convKey, sessionId, chars: streamed.length });
    return streamed;
  }
}
