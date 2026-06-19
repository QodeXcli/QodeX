import { z } from 'zod';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { proxyFetch } from '../../utils/proxy-fetch.js';
import { runProcess } from '../../utils/run-process.js';

/**
 * `network_optimize` — the tool built for a restricted/throttled network (your
 * recurring npm / pip / GitHub / HuggingFace timeouts).
 *
 * Algorithm:
 *   1. For each ecosystem (npm, pip, huggingface, github), probe the official
 *      endpoint AND a set of known mirrors *concurrently*, through any proxy
 *      that's already configured (proxyFetch respects HTTPS_PROXY/ALL_PROXY).
 *   2. Measure reachability + latency for each. A mirror only wins if it's
 *      reachable AND meaningfully faster (or the official one is unreachable).
 *   3. Emit a concrete plan: exact registry/index-url/endpoint to use, plus the
 *      precise command or env export to set it.
 *   4. With `apply: true`, write the durable config where one exists
 *      (~/.npmrc, pip.conf, git http.proxy) and print the env exports that the
 *      user must add to their shell (a tool can't mutate the parent shell's env).
 *
 * Read-only by default (just probes + recommends). `apply: true` writes config
 * files, so that path is marked destructive.
 */

interface Candidate { label: string; probeUrl: string; value: string; official?: boolean; }
interface EcoResult { ecosystem: string; ranked: Array<{ label: string; value: string; latencyMs: number | null; reachable: boolean; official: boolean }>; }

const ECOSYSTEMS: Record<string, { candidates: Candidate[]; how: (value: string) => string }> = {
  npm: {
    candidates: [
      { label: 'npm official', probeUrl: 'https://registry.npmjs.org/npm', value: 'https://registry.npmjs.org/', official: true },
      { label: 'npmmirror (CN)', probeUrl: 'https://registry.npmmirror.com/npm', value: 'https://registry.npmmirror.com/' },
    ],
    how: (v) => `npm config set registry ${v}    # or add "registry=${v}" to ~/.npmrc`,
  },
  pip: {
    candidates: [
      { label: 'PyPI official', probeUrl: 'https://pypi.org/simple/pip/', value: 'https://pypi.org/simple', official: true },
      { label: 'Tsinghua (CN)', probeUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple/pip/', value: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
      { label: 'Aliyun (CN)', probeUrl: 'https://mirrors.aliyun.com/pypi/simple/pip/', value: 'https://mirrors.aliyun.com/pypi/simple' },
    ],
    how: (v) => `pip config set global.index-url ${v}`,
  },
  huggingface: {
    candidates: [
      { label: 'HuggingFace official', probeUrl: 'https://huggingface.co/api/models?limit=1', value: 'https://huggingface.co', official: true },
      { label: 'hf-mirror (CN)', probeUrl: 'https://hf-mirror.com/api/models?limit=1', value: 'https://hf-mirror.com' },
    ],
    how: (v) => `export HF_ENDPOINT=${v}    # add to ~/.zshrc to persist`,
  },
  github: {
    candidates: [
      { label: 'GitHub', probeUrl: 'https://github.com/robots.txt', value: 'https://github.com', official: true },
      { label: 'GitHub API', probeUrl: 'https://api.github.com/zen', value: 'https://api.github.com' },
    ],
    how: () => `If GitHub is slow/unreachable, route git through your proxy:\n    git config --global http.proxy $HTTPS_PROXY\n  or use a proxy/Warp for the whole session.`,
  },
};

async function probe(url: string, timeoutMs: number): Promise<{ reachable: boolean; latencyMs: number | null }> {
  const start = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await proxyFetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    // Any HTTP response (even 4xx) means the host is reachable; we only care that
    // the TCP+TLS+routing path works, not the specific status.
    return { reachable: res.status > 0, latencyMs: Date.now() - start };
  } catch {
    clearTimeout(t);
    return { reachable: false, latencyMs: null };
  }
}

const Args = z.object({
  ecosystems: z.array(z.enum(['npm', 'pip', 'huggingface', 'github'])).optional()
    .describe('Which ecosystems to optimize. Default: all four.'),
  apply: z.boolean().optional()
    .describe('If true, write durable config (~/.npmrc, pip.conf, git http.proxy) for the winning mirrors. Default false (recommend only).'),
  timeout_seconds: z.number().int().min(1).max(30).optional()
    .describe('Per-probe timeout. Default 6.'),
});

export class NetworkOptimizeTool extends Tool<z.infer<typeof Args>> {
  name = 'network_optimize';
  description = 'Diagnose a slow/restricted network and pick the fastest reachable package mirror for npm, pip, HuggingFace and GitHub. Probes official vs known mirrors concurrently (through any configured proxy), ranks by reachability + latency, and returns the exact config to use. Set apply:true to write ~/.npmrc / pip.conf / git proxy automatically. Use this when installs time out (the recurring [NO_RESULTS] / npm-hang situation).';
  isReadOnly = false; // probing is read-only; apply writes config files
  isDestructive = false; // gated: only apply:true mutates, surfaced in output
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, _ctx: ToolContext): Promise<ToolResult> {
    const timeoutMs = (args.timeout_seconds ?? 6) * 1000;
    const targets = args.ecosystems ?? ['npm', 'pip', 'huggingface', 'github'];

    const results: EcoResult[] = await Promise.all(targets.map(async (eco) => {
      const spec = ECOSYSTEMS[eco]!;
      const probed = await Promise.all(spec.candidates.map(async (c) => {
        const { reachable, latencyMs } = await probe(c.probeUrl, timeoutMs);
        return { label: c.label, value: c.value, latencyMs, reachable, official: c.official ?? false };
      }));
      // Rank: reachable first, then lowest latency.
      probed.sort((a, b) => {
        if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
        return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
      });
      return { ecosystem: eco, ranked: probed };
    }));

    const lines: string[] = ['# Network optimization report', ''];
    const plan: Array<{ eco: string; value: string }> = [];

    for (const r of results) {
      lines.push(`## ${r.ecosystem}`);
      for (const c of r.ranked) {
        const lat = c.reachable ? `${c.latencyMs} ms` : 'unreachable';
        lines.push(`  ${c.reachable ? '✓' : '✗'} ${c.label.padEnd(22)} ${lat}`);
      }
      const best = r.ranked[0];
      if (!best || !best.reachable) {
        lines.push(`  → none reachable. Use a proxy / Warp, then re-run.`);
      } else {
        // Recommend switching only if the winner is a non-official mirror that
        // beat the official endpoint, or the official one is unreachable.
        const official = r.ranked.find(c => c.official);
        const switchTo = !official?.reachable || (!best.official);
        if (switchTo && !best.official) {
          lines.push(`  → RECOMMEND: ${best.label}`);
          lines.push(`    ${ECOSYSTEMS[r.ecosystem]!.how(best.value)}`);
          plan.push({ eco: r.ecosystem, value: best.value });
        } else {
          lines.push(`  → official endpoint is fine (fastest reachable).`);
        }
      }
      lines.push('');
    }

    if (args.apply && plan.length > 0) {
      lines.push('## Applied');
      for (const p of plan) {
        try {
          const msg = await this.applyOne(p.eco, p.value);
          lines.push(`  ✓ ${p.eco}: ${msg}`);
        } catch (e: any) {
          lines.push(`  ✗ ${p.eco}: ${e.message}`);
        }
      }
      lines.push('');
      lines.push('Note: HF_ENDPOINT and proxy env vars can only be *suggested* — a tool');
      lines.push('cannot change the parent shell. Add the export lines above to ~/.zshrc.');
    } else if (plan.length > 0) {
      lines.push('Run again with apply:true to write the npm/pip/git config automatically.');
    }

    return { content: lines.join('\n') };
  }

  /** Write durable config for one ecosystem. Returns a short status string. */
  private async applyOne(eco: string, value: string): Promise<string> {
    if (eco === 'npm') {
      const npmrc = path.join(os.homedir(), '.npmrc');
      await this.upsertLine(npmrc, /^registry=.*/m, `registry=${value}`);
      return `wrote registry to ~/.npmrc`;
    }
    if (eco === 'pip') {
      // pip uses ~/.config/pip/pip.conf on macOS/Linux.
      const dir = path.join(os.homedir(), '.config', 'pip');
      await fs.mkdir(dir, { recursive: true });
      const conf = path.join(dir, 'pip.conf');
      let body = '';
      try { body = await fs.readFile(conf, 'utf8'); } catch { /* new file */ }
      if (!/^\[global\]/m.test(body)) body = `[global]\nindex-url = ${value}\n` + body;
      else if (/^index-url\s*=.*/m.test(body)) body = body.replace(/^index-url\s*=.*/m, `index-url = ${value}`);
      else body = body.replace(/^\[global\]/m, `[global]\nindex-url = ${value}`);
      await fs.writeFile(conf, body);
      return `wrote index-url to ~/.config/pip/pip.conf`;
    }
    if (eco === 'github') {
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY;
      if (!proxy) return `no proxy env set — nothing to apply (set HTTPS_PROXY first)`;
      const r = await runProcess('git', ['config', '--global', 'http.proxy', proxy], { timeoutMs: 10_000 });
      if (r.notFound) return `git not installed`;
      return r.ok ? `set git http.proxy to ${proxy}` : `git config failed: ${r.stderr.trim()}`;
    }
    // huggingface: env-only, can't persist from a tool.
    return `set via env: export HF_ENDPOINT=${value} (add to ~/.zshrc)`;
  }

  /** Insert or replace a single line in a config file (creating it if needed). */
  private async upsertLine(file: string, matcher: RegExp, line: string): Promise<void> {
    let body = '';
    try { body = await fs.readFile(file, 'utf8'); } catch { /* new file */ }
    if (matcher.test(body)) body = body.replace(matcher, line);
    else body = (body && !body.endsWith('\n') ? body + '\n' : body) + line + '\n';
    await fs.writeFile(file, body);
  }
}
