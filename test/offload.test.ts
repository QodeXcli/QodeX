import { describe, it, expect } from 'vitest';
import { suggestGpuLayers, describeOffload } from '../src/llm/offload.ts';

describe('suggestGpuLayers — fit a big (MoE) model on limited VRAM', () => {
  it('keeps ALL layers on GPU when the model fits', () => {
    // 8 GB model, 24 GB VRAM, 32 layers → fits fully.
    const p = suggestGpuLayers({ modelSizeGB: 8, vramBudgetGB: 24, totalLayers: 32 });
    expect(p.fitsFully).toBe(true);
    expect(p.numGpu).toBe(32);
    expect(p.gpuFraction).toBe(1);
  });

  it('offloads a slice to CPU when the model is bigger than VRAM', () => {
    // 48 GB MoE, 12 GB VRAM (1.5 reserve → 10.5 usable), 64 layers (0.75 GB/layer) → 14 layers.
    const p = suggestGpuLayers({ modelSizeGB: 48, vramBudgetGB: 12, totalLayers: 64 });
    expect(p.fitsFully).toBe(false);
    expect(p.numGpu).toBe(14);
    expect(p.gpuFraction).toBeCloseTo(14 / 64, 5);
  });

  it('falls back to CPU (num_gpu 0) when even one layer will not fit', () => {
    const p = suggestGpuLayers({ modelSizeGB: 80, vramBudgetGB: 2, totalLayers: 80 }); // 0.5 usable, 1 GB/layer
    expect(p.numGpu).toBe(0);
    expect(p.fitsFully).toBe(false);
  });

  it('clamps and never returns a negative or >total layer count', () => {
    expect(suggestGpuLayers({ modelSizeGB: 1000, vramBudgetGB: 0, totalLayers: 40 }).numGpu).toBe(0);
    expect(suggestGpuLayers({ modelSizeGB: 0, vramBudgetGB: 24, totalLayers: 40 }).numGpu).toBe(40); // degenerate → all GPU
  });

  it('respects a custom reserve', () => {
    const tight = suggestGpuLayers({ modelSizeGB: 32, vramBudgetGB: 16, totalLayers: 32, reserveGB: 8 }); // 8 usable, 1/layer
    expect(tight.numGpu).toBe(8);
  });
});

describe('describeOffload — human summary', () => {
  it('describes full-fit, partial offload, and cpu-only', () => {
    expect(describeOffload({ numGpu: 32, gpuFraction: 1, fitsFully: true }, 32)).toMatch(/Fits in VRAM/);
    expect(describeOffload({ numGpu: 14, gpuFraction: 14 / 64, fitsFully: false }, 64)).toMatch(/keep 14\/64 layers.*num_gpu: 14/);
    expect(describeOffload({ numGpu: 0, gpuFraction: 0, fitsFully: false }, 80)).toMatch(/CPU.*slow/);
  });
});
