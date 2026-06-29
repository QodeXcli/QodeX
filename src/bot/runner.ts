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
import type { AgentRunner, TurnSink, RunnerStatus, ArtifactCard } from './types.js';
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
  private modelByKey = new Map<string, string>();   // per-conversation model override (/model)
  private autoByKey = new Map<string, boolean>();    // per-conversation auto-approve (/auto)
  constructor(private deps: RunnerDeps) {}

  async reset(convKey: string): Promise<void> {
    await this.map.clear(convKey);
  }

  private modelFor(convKey: string): string {
    return this.modelByKey.get(convKey) ?? this.deps.config.defaults.model;
  }

  async status(convKey: string): Promise<RunnerStatus> {
    return { model: this.modelFor(convKey), cwd: this.deps.cwd, sessionId: (await this.map.get(convKey)) ?? undefined, auto: this.autoByKey.get(convKey) ?? false };
  }

  async setModel(convKey: string, model: string): Promise<string> {
    this.modelByKey.set(convKey, model);
    return model;
  }

  async setAuto(convKey: string, on: boolean): Promise<void> {
    this.autoByKey.set(convKey, on);
  }

  async listSessions(limit = 8): Promise<{ id: string; title: string; when: string }[]> {
    return getSessionStore().listRecentSessions(limit, this.deps.cwd).map(s => ({
      id: s.id,
      title: s.title?.trim() || `${s.turn_count} turn${s.turn_count === 1 ? '' : 's'}`,
      when: relTime(s.updated_at),
    }));
  }

  async listEpisodes(limit = 8): Promise<{ when: string; prompt: string; summary: string }[]> {
    const { readEpisodes } = await import('../context/episodic-memory.js');
    const eps = await readEpisodes(this.deps.cwd);
    return eps.slice(-limit).reverse().map(e => ({ when: relTime(e.ts), prompt: e.prompt, summary: e.summary }));
  }

  /** Rebind a conversation to a past session by full id OR short prefix (as shown by /sessions). */
  async resume(convKey: string, idOrPrefix: string): Promise<boolean> {
    const store = getSessionStore();
    const match = store.loadSession(idOrPrefix) ? idOrPrefix
      : store.listRecentSessions(50, this.deps.cwd).find(s => s.id.startsWith(idOrPrefix))?.id;
    if (!match) return false;
    await this.map.set(convKey, match);
    return true;
  }

  async runTurn(convKey: string, userText: string, sink: TurnSink, signal: AbortSignal): Promise<string> {
    const store = getSessionStore();
    const model = this.modelFor(convKey);
    const config = model === this.deps.config.defaults.model
      ? this.deps.config
      : { ...this.deps.config, defaults: { ...this.deps.config.defaults, model } }; // per-chat model override
    const agent = new AgentLoop({
      router: this.deps.router,
      registry: this.deps.registry,
      permissions: this.deps.permissions,
      config,
      cwd: this.deps.cwd,
    });

    // Resolve (or create) the durable session for this conversation.
    let sessionId = await this.map.get(convKey);
    const existing = sessionId ? store.loadSession(sessionId) : null;
    let messages;
    if (existing) {
      messages = [...existing.messages, { role: 'user' as const, content: userText }];
    } else {
      sessionId = store.createSession(this.deps.cwd, model);
      await this.map.set(convKey, sessionId);
      messages = await agent.buildInitialMessages(userText, 'normal', model);
    }
    const sid: string = sessionId!; // always set by the branch above
    store.recordTurn(sid, [{ role: 'user', content: userText }], { input: 0, output: 0, costUsd: 0 });

    // /auto on → approve permission prompts automatically (skip the buttons) for the affirmative
    // option only; a prompt with no clear "yes/allow" still falls back to asking, so we never
    // silently green-light something ambiguous.
    const auto = this.autoByKey.get(convKey) ?? false;
    const askUser = async (prompt: string, options: string[] = ['yes', 'no']): Promise<string> => {
      if (auto) { const yes = options.find(o => /^(y|yes|allow|approve|ok|always)\b/i.test(o.trim())); if (yes) return yes; }
      return sink.ask(prompt, options);
    };

    const display = new StreamDisplayFilter();
    let streamed = '';
    // Accumulate the "living artifact" signals across the turn's tool results, so we can hand the bot
    // ONE rich card at the end (verdict from artifact_review, live URL from artifact_live).
    const card: ArtifactCard = { artifactId: '' };

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
        case 'tool_result': {
          const md: any = ev.data?.metadata;
          if (md && !ev.data?.isError) {
            if (ev.data?.name === 'artifact_review') {
              card.artifactId = md.artifactId ?? card.artifactId;
              card.verdict = md.verdict; card.issues = md.issues; card.screenshotPath = md.screenshotPath;
              card.title = md.title ?? card.title; card.type = md.type ?? card.type;
            } else if (ev.data?.name === 'artifact_live') {
              card.artifactId = md.artifactId ?? card.artifactId;
              card.liveUrl = md.url ?? md.tunnelUrl; card.type = md.type ?? card.type;
            }
          }
          break;
        }
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

    // A live artifact was produced this turn → hand the bot a card (screenshot + verdict + actions).
    if (card.artifactId && (card.liveUrl || card.verdict) && sink.artifact) {
      await sink.artifact(card);
    }

    logger.info('bot turn complete', { convKey, sessionId, chars: streamed.length });
    return streamed;
  }
}

/** Compact relative time for the /sessions list ("just now", "12m ago", "3d ago"). */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
