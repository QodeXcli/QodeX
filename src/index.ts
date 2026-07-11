/*
 * QodeX — Local-first agentic coding CLI
 * Copyright 2026 7 SEVEN
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { loadConfig, ensureQodexHome, setActiveConfig } from './config/loader.js';
import { ModelRouter } from './llm/router.js';
import { ToolRegistry } from './tools/registry.js';
import { PermissionEngine } from './security/permissions.js';
import { App } from './cli/ui.js';
import { runHeadless } from './cli/modes/headless.js';
import { contractFromFlags } from './agent/autonomy-contract.js';
import { getJournal } from './filesystem/transaction.js';
import { getSessionStore } from './session/store.js';
import { MCPManager, setMCPManager, getMCPManager } from './mcp/manager.js';
import { CodeGraphDB } from './codegraph/schema.js';
import { Indexer } from './codegraph/indexer.js';
import { setCodeGraphDB, setIndexer } from './codegraph/tools.js';
import { HooksManager, setHooksManager } from './hooks/manager.js';
import { initSkillRegistry } from './skills/registry.js';
import { seedBundledSkills } from './skills/seed.js';
import * as path from 'path';
import * as fsSync from 'fs';
import { fileURLToPath } from 'url';
import { logger } from './utils/logger.js';

async function bootstrap(): Promise<{
  config: Awaited<ReturnType<typeof loadConfig>>;
  router: ModelRouter;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  mcpManager: MCPManager;
  codeGraph: CodeGraphDB;
  indexer: Indexer;
  hooks: HooksManager;
}> {
  await ensureQodexHome();
  await logger.init('info');
  logger.info('QodeX starting', { node: process.version, cwd: process.cwd() });

  // Load any API keys stored in ~/.qodex/.env (written by `qodex provider add`) into the
  // environment BEFORE the router reads them. An explicit `export` in the user's shell still
  // wins, so this never overrides a key they set themselves.
  try {
    const { loadEnvFileIntoProcess } = await import('./setup/env-writer.js');
    const n = await loadEnvFileIntoProcess();
    if (n > 0) logger.info(`Loaded ${n} API key(s) from ~/.qodex/.env`);
  } catch (e: any) {
    logger.debug('No ~/.qodex/.env loaded', { err: e?.message });
  }

  // Warm the real BPE tokenizer in the background (gpt-tokenizer, if installed).
  // Non-blocking: token counts use the calibrated heuristic until this resolves.
  void import('./utils/tokenizer.js').then(t => t.warmTokenizer()).catch((err) => logger.debug('tokenizer warm-up failed', { err }));

  const config = await loadConfig(process.cwd());
  // Import Claude Code plugins/standalone assets: agents → dispatchable roles (for the
  // `task` tool + plugin commands like /review-pr), plus plugin-declared MCP servers and
  // hooks. User config always wins on collisions. (Skills/commands are loaded separately
  // by their own loaders.) Disable all of this with QODEX_DISABLE_CLAUDE_PLUGINS=1.
  try {
    const { applyClaudeCodeIntegration } = await import('./integrations/claude-plugins.js');
    const r = await applyClaudeCodeIntegration(config, process.cwd());
    if (r.agents || r.mcp || r.hooks) {
      logger.info('Claude Code integration applied', r);
    }
  } catch (e: any) {
    logger.debug('Claude Code integration skipped', { err: e?.message });
  }
  setActiveConfig(config);
  // Browser CDP attach: if configured, the browser_* tools attach to the user's running
  // browser instead of launching a fresh headless one. (QODEX_BROWSER_CDP_URL env wins.)
  if ((config as any).browser?.cdpUrl) {
    try {
      const { setBrowserCdpUrl } = await import('./tools/browser/session.js');
      setBrowserCdpUrl((config as any).browser.cdpUrl);
    } catch { /* browser module optional */ }
  }
  const router = new ModelRouter(config);
  const registry = new ToolRegistry();
  const permissions = new PermissionEngine(config);

  // Code graph — project-local SQLite
  const qodexProjectDir = path.join(process.cwd(), '.qodex');
  try { fsSync.mkdirSync(qodexProjectDir, { recursive: true }); } catch (err) { logger.warn('Failed to create project .qodex dir', { dir: qodexProjectDir, err }); }
  const codeGraph = new CodeGraphDB(path.join(qodexProjectDir, 'codegraph.db'));
  const indexer = new Indexer(codeGraph, process.cwd());
  setCodeGraphDB(codeGraph);
  setIndexer(indexer);

  // Lifecycle hooks — load before MCP so SessionStart hooks see a clean environment
  const hooks = new HooksManager(config.hooks ?? {});
  setHooksManager(hooks);

  // Start MCP manager (non-blocking on individual failures)
  const mcpManager = new MCPManager(config.mcp ?? { servers: {} }, registry);
  setMCPManager(mcpManager);

  // Seed bundled skills into ~/.qodex/skills on first run (idempotent — does NOT
  // overwrite skills the user has installed or edited). Then load the registry
  // so buildSystemPrompt and the use_skill tool see them.
  await seedBundledSkills();
  await initSkillRegistry(process.cwd());

  // Router init must finish before the first turn can route to a model.
  await router.initialize();

  // MCP startup runs in the BACKGROUND so a slow or failing server (e.g. a remote
  // MCP behind a ~10s initialize handshake) doesn't block the first turn. Servers
  // register their tools into the shared registry when ready; a turn that fires
  // before a given server is up simply doesn't see its tools yet (fail soft).
  // Per-server errors are already swallowed inside startAll (Promise.allSettled);
  // the catch here guards against an unexpected throw in the aggregate.
  void mcpManager.startAll().catch(err => logger.warn(`MCP background startup error: ${err?.message ?? err}`));

  // Graceful shutdown — also fires SessionEnd hooks
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down...');
    try {
      if (hooks.hasAny('SessionEnd')) {
        await hooks.dispatch('SessionEnd', { event: 'SessionEnd', sessionId: 'shutdown', cwd: process.cwd() });
      }
    } catch (err) { logger.debug('SessionEnd hook failed', { err }); }
    try {
      const m = getMCPManager();
      if (m) await m.stopAll();
    } catch {}
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { config, router, registry, permissions, mcpManager, codeGraph, indexer, hooks };
}

const program = new Command();

// Read the version from package.json at runtime. Previously this was a hardcoded string that we
// kept forgetting to bump, so `qodex --version` reported a stale number (1.22.0) for ~50 releases
// even though the freshly-built dist was current — a confusing red herring. Resolve relative to this
// module (dist/index.js → ../package.json), with a safe fallback if the file can't be read.
function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fsSync.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

program
  .name('qodex')
  .description('QodeX — Local-first agentic coding CLI')
  .version(readVersion())
  .argument('[prompt...]', 'Initial prompt (omit to launch interactive REPL)')
  .option('-p, --print <prompt>', 'Run a single prompt non-interactively and exit')
  .option('--json', 'When used with --print, emit NDJSON events to stdout')
  .option('-y, --yes', 'Auto-approve all permission prompts (headless mode only)')
  // ── Guardrailed autonomy contract (headless -p only) ──
  .option('--budget-tokens <n>', 'Kill the run after N total (novel) tokens; triggers rollback-on-fail')
  .option('--budget-usd <n>', 'Kill the run after $N spend; triggers rollback-on-fail')
  .option('--max-wall <sec>', 'Stall-aware wall-clock ceiling in seconds (slow ≠ runaway; fires only when also stalled)')
  .option('--scope <path-prefix>', 'Deny agent edits outside this path prefix (pre-write gate on journaled writes)')
  .option('--verify <cmd>', 'Shell command run after the agent finishes; non-zero exit = failed run')
  .option('--rollback-on-fail', "Roll back all session writes when the run fails (default ON when --verify or a budget is set). NOTE: session-scoped — with -r/--resume this also reverts earlier turns' journaled writes, not just this run's")
  .option('-m, --model <id>', 'Override default model (e.g. qwen2.5-coder:32b, claude-sonnet-4-6, gpt-4o)')
  .option('-r, --resume <id>', 'Resume an existing session by id prefix')
  .option('-c, --continue', 'Resume the most recent session in this directory (no id needed)')
  .option('--list-models', 'List available models from all providers and exit')
  .option('--list-sessions', 'List recent sessions and exit')
  .action(async (promptArgs: string[], opts: any) => {
    // First-run check: if no config exists and we're interactive, suggest the wizard
    // (don't block — user can press Ctrl+C and proceed with defaults if they want).
    const { configExists } = await import('./setup/wizard.js');
    if (!(await configExists()) && process.stdin.isTTY && process.env.QODEX_SKIP_SETUP !== '1' && !opts.print) {
      console.log('First run detected — no config at ~/.qodex/config.yaml');
      console.log('Running setup wizard (one minute). Press Ctrl+C to skip and use defaults.');
      console.log('');
      try {
        const { runSetup } = await import('./setup/wizard.js');
        await runSetup({});
      } catch (e: any) {
        if (e?.message?.includes('SIGINT') || e?.code === 'ABORT_ERR') {
          console.log('\nSkipped setup. Using defaults. Run `qx setup` anytime.');
        } else {
          console.log(`\nSetup error: ${e?.message ?? e}. Continuing with defaults.`);
        }
      }
    }

    const { config, router, registry, permissions } = await bootstrap();

    if (opts.listModels) {
      const models = router.listAvailableModels();
      if (models.length === 0) {
        console.log('No models available.');
        console.log('  - Start Ollama: ollama serve');
        console.log('  - Or set ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY');
        return;
      }
      console.log('Available models:');
      for (const m of models) {
        // Price by the model's OWN cost metadata, not the provider: a local server
        // (LM Studio under the openai provider) also lists hardcoded cloud models,
        // so provider-level "local" would mislabel them. cost 0 / undefined = free
        // (local & user-added models carry no cost); a positive cost = paid cloud.
        const inCost = m.info.inputCostPerMillion;
        const price = (inCost == null || inCost === 0)
          ? '(local, free)'
          : `($${inCost}/$${m.info.outputCostPerMillion} per M)`;
        console.log(`  ${m.provider}/${m.model}  ctx=${(m.info.contextWindow / 1000).toFixed(0)}k  ${price}  tools=${m.info.supportsToolCalls ? 'yes' : 'no'}`);
      }
      return;
    }

    if (opts.listSessions) {
      const sessions = getSessionStore().listRecentSessions(20, process.cwd());
      if (sessions.length === 0) {
        console.log('No sessions in this directory.');
        return;
      }
      console.log('Recent sessions:');
      for (const s of sessions) {
        const title = s.title ?? '(untitled)';
        console.log(`  ${s.id.slice(0, 8)}  ${new Date(s.updated_at).toLocaleString()}  ${s.turn_count} turns  $${s.total_cost_usd.toFixed(3)}  — ${title}`);
      }
      return;
    }

    // Resolve resume session id from prefix
    let resumeSessionId: string | undefined;
    if (opts.resume) {
      const all = getSessionStore().listRecentSessions(100);
      const match = all.find(s => s.id.startsWith(opts.resume));
      if (!match) {
        console.error(`Session not found matching prefix: ${opts.resume}`);
        process.exit(1);
      }
      resumeSessionId = match.id;
    } else if (opts.continue) {
      // --continue: pick up the most recent session in THIS directory, no id needed.
      const recent = getSessionStore().listRecentSessions(1, process.cwd());
      if (recent.length === 0) {
        console.error('No prior session in this directory to continue. Start one with `qodex`.');
        process.exit(1);
      }
      resumeSessionId = recent[0]!.id;
    }

    // Guardrailed autonomy contract — headless-only flags fused into one object.
    // null when none of the flags were given, so plain runs stay on the exact old path.
    const contract = contractFromFlags({
      budgetTokens: opts.budgetTokens,
      budgetUsd: opts.budgetUsd,
      maxWall: opts.maxWall,
      scope: opts.scope,
      verify: opts.verify,
      rollbackOnFail: opts.rollbackOnFail,
    });
    if (contract && !opts.print) {
      console.error('--budget-tokens/--budget-usd/--max-wall/--scope/--verify/--rollback-on-fail require headless mode (-p/--print).');
      process.exit(1);
    }

    // Headless mode
    if (opts.print) {
      const code = await runHeadless({
        cwd: process.cwd(),
        config,
        router,
        registry,
        permissions,
        prompt: opts.print,
        json: !!opts.json,
        autoApproveAll: !!opts.yes,
        explicitModel: opts.model,
        resumeSessionId,
        contract: contract ?? undefined,
      });
      process.exit(code);
    }

    // Interactive mode
    const initialPrompt = promptArgs && promptArgs.length > 0 ? promptArgs.join(' ') : undefined;

    if (router.listAvailableModels().length === 0) {
      console.error('\n⚠ No models available.\n');
      console.error('Start a local model:');
      console.error('  ollama serve');
      console.error('  ollama pull qwen2.5-coder:32b\n');
      console.error('Or set a cloud API key:');
      console.error('  export ANTHROPIC_API_KEY=...');
      console.error('  export OPENAI_API_KEY=...');
      console.error('  export DEEPSEEK_API_KEY=...\n');
      process.exit(1);
    }

    // Interactive REPL resilience: a stray async rejection — e.g. a deep
    // dependency's wasm loader floating an ENOENT outside any awaited promise —
    // must NOT take down the whole session. Log it (to the log file, never to the
    // TUI surface) and keep the REPL alive. Scoped to interactive mode only;
    // headless/scheduled runs keep Node's default behaviour so real failures
    // still surface as non-zero exits.
    process.on('unhandledRejection', (reason: any) => {
      logger.error('Unhandled promise rejection (REPL kept alive)', {
        err: reason?.message ?? String(reason),
        stack: reason?.stack,
      });
    });

    let activeSessionId: string | undefined;
    // Warm the local default model in the background so the first prompt isn't a cold load.
    // Non-blocking: the UI renders immediately while the model loads into memory.
    if (config.defaults.warmOnStart !== false) {
      void import('./llm/warmup.js').then(m => m.warmModel(router, config)).catch(() => {});
    }
    const { waitUntilExit } = render(
      React.createElement(App, {
        cwd: process.cwd(),
        config,
        router,
        registry,
        permissions,
        initialPrompt,
        resumeSessionId,
        explicitModel: opts.model,
        onSessionActive: (id: string) => { activeSessionId = id; },
      }),
    );
    await waitUntilExit();
    if (activeSessionId) {
      const short = activeSessionId.slice(0, 8);
      console.log(`\nResume this session with:  qodex --resume ${short}   (or: qodex --continue)`);
    }
  });

// Subcommands
program
  .command('undo [count]')
  .description('Roll back the last N transactions in the most recent session')
  .action(async (count?: string) => {
    await bootstrap();
    const n = parseInt(count ?? '1') || 1;
    const sessions = getSessionStore().listRecentSessions(1, process.cwd());
    if (sessions.length === 0) {
      console.log('No sessions to undo in this directory.');
      return;
    }
    const result = await getJournal().rollbackLast(sessions[0]!.id, n);
    console.log(`Rolled back ${result.txnsRolled} transactions, restored ${result.filesRestored} files.`);
  });

program
  .command('sessions')
  .description('List recent sessions')
  .action(async () => {
    await bootstrap();
    const sessions = getSessionStore().listRecentSessions(20, process.cwd());
    if (sessions.length === 0) {
      console.log('No sessions.');
      return;
    }
    for (const s of sessions) {
      console.log(`  ${s.id.slice(0, 8)}  ${new Date(s.updated_at).toLocaleString()}  ${s.turn_count} turns  $${s.total_cost_usd.toFixed(3)}`);
    }
  });

program
  .command('index')
  .description('Build/refresh the code graph for the current directory (symbols, AST)')
  .option('-f, --force', 'Re-index every file, ignoring mtime cache')
  .action(async (opts: any) => {
    const { indexer, codeGraph, mcpManager } = await bootstrap();
    console.log('Indexing code graph...');
    let lastTick = Date.now();
    const result = await indexer.indexAll({
      force: !!opts.force,
      onProgress: ({ processed, total, currentFile }) => {
        if (Date.now() - lastTick < 150) return;
        lastTick = Date.now();
        process.stdout.write(`\r  ${processed}/${total}  ${currentFile?.slice(0, 60) ?? ''}                    `);
      },
    });
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    console.log(`✓ Indexed ${result.filesIndexed} file(s), skipped ${result.filesSkipped}, removed ${result.filesRemoved}.`);
    console.log(`  Total symbols: ${result.symbolCount}`);
    console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Stats: ${JSON.stringify(codeGraph.stats())}`);
    await mcpManager.stopAll();
    process.exit(0);
  });

program
  .command('impact <target>')
  .description('Blast-radius analysis for a file or symbol: references, caller files, covering tests (from the code graph)')
  .option('--json', 'Print machine-readable JSON instead of the summary line')
  .action(async (target: string, _opts: any, cmd: any) => {
    // optsWithGlobals(): merge local flags with root-level ones so a future global
    // flag doesn't silently vanish here (same pattern as `mcp serve` / `provider add`).
    const opts = cmd.optsWithGlobals() as { json?: boolean };
    const dbPath = path.join(process.cwd(), '.qodex', 'codegraph.db');
    if (!fsSync.existsSync(dbPath)) {
      console.error('No code graph found at .qodex/codegraph.db — run `qodex index` first.');
      process.exit(1);
    }
    const db = new CodeGraphDB(dbPath);
    const { computeBlastRadius } = await import('./agent/blast-radius.js');

    // Resolve the target: an existing file → file mode; otherwise an indexed symbol,
    // analyzed in the file where it's defined.
    const asFile = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    let fileAbs: string;
    let symbolFilter: string[] | undefined;
    if (fsSync.existsSync(asFile) && fsSync.statSync(asFile).isFile()) {
      fileAbs = asFile;
    } else {
      const defs = db.findSymbolsByName(target);
      if (defs.length === 0) {
        console.error(`"${target}" is neither an existing file nor an indexed symbol. Run \`qodex index\` to refresh the graph.`);
        process.exit(1);
      }
      fileAbs = defs[0]!.file_path;
      symbolFilter = [target];
      if (defs.length > 1) {
        console.log(`(symbol defined in ${defs.length} places — analyzing ${path.relative(process.cwd(), fileAbs)})`);
      }
    }
    const impact = await computeBlastRadius(db, fileAbs, {
      cwd: process.cwd(),
      symbolFilter,
      maxGraphAgeMs: Number.POSITIVE_INFINITY, // standalone: always answer, even from an old graph
      maxChars: 2000, // terminal gets a roomier cap than the edit-loop note
    });
    if (opts.json) {
      console.log(JSON.stringify(impact, null, 2));
    } else if (!impact.note) {
      console.log(`No impact data for ${path.relative(process.cwd(), fileAbs)} — the file has no indexed top-level symbols (run \`qodex index\` to refresh).`);
    } else {
      console.log(impact.note);
    }
    process.exit(0);
  });

program
  .command('config')
  .description('Show effective configuration')
  .action(async () => {
    const config = await loadConfig(process.cwd());
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command('bot')
  .description('Run the Telegram/Discord/Slack bot front-end (drives the agent from chat)')
  .option('--telegram', 'start only Telegram')
  .option('--discord', 'start only Discord')
  .option('--slack', 'start only Slack')
  .action(async (opts: { telegram?: boolean; discord?: boolean; slack?: boolean }) => {
    const { config, router, registry, permissions } = await bootstrap();
    const { startBots } = await import('./bot/start.js');
    await startBots({ config, router, registry, permissions, cwd: process.cwd() }, opts);
  });

program
  .command('dashboard')
  .alias('dash')
  .description('Open a live CONTROL dashboard — view AND change providers, settings, memory, schedules, offloading')
  .option('--static', 'Write a read-only HTML snapshot instead of starting the control server')
  .action(async (opts: { static?: boolean }) => {
    if (opts.static) {
      const { writeStaticDashboard } = await import('./cli/dashboard.js');
      const out = await writeStaticDashboard(process.cwd());
      console.log(`\n📊 QodeX dashboard (read-only) → ${out}\n`);
      process.exit(0);
    }
    const { runDashboard } = await import('./cli/dashboard.js');
    const url = await runDashboard(process.cwd());
    console.log(`\n📊 QodeX control dashboard → ${url}`);
    console.log('   Live & local (127.0.0.1, token-protected). Toggle settings, manage schedules,');
    console.log('   forget facts, apply offloading — changes hit your real config. Ctrl-C to stop.\n');
    const shutdown = () => process.exit(0);
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
    await new Promise<never>(() => {}); // keep the server alive
  });

const mcpCmd = program
  .command('mcp')
  .description('Manage MCP servers (status, catalog, add, remove)');

mcpCmd
  .command('status', { isDefault: true })
  .description('Show MCP server status')
  .action(async () => {
    const { mcpManager } = await bootstrap();
    const statuses = mcpManager.status();
    if (statuses.length === 0) {
      console.log('No MCP servers configured.\n');
      console.log('Add a well-known one:  qodex mcp add github');
      console.log('See the catalog:       qodex mcp catalog');
      process.exit(0);
    }
    for (const s of statuses) {
      const icon = s.state === 'ready' ? '✓' : s.state === 'failed' ? '✗' : '…';
      console.log(`${icon} ${s.name}  state=${s.state}  tools=${s.toolCount}  transport=${s.transport}${s.error ? `  err="${s.error}"` : ''}`);
    }
    await mcpManager.stopAll();
    process.exit(0);
  });

mcpCmd
  .command('serve')
  .description('Run QodeX AS an MCP server (stdio) — expose its tools to editors like Cursor/Zed/VS Code')
  .option('--tools <names>', 'Comma-separated registry tools to expose (explicit allowlist)')
  .option('--scope <scope>', "Exposure scope: 'safe' (read-only, default), 'all', or omit to use config")
  .action(async (_opts: unknown, cmd: Command) => {
    // optsWithGlobals(): the root command also defines --scope (the autonomy-contract
    // path-prefix), and commander's default (non-positional) parsing lets the PARENT
    // swallow `--scope safe|all` even when written after the subcommand — local opts
    // arrive empty and exposure silently falls back to config. Under config expose
    // 'all', a user asking for --scope safe would get write-capable tools. Same gotcha
    // as --model/--json; see `provider add`.
    const opts = cmd.optsWithGlobals() as { tools?: string; scope?: string };
    // IMPORTANT: stdout is the protocol channel — no console.log here, ever.
    const { config, registry } = await bootstrap();
    const { QodexMcpServer } = await import('./mcp/server/server.js');
    // --tools (explicit list) takes priority; else --scope ('safe'|'all'); else config.
    let exposeTools: string[] | 'safe' | 'all' | undefined;
    if (opts.tools) exposeTools = opts.tools.split(',').map(s => s.trim()).filter(Boolean);
    else if (opts.scope === 'safe' || opts.scope === 'all') exposeTools = opts.scope;
    const server = new QodexMcpServer({ registry, config, cwd: process.cwd(), exposeTools: exposeTools as any });
    server.start();
    // Keep the process alive; server exits on stdin 'end' or 'exit' method.
  });

mcpCmd
  .command('catalog')
  .description('List well-known MCP servers you can add with one command')
  .action(async () => {
    const { listMcpSpecs } = await import('./mcp/registry.js');
    const specs = listMcpSpecs();
    console.log(`${specs.length} well-known MCP servers:\n`);
    for (const s of specs) {
      const authTag = s.auth === 'oauth' ? 'OAuth (browser)' :
        s.auth === 'token' ? `token: ${s.credentials[0]?.envVar ?? '?'}` :
        s.auth === 'connstr' ? 'connection string' : 'no auth';
      const danger = s.destructive ? '  ⚠ can modify external state' : '';
      console.log(`  ${s.id.padEnd(20)} ${s.title}`);
      console.log(`  ${' '.repeat(20)} ${s.description}`);
      console.log(`  ${' '.repeat(20)} transport=${s.transport}  auth=${authTag}${danger}`);
      console.log('');
    }
    console.log('Add one with:  qodex mcp add <id>     (e.g. qodex mcp add sentry)');
    process.exit(0);
  });

mcpCmd
  .command('add <id>')
  .description('Add a well-known MCP server to your config (prompts for any needed token)')
  .option('--token <value>', 'Provide the API token/secret non-interactively')
  .option('--inline', 'Write the literal token into config.yaml instead of a ${ENV_VAR} reference (less safe)')
  .option('--as <name>', 'Use a custom config key instead of the default id')
  .action(async (id: string, opts: { token?: string; inline?: boolean; as?: string }) => {
    const { findMcpSpec } = await import('./mcp/registry.js');
    const { addServerToConfig } = await import('./mcp/config-writer.js');
    const spec = findMcpSpec(id);
    if (!spec) {
      console.error(`✗ Unknown server "${id}". Run \`qodex mcp catalog\` to see available ids.`);
      process.exit(1);
    }

    // Gather secrets.
    const secrets: Record<string, string> = {};
    const needsSecret = spec.credentials.length > 0;
    if (needsSecret) {
      const cred = spec.credentials[0]!;
      let value = opts.token;
      if (!value) {
        // Prompt interactively.
        const readline = await import('readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log(`\n${spec.title} needs: ${cred.label}`);
        console.log(`  ${cred.hint}\n`);
        value = (await rl.question(`Paste ${cred.envVar} (or leave blank to set the env var yourself later): `)).trim();
        rl.close();
      }
      if (value) secrets[cred.envVar] = value;
    }

    const { id: writtenId, entry } = await addServerToConfig(spec, {
      secrets,
      inlineToken: opts.inline,
      asId: opts.as,
    });

    console.log(`\n✓ Added "${writtenId}" to ~/.qodex/config.yaml`);
    if (spec.auth === 'oauth') {
      console.log(`\n  This server uses OAuth. On the next \`qodex\` launch it will open your browser to authorize. Nothing else to do.`);
    } else if (needsSecret) {
      const cred = spec.credentials[0]!;
      if (opts.inline && secrets[cred.envVar]) {
        console.log(`\n  ⚠ Token written literally into config.yaml. Don't commit that file.`);
      } else if (secrets[cred.envVar]) {
        console.log(`\n  Config references \${${cred.envVar}}. Export it so QodeX can read it:`);
        console.log(`    echo 'export ${cred.envVar}="${'*'.repeat(8)}"' >> ~/.zshrc && source ~/.zshrc`);
        console.log(`  (Your pasted value is NOT stored in config — only the reference is.)`);
        console.log(`\n  Tip: paste with --inline to store it in config.yaml directly instead.`);
      } else {
        console.log(`\n  No token provided. Set it before launching:`);
        console.log(`    export ${cred.envVar}="your-token"   # add to ~/.zshrc to persist`);
      }
    }
    if (spec.note) console.log(`\n  Note: ${spec.note}`);
    if (spec.docs) console.log(`  Docs: ${spec.docs}`);
    console.log(`\n  Launch \`qodex\` and run /mcp to verify the connection.`);
    process.exit(0);
  });

mcpCmd
  .command('remove <id>')
  .alias('rm')
  .description('Remove an MCP server from your config')
  .action(async (id: string) => {
    const { removeServerFromConfig } = await import('./mcp/config-writer.js');
    const removed = await removeServerFromConfig(id);
    if (removed) console.log(`✓ Removed "${id}" from ~/.qodex/config.yaml`);
    else console.log(`(no server "${id}" in config)`);
    process.exit(0);
  });

const providerCmd = program
  .command('provider')
  .description('Manage LLM providers (list known gateways, add one, remove one)');

providerCmd
  .command('list')
  .description('List known OpenAI-compatible gateways you can add (OpenRouter, Gemini, Groq, …)')
  .action(async () => {
    const { KNOWN_GATEWAYS, listGatewayIds } = await import('./setup/gateways.js');
    console.log('\nKnown gateways (add with `qodex provider add <id>`):\n');
    for (const id of listGatewayIds()) {
      const g = KNOWN_GATEWAYS[id];
      console.log(`  ${id.padEnd(12)} ${g.title}`);
      console.log(`  ${' '.repeat(12)} key: ${g.apiKeyEnv}  ·  ${g.baseUrl}`);
      if (g.note) console.log(`  ${' '.repeat(12)} note: ${g.note}`);
      console.log('');
    }
    console.log('Not listed? Add any OpenAI-compatible endpoint:');
    console.log('  qodex provider add <name> --base-url <url> --key-env <ENV_VAR> [--model <id>]\n');
    process.exit(0);
  });

providerCmd
  .command('add [id]')
  .description('Add a provider to ~/.qodex/config.yaml. Run with no id for a guided setup that asks for your key.')
  .option('--base-url <url>', 'OpenAI-compatible base URL (for a gateway not in the known list)')
  .option('--key-env <ENV_VAR>', 'Env var holding the API key (for an unlisted gateway)')
  .option('--model <id>', 'Pin a specific model id (otherwise the gateway default / auto-discovery is used)')
  .option('--context <n>', 'Context window for the pinned model', (v) => parseInt(v, 10))
  .option('--no-tools', 'Mark the pinned model as NOT supporting tool calls')
  .option('--default', 'Also set this provider+model as the default')
  .action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
    // optsWithGlobals(): the root command also defines `-m, --model`, and commander's default
    // (non-positional) parsing lets the PARENT swallow `--model <id>` even when it's written after
    // the subcommand — the local opts arrive empty and the value lands in program.opts() instead.
    // Merging globals back in recovers it. Same gotcha for every subcommand flag that shadows a
    // root global (--model, --json); see `offload`, `tokens`, `schedule add`, `schedule tick`.
    const opts = cmd.optsWithGlobals() as { baseUrl?: string; keyEnv?: string; model?: string; context?: number; tools?: boolean; default?: boolean };
    const { findGateway, buildCustomEntry } = await import('./setup/gateways.js');
    const { addProviderToConfig } = await import('./setup/provider-writer.js');
    const { isInteractiveTTY } = await import('./setup/prompt.js');

    // Guided path: no id at all, OR a known gateway with no overriding flags, on a real TTY.
    // This is the friendly "pick a provider → paste your key → done" flow.
    const hasExplicitFlags = !!(opts.baseUrl || opts.keyEnv || opts.model || opts.context || opts.default);
    const knownOrEmpty = !id || !!findGateway(id);
    if (isInteractiveTTY() && knownOrEmpty && !hasExplicitFlags) {
      const { interactiveAddProvider } = await import('./setup/provider-add-interactive.js');
      try {
        const r = await interactiveAddProvider(id);
        process.exit(r ? 0 : 1);
      } catch (e: any) {
        console.error(`✗ ${e?.message ?? e}`);
        process.exit(1);
      }
    }

    if (!id) {
      console.error('✗ Provide a provider id, or run `qodex provider add` in a terminal for guided setup.');
      console.error('  Known gateways:  qodex provider list');
      process.exit(1);
    }

    const spec = findGateway(id);
    let entry;
    try {
      if (spec) {
        entry = buildCustomEntry({
          spec,
          modelId: opts.model,
          contextWindow: opts.context,
          toolCalls: opts.tools,
        });
      } else {
        // Unlisted gateway — require the explicit fields.
        if (!opts.baseUrl || !opts.keyEnv) {
          console.error(`✗ "${id}" isn't a known gateway. Either pick one from \`qodex provider list\`,`);
          console.error(`  or add it explicitly:`);
          console.error(`  qodex provider add ${id} --base-url <url> --key-env <ENV_VAR> [--model <id>]`);
          process.exit(1);
        }
        entry = buildCustomEntry({
          name: id,
          baseUrl: opts.baseUrl,
          apiKeyEnv: opts.keyEnv,
          modelId: opts.model,
          contextWindow: opts.context,
          toolCalls: opts.tools,
        });
      }
    } catch (e: any) {
      console.error(`✗ ${e?.message ?? e}`);
      process.exit(1);
    }

    const res = await addProviderToConfig(entry, {
      setDefault: opts.default,
      defaultModel: opts.model,
    });

    console.log(`\n✓ Added provider "${res.name}" to ${res.configPath} (your other providers are untouched).`);
    const keyEnv = entry.apiKeyEnv;
    console.log(`\n  Export your key so QodeX can read it:`);
    console.log(`    export ${keyEnv}="your-key-here"      # add to ~/.zshrc to persist`);
    if (spec?.keyHint) console.log(`    ${spec.keyHint}`);
    if (spec?.note) console.log(`\n  Note: ${spec.note}`);
    if (res.setDefault) {
      console.log(`\n  Default model is now ${entry.models?.[0]?.id ?? entry.name}.`);
    } else {
      console.log(`\n  Use it with:  qodex --model ${entry.name}/${entry.models?.[0]?.id ?? '<model-id>'}`);
    }
    console.log(`\n  Verify with:  qodex --list-models\n`);
    process.exit(0);
  });

providerCmd
  .command('remove <name>')
  .alias('rm')
  .description('Remove a custom provider from ~/.qodex/config.yaml')
  .action(async (name: string) => {
    const fs = await import('fs/promises');
    const yaml = await import('js-yaml');
    const { QODEX_CONFIG_FILE } = await import('./config/defaults.js');
    let raw = '';
    try { raw = await fs.readFile(QODEX_CONFIG_FILE, 'utf-8'); } catch {
      console.log('(no config file yet)'); process.exit(0);
    }
    const cfg: any = raw.trim() ? (yaml.load(raw) ?? {}) : {};
    const custom = cfg?.providers?.custom;
    if (!Array.isArray(custom) || !custom.some((c: any) => c?.name === name)) {
      console.log(`(no custom provider "${name}" in config)`); process.exit(0);
    }
    cfg.providers.custom = custom.filter((c: any) => c?.name !== name);
    const { writeFileAtomic } = await import('./utils/atomic-write.js');
    await writeFileAtomic(QODEX_CONFIG_FILE, yaml.dump(cfg, { lineWidth: 100, noRefs: true }));
    console.log(`✓ Removed custom provider "${name}".`);
    process.exit(0);
  });

program
  .command('maintain-demo')
  .description('Open a self-contained "Maintain in action" demo page (the self-improvement loop, visually)')
  .option('--markdown', 'emit a shareable Markdown writeup instead of opening the interactive page')
  .option('--pdf', 'write a shareable one-page PDF instead of opening the interactive page')
  .option('-o, --out <file>', 'with --markdown/--pdf, write to this file (PDF default: ~/.qodex/maintain-demo.pdf)')
  .action(async (opts: { markdown?: boolean; pdf?: boolean; out?: string }) => {
    if (opts.markdown) {
      const { buildMaintainDemoMarkdown } = await import('./cli/maintain-demo.js');
      const md = buildMaintainDemoMarkdown();
      if (opts.out) { const { promises: fs } = await import('fs'); await fs.writeFile(opts.out, md); console.log(`\n📝 Maintain writeup → ${opts.out}\n`); }
      else console.log(md);
      process.exit(0);
    }
    if (opts.pdf) {
      const { buildMaintainDemoPdfBlocks } = await import('./cli/maintain-demo.js');
      const { buildPdf } = await import('./cli/pdf-lite.js');
      const { QODEX_HOME } = await import('./config/defaults.js');
      const { promises: fs } = await import('fs');
      const path = await import('path');
      const out = opts.out ?? path.join(QODEX_HOME, 'maintain-demo.pdf');
      await fs.mkdir(path.dirname(out), { recursive: true }).catch(() => {});
      await fs.writeFile(out, Buffer.from(buildPdf(buildMaintainDemoPdfBlocks()), 'latin1'));
      console.log(`\n📄 Maintain one-pager → ${out}\n`);
      process.exit(0);
    }
    const { runMaintainDemo } = await import('./cli/maintain-demo.js');
    const out = await runMaintainDemo();
    console.log(`\n🎬 Maintain demo → ${out}\n   Opened in your browser.\n`);
    process.exit(0);
  });

program
  .command('maintain-report')
  .description('Self-Improvement Report — real receipt-backed numbers; --markdown for PRs, --pdf for a shareable one-pager')
  .option('--markdown', 'emit the report as Markdown (paste into a PR / issue / team chat)')
  .option('--pdf', 'write the report as a one-page PDF (real bar chart for the 8-week trend)')
  .option('-o, --out <file>', 'with --markdown/--pdf, write to this file (PDF default: ~/.qodex/maintain-report.pdf)')
  .action(async (opts: { markdown?: boolean; pdf?: boolean; out?: string }) => {
    const { getScheduleStore } = await import('./schedule/store.js');
    const { parseMaintainScope, MAINTAIN_SCOPES } = await import('./schedule/recipes.js');
    const { buildMaintainStats, weeklyReport, recommendNextScope, trendByWeek, projectMonthly, forecastTrend } = await import('./cli/maintain-stats.js');
    const store = getScheduleStore();
    const runs: import('./cli/maintain-stats.js').MaintainRun[] = [];
    for (const s of store.list().filter((s: any) => s.recipe === 'maintain')) {
      const scope = parseMaintainScope(s.prompt).scope;
      for (const r of store.recentRuns(s.id, 100)) {
        let status = r.status ?? 'running'; let files = 0;
        if (r.receipt) { try { const rc = JSON.parse(r.receipt); status = rc.status ?? status; files = (rc.filesChanged ?? []).length; } catch { /* ignore */ } }
        runs.push({ scope, status, filesChanged: files, when: '', at: r.started_at });
      }
    }
    const now = Date.now();
    const stats = buildMaintainStats(runs);
    const wk = weeklyReport(runs, now);
    const next = recommendNextScope(runs, stats, MAINTAIN_SCOPES);
    const proj = projectMonthly(runs, now);
    const fc = forecastTrend(runs, now);
    const trend = trendByWeek(runs, now);

    // Export paths: the SAME data through the PURE exporters — report can't disagree across formats.
    if (opts.markdown || opts.pdf) {
      const { buildMaintainReportMarkdown, buildMaintainReportPdfBlocks } = await import('./cli/maintain-report-export.js');
      const data = {
        generatedAt: new Date(now).toISOString().slice(0, 10),
        project: process.cwd().split(/[\\/]/).filter(Boolean).pop(),
        stats, weekly: wk, trend, forecast: fc, projection: proj, next,
      };
      if (opts.markdown) {
        const md = buildMaintainReportMarkdown(data);
        if (opts.out) { const { promises: fs } = await import('fs'); await fs.writeFile(opts.out, md); console.log(`\n📝 Report → ${opts.out}\n`); }
        else console.log(md);
        process.exit(0);
      }
      const { buildPdf } = await import('./cli/pdf-lite.js');
      const { QODEX_HOME } = await import('./config/defaults.js');
      const path = await import('path');
      const { promises: fs } = await import('fs');
      const out = opts.out ?? path.join(QODEX_HOME, 'maintain-report.pdf');
      await fs.mkdir(path.dirname(out), { recursive: true }).catch(() => {});
      await fs.writeFile(out, Buffer.from(buildPdf(buildMaintainReportPdfBlocks(data)), 'latin1'));
      console.log(`\n📄 Report → ${out}\n`);
      process.exit(0);
    }

    const spark = (() => { const t = trend; const max = Math.max(1, ...t); const b = '▁▂▃▄▅▆▇█'; return t.map(n => b[Math.min(7, Math.round((n / max) * 7))]).join(''); })();
    console.log('\n🔧 QodeX Self-Improvement Report\n');
    if (stats.totalRuns === 0) { console.log('  No maintain runs yet. `qodex schedule add --recipe maintain --prompt "unused-imports"`.\n'); process.exit(0); }
    console.log(`  All time:   ${stats.opened} cleanup PR(s) · ${stats.blocked} safely blocked · ${stats.filesCleaned} files cleaned · ~${stats.estMinutesSaved} min saved`);
    console.log(`  This week:  ${wk.opened} PR(s) · ${wk.filesCleaned} files · ${wk.openedDelta >= 0 ? '▲' : '▼'}${Math.abs(wk.openedDelta)} vs last week`);
    console.log(`  8-wk trend: ${spark}  (opened/week)`);
    const arrow = fc.direction === 'rising' ? 'rising ↑' : fc.direction === 'falling' ? 'cooling ↓' : 'steady →';
    console.log(`  Forecast:   ${arrow} · avg ~${fc.weeklyAvg}/wk · next week ≈ ${fc.nextWeek} cleanup(s)`);
    console.log(`  Projected:  ~${proj.cleanupsPerMonth} cleanups/mo · ~${proj.minutesPerMonth} min/mo at the current rate`);
    console.log(`  By scope:   ${stats.byScope.map(s => `${s.scope} ${s.opened}/${s.runs}`).join(' · ') || '—'}`);
    if (next) console.log(`  Suggested:  qodex schedule add --recipe maintain --prompt "${next.scope}"   (${next.why})`);
    console.log('');
    process.exit(0);
  });

// Gather maintain runs from the local schedule store (shared by export). Returns MaintainRun[].
async function gatherMaintainRuns(): Promise<import('./cli/maintain-stats.js').MaintainRun[]> {
  const { getScheduleStore } = await import('./schedule/store.js');
  const { parseMaintainScope } = await import('./schedule/recipes.js');
  const store = getScheduleStore();
  const runs: import('./cli/maintain-stats.js').MaintainRun[] = [];
  for (const s of store.list().filter((s: any) => s.recipe === 'maintain')) {
    const scope = parseMaintainScope(s.prompt).scope;
    for (const r of store.recentRuns(s.id, 500)) {
      let status = r.status ?? 'running'; let files = 0;
      if (r.receipt) { try { const rc = JSON.parse(r.receipt); status = rc.status ?? status; files = (rc.filesChanged ?? []).length; } catch { /* ignore */ } }
      runs.push({ scope, status, filesChanged: files, when: '', at: r.started_at });
    }
  }
  return runs;
}

program
  .command('maintain-export')
  .description('Export the maintain history to a portable JSON snapshot; --sign adds an HMAC-signed audit head')
  .option('-o, --out <file>', 'write to this file instead of stdout')
  .option('--sign', 'sign the snapshot with HMAC-SHA256 using the QODEX_AUDIT_KEY env var (never stored)')
  .action(async (opts: { out?: string; sign?: boolean }) => {
    const { serializeMaintainHistory } = await import('./cli/maintain-history.js');
    let key: string | undefined;
    if (opts.sign) {
      key = process.env.QODEX_AUDIT_KEY;
      if (!key) { console.error('\n✗ --sign needs a key: set QODEX_AUDIT_KEY in your environment (it is never stored).\n'); process.exit(1); }
    }
    const runs = await gatherMaintainRuns();
    const json = serializeMaintainHistory(runs, new Date().toISOString(), { key });
    if (opts.out) {
      const { promises: fs } = await import('fs');
      await fs.writeFile(opts.out, json);
      console.log(`\n📦 Exported ${runs.length} maintain run(s) → ${opts.out}${key ? '  🔏 signed' : ''}\n`);
    } else {
      console.log(json);
    }
    process.exit(0);
  });

program
  .command('maintain-import <file>')
  .description('Report on a maintain-history snapshot; --merge combines it with local history')
  .option('--merge', 'merge the snapshot with local history and report the combined analytics')
  .action(async (file: string, opts: { merge?: boolean }) => {
    const { promises: fs } = await import('fs');
    const { deserializeMaintainHistory, mergeRuns, verifyHistoryAudit } = await import('./cli/maintain-history.js');
    const { buildMaintainStats, forecastTrend } = await import('./cli/maintain-stats.js');
    let parsed;
    try { parsed = deserializeMaintainHistory(await fs.readFile(file, 'utf-8')); }
    catch (e: any) { console.error(`\n✗ Could not read snapshot: ${e?.message ?? e}\n`); process.exit(1); }
    let runs = parsed!.runs;
    // Tamper check BEFORE merging: verify the snapshot's audit head (and signature, if a key is set).
    const audit = verifyHistoryAudit(runs, parsed!.audit, process.env.QODEX_AUDIT_KEY);
    if (audit.present && !audit.ok) {
      const why = audit.headMatches === false ? 'runs do not match the audit head (snapshot was altered)' : 'signature is INVALID (wrong key or forged)';
      console.error(`\n❌ Snapshot failed its audit check: ${why}. Refusing to report on it.\n`);
      process.exit(1);
    }
    let label = `snapshot (${runs.length} run(s)${parsed!.exportedAt ? `, exported ${parsed!.exportedAt.slice(0, 10)}` : ''})`;
    if (opts.merge) {
      const local = await gatherMaintainRuns();
      const before = runs.length;
      runs = mergeRuns(local, runs);
      label = `merged: ${local.length} local + ${before} imported → ${runs.length} unique`;
    }
    const now = Date.now();
    const stats = buildMaintainStats(runs);
    const fc = forecastTrend(runs, now);
    const arrow = fc.direction === 'rising' ? 'rising ↑' : fc.direction === 'falling' ? 'cooling ↓' : 'steady →';
    console.log(`\n📥 Maintain history — ${label}\n`);
    if (audit.present) {
      const sig = !audit.signaturePresent ? 'unsigned'
        : audit.signatureValid === undefined ? 'signed (set QODEX_AUDIT_KEY to verify)'
        : audit.signatureValid ? '🔏 signature valid (authentic)' : 'signature INVALID';
      console.log(`  Audit:     ✓ integrity intact · ${sig}`);
    }
    if (stats.totalRuns === 0) { console.log('  No runs in the snapshot.\n'); process.exit(0); }
    console.log(`  Totals:    ${stats.opened} cleanup PR(s) · ${stats.blocked} safely blocked · ${stats.filesCleaned} files cleaned · ~${stats.estMinutesSaved} min saved`);
    console.log(`  Forecast:  ${arrow} · avg ~${fc.weeklyAvg}/wk · next week ≈ ${fc.nextWeek}`);
    console.log(`  By scope:  ${stats.byScope.map(s => `${s.scope} ${s.opened}/${s.runs}`).join(' · ') || '—'}`);
    console.log(opts.merge ? '\n  (report only — local history is unchanged)\n' : '');
    process.exit(0);
  });

// Gather AUDITABLE runs — richer than analytics runs: PR url + verification, straight from receipts.
async function gatherAuditableRuns(): Promise<import('./cli/maintain-audit.js').AuditableRun[]> {
  const { getScheduleStore } = await import('./schedule/store.js');
  const { parseMaintainScope } = await import('./schedule/recipes.js');
  const store = getScheduleStore();
  const runs: import('./cli/maintain-audit.js').AuditableRun[] = [];
  for (const s of store.list().filter((s: any) => s.recipe === 'maintain')) {
    const scope = parseMaintainScope(s.prompt).scope;
    for (const r of store.recentRuns(s.id, 500)) {
      let status = r.status ?? 'running', files = 0, prUrl: string | undefined, verification: { command: string; passed: boolean }[] | undefined;
      if (r.receipt) {
        try {
          const rc = JSON.parse(r.receipt);
          status = rc.status ?? status;
          files = (rc.filesChanged ?? []).length;
          prUrl = rc.prUrl || undefined;
          verification = Array.isArray(rc.verification) ? rc.verification.map((v: any) => ({ command: String(v.command ?? ''), passed: !!v.passed })) : undefined;
        } catch { /* ignore */ }
      }
      runs.push({ at: r.started_at, scope, status, filesChanged: files, prUrl, verification });
    }
  }
  return runs;
}

program
  .command('maintain-audit')
  .description('Export a tamper-evident audit log of maintain runs (a hash chain); --sign adds an HMAC signature; --pdf renders the auditor one-pager')
  .option('-o, --out <file>', 'write to this file (PDF default: ~/.qodex/maintain-audit.pdf)')
  .option('--sign', 'sign the chain head with HMAC-SHA256 using the QODEX_AUDIT_KEY env var')
  .option('--pdf', 'render an auditor-facing PDF (verification status + the full run chain) instead of JSON')
  .action(async (opts: { out?: string; sign?: boolean; pdf?: boolean }) => {
    const { buildSignedAuditLog, serializeAuditLog, verifyAuditLog, buildAuditPdfBlocks } = await import('./cli/maintain-audit.js');
    const runs = await gatherAuditableRuns();
    let key: string | undefined;
    if (opts.sign) {
      key = process.env.QODEX_AUDIT_KEY;
      if (!key) { console.error('\n✗ --sign needs a key: set QODEX_AUDIT_KEY in your environment (it is never stored).\n'); process.exit(1); }
    }
    const log = buildSignedAuditLog(runs, { exportedAt: new Date().toISOString(), key });
    if (opts.pdf) {
      const verdict = verifyAuditLog(log, key);   // self-check the freshly-built chain → status block
      const { buildPdf } = await import('./cli/pdf-lite.js');
      const { QODEX_HOME } = await import('./config/defaults.js');
      const path = await import('path');
      const { promises: fs } = await import('fs');
      const out = opts.out ?? path.join(QODEX_HOME, 'maintain-audit.pdf');
      await fs.mkdir(path.dirname(out), { recursive: true }).catch(() => {});
      await fs.writeFile(out, Buffer.from(buildPdf(buildAuditPdfBlocks(log, verdict)), 'latin1'));
      console.log(`\n📄 Audit one-pager → ${out}\n   ${log.count} entry(ies)${log.signature ? ` · 🔏 signed (key ${log.keyId})` : ' · unsigned'}\n`);
      process.exit(0);
    }
    const json = serializeAuditLog(log);
    if (opts.out) {
      const { promises: fs } = await import('fs');
      await fs.writeFile(opts.out, json);
      console.log(`\n🔏 Audit log → ${opts.out}\n   ${log.count} entry(ies) · head ${log.head.slice(0, 16)}…${log.signature ? ` · signed (key ${log.keyId})` : ' · unsigned'}\n`);
    } else {
      console.log(json);
    }
    process.exit(0);
  });

program
  .command('maintain-audit-verify <file>')
  .description('Verify a maintain audit log offline: chain integrity + (with QODEX_AUDIT_KEY) the signature')
  .action(async (file: string) => {
    const { promises: fs } = await import('fs');
    const { verifyAuditLog } = await import('./cli/maintain-audit.js');
    let log: any;
    try { log = JSON.parse(await fs.readFile(file, 'utf-8')); }
    catch (e: any) { console.error(`\n✗ Could not read audit log: ${e?.message ?? e}\n`); process.exit(1); }
    const key = process.env.QODEX_AUDIT_KEY;
    const v = verifyAuditLog(log, key);
    console.log(`\n🔎 Audit verification — ${file}\n`);
    console.log(`  entries:    ${v.count}`);
    console.log(`  chain:      ${v.chainValid ? '✓ intact (no entry altered/reordered/dropped)' : `✗ BROKEN at #${v.brokenAt} — ${v.reason}`}`);
    console.log(`  head:       ${v.headMatches ? '✓ matches the chain' : '✗ stored head ≠ recomputed head'}`);
    if (!v.signaturePresent) console.log('  signature:  — none (integrity only; add --sign on export for authenticity)');
    else if (v.signatureValid === undefined) console.log('  signature:  present, but no QODEX_AUDIT_KEY set to check it');
    else console.log(`  signature:  ${v.signatureValid ? '✓ valid (authentic)' : '✗ INVALID (wrong key or forged)'}`);
    console.log(`\n  ${v.ok ? '✅ PASS — this log is trustworthy.' : '❌ FAIL — do not trust this log.'}\n`);
    process.exit(v.ok ? 0 : 1);
  });

program
  .command('whoami')
  .description('Show what QodeX has learned about you — stated preferences + the focus of recent tasks')
  .action(async () => {
    const { getSessionStore } = await import('./session/store.js');
    const { readEpisodes } = await import('./context/episodic-memory.js');
    const { buildUserModel, renderUserModel } = await import('./context/user-model.js');
    const cwd = process.cwd();
    const userFacts = (() => { try { return getSessionStore().getFactsByScope('user', cwd, 100); } catch { return []; } })();
    const eps = await readEpisodes(cwd).catch(() => []);
    console.log('\n' + renderUserModel(buildUserModel({ userFacts, episodes: eps.map(e => ({ prompt: e.prompt, files: e.filesChanged })) })) + '\n');
    process.exit(0);
  });

program
  .command('tunnel')
  .description('SSH-tunnel to a remote model server (run the heavy model on a workstation, drive from here)')
  .requiredOption('--host <host>', 'Remote host (workstation running Ollama / LM Studio)')
  .option('--user <user>', 'SSH user')
  .option('--port <n>', 'SSH port (default 22)')
  .option('--remote-port <n>', 'Remote inference port', '11434')
  .option('--local-port <n>', 'Local port to forward', '11434')
  .option('--identity <file>', 'SSH private key file')
  .action(async (opts: any) => {
    const { openTunnel, buildTunnelArgs } = await import('./cli/ssh-tunnel.js');
    const t = { host: opts.host, user: opts.user, port: opts.port ? Number(opts.port) : undefined,
      localPort: Number(opts.localPort), remotePort: Number(opts.remotePort), identityFile: opts.identity };
    console.log(`\n🔌 ssh ${buildTunnelArgs(t).join(' ')}`);
    try {
      await openTunnel(t);
      console.log(`✓ Tunnel up — point providers.ollama.baseUrl at http://localhost:${t.localPort}. Ctrl-C to close.\n`);
      process.on('SIGINT', () => process.exit(0));
      await new Promise<never>(() => {});
    } catch (e: any) { console.error(`✗ ${e?.message ?? e}`); process.exit(1); }
  });

program
  .command('update')
  .description('Self-update the QodeX git checkout (git pull → npm install → npm run build)')
  .option('--check', 'Only check whether a newer version is available; don\'t apply it')
  .action(async (opts: { check?: boolean }) => {
    if (opts.check) {
      const { checkForUpdate } = await import('./cli/self-update.js');
      const s = await checkForUpdate();
      console.log(`\n${s.updateAvailable ? '⬆' : s.ok ? '✓' : '✗'} ${s.message}\n`);
      process.exit(s.ok ? 0 : 1);
    }
    const { selfUpdate } = await import('./cli/self-update.js');
    console.log('\n🔄 Updating QodeX…');
    const r = await selfUpdate(line => console.log('  ' + line));
    for (const l of r.log) console.log('  ' + l);
    console.log(`\n${r.ok ? '✓' : '✗'} ${r.message}\n`);
    process.exit(r.ok ? 0 : 1);
  });

program
  .command('offload')
  .description('Auto-detect VRAM + model size and suggest a num_gpu for running large/MoE models locally')
  .option('--model <id>', 'Ollama model to plan for (default: configured default model)')
  .option('--vram <gb>', 'Override the VRAM budget in GB (skip auto-detect)')
  .option('--apply', 'Write the suggested num_gpu into config (providers.ollama.options.num_gpu)')
  .action(async (_opts: unknown, cmd: Command) => {
    // Root -m/--model swallows a post-subcommand --model under default parsing (see `provider add`).
    const opts = cmd.optsWithGlobals() as { model?: string; vram?: string; apply?: boolean };
    const config = await loadConfig(process.cwd());
    const baseUrl = (config as any).providers?.ollama?.baseUrl ?? 'http://localhost:11434';
    const model = opts.model ?? (config as any).defaults?.model;
    if (!model) { console.error('No model — pass --model <id> or set defaults.model.'); process.exit(1); }
    const { planOffload, detectVramGB } = await import('./setup/offload-detect.js');
    const { describeOffload } = await import('./llm/offload.js');
    const vramBudgetGB = opts.vram ? Number(opts.vram) : undefined;
    const sug = await planOffload({ baseUrl, model, vramBudgetGB });
    if (!sug) {
      const vram = vramBudgetGB ?? detectVramGB();
      console.error(!vram
        ? `Couldn't detect VRAM. Re-run with --vram <gb> to set a budget manually.`
        : `Couldn't read model facts — is "${model}" pulled in Ollama at ${baseUrl}? (Ollama-only; LM Studio not supported here.)`);
      process.exit(1);
    }
    console.log(`\nModel: ${model}`);
    console.log(`  ~${sug.facts.modelSizeGB.toFixed(1)} GB · ${sug.facts.totalLayers} layers · VRAM budget ${sug.vramGB} GB`);
    console.log(`  ${describeOffload(sug.plan, sug.facts.totalLayers)}\n`);
    if (opts.apply) {
      const fs = await import('fs/promises');
      const yaml = await import('js-yaml');
      const { QODEX_CONFIG_FILE } = await import('./config/defaults.js');
      let raw = ''; try { raw = await fs.readFile(QODEX_CONFIG_FILE, 'utf-8'); } catch {}
      const cfg: any = raw.trim() ? (yaml.load(raw) ?? {}) : {};
      cfg.providers ??= {}; cfg.providers.ollama ??= {}; cfg.providers.ollama.options ??= {};
      cfg.providers.ollama.options.num_gpu = sug.plan.numGpu;
      const { writeFileAtomic } = await import('./utils/atomic-write.js');
      await writeFileAtomic(QODEX_CONFIG_FILE, yaml.dump(cfg, { lineWidth: 100, noRefs: true }));
      console.log(`✓ Wrote providers.ollama.options.num_gpu: ${sug.plan.numGpu} to ${QODEX_CONFIG_FILE}`);
    } else {
      console.log('Re-run with --apply to write it, or add manually:');
      console.log(`  providers: { ollama: { options: { num_gpu: ${sug.plan.numGpu} } } }`);
    }
    process.exit(0);
  });

program
  .command('speculative')
  .alias('spec')
  .description('Detect and configure a draft model for speculative decoding (faster local generation)')
  .option('--apply', 'Write the chosen draft model into config (openai.draftModel)')
  .action(async (opts: { apply?: boolean }) => {
    const { config, router } = await bootstrap();
    const { suggestDraftFamily, pickDraftModel } = await import('./llm/speculative.js');

    // The local backend is usually openai-compatible (LM Studio) or ollama.
    const localProviderName = router.providerNames().includes('openai') ? 'openai' : 'ollama';
    const provider = router.getProvider(localProviderName);
    if (!provider) {
      console.log('No local provider configured. Speculative decoding needs LM Studio or Ollama.');
      process.exit(0);
    }

    let models: { id: string }[] = [];
    try {
      models = await provider.listModels();
    } catch (e: any) {
      console.error(`Couldn't list models from ${localProviderName}: ${e.message}`);
      console.error('Is the local server running?');
      process.exit(1);
    }
    const ids = models.map(m => m.id);
    if (ids.length === 0) {
      console.log('No models found on the local server.');
      process.exit(0);
    }

    // Identify the primary (largest / configured) model.
    const primary = (config.providers as any)[localProviderName]?.model
      ?? (config as any).model
      ?? ids[0];

    console.log(`Primary model: ${primary}`);
    const suggestion = suggestDraftFamily(primary);
    if (!suggestion) {
      console.log(`\nNo known draft pairing for "${primary}".`);
      console.log('Speculative decoding needs a draft model from the SAME family (shared vocabulary).');
      console.log('If you have a small sibling (e.g. a 0.5B/1.5B of the same model), set it manually:');
      console.log('  openai.draftModel: "<small-model-id>"  in ~/.qodex/config.yaml');
      process.exit(0);
    }

    console.log(`Family: ${suggestion.family}`);
    const draft = pickDraftModel(primary, ids);
    if (!draft) {
      console.log(`\nNo compatible draft model is loaded locally.`);
      console.log(`Download a small ${suggestion.family} model (one containing ${suggestion.draftHints.join(' / ')}) and re-run.`);
      console.log(`Why: ${suggestion.reason}`);
      process.exit(0);
    }

    console.log(`\n✓ Compatible draft model found: ${draft}`);
    console.log(`  Pairing ${draft} (draft) → ${primary} (target) can speed up generation up to ~2-3× on code,`);
    console.log(`  which is highly predictable (braces, imports, repeated identifiers get accepted verbatim).`);

    if (opts.apply) {
      const { addDraftToConfig } = await import('./llm/speculative-config.js');
      await addDraftToConfig(localProviderName, draft);
      console.log(`\n✓ Wrote ${localProviderName}.draftModel = "${draft}" to ~/.qodex/config.yaml`);
      console.log(`  Speculative decoding is now on for local generation. Run \`qodex speculative\` again anytime to re-check.`);
    } else {
      console.log(`\nApply it with:  qodex speculative --apply`);
    }
    process.exit(0);
  });

program
  .command('doctor')
  .description('Check environment health (providers, Ollama, grammars, MCP, DB writability)')
  .action(async () => {
    console.log('QodeX doctor — checking environment...\n');

    // Node version
    const nodeMajor = parseInt(process.versions.node.split('.')[0]!);
    console.log(`  Node.js:       ${process.version}  ${nodeMajor >= 20 ? '✓' : '✗ (need >=20)'}`);

    // QodeX home writability
    try {
      const { promises: fs } = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const home = path.join(os.homedir(), '.qodex');
      await fs.mkdir(home, { recursive: true });
      const probe = path.join(home, '.doctor-probe');
      await fs.writeFile(probe, 'ok');
      await fs.unlink(probe);
      console.log(`  ~/.qodex/:     writable  ✓`);
    } catch (e: any) {
      console.log(`  ~/.qodex/:     ✗ ${e.message}`);
    }

    // Bootstrap (router init + MCP)
    const { router, mcpManager, config } = await bootstrap();

    // Providers
    const models = router.listAvailableModels();
    console.log(`  Providers:     ${models.length} model(s) available across providers`);
    const byProvider = new Map<string, number>();
    for (const m of models) byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
    for (const [p, n] of byProvider) console.log(`    - ${p}: ${n} model(s)`);
    if (models.length === 0) {
      console.log('    ⚠ No models — start Ollama (ollama serve) or set ANTHROPIC_API_KEY / OPENAI_API_KEY');
    }

    // Ollama reachable?
    const ollamaUrl = config.providers.ollama.baseUrl;
    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      console.log(`  Ollama:        ${res.ok ? '✓' : '✗'} (${ollamaUrl})`);
    } catch {
      console.log(`  Ollama:        ✗ unreachable at ${ollamaUrl}`);
    }

    // Ripgrep (optional — enables the fast search path; a pure-JS fallback is used otherwise)
    const { hasRipgrep } = await import('./utils/ripgrep.js');
    if (await hasRipgrep()) {
      console.log(`  ripgrep (rg):  ✓ available (grep + code-graph navigation use the fast path)`);
    } else {
      const platform = process.platform;
      const installCmd = platform === 'darwin' ? 'brew install ripgrep'
        : platform === 'linux' ? 'apt install ripgrep   # or: dnf install ripgrep'
        : platform === 'win32' ? 'winget install BurntSushi.ripgrep.MSVC'
        : 'see https://github.com/BurntSushi/ripgrep#installation';
      console.log(`  ripgrep (rg):  ✗ not on PATH — optional. grep and code_graph_find_callers/find_references`);
      console.log(`                  fall back to a slower built-in scan. Install for speed: ${installCmd}`);
    }

    // Git
    try {
      const cp = await import('child_process');
      await new Promise<void>((resolve, reject) => {
        const p = cp.spawn('git', ['--version'], { stdio: 'ignore' });
        p.on('close', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        p.on('error', reject);
      });
      console.log(`  git:           ✓ available (auto-commit on transactions)`);
    } catch {
      console.log(`  git:           ✗ not on PATH — auto-commit disabled (journal still works)`);
    }

    // Tree-sitter grammars
    const path = await import('path');
    const url = await import('url');
    const fs = (await import('fs')).promises;
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    // index.{js,ts} lives one level under the project root (dist/ or src/), so the
    // grammars dir is `../grammars`. Fall back to cwd for run-from-anywhere.
    const grammarCandidates = [
      path.join(here, '..', 'grammars'),
      path.join(process.cwd(), 'grammars'),
    ];
    let grammarCount = 0;
    for (const dir of grammarCandidates) {
      try {
        const files = await fs.readdir(dir);
        const count = files.filter(f => f.endsWith('.wasm')).length;
        if (count > 0) { grammarCount = count; break; }
      } catch {}
    }
    console.log(`  AST grammars:  ${grammarCount} installed${grammarCount === 0 ? '  (run: node scripts/install-grammars.mjs)' : ''}`);
    if (grammarCount > 0) {
      // Counting .wasm files isn't enough — a present grammar can still fail to
      // LOAD (most often an ABI mismatch with the installed web-tree-sitter), in
      // which case AST silently falls back to regex. Test-load one and surface the
      // real reason here.
      try {
        const { diagnoseGrammar } = await import('./tools/ast/parser.js');
        const diag = await diagnoseGrammar('javascript');
        if (diag.ok) {
          console.log(`                 ✓ javascript grammar loads (AST active)`);
        } else {
          console.log(`                 ✗ javascript grammar present but FAILED to load — AST falls back to regex`);
          console.log(`                   reason: ${diag.error}`);
        }
      } catch (e: any) {
        console.log(`                 ✗ grammar test-load error: ${e?.message}`);
      }
    }

    // MCP
    const mcpStatuses = mcpManager.status();
    console.log(`  MCP servers:   ${mcpStatuses.length} configured, ${mcpStatuses.filter(s => s.state === 'ready').length} ready`);
    for (const s of mcpStatuses) {
      const icon = s.state === 'ready' ? '✓' : s.state === 'failed' ? '✗' : '…';
      console.log(`    ${icon} ${s.name}  ${s.toolCount} tool(s)${s.error ? `  err="${s.error}"` : ''}`);
    }

    console.log('\nDone.');
    await mcpManager.stopAll();
    process.exit(0);
  });

program
  .command('tokens [sessionId]')
  .description('Show per-turn token consumption breakdown for a session. Pure measurement, no behavior change. Defaults to the most recent session in this directory.')
  .option('-j, --json', 'Output JSON instead of a human-readable table')
  .action(async (sessionIdArg: string | undefined, _opts: unknown, cmd: Command) => {
    // Root --json swallows a post-subcommand --json under default parsing (see `provider add`).
    const opts = cmd.optsWithGlobals() as { json?: boolean };
    const { registry, codeGraph, mcpManager } = await bootstrap();
    const store = getSessionStore();

    // Resolve which session to analyze
    let sessionId = sessionIdArg;
    if (!sessionId) {
      const recent = store.listRecentSessions(1, process.cwd());
      if (recent.length === 0) {
        console.error('No sessions in this directory. Pass a session id or start a session first.');
        await mcpManager.stopAll();
        process.exit(1);
      }
      sessionId = recent[0]!.id;
    }
    // Allow short prefix match for convenience
    if (sessionId.length < 36) {
      const all = store.listRecentSessions(100, process.cwd());
      const match = all.find(s => s.id.startsWith(sessionId!));
      if (!match) {
        console.error(`No session matches prefix '${sessionId}'.`);
        await mcpManager.stopAll();
        process.exit(1);
      }
      sessionId = match.id;
    }

    const loaded = store.loadSession(sessionId);
    if (!loaded) {
      console.error(`Session not found: ${sessionId}`);
      await mcpManager.stopAll();
      process.exit(1);
    }

    // Estimate system prompt and tool schema sizes that WOULD apply to this session.
    // We rebuild them using the same builders the agent loop uses at startup, but
    // skip the full agent construction (we just need the strings, not a live agent).
    const { estimateTokens, estimateTokensJson, analyzeMessages, formatReport } =
      await import('./diagnostics/token-analyzer.js');
    const { buildSystemPrompt, detectModelFamily } = await import('./llm/prompts/system.js');
    const { detectProjectInfo } = await import('./context/project-info.js');
    const { loadProjectRules } = await import('./context/claude-md.js');
    const { buildDirectoryTree, getGitBranch } = await import('./context/tree.js');

    let systemTokens = 0;
    let toolSchemaTokens = 0;
    try {
      const [projectInfo, projectRules, directoryTree, gitBranch] = await Promise.all([
        detectProjectInfo(process.cwd()),
        loadProjectRules(process.cwd()),
        buildDirectoryTree(process.cwd()),
        getGitBranch(process.cwd()),
      ]);
      const modelId = loaded.meta.model ?? 'gpt-4o-mini';
      const sysPrompt = buildSystemPrompt({
        cwd: process.cwd(),
        mode: 'normal',
        modelFamily: detectModelFamily(modelId),
        projectInfo: { ...projectInfo },
        projectRules: projectRules?.content,
        knowledgeFacts: store.getFactsForCwd(process.cwd()),
        directoryTree,
        gitBranch,
        availableToolNames: registry.list().map(t => t.name),
      });
      systemTokens = estimateTokens(sysPrompt);
      const schemas = registry.getSchemas({ mode: 'normal' });
      toolSchemaTokens = estimateTokensJson(schemas);
    } catch (e: any) {
      console.error(`Warning: could not measure system+schemas precisely (${e.message}).`);
    }

    const report = analyzeMessages(sessionId, loaded.messages, { systemTokens, toolSchemaTokens });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report));
    }

    // Clean shutdown — process.exit will close DB handles, just stop MCP children
    await mcpManager.stopAll();
    process.exit(0);
  });

// `qodex schedule …` — recurring background tasks. The `tick` subcommand is
// what the launchd plist / cron line invokes once a minute; everything else is
// for humans to manage their entries.
const schedule = program.command('schedule').description('Manage scheduled (recurring) tasks');

schedule
  .command('list')
  .description('List all scheduled tasks')
  .action(async () => {
    const { getScheduleStore } = await import('./schedule/store.js');
    const entries = getScheduleStore().list();
    if (entries.length === 0) {
      console.log('No scheduled tasks. Add one with `qodex schedule add --name <n> --cron "<expr>" --prompt "<...>"`.');
      return;
    }
    for (const e of entries) {
      const flag = e.enabled ? '●' : '○';
      const next = e.next_run_at ? new Date(e.next_run_at).toLocaleString() : '—';
      const last = e.last_run_at
        ? `${new Date(e.last_run_at).toLocaleString()} (${e.last_status})`
        : 'never';
      const tags = [e.recipe ? `recipe:${e.recipe}` : '', e.deliver ? `→${e.deliver}` : ''].filter(Boolean).join('  ');
      console.log(`${flag} ${e.id.slice(0, 8)}  ${e.name.padEnd(20)}  ${e.cron.padEnd(15)}  next: ${next}  last: ${last}  runs: ${e.run_count}${tags ? `  ${tags}` : ''}`);
    }
  });

schedule
  .command('add')
  .description('Add a new scheduled task')
  .requiredOption('--name <n>', 'Human-readable name')
  .requiredOption('--cron <expr>', 'Cron expression or alias (@hourly, @daily, @weekly, @monthly)')
  .requiredOption('--prompt <text>', 'Prompt fed to the agent each run')
  .option('--cwd <dir>', 'Working directory for the run (default: current cwd)')
  .option('--model <id>', 'Model to use (default: configured default)')
  .option('--allow <tools>', 'Comma-separated tool allowlist (default: all)')
  .option('--deliver <target>', 'Send the result to chat, e.g. "telegram:<chatId>" or "discord:<channelId>"')
  .option('--recipe <kind>', 'Run a protocol instead of a bare prompt: "verified-pr" (sandbox branch → verify → open PR only if green)')
  .action(async (_opts: unknown, cmd: Command) => {
    // Root -m/--model swallows a post-subcommand --model under default parsing (see `provider add`).
    const opts: any = cmd.optsWithGlobals();
    const { getScheduleStore } = await import('./schedule/store.js');
    const { isRecipe, RECIPES } = await import('./schedule/recipes.js');
    const { parseDeliveryTarget } = await import('./schedule/delivery.js');
    try {
      if (opts.recipe && !isRecipe(opts.recipe)) {
        throw new Error(`Unknown recipe "${opts.recipe}". Available: ${RECIPES.join(', ')}.`);
      }
      if (opts.deliver && !parseDeliveryTarget(opts.deliver)) {
        throw new Error(`Invalid --deliver "${opts.deliver}". Use "telegram:<chatId>" or "discord:<channelId>".`);
      }
      const entry = getScheduleStore().add({
        name: opts.name,
        cron: opts.cron,
        prompt: opts.prompt,
        cwd: opts.cwd ?? process.cwd(),
        model: opts.model,
        allowedTools: opts.allow ? opts.allow.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
        deliver: opts.deliver,
        recipe: opts.recipe,
      });
      console.log(`✓ Scheduled "${entry.name}" (${entry.id.slice(0, 8)}).`);
      if (entry.recipe) console.log(`  Recipe:   ${entry.recipe}`);
      if (entry.deliver) console.log(`  Delivers: ${entry.deliver}`);
      if (entry.next_run_at) console.log(`  Next run: ${new Date(entry.next_run_at).toLocaleString()}`);
      console.log(`  Make sure the tick is installed: \`qodex schedule install\``);
    } catch (e: any) {
      console.error(`Failed: ${e.message}`);
      process.exit(1);
    }
  });

schedule
  .command('rm <idOrName>')
  .description('Remove a scheduled task')
  .action(async (idOrName: string) => {
    const { getScheduleStore } = await import('./schedule/store.js');
    const ok = getScheduleStore().remove(idOrName);
    console.log(ok ? '✓ Removed.' : `No schedule matches "${idOrName}".`);
  });

schedule
  .command('enable <idOrName>')
  .description('Enable a scheduled task')
  .action(async (idOrName: string) => {
    const { getScheduleStore } = await import('./schedule/store.js');
    const e = getScheduleStore().setEnabled(idOrName, true);
    console.log(e ? `✓ Enabled "${e.name}". Next run: ${e.next_run_at ?? '—'}` : `No schedule matches "${idOrName}".`);
  });

schedule
  .command('disable <idOrName>')
  .description('Disable a scheduled task (keep entry but skip ticks)')
  .action(async (idOrName: string) => {
    const { getScheduleStore } = await import('./schedule/store.js');
    const e = getScheduleStore().setEnabled(idOrName, false);
    console.log(e ? `✓ Disabled "${e.name}".` : `No schedule matches "${idOrName}".`);
  });

schedule
  .command('runs <idOrName>')
  .description('Show recent runs for a scheduled task')
  .option('-n, --limit <n>', 'How many runs to show', '10')
  .action(async (idOrName: string, opts: any) => {
    const { getScheduleStore } = await import('./schedule/store.js');
    const store = getScheduleStore();
    const e = store.resolve(idOrName);
    if (!e) { console.error(`No schedule matches "${idOrName}".`); process.exit(1); }
    const runs = store.recentRuns(e.id, parseInt(opts.limit, 10) || 10);
    if (runs.length === 0) { console.log('No runs yet.'); return; }
    for (const r of runs) {
      const dur = r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—';
      let verdict = '';
      if (r.receipt) { try { const rc = JSON.parse(r.receipt); verdict = `  🧾 ${rc.status}${rc.prUrl ? ` ${rc.prUrl}` : ''}`; } catch {} }
      console.log(`  ${r.started_at}  ${(r.status ?? 'running').padEnd(8)}  exit=${r.exit_code ?? '—'}  ${dur}  ${(r.message ?? '').slice(0, 80)}${verdict}`);
    }
  });

schedule
  .command('receipt <idOrName>')
  .description('Show the trust receipt of the latest run (what ran, what verified, the PR)')
  .action(async (idOrName: string) => {
    const { getScheduleStore } = await import('./schedule/store.js');
    const { formatReceipt } = await import('./schedule/receipt.js');
    const store = getScheduleStore();
    const e = store.resolve(idOrName);
    if (!e) { console.error(`No schedule matches "${idOrName}".`); process.exit(1); }
    const withReceipt = store.recentRuns(e.id, 20).find(r => r.receipt);
    if (!withReceipt?.receipt) { console.log('No receipt yet (only `verified-pr`/receipt-emitting runs produce one).'); return; }
    try { console.log(`\n${formatReceipt(JSON.parse(withReceipt.receipt))}\n  run: ${withReceipt.started_at}\n`); }
    catch { console.log(withReceipt.receipt); }
  });

schedule
  .command('tick')
  .description('Run all due schedules now (invoked by launchd/cron every minute)')
  .option('--json', 'Print result as JSON')
  .action(async (_opts: unknown, cmd: Command) => {
    // Root --json swallows a post-subcommand --json under default parsing (see `provider add`).
    const opts: any = cmd.optsWithGlobals();
    const { tick } = await import('./schedule/runner.js');
    const result = await tick();
    if (opts.json) console.log(JSON.stringify(result));
    else if (!result.acquired) console.log('(another tick is in progress)');
    else console.log(`tick: ran=${result.ranIds.length}, failed=${result.failed.length}, skipped=${result.skipped.length}`);
    process.exit(0);
  });

schedule
  .command('install')
  .description('Install the platform tick (LaunchAgent on macOS, prints crontab line on Linux)')
  .action(async () => {
    const { install } = await import('./schedule/installer.js');
    const r = await install();
    console.log(r.message);
    if (r.artifactPath) console.log(`  Artifact: ${r.artifactPath}`);
    process.exit(r.installed ? 0 : (process.platform === 'linux' ? 0 : 1));
  });

schedule
  .command('uninstall')
  .description('Remove the platform tick installer')
  .action(async () => {
    const { uninstall } = await import('./schedule/installer.js');
    const r = await uninstall();
    console.log(r.message);
    process.exit(0);
  });

program
  .command('setup')
  .description('Interactive configuration wizard. Detects hardware, picks a model, configures sub-agents, snapshot, and caching.')
  .option('--defaults', 'Apply sensible defaults without prompting (for scripts)')
  .option('--check', 'Show detected hardware + would-be defaults; do not write')
  .action(async (opts: { defaults?: boolean; check?: boolean }) => {
    const { runSetup } = await import('./setup/wizard.js');
    await runSetup({ defaults: opts.defaults, check: opts.check });
    process.exit(0);
  });

// `qodex skill …` — install / list / remove / enable installable model skills.
// Built as a separate sub-Command so each subcommand gets clean --help and arg validation.
import { buildSkillCommand } from './cli/skill-command.js';
program.addCommand(buildSkillCommand());

program.parseAsync(process.argv).catch(err => {
  console.error('Error:', err.message);
  if (process.env.QODEX_DEBUG) console.error(err.stack);
  process.exit(1);
});