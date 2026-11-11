/**
 * One desk goal, run by the same headless agent as `qodex -p`.
 *
 * Ordinary edits and shell use approval mode "always" for this process, then
 * the previous mode is restored. Anything that still asks — irreversible shell,
 * screen click/type/key, send/spend — is parked on the sentinel. The call runs
 * only after a person allows that exact id. Timeout denies it.
 *
 * Tool names and scrubbed args are returned so `desk teach --from-last` can
 * turn a real run into a routine. MCP is not started; the process must exit
 * when the goal exits.
 */
import { getApprovalMode, setApprovalMode } from '../security/permissions.js';
import { scrubPacket } from './policy.js';
import { classifyAsk, parkSentinel, waitForSentinel } from './sentinel.js';

const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;

export interface DeskRunResult {
  code: number;
  trace: Array<{ tool: string; summary: string }>;
}

export async function runDeskAgent(opts: {
  cwd: string;
  prompt: string;
  deskId: string;
  goalId: string;
  sentinelTimeoutMs?: number;
}): Promise<DeskRunResult> {
  const prevMode = getApprovalMode();
  const prevCwd = process.cwd();
  const trace: Array<{ tool: string; summary: string }> = [];
  const timeoutMs = opts.sentinelTimeoutMs ?? 10 * 60_000;
  setApprovalMode('always');
  try {
    process.chdir(opts.cwd);
    const { loadConfig, ensureQodexHome, setActiveConfig } = await import('../config/loader.js');
    const { logger } = await import('../utils/logger.js');
    await ensureQodexHome();
    await logger.init('info');
    try {
      const { loadEnvFileIntoProcess } = await import('../setup/env-writer.js');
      await loadEnvFileIntoProcess();
    } catch { /* no ~/.qodex/.env */ }

    const config = await loadConfig(opts.cwd);
    setActiveConfig(config);
    const { ModelRouter } = await import('../llm/router.js');
    const { ToolRegistry } = await import('../tools/registry.js');
    const { PermissionEngine } = await import('../security/permissions.js');
    const router = new ModelRouter(config);
    const registry = new ToolRegistry();
    try {
      const { registerUserPlugins } = await import('../plugins/loader.js');
      await registerUserPlugins(registry, opts.cwd);
    } catch { /* plugins are optional */ }
    const permissions = new PermissionEngine(config);
    try {
      const { seedBundledSkills } = await import('../skills/seed.js');
      const { initSkillRegistry } = await import('../skills/registry.js');
      await seedBundledSkills();
      await initSkillRegistry(opts.cwd);
    } catch { /* skills stay empty if seeding fails */ }
    await router.initialize();
    const { runHeadless } = await import('../cli/modes/headless.js');
    const code = await runHeadless({
      cwd: opts.cwd,
      config,
      router,
      registry,
      permissions,
      prompt: opts.prompt,
      json: false,
      autoApproveAll: false,
      askUser: async prompt => {
        const hit = classifyAsk(prompt);
        const req = await parkSentinel({
          deskId: opts.deskId,
          goalId: opts.goalId,
          prompt,
          kind: hit.kind,
          reason: hit.reason,
        });
        console.error(`\n⏸ sentinel ${req.id} [${hit.kind}] ${hit.reason}`);
        console.error(`   ${prompt.split('\n')[0]?.slice(0, 220) ?? ''}`);
        console.error(`   allow: qodex desk allow-call ${req.id}`);
        console.error(`   deny:  qodex desk deny-call ${req.id}`);
        console.error(`   waiting up to ${Math.round(timeoutMs / 1000)}s\n`);
        const decision = await waitForSentinel(req.id, timeoutMs);
        console.error(decision === 'allowed' ? `✓ sentinel ${req.id} allowed — running it` : `✗ sentinel ${req.id} ${decision}`);
        return decision === 'allowed' ? 'yes' : 'no';
      },
      onTool: (name, args) => {
        if (!TOOL_NAME.test(name) || trace.length >= 24) return;
        const summary = scrubPacket(args || name).text.replace(/\s+/g, ' ').trim().slice(0, 180) || name;
        trace.push({ tool: name, summary });
      },
    });
    return { code, trace };
  } finally {
    setApprovalMode(prevMode);
    try { process.chdir(prevCwd); } catch { /* the old cwd disappeared */ }
  }
}
