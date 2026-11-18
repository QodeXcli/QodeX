/**
 * Kernel / driver / XNU bridge — the TypeScript side of REA's ring-0 layer.
 *
 * TypeScript runs in user space (Ring 3 / EL0), so kernel access goes
 * through a native N-API addon (Rust, napi-rs) that talks to a custom
 * Windows driver via DeviceIoControl, to macOS EndpointSecurity /
 * Hypervisor.framework, or to Linux/Android eBPF programs.
 *
 * The Rust crate lives at `native/kernel-bridge` (napi-rs 2, `rea-kernel-bridge`).
 * Until it is compiled (`cd native/kernel-bridge && npm run build`) and its
 * `.node` file is placed where `loadNativeAddon` can find it,
 * `KernelOrchestrator.bootstrap()` throws a clear error saying so. Nothing
 * here pretends to touch the kernel.
 */
import { EventEmitter } from 'events';
import { createRequire } from 'module';

export enum PlatformTarget {
  WINDOWS_NT = 'win32_nt',
  MACOS_XNU = 'darwin_xnu',
  ANDROID_EBPF = 'linux_ebpf',
}

export interface SyscallEvent {
  pid: number;
  tid: number;
  processName: string;
  syscallId: number;
  args: BigUint64Array;
  returnAddress: bigint;
}

/** The binary surface the Rust N-API addon must export. */
export interface NativeKernelAddon {
  initDriverConnection(platform: PlatformTarget, driverPath?: string): boolean;
  readPhysicalMemory(physAddr: bigint, size: number): Buffer;
  readProcessVirtualMemory(pid: number, vAddr: bigint, size: number): Buffer;
  installSyscallHook(syscallName: string, callback: (event: SyscallEvent) => void): number;
  hideProcessFromKernelList(pid: number): boolean;
}

const ADDON_NOT_BUILT =
  'REA kernel addon is not built. The Rust crate exists at native/kernel-bridge (napi-rs 2) but its .node file has not been compiled yet. ' +
  'Build it with: cd native/kernel-bridge && npm run build — then pass the resulting .node file to loadNativeAddon(). ' +
  'Note: syscall hooks still need their event source (Windows .sys driver, macOS EndpointSecurity client, Linux eBPF object); without one, register_syscall_hook returns a clear error instead of a hook id that never fires.';

/** Load and validate the native addon from a `.node` file. */
export function loadNativeAddon(addonPath: string): NativeKernelAddon {
  let mod: unknown;
  try {
    mod = createRequire(import.meta.url)(addonPath);
  } catch (e: any) {
    throw new Error(`${ADDON_NOT_BUILT} (load failed: ${e?.message ?? e})`);
  }
  const addon = (mod as { default?: unknown }).default ?? mod;
  const required: (keyof NativeKernelAddon)[] = [
    'initDriverConnection',
    'readPhysicalMemory',
    'readProcessVirtualMemory',
    'installSyscallHook',
    'hideProcessFromKernelList',
  ];
  for (const fn of required) {
    if (typeof (addon as Record<string, unknown>)[fn] !== 'function') {
      throw new Error(
        `${ADDON_NOT_BUILT} (addon at ${addonPath} does not export ${fn})`,
      );
    }
  }
  return addon as NativeKernelAddon;
}

export class KernelOrchestrator extends EventEmitter {
  private native: NativeKernelAddon | null = null;

  constructor(private platform: PlatformTarget) {
    super();
  }

  public bootstrap(addonPath: string, driverPath?: string): void {
    this.native = loadNativeAddon(addonPath);
    const connected = this.native.initDriverConnection(this.platform, driverPath);
    if (!connected) {
      throw new Error(`Could not connect to the kernel layer: ${this.platform}`);
    }
  }

  public get connected(): boolean {
    return this.native !== null;
  }

  /**
   * Trace sensitive syscalls at the kernel level. Emits a `syscall` event
   * per hit: `{ syscall, pid, tid, processName, syscallId, args, returnAddress }`.
   */
  public traceKernelSyscalls(syscalls: string[]): void {
    if (!this.native) throw new Error(ADDON_NOT_BUILT);
    for (const sc of syscalls) {
      this.native.installSyscallHook(sc, (event: SyscallEvent) => {
        this.emit('syscall', { syscall: sc, ...event });
      });
    }
  }

  /** Direct memory dump from the kernel, bypassing user-space protections. */
  public dumpProtectedMemory(pid: number, baseAddress: bigint, size: number): Buffer {
    if (!this.native) throw new Error(ADDON_NOT_BUILT);
    return this.native.readProcessVirtualMemory(pid, baseAddress, size);
  }
}
