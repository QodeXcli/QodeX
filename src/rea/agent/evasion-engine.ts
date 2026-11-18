/**
 * Universal evasion engine — runs INSIDE the target process (compiled with
 * frida-compile, loaded by `ProcessInjector`).
 *
 * Neutralises, in memory, the checks a target uses to refuse to run under
 * instrumentation: root / jailbreak file probes (libc `faccessat`), the
 * XNU anti-debug trap (`ptrace` PT_DENY_ATTACH), Android certificate
 * pinning (Conscrypt `TrustManagerImpl`), and Apple certificate trust
 * (`SecTrustEvaluateWithError`).
 *
 * Every bypass is installed only when its runtime is present
 * (`Java.available` / `ObjC.available` / Darwin for ptrace); a missing
 * runtime is a no-op, never a crash. Hooks are best-effort: a target that
 * moved to a newer API (e.g. a renamed TrustManager method) simply keeps
 * its original check, and the host sees that nothing was hooked.
 */
import { findExport } from './util.js';

export class UniversalEvasionEngine {
  public activateAllBypasses(): void {
    this.bypassLowLevelFileChecks();
    this.bypassAntiDebug();
    if (Java.available) this.bypassAndroidSecurity();
    if (ObjC.available) this.bypassAppleSecurity();
  }

  /** Hide root / jailbreak artefacts from libc file probes. */
  private bypassLowLevelFileChecks(): void {
    const blacklistedPaths = [
      '/sbin/su',
      '/system/bin/su',
      '/system/xbin/su',
      'magisk',
      '/Applications/Cydia.app',
      '/Library/MobileSubstrate',
      '/bin/bash',
      '/usr/sbin/sshd',
    ];

    const faccessatPtr = findExport(null, 'faccessat');
    if (faccessatPtr === null) return;

    Interceptor.attach(faccessatPtr, {
      onEnter(args) {
        this.path = args[1].readUtf8String() ?? '';
      },
      onLeave(retval) {
        const path = (this.path as string) ?? '';
        if (blacklistedPaths.some((item) => path.includes(item))) {
          retval.replace(ptr(-1)); // ENOENT — the file does not exist.
        }
      },
    });
  }

  /**
   * Neutralise XNU anti-debugging (`ptrace` PT_DENY_ATTACH = 31).
   * Darwin-only: on Linux request 31 is a different ptrace operation, so
   * the hook is not installed there.
   */
  private bypassAntiDebug(): void {
    if (Process.platform !== 'darwin') return;
    const ptracePtr = findExport(null, 'ptrace');
    if (ptracePtr === null) return;

    Interceptor.attach(ptracePtr, {
      onEnter(args) {
        if (args[0].toInt32() === 31) {
          args[0] = ptr(0);
        }
      },
      onLeave(retval) {
        retval.replace(ptr(0));
      },
    });
  }

  /**
   * Android SSL pinning (Conscrypt / OkHttp / TrustManager).
   * `verifyChain` really takes (untrustedChain, trustAnchorChain, host,
   * clientAuth, ocspData, tlsSctData) and returns the verified chain — the
   * bypass returns the untrusted chain as-is instead of validating it.
   * The class may not be loaded in this process; that is a no-op.
   */
  private bypassAndroidSecurity(): void {
    try {
      Java.perform(() => {
        let trustManagerImpl: { [method: string]: any };
        try {
          trustManagerImpl = Java.use('com.android.org.conscrypt.TrustManagerImpl');
        } catch {
          return; // Conscrypt is not in this process.
        }
        const verifyChain = trustManagerImpl['verifyChain'];
        if (typeof verifyChain === 'undefined') return;
        verifyChain.implementation = function (untrustedChain: unknown) {
          return untrustedChain;
        };
      });
    } catch {
      // Java runtime went away mid-call; nothing to bypass.
    }
  }

  /** iOS / macOS certificate trust (`SecTrustEvaluateWithError`). */
  private bypassAppleSecurity(): void {
    const secTrustPtr = findExport('Security', 'SecTrustEvaluateWithError');
    if (secTrustPtr === null) return;

    Interceptor.replace(
      secTrustPtr,
      new NativeCallback(
        (_trust: NativePointer, errorPtr: NativePointer) => {
          if (!errorPtr.isNull()) errorPtr.writePointer(ptr(0));
          return 1; // Certificate trusted.
        },
        'bool',
        ['pointer', 'pointer'],
      ),
    );
  }
}
