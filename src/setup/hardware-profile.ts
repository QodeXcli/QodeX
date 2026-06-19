/**
 * Hardware profile detection.
 *
 * Tells the setup wizard (and `qx setup --check`) what kind of machine we're on so
 * it can recommend a sensibly-sized local model. Tier mapping:
 *
 *   small  : < 12 GB RAM           → 7B param models
 *   medium : 12–32 GB               → 14B models
 *   large  : 32–64 GB               → 32B models
 *   xl     : 64 GB+                  → 32B+ comfortably, MoE candidates (Mixtral, DeepSeek-V3)
 *
 * The tier is a *suggestion*, not a constraint. Users can override anything. Detection
 * is best-effort and never blocks — failures result in `unknown` fields, not exceptions.
 */
import * as os from 'os';
import { spawnSync } from 'child_process';

export type HardwareTier = 'small' | 'medium' | 'large' | 'xl';

export interface HardwareProfile {
  os: 'macos' | 'linux' | 'windows' | 'other';
  arch: 'arm64' | 'x64' | 'other';
  appleSilicon: boolean;
  /** Free-form short label, e.g. "Apple M2 Pro" or "Intel Xeon E5-2680" or "Unknown". */
  cpuLabel: string;
  cpuCores: number;
  /** Total RAM in GB, rounded. */
  ramGb: number;
  /** GPU description if detectable. On Apple Silicon, GPU shares RAM (unified memory). */
  gpu: {
    /** Human label, e.g. "Apple integrated (unified memory)" or "NVIDIA RTX 4090". */
    label: string;
    /** VRAM in GB. On Apple Silicon, equal to RAM (unified). null = unknown. */
    vramGb: number | null;
    /** Whether the GPU is realistically usable for local LLM inference. */
    canRunLLM: boolean;
  };
  diskFreeGb: number | null;
  tier: HardwareTier;
  /** Model id recommendations for this tier, ordered by suitability. */
  recommendedModels: string[];
}

/** The single public entry point. */
export function detectHardware(): HardwareProfile {
  const platform = os.platform();
  const osKind: HardwareProfile['os'] =
    platform === 'darwin' ? 'macos' :
    platform === 'linux' ? 'linux' :
    platform === 'win32' ? 'windows' : 'other';
  const arch: HardwareProfile['arch'] =
    os.arch() === 'arm64' ? 'arm64' :
    os.arch() === 'x64' ? 'x64' : 'other';
  const appleSilicon = osKind === 'macos' && arch === 'arm64';

  const ramGb = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  const cpuCores = os.cpus().length;
  const cpuLabel = detectCpuLabel(osKind);
  const gpu = detectGpu(osKind, appleSilicon, ramGb);
  const diskFreeGb = detectFreeDisk(osKind);
  const tier = chooseTier(ramGb, gpu);
  const recommendedModels = recommendModels(tier, appleSilicon);

  return {
    os: osKind, arch, appleSilicon,
    cpuLabel, cpuCores, ramGb,
    gpu, diskFreeGb,
    tier, recommendedModels,
  };
}

// ── CPU label ────────────────────────────────────────────────────────────────

function detectCpuLabel(osKind: HardwareProfile['os']): string {
  // os.cpus()[0].model works on every platform but the strings are wildly different.
  // We do a tiny per-OS cleanup so the wizard line looks reasonable.
  const raw = os.cpus()[0]?.model?.trim() ?? 'Unknown CPU';

  if (osKind === 'macos') {
    // macOS gives strings like "Apple M2 Pro" already — good as-is.
    return raw;
  }
  if (osKind === 'linux') {
    // Linux gives the full Intel/AMD marketing name. Trim the trailing speed parens / @ if any.
    return raw.replace(/\s*@\s*[\d.]+\s*[GMK]?Hz/i, '').replace(/\s+CPU\s*/i, ' ').trim();
  }
  if (osKind === 'windows') {
    return raw;
  }
  return raw;
}

// ── GPU ──────────────────────────────────────────────────────────────────────

function detectGpu(osKind: HardwareProfile['os'], appleSilicon: boolean, ramGb: number): HardwareProfile['gpu'] {
  // Apple Silicon: GPU is the M-series integrated unit, RAM is unified.
  // No need to shell out — we already know the architecture.
  if (appleSilicon) {
    return {
      label: 'Apple integrated (unified memory)',
      vramGb: ramGb,           // unified: full system RAM is addressable by the GPU
      canRunLLM: true,
    };
  }

  if (osKind === 'linux' || osKind === 'windows') {
    // Try nvidia-smi first. It's the most common dedicated-GPU case for LLM work.
    const nv = tryRun('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 2000);
    if (nv && nv.exitCode === 0 && nv.stdout.trim()) {
      // Output like: "NVIDIA GeForce RTX 4090, 24564"
      const firstLine = nv.stdout.trim().split('\n')[0] ?? '';
      const parts = firstLine.split(',').map(s => s.trim());
      const name = parts[0] ?? 'NVIDIA GPU';
      const vramMb = parseInt(parts[1] ?? '0', 10);
      const vramGb = vramMb > 0 ? Math.round(vramMb / 1024) : null;
      return {
        label: name,
        vramGb,
        canRunLLM: (vramGb ?? 0) >= 6,
      };
    }
    // AMD via rocm-smi (less common, best-effort)
    const amd = tryRun('rocm-smi', ['--showmeminfo', 'vram'], 2000);
    if (amd && amd.exitCode === 0 && /VRAM/i.test(amd.stdout)) {
      return { label: 'AMD GPU (ROCm)', vramGb: null, canRunLLM: true };
    }
    // No dedicated GPU found — integrated only, not realistic for local LLM > 7B
    return {
      label: 'integrated / unknown',
      vramGb: null,
      canRunLLM: false,
    };
  }

  return { label: 'unknown', vramGb: null, canRunLLM: false };
}

// ── Disk free ────────────────────────────────────────────────────────────────

function detectFreeDisk(osKind: HardwareProfile['os']): number | null {
  if (osKind === 'macos' || osKind === 'linux') {
    // `df -k .` is portable across both. Take the "Available" column.
    const r = tryRun('df', ['-k', os.homedir()], 2000);
    if (r && r.exitCode === 0) {
      const lines = r.stdout.trim().split('\n');
      const data = lines[lines.length - 1] ?? '';
      const cols = data.split(/\s+/);
      // df output: Filesystem 1024-blocks Used Available Capacity Mounted
      const availKb = parseInt(cols[3] ?? '0', 10);
      if (availKb > 0) return Math.round(availKb / 1024 / 1024);
    }
  }
  if (osKind === 'windows') {
    // PowerShell one-liner — only attempted if powershell is on PATH
    const r = tryRun('powershell', ['-NoProfile', '-Command',
      '(Get-PSDrive C).Free / 1GB'], 3000);
    if (r && r.exitCode === 0) {
      const n = parseFloat(r.stdout.trim());
      if (!isNaN(n)) return Math.round(n);
    }
  }
  return null;
}

// ── Tier ─────────────────────────────────────────────────────────────────────

function chooseTier(ramGb: number, gpu: HardwareProfile['gpu']): HardwareTier {
  // For non-Apple, dedicated VRAM is the real constraint. Use it if available.
  // Otherwise RAM is the best proxy (Apple Silicon uses unified, Linux/Windows
  // without a real GPU will CPU-offload from RAM at slow speeds).
  const memGb = gpu.vramGb && gpu.vramGb >= 6 ? gpu.vramGb : ramGb;

  if (memGb >= 64) return 'xl';
  if (memGb >= 32) return 'large';
  if (memGb >= 12) return 'medium';
  return 'small';
}

// ── Model recommendations ────────────────────────────────────────────────────

function recommendModels(tier: HardwareTier, appleSilicon: boolean): string[] {
  // Order: most-suitable first. We bias toward Qwen-coder (best for tool calling at each
  // size) but list runners-up so users with different preferences see options.
  // Apple Silicon gets MoE candidates earlier since unified memory tolerates them well.
  switch (tier) {
    case 'small':
      return ['qwen2.5-coder:7b', 'deepseek-coder-v2:lite', 'qwen2.5-coder:3b'];
    case 'medium':
      return ['qwen2.5-coder:14b', 'qwen2.5-coder:7b', 'deepseek-coder-v2:lite'];
    case 'large':
      return ['qwen2.5-coder:32b', 'qwen2.5-coder:14b', 'deepseek-coder-v2:16b'];
    case 'xl':
      return appleSilicon
        ? ['qwen2.5-coder:32b', 'deepseek-v3', 'qwen2.5:72b', 'mixtral:8x22b']
        : ['qwen2.5-coder:32b', 'qwen2.5:72b', 'deepseek-coder-v2:236b', 'mixtral:8x22b'];
  }
}

// ── tiny spawnSync helper ────────────────────────────────────────────────────

interface RunResult { exitCode: number; stdout: string; stderr: string }

function tryRun(cmd: string, args: string[], timeoutMs: number): RunResult | null {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: timeoutMs });
    if (r.error) return null;
    return {
      exitCode: r.status ?? 1,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    };
  } catch {
    return null;
  }
}

/** Pretty single-block summary for the wizard / `qx setup --check`. */
export function formatHardwareSummary(p: HardwareProfile): string {
  const osLabel = p.os === 'macos' ? `macOS${p.appleSilicon ? ` (${p.arch}, Apple Silicon)` : ` (${p.arch})`}`
    : p.os === 'linux' ? `Linux (${p.arch})`
    : p.os === 'windows' ? `Windows (${p.arch})`
    : `${p.os} (${p.arch})`;
  const diskLine = p.diskFreeGb !== null ? `${p.diskFreeGb} GB free` : 'unknown';
  const vramLine = p.gpu.vramGb !== null ? `${p.gpu.vramGb} GB` : 'unknown';
  const models = p.recommendedModels?.length ? p.recommendedModels.join(', ') : '(none)';
  return [
    `  OS:     ${osLabel}`,
    `  CPU:    ${p.cpuLabel} (${p.cpuCores} cores)`,
    `  RAM:    ${p.ramGb} GB`,
    `  GPU:    ${p.gpu.label}${p.gpu.vramGb !== null ? ` (${vramLine})` : ''}`,
    `  Disk:   ${diskLine}`,
    ``,
    `  Recommended tier: ${p.tier}`,
    `  Suggested local models: ${models}`,
  ].join('\n');
}
