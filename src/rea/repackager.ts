/**
 * Automated APK / IPA repackager — the host-side half of REA for
 * non-rooted / non-jailbroken phones.
 *
 * Opens an .apk or .ipa, injects the Frida Gadget library into the main
 * binary (ELF DT_NEEDED / Mach-O LC_LOAD_DYLIB), rebuilds, aligns, and
 * re-signs the package.
 *
 * Binary editing goes through LIEF (Python `lief` package) via a small
 * embedded script, because there is no maintained Node.js LIEF binding.
 * Every external tool (apktool, zipalign, apksigner, unzip, zip, codesign,
 * python3 + lief) is checked up front; a missing tool is a clear error
 * naming the tool, never a silent skip.
 *
 * The keystore password is passed to apksigner through an environment
 * variable (`env:REA_APKSIGNER_PASS`), never on the command line, so it
 * does not show up in `ps`.
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface LiefBinaryInjector {
  injectElfNeeded(elfPath: string, libraryName: string): Promise<void>;
  injectMachoDylib(machoPath: string, dylibInstallName: string): Promise<void>;
}

/**
 * LIEF via an embedded Python script. `lief` must be installed
 * (`pip install lief`); without it every call throws a clear error.
 */
export class LiefPythonBridge implements LiefBinaryInjector {
  constructor(private pythonBinary = 'python3') {}

  public async injectElfNeeded(elfPath: string, libraryName: string): Promise<void> {
    await this.runLiefScript('elf', elfPath, libraryName);
  }

  public async injectMachoDylib(machoPath: string, dylibInstallName: string): Promise<void> {
    await this.runLiefScript('macho', machoPath, dylibInstallName);
  }

  private async runLiefScript(kind: 'elf' | 'macho', binaryPath: string, library: string): Promise<void> {
    const script = [
      'import sys, lief',
      'kind, binary_path, library = sys.argv[1], sys.argv[2], sys.argv[3]',
      'binary = lief.parse(binary_path)',
      'if binary is None:',
      '    raise SystemExit(f"lief could not parse {binary_path}")',
      'binary.add_library(library)',
      'binary.write(binary_path)',
    ].join('\n');
    try {
      await execFileAsync(this.pythonBinary, ['-c', script, kind, binaryPath, library], {
        timeout: 120_000,
      });
    } catch (e: any) {
      const stderr = String(e?.stderr ?? e?.message ?? e);
      if (/No module named .*lief/i.test(stderr)) {
        throw new Error(
          'LIEF is not installed for python3 (pip install lief). Binary injection cannot run without it.',
        );
      }
      throw new Error(`LIEF injection failed for ${binaryPath}: ${stderr.trim()}`);
    }
  }
}

/** Throw a clear error naming the tool when it is not on PATH. Pure Node.js — no shell, so it works the same under vitest, npm scripts, and the CLI. */
export async function requireTool(name: string): Promise<void> {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  const candidates =
    process.platform === 'win32'
      ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
      : [name];
  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      try {
        await fs.access(path.join(dir, candidate), fs.constants.X_OK);
        return; // Found an executable with this name.
      } catch {
        // Try the next candidate.
      }
    }
  }
  throw new Error(`Required tool not found on PATH: ${name}`);
}

export class MobileRepackager {
  constructor(private liefBridge: LiefBinaryInjector = new LiefPythonBridge()) {}

  /** Repackage an APK with the Frida Gadget injected into a native library. */
  public async repackageApk(
    apkPath: string,
    gadgetSoPath: string,
    targetNativeLib: string,
    keystorePath: string,
    keystorePass: string,
    abi = 'arm64-v8a',
  ): Promise<string> {
    await requireTool('apktool');
    await requireTool('zipalign');
    await requireTool('apksigner');

    const workDir = path.join('/tmp', `rea_apk_${Date.now()}`);
    const unsignedApk = path.join('/tmp', `rea_unsigned_${Date.now()}.apk`);
    const signedApk = path.join('/tmp', `rea_repackaged_${Date.now()}.apk`);

    // 1. Decode resources + DEX without touching native code.
    await execFileAsync('apktool', ['d', apkPath, '-o', workDir], { timeout: 300_000 });

    // 2. Drop the gadget into the target ABI dir and add it as DT_NEEDED.
    const libDir = path.join(workDir, 'lib', abi);
    await fs.mkdir(libDir, { recursive: true });
    await fs.copyFile(gadgetSoPath, path.join(libDir, 'librea_gadget.so'));
    await this.liefBridge.injectElfNeeded(
      path.join(libDir, targetNativeLib),
      'librea_gadget.so',
    );

    // 3. Rebuild, align, and sign (v2/v3).
    await execFileAsync('apktool', ['b', workDir, '-o', unsignedApk, '--use-aapt2'], {
      timeout: 300_000,
    });
    await execFileAsync('zipalign', ['-p', '-f', '4', unsignedApk, signedApk], {
      timeout: 120_000,
    });
    await execFileAsync(
      'apksigner',
      ['sign', '--ks', keystorePath, '--ks-pass', 'env:REA_APKSIGNER_PASS', signedApk],
      {
        timeout: 120_000,
        env: { ...process.env, REA_APKSIGNER_PASS: keystorePass },
      },
    );

    return signedApk;
  }

  /** Repackage an IPA with the Frida Gadget injected into the main executable. */
  public async repackageIpa(
    ipaPath: string,
    gadgetDylibPath: string,
    mobileProvisionPath: string,
    signingIdentity: string,
  ): Promise<string> {
    await requireTool('unzip');
    await requireTool('zip');
    await requireTool('codesign');

    const workDir = path.join('/tmp', `rea_ipa_${Date.now()}`);
    await execFileAsync('unzip', ['-q', ipaPath, '-d', workDir], { timeout: 120_000 });

    const payloadDir = path.join(workDir, 'Payload');
    const apps = await fs.readdir(payloadDir);
    if (apps.length === 0) {
      throw new Error(`No .app bundle found inside ${ipaPath}`);
    }
    const appBundle = path.join(payloadDir, apps[0]!);
    const mainExecutable = path.join(appBundle, path.basename(apps[0]!, '.app'));

    // 1. Copy the gadget into Frameworks/ and add LC_LOAD_DYLIB.
    const frameworksDir = path.join(appBundle, 'Frameworks');
    await fs.mkdir(frameworksDir, { recursive: true });
    await fs.copyFile(gadgetDylibPath, path.join(frameworksDir, 'REAGadget.dylib'));
    await this.liefBridge.injectMachoDylib(
      mainExecutable,
      '@executable_path/Frameworks/REAGadget.dylib',
    );

    // 2. Replace the provisioning profile and re-sign, keeping entitlements.
    await fs.copyFile(mobileProvisionPath, path.join(appBundle, 'embedded.mobileprovision'));
    await execFileAsync('codesign', ['-f', '-s', signingIdentity, path.join(frameworksDir, 'REAGadget.dylib')], {
      timeout: 120_000,
    });
    await execFileAsync('codesign', ['-f', '-s', signingIdentity, appBundle], {
      timeout: 120_000,
    });

    const outputIpa = path.join('/tmp', `rea_repackaged_${Date.now()}.ipa`);
    await execFileAsync('zip', ['-qr', outputIpa, 'Payload'], {
      cwd: workDir,
      timeout: 120_000,
    });

    return outputIpa;
  }
}
