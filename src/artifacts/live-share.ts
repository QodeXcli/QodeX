/**
 * Sharing layer for live artifacts — turns a loopback dev server into something a
 * teammate can actually open: a local-network URL (same WiFi/LAN) and/or a public
 * private link via a quick tunnel (cloudflared, falling back to ngrok). All shareable
 * URLs carry the access token, so only someone with the full link gets in.
 */
import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';

/** This machine's non-internal IPv4 addresses → shareable LAN URLs (same network only). */
export function lanUrls(port: number, token?: string): string[] {
  const suffix = token ? `?k=${token}` : '';
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      // Node 18+ reports family as 'IPv4' (string); older as 4 (number) — accept both.
      if ((a.family === 'IPv4' || (a.family as unknown) === 4) && !a.internal) {
        out.push(`http://${a.address}:${port}/${suffix}`);
      }
    }
  }
  return out;
}

/** Pull the public https URL out of a cloudflared/ngrok log line. Pure → unit-testable. */
export function parseTunnelUrl(text: string): string | undefined {
  const m = text.match(/https:\/\/[a-z0-9-]+\.(?:trycloudflare\.com|ngrok(?:-free)?\.app|ngrok\.io)[^\s"']*/i);
  return m ? m[0] : undefined;
}

export interface TunnelHandle { url: string; close: () => void; }

/** Spawn one tunnel binary and resolve with its public URL when it appears in the logs. */
function spawnTunnel(cmd: string, args: string[], timeoutMs: number): Promise<TunnelHandle> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      reject(new Error(`${cmd} could not start: ${e?.message ?? e}`));
      return;
    }
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const onData = (buf: Buffer) => {
      const u = parseTunnelUrl(buf.toString());
      if (u) done(() => resolve({ url: u, close: () => { try { child.kill('SIGTERM'); } catch { /* gone */ } } }));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData); // cloudflared prints the URL to stderr
    child.on('error', (e: any) => done(() => reject(new Error(`${cmd} unavailable: ${e?.message ?? e}`))));
    child.on('exit', code => done(() => reject(new Error(`${cmd} exited (${code}) before a URL appeared`))));
    const timer = setTimeout(() => done(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } reject(new Error(`${cmd} timed out`)); }), timeoutMs);
  });
}

/**
 * Start a public quick-tunnel to a local port. Tries cloudflared first (no account
 * needed for trycloudflare.com), then ngrok. Rejects with guidance if neither works.
 */
export async function startTunnel(port: number, timeoutMs = 15000): Promise<TunnelHandle> {
  try {
    return await spawnTunnel('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], timeoutMs);
  } catch (cfErr) {
    try {
      return await spawnTunnel('ngrok', ['http', String(port), '--log', 'stdout'], timeoutMs);
    } catch (ngErr) {
      throw new Error(
        'Could not start a public tunnel. Install cloudflared (recommended, no account) ' +
        `or ngrok, then retry. (cloudflared: ${(cfErr as Error).message}; ngrok: ${(ngErr as Error).message})`,
      );
    }
  }
}

/** A short, URL-safe, cryptographically-random access token for a private live link. */
export function makeAccessToken(): string {
  // 12 bytes → 96 bits of entropy; base64url is compact and paste-safe.
  return randomBytes(12).toString('base64url');
}
