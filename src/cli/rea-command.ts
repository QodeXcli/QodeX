/**
 * `qodex rea` — the REA command group: live injection, agent bundling,
 * and APK / IPA repackaging.
 *
 * These commands instrument a process or rebuild a package. They only run
 * against targets the user owns or has explicit permission to test.
 * `qodex re` (static read) stays separate and read-only.
 */
import { Command } from 'commander';
import type { DeviceKind } from '../rea/injector.js';

function parseTarget(raw: string): string | number {
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

export function buildReaCommand(): Command {
  const cmd = new Command('rea');
  cmd.description('REA — live reverse engineering: inject a Frida agent, build agent bundles, repackage APK/IPA.');

  cmd
    .command('inject')
    .description('Inject a compiled agent bundle into a process and stream its telemetry until Ctrl+C.')
    .requiredOption('--target <name|pid>', 'Process name or pid')
    .requiredOption('--agent <bundle.js>', 'Compiled agent bundle (frida-compile output)')
    .option('--spawn', 'Spawn the program suspended, instrument, then resume')
    .option('--device <local|usb|remote>', 'Frida device', 'local')
    .action(async (opts: { target: string; agent: string; spawn?: boolean; device: DeviceKind }) => {
      const { ProcessInjector } = await import('../rea/injector.js');
      const injector = new ProcessInjector();
      const exports = await injector.inject({
        deviceType: opts.device,
        targetProcess: parseTarget(opts.target),
        spawnMode: opts.spawn ?? false,
        agentBundlePath: opts.agent,
        onTelemetry: (payload, data) => {
          console.log('[rea]', JSON.stringify(payload), data ? `(data ${data.byteLength} bytes)` : '');
        },
      });
      console.log(`[rea] injected into ${opts.target}; agent exports: ${Object.keys(exports).join(', ') || '(none)'}`);
      console.log('[rea] streaming telemetry — Ctrl+C to detach.');
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
      });
      await injector.detach();
      console.log('[rea] detached.');
    });

  cmd
    .command('build-agent')
    .description('Compile a TypeScript agent entry into a bundle the injector can load.')
    .requiredOption('--entry <file.ts>', 'Agent entry (e.g. src/rea/agent/index.ts)')
    .requiredOption('--out <bundle.js>', 'Output bundle path')
    .action(async (opts: { entry: string; out: string }) => {
      const { buildAgentBundle } = await import('../rea/injector.js');
      const out = await buildAgentBundle({ entry: opts.entry, out: opts.out });
      console.log(`[rea] agent bundle written to ${out}`);
    });

  cmd
    .command('repackage-apk')
    .description('Repackage an APK with the Frida Gadget injected into a native library.')
    .requiredOption('--apk <path>', 'Input .apk')
    .requiredOption('--gadget <lib.so>', 'Frida Gadget .so for the target ABI')
    .requiredOption('--lib <name.so>', 'Native library inside the APK to add the gadget to')
    .requiredOption('--keystore <path>', 'Signing keystore')
    .option('--abi <abi>', 'Target ABI', 'arm64-v8a')
    .action(async (opts: { apk: string; gadget: string; lib: string; keystore: string; abi: string }) => {
      const keystorePass = process.env.REA_KEYSTORE_PASS;
      if (!keystorePass) {
        console.error('[rea] REA_KEYSTORE_PASS is not set (the keystore password is never taken on the command line).');
        process.exitCode = 2;
        return;
      }
      const { MobileRepackager } = await import('../rea/repackager.js');
      const out = await new MobileRepackager().repackageApk(
        opts.apk,
        opts.gadget,
        opts.lib,
        opts.keystore,
        keystorePass,
        opts.abi,
      );
      console.log(`[rea] repackaged APK written to ${out}`);
    });

  cmd
    .command('repackage-ipa')
    .description('Repackage an IPA with the Frida Gadget injected into the main executable.')
    .requiredOption('--ipa <path>', 'Input .ipa')
    .requiredOption('--gadget <dylib>', 'Frida Gadget .dylib')
    .requiredOption('--provision <path>', 'Replacement .mobileprovision')
    .requiredOption('--identity <name>', 'codesign identity')
    .action(async (opts: { ipa: string; gadget: string; provision: string; identity: string }) => {
      const { MobileRepackager } = await import('../rea/repackager.js');
      const out = await new MobileRepackager().repackageIpa(
        opts.ipa,
        opts.gadget,
        opts.provision,
        opts.identity,
      );
      console.log(`[rea] repackaged IPA written to ${out}`);
    });

  return cmd;
}
