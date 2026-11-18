/**
 * `qodex host` — the machine that stays on. Not Hermes Cloud.
 * A laptop posts a job and leaves. The job stays here.
 */
import { Command } from 'commander';
import * as path from 'path';
import { residentHome, residentLogPath } from '../resident/paths.js';
import { hangupPolicy, spawnResident } from '../resident/detach.js';
import { JobStore } from '../host/jobs.js';
import { startHostServer } from '../host/server.js';
import { setHostEnqueue } from '../host/bridge.js';
import { bindAllowed, ensureHostToken, loopback } from '../host/token.js';

export function buildHostCommand(deps: {
  bootstrap?: () => Promise<{ config: any; router: any; registry: any; permissions: any }>;
} = {}): Command {
  const cmd = new Command('host');
  cmd.description('Run the self-hosted agent on a machine that stays on. Not a cloud.');
  cmd.option('--bind <host>', 'Listen address', '127.0.0.1');
  cmd.option('--port <n>', 'Listen port', '8787');
  cmd.option('--detach', 'Keep running after this terminal closes');
  cmd.option('--no-bots', 'Do not attach chat platforms');

  cmd
    .command('submit')
    .description('Hand a prompt to a host and exit. The host keeps the job.')
    .requiredOption('--url <url>', 'Host base URL')
    .requiredOption('--prompt <text>', 'What the host should do')
    .option('--token <token>', 'Bearer token (prefer QODEX_HOST_TOKEN)')
    .option('--project <dir>', 'Project directory on the host')
    .action(async (opts: { url: string; prompt: string; token?: string; project?: string }) => {
      const token = opts.token || process.env.QODEX_HOST_TOKEN;
      if (!token) {
        console.error('set QODEX_HOST_TOKEN or pass --token');
        process.exitCode = 2;
        return;
      }
      const res = await fetch(new URL('/v1/jobs', opts.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: opts.prompt, project: opts.project }),
      });
      const body = await res.text();
      console.log(body);
      if (!res.ok) process.exitCode = 1;
    });

  cmd
    .command('pull')
    .description('Read a job the host kept after you left')
    .requiredOption('--url <url>', 'Host base URL')
    .requiredOption('--id <id>', 'Job id')
    .option('--token <token>', 'Bearer token (prefer QODEX_HOST_TOKEN)')
    .action(async (opts: { url: string; id: string; token?: string }) => {
      const token = opts.token || process.env.QODEX_HOST_TOKEN;
      if (!token) {
        console.error('set QODEX_HOST_TOKEN or pass --token');
        process.exitCode = 2;
        return;
      }
      const res = await fetch(new URL('/v1/jobs/' + opts.id, opts.url), {
        headers: { authorization: `Bearer ${token}` },
      });
      console.log(await res.text());
      if (!res.ok) process.exitCode = 1;
    });

  cmd.action(async (opts: { bind: string; port: string; detach?: boolean; bots?: boolean }) => {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error('port must be 1-65535');
      process.exitCode = 2;
      return;
    }
    if (opts.detach) {
      const pid = spawnResident({
        args: ['host', '--bind', opts.bind, '--port', String(port), ...(opts.bots === false ? ['--no-bots'] : [])],
        logPath: residentLogPath(),
      });
      console.log(`host detached · pid ${pid}`);
      console.log('This machine keeps the jobs. Closing the laptop that submitted them does not.');
      console.log('This is not a hosted cloud.');
      return;
    }
    if (hangupPolicy() === 'ignore') process.on('SIGHUP', () => {});
    const token = process.env.QODEX_HOST_TOKEN || await ensureHostToken(path.join(residentHome(), 'host', 'token'));
    const policy = bindAllowed(opts.bind, token);
    if (!policy.ok) {
      console.error(policy.reason);
      process.exitCode = 2;
      return;
    }
    const store = new JobStore(path.join(residentHome(), 'host', 'jobs.json'));
    await store.load();
    const { runHostJob } = await import('../host/turn.js');
    const server = await startHostServer({ host: opts.bind, port, token, store, run: runHostJob });
    setHostEnqueue((prompt, project) => store.add({ prompt, project }));
    if (opts.bots !== false && deps.bootstrap) {
      try {
        const boot = await deps.bootstrap();
        const { openBots } = await import('../bot/start.js');
        const opened = await openBots({
          config: boot.config,
          router: boot.router,
          registry: boot.registry,
          permissions: boot.permissions,
          cwd: process.cwd(),
        });
        for (const n of opened.notes) console.error(n);
        if (opened.platforms.length) console.error(`bots: ${opened.platforms.join(', ')}`);
        else if (!opened.notes.length) console.error('no bot platform is enabled — /goal works only in this process once a bot is configured');
      } catch (e: any) {
        console.error(`bots did not start: ${e?.message ?? e}`);
      }
    }
    console.error(`host listening on http://${opts.bind}:${server.port}`);
    console.error(loopback(opts.bind) ? 'loopback only' : 'not loopback — the token is the lock');
    console.error('cloud: false');
    console.error(`token file ${path.join(residentHome(), 'host', 'token')}`);
    await new Promise<void>((resolve) => {
      const stop = () => { void server.close().finally(resolve); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
  });

  return cmd;
}
