# REA — سیستم مهندسی معکوس خودمختار (Autonomous Reverse Engineering)

معماری یک سیستم مهندسی معکوس خودمختار (REA) در تایپ‌اسکریپت بر پایه دو لایه اصلی بنا می‌شود: لایه ارکستراسیون میزبان (Host Orchestrator) روی Node.js/Bun که از طریق پل ارتباطی بومی (N-API با هسته Rust) با کرنل و سیستم‌عامل صحبت می‌کند، و لایه مامور درون‌حافظه‌ای (In-Memory Agent) که با frida-compile از تایپ‌اسکریپت به کد قابل اجرا درون فضای آدرس‌دهی پروسه هدف تبدیل می‌شود.

در ادامه، معماری دقیق و کدهای ساختاری هر ۶ بخش به صورت ماژولار در تایپ‌اسکریپت طراحی شده است.

## ۱. معماری کلی سیستم (System Blueprint)

```
[ TypeScript Orchestrator (Node.js / Bun) ]
       │
       ├──► [1. Kernel/XNU Bridge] ──(N-API / IOCTL / eBPF)──► Windows Driver (.sys) / macOS EndpointSecurity / Linux eBPF
       ├──► [2. Process Injector]  ──(Frida-Core / Mach Task)─► Target Process Memory Space
       │         └──► [3. Crypto/Traffic Harvester (TS GumJS)]
       │         └──► [4. SSL / Root / Jailbreak Bypass (TS GumJS)]
       ├──► [5. APK/IPA Repackager]──(LIEF / Apktool / Codesign)► Patched & Signed Mobile Binary
       └──► [6. Atom-by-Atom Synthesizer] ──(Ghidra IR + Unicorn + LLM + tsc/rustc)──► Compilable Source Project
```

## ۲. هوک کرنل، درایور و XNU (Kernel / Driver / XNU Bridge)

تایپ‌اسکریپت به تنهایی در فضای کاربر (Ring 3 / EL0) اجرا می‌شود؛ بنابراین برای دسترسی به کرنل (Ring 0 / EL1)، معماری از یک ماژول N-API (نوشته‌شده با Rust) استفاده می‌کند که در ویندوز از طریق DeviceIoControl با درایور سفارشی، در macOS با فریم‌ورک EndpointSecurity / Hypervisor.framework، و در لینوکس/اندروید با برنامه‌های eBPF ارتباط برقرار می‌کند.

```typescript
// src/kernel/KernelBridge.ts
import { EventEmitter } from 'events';

export enum PlatformTarget {
  WINDOWS_NT = 'win32_nt',     // ارتباط با درایور کرنل از طریق IOCTL
  MACOS_XNU = 'darwin_xnu',    // ارتباط با EndpointSecurity و Mach Traps
  ANDROID_EBPF = 'linux_ebpf'  // بارگذاری پروب‌های eBPF روی کرنل اندروید
}

export interface SyscallEvent {
  pid: number;
  tid: number;
  processName: string;
  syscallId: number;
  args: BigUint64Array;
  returnAddress: bigint;
}

// رابط باینری بومی (کامپایل‌شده با napi-rs)
export interface NativeKernelAddon {
  initDriverConnection(platform: PlatformTarget, driverPath?: string): boolean;
  readPhysicalMemory(physAddr: bigint, size: number): Buffer;
  readProcessVirtualMemory(pid: number, vAddr: bigint, size: number): Buffer;
  installSyscallHook(syscallName: string, callback: (event: SyscallEvent) => void): number;
  hideProcessFromKernelList(pid: number): boolean; // تغییر ساختار EPROCESS در ویندوز یا task_t در XNU
}

export class KernelOrchestrator extends EventEmitter {
  private native: NativeKernelAddon;

  constructor(nativeAddon: NativeKernelAddon, private platform: PlatformTarget) {
    super();
    this.native = nativeAddon;
  }

  public bootstrap(driverPath?: string): void {
    const connected = this.native.initDriverConnection(this.platform, driverPath);
    if (!connected) {
      throw new Error(`خطا در اتصال به لایه کرنل: ${this.platform}`);
    }
  }

  // رهگیری فراخوانی‌های سیستمی حساس در سطح کرنل (بدون امکان تشخیص توسط Anti-Cheat یا پروسه‌های هدف)
  public traceKernelSyscalls(syscalls: string[]): void {
    for (const sc of syscalls) {
      this.native.installSyscallHook(sc, (event: SyscallEvent) => {
        this.emit('syscall', { syscall: sc, ...event });
      });
    }
  }

  // دامپ مستقیم حافظه از سطح کرنل برای دور زدن محافظت‌های فضای کاربر (مانند VirtualProtect یا mprotect)
  public dumpProtectedMemory(pid: number, baseAddress: bigint, size: number): Buffer {
    return this.native.readProcessVirtualMemory(pid, baseAddress, size);
  }
}
```

## ۳. تزریق به پروسه (Process Injection Engine)

این ماژول وظیفه دارد کدهای تایپ‌اسکریپتِ کامپایل‌شده را به درون فضای حافظه پروسه هدف (روی ویندوز، مک یا دستگاه موبایل متصل از طریق USB/TCP) تزریق کند و یک کانال ارتباطی دوطرفه (RPC) بسازد.

```typescript
// src/injector/ProcessInjector.ts
import * as frida from 'frida';
import * as fs from 'fs/promises';

export interface InjectionOptions {
  deviceType: 'local' | 'usb' | 'remote';
  targetProcess: string | number;
  spawnMode: boolean; // true: اجرای برنامه از ابتدا با حالت تعلیق (Early Instrumentation)
  agentBundlePath: string;
}

export class ProcessInjector {
  private device!: frida.Device;
  private session!: frida.Session;
  private script!: frida.Script;

  public async inject(options: InjectionOptions): Promise<frida.ScriptExports> {
    // ۱. انتخاب دیوایس هدف (ویندوز/مک محلی یا موبایل از طریق USB)
    if (options.deviceType === 'local') {
      this.device = await frida.getLocalDevice();
    } else if (options.deviceType === 'usb') {
      this.device = await frida.getUsbDevice();
    } else {
      this.device = await frida.getRemoteDevice();
    }

    // ۲. پیوستن به پروسه یا ایجاد پروسه در حالت Suspended برای هوک کردن پیش از اجرای EntryPoint
    let pid: number;
    if (options.spawnMode && typeof options.targetProcess === 'string') {
      pid = await this.device.spawn([options.targetProcess]);
    } else {
      pid = typeof options.targetProcess === 'number'
        ? options.targetProcess
        : (await this.device.getProcess(options.targetProcess)).pid;
    }

    this.session = await this.device.attach(pid);

    // ۳. بارگذاری باندل تایپ‌اسکریپت درون فضای حافظه پروسه
    const agentSource = await fs.readFile(options.agentBundlePath, 'utf8');
    this.script = await this.session.createScript(agentSource, { runtime: frida.ScriptRuntime.QJS });

    this.script.message.connect((message, data) => {
      if (message.type === 'send') {
        this.handleAgentTelemetry(message.payload, data);
      }
    });

    await this.script.load();

    // ۴. آزادسازی پروسه در صورت استفاده از Spawn Mode
    if (options.spawnMode) {
      await this.device.resume(pid);
    }

    return this.script.exports;
  }

  private handleAgentTelemetry(payload: unknown, rawBuffer: Buffer | null): void {
    // ارسال لاگ‌ها، کلیدهای استخراج‌شده و بلوک‌های حافظه به موتور تحلیلگر
    console.log('[Agent Telemetry]:', payload, rawBuffer ? `Buffer(${rawBuffer.byteLength} bytes)` : '');
  }
}
```

## ۴. استخراج کلید و ترافیک از حافظه (In-Memory Key & Traffic Harvester)

کد زیر درون پروسه هدف اجرا می‌شود (نوشته‌شده با @types/frida-gum). این ماژول توابع رمزنگاری کتابخانه‌های OpenSSL، BoringSSL، CommonCrypto (مک و iOS) و BCrypt (ویندوز) را هوک کرده و کلیدهای TLS (با فرمت استاندارد SSLKEYLOGFILE قابل بازگشایی در Wireshark) و بافرهای رمزگشایی‌شده را پیش از رمزنگاری استخراج می‌کند.

```typescript
// src/agent/modules/CryptoHarvester.ts (اجرا در فضای حافظه پروسه هدف)

export class MemoryCryptoHarvester {
  public startHarvesting(): void {
    this.hookTlsReadWrite();
    this.hookSslKeyLog();
    this.hookAppleCommonCrypto();
  }

  // ۱. استخراج ترافیک خام پیش از رمزنگاری و پس از رمزگشایی
  private hookTlsReadWrite(): void {
    const sslWritePtr = Module.findExportByName(null, 'SSL_write');
    const sslReadPtr = Module.findExportByName(null, 'SSL_read');

    if (sslWritePtr) {
      Interceptor.attach(sslWritePtr, {
        onEnter(args) {
          const buf = args[1];
          const len = args[2].toInt32();
          if (len > 0) {
            send({ type: 'TLS_PLAINTEXT_OUT', length: len }, buf.readByteArray(len));
          }
        }
      });
    }

    if (sslReadPtr) {
      Interceptor.attach(sslReadPtr, {
        onEnter(args) {
          this.buf = args[1];
        },
        onLeave(retval) {
          const len = retval.toInt32();
          if (len > 0 && this.buf) {
            send({ type: 'TLS_PLAINTEXT_IN', length: len }, this.buf.readByteArray(len));
          }
        }
      });
    }
  }

  // ۲. استخراج کلیدهای نشست TLS (Session Keys) از BoringSSL / OpenSSL
  private hookSslKeyLog(): void {
    const setKeylogPtr = Module.findExportByName(null, 'SSL_CTX_set_keylog_callback');
    const sslNewPtr = Module.findExportByName(null, 'SSL_new');

    if (!setKeylogPtr || !sslNewPtr) return;

    const setKeylog = new NativeFunction(setKeylogPtr, 'void', ['pointer', 'pointer']);
    const keylogCallback = new NativeCallback((_ssl: NativePointer, linePtr: NativePointer) => {
      const keyLine = linePtr.readUtf8String();
      send({ type: 'SSL_SECRET_KEY', keylog: keyLine });
    }, 'void', ['pointer', 'pointer']);

    Interceptor.attach(sslNewPtr, {
      onEnter(args) {
        const sslCtx = args[0];
        setKeylog(sslCtx, keylogCallback);
      }
    });
  }

  // ۳. استخراج کلیدهای متقارن AES/DES در macOS و iOS (CCCrypt)
  private hookAppleCommonCrypto(): void {
    const ccCryptPtr = Module.findExportByName('libcommonCrypto.dylib', 'CCCrypt');
    if (!ccCryptPtr) return;

    Interceptor.attach(ccCryptPtr, {
      onEnter(args) {
        this.operation = args[0].toInt32(); // 0 = kCCEncrypt, 1 = kCCDecrypt
        this.algorithm = args[1].toInt32();
        const keyLength = args[4].toInt32();
        const keyBytes = args[3].readByteArray(keyLength);
        send({
          type: 'SYMMETRIC_KEY_INTERCEPTED',
          operation: this.operation === 0 ? 'ENCRYPT' : 'DECRYPT',
          algorithm: this.algorithm
        }, keyBytes);
      }
    });
  }
}
```

## ۵. دور زدن SSL Pinning، روت و جیلبریک (Universal Evasion Engine)

این ماژول درون‌حافظه‌ای، بررسی‌های امنیتی سیستم‌عامل، پینینگ گواهی در لایه Native و Runtime (جاوا و Objective-C/Swift) و مکانیزم‌های تشخیص دیباگر (ptrace / sysctl) را خنثی می‌کند.

```typescript
// src/agent/modules/EvasionEngine.ts (اجرا در فضای حافظه پروسه هدف)

export class UniversalEvasionEngine {
  public activateAllBypasses(): void {
    this.bypassLowLevelFileChecks();
    this.bypassAntiDebug();
    if (Java.available) this.bypassAndroidSecurity();
    if (ObjC.available) this.bypassAppleSecurity();
  }

  // ۱. مخفی‌سازی فایل‌های روت و جیلبریک در سطح libc (مشترک بین اندروید و iOS)
  private bypassLowLevelFileChecks(): void {
    const blacklistedPaths = [
      '/sbin/su', '/system/bin/su', '/system/xbin/su', 'magisk',
      '/Applications/Cydia.app', '/Library/MobileSubstrate', '/bin/bash', '/usr/sbin/sshd'
    ];

    const faccessatPtr = Module.findExportByName(null, 'faccessat');
    if (faccessatPtr) {
      Interceptor.attach(faccessatPtr, {
        onEnter(args) {
          this.path = args[1].readUtf8String() || '';
        },
        onLeave(retval) {
          if (blacklistedPaths.some(item => this.path.includes(item))) {
            retval.replace(ptr(-1)); // بازگرداندن ENOENT (فایل وجود ندارد)
          }
        }
      });
    }
  }

  // ۲. خنثی‌سازی Anti-Debugging (ptrace در مک/iOS/اندروید)
  private bypassAntiDebug(): void {
    const ptracePtr = Module.findExportByName(null, 'ptrace');
    if (ptracePtr) {
      Interceptor.attach(ptracePtr, {
        onEnter(args) {
          const request = args[0].toInt32();
          // PT_DENY_ATTACH = 31 در XNU (macOS/iOS)
          if (request === 31) {
            args[0] = ptr(0);
          }
        },
        onLeave(retval) {
          retval.replace(ptr(0));
        }
      });
    }
  }

  // ۳. دور زدن SSL Pinning در اندروید (Conscrypt / OkHttp / TrustManager)
  private bypassAndroidSecurity(): void {
    Java.perform(() => {
      const TrustManagerImpl = Java.use('com.android.org.conscrypt.TrustManagerImpl');
      TrustManagerImpl.verifyChain.implementation = function (untrustedChain: unknown) {
        return untrustedChain; // تایید بدون قید و شرط زنجیره گواهی
      };
    });
  }

  // ۴. دور زدن SSL Pinning در iOS و macOS (SecTrustEvaluateWithError و BoringSSL)
  private bypassAppleSecurity(): void {
    const secTrustPtr = Module.findExportByName('Security', 'SecTrustEvaluateWithError');
    if (secTrustPtr) {
      Interceptor.replace(
        secTrustPtr,
        new NativeCallback((_trust: NativePointer, errorPtr: NativePointer) => {
          if (!errorPtr.isNull()) errorPtr.writePointer(NULL);
          return 1; // تایید گواهی (true)
        }, 'bool', ['pointer', 'pointer'])
      );
    }
  }
}
```

## ۶. بازبسته‌بندی خودکار APK و IPA (Automated Binary Repackager)

برای اجرا روی گوشی‌های غیرروت یا غیرجیلبریک، این خط لوله در سمت Node.js فایل .apk یا .ipa را باز کرده، کتابخانه مامور (libfrida-gadget.so یا FridaGadget.dylib) را به هدر باینری (ELF Dynamic Section یا Mach-O LC_LOAD_DYLIB) تزریق می‌کند و بسته را مجدداً امضا (Sign) می‌نماید.

```typescript
// src/repackager/MobileRepackager.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(execFile);

export interface LiefBinaryInjector {
  injectElfNeeded(elfPath: string, libraryName: string): void;
  injectMachoDylib(machoPath: string, dylibInstallName: string): void;
}

export class MobileRepackager {
  constructor(private liefBridge: LiefBinaryInjector) {}

  // بازبسته‌بندی APK اندروید
  public async repackageApk(
    apkPath: string,
    gadgetSoPath: string,
    targetNativeLib: string,
    keystorePath: string,
    keystorePass: string
  ): Promise<string> {
    const workDir = path.join('/tmp', `apk_work_${Date.now()}`);

    // ۱. دیکامپایل منابع و DEX بدون دست زدن به کدهای بومی
    await execAsync('apktool', ['d', apkPath, '-o', workDir]);

    // ۲. کپی کردن گجت به پوشه معماری هدف و تزریق وابستگی در جدول ELF DT_NEEDED
    const libDir = path.join(workDir, 'lib', 'arm64-v8a');
    await fs.copyFile(gadgetSoPath, path.join(libDir, 'librea_gadget.so'));
    this.liefBridge.injectElfNeeded(path.join(libDir, targetNativeLib), 'librea_gadget.so');

    // ۳. بیلد مجدد، تراز کردن بایت‌ها (Zipalign) و امضای نسخه v2/v3
    const unsignedApk = path.join('/tmp', 'unsigned.apk');
    const signedApk = path.join('/tmp', 'repackaged_signed.apk');

    await execAsync('apktool', ['b', workDir, '-o', unsignedApk, '--use-aapt2']);
    await execAsync('zipalign', ['-p', '-f', '4', unsignedApk, signedApk]);
    await execAsync('apksigner', [
      'sign', '--ks', keystorePath, '--ks-pass', `pass:${keystorePass}`, signedApk
    ]);

    return signedApk;
  }

  // بازبسته‌بندی IPA آی‌اواس
  public async repackageIpa(
    ipaPath: string,
    gadgetDylibPath: string,
    mobileProvisionPath: string,
    signingIdentity: string
  ): Promise<string> {
    const workDir = path.join('/tmp', `ipa_work_${Date.now()}`);
    await execAsync('unzip', ['-q', ipaPath, '-d', workDir]);

    const payloadDir = path.join(workDir, 'Payload');
    const apps = await fs.readdir(payloadDir);
    const appBundle = path.join(payloadDir, apps[0]);
    const mainExecutable = path.join(appBundle, path.basename(apps[0], '.app'));

    // ۱. کپی کردن Dylib به داخل باندل و تزریق دستور LC_LOAD_DYLIB در هدر Mach-O
    const frameworksDir = path.join(appBundle, 'Frameworks');
    await fs.mkdir(frameworksDir, { recursive: true });
    await fs.copyFile(gadgetDylibPath, path.join(frameworksDir, 'REAGadget.dylib'));

    this.liefBridge.injectMachoDylib(mainExecutable, '@executable_path/Frameworks/REAGadget.dylib');

    // ۲. جایگزینی پروفایل Provisioning و امضای مجدد با حفظ Entitlementها
    await fs.copyFile(mobileProvisionPath, path.join(appBundle, 'embedded.mobileprovision'));
    await execAsync('codesign', ['-f', '-s', signingIdentity, path.join(frameworksDir, 'REAGadget.dylib')]);
    await execAsync('codesign', ['-f', '-s', signingIdentity, appBundle]);

    const outputIpa = path.join('/tmp', 'repackaged.ipa');
    await execAsync('zip', ['-qr', outputIpa, 'Payload'], { cwd: workDir });

    return outputIpa;
  }
}
```

## ۷. بازسازی «اتم‌به‌اتم» و تبدیل باینری به پروژه قابل کامپایل (Atom-by-Atom Synthesizer)

برای تبدیل یک باینری کامپایل‌شده (PE، Mach-O یا ELF) به یک پروژه کاملاً تمیز و قابل کامپایل، صرفاً استفاده از یک دیکامپایلر کافی نیست (زیرا خروجی دیکامپایلرها شبه‌کدِ غیرقابل کامپایل است). معماری زیر یک حلقه تایید کامپایلر و شبیه‌ساز (Compiler & Emulator Verification Loop) پیاده‌سازی می‌کند:

- استخراج گراف فراخوانی توپولوژیک (Topological Call Graph): توابع از برگ‌های گراف (توابعی که تابع دیگری را صدا نمی‌زنند) به سمت ریشه (main) مرتب می‌شوند.
- ادغام تحلیل استاتیک و پویا: کد میانی (LLVM IR / Ghidra P-Code) به همراه ردپای اجرای واقعی (Dynamic Execution Traces که توسط ماژول‌های بخش ۳ و ۴ جمع‌آوری شده) ترکیب می‌شوند.
- بازنویسی و کامپایل آزمایشی: کد مقصد (Rust یا C++/TypeScript) تولید شده، توسط کامپایلر واقعی کامپایل می‌شود، و در صورت بروز خطای کامپایل، خطا به موتور سنتز برگردانده می‌شود تا اصلاح شود.
- اثبات هم‌ارزی معنایی (Semantic Equivalence Check): تابع اصلیِ باینری و تابع جدیدِ کامپایل‌شده هر دو درون موتور شبیه‌ساز (Unicorn/Qiling) با ورودی‌های یکسان اجرا می‌شوند تا یکسان بودن خروجی در رجیسترها و حافظه اثبات گردد.

```typescript
// src/synthesizer/AtomByAtomSynthesizer.ts

export interface BinaryFunctionAtom {
  address: bigint;
  name: string;
  size: number;
  rawBytes: Buffer;
  pcodeIr: string;            // کد میانی استخراج‌شده از Ghidra/Radare2
  decompiledPseudoC: string;  // شبه‌کد اولیه
  callees: bigint[];          // توابع فراخوانی‌شده توسط این تابع
  dynamicTraces: Array<{ inputs: Record<string, bigint>; outputs: Record<string, bigint> }>;
}

export interface StaticLifterEngine {
  extractDependencyGraph(binaryPath: string): Promise<BinaryFunctionAtom[]>;
  extractDataStructuresAndTypes(binaryPath: string): Promise<string>;
}

export interface BinaryEquivalenceTester {
  verifyFunctionEquivalence(
    originalBytes: Buffer,
    compiledObjectPath: string,
    symbolName: string,
    testVectors: BinaryFunctionAtom['dynamicTraces']
  ): Promise<{ equivalent: boolean; mismatchDetail?: string }>;
}

export interface CodeSynthesisModel {
  synthesizeFunction(prompt: {
    atom: BinaryFunctionAtom;
    resolvedDependenciesCode: string[];
    globalTypesHeader: string;
    lastCompilerError?: string;
    lastEquivalenceMismatch?: string;
  }): Promise<string>;
}

export class AtomByAtomSynthesizer {
  constructor(
    private lifter: StaticLifterEngine,
    private equivalenceTester: BinaryEquivalenceTester,
    private aiSynthesizer: CodeSynthesisModel,
    private compilerRunner: (sourceCode: string) => Promise<{ success: boolean; objPath?: string; stderr?: string }>
  ) {}

  public async reconstructFullProject(binaryPath: string): Promise<Map<string, string>> {
    // ۱. استخراج تمام ساختارهای داده، جدول ایمپورت‌ها و گراف توابع
    const globalTypesHeader = await this.lifter.extractDataStructuresAndTypes(binaryPath);
    const allAtoms = await this.lifter.extractDependencyGraph(binaryPath);

    // ۲. مرتب‌سازی توپولوژیک (از پایین‌ترین سطح وابستگی به سمت تابع main)
    const sortedAtoms = this.topologicalSort(allAtoms);
    const verifiedSourceMap = new Map<bigint, string>();
    const projectFiles = new Map<string, string>();

    projectFiles.set('src/types.rs', globalTypesHeader);

    // ۳. بازسازی اتم‌به‌اتم هر تابع با حلقه تایید کامپایلر و شبیه‌ساز
    for (const atom of sortedAtoms) {
      const depsCode = atom.callees
        .map(addr => verifiedSourceMap.get(addr))
        .filter((code): code is string => Boolean(code));

      let lastCompilerError: string | undefined;
      let lastEquivalenceMismatch: string | undefined;
      let verifiedCode = '';

      for (let attempt = 1; attempt <= 5; attempt++) {
        const candidateCode = await this.aiSynthesizer.synthesizeFunction({
          atom,
          resolvedDependenciesCode: depsCode,
          globalTypesHeader,
          lastCompilerError,
          lastEquivalenceMismatch
        });

        // الف) تست کامپایل واقعی
        const compileResult = await this.compilerRunner(candidateCode);
        if (!compileResult.success || !compileResult.objPath) {
          lastCompilerError = compileResult.stderr;
          continue;
        }

        // ب) تست هم‌ارزی باینری در شبیه‌ساز (مقایسه رجیسترهای خروجی با باینری اصلی)
        const eqResult = await this.equivalenceTester.verifyFunctionEquivalence(
          atom.rawBytes,
          compileResult.objPath,
          atom.name,
          atom.dynamicTraces
        );

        if (!eqResult.equivalent) {
          lastEquivalenceMismatch = eqResult.mismatchDetail;
          continue;
        }

        verifiedCode = candidateCode;
        break;
      }

      if (!verifiedCode) {
        throw new Error(`عدم موفقیت در بازسازی قطعی اتم در آدرس 0x${atom.address.toString(16)}`);
      }

      verifiedSourceMap.set(atom.address, verifiedCode);
      projectFiles.set(`src/modules/${atom.name}.rs`, verifiedCode);
    }

    return projectFiles;
  }

  private topologicalSort(atoms: BinaryFunctionAtom[]): BinaryFunctionAtom[] {
    const visited = new Set<bigint>();
    const result: BinaryFunctionAtom[] = [];
    const atomMap = new Map(atoms.map(a => [a.address, a]));

    const visit = (atom: BinaryFunctionAtom) => {
      if (visited.has(atom.address)) return;
      visited.add(atom.address);
      for (const calleeAddr of atom.callees) {
        const callee = atomMap.get(calleeAddr);
        if (callee) visit(callee);
      }
      result.push(atom);
    };

    for (const atom of atoms) visit(atom);
    return result;
  }
}
```
