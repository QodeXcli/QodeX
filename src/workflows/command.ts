/**
 * `qodex workflow …` — manage and replay learned browser workflows from the shell.
 *
 *   qodex workflow list                       saved workflows
 *   qodex workflow show <name> [--json]       params + steps
 *   qodex workflow rm <name> [--keep-skill]   delete (and its generated skill)
 *   qodex workflow run <name> [-p k=v]...     replay in the QodeX browser
 *   qodex workflow record <name> [--url u]    demonstrate a task in a visible
 *                                             browser window; Enter saves it
 *
 * Wired into the top-level commander by src/index.ts (`program.addCommand(
 * buildWorkflowCommand())`). It never calls bootstrap: it only needs the config
 * (loaded + activated here) and the browser manager. Prompts use a non-raw
 * readline so Ctrl+C keeps its default meaning (exit) — no SIGINT listener is
 * installed. Replays run with a real ToolContext so Sentinel can ask the person
 * at the terminal before purchases / sending / credential entry.
 */

import { Command } from 'commander';
import * as readline from 'readline';
import type { ToolContext } from '../tools/base.js';
import type { BrowserManager } from '../tools/browser/types.js';
import type { QodexConfig } from '../config/defaults.js';
import { normalizeAnswer, safeOption, setInteractiveHuman } from '../control/approvals.js';
import { getWorkflowRecorder } from './recorder.js';
import { formatReplayReport, runWorkflow } from './replay.js';
import { removeWorkflowSkill, writeWorkflowSkill } from './skillgen.js';
import { WorkflowStore } from './store.js';
import { renderWorkflowDetail, renderWorkflowList } from './tools.js';
import { describeStep, normalizeWorkflowName, type Workflow } from './types.js';

async function loadActiveConfig(): Promise<QodexConfig> {
  const { loadConfig, setActiveConfig } = await import('../config/loader.js');
  const config = await loadConfig(process.cwd());
  setActiveConfig(config);
  return config;
}

async function browser(): Promise<BrowserManager> {
  const { getBrowserManager } = await import('../tools/browser/types.js');
  return getBrowserManager();
}

function fail(msg: string, code = 1): never {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

/** Read one line from stdin ('' on EOF). Non-raw so Ctrl+C still exits the process. */
function readLine(prompt?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    if (prompt) process.stdout.write(prompt);
    let done = false;
    const finish = (v: string) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    rl.once('line', l => finish(l));
    rl.once('close', () => finish(''));
  });
}

const interactive = (): boolean => !!process.stdin.isTTY && !!process.stdout.isTTY;

/** A ToolContext for CLI replays: real permissions + journal, terminal prompts when a human is present. */
async function makeCliContext(config: QodexConfig): Promise<ToolContext & { cleanup: () => Promise<void> }> {
  const { getJournal } = await import('../filesystem/transaction.js');
  const { PermissionEngine } = await import('../security/permissions.js');
  const sessionId = `workflow-cli-${Date.now().toString(36)}`;
  const transaction = await getJournal().begin(sessionId);
  const permissions = new PermissionEngine(config);
  const human = interactive();
  // Sentinel asks the local human first when one is present; otherwise it routes to remote channels or refuses.
  setInteractiveHuman(human);
  let chain: Promise<unknown> = Promise.resolve();
  const askUser = (prompt: string, options: string[] = ['yes', 'no']): Promise<string> => {
    const run = async (): Promise<string> => {
      if (!human) return safeOption(options) ?? 'no';
      for (let i = 0; i < 3; i++) {
        const line = await readLine(`\n${prompt}\n  [${options.join(' / ')}] > `);
        const a = normalizeAnswer(line, options);
        if (a) return a;
        if (!line) break;
        console.log(`  Please answer one of: ${options.join(', ')}`);
      }
      return safeOption(options) ?? 'no';
    };
    const p = chain.then(run, run);
    chain = p.catch(() => undefined);
    return p;
  };
  return {
    cwd: process.cwd(),
    sessionId,
    transaction,
    permissions,
    askUser,
    emit: (ev) => {
      if (ev.type === 'progress') console.log(`  … ${ev.message}`);
    },
    currentTurn: 0,
    cleanup: async () => {
      try { await transaction.commit('workflow run'); } catch { /* nothing journaled */ }
    },
  };
}

function parseParams(kv: string[]): Array<{ name: string; value: string }> {
  return kv.map(item => {
    const i = item.indexOf('=');
    if (i <= 0) fail(`--param expects name=value, got ${JSON.stringify(item)}`);
    return { name: item.slice(0, i).trim(), value: item.slice(i + 1) };
  });
}

function collect(v: string, prev: string[]): string[] {
  return [...prev, v];
}

async function loadOrFail(store: WorkflowStore, name: string): Promise<Workflow> {
  let wf: Workflow | null = null;
  try {
    wf = await store.load(name);
  } catch (e: any) {
    fail(String(e?.message ?? e));
  }
  if (!wf) {
    const all = await store.list().catch(() => []);
    fail(`no workflow named "${normalizeWorkflowName(name) || name}".${all.length ? ` Available: ${all.map(w => w.name).join(', ')}` : ' None saved yet.'}`);
  }
  return wf;
}

export function buildWorkflowCommand(): Command {
  const cmd = new Command('workflow');
  cmd.alias('workflows').description('Record, list and replay browser workflows (learn a task from a demonstration)');

  cmd
    .command('list')
    .alias('ls')
    .description('List saved workflows')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      await loadActiveConfig();
      const store = new WorkflowStore();
      const all = await store.list();
      if (opts.json) console.log(JSON.stringify(all, null, 2));
      else console.log(renderWorkflowList(all, store.dir));
    });

  cmd
    .command('show <name>')
    .description('Show a workflow\'s params and steps')
    .option('--json', 'Print the raw workflow JSON')
    .action(async (name: string, opts: { json?: boolean }) => {
      await loadActiveConfig();
      const store = new WorkflowStore();
      const wf = await loadOrFail(store, name);
      if (opts.json) console.log(JSON.stringify(wf, null, 2));
      else console.log(renderWorkflowDetail(wf, store.filePath(wf.name)));
    });

  cmd
    .command('rm <name>')
    .alias('remove')
    .description('Delete a workflow and the skill generated for it')
    .option('--keep-skill', 'Keep the generated workflow-<name> skill')
    .action(async (name: string, opts: { keepSkill?: boolean }) => {
      await loadActiveConfig();
      const store = new WorkflowStore();
      const id = normalizeWorkflowName(name);
      const removed = id ? await store.remove(id) : false;
      if (!removed) fail(`no workflow named "${id || name}"`);
      const skill = opts.keepSkill ? false : await removeWorkflowSkill(id).catch(() => false);
      console.log(`✓ Removed workflow "${id}"${skill ? ` and skill "workflow-${id}"` : ''}.`);
    });

  cmd
    .command('run <name>')
    .description('Replay a workflow in the QodeX browser')
    .option('-p, --param <name=value>', 'Param value (repeatable). For secrets use name=vault:<entry>', collect, [] as string[])
    .option('--dry-run', 'Validate params and list the steps without opening the browser')
    .option('--use-examples', 'Use recorded example values for params you don\'t pass')
    .option('--start-step <n>', 'Start at step n (1-based)', (v: string) => parseInt(v, 10))
    .option('--headed', 'Show the browser window while replaying')
    .option('--json', 'Print the replay report as JSON')
    .action(async (name: string, opts: { param: string[]; dryRun?: boolean; useExamples?: boolean; startStep?: number; headed?: boolean; json?: boolean }) => {
      const config = await loadActiveConfig();
      const store = new WorkflowStore();
      const wf = await loadOrFail(store, name);
      const params = parseParams(opts.param ?? []);
      if (opts.startStep !== undefined && (!Number.isFinite(opts.startStep) || opts.startStep < 1)) fail('--start-step must be a positive number');

      if (opts.dryRun) {
        const report = await runWorkflow(wf, params, { dryRun: true, startStep: opts.startStep, useExamples: opts.useExamples });
        console.log(opts.json ? JSON.stringify(report, null, 2) : formatReplayReport(report, wf, params, t => t));
        process.exit(report.ok ? 0 : 1);
      }

      let mgr: BrowserManager;
      try {
        mgr = await browser();
        if (opts.headed) await mgr.ensure({ headless: false });
      } catch (e: any) {
        fail(`[BROWSER_UNAVAILABLE] ${String(e?.message ?? e).split('\n')[0]}`);
      }
      const ctx = await makeCliContext(config);
      if (!opts.json) console.log(`▶ Replaying "${wf.name}" (${wf.steps.length} steps)…`);
      const report = await runWorkflow(wf, params, {
        mgr,
        ctx,
        cwd: process.cwd(),
        startStep: opts.startStep,
        useExamples: opts.useExamples,
        onStep: ev => {
          if (opts.json) return;
          if (ev.type === 'waiting') console.log('  … waiting: a human has control of the browser');
          else if (ev.type === 'done' && ev.result) {
            const mark = ev.result.status === 'ok' ? '✓' : ev.result.status === 'skipped' ? '↷' : '✗';
            console.log(`  ${mark} ${ev.step || 'start'}/${ev.total} ${ev.description}`);
          }
        },
      });
      console.log(opts.json ? JSON.stringify(report, null, 2) : '\n' + formatReplayReport(report, wf, params, t => t));
      await ctx.cleanup();
      await mgr.close().catch(() => {});
      process.exit(report.ok ? 0 : 1);
    });

  cmd
    .command('record <name>')
    .description('Demonstrate a task in a visible QodeX browser window and save it as a replayable workflow')
    .option('--url <url>', 'Page to open before recording starts')
    .option('-d, --description <text>', 'What the workflow does (asked for at the end when omitted)')
    .option('--profile <name>', 'Browser profile to use (default: the configured one)')
    .option('--force', 'Replace an existing workflow with the same name')
    .action(async (name: string, opts: { url?: string; description?: string; profile?: string; force?: boolean }) => {
      await loadActiveConfig();
      const store = new WorkflowStore();
      const id = normalizeWorkflowName(name);
      if (!id) fail('a workflow name is required');
      if (!opts.force && await store.exists(id)) fail(`a workflow named "${id}" already exists — use --force to replace it`);
      if (opts.url && !/^https?:\/\//i.test(opts.url)) fail('--url must start with http:// or https://');

      let mgr: BrowserManager;
      try {
        mgr = await browser();
      } catch (e: any) {
        fail(`[BROWSER_UNAVAILABLE] ${String(e?.message ?? e).split('\n')[0]}`);
      }
      try {
        await mgr.restart({ headless: false, ...(opts.profile ? { profile: opts.profile } : {}) });
      } catch (e: any) {
        fail(`could not open a visible browser window: ${String(e?.message ?? e).split('\n')[0]}\n  On a machine without a display, demonstrate through the control center instead (qodex control → Take over) and let the agent record with workflow_record source=human.`);
      }
      if (opts.url) {
        try {
          const page = await mgr.activePage();
          await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        } catch (e: any) {
          console.error(`  (could not fully load ${opts.url}: ${String(e?.message ?? e).split('\n')[0]} — continuing)`);
        }
      }
      const recorder = getWorkflowRecorder();
      try {
        await recorder.start({ name, description: opts.description, source: 'human', mgr, overwrite: !!opts.force });
      } catch (e: any) {
        await mgr.close().catch(() => {});
        fail(String(e?.message ?? e));
      }
      console.log(`● Recording "${id}" — do the task in the QodeX browser window now.`);
      console.log('  Clicks, typing, selections and Enter are captured; password fields are saved as secret params (never their values).');
      console.log('  Press Enter here when you are done (Ctrl+C cancels without saving).');
      await readLine();

      const wf = await recorder.stop();
      if (!wf.steps.length) {
        await mgr.close().catch(() => {});
        fail('nothing replayable was recorded — no clicks, typing or navigation were captured.');
      }
      if (!wf.description && interactive()) {
        wf.description = (await readLine('One-line description of what this workflow does (Enter to skip): ')).trim();
      }
      let saved: Workflow;
      let file: string;
      try {
        const r = await store.save(wf, { overwrite: !!opts.force });
        saved = r.workflow;
        file = r.file;
        recorder.warnings.push(...r.warnings);
      } catch (e: any) {
        await mgr.close().catch(() => {});
        fail(String(e?.message ?? e));
      }
      const skill = await writeWorkflowSkill(saved).catch((e: any) => ({ written: false, name: `workflow-${saved.name}`, reason: String(e?.message ?? e), file: '' }));
      console.log(`\n✓ Saved workflow "${saved.name}" (${saved.steps.length} steps) → ${file}`);
      saved.steps.forEach((s, i) => console.log(`  ${i + 1}. ${describeStep(s)}`));
      if (saved.params.length) console.log(`  Params: ${saved.params.map(p => `${p.name}${p.secret ? ' (secret)' : p.example !== undefined ? ` = ${JSON.stringify(p.example)}` : ''}`).join(', ')}`);
      console.log(skill.written ? `  Skill: ${skill.name} (the agent will find it when you ask for this task again)` : `  Skill not written: ${skill.reason}`);
      for (const w of new Set(recorder.warnings)) console.log(`  Note: ${w}`);
      console.log(`  Replay: qodex workflow run ${saved.name}${saved.params.filter(p => !p.default).map(p => ` -p ${p.name}=…`).join('')}`);
      await mgr.close().catch(() => {});
      process.exit(0);
    });

  return cmd;
}
