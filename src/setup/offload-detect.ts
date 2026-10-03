/**
 * Auto-detect the knobs for `suggestGpuLayers` — so `qodex offload` can propose a `num_gpu`
 * instead of the user guessing. Two halves:
 *
 *   - PURE parsers (unit-tested) for the tool/API outputs: nvidia-smi VRAM, macOS unified
 *     memory, and an Ollama `/api/show` block_count.
 *   - Best-effort detectors that actually run the tools / hit the API and degrade to null when
 *     they're absent (no GPU, daemon down, weird platform) — detection never throws.
 *
 * The decision math lives in src/llm/offload.ts; this only gathers the inputs.
 */
import { spawnSync } from 'child_process';
import { suggestGpuLayers, type OffloadPlan } from '../llm/offload.js';

// ── PURE parsers ────────────────────────────────────────────────────────────────

/** nvidia-smi `--query-gpu=memory.total --format=csv,noheader,nounits` → GB of the biggest GPU. */
export function parseNvidiaSmiVram(stdout: string): number | null {
  const mibs = stdout.split('\n').map(l => parseInt(l.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  if (!mibs.length) return null;
  return Math.max(...mibs) / 1024; // MiB → GiB
}

/** `sysctl -n hw.memsize` (bytes) → GB of total RAM (Apple Silicon shares it with the GPU). */
export function parseMacMemGB(stdout: string): number | null {
  const bytes = parseInt(stdout.trim(), 10);
  return Number.isFinite(bytes) && bytes > 0 ? bytes / 1024 ** 3 : null;
}

/** Pull the transformer block count out of an Ollama /api/show `model_info` map. The key is
 *  arch-prefixed (e.g. `qwen3.block_count`, `llama.block_count`), so match on the suffix. PURE. */
export function extractBlockCount(modelInfo: Record<string, unknown> | undefined | null): number | null {
  if (!modelInfo) return null;
  for (const [k, v] of Object.entries(modelInfo)) {
    if (/\.block_count$/.test(k) && typeof v === 'number' && v > 0) return v;
  }
  return null;
}

// ── best-effort detectors (impure) ───────────────────────────────────────────────

/** Detect a usable VRAM budget in GB. NVIDIA → the GPU's memory; Apple Silicon → a fraction of
 *  unified RAM (the rest stays for the OS); else null. Never throws. */
export function detectVramGB(): number | null {
  try {
    const smi = spawnSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf-8', timeout: 4000 });
    if (smi.status === 0 && smi.stdout) {
      const gb = parseNvidiaSmiVram(smi.stdout);
      if (gb) return gb;
    }
  } catch { /* no nvidia-smi */ }
  if (process.platform === 'darwin') {
    try {
      const mem = spawnSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf-8', timeout: 4000 });
      const total = mem.status === 0 ? parseMacMemGB(mem.stdout ?? '') : null;
      if (total) return Math.round(total * 0.7); // unified memory — leave headroom for the OS
    } catch { /* unavailable */ }
  }
  return null;
}

export interface ModelFacts { totalLayers: number; modelSizeGB: number; }

/** Ask Ollama about a model: block count (from /api/show) + on-disk size (from /api/tags). */
export async function fetchOllamaModelFacts(baseUrl: string, model: string): Promise<ModelFacts | null> {
  try {
    const showRes = await fetch(`${baseUrl.replace(/\/$/, '')}/api/show`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: model }), signal: AbortSignal.timeout(5000),
    });
    if (!showRes.ok) return null;
    const show: any = await showRes.json();
    const totalLayers = extractBlockCount(show?.model_info);
    if (!totalLayers) return null;

    let modelSizeGB = 0;
    try {
      const tagsRes = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (tagsRes.ok) {
        const tags: any = await tagsRes.json();
        const hit = (tags?.models ?? []).find((m: any) => m.name === model || m.model === model);
        if (hit?.size) modelSizeGB = Number(hit.size) / 1e9;
      }
    } catch { /* size optional */ }
    if (!modelSizeGB) return null;
    return { totalLayers, modelSizeGB };
  } catch {
    return null;
  }
}

export interface OffloadSuggestion { plan: OffloadPlan; facts: ModelFacts; vramGB: number; }

/** Gather hardware + model facts and compute an offload plan. Returns null when anything needed
 *  is unavailable (so the caller can say "couldn't auto-detect — set num_gpu manually"). */
export async function planOffload(opts: { baseUrl: string; model: string; vramBudgetGB?: number }): Promise<OffloadSuggestion | null> {
  const vramGB = opts.vramBudgetGB ?? detectVramGB();
  if (!vramGB) return null;
  const facts = await fetchOllamaModelFacts(opts.baseUrl, opts.model);
  if (!facts) return null;
  const plan = suggestGpuLayers({ modelSizeGB: facts.modelSizeGB, vramBudgetGB: vramGB, totalLayers: facts.totalLayers });
  return { plan, facts, vramGB };
}
