/**
 * One turn on the host. A permission ask is not approved from here.
 */
import type { HostJob } from './jobs.js';

export async function runHostJob(job: HostJob): Promise<{ state: 'done' | 'held'; text: string }> {
  const { loadConfig } = await import('../config/loader.js');
  const { ModelRouter } = await import('../llm/router.js');
  const { ToolRegistry } = await import('../tools/registry.js');
  const { PermissionEngine } = await import('../security/permissions.js');
  const { QodexAgentRunner } = await import('../bot/runner.js');
  const config = await loadConfig(job.project);
  const runner = new QodexAgentRunner({
    config,
    router: new ModelRouter(config),
    registry: new ToolRegistry(),
    permissions: new PermissionEngine(config),
    cwd: job.project,
  });
  let asked: string | null = null;
  const text = await runner.runTurn('host:' + job.id, job.prompt, {
    onDelta() {},
    onStatus() {},
    async ask(prompt: string) {
      asked = prompt;
      return 'deny';
    },
  }, new AbortController().signal);
  if (asked) {
    return { state: 'held', text: `${text}\n\nheld: ${asked}\nThis was not auto-approved. A person has to allow it on the host.` };
  }
  return { state: 'done', text };
}
