/**
 * `ssh` — one non-interactive command on another machine.
 *
 * Uses the system OpenSSH. The command is a single argv after the destination,
 * so it cannot be read as an ssh option. Passwords go through SSH_ASKPASS
 * (environment only, never the command line, never the result). Host-key
 * checking stays at the user's ssh config — this tool does not pass
 * StrictHostKeyChecking=no.
 *
 * Every call asks. A remote command leaves the machine.
 */
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { interpretPermissionAnswer } from '../../security/permissions.js';
import { checkHost, checkIdentity, checkPort, checkUser, destination } from './target.js';

const ArgsSchema = z.object({
  host: z.string().describe('Hostname or IP. Not an ssh option.'),
  user: z.string().optional().describe('Remote user. Omit to use the local ssh config.'),
  port: z.number().int().min(1).max(65535).optional().describe('SSH port. Default 22.'),
  identity_file: z.string().optional().describe('Private key path (-i). Prefer this over a password.'),
  command: z.string().min(1).max(4000).describe('One remote command. It runs and ssh exits. Do not open an interactive shell.'),
  timeout_seconds: z.number().int().min(1).max(180).optional().describe('Default 30.'),
  password: z.string().max(256).optional().describe('Only if there is no key. Sent via SSH_ASKPASS, not argv. Never echoed.'),
});

export interface SshBuild {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  command: string;
  askpass: boolean;
  connectTimeoutSec: number;
}

export function buildSshArgs(input: SshBuild): { ok: true; args: string[] } | { ok: false; error: string } {
  const host = checkHost(input.host);
  if (!host.ok) return host;
  const user = checkUser(input.user);
  if (!user.ok) return user;
  const port = checkPort(input.port, 22);
  if (!port.ok) return port;
  const identity = checkIdentity(input.identityFile);
  if (!identity.ok) return identity;
  const command = input.command.replace(/\r|\n/g, ' ').trim();
  if (!command) return { ok: false, error: 'ssh needs a command' };

  const args = [
    '-o', `ConnectTimeout=${input.connectTimeoutSec}`,
    '-o', 'NumberOfPasswordPrompts=1',
  ];
  if (!input.askpass) args.push('-o', 'BatchMode=yes');
  if (input.port != null) args.push('-p', String(port.port));
  if (identity.file) args.push('-i', identity.file);
  args.push(destination(user.user, host.host), command);
  return { ok: true, args };
}

export function redactSecret(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

async function confirmRemote(ctx: ToolContext, operation: string): Promise<ToolResult | null> {
  const decision = ctx.permissions.evaluate({ tool: 'ssh', operation });
  if (decision === 'deny') {
    return { content: `[PERMISSION_DENIED] ${operation}`, isError: true };
  }
  ctx.emit({ type: 'permission-request', tool: 'ssh', operation });
  const answer = await ctx.askUser(`ssh leaves this machine: ${operation}`, ['yes', 'no']);
  if (interpretPermissionAnswer(answer) !== 'allow') {
    return { content: '[USER_REJECTED] ssh was not approved. Remote commands are confirmed every time.', isError: true };
  }
  return null;
}

function runSsh(args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    };
    const take = (buf: Buffer) => {
      if (out.length < 64_000) out += buf.toString('utf-8');
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.on('error', err => {
      out += err.message;
      finish(127);
    });
    child.on('exit', code => finish(code ?? 1));
  });
}

export class SshTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'ssh';
  description = 'Run ONE command on another machine via the system ssh, then exit. Not an interactive login. Prefer a key (identity_file). A password, if you truly have no key, is sent via SSH_ASKPASS and is not put on the command line. Host-key checking is left on. Asks every time, then runs.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const built = buildSshArgs({
      host: args.host,
      user: args.user,
      port: args.port,
      identityFile: args.identity_file,
      command: args.command,
      askpass: Boolean(args.password),
      connectTimeoutSec: Math.min(args.timeout_seconds ?? 30, 30),
    });
    if (!built.ok) return { content: `[SSH_ERROR] ${built.error}`, isError: true };

    const shown = `${args.user ? args.user + '@' : ''}${args.host} ${args.command.slice(0, 180)}`;
    const blocked = await confirmRemote(ctx, shown);
    if (blocked) return blocked;

    const timeoutMs = (args.timeout_seconds ?? 30) * 1000;
    let dir: string | undefined;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (args.password) {
        dir = await mkdtemp(path.join(tmpdir(), 'qodex-ask-'));
        const script = path.join(dir, 'askpass.sh');
        await writeFile(script, '#!/bin/sh\nprintf \'%s\\n\' "$QODEX_SSH_PASSWORD"\n', { mode: 0o700 });
        env.SSH_ASKPASS = script;
        env.SSH_ASKPASS_REQUIRE = 'force';
        env.DISPLAY = env.DISPLAY || 'qodex:0';
        env.QODEX_SSH_PASSWORD = args.password;
      }
      const result = await runSsh(built.args, timeoutMs, env);
      const body = redactSecret(result.out, args.password).slice(0, 64_000);
      const tail = result.timedOut ? '\n[timed out]' : `\n[exit ${result.code}]`;
      return { content: body + tail, isError: result.code !== 0 || result.timedOut };
    } catch (e: any) {
      return { content: `[SSH_ERROR] ${e?.message ?? e}`, isError: true };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
