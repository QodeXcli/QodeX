/**
 * Headless (`qodex --print`) driver: runs one agent task without the TUI and streams
 * plain text or NDJSON (`--json`) to stdout. Scheduled runs and scripts use it.
 *
 * Approvals here are UNATTENDED: no human sits at this process's terminal. Every
 * askUser prompt is answered by a fixed policy (`headlessAnswer`): deny by default,
 * approve only with `--yes`. Sentinel-critical actions never reach this asker — they
 * need a real human on a remote channel (control center / Telegram) or are refused.
 */
import { AgentLoop, setActiveAgent, getActiveAgent } from '../../agent/loop.js';
import type { ModelRouter } from '../../llm/router.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { PermissionEngine } from '../../security/permissions.js';
import type { QodexConfig } from '../../config/defaults.js';
import { getSessionStore } from '../../session/store.js';
import { logger } from '../../utils/logger.js';
import { StreamDisplayFilter } from '../../llm/thinking.js';
import { dedupeFinalAgainstStreamed, dedupeSelfRepeatedText } from './final-dedupe.js';
import { getApprovalBroker, isApproval, safeOption, setInteractiveHuman } from '../../control/approvals.js';
import { setSubAgentRunner, getSubAgentRunner } from '../../tools/builtin/task.js';

/**
 * The unattended answer to an approval prompt. PURE.
 *
 *   - without --yes: the safe option (the first option starting with n / deny / reject /
 *     cancel / …), else 'no'. (The old code fell back to options[0], so the edit-approval
 *     prompt ['accept','edit','continue','reject'] was silently ACCEPTED while logging "denied".)
 *   - with --yes: the first approving option (starting with y / accept / approve / allow),
 *     else options[0].
 */
export function headlessAnswer(options: string[] | undefined, autoYes: boolean): string {
  const opts = Array.isArray(options) && options.length > 0 ? options : ['yes', 'no'];
  if (autoYes) {
    return opts.find(o => /^(y|accept|approve|allow)/i.test(String(o).trim())) ?? opts[0]!;
  }
  return safeOption(opts) ?? 'no';
}

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

  // Unattended process: no human at this terminal (Sentinel reads this to decide that
  // critical actions must go to a remote channel or be refused).
  setInteractiveHuman(false);

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

  // The fixed unattended policy (see headlessAnswer). Approvals under --yes stay quiet in
  // text mode (as before); denials are always reported so the user knows why a step failed.
  const policyAsk = async (prompt: string, options: string[] = ['yes', 'no']): Promise<string> => {
    const answer = headlessAnswer(options, !!opts.autoApproveAll);
    const approved = isApproval(answer, options);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ type: 'permission_request', prompt, options, answer, denied: !approved }) + '\n');
    } else if (!approved) {
      console.error(`Permission request: ${prompt} → auto-denied in headless mode (use --yes to auto-approve)`);
    }
    return answer;
  };
  // Brokered semantics: when a remote approval channel (control center / Telegram) lives
  // in this process, the prompt also goes through the ApprovalBroker so it is published
  // (bus + channels) and audited; the local policy answers it.
  const askUser = async (prompt: string, options: string[] = ['yes', 'no']): Promise<string> => {
    const broker = getApprovalBroker();
    if (broker.hasRemoteChannel()) {
      const r = await broker.request({ prompt, options, source: 'headless' }, (p, o) => policyAsk(p, o));
      return r.answer;
    }
    return policyAsk(prompt, options);
  };

  // SIGTERM (scheduler hard-kill, `kill`, a supervising process) cancels the run cleanly:
  // the loop sees the abort, rolls back the pending transaction and stops. SIGINT is
  // deliberately NOT handled here — any SIGINT listener would disable Ctrl+C exit.
  const runAbort = new AbortController();
  const onSigterm = () => { if (!runAbort.signal.aborted) runAbort.abort('SIGTERM'); };
  process.once('SIGTERM', onSigterm);

  // Sub-agents (task / fanout / gather / orchestrate / browser_agent / background jobs)
  // were disabled in --print because only the TUI registered a runner. Register one for
  // this run, and publish the agent so remote steering (control center) reaches it.
  // Both are unpublished in the finally below.
  const subAgentRunner = (p: string, o: Parameters<AgentLoop['runSubagent']>[1]) => agent.runSubagent(p, o);
  setSubAgentRunner(subAgentRunner);
  setActiveAgent(agent);

  try {
    for await (const event of agent.run(initialMessages, sessionId, {
      explicitModel: explicitModelOverride,
      mode: allowedToolsOverride && allowedToolsOverride.length > 0
        ? { mode: modeOverride, allowedTools: allowedToolsOverride }
        : { mode: modeOverride },
      askUser,
      signal: runAbort.signal,
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
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    // Unpublish only what we published (a host may have swapped in its own since).
    if (getSubAgentRunner() === subAgentRunner) setSubAgentRunner(null);
    if (getActiveAgent() === agent) setActiveAgent(null);
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
