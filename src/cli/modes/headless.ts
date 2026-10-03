/**
 * Headless (`qodex --print`) driver: runs one agent task without the TUI and streams
 * plain text or NDJSON (`--json`) to stdout. Scheduled runs and scripts use it.
 *
 * Approvals here are UNATTENDED: no human sits at this process's terminal. Without
 * `--yes` every askUser prompt is denied (`headlessAnswer`). `--yes` / `--auto` is AUTO
 * MODE, not "answer yes": the permission policy runs everything inside the project without
 * asking, and whatever still asks (destructive outside the project, force push / publish /
 * remote deletes, system-level) needs a human — a remote channel (control center /
 * Telegram) can approve it, otherwise it is refused with [AUTO_MODE_NEEDS_HUMAN].
 * Sentinel-critical actions never reach this asker — they need a real human on a remote
 * channel or are refused.
 */
import { forwardAgentEvent } from '../../control/forward.js';
import { AgentLoop, setActiveAgent, getActiveAgent } from '../../agent/loop.js';
import type { ModelRouter } from '../../llm/router.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { PermissionEngine } from '../../security/permissions.js';
import type { QodexConfig } from '../../config/defaults.js';
import { getSessionStore } from '../../session/store.js';
import { logger } from '../../utils/logger.js';
import { StreamDisplayFilter } from '../../llm/thinking.js';
import { dedupeFinalAgainstStreamed, dedupeSelfRepeatedText } from './final-dedupe.js';
import { headlessAskChoice } from './headless-ask.js';
import {
  type AutonomyContract,
  type ContractUsage,
  enforceContract,
  buildRunReport,
  exitCodeFor,
  resolveScopeRoot,
  setWriteScopeRoot,
} from '../../agent/autonomy-contract.js';
import { getApprovalBroker, isApproval, normalizeAnswer, setInteractiveHuman } from '../../control/approvals.js';
import { setSubAgentRunner, getSubAgentRunner } from '../../tools/builtin/task.js';
import { getApprovalMode, isAutonomousMode, setApprovalMode } from '../../security/permissions.js';
import { needsHumanMessage } from '../../security/autonomy.js';
import { resolveSentinelConfig } from '../../config/agent-config.js';

/** A prompt condensed to one line for a refusal message (drops Sentinel's title line). */
function firstLine(s: string): string {
  return (s ?? '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('🛡')).join(' · ').slice(0, 300);
}

/**
 * The unattended answer to an approval prompt. PURE.
 *
 * Delegates to headlessAskChoice (headless-ask.ts), the single fail-safe policy:
 *   - without --yes: the deny option (reject / no / deny), never options[0] — the old
 *     code silently ACCEPTED the edit-approval prompt while logging "denied".
 *   - with autoYes outside auto mode: the first affirmative option (accept / yes / approve /
 *     allow / ...); when there is none it still denies. (runHeadless never uses this: its
 *     --yes runs in auto mode, where a prompt that reaches the asker needs a human.)
 */
export function headlessAnswer(options: string[] | undefined, autoYes: boolean): string {
  const opts = Array.isArray(options) && options.length > 0 ? options : ['yes', 'no'];
  return headlessAskChoice(opts, autoYes).choice;
}

/**
 * The askUser of an unattended `--print` run: the fixed `headlessAnswer` policy, reported
 * on stdout (`--json`: a `permission_request` line) or stderr (text mode, denials only).
 *
 * When a remote approval channel (control center / Telegram) lives in this process, the
 * prompt also goes through the ApprovalBroker so it is published (bus + channels) and
 * audited, with the policy as the local asker that answers it. A policy answer the broker
 * can't map onto the prompt's options — 'reject' for a choice like ['React', 'Vue'] — is
 * answered directly instead: the broker would drop it and the run would wait
 * forever for a remote human.
 */
export function makeHeadlessAskUser(opts: {
  autoYes: boolean;
  json: boolean;
  /** stdout writer (default process.stdout.write). */
  write?: (line: string) => void;
  /** stderr reporter for denials in text mode (default console.error). */
  warn?: (line: string) => void;
  /** How long a remote human (control center / Telegram) gets in auto mode. Default 600 s. */
  remoteTimeoutMs?: number;
}): (prompt: string, options?: string[]) => Promise<string> {
  const write = opts.write ?? ((line: string) => { process.stdout.write(line); });
  const warn = opts.warn ?? ((line: string) => { console.error(line); });

  /**
   * `--yes` / `--auto` mean AUTO MODE, not "answer yes". In auto mode ordinary work never
   * reaches askUser — the policy runs it. What does arrive needs a human (destructive
   * outside the project, force push / publish / remote deletes, system-level, a Sentinel
   * prompt about remote data). It is never answered yes here: a remote human can approve it
   * (control center / Telegram, with a timeout), otherwise it is refused and the run says
   * how to approve it.
   */
  const needsHuman = async (prompt: string, options: string[]): Promise<string> => {
    const deny = headlessAnswer(options, false);
    const broker = getApprovalBroker();
    if (broker.hasRemoteChannel() && normalizeAnswer(deny, options) !== null) {
      const r = await broker.request({
        prompt, options, source: 'headless', category: 'auto-mode', risk: 'high',
        timeoutMs: opts.remoteTimeoutMs ?? 600_000,
      });
      const approved = isApproval(r.answer, options);
      if (opts.json) write(JSON.stringify({ type: 'permission_request', prompt, options, answer: r.answer, denied: !approved, by: r.by }) + '\n');
      else if (!approved) warn(`Permission request: ${firstLine(prompt)} → ${r.by === 'timeout' ? 'no approval arrived in time' : 'declined'} (${r.by})`);
      return r.answer;
    }
    const message = needsHumanMessage(firstLine(prompt));
    if (opts.json) write(JSON.stringify({ type: 'permission_request', prompt, options, answer: deny, denied: true, needsHuman: true, message }) + '\n');
    else warn(message);
    return deny;
  };
  const policyAsk = async (prompt: string, options: string[] = ['yes', 'no']): Promise<string> => {
    const answer = headlessAnswer(options, opts.autoYes);
    const approved = isApproval(answer, options);
    if (opts.json) {
      write(JSON.stringify({ type: 'permission_request', prompt, options, answer, denied: !approved }) + '\n');
    } else if (!approved) {
      warn(`Permission request: ${prompt} → auto-denied in headless mode (use --yes to auto-approve)`);
    }
    return answer;
  };
  return async (prompt: string, options: string[] = ['yes', 'no']): Promise<string> => {
    const opts2 = Array.isArray(options) && options.length > 0 ? options : ['yes', 'no'];
    if (opts.autoYes || isAutonomousMode()) return needsHuman(prompt, opts2);
    const broker = getApprovalBroker();
    if (broker.hasRemoteChannel() && normalizeAnswer(headlessAnswer(opts2, opts.autoYes), opts2) !== null) {
      const r = await broker.request({ prompt, options: opts2, source: 'headless' }, (p, o) => policyAsk(p, o));
      return r.answer;
    }
    return policyAsk(prompt, opts2);
  };
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
  /** Guardrailed autonomy contract (--budget-tokens/--budget-usd/--max-wall/--scope/
   *  --verify/--rollback-on-fail). When set: budgets override config.budget, journaled
   *  writes are scope-gated, and the run ends with enforcement (verify →
   *  rollback-on-fail → RUN REPORT). */
  contract?: AutonomyContract;
  /** `--receipt <path>`: write a signed, tamper-evident JSON receipt of the run there.
   *  Requires a contract (there is nothing to attest without one). */
  receiptPath?: string;
}

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const startedAt = Date.now();
  const store = getSessionStore();

  // ── Autonomy contract: apply budgets BEFORE the loop is built ──
  // Budgets ride the existing BudgetTracker (fromConfig reads config.budget), so a
  // shallow clone with overridden limits is the whole wiring. (The write-scope gate
  // is armed further down, right before agent.run() — see the comment there.)
  let config = opts.config;
  if (opts.contract) {
    const c = opts.contract;
    if (c.budgetTokens !== undefined || c.budgetUsd !== undefined || c.maxWallSec !== undefined) {
      config = {
        ...config,
        budget: {
          ...config.budget,
          ...(c.budgetTokens !== undefined ? { perTaskMaxTokens: c.budgetTokens } : {}),
          ...(c.budgetUsd !== undefined ? { perTaskLimitUsd: c.budgetUsd } : {}),
          ...(c.maxWallSec !== undefined ? { perTaskMaxWallSeconds: c.maxWallSec } : {}),
        },
      };
    }
    // A USD budget on a model we cannot price would never fire: computeCost multiplies by a
    // placeholder 0, spend stays $0.00 forever, and the run is effectively unbounded. Say so
    // loudly rather than letting the user believe a cap is protecting them.
    if (c.budgetUsd !== undefined) {
      try {
        const routed = opts.router.route('main' as any, 0, {});
        if (routed?.modelInfo?.pricingSource === 'unknown') {
          process.stderr.write(
            `⚠  --budget-usd cannot be enforced for "${routed.modelInfo.id}": no pricing is known for this model, ` +
            `so spend always computes as $0.00. Use --budget-tokens or --max-wall instead, or set the price under ` +
            `providers.custom[].models[].inputCostPerMillion.\n`,
          );
        }
      } catch { /* routing probe is best-effort — never block the run on it */ }
    }
  }

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

  let resumeCwd: string | undefined;
  if (opts.resumeSessionId) {
    const loaded = store.loadSession(opts.resumeSessionId);
    if (!loaded) {
      console.error(`Session not found: ${opts.resumeSessionId}`);
      return 1;
    }
    sessionId = opts.resumeSessionId;
    initialMessages = [...loaded.messages, { role: 'user' as const, content: effectivePrompt }];
    const { pickWorkingCwd } = await import('../../session/handoff.js');
    resumeCwd = pickWorkingCwd({ sessionCwd: loaded.meta.cwd, hostCwd: opts.cwd });
  } else {
    sessionId = store.createSession(opts.cwd, explicitModelOverride ?? opts.config.defaults.model);
  }

  const agent = new AgentLoop({
    router: opts.router,
    registry: opts.registry,
    permissions: opts.permissions,
    config, // contract budgets (if any) applied above
    cwd: resumeCwd ?? opts.cwd,
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
  // ── Contract-run telemetry, gathered regardless of --json ──
  // usage comes from budget_update/final events; budget-exceeded is the loop's
  // 'error' event carrying a budgetType (tokens/cost/time/iterations — time is the
  // stall-aware kill); any other error (incl. a fatal throw) counts as agentError.
  let lastUsage: ContractUsage = { tokens: 0, costUsd: 0, wallTimeMs: 0, iterations: 0 };
  let budgetExceeded: { type?: string; message: string } | null = null;
  let agentError: string | null = null;
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

  // The fixed unattended policy (see headlessAnswer / makeHeadlessAskUser). Approvals under
  // --yes stay quiet in text mode (as before); denials are always reported so the user knows
  // why a step failed. Brokered (published + audited) when a remote channel is attached.
  let remoteTimeoutMs = 600_000;
  try { remoteTimeoutMs = resolveSentinelConfig(opts.config).remoteApprovalTimeoutSec * 1000; } catch { /* default */ }
  const askUser = makeHeadlessAskUser({ autoYes: !!opts.autoApproveAll, json: opts.json, remoteTimeoutMs });

  // `--yes` is auto mode (index.ts sets it for --yes/--auto; set it here too so a direct
  // caller gets the same semantics). The permission engine then runs everything inside the
  // project and asks only for what needs a human — which the asker above never answers yes.
  const modeBefore = getApprovalMode();
  if (opts.autoApproveAll && modeBefore !== 'auto') setApprovalMode('auto');

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

  // ── Autonomy contract: arm the write-scope gate ──
  // The scope root is a module-global consulted by Transaction.write()/delete() during
  // agent.run() below; the finally clears it. Armed HERE — after the pre-loop early
  // returns (slash-command short-circuit, resume-not-found) and buildInitialMessages,
  // none of which do journaled writes — so those paths can never leak it past this run
  // (they used to: set on entry, cleared only by the loop's finally). A pre-loop throw
  // also skips enforcement, which is fine: no journaled writes can exist yet.
  if (opts.contract?.scopePrefix) {
    setWriteScopeRoot(resolveScopeRoot(opts.cwd, opts.contract.scopePrefix));
  }

  try {
    for await (const event of agent.run(initialMessages, sessionId, {
      explicitModel: explicitModelOverride,
      mode: allowedToolsOverride && allowedToolsOverride.length > 0
        ? { mode: modeOverride, allowedTools: allowedToolsOverride }
        : { mode: modeOverride },
      askUser,
      signal: runAbort.signal,
    })) {
      forwardAgentEvent('headless', event);
      // Contract telemetry first — independent of the output mode below.
      if (event.type === 'budget_update' && event.data) {
        lastUsage = {
          tokens: event.data.tokens ?? lastUsage.tokens,
          costUsd: event.data.costUsd ?? lastUsage.costUsd,
          wallTimeMs: event.data.wallTimeMs ?? lastUsage.wallTimeMs,
          iterations: event.data.iterations ?? lastUsage.iterations,
        };
      } else if (event.type === 'final' && event.data?.usage) {
        lastUsage = event.data.usage;
      } else if (event.type === 'error') {
        if (event.data?.budgetType) {
          budgetExceeded = { type: event.data.budgetType, message: event.data.message ?? 'budget exceeded' };
        } else {
          agentError = event.data?.message ?? 'unknown agent error';
        }
      }
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
    // Under a contract, a crash must STILL reach enforcement — otherwise a fatal
    // mid-run throw would leave half-applied writes on disk with no rollback.
    if (!opts.contract) return 1;
    agentError = agentError ?? `fatal: ${e.message}`;
    exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    // Unpublish only what we published (a host may have swapped in its own since).
    if (getSubAgentRunner() === subAgentRunner) setSubAgentRunner(null);
    if (getActiveAgent() === agent) setActiveAgent(null);
    // Scope root is module-global — never let it leak past this run.
    if (opts.contract?.scopePrefix) setWriteScopeRoot(null);
    // Same for the approval mode this run switched on for --yes.
    if (opts.autoApproveAll && modeBefore !== 'auto') setApprovalMode(modeBefore);
  }

  // ── Autonomy contract enforcement: verify → rollback-on-fail → RUN REPORT ──
  if (opts.contract) {
    const { getJournal } = await import('../../filesystem/transaction.js');
    const outcome = await enforceContract({
      contract: opts.contract,
      cwd: opts.cwd,
      sessionId,
      usage: lastUsage,
      budgetExceeded,
      agentError,
      journal: getJournal(),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ type: 'run_report', ...outcome }) + '\n');
    } else {
      if (!atLineStart) out('\n');
      out(buildRunReport(outcome) + '\n');
    }

    // ── Verifiable run receipt ──
    // The report above is for a human watching the terminal. The receipt is the same facts
    // as a signed, tamper-evident artifact a CI job or a reviewer can re-check later.
    // Written only when --receipt is passed, so the default stdout contract is untouched.
    if (opts.receiptPath) {
      try {
        const { buildReceipt, signReceipt } = await import('../../agent/run-receipt.js');
        // On a rollback every listed file was restored; otherwise none were.
        const wasReverted = outcome.reverted;
        let receipt = buildReceipt({
          runId: sessionId,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          cwd: opts.cwd,
          scope: opts.contract.scopePrefix ?? null,
          granted: {
            tokens: opts.contract.budgetTokens,
            costUsd: opts.contract.budgetUsd,
            wallSec: opts.contract.maxWallSec,
          },
          consumed: {
            tokens: lastUsage.tokens,
            costUsd: lastUsage.costUsd,
            wallSec: Math.round(lastUsage.wallTimeMs / 1000),
            iterations: lastUsage.iterations,
          },
          verify: outcome.verify
            ? {
                command: outcome.verify.cmd,
                exitCode: outcome.verify.exitCode,
                ok: outcome.verify.ok,
                outputTail: outcome.verify.outputTail,
              }
            : null,
          files: outcome.filesChanged.map(p => ({ path: p, reverted: wasReverted })),
          // Ordered evidence of what the run did. Verify and rollback are known here;
          // per-tool and permission entries join as those paths start reporting.
          actions: [
            ...(outcome.verify
              ? [{
                  kind: 'verify' as const,
                  name: outcome.verify.cmd,
                  detail: `exit ${outcome.verify.exitCode ?? 'killed'}`,
                  ok: outcome.verify.ok,
                }]
              : []),
            ...(outcome.rollback
              ? [{
                  kind: 'rollback' as const,
                  name: 'rollbackSession',
                  detail: `${outcome.rollback.filesRestored} file(s) restored, ${outcome.rollback.txnsRolled} txn(s)`,
                  ok: true,
                }]
              : []),
          ],
          verdict: outcome.verdict,
          failReasons: outcome.failReasons,
        });
        // Signing is what makes a FIELD edit detectable. Without a key the chain still
        // protects the action log and verification honestly reports UNSIGNED.
        const auditKey = process.env.QODEX_AUDIT_KEY;
        if (auditKey) receipt = signReceipt(receipt, auditKey);
        const fsp = await import('fs/promises');
        await fsp.writeFile(opts.receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf-8');
        if (opts.json) {
          process.stdout.write(JSON.stringify({ type: 'run_receipt', path: opts.receiptPath, receipt }) + '\n');
        } else {
          out(`\nReceipt: ${opts.receiptPath}${auditKey ? ' (signed)' : ' (UNSIGNED — set QODEX_AUDIT_KEY to sign)'}\n`);
        }
      } catch (e: any) {
        // A receipt failure must never change the run's verdict — report it and move on.
        logger.warn('Failed to write run receipt', { err: e?.message });
        if (!opts.json) out(`\nReceipt: FAILED to write (${e?.message})\n`);
      }
    }

    exitCode = exitCodeFor(outcome.verdict);
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
