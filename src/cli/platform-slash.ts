/**
 * Slash commands for the agent platform: the dedicated browser, the control
 * center, human takeover, approvals, missions, workflows, Sentinel, Telegram,
 * the vault and desktop control.
 *
 * Kept out of slash-commands.ts so that switch stays readable; every handler
 * lazy-imports its module (nothing here launches a browser unless asked to) and
 * returns plain text, so the commands work in the TUI and in headless runs.
 */

import type { ToolContext } from '../tools/base.js';

export interface PlatformSlashResult {
  handled: true;
  message: string;
}

const PLATFORM_COMMANDS = new Set([
  'browser', 'control', 'takeover', 'approvals', 'approve', 'deny',
  'missions', 'mission', 'workflows', 'workflow', 'sentinel', 'telegram', 'vault', 'desktop',
]);

export function isPlatformSlashCommand(cmd: string): boolean {
  return PLATFORM_COMMANDS.has(cmd);
}

/** Minimal ToolContext for calling a read-only tool from a slash command. */
function slashCtx(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: 'slash',
    transaction: {} as any,
    permissions: { evaluate: () => 'allow', rememberDecision: () => {} } as any,
    askUser: async (_p: string, options?: string[]) => (options ?? ['no']).find(o => /^n/i.test(o)) ?? 'no',
    emit: () => {},
  };
}

const ok = (message: string): PlatformSlashResult => ({ handled: true, message });

export async function handlePlatformSlash(cmd: string, args: string[], cwd: string): Promise<PlatformSlashResult> {
  const sub = (args[0] ?? '').toLowerCase();
  const rest = args.slice(1).join(' ').trim();
  try {
    switch (cmd) {
      case 'browser': return ok(await browserCmd(sub, rest, cwd));
      case 'control': return ok(await controlCmd(sub, args));
      case 'takeover': return ok(await takeoverCmd(sub));
      case 'approvals': return ok(await approvalsList());
      case 'approve': return ok(await answerApproval(args[0], args.slice(1).join(' ') || 'yes'));
      case 'deny': return ok(await answerApproval(args[0], 'no'));
      case 'missions': return ok(await missionsList());
      case 'mission': return ok(await missionCmd(args, cwd));
      case 'workflows':
      case 'workflow': return ok(await workflowsList());
      case 'sentinel': return ok(await sentinelCmd(sub));
      case 'telegram': {
        const { telegramSlashCommand } = await import('../channels/telegram/index.js');
        return ok(await telegramSlashCommand(args.join(' '), {
          missionAdapter: async () => (await import('../missions/telegram-adapter.js')).createTelegramMissionAdapter({ defaultCwd: cwd }),
        }));
      }
      case 'vault': {
        const { VAULT_TOOL_CLASSES } = await import('../vault/index.js');
        const List = VAULT_TOOL_CLASSES.find(C => new C().name === 'vault_list')!;
        const r = await new List().execute({} as any, slashCtx(cwd));
        return ok(`${r.content}\n\nAdd a login (the model never sees it): qodex vault add <name> --origin https://site.example --username you@example.com\nChange one: qodex vault edit <name> · new password: qodex vault rotate <name> · import a browser export: qodex vault import <file>`);
      }
      case 'desktop': {
        const { desktopStatusText } = await import('../tools/computer/index.js');
        return ok(await desktopStatusText(cwd));
      }
    }
  } catch (e: any) {
    return ok(`/${cmd} failed: ${e?.message ?? e}`);
  }
  return ok(`Unknown command /${cmd}`);
}

// ── /browser ─────────────────────────────────────────────────────────────────

async function browserStatusText(cwd: string): Promise<string> {
  const { BrowserStatusTool } = await import('../tools/browser/index.js');
  const r = await new BrowserStatusTool().execute({} as any, slashCtx(cwd));
  const { unfenceForDisplay } = await import('../sentinel/index.js');
  return unfenceForDisplay(r.content);
}

async function browserCmd(sub: string, rest: string, cwd: string): Promise<string> {
  const { getBrowserManager, peekBrowserManager } = await import('../tools/browser/types.js');
  switch (sub) {
    case '':
    case 'status':
      return browserStatusText(cwd);
    case 'open':
    case 'headed':
    case 'show': {
      const mgr = await getBrowserManager();
      await mgr.restart({ headless: false });
      if (rest) {
        const page = await mgr.activePage();
        const url = /^[a-z][a-z0-9+.-]*:/i.test(rest) ? rest : `https://${rest}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      return 'QodeX Browser is open in a visible window (persistent profile — log in to sites once and the agent stays logged in).\n' +
        'Tip: /control opens a live view where you can watch the agent, take over and approve actions.';
    }
    case 'headless':
    case 'hide': {
      const mgr = await getBrowserManager();
      await mgr.restart({ headless: true });
      return 'QodeX Browser restarted headless (profile and logins kept).';
    }
    case 'close':
    case 'stop': {
      const mgr = peekBrowserManager();
      if (!mgr || !mgr.isRunning()) return 'QodeX Browser is not running.';
      await mgr.close();
      return 'QodeX Browser closed (profile data is kept on disk).';
    }
    case 'profile': {
      if (!rest) return 'Usage: /browser profile <name>   — switch to (or create) a named persistent profile, e.g. "work" or "personal".';
      const mgr = await getBrowserManager();
      await mgr.restart({ profile: rest });
      return `QodeX Browser now uses profile "${mgr.status().profile}".`;
    }
    default:
      return 'Usage: /browser [status|open [url]|headless|close|profile <name>]';
  }
}

// ── /control, /takeover ──────────────────────────────────────────────────────

/** This process's one reference on the control center's mission actions (released by /control stop). */
let missionControl: Promise<() => void> | null = null;

async function controlCmd(sub: string, args: string[]): Promise<string> {
  const server = await import('../control/server.js');
  if (sub === 'stop' || sub === 'off') {
    const held = missionControl;
    missionControl = null;
    if (held) (await held.catch(() => null))?.();
    const stopped = await server.stopControlCenter();
    return stopped ? 'Control center stopped.' : 'Control center was not running.';
  }
  if (sub === 'status') {
    const info = server.getControlCenter();
    return info ? server.describeControlCenter(info) : 'Control center is not running. Start it with /control';
  }
  const flags = new Set(args.map(a => a.replace(/^--/, '').toLowerCase()));
  const info = await server.startControlCenter({ lan: flags.has('lan'), tunnel: flags.has('tunnel') });
  if (!missionControl) {
    const pending = import('../control/missions-bridge.js').then(m => m.registerMissionControl());
    missionControl = pending;
    // A failed registration must not stick: the next /control tries again.
    pending.catch(() => { if (missionControl === pending) missionControl = null; });
  }
  await missionControl;
  return server.describeControlCenter(info, flags.has('fa') ? 'fa' : 'en');
}

async function takeoverCmd(sub: string): Promise<string> {
  const { peekBrowserManager } = await import('../tools/browser/types.js');
  const mgr = peekBrowserManager();
  if (!mgr || !mgr.isRunning()) return 'QodeX Browser is not running — nothing to take over.';
  if (sub === 'off' || sub === 'release' || sub === 'end') {
    mgr.setTakeover(false, 'terminal');
    return 'Control handed back to the agent.';
  }
  if (sub === 'on' || sub === '') {
    mgr.setTakeover(true, 'terminal');
    return 'You have control of the browser — the agent\'s browser actions now wait.\n' +
      'Drive it in the visible window (/browser open) or the live view (/control). Hand back with /takeover off.';
  }
  return 'Usage: /takeover [on|off]';
}

// ── approvals ────────────────────────────────────────────────────────────────

async function approvalsList(): Promise<string> {
  const { getApprovalBroker } = await import('../control/approvals.js');
  const lines: string[] = [];
  for (const p of getApprovalBroker().pending()) {
    lines.push(`${p.id}  [${p.category ?? 'approval'}${p.risk ? `/${p.risk}` : ''}]  ${oneLine(p.prompt)}  (${p.options.join('/')})`);
  }
  try {
    const { getMissionStore, approvalOptions } = await import('../missions/store.js');
    for (const a of getMissionStore().listPendingApprovals()) {
      lines.push(`${a.id}  [mission ${a.mission_id}${a.category ? ` · ${a.category}` : ''}]  ${oneLine(a.prompt)}  (${approvalOptions(a).join('/')})`);
    }
  } catch { /* missions DB unavailable */ }
  if (!lines.length) return 'No pending approvals.';
  return ['Pending approvals:', ...lines, '', 'Answer with /approve <id> or /deny <id>.'].join('\n');
}

async function answerApproval(id: string | undefined, answer: string): Promise<string> {
  if (!id) return 'Usage: /approve <id> [answer]  |  /deny <id>   (see /approvals)';
  const { getApprovalBroker } = await import('../control/approvals.js');
  const broker = getApprovalBroker();
  const match = broker.pending().find(p => p.id === id || p.id.startsWith(id));
  if (match) {
    return broker.resolve(match.id, answer, 'terminal')
      ? `Answered ${match.id}: ${answer}`
      : `"${answer}" is not one of: ${match.options.join(', ')}`;
  }
  const { answerApprovalById } = await import('../missions/index.js');
  const r = answerApprovalById(id, answer, { by: 'terminal' });
  return r.message ?? (r.ok ? `Answered ${id}.` : `No pending approval matches "${id}".`);
}

// ── missions ─────────────────────────────────────────────────────────────────

async function missionsList(): Promise<string> {
  const { listMissionSummaries } = await import('../missions/index.js');
  const { formatMissionLine } = await import('../missions/tools.js');
  const list = listMissionSummaries({ limit: 10 });
  if (!list.length) return 'No missions yet. Start one with /mission <goal> — it keeps working in the background.';
  return ['Missions (newest first):', ...list.map(m => formatMissionLine(m)), '', '/mission status <id> · /mission cancel <id> · /mission steer <id> <note>'].join('\n');
}

async function missionCmd(args: string[], cwd: string): Promise<string> {
  const m = await import('../missions/index.js');
  const { formatMissionStatus } = await import('../missions/tools.js');
  const sub = (args[0] ?? '').toLowerCase();
  const id = args[1];
  switch (sub) {
    case '':
      return 'Usage: /mission <goal>  |  /mission status|cancel|resume <id>  |  /mission steer <id> <note>  |  /mission approve|deny <id> [approvalId]';
    case 'status': {
      const store = m.getMissionStore();
      const row = id ? store.resolve(id) : store.latest();
      if (!row) return id ? `No mission matches "${id}".` : 'No missions yet.';
      const s = m.summarizeMission(store, row);
      return s ? formatMissionStatus(store, s) : `No mission matches "${id}".`;
    }
    case 'cancel':
      if (!id) return 'Usage: /mission cancel <id>';
      return m.cancelMission(id, { by: 'terminal' }).message;
    case 'resume': {
      if (!id) return 'Usage: /mission resume <id>';
      const prep = m.prepareResume(id);
      if (!prep.ok || !prep.mission) return prep.message;
      const { pid } = m.spawnMissionWorker(prep.mission.id, { cwd: prep.mission.cwd });
      return `Mission ${prep.mission.id} resumed (worker pid ${pid}).`;
    }
    case 'steer':
      if (!id || args.length < 3) return 'Usage: /mission steer <id> <note>';
      return m.steerMission(id, args.slice(2).join(' '), { by: 'terminal' }).message;
    case 'approve':
    case 'deny':
      if (!id) return `Usage: /mission ${sub} <id> [approvalId]`;
      return m.answerMissionApproval(id, args[2], sub === 'approve' ? 'yes' : 'no', { by: 'terminal' }).message;
    default: {
      const goal = args.join(' ').trim();
      const r = m.startMission({ goal, cwd, source: 'tui' });
      return `Mission ${r.mission.id} started in the background${r.pid ? ` (worker pid ${r.pid})` : ''}.\n` +
        `It keeps working even if you close QodeX. Watch: qodex mission attach ${r.mission.id}  ·  status: /mission status ${r.mission.id}`;
    }
  }
}

// ── workflows / sentinel ─────────────────────────────────────────────────────

async function workflowsList(): Promise<string> {
  const { WorkflowStore, getWorkflowsDir, getActiveRecording, renderWorkflowList } = await import('../workflows/index.js');
  const rec = getActiveRecording();
  const recName = rec ? rec.status().name ?? 'current' : undefined;
  return renderWorkflowList(await new WorkflowStore().list(), getWorkflowsDir(), recName);
}

async function sentinelCmd(sub: string): Promise<string> {
  const { getSentinel, formatSentinelStatus } = await import('../sentinel/index.js');
  if (sub === 'reset') {
    getSentinel().resetSession();
    return 'Sentinel: session approvals ("always for this site") cleared.';
  }
  return formatSentinelStatus();
}

function oneLine(s: string, max = 140): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ── /allow, /mail (standing grants + mail automation) ────────────────────────

/**
 * `/allow …` (standing grants, src/grants/command.ts) and `/mail …` (watcher, rules,
 * the reply-all preset, src/mail/rules.ts). The TUI is a human surface; a headless
 * run (a schedule's prompt) may list / revoke / remove but never create a grant or
 * a rule. Arguments are re-split so "quoted conditions" and "quoted tasks" survive.
 */
export async function mailAutomationSlash(cmd: string, args: string[], cwd: string, sessionId: string): Promise<PlatformSlashResult> {
  const origin = sessionId === 'headless' ? 'headless' as const : 'tui' as const;
  try {
    const { splitArgs, runMailAutomationCommand } = await import('../mail/rules.js');
    const argv = splitArgs(args.join(' '));
    if (cmd === 'allow') {
      const { runAllowCommand } = await import('../grants/command.js');
      return ok(await runAllowCommand(argv, { origin }));
    }
    return ok(await runMailAutomationCommand(argv, { origin, cwd }));
  } catch (e: any) {
    return ok(`/${cmd} failed: ${e?.message ?? e}`);
  }
}
