import { AgentLoop } from '../../agent/loop.js';
import type { ModelRouter } from '../../llm/router.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { PermissionEngine } from '../../security/permissions.js';
import type { QodexConfig } from '../../config/defaults.js';
import { getSessionStore } from '../../session/store.js';
import { logger } from '../../utils/logger.js';
import { StreamDisplayFilter } from '../../llm/thinking.js';
import { dedupeFinalAgainstStreamed, dedupeSelfRepeatedText } from './final-dedupe.js';

export interface HeadlessOptions {
  cwd: string;
  config: QodexConfig;
  router: ModelRouter;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  prompt: string;
  json: boolean;
  autoApproveAll?: boolean;
  explicitModel?: string;
  resumeSessionId?: string;
}

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const startedAt = Date.now();
  const store = getSessionStore();

  // Resolve a leading custom slash command into its template + one-shot overrides.
  let effectivePrompt = opts.prompt;
  let modeOverride: 'plan' | 'normal' = 'normal';
  let explicitModelOverride = opts.explicitModel;
  let allowedToolsOverride: string[] | undefined;
  if (opts.prompt.trim().startsWith('/')) {
    const { handleSlashCommand } = await import('../slash-commands.js');
    const result = await handleSlashCommand(opts.prompt, 'headless', opts.cwd);
    if (result.handled && result.action?.type === 'submit_prompt') {
      effectivePrompt = result.action.prompt;
      if (result.action.mode) modeOverride = result.action.mode;
      if (result.action.model) explicitModelOverride = result.action.model;
      if (result.action.allowedTools && result.action.allowedTools.length > 0) {
        allowedToolsOverride = result.action.allowedTools;
      }
    } else if (result.handled && result.message) {
      // Built-in slash command that just prints something — nothing to send to the agent
      if (opts.json) {
        process.stdout.write(JSON.stringify({ type: 'slash_result', message: result.message }) + '\n');
      } else {
        process.stdout.write(result.message + '\n');
      }
      return 0;
    }
  }

  // Auto-detect referenced image paths and nudge the agent toward vision_analyze.
  {
    const { annotateImagePrompt } = await import('../../utils/image-paths.js');
    effectivePrompt = annotateImagePrompt(effectivePrompt, opts.cwd);
  }

  let sessionId: string;
  let initialMessages;

  if (opts.resumeSessionId) {
    const loaded = store.loadSession(opts.resumeSessionId);
    if (!loaded) {
      console.error(`Session not found: ${opts.resumeSessionId}`);
      return 1;
    }
    sessionId = opts.resumeSessionId;
    initialMessages = [...loaded.messages, { role: 'user' as const, content: effectivePrompt }];
  } else {
    sessionId = store.createSession(opts.cwd, explicitModelOverride ?? opts.config.defaults.model);
  }

  const agent = new AgentLoop({
    router: opts.router,
    registry: opts.registry,
    permissions: opts.permissions,
    config: opts.config,
    cwd: opts.cwd,
  });

  if (!initialMessages) {
    initialMessages = await agent.buildInitialMessages(
      effectivePrompt,
      modeOverride,
      explicitModelOverride ?? opts.config.defaults.model,
    );
  }

  // Record user turn (the rendered prompt, so resume sees the real instructions)
  store.recordTurn(sessionId, [{ role: 'user', content: effectivePrompt }], { input: 0, output: 0, costUsd: 0 });

  let exitCode = 0;
  // Text streamed (via text_delta) during the CURRENT agent iteration. Reset on each
  // iteration_start so it mirrors the loop's per-iteration assistantText. The 'final'
  // event carries that same text in full, so we compare against this to avoid
  // reprinting what we already streamed (the long-standing "double-print" bug).
  let streamedThisTurn = '';
  // Whether stdout is at the start of a line, so we emit exactly one trailing newline
  // without piling up blank lines.
  let atLineStart = true;
  const out = (s: string) => {
    if (!s) return;
    process.stdout.write(s);
    atLineStart = s.endsWith('\n');
  };
  // Strips reasoning blocks and leaked tool-call syntax from the printed stream (the loop
  // still recovers tool calls and emits reasoning as a separate event; --json surfaces it
  // all). Recreated per iteration so state never leaks across turns.
  let display = new StreamDisplayFilter();

  const askUser = async (prompt: string, options: string[] = ['yes', 'no']): Promise<string> => {
    if (opts.autoApproveAll) {
      const yes = options.find(o => o.toLowerCase().startsWith('y'));
      if (yes) return yes;
    }
    // In headless without auto-approve, deny by default
    if (opts.json) {
      process.stdout.write(JSON.stringify({ type: 'permission_request', prompt, options, denied: true }) + '\n');
    } else {
      console.error(`Permission request: ${prompt} → auto-denied in headless mode (use --yes to auto-approve)`);
    }
    const no = options.find(o => o.toLowerCase().startsWith('n'));
    return no ?? options[0]!;
  };

  try {
    for await (const event of agent.run(initialMessages, sessionId, {
      explicitModel: explicitModelOverride,
      mode: allowedToolsOverride && allowedToolsOverride.length > 0
        ? { mode: modeOverride, allowedTools: allowedToolsOverride }
        : { mode: modeOverride },
      askUser,
    })) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ type: event.type, ...event.data }) + '\n');
      } else {
        switch (event.type) {
          case 'iteration_start':
            // New turn — the upcoming 'final' will reflect only this turn's text.
            streamedThisTurn = '';
            display = new StreamDisplayFilter();
            break;
          case 'text_delta': {
            const visible = display.push(event.data?.delta ?? '');
            out(visible);
            streamedThisTurn += visible;
            break;
          }
          case 'thinking_done': {
            // Flush any text the filter was holding (a tail that never became a tag).
            const tail = display.flush();
            out(tail);
            streamedThisTurn += tail;
            // Separate a streamed block from whatever comes next (tool logs, next turn).
            if (!atLineStart) out('\n');
            break;
          }
          case 'tool_result':
            if (event.data?.isError) {
              process.stderr.write(`[tool:${event.data.name}] ${event.data.result.slice(0, 200)}\n`);
            }
            break;
          case 'notice':
            process.stderr.write(`${event.data?.message}\n`);
            break;
          case 'error':
            console.error(`Error: ${event.data?.message}`);
            exitCode = 1;
            break;
          case 'final': {
            // Collapse any self-repeat first (model emitting its whole answer
            // twice in one block), then run the streamed-vs-final dedupe.
            const content = dedupeSelfRepeatedText(event.data?.content ?? '');
            const decision = dedupeFinalAgainstStreamed(content, streamedThisTurn);
            if (decision.emit) out(decision.emit);
            if (decision.closeLine && !atLineStart) out('\n');
            break;
          }
        }
      }
    }
  } catch (e: any) {
    logger.error('Headless run failed', { err: e.message });
    console.error('Fatal:', e.message);
    return 1;
  }

  // Desktop notification for long autonomous runs (e.g. `qodex --print … --yes`
  // left running while the user does something else). Skipped when:
  //   - the run was short (< 30s) — a quick one-shot doesn't need a popup;
  //   - QODEX_SCHEDULED is set — the schedule runner already notifies, so we'd
  //     otherwise double-fire.
  const elapsedMs = Date.now() - startedAt;
  if (!process.env.QODEX_SCHEDULED && opts.autoApproveAll && elapsedMs >= 30_000) {
    const { notifyDesktop } = await import('../../utils/notify.js');
    const secs = Math.round(elapsedMs / 1000);
    void notifyDesktop({
      title: exitCode === 0 ? '✓ QodeX finished' : '✗ QodeX finished with errors',
      subtitle: `Autonomous run · ${secs}s`,
      message: exitCode === 0 ? 'Your task completed.' : `Exited with code ${exitCode} — check the output.`,
      sound: true,
    });
  }

  return exitCode;
}
