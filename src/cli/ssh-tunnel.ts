/**
 * `qodex tunnel` — the local-first answer to remote execution backends. Open an SSH local-forward
 * to a remote inference server (Ollama / LM Studio on your beefy workstation) so QodeX, running on
 * your laptop, talks to `localhost:<port>` while the heavy model runs over there.
 *
 * We tunnel the MODEL, not the shell: QodeX edits your *local* repo and runs *local* commands, so
 * keeping code/exec local (and only the inference remote) is the right split — you get a 70B/MoE
 * model without exposing the workstation to the network or shipping your code elsewhere.
 *
 * buildTunnelArgs is PURE (unit-tested); openTunnel spawns ssh and stays up until killed.
 */
import { spawn } from 'cross-spawn';

export interface TunnelOpts {
  host: string;
  user?: string;
  /** SSH port on the remote (default 22). */
  port?: number;
  localPort: number;
  remotePort: number;
  /** Private key file (-i). */
  identityFile?: string;
}

/** Build the `ssh` argv for a no-shell local port-forward with keepalive. PURE. */
export function buildTunnelArgs(o: TunnelOpts): string[] {
  const args = [
    '-N',                                            // no remote command — forward only
    '-o', 'ServerAliveInterval=30',                  // keep the tunnel from idling out
    '-o', 'ExitOnForwardFailure=yes',                // fail fast if the local port is taken
    '-L', `${o.localPort}:localhost:${o.remotePort}`,
  ];
  if (o.port) args.push('-p', String(o.port));
  if (o.identityFile) args.push('-i', o.identityFile);
  args.push(`${o.user ? `${o.user}@` : ''}${o.host}`);
  return args;
}

/** Open the tunnel; resolves with a `close()` once ssh is spawned. Rejects if ssh exits early. */
export async function openTunnel(o: TunnelOpts): Promise<{ close: () => void }> {
  const args = buildTunnelArgs(o);
  const child = spawn('ssh', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  return new Promise((resolve, reject) => {
    let settled = false;
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    child.on('exit', code => { if (!settled) { settled = true; reject(new Error(`ssh exited (${code}) — check host/key/port`)); } });
    // ssh -N stays running; if it hasn't died in 1.2s, assume the forward is up.
    setTimeout(() => { if (!settled) { settled = true; resolve({ close: () => child.kill() }); } }, 1200);
  });
}
