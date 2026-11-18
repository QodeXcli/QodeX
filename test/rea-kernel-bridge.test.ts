import { describe, it, expect } from 'vitest';
import {
  KernelOrchestrator,
  PlatformTarget,
  loadNativeAddon,
} from '../src/rea/kernel-bridge.js';

describe('loadNativeAddon', () => {
  it('throws a clear "not built" error for a missing addon file', () => {
    expect(() => loadNativeAddon('/nonexistent/rea-kernel.node')).toThrow(/not built/i);
  });
});

describe('KernelOrchestrator', () => {
  it('bootstrap throws a clear "not built" error when the addon is missing', () => {
    const orch = new KernelOrchestrator(PlatformTarget.ANDROID_EBPF);
    expect(() => orch.bootstrap('/nonexistent/rea-kernel.node')).toThrow(/not built/i);
    expect(orch.connected).toBe(false);
  });

  it('traceKernelSyscalls without bootstrap throws instead of pretending', () => {
    const orch = new KernelOrchestrator(PlatformTarget.MACOS_XNU);
    expect(() => orch.traceKernelSyscalls(['open'])).toThrow(/not built/i);
  });

  it('dumpProtectedMemory without bootstrap throws instead of pretending', () => {
    const orch = new KernelOrchestrator(PlatformTarget.WINDOWS_NT);
    expect(() => orch.dumpProtectedMemory(1234, 0x1000n, 64)).toThrow(/not built/i);
  });
});
