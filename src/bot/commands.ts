/**
 * Bot command registry — the single source of truth for everything `/slash`.
 *
 * Each command is declared once (name + description + handler) and EVERYTHING derives from this
 * list: the gateway's dispatch, the `/help` text, and the native command menu the adapter pushes to
 * the client (Telegram setMyCommands) so the user gets a tappable `/` picker. Add one entry → both
 * platforms gain the command, the menu, and the help line — no place to forget.
 *
 * Commands stay transport-agnostic: a handler talks to the conversation through `GatewayControls`
 * (abort/queue/reset) and the injected `AgentRunner` (status/model/auto/sessions). A command that
 * needs an optional runner capability degrades to a friendly "not available here" if it's absent,
 * so a minimal runner — or a unit-test fake — never crashes.
 */
import type { AgentRunner, Button } from './types.js';

/** The slice of the gateway a command may drive (kept tiny + testable). */
export interface GatewayControls {
  isBusy(): boolean;
  queueDepth(): number;
  /** Abort the running turn; returns whether one was actually running. */
  abort(): boolean;
  /** Drop the queue and forget the session (a fresh conversation). */
  reset(): Promise<void>;
  /** Run `text` as a normal agent turn (streamed) — how shortcut commands like /impact delegate to a tool. */
  runTask(text: string): Promise<void>;
}

export interface CommandCtx {
  /** Everything the user typed after the command word, trimmed (e.g. the id for `/resume <id>`). */
  args: string;
  key: string;
  agent: AgentRunner;
  gateway: GatewayControls;
  reply(text: string, buttons?: Button[][]): Promise<void>;
}

export interface BotCommand {
  /** Without the leading slash, e.g. `new`. */
  name: string;
  /** One line, shown in the native `/` menu and in `/help`. Keep < ~60 chars (Telegram limit). */
  description: string;
  run(ctx: CommandCtx): Promise<void>;
}

const NA = (feature: string) => `ℹ️ ${feature} isn't available on this bot build.`;
const truncate = (s: string, n: number): string => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export const COMMANDS: BotCommand[] = [
  {
    name: 'help',
    description: 'Show what I can do and every command',
    run: async ({ reply }) => reply(helpText()),
  },
  {
    name: 'new',
    description: 'Start a fresh conversation (new session)',
    run: async ({ gateway, reply }) => { await gateway.reset(); await reply('🆕 Fresh conversation — previous context cleared.'); },
  },
  {
    name: 'stop',
    description: 'Abort the task running right now',
    // When a turn IS running, the runner reports "Stopped" as it unwinds — stay quiet to avoid a
    // double message; only speak up when there was nothing to stop.
    run: async ({ gateway, reply }) => { if (!gateway.abort()) await reply('Nothing is running.'); },
  },
  {
    name: 'status',
    description: 'Show model, project, session and what’s running',
    run: async ({ agent, gateway, key, reply }) => {
      const lines = [gateway.isBusy() ? '⚙️ Running a task' : '💤 Idle'];
      const q = gateway.queueDepth();
      if (q) lines.push(`⏳ ${q} message${q === 1 ? '' : 's'} queued`);
      if (agent.status) {
        const s = await agent.status(key);
        lines.push(`🧠 model: \`${s.model}\``, `📁 project: \`${s.cwd}\``, `🔓 auto-approve: ${s.auto ? 'on' : 'off'}`);
        if (s.sessionId) lines.push(`🧵 session: \`${s.sessionId.slice(0, 8)}\``);
      }
      await reply(lines.join('\n'));
    },
  },
  {
    name: 'auto',
    description: 'Auto-approve actions: /auto on | off',
    run: async ({ agent, args, key, reply }) => {
      if (!agent.setAuto) return reply(NA('Auto-approve'));
      const v = args.toLowerCase();
      if (v !== 'on' && v !== 'off') return reply('Usage: `/auto on` or `/auto off`.\nWhen ON, I run shell/edits without asking — convenient on your phone, riskier. OFF by default.');
      await agent.setAuto(key, v === 'on');
      await reply(v === 'on' ? '🔓 Auto-approve ON — I won’t ask before running things this conversation.' : '🔒 Auto-approve OFF — I’ll ask before risky actions.');
    },
  },
  {
    name: 'model',
    description: 'Show or switch the model: /model [id]',
    run: async ({ agent, args, key, reply }) => {
      if (!args) {
        const cur = agent.status ? (await agent.status(key)).model : undefined;
        return reply(cur ? `🧠 Current model: \`${cur}\`\nSwitch with \`/model <id>\`.` : NA('Model info'));
      }
      if (!agent.setModel) return reply(NA('Model switching'));
      const now = await agent.setModel(key, args);
      await reply(`🧠 Model for this conversation → \`${now}\`.`);
    },
  },
  {
    name: 'impact',
    description: 'Impact of a symbol: /impact <symbol>',
    run: async ({ gateway, args, reply }) => {
      if (!args) return reply('Usage: `/impact <symbol>` — what depends on / calls a function, class or export.');
      await gateway.runTask(`Use the analyze_impact code-graph tool on the symbol \`${args}\` and report, concisely, everything that depends on or calls it (the blast radius of changing it). Do not edit anything.`);
    },
  },
  {
    name: 'rename',
    description: 'Safe AST rename: /rename <old> <new>',
    run: async ({ gateway, args, reply }) => {
      const [oldName, newName] = args.split(/\s+/);
      if (!oldName || !newName) return reply('Usage: `/rename <old> <new>` — AST-aware rename across the codebase (you’ll be asked to approve the edits).');
      await gateway.runTask(`Use the safe_rename code-graph tool to rename the symbol \`${oldName}\` to \`${newName}\` across the codebase.`);
    },
  },
  {
    name: 'episodes',
    description: 'Past tasks I solved here (episodic memory)',
    run: async ({ agent, reply }) => {
      if (!agent.listEpisodes) return reply(NA('Episodic memory'));
      const eps = await agent.listEpisodes(8);
      if (!eps.length) return reply('No episodic memory for this project yet — I record one after each verified-successful task.');
      const body = eps.map(e => `• _(${e.when})_ ${truncate(e.prompt, 60)}\n   ↳ ${truncate(e.summary, 90)}`).join('\n');
      await reply(`🧠 *What I’ve done here before*\n${body}`);
    },
  },
  {
    name: 'sessions',
    description: 'List recent sessions you can /resume',
    run: async ({ agent, reply }) => {
      if (!agent.listSessions) return reply(NA('Session history'));
      const list = await agent.listSessions(8);
      if (!list.length) return reply('No past sessions for this project yet.');
      const body = list.map(s => `• \`${s.id.slice(0, 8)}\` — ${s.title} _(${s.when})_`).join('\n');
      await reply(`🧵 *Recent sessions*\n${body}\n\nResume one with \`/resume <id>\`.`);
    },
  },
  {
    name: 'resume',
    description: 'Continue a past session: /resume <id>',
    run: async ({ agent, args, key, reply }) => {
      if (!agent.resume) return reply(NA('Resume'));
      if (!args) return reply('Usage: `/resume <id>` — get ids from `/sessions`.');
      const ok = await agent.resume(key, args);
      await reply(ok ? `🧵 Resumed session \`${args.slice(0, 8)}\` — I have its history now.` : `❓ No session matches \`${args}\`. Try \`/sessions\`.`);
    },
  },
];

/** Look up a command by the leading `/word` (case-insensitive). `/start` aliases `/help`. */
export function findCommand(text: string): { cmd: BotCommand; args: string } | null {
  if (!text.startsWith('/')) return null;
  const sp = text.indexOf(' ');
  let word = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
  const args = sp === -1 ? '' : text.slice(sp + 1).trim();
  if (word === 'start') word = 'help';
  const cmd = COMMANDS.find(c => c.name === word);
  return cmd ? { cmd, args } : null;
}

/** The list an adapter registers as the native `/` menu. */
export function menuDescriptors(): { command: string; description: string }[] {
  return COMMANDS.map(c => ({ command: c.name, description: c.description }));
}

function helpText(): string {
  const cmds = COMMANDS.map(c => `\`/${c.name}\` — ${c.description}`).join('\n');
  return [
    '🤖 *QodeX bot*',
    'Send a coding task and I’ll work in the project, streaming as I go. When I need approval I show buttons — tap one (or reply yes/no), or turn on `/auto`.',
    '',
    '*Commands*',
    cmds,
  ].join('\n');
}
