import { describe, it, expect } from 'vitest';
import { detectHardware, formatHardwareSummary } from '../src/setup/hardware-profile.js';

describe('detectHardware', () => {
  it('returns a complete profile with all fields populated', () => {
    const p = detectHardware();
    expect(p.os).toMatch(/macos|linux|windows|other/);
    expect(p.arch).toMatch(/arm64|x64|other/);
    expect(typeof p.appleSilicon).toBe('boolean');
    expect(typeof p.cpuLabel).toBe('string');
    expect(p.cpuLabel.length).toBeGreaterThan(0);
    expect(p.cpuCores).toBeGreaterThan(0);
    expect(p.ramGb).toBeGreaterThan(0);
    expect(p.tier).toMatch(/small|medium|large|xl/);
    expect(Array.isArray(p.recommendedModels)).toBe(true);
    expect(p.recommendedModels.length).toBeGreaterThan(0);
  });

  it('appleSilicon flag matches macos+arm64', () => {
    const p = detectHardware();
    if (p.appleSilicon) {
      expect(p.os).toBe('macos');
      expect(p.arch).toBe('arm64');
    }
  });

  it('tier reflects RAM (or VRAM for non-Apple)', () => {
    const p = detectHardware();
    // The function chooses memGb based on GPU vram (if >=6GB dedicated) otherwise RAM
    // For Apple Silicon, GPU vram === RAM; for non-GPU systems same
    const memGb = p.gpu.vramGb && p.gpu.vramGb >= 6 ? p.gpu.vramGb : p.ramGb;
    if (memGb >= 64) expect(p.tier).toBe('xl');
    else if (memGb >= 32) expect(p.tier).toBe('large');
    else if (memGb >= 12) expect(p.tier).toBe('medium');
    else expect(p.tier).toBe('small');
  });

  it('Apple Silicon profile reports unified memory', () => {
    const p = detectHardware();
    if (p.appleSilicon) {
      expect(p.gpu.label).toMatch(/unified/i);
      expect(p.gpu.vramGb).toBe(p.ramGb);
      expect(p.gpu.canRunLLM).toBe(true);
    }
  });

  it('xl tier on Apple Silicon prefers DeepSeek-V3 / Qwen 72B', () => {
    // We can't force the runtime hardware, but we can test the recommendation logic
    // by directly inspecting what tier=xl + appleSilicon produces.
    const p = detectHardware();
    if (p.tier === 'xl' && p.appleSilicon) {
      // First recommendation should still be the most reliable tool-caller (qwen-coder)
      expect(p.recommendedModels[0]).toContain('qwen2.5-coder');
      // But DeepSeek-V3 should be in the list (MoE candidate)
      expect(p.recommendedModels.some(m => /deepseek-v3/.test(m))).toBe(true);
    }
  });

  it('small tier recommends only 7B-class models', () => {
    const p = detectHardware();
    if (p.tier === 'small') {
      for (const m of p.recommendedModels) {
        // Should NOT recommend 32B / 72B / MoE on small hardware
        expect(m).not.toMatch(/32b|72b|mixtral/i);
      }
    }
  });
});

describe('formatHardwareSummary', () => {
  it('produces readable multi-line output with all key fields', () => {
    const p = detectHardware();
    const out = formatHardwareSummary(p);
    expect(out).toContain('OS:');
    expect(out).toContain('CPU:');
    expect(out).toContain('RAM:');
    expect(out).toContain('GPU:');
    expect(out).toContain('Recommended tier:');
    expect(out).toContain('Suggested local models:');
    // Should mention the actual tier
    expect(out).toContain(p.tier);
  });
});
