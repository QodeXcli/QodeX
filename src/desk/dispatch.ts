/**
 * One desk goal, run by the same headless agent as `qodex -p`.
 *
 * Ordinary edits and shell use approval mode "always" for this process only,
 * then the previous mode is restored. Irreversible shell still asks, and
 * headless without --yes denies that ask. Screen click/type/key ask every
 * time and are denied here too.
 *
 * MCP servers are not started: a desk run must return when the goal returns,
 * not sit on a background socket. Code-graph tools say so if the index is cold.
 */
import { getApprovalMode, setApprovalMode } from '../security/permissions.js';

export async function runDeskAgent(opts: { cwd: string; prompt: string }): Promise<number> {
  const prevMode = getApprovalMode();
  const prevCwd = process.cwd();
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
    return await runHeadless({
      cwd: opts.cwd,
      config,
      router,
      registry,
      permissions,
      prompt: opts.prompt,
      json: false,
      autoApproveAll: false,
    });
  } finally {
    setApprovalMode(prevMode);
    try { process.chdir(prevCwd); } catch { /* the old cwd disappeared */ }
  }
}
