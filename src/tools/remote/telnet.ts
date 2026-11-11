/**
 * `telnet` — a small real client (RFC 854), not a claim that a binary exists.
 *
 * Negotiates by refusing options, sends the lines you give it, and returns the
 * text. A secret line (a device password) is sent but not printed back.
 * Every call asks. Telnet is cleartext and leaves the machine.
 */
import { connect, type Socket } from 'net';
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { interpretPermissionAnswer } from '../../security/permissions.js';
import { checkHost, checkPort } from './target.js';

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

const ArgsSchema = z.object({
  host: z.string().describe('Hostname or IP of the device.'),
  port: z.number().int().min(1).max(65535).optional().describe('Default 23.'),
  timeout_seconds: z.number().int().min(1).max(120).optional().describe('Whole session. Default 20.'),
  lines: z.array(z.string().max(500)).max(32).optional().describe('Lines to send, in order, each ended with CR LF. Omit to only read the banner.'),
  secret: z.string().max(256).optional().describe('A password line. Sent, never printed in the result or the approval prompt.'),
  secret_at: z.number().int().min(0).max(32).optional().describe('Insert secret after this many lines. Default 0 (send it first).'),
});

export interface TelnetStep {
  text: string;
  secret: boolean;
}

/** Drop Telnet controls. Refuse every option so a picky device still talks. PURE. */
export function consumeTelnet(input: Buffer): { text: string; reply: Buffer } {
  const clean: number[] = [];
  const reply: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const b = input[i]!;
    if (b !== IAC) { clean.push(b); continue; }
    const cmd = input[++i];
    if (cmd === undefined) break;
    if (cmd === IAC) { clean.push(255); continue; }
    if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
      const opt = input[++i];
      if (opt === undefined) break;
      reply.push(IAC, cmd === WILL || cmd === WONT ? DONT : WONT, opt);
      continue;
    }
    if (cmd === SB) {
      let j = i + 1;
      for (; j < input.length - 1; j++) {
        if (input[j] === IAC && input[j + 1] === SE) { i = j + 1; break; }
      }
      if (j >= input.length - 1) i = input.length;
      continue;
    }
  }
  return { text: Buffer.from(clean).toString('utf8'), reply: Buffer.from(reply) };
}

export function buildTelnetSteps(lines: string[] | undefined, secret?: string, secretAt?: number): TelnetStep[] {
  const steps: TelnetStep[] = (lines ?? []).map(text => ({ text, secret: false }));
  if (secret != null && secret !== '') {
    const at = Math.max(0, Math.min(secretAt ?? 0, steps.length));
    steps.splice(at, 0, { text: secret, secret: true });
  }
  return steps;
}

export function redactSecret(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

async function confirmTelnet(ctx: ToolContext, operation: string): Promise<ToolResult | null> {
  const decision = ctx.permissions.evaluate({ tool: 'telnet', operation });
  if (decision === 'deny') return { content: `[PERMISSION_DENIED] ${operation}`, isError: true };
  ctx.emit({ type: 'permission-request', tool: 'telnet', operation });
  const answer = await ctx.askUser(`telnet leaves this machine: ${operation}`, ['yes', 'no']);
  if (interpretPermissionAnswer(answer) !== 'allow') {
    return { content: '[USER_REJECTED] telnet was not approved. Remote sessions are confirmed every time.', isError: true };
  }
  return null;
}

export function runTelnetSession(opts: {
  host: string;
  port: number;
  timeoutMs: number;
  steps: TelnetStep[];
  secret?: string;
}): Promise<{ text: string; error?: string }> {
  return new Promise(resolve => {
    const socket: Socket = connect({ host: opts.host, port: opts.port });
    let text = '';
    let settled = false;
    let step = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const done = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (idle) clearTimeout(idle);
      socket.destroy();
      resolve({ text: redactSecret(text, opts.secret).slice(0, 64_000), error });
    };
    const killer = setTimeout(() => done(text ? undefined : 'timed out'), opts.timeoutMs);
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => done(), 800);
    };
    const sendNext = () => {
      if (settled) return;
      if (step >= opts.steps.length) { armIdle(); return; }
      const current = opts.steps[step++]!;
      socket.write(current.text.replace(/[\r\n]/g, '') + '\r\n');
      if (current.secret) text += '[secret sent]\n';
      setTimeout(sendNext, 200);
    };

    socket.setTimeout(opts.timeoutMs);
    socket.on('timeout', () => done(text ? undefined : 'timed out'));
    socket.on('error', err => done(err.message));
    socket.on('connect', () => setTimeout(sendNext, 100));
    socket.on('data', (buf: Buffer) => {
      const { text: piece, reply } = consumeTelnet(buf);
      if (reply.length) socket.write(reply);
      if (text.length < 64_000) text += piece;
      if (step >= opts.steps.length) armIdle();
    });
    socket.on('close', () => done());
  });
}

export class TelnetTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'telnet';
  description = 'Open a Telnet session to a host (routers, switches, serial gateways), send lines, return the text. Cleartext. A password goes in `secret` and is not printed. Not an interactive shell — pass the lines and it exits. Asks every time, then connects.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const host = checkHost(args.host);
    if (!host.ok) return { content: `[TELNET_ERROR] ${host.error}`, isError: true };
    const port = checkPort(args.port, 23);
    if (!port.ok) return { content: `[TELNET_ERROR] ${port.error}`, isError: true };
    const steps = buildTelnetSteps(args.lines, args.secret, args.secret_at);
    const operation = `${host.host}:${port.port} (${steps.length} lines)`;
    const blocked = await confirmTelnet(ctx, operation);
    if (blocked) return blocked;
    const result = await runTelnetSession({
      host: host.host,
      port: port.port,
      timeoutMs: (args.timeout_seconds ?? 20) * 1000,
      steps,
      secret: args.secret,
    });
    if (result.error && !result.text) return { content: `[TELNET_ERROR] ${result.error}`, isError: true };
    const note = result.error ? `\n[${result.error}]` : '';
    return { content: (result.text || '(no output)') + note, isError: Boolean(result.error) };
  }
}
