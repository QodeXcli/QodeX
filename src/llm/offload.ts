/**
 * Local-engine offloading helpers — run a model that's bigger than your VRAM by keeping some
 * layers on the CPU. Especially relevant for large Mixture-of-Experts (MoE) coders (Qwen3-Coder
 * MoE, DeepSeek-MoE …): the bulk of the weights are expert FFN layers, so offloading a slice of
 * layers to system RAM lets a 30–100B MoE run on a 12–24 GB GPU at usable speed.
 *
 * QodeX already forwards `providers.ollama.options` verbatim, so `num_gpu` (the number of layers
 * to keep on the GPU; the rest run on CPU) Just Works. These PURE helpers turn a VRAM budget +
 * model facts into a sensible `num_gpu`, so a setup wizard or the docs can suggest one instead of
 * the user guessing. No I/O, no hardware probing — caller supplies the numbers.
 */

export interface OffloadInputs {
  /** On-disk size of the (quantized) weights, GB. */
  modelSizeGB: number;
  /** VRAM you're willing to give the model, GB (leave headroom for the desktop / other apps). */
  vramBudgetGB: number;
  /** Total transformer layers (blocks) in the model. */
  totalLayers: number;
  /** VRAM reserved for the KV cache + activations + overhead, GB. Default 1.5. */
  reserveGB?: number;
}

export interface OffloadPlan {
  /** Layers to keep on the GPU — feed as `options.num_gpu`. 0 = pure CPU; totalLayers = all-GPU. */
  numGpu: number;
  /** Fraction of layers on the GPU (0–1) — a quick "how offloaded am I" read. */
  gpuFraction: number;
  /** True when the whole model fits and no offloading is needed. */
  fitsFully: boolean;
}

/** Suggest how many layers to keep on the GPU given a VRAM budget. PURE. Clamps to [0, total]. */
export function suggestGpuLayers(inp: OffloadInputs): OffloadPlan {
  const total = Math.max(1, Math.floor(inp.totalLayers));
  const reserve = inp.reserveGB ?? 1.5;
  const perLayerGB = inp.modelSizeGB / total;
  const usable = inp.vramBudgetGB - reserve;
  if (perLayerGB <= 0 || !Number.isFinite(perLayerGB)) {
    return { numGpu: total, gpuFraction: 1, fitsFully: true };
  }
  const raw = Math.floor(usable / perLayerGB);
  const numGpu = Math.max(0, Math.min(total, raw));
  return { numGpu, gpuFraction: numGpu / total, fitsFully: numGpu >= total };
}

/** One-line, human-readable summary of an offload plan (for `qodex setup` / docs). PURE. */
export function describeOffload(plan: OffloadPlan, totalLayers: number): string {
  if (plan.fitsFully) return `Fits in VRAM — all ${totalLayers} layers on GPU (num_gpu: ${plan.numGpu}).`;
  if (plan.numGpu === 0) return `Too tight for GPU layers — running on CPU (num_gpu: 0). Expect slow generation.`;
  const pct = Math.round(plan.gpuFraction * 100);
  return `Offload: keep ${plan.numGpu}/${totalLayers} layers (${pct}%) on GPU, the rest on CPU — set options.num_gpu: ${plan.numGpu}.`;
}
