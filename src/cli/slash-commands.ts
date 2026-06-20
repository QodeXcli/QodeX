import { getJournal } from '../filesystem/transaction.js';
import { getSessionStore } from '../session/store.js';
import { clearTodos, getTodos } from '../tools/builtin/todo.js';
import { getMCPManager } from '../mcp/manager.js';
import { loadCustomCommands, renderTemplate } from './custom-commands.js';
import {
  listAllSkillsWithState,
  getSkill,
  setSkillEnabled,
  refreshSkillRegistry,
  slashAliasMap,
} from '../skills/registry.js';

export interface SlashResult {
  /** True if the command was handled (don't send to agent). */
  handled: boolean;
  /** Text to show in the UI. */
  message?: string;
  /** Special instructions for the host. */
  action?:
    | { type: 'clear' }
    | { type: 'set_model'; model: string }
    | { type: 'set_mode'; mode: 'plan' | 'normal' }
    | { type: 'set_max_iterations'; value: number }
    | { type: 'set_effort'; value: 'low' | 'medium' | 'high' | 'off' }
    | { type: 'switch_session'; sessionId: string }
    | { type: 'exit' }
    | {
        /**
         * Submit the rendered template as a normal user prompt. The host should:
         *   1. Show `commandName` (with args) in chat history, NOT the rendered template
         *   2. Apply `allowedTools` / `model` / `mode` as a one-shot override for the next run
         *   3. Pass `prompt` to the agent as user input
         */
        type: 'submit_prompt';
        prompt: string;
        commandName: string;
        rawInput: string;
        allowedTools?: string[];
        model?: string;
        mode?: 'plan' | 'normal';
      };
}

export async function handleSlashCommand(input: string, sessionId: string, cwd: string, config?: any): Promise<SlashResult> {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
  const arg = args.join(' ');

  // A real slash command is `/name` where name is a plain identifier (letters, digits,
  // -, _). Anything else that merely starts with '/' — an absolute file path like
  // `/Users/me/pic.png ...`, a URL, etc. — is NOT a command. Let it through as a normal
  // message so the agent (and tools like vision_analyze) can act on it, instead of
  // erroring "Unknown command". Typos like `/helpp` still match the shape → handled below.
  if (!/^[a-zA-Z][\w-]*$/.test(cmd ?? '')) {
    return { handled: false };
  }

  switch (cmd) {
    case 'btw': {
      // When a task is running, `/btw` is intercepted in the UI and injected live.
      // Reaching here means it was typed while IDLE — there's nothing to steer.
      return {
        handled: true,
        message: '/btw steers a task that is already running. Nothing is running right now — just type your request normally, or run a task and use /btw <note> mid-flight to nudge it.',
      };
    }
    case 'flywheel': {
      const { countTrajectories, getTrajectoryDatasetPath } = await import('../agent/trajectory.js');
      const enabled = (config as any)?.flywheel?.enabled === true;
      const sandboxOn = (config as any)?.sandbox?.enabled === true;
      const count = await countTrajectories(cwd);
      const datasetPath = getTrajectoryDatasetPath(cwd);
      const lines = [
        `Data flywheel: ${enabled ? 'ON' : 'OFF'}${enabled && !sandboxOn ? ' (but needs sandbox.enabled too!)' : ''}`,
        `Recorded trajectories for this project: ${count}`,
        `Dataset: ${datasetPath}`,
        '',
        enabled
          ? 'Each successful sandboxed+merged task appends one training example (local only).'
          : 'Enable with flywheel.enabled: true AND sandbox.enabled: true in ~/.qodex/config.yaml.',
      ];
      return { handled: true, message: lines.join('\n') };
    }

    case 'trellis': {
      const sub = arg.trim().toLowerCase();
      const { loadTrellisContext } = await import('../context/trellis.js');
      if (sub === 'init') {
        // Scaffold an empty .trellis/ tree so the user (or the official Trellis
        // CLI) can fill it. We only create dirs + a starter spec; we never
        // overwrite existing files.
        const fs = await import('fs');
        const path = await import('path');
        const base = path.join(cwd, '.trellis');
        const made: string[] = [];
        for (const d of ['spec', 'tasks', 'workspace']) {
          const dir = path.join(base, d);
          if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); made.push(`.trellis/${d}/`); }
        }
        const specFile = path.join(base, 'spec', 'conventions.md');
        if (!fs.existsSync(specFile)) {
          fs.writeFileSync(specFile,
            '# Project conventions\n\n' +
            '<!-- Write binding rules here: code style, architecture, do/don\'t. -->\n' +
            '<!-- QodeX injects this into every session as binding context. -->\n');
          made.push('.trellis/spec/conventions.md');
        }
        return {
          handled: true,
          message: made.length
            ? `Initialised Trellis harness:\n${made.map(m => '  + ' + m).join('\n')}\n\n` +
              `Edit .trellis/spec/conventions.md with your rules. Add task PRDs under ` +
              `.trellis/tasks/ and session journals under .trellis/workspace/. ` +
              `QodeX injects these automatically every session.`
            : `Trellis harness already initialised in this project.`,
        };
      }
      // Status
      const ctx = await loadTrellisContext(cwd);
      if (!ctx) {
        return {
          handled: true,
          message:
            'No .trellis/ harness in this project. Run /trellis init to create one, ' +
            'or install the official Trellis CLI. QodeX reads .trellis/spec, ' +
            '.trellis/tasks, and .trellis/workspace automatically when present.',
        };
      }
      return {
        handled: true,
        message:
          `Trellis harness active at ${ctx.rootDir}/.trellis/\n` +
          `  spec files:    ${ctx.counts.specFiles}\n` +
          `  task files:    ${ctx.counts.taskFiles}\n` +
          `  journal files: ${ctx.counts.journalFiles} (newest 3 injected)\n\n` +
          `These are injected into context every session — no need to re-explain the project.`,
      };
    }

    case 'effort':
    case 'reasoning': {
      const v = arg.trim().toLowerCase();
      if (!['low', 'medium', 'high', 'off'].includes(v)) {
        return {
          handled: true,
          message:
            'Usage: /effort <low|medium|high|off>\n' +
            'Sets reasoning/thinking effort for models that support it (sent as ' +
            'reasoning_effort). "off" clears the override (model default). ' +
            'Models without reasoning ignore it.',
        };
      }
      return {
        handled: true,
        message: v === 'off'
          ? 'Reasoning effort cleared (model default).'
          : `Reasoning effort set to "${v}" for this session.`,
        action: { type: 'set_effort', value: v as any },
      };
    }
    case 'unlimited': {
      // Remove the per-task iteration cap for this session. Token/cost/time
      // budgets still protect against a true runaway; only the iteration count
      // is lifted. Use Esc/Ctrl+C to stop manually.
      return {
        handled: true,
        message:
          'Iteration limit removed for this session. The agent will keep going until the task is done ' +
          '(token/cost/time budgets still apply; press Esc or Ctrl+C to stop). ' +
          'To make this permanent, set `defaults.maxIterations: 0` in ~/.qodex/config.yaml.',
        action: { type: 'set_max_iterations', value: 0 },
      };
    }
    case 'iterations': {
      const n = parseInt(arg, 10);
      if (arg === '' || Number.isNaN(n) || n < 0) {
        return {
          handled: true,
          message:
            'Usage: /iterations <number>   (e.g. /iterations 100)\n' +
            '  /iterations 0   → no limit (same as /unlimited)\n' +
            'Sets the per-task iteration cap for this session only.',
        };
      }
      return {
        handled: true,
        message: n === 0
          ? 'Iteration limit removed for this session (token/cost/time budgets still apply).'
          : `Iteration limit set to ${n} for this session.`,
        action: { type: 'set_max_iterations', value: n },
      };
    }
    case 'index': {
      // Trigger a background re-index. The actual indexer needs access to the codegraph DB;
      // we expose it via the codegraph/tools module.
      const { getCodeGraphDB } = await import('../codegraph/tools.js');
      const db = getCodeGraphDB();
      if (!db) return { handled: true, message: 'Code graph not initialized.' };
      const { Indexer } = await import('../codegraph/indexer.js');
      const indexer = new Indexer(db, cwd);
      const force = arg === '--force' || arg === '-f';
      // Run synchronously — small repos finish fast; for huge repos the user can Ctrl+C
      const result = await indexer.indexAll({ force });
      return {
        handled: true,
        message: `Indexed ${result.filesIndexed} file(s), skipped ${result.filesSkipped}, removed ${result.filesRemoved}.\n` +
          `  Total symbols: ${result.symbolCount}\n` +
          `  Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
      };
    }

    case 'mcp': {
      const m = getMCPManager();
      if (!m) return { handled: true, message: 'MCP manager not initialized.' };
      const statuses = m.status();
      if (statuses.length === 0) {
        return {
          handled: true,
          message: 'No MCP servers configured.\n\n' +
            'To add one, edit ~/.qodex/config.yaml:\n' +
            '  mcp:\n' +
            '    servers:\n' +
            '      filesystem:\n' +
            '        command: npx\n' +
            '        args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/work"]\n' +
            '        enabled: true',
        };
      }
      const lines = statuses.map(s => {
        const icon = s.state === 'ready' ? '✓' : s.state === 'failed' ? '✗' : '…';
        const err = s.error ? `  (${s.error})` : '';
        return `  ${icon} ${s.name}  state=${s.state}  tools=${s.toolCount}  transport=${s.transport}${err}`;
      });
      return { handled: true, message: 'MCP servers:\n' + lines.join('\n') };
    }

    case 'mcp-restart':
    case 'mcprestart': {
      const m = getMCPManager();
      if (!m) return { handled: true, message: 'MCP manager not initialized.' };
      if (!arg) return { handled: true, message: 'Usage: /mcp-restart <server-name>' };
      try {
        await m.restart(arg);
        return { handled: true, message: `Restarted MCP server ${arg}.` };
      } catch (e: any) {
        return { handled: true, message: `Failed to restart ${arg}: ${e.message}` };
      }
    }

    case 'help':
    case 'h': {
      return {
        handled: true,
        message: `QodeX slash commands:

  Session
    /help              Show this help
    /clear             Reset conversation (delete messages from DB)
    /undo [N=1]        Roll back the last N transactions
    /undo-session      Roll back the entire session
    /sessions          List recent sessions
    /resume <id>       Continue a previous session
    /exit              Exit QodeX

  Mode & model
    /plan              Switch to plan mode (read-only)
    /normal            Switch back to normal mode
    /model <id>        Override model for this conversation (bare /model lists models)
    /effort <level>    Reasoning effort: low|medium|high|off (for models that support it)
    /trellis [init]    Show Trellis harness status, or scaffold .trellis/ (spec+tasks+journals)
    /auto on|off       Auto-approve all permission prompts (session-only)
    /network           Diagnose internet + local backend connectivity
    /tools [--all]     List all registered tools by category
    /memory            Show / manage persisted project facts
    /strict on|off     Production-safety mode (plan + analyze before changes)
    /restore           Roll back to the most recent auto-snapshot (heavy undo)
    /unlimited         Remove the iteration cap for this session
    /iterations <n>    Set iteration cap for this session (0 = no limit)
    /btw <note>        Steer a RUNNING task mid-flight — inject a guidance note without stopping it

  Sub-agents & safety
    /subagents [off|sequential|parallel]   Configure sub-agent dispatcher
    /subagent-model [<id>|clear]   Pin a different model for sub-agents
    /roles                          Show role → model assignments + concurrency
    /snapshot [list|on|off|take "msg"|restore]   Manage auto-snapshots
    /caching [on|off]   Toggle Anthropic prompt caching for this session

  Observability
    /cost              Show token/cost usage
    /tokens            Per-turn token breakdown (inline)
    /todos             Show current todo list

  Tools & extensions
    /index [--force]               Build/refresh code graph
    /commands                      List custom slash commands (.qodex/commands/*.md)
    /skills                        List installed skills (taste, ui-ux-pro-max, ghost, OODA, L99, god-mode, artifacts)
    /skill <name> [args]           Run a skill explicitly (also: /skill enable|disable|reload)
    /hooks                         List configured lifecycle hooks
    /mcp                           Show status of MCP servers
    /mcp-restart <id>              Restart an MCP server
    /release-notes [<a>..<b>] [--write] [--bump=patch|minor|major] [--all]
                                   Generate release notes from a git range
    /schedule                      List scheduled tasks (add/rm/install via shell: \`qodex schedule …\`)
    /mcp-build <name> [desc]       Guided 4-stage scaffold of a new MCP server

  Coming in v0.5.1
    /compact           Summarise older history with the active model`,
      };
    }

    case 'clear': {
      clearTodos(sessionId);
      getSessionStore().clearMessages(sessionId);
      return {
        handled: true,
        action: { type: 'clear' },
        message: 'Conversation cleared (messages deleted from DB, todos cleared).',
      };
    }

    case 'undo': {
      const n = parseInt(arg) || 1;
      const journal = getJournal();
      const result = await journal.rollbackLast(sessionId, n);

      // Also tell the user if there are auto-snapshots they could fall further back to
      const { getActiveAgent } = await import('../agent/loop.js');
      const agent = getActiveAgent();
      const svc = agent?.getSnapshotService?.();
      const snapshots = svc?.list() ?? [];
      const suffix = snapshots.length > 0
        ? `\n\nAuto-snapshots available (${snapshots.length}). Use \`/restore\` to roll back to the most recent one, or \`/snapshot list\` to see all.`
        : '';

      return {
        handled: true,
        message: (result.txnsRolled === 0
          ? 'Nothing to undo in the journal for this session.'
          : `Rolled back ${result.txnsRolled} transaction(s), restored ${result.filesRestored} file(s).`) + suffix,
      };
    }

    case 'restore':
    case 'rollback': {
      // Pop the latest auto-snapshot. Distinct from /undo (which rolls back the
      // file-edit journal): /restore is the heavier hammer — it git-stash-pops
      // the snapshot we took before the agent's first mutation of the turn.
      // Use when you want to throw away EVERYTHING the agent did in that turn.
      const { getActiveAgent } = await import('../agent/loop.js');
      const agent = getActiveAgent();
      const svc = agent?.getSnapshotService?.();
      if (!svc) {
        return { handled: true, message: 'Auto-snapshot is disabled. Enable with safety.autoSnapshot: true in config, or use /undo for journal-based rollback.' };
      }
      const r = svc.restoreLatest();
      return {
        handled: true,
        message: r.restored
          ? `✓ ${r.message}\nWorking tree restored from auto-snapshot. Verify with \`git diff\` / \`git status\`.`
          : r.message,
      };
    }

    case 'undo-session': {
      const journal = getJournal();
      const result = await journal.rollbackSession(sessionId);
      return {
        handled: true,
        message: `Rolled back ENTIRE session: ${result.txnsRolled} transactions, ${result.filesRestored} files restored.`,
      };
    }

    case 'sessions':
    case 'history': {
      const store = getSessionStore();
      const sessions = store.listRecentSessions(15, cwd);
      if (sessions.length === 0) {
        return { handled: true, message: 'No previous sessions in this directory.' };
      }
      const lines = sessions.map(s => {
        const date = new Date(s.updated_at).toLocaleString();
        const title = s.title ?? '(untitled)';
        return `  ${s.id.slice(0, 8)} ${date} — ${title} (${s.turn_count} turns, $${s.total_cost_usd.toFixed(3)})`;
      });
      return { handled: true, message: `Recent sessions:\n${lines.join('\n')}\n\nUse /resume <id> to continue.` };
    }

    case 'resume': {
      if (!arg) return { handled: true, message: 'Usage: /resume <session-id-prefix>' };
      const store = getSessionStore();
      const all = store.listRecentSessions(100);
      const match = all.find(s => s.id.startsWith(arg));
      if (!match) return { handled: true, message: `No session found matching "${arg}".` };
      return {
        handled: true,
        action: { type: 'switch_session', sessionId: match.id },
        message: `Resumed session ${match.id.slice(0, 8)} (${match.turn_count} turns).`,
      };
    }

    case 'plan': {
      return {
        handled: true,
        action: { type: 'set_mode', mode: 'plan' },
        message: 'Plan mode enabled for next turn. Mutating tools are blocked until you /normal again.',
      };
    }

    case 'normal': {
      // NOTE: do NOT alias 'auto' here — '/auto' is the session auto-approve
      // command handled further down. Aliasing it to 'normal' shadowed that
      // case (first match wins in the switch) and made /auto a no-op.
      return {
        handled: true,
        action: { type: 'set_mode', mode: 'normal' },
        message: 'Normal mode enabled. All tools available.',
      };
    }

    case 'strict': {
      // /strict on|off — production-safety mode
      // When on, the system prompt instructs the agent to plan/analyze/verify
      // before any multi-file or impactful change. Useful for live codebases.
      const { setStrictMode, isStrictMode } = await import('../safety/strict-mode.js');
      const a = (arg ?? '').trim().toLowerCase();
      if (a === 'on' || a === 'true' || a === '1') {
        setStrictMode(true);
        return { handled: true, message: '🛡  Strict mode ON — agent will plan, analyze impact, and verify before multi-file changes. /strict off to disable.' };
      }
      if (a === 'off' || a === 'false' || a === '0') {
        setStrictMode(false);
        return { handled: true, message: 'Strict mode OFF — back to normal operation.' };
      }
      return {
        handled: true,
        message: `Strict mode: ${isStrictMode() ? 'ON 🛡' : 'OFF'}\n\nUsage: /strict on   |   /strict off\n\nWhen ON, the agent must:\n  - Run analyze_impact / project_overview before multi-file changes\n  - present_plan for any change spanning >2 files\n  - Verify with auto_fix after every batch of edits\n  - Dry-run destructive commands first\n  - Explain blast radius before risky changes\nUse for production codebases (Seven Gum, ChinPost, sg-commerce-pro).`,
      };
    }

    case 'context': {
      // Show context window usage breakdown
      const store = getSessionStore();
      const loaded = store.loadSession(sessionId);
      if (!loaded) return { handled: true, message: 'Session not found.' };
      const msgs = loaded.messages;
      const charCount = msgs.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
      const estTokens = Math.ceil(charCount / 3.5);
      const ctxWindow = 32_768; // conservative; actual model may have more
      const pct = Math.round((estTokens / ctxWindow) * 100);
      const filled = Math.min(40, Math.floor(pct / 2.5));
      const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, 40 - filled));
      const roleStats = new Map<string, { count: number; chars: number }>();
      for (const m of msgs) {
        const role = m.role;
        const stat = roleStats.get(role) ?? { count: 0, chars: 0 };
        stat.count++;
        stat.chars += typeof m.content === 'string' ? m.content.length : 0;
        roleStats.set(role, stat);
      }
      const lines = [
        `Context usage: ~${estTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (${pct}%)`,
        `[${bar}]`,
        '',
        `Messages: ${msgs.length}`,
      ];
      for (const [role, s] of roleStats) {
        lines.push(`  ${role.padEnd(12)} ${String(s.count).padStart(4)} msg, ~${Math.ceil(s.chars / 3.5).toLocaleString()} tokens`);
      }
      if (pct >= 70) {
        lines.push('');
        lines.push(`⚠ Context >${pct}% — consider /compact to summarize old turns.`);
      }
      return { handled: true, message: lines.join('\n') };
    }

    case 'compact': {
      // Manually trigger compaction signal — agent loop catches this and compacts
      return {
        handled: true,
        action: { type: 'compact' } as any,
        message: 'Compacting conversation history… old turns will be summarized; recent ones preserved.',
      };
    }

    case 'network':
    case 'net': {
      // Probe internet + local backends and pretty-print the result.
      // Useful when web_search keeps returning [NO_RESULTS] — surfaces whether
      // the user's machine actually has connectivity, or whether DDG / HF are
      // unreachable from this network specifically.
      const { runFullDiagnostic, formatDiagnostic } = await import('../utils/network-check.js');
      const diag = await runFullDiagnostic();
      return {
        handled: true,
        message: formatDiagnostic(diag),
      };
    }

    case 'tools': {
      // List all registered tools, grouped by category. With `--all` show full
      // descriptions; without, show just names + one-line summaries.
      const { getRegistry } = await import('../tools/registry.js');
      const reg = getRegistry();
      const all = reg.list();
      const verbose = (arg ?? '').includes('--all') || (arg ?? '').includes('-v');

      // Group by name prefix
      const categories: Record<string, typeof all> = {
        'Filesystem': [],
        'Shell & code': [],
        'Code graph': [],
        'Analysis & Safety': [],
        'Frontend & Design': [],
        'Git': [],
        'Web': [],
        'Browser': [],
        'Dev server': [],
        'Background jobs': [],
        'Vision': [],
        'Computer use (macOS)': [],
        'Database': [],
        'WordPress': [],
        'Memory': [],
        'Sub-agents & planning': [],
        'MCP (external)': [],
        'Other': [],
      };
      for (const t of all) {
        const n = t.name;
        if (n.startsWith('browser_')) categories['Browser']!.push(t);
        else if (n.startsWith('dev_server_')) categories['Dev server']!.push(t);
        else if (n.startsWith('background_job_')) categories['Background jobs']!.push(t);
        else if (n.startsWith('computer_use_')) categories['Computer use (macOS)']!.push(t);
        else if (n.startsWith('git_') || n === 'smart_diff') categories['Git']!.push(t);
        else if (n.startsWith('code_graph_') || n === 'semantic_search') categories['Code graph']!.push(t);
        else if (['project_overview', 'analyze_impact', 'find_dead_code', 'safe_rename', 'safe_delete_file', 'review_my_changes', 'explain_codebase', 'suggest_improvements'].includes(n)) categories['Analysis & Safety']!.push(t);
        else if (['detect_frontend_stack', 'analyze_design_system', 'find_ui_components', 'design_audit'].includes(n)) categories['Frontend & Design']!.push(t);
        else if (n.startsWith('web_') || n === 'network_check' || n === 'http_request') categories['Web']!.push(t);
        else if (n.startsWith('vision_')) categories['Vision']!.push(t);
        else if (n.startsWith('db_')) categories['Database']!.push(t);
        else if (n.startsWith('wp_')) categories['WordPress']!.push(t);
        else if (['remember', 'recall', 'forget'].includes(n)) categories['Memory']!.push(t);
        else if (['read_file','write_file','edit_text','edit_symbol','multi_edit','multi_file_edit','ls','glob','grep','pdf_read','csv_read','csv_write','xlsx_read'].includes(n)) categories['Filesystem']!.push(t);
        else if (['bash','code_run'].includes(n)) categories['Shell & code']!.push(t);
        else if (['task','present_plan','todo_read','todo_write','auto_fix','use_skill'].includes(n)) categories['Sub-agents & planning']!.push(t);
        else if (n.startsWith('mcp_') || n.includes(':')) categories['MCP (external)']!.push(t);
        else categories['Other']!.push(t);
      }

      const lines: string[] = [`Registered tools: ${all.length} total`];
      for (const [cat, tools] of Object.entries(categories)) {
        if (tools.length === 0) continue;
        lines.push('');
        lines.push(`${cat} (${tools.length}):`);
        for (const t of tools) {
          const ro = t.isReadOnly ? ' [read-only]' : '';
          if (verbose) {
            lines.push(`  ${t.name}${ro}`);
            lines.push(`    ${t.description}`);
          } else {
            const short = t.description.length > 100 ? t.description.slice(0, 100) + '…' : t.description;
            lines.push(`  ${t.name.padEnd(28)} ${ro.padEnd(13)} ${short}`);
          }
        }
      }
      lines.push('');
      lines.push(`(tip: /tools --all for full descriptions)`);
      return { handled: true, message: lines.join('\n') };
    }

    case 'model': {
      if (!arg) {
        const def = config?.defaults?.model ?? '(unknown)';
        const lines: string[] = [`Current default model: ${def}`, ''];
        // Gather configured models across providers (defaults + extraModels).
        const seen = new Set<string>();
        const add = (id?: string) => { if (id && !seen.has(id)) { seen.add(id); } };
        add(def);
        const providers = config?.providers ?? {};
        for (const pName of Object.keys(providers)) {
          const p = providers[pName] ?? {};
          add(p.model);
          for (const em of (p.extraModels ?? [])) add(em.model ?? em.id ?? em.name);
        }
        // Named roles can pin specific models too.
        const roles = config?.roles ?? {};
        for (const r of Object.keys(roles)) add(roles[r]?.model);
        const list = [...seen].filter(Boolean);
        if (list.length > 0) {
          lines.push('Configured models:');
          for (const m of list) lines.push(`  ${m === def ? '●' : '○'} ${m}`);
        }
        lines.push('', 'Switch with: /model <model-id>  (applies from the next turn).');
        return { handled: true, message: lines.join('\n') };
      }
      return {
        handled: true,
        action: { type: 'set_model', model: arg },
        message: `Model set to ${arg} for next turn.`,
      };
    }

    case 'cost':
    case 'usage': {
      const store = getSessionStore();
      const loaded = store.loadSession(sessionId);
      if (!loaded) return { handled: true, message: 'Session not found.' };
      const m = loaded.meta;
      return {
        handled: true,
        message: `Session ${m.id.slice(0, 8)}:
  Turns: ${m.turn_count}
  Input tokens: ${m.total_input_tokens.toLocaleString()}
  Output tokens: ${m.total_output_tokens.toLocaleString()}
  Cost: $${m.total_cost_usd.toFixed(4)}`,
      };
    }

    case 'telemetry': {
      const { getTelemetry } = await import('../utils/telemetry.js');
      const tel = getTelemetry();
      const parts = (arg ?? '').trim().split(/\s+/);
      const verb = parts[0] ?? '';
      if (verb === 'on') {
        tel.setEnabled(true);
        return { handled: true, message: 'Telemetry ON (local-only, ~/.qodex/telemetry.db). No phone-home.' };
      }
      if (verb === 'off') {
        tel.setEnabled(false);
        return { handled: true, message: 'Telemetry OFF. Existing data retained until /telemetry clear.' };
      }
      if (verb === 'clear') {
        const r = tel.clear();
        return { handled: true, message: `Cleared: ${r.toolEventsDeleted} tool event(s), ${r.llmEventsDeleted} LLM event(s).` };
      }
      if (verb === 'anonymize') {
        const mode = (parts[1] ?? 'on') !== 'off';
        tel.setEnabled(tel.isEnabled(), mode);
        return { handled: true, message: `Anonymize cwd: ${mode ? 'ON (sha256-hashed)' : 'OFF (raw path)'}` };
      }
      return {
        handled: true,
        message: `Telemetry: ${tel.isEnabled() ? 'ON' : 'OFF'}  (local-only, no phone-home)\n\nCommands:\n  /telemetry on              enable\n  /telemetry off             disable\n  /telemetry anonymize on    hash cwd in records\n  /telemetry clear           wipe local DB\n  /stats                     view aggregated stats`,
      };
    }

    case 'stats': {
      const { getTelemetry } = await import('../utils/telemetry.js');
      const tel = getTelemetry();
      if (!tel.isEnabled()) {
        return { handled: true, message: 'Telemetry is OFF. Enable with /telemetry on to start recording.' };
      }
      const a = (arg ?? '').trim();
      const days = parseInt(a, 10);
      const daysBack = !isNaN(days) && days > 0 ? days : 30;
      const allCwds = a === 'all';
      const toolStats = tel.getToolStats(daysBack, allCwds ? undefined : cwd);
      const modelStats = tel.getModelStats(daysBack, allCwds ? undefined : cwd);
      const lines: string[] = [`Stats — last ${daysBack} day(s), ${allCwds ? 'all projects' : cwd}`, ''];
      lines.push('Top tools:');
      if (toolStats.length === 0) lines.push('  (no events recorded yet)');
      else for (const t of toolStats.slice(0, 12)) {
        const sr = t.totalCalls > 0 ? (100 * t.successCount / t.totalCalls).toFixed(0) : '—';
        lines.push(`  ${t.tool.padEnd(28)} ${String(t.totalCalls).padStart(5)}x  ${sr}% ok  avg ${Math.round(t.avgDurationMs)}ms`);
      }
      lines.push('');
      lines.push('Model usage:');
      if (modelStats.length === 0) lines.push('  (no events recorded yet)');
      else for (const m of modelStats) {
        lines.push(`  ${m.provider}/${m.model}  [${m.role}]  ${m.callCount}x  ${m.totalInputTokens.toLocaleString()} in / ${m.totalOutputTokens.toLocaleString()} out  $${m.totalCostUsd.toFixed(4)}`);
      }
      return { handled: true, message: lines.join('\n') };
    }

    case 'todos':
    case 'todo': {
      const todos = getTodos(sessionId);
      if (todos.length === 0) return { handled: true, message: 'No todos.' };
      const lines = todos.map(t => {
        const marker = t.status === 'completed' ? '[x]'
          : t.status === 'in_progress' ? '[>]'
          : t.status === 'cancelled' ? '[-]'
          : '[ ]';
        return `  ${marker} ${t.content}`;
      });
      return { handled: true, message: lines.join('\n') };
    }

    case 'hooks': {
      const { getHooksManager } = await import('../hooks/manager.js');
      const hm = getHooksManager();
      if (!hm) return { handled: true, message: 'Hooks manager not initialized.' };
      const list = hm.list();
      if (list.length === 0) {
        return {
          handled: true,
          message: 'No lifecycle hooks configured.\n\n' +
            'To add one, edit ~/.qodex/config.yaml under `hooks`:\n' +
            '  hooks:\n' +
            '    PostToolUse:\n' +
            '      - matcher: "write_file|edit_file|edit_symbol|multi_edit"\n' +
            '        command: "npx prettier --write $QODEX_FILE_PATHS 2>&1 || true"\n' +
            '        timeout: 30\n' +
            '    PreToolUse:\n' +
            '      - matcher: "^bash$"\n' +
            '        command: "/usr/local/bin/audit-bash.sh"\n\n' +
            'Hooks receive context via env vars:\n' +
            '  QODEX_HOOK_EVENT, QODEX_TOOL_NAME, QODEX_TOOL_ARGS_JSON,\n' +
            '  QODEX_TOOL_RESULT, QODEX_FILE_PATHS, QODEX_SESSION_ID, QODEX_CWD',
        };
      }
      const lines = list.map(({ event, index, config }) => {
        const matcher = config.matcher ? `  matcher=${config.matcher}` : '';
        const blocking = config.blocking === false ? '  (non-blocking)' : '';
        const name = config.name ?? config.command.slice(0, 50);
        return `  [${event}] #${index}  ${name}${matcher}${blocking}`;
      });
      return { handled: true, message: `Configured hooks (${list.length}):\n${lines.join('\n')}` };
    }

    case 'commands': {
      const customs = await loadCustomCommands(cwd);
      if (customs.size === 0) {
        return {
          handled: true,
          message: 'No custom commands defined.\n\n' +
            'Create one by adding a Markdown file:\n' +
            '  .qodex/commands/<name>.md       (project-specific)\n' +
            '  ~/.qodex/commands/<name>.md     (user-global)\n\n' +
            'Example:\n' +
            '  ---\n' +
            '  description: Fix lint errors in a file\n' +
            '  argument-hint: <file-path>\n' +
            '  allowed-tools: [read_file, edit_file, bash]\n' +
            '  ---\n' +
            '  Please fix any lint errors in {{ARGUMENTS}}. First run the linter,\n' +
            '  then make minimal edits.',
        };
      }
      const lines: string[] = [`${customs.size} custom command${customs.size > 1 ? 's' : ''}:`];
      for (const [name, spec] of [...customs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const argHint = spec.argumentHint ? ` ${spec.argumentHint}` : '';
        const desc = spec.description ? `  — ${spec.description}` : '';
        const tag = spec.origin === 'project' ? '[project]' : '[user]';
        lines.push(`  /${name}${argHint}  ${tag}${desc}`);
      }
      return { handled: true, message: lines.join('\n') };
    }

    case 'tokens': {
      // Quick measurement of THIS session's token consumption.
      // For full breakdown across categories, use `qx tokens` from the shell — slash
      // command runs inline so we keep it light and bounded.
      const store = getSessionStore();
      const loaded = store.loadSession(sessionId);
      if (!loaded) {
        return { handled: true, message: 'Session not found.' };
      }
      const { analyzeMessages, formatReport, estimateTokens } = await import('../diagnostics/token-analyzer.js');
      // We don't have direct access to system prompt / tool schemas from inside the slash
      // command, so we approximate them from the FIRST system message in history (if any).
      const firstSystem = loaded.messages.find(m => m.role === 'system');
      const systemTokens = firstSystem ? estimateTokens(firstSystem.content) : 0;
      // Tool schemas: not stored per-turn. We mark this clearly in the output.
      const report = analyzeMessages(sessionId, loaded.messages, { systemTokens, toolSchemaTokens: 0 });
      const note = '(note: tool-schema column shows 0 in /tokens — run `qx tokens` from the shell for the full measurement)';
      return { handled: true, message: note + '\n\n' + formatReport(report) };
    }

    case 'snapshot':
    case 'snapshots': {
      // /snapshot           — list active snapshots
      // /snapshot on|off    — toggle auto-snapshot for this session
      // /snapshot take "msg" — take one right now
      // /snapshot restore   — pop the most recent snapshot back onto the working tree
      const { getActiveAgent } = await import('../agent/loop.js');
      const agent = getActiveAgent();
      if (!agent) return { handled: true, message: 'Snapshot service requires an active agent.' };

      const sub = args[0]?.toLowerCase();
      if (!sub || sub === 'list') {
        const svc = agent.getSnapshotService();
        if (!svc) return { handled: true, message: 'Auto-snapshot is OFF. Toggle with `/snapshot on` or take one manually with `/snapshot take "label"`.' };
        const list = svc.list();
        if (list.length === 0) return { handled: true, message: 'No active snapshots.' };
        const lines = ['Active snapshots (oldest first):'];
        list.forEach((s, i) => {
          const ago = Math.round((Date.now() - s.createdAt) / 1000);
          lines.push(`  ${i + 1}. ${s.message}  (${ago}s ago, turn ${s.turn})`);
        });
        lines.push('');
        lines.push('Restore most recent: /snapshot restore');
        return { handled: true, message: lines.join('\n') };
      }
      if (sub === 'on') {
        agent.setAutoSnapshot(true);
        return { handled: true, message: 'Auto-snapshot enabled for this session.' };
      }
      if (sub === 'off') {
        agent.setAutoSnapshot(false);
        return { handled: true, message: 'Auto-snapshot disabled for new operations. Existing snapshots are preserved.' };
      }
      if (sub === 'take') {
        // Need agent to have a snapshot service first
        let svc = agent.getSnapshotService();
        if (!svc) {
          agent.setAutoSnapshot(true);
          svc = agent.getSnapshotService();
        }
        const label = args.slice(1).join(' ') || 'manual';
        const rec = svc!.takeSnapshot(`manual: ${label}`, 0);
        if (!rec) return { handled: true, message: 'Snapshot skipped (not a git repo, or working tree clean).' };
        return { handled: true, message: `Snapshot taken: ${rec.message}` };
      }
      if (sub === 'restore') {
        const svc = agent.getSnapshotService();
        if (!svc) return { handled: true, message: 'No snapshot service active.' };
        const r = svc.restoreLatest();
        return { handled: true, message: r.message };
      }
      return { handled: true, message: 'Usage: /snapshot [list|on|off|take "label"|restore]' };
    }

    case 'subagents':
    case 'subagent': {
      // /subagents          — show current mode
      // /subagents off|sequential|parallel — switch mode for this session
      const { getActiveAgent } = await import('../agent/loop.js');
      const agent = getActiveAgent();
      if (!agent) return { handled: true, message: 'Sub-agent settings require an active agent.' };

      const mode = args[0]?.toLowerCase();
      if (!mode) {
        const { getActiveConfig } = await import('../config/loader.js');
        const cur = (getActiveConfig() as any)?.subagents?.mode ?? 'sequential';
        return {
          handled: true,
          message:
            `Sub-agents: ${cur}\n` +
            'Switch with: /subagents off | sequential | parallel\n' +
            '  off        — `task` tool unavailable\n' +
            '  sequential — sub-agents run one at a time, isolated context (recommended)\n' +
            '  parallel   — cloud-only; falls back to sequential on local',
        };
      }
      if (mode !== 'off' && mode !== 'sequential' && mode !== 'parallel') {
        return { handled: true, message: 'Invalid mode. Use: off | sequential | parallel' };
      }
      agent.setSubagentMode(mode);
      return { handled: true, message: `Sub-agents now: ${mode}` };
    }

    case 'subagent-model':
    case 'sub-model': {
      // /subagent-model              — show current resolution
      // /subagent-model <id>         — pin a model for sub-agents in this session
      // /subagent-model clear        — clear session override (fall back to config / parent)
      const { resolveRole, setSessionRoleOverride, getSessionRoleOverride, inferProvider } =
        await import('../llm/role-resolver.js');
      const { getActiveConfig } = await import('../config/loader.js');
      const cfg = getActiveConfig();
      if (!cfg) return { handled: true, message: 'Config not loaded.' };

      const target = args[0];
      if (!target) {
        const resolved = resolveRole('subagent', cfg);
        const overr = getSessionRoleOverride('subagent');
        const lines = [
          `Sub-agent model: ${resolved.provider}/${resolved.model}`,
          `Source: ${resolved.source}`,
          '',
          'Usage:',
          '  /subagent-model <id>     — pin a model (e.g. claude-haiku-4-5, qwen2.5-coder:7b)',
          '  /subagent-model clear    — clear session override',
        ];
        if (overr) lines.push('', `Currently overridden in this session: ${overr.provider}/${overr.model}`);
        return { handled: true, message: lines.join('\n') };
      }
      if (target === 'clear' || target === 'none' || target === 'off') {
        setSessionRoleOverride('subagent', null);
        return { handled: true, message: 'Sub-agent session override cleared. Falling back to config / parent default.' };
      }
      // Set new override; infer provider from model id
      const provider = inferProvider(target);
      setSessionRoleOverride('subagent', { provider, model: target });
      return {
        handled: true,
        message:
          `Sub-agent model pinned to ${provider}/${target} for this session.\n` +
          `(To persist: edit ~/.qodex/config.yaml → roles.subagent, or re-run \`qx setup\`.)`,
      };
    }

    case 'roles': {
      // Show every role → model resolution, plus concurrency policy verdict
      const { resolveRole, effectiveConcurrencyMode } = await import('../llm/role-resolver.js');
      const { BUILTIN_ROLES } = await import('../llm/prompts/role-prompts.js');
      const { getActiveConfig } = await import('../config/loader.js');
      const cfg = getActiveConfig();
      if (!cfg) return { handled: true, message: 'Config not loaded.' };

      const parent = { provider: cfg.defaults.provider, model: cfg.defaults.model };
      const sub = resolveRole('subagent', cfg);
      const concurrency = effectiveConcurrencyMode(cfg, parent.provider, sub.provider);
      const subMode = (cfg as any).subagents?.mode ?? 'sequential';

      const lines = [
        'Role → model assignments:',
        '',
        `  parent       ${parent.provider}/${parent.model}`,
        `  subagent     ${sub.provider}/${sub.model}   (from ${sub.source})`,
      ];

      // Show every additional role: built-ins always, custom-defined extras too
      const rolesMap = (cfg as any).roles ?? {};
      const additionalNames = new Set<string>([...BUILTIN_ROLES]);
      for (const name of Object.keys(rolesMap)) {
        if (name !== 'subagent') additionalNames.add(name);
      }
      for (const name of additionalNames) {
        const r = resolveRole(name, cfg);
        const configured = !!rolesMap[name]?.model;
        const tag = configured ? '' : '  (not configured — falls back)';
        lines.push(`  ${name.padEnd(12)} ${r.provider}/${r.model}   (from ${r.source})${tag}`);
      }

      lines.push('');
      lines.push(`Sub-agent mode: ${subMode}`);
      lines.push(`Concurrency:    ${concurrency.mode}   (${concurrency.reason})`);
      if (subMode === 'parallel' && concurrency.mode === 'sequential') {
        lines.push('');
        lines.push('  ↳ Note: configured mode is `parallel` but the auto policy fell back to');
        lines.push('    sequential because both sides are local. To force, set');
        lines.push('    subagents.concurrencyMode: force in config.');
      }
      lines.push('');
      lines.push('Change via:');
      lines.push('  /subagent-model <id>   — session override for sub-agents');
      lines.push('  /model <id>            — session override for parent');
      lines.push('  ~/.qodex/config.yaml roles.<name>: {provider, model}   — persist a role');
      return { handled: true, message: lines.join('\n') };
    }

    case 'memory':
    case 'facts': {
      // /memory                  — list facts for current cwd
      // /memory clear            — wipe all facts for cwd (with confirmation)
      // /memory forget <substr>  — drop facts matching substring
      const { getSessionStore } = await import('../session/store.js');
      const store = getSessionStore();
      const parts = (arg ?? '').trim().split(/\s+/);
      const verb = parts[0] ?? '';
      if (verb === 'clear') {
        const db = (store as any).db;
        const result = db.prepare(`DELETE FROM session_facts WHERE cwd = ?`).run(cwd);
        return { handled: true, message: `Cleared ${result.changes} fact(s) for ${cwd}.` };
      }
      if (verb === 'forget') {
        const needle = parts.slice(1).join(' ').trim();
        if (!needle) return { handled: true, message: 'Usage: /memory forget <substring>' };
        const db = (store as any).db;
        const result = db.prepare(`DELETE FROM session_facts WHERE cwd = ? AND fact LIKE ?`).run(cwd, `%${needle}%`);
        return { handled: true, message: `Forgot ${result.changes} fact(s) matching "${needle}".` };
      }
      // Default: list
      const facts = store.getFactsForCwd(cwd, 100);
      if (facts.length === 0) {
        return {
          handled: true,
          message: `No facts stored for ${cwd}.\n\nAgent can call the \`remember\` tool to save facts.\nOr add a QODEX.md to the project root for static rules.`,
        };
      }
      const lines = [
        `${facts.length} fact(s) for ${cwd}:`,
        '',
        ...facts.map((f, i) => `  ${(i + 1).toString().padStart(2)}. ${f}`),
        '',
        'Commands:',
        '  /memory clear            — wipe all',
        '  /memory forget <sub>     — drop facts containing this substring',
      ];
      return { handled: true, message: lines.join('\n') };
    }

    case 'project': {
      // /project                  — show this project's memory (name + worklog)
      // /project define <name>     — name the project rooted at this directory
      // /project log <entry>       — manually add a worklog entry
      // /project clear             — wipe this project's worklog
      const { getSessionStore } = await import('../session/store.js');
      const store = getSessionStore();
      const parts = (arg ?? '').trim().split(/\s+/);
      const verb = (parts[0] ?? '').toLowerCase();

      if (verb === 'define') {
        const rest = parts.slice(1).join(' ').trim();
        if (!rest) return { handled: true, message: 'Usage: /project define <name> [- description]' };
        const split = rest.split(/\s+[\u2014-]\s+/); // "Name - desc" or "Name — desc"
        const name = (split[0] ?? rest).trim();
        const desc = split.length > 1 ? split.slice(1).join(' - ').trim() : undefined;
        store.defineProject(cwd, name, desc);
        return {
          handled: true,
          message: `Project defined: "${name}"${desc ? ` - ${desc}` : ''}\nRooted at ${cwd}.\nI'll brief you on prior work each session and record progress as we go.`,
        };
      }

      if (verb === 'log') {
        const entry = parts.slice(1).join(' ').trim();
        if (!entry) return { handled: true, message: 'Usage: /project log <what was done>' };
        store.addWorklogEntry(cwd, sessionId, entry, 'work');
        return { handled: true, message: `Logged to project memory: ${entry}` };
      }

      if (verb === 'clear') {
        const db = (store as any).db;
        const r = db.prepare(`DELETE FROM project_worklog WHERE cwd = ?`).run(cwd);
        return { handled: true, message: `Cleared ${r.changes} worklog entr${r.changes === 1 ? 'y' : 'ies'} for this project.` };
      }

      // Default: show the brief.
      const project = store.getProject(cwd);
      const log = store.getWorklog(cwd, 30);
      if (!project && log.length === 0) {
        return {
          handled: true,
          message:
            `No project defined for ${cwd}.\n\n  /project define <name>   - name this project\n  /project log <entry>     - record what was done\n\nOnce defined, I'll brief you on prior work each session automatically; the agent also records progress via the project_log tool.`,
        };
      }
      const plines: string[] = [];
      if (project) plines.push(`Project: ${project.name}${project.description ? ` - ${project.description}` : ''}`);
      plines.push(`Directory: ${cwd}`);
      plines.push('');
      if (log.length) {
        plines.push(`Worklog (${log.length} most recent):`);
        for (const e of log) {
          const when = (e.created_at ?? '').slice(0, 16).replace('T', ' ');
          const tag = e.kind && e.kind !== 'work' ? `(${e.kind}) ` : '';
          plines.push(`  - [${when}] ${tag}${e.entry}`);
        }
      } else {
        plines.push('No worklog entries yet.');
      }
      plines.push('');
      plines.push('  /project define <name>  |  /project log <entry>  |  /project clear');
      return { handled: true, message: plines.join('\n') };
    }

    case 'caching': {
      // /caching            — show Anthropic prompt-caching status
      // /caching on|off     — toggle (requires Anthropic provider)
      const { getActiveConfig } = await import('../config/loader.js');
      const cfg = getActiveConfig() as any;
      const cur = cfg?.providers?.anthropic?.useCaching === true;
      const sub = args[0]?.toLowerCase();
      if (!sub) {
        return {
          handled: true,
          message:
            `Anthropic prompt caching: ${cur ? 'enabled' : 'disabled'}\n` +
            'Toggle with: /caching on | off\n' +
            '(Only affects Anthropic API calls. Free to enable; first call full price, subsequent calls within 5 min get ~90% off the cached portion.)',
        };
      }
      if (sub !== 'on' && sub !== 'off') {
        return { handled: true, message: 'Usage: /caching [on|off]' };
      }
      // Mutate active config — affects future provider instantiation
      if (cfg) {
        cfg.providers = cfg.providers ?? {};
        cfg.providers.anthropic = { ...(cfg.providers.anthropic ?? {}), useCaching: sub === 'on' };
      }
      return {
        handled: true,
        message:
          `Anthropic caching ${sub === 'on' ? 'enabled' : 'disabled'} for this session.\n` +
          '(Note: takes effect on the NEXT model call; existing in-flight request is unchanged. Restart `qx` for a clean reset, or persist with `qx setup`.)',
      };
    }

    case 'auto': {
      // /auto on|off  — session-wide auto-approve of permission prompts
      const sub = args[0]?.toLowerCase();
      if (sub !== 'on' && sub !== 'off') {
        return {
          handled: true,
          message:
            'Usage: /auto on | off\n' +
            'When ON, all permission prompts auto-approve for THIS session only. Hard-denied patterns (rm -rf /, etc.) still refuse. Re-disable with /auto off.',
        };
      }
      // Toggle via PermissionEngine — exposed via the active config's runtime layer
      const { setAutoApproveSession, getAutoApproveSession } = await import('../security/permissions.js');
      setAutoApproveSession(sub === 'on');
      const status = getAutoApproveSession() ? 'ENABLED' : 'disabled';
      return {
        handled: true,
        message:
          sub === 'on'
            ? `⚠ Auto-approve ${status} for this session. All tool calls will run without prompting.\n  Hard-deny patterns still apply. Disable with /auto off.`
            : `Auto-approve ${status}. Permission prompts restored.`,
      };
    }

    case 'exit':
    case 'quit':
    case 'q': {
      return { handled: true, action: { type: 'exit' }, message: 'Bye.' };
    }

    case 'schedule':
    case 'schedules': {
      // Read-only summary. Mutating ops live on the CLI (`qodex schedule add|rm|...`)
      // because they need richer arg parsing than a single slash line and they
      // mostly happen outside the agent loop.
      const { getScheduleStore } = await import('../schedule/store.js');
      const entries = getScheduleStore().list();
      if (entries.length === 0) {
        return {
          handled: true,
          message: 'No scheduled tasks.\n\nAdd one from your shell:\n  qodex schedule add --name nightly-tests --cron "@daily" --prompt "run npm test and report results"\n  qodex schedule install    # one-time: install the launchd tick',
        };
      }
      const lines = entries.map(e => {
        const flag = e.enabled ? '●' : '○';
        const next = e.next_run_at ? new Date(e.next_run_at).toLocaleString() : '—';
        const last = e.last_run_at ? `${e.last_status} @ ${new Date(e.last_run_at).toLocaleString()}` : 'never';
        return `  ${flag} ${e.id.slice(0, 8)} ${e.name} (${e.cron})  next: ${next}  last: ${last}`;
      });
      return {
        handled: true,
        message: `Scheduled tasks:\n${lines.join('\n')}\n\nManage from shell: \`qodex schedule add|rm|enable|disable|runs|tick\`.`,
      };
    }

    case 'mcp-build':
    case 'mcpbuild': {
      // Shortcut around the mcp_scaffold tool — wraps the agent in the 4-stage
      // build workflow that examples/commands/mcp-build.md also defines, so
      // users get the same experience without having to copy the file into
      // their .qodex/commands/.
      const promptBody = `You will build a new MCP (Model Context Protocol) server in four stages. Arguments: ${arg || '(none — ask me for name + description)'}.

STAGE 1 — Discovery (write nothing yet):
  Ask me: (a) what does this server do? (b) what tools should it expose? (1-5 names + one-line purpose) (c) network/auth needed? (d) target dir (default ./<name>).
  Wait for my answers. Do not assume.

STAGE 2 — Schema:
  For each tool, draft JSON-Schema-style input/output. Show me the list. Wait for approval.

STAGE 3 — Scaffold:
  Call mcp_scaffold(name, description, dir). Then for each confirmed tool that isn't "example":
    - Create src/tools/<name>.ts following the example pattern
    - Wire it into src/index.ts (import + dispatch case)
    - Add test/<name>.test.ts
  TODOs for network/auth: throw('TODO: ...') so tests surface them.

STAGE 4 — Wire + test:
  cd <dir>; npm install; npm run build; npm test.
  Show me the configSnippet from the scaffold output for me to paste into ~/.qodex/config.yaml.
  Do NOT edit ~/.qodex/config.yaml yourself.

Guardrails: never invent tools I didn't confirm; never modify ~/.qodex/config.yaml; never commit/push.`;
      return {
        handled: true,
        action: {
          type: 'submit_prompt',
          prompt: promptBody,
          commandName: '/mcp-build',
          rawInput: trimmed,
          allowedTools: ['mcp_scaffold', 'read_file', 'write_file', 'edit_text', 'bash', 'ls', 'glob'],
        },
      };
    }

    case 'release-notes':
    case 'releasenotes': {
      // Thin shortcut around the generate_release_notes tool. We let the agent
      // do the prose-polishing, so we just hand it a focused instruction with the
      // tool exposed and the user's args forwarded.
      const promptBody = `Generate release notes for this repo using the generate_release_notes tool.
Arguments to interpret: ${arg || '(no args — use defaults: latest tag .. HEAD, scope=user, markdown)'}.

Parsing rules:
- A bare git range like \`a..b\` → from + to
- \`--write\` → write_to_changelog: true
- \`--bump=patch|minor|major\` → bump
- \`--all\` → scope: all
- \`--json\` → format: json

After the tool returns:
1. Show me the markdown (or JSON) verbatim.
2. If anything looks miscategorized, mention which commits and why — do not silently re-bucket.
3. If write_to_changelog or bump produced file writes, confirm what was written.

Never invent commits. If the range is empty, say so and stop.`;
      return {
        handled: true,
        action: {
          type: 'submit_prompt',
          prompt: promptBody,
          commandName: '/release-notes',
          rawInput: trimmed,
          allowedTools: ['generate_release_notes', 'git_log', 'git_diff', 'read_file', 'write_file', 'bash'],
        },
      };
    }

    case 'skills': {
      // List every installed skill (enabled + disabled) with origin and version.
      const all = await listAllSkillsWithState(cwd);
      if (all.length === 0) {
        return {
          handled: true,
          message:
            'No skills installed.\n\n' +
            'Skills are user-installed playbooks the model auto-discovers (taste, ui-ux-pro-max, ghost, OODA, L99, god-mode, artifacts...).\n\n' +
            'Install one from your shell:\n' +
            '  qodex skill install gh:user/skill-repo\n' +
            '  qodex skill install ./path/to/skill-dir\n' +
            '  qodex skill install npm:@qodex/skill-taste\n\n' +
            'Or drop a SKILL.md into ~/.qodex/skills/<name>/ manually.',
        };
      }
      const lines: string[] = [`${all.length} skill${all.length > 1 ? 's' : ''} installed:`, ''];
      for (const s of all) {
        const flag = s.enabled ? '●' : '○';
        const ver = s.version ? ` v${s.version}` : '';
        const tag = `[${s.origin}]`;
        const aliases = s.slashAliases?.length ? ` (slash: ${s.slashAliases.map(a => '/' + a).join(' ')})` : '';
        lines.push(`  ${flag} ${s.name}${ver}  ${tag}${aliases}`);
        lines.push(`      ${s.description}`);
      }
      lines.push('');
      lines.push('Run explicitly: /skill <name> [args]');
      lines.push('Toggle:        /skill enable <name> | /skill disable <name>');
      lines.push('Manage:        `qodex skill install|remove <source>` from your shell');
      return { handled: true, message: lines.join('\n') };
    }

    case 'skill': {
      // /skill                       — show usage
      // /skill <name> [args]         — explicit run (submit_prompt with skill body)
      // /skill enable <name>         — re-enable a disabled user-scope skill
      // /skill disable <name>        — disable a user-scope skill
      // /skill reload                — refresh registry from disk
      const sub = (args[0] ?? '').toLowerCase();
      const target = args[1] ?? '';
      if (!sub) {
        return {
          handled: true,
          message:
            'Usage:\n' +
            '  /skill <name> [args]    run a skill explicitly\n' +
            '  /skill enable <name>    re-enable a disabled user-scope skill\n' +
            '  /skill disable <name>   disable a user-scope skill\n' +
            '  /skill reload           refresh registry from disk after manual edits\n' +
            '  /skills                 list every installed skill\n\n' +
            'Skills are also auto-loadable by the model via the `use_skill` tool.',
        };
      }
      if (sub === 'reload') {
        await refreshSkillRegistry();
        return { handled: true, message: 'Skill registry reloaded.' };
      }
      if (sub === 'enable' || sub === 'disable') {
        if (!target) return { handled: true, message: `Usage: /skill ${sub} <name>` };
        await setSkillEnabled(target, sub === 'enable');
        return { handled: true, message: `Skill "${target}" ${sub}d.` };
      }
      // Explicit run: treat sub as the skill name, everything after as args.
      const spec = getSkill(sub);
      if (!spec) {
        return { handled: true, message: `Unknown skill "${sub}". Try /skills to list installed ones.` };
      }
      const userArgs = args.slice(1).join(' ');
      const promptBody = buildSkillRunPrompt(spec.name, spec.body, userArgs);
      return {
        handled: true,
        action: {
          type: 'submit_prompt',
          prompt: promptBody,
          commandName: `/skill ${spec.name}`,
          rawInput: trimmed,
          allowedTools: spec.allowedTools,
          model: spec.model,
        },
      };
    }

    default: {
      // 1) Skill slash-aliases (e.g. /ghost → use skill "ghost"). Check first so a
      //    skill's alias can't be shadowed by a stale custom-command file.
      const aliases = slashAliasMap();
      const aliasTarget = aliases.get((cmd ?? '').toLowerCase());
      if (aliasTarget) {
        const spec = getSkill(aliasTarget);
        if (spec) {
          const promptBody = buildSkillRunPrompt(spec.name, spec.body, arg);
          return {
            handled: true,
            action: {
              type: 'submit_prompt',
              prompt: promptBody,
              commandName: `/${cmd}`,
              rawInput: trimmed,
              allowedTools: spec.allowedTools,
              model: spec.model,
            },
          };
        }
      }

      // 2) Custom commands from .qodex/commands/*.md. Lazy reload each call so users
      //    can edit/add command files without restarting the agent.
      const customs = await loadCustomCommands(cwd);
      const spec = customs.get(cmd ?? '');
      if (!spec) {
        return { handled: true, message: `Unknown command: /${cmd}. Try /help, /commands, or /skills.` };
      }
      const rendered = renderTemplate(spec.template, arg, { cwd });
      if (rendered.trim().length === 0) {
        return { handled: true, message: `Custom command /${cmd} has an empty template body after interpolation.` };
      }
      return {
        handled: true,
        action: {
          type: 'submit_prompt',
          prompt: rendered,
          commandName: cmd ?? '',
          rawInput: trimmed,
          allowedTools: spec.allowedTools,
          model: spec.model,
          mode: spec.mode,
        },
      };
    }
  }
}

/** Build the prompt sent to the model when a skill is invoked explicitly. */
function buildSkillRunPrompt(name: string, body: string, userArgs: string): string {
  const argsLine = userArgs.trim()
    ? `\n\nUser arguments for this run: ${userArgs.trim()}`
    : '';
  return `The user invoked the **${name}** skill. Follow its playbook below for this turn. Treat these as binding instructions in addition to the system prompt; if a system rule and this skill conflict, ask the user before deviating.${argsLine}\n\n---\n${body}`;
}
