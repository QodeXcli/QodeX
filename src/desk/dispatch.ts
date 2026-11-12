/**
 * One desk goal, run by the same headless agent as `qodex -p`.
 *
 * Ordinary edits and shell use approval mode "always" for this process, then
 * the previous mode is restored. Anything that still asks — irreversible shell,
 * screen click/type/key, a browser click/fill/script, send/spend — is parked
 * on the sentinel. The call runs only after a person allows that exact id.
 * Timeout denies it.
 *
 * Tool names and scrubbed args are returned so `desk teach --from-last` can
 * turn a real run into a routine. MCP servers the user already configured
 * are started for this goal and stopped when it exits. None configured means
 * nothing extra is started. The process still exits with the goal.
 */
import { getApprovalMode, setApprovalMode } from '../security/permissions.js';
import { getMCPManager, MCPManager, setMCPManager } from '../mcp/manager.js';
import type { MCPManagerConfig } from '../mcp/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { deskMcpConfig, isDeskToolName, scrubPacket } from './policy.js';
import { classifyAsk, parkSentinel, waitForSentinel } from './sentinel.js';

export interface DeskRunResult {
  code: number;
  trace: Array<{ tool: string; summary: string }>;
}

/**
 * Start the MCP servers already in config, run `body`, then stop them.
 * Disabled or absent servers start nothing and do not replace a manager.
 * `ready` is only the servers that finished initialize. A failed one is not claimed as up.
 */
export async function withConfiguredMcp<T>(
  registry: ToolRegistry,
  mcp: MCPManagerConfig | undefined,
  body: (ready: string[]) => Promise<T>,
): Promise<T> {
  const picked = deskMcpConfig(mcp);
  if (!picked) return body([]);
  const prev = getMCPManager();
  const manager = new MCPManager(picked, registry);
  setMCPManager(manager);
  try {
    await manager.startAll();
    const ready = manager.status().filter(s => s.state === 'ready').map(s => s.name);
    return await body(ready);
  } finally {
    await manager.stopAll().catch(() => {});
    setMCPManager(prev);
  }
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
    return await withConfiguredMcp(registry, config.mcp, async (ready) => {
      let prompt = opts.prompt;
      if (ready.length > 0) {
        prompt += `\nConnectors up for this run (already configured on this machine): ${ready.join(', ')}. Spend, send, delete, and a cloud-browser act still wait on the sentinel. A connector that is not in the tool list is not available.`;
      }
      const { runHeadless } = await import('../cli/modes/headless.js');
      const code = await runHeadless({
        cwd: opts.cwd,
        config,
        router,
        registry,
        permissions,
        prompt,
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
          if (!isDeskToolName(name) || trace.length >= 24) return;
          const summary = scrubPacket(args || name).text.replace(/\s+/g, ' ').trim().slice(0, 180) || name;
          trace.push({ tool: name, summary });
        },
      });
      return { code, trace };
    });
  } finally {
    setApprovalMode(prevMode);
    try { process.chdir(prevCwd); } catch { /* the old cwd disappeared */ }
  }
}
