/**
 * `rea_repackage` — rebuild an APK or IPA with the Frida Gadget injected,
 * for running on a phone without root / jailbreak.
 *
 * The input package is never modified; the output is a new file. Only run
 * against a package the user owns or has explicit permission to modify.
 * The keystore password is taken from the REA_KEYSTORE_PASS environment
 * variable, never from the arguments.
 */
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { MobileRepackager } from '../../rea/repackager.js';

const Args = z.object({
  kind: z.enum(['apk', 'ipa']).describe('Package type.'),
  packagePath: z.string().min(1).describe('Input .apk or .ipa.'),
  gadgetPath: z.string().min(1).describe('Frida Gadget library (.so for APK, .dylib for IPA).'),
  targetLib: z
    .string()
    .min(1)
    .optional()
    .describe('APK only: native library inside the APK to add the gadget to (e.g. "libmain.so").'),
  keystorePath: z.string().min(1).optional().describe('APK only: signing keystore.'),
  abi: z.string().optional().describe('APK only: target ABI.'),
  mobileProvisionPath: z.string().min(1).optional().describe('IPA only: replacement .mobileprovision.'),
  signingIdentity: z.string().min(1).optional().describe('IPA only: codesign identity.'),
});

export class ReaRepackageTool extends Tool<z.infer<typeof Args>> {
  name = 'rea_repackage';
  description =
    'Repackage an APK or IPA with the Frida Gadget injected into its main binary, for a phone without root / jailbreak. ' +
    'The input package is never modified; the output is a new file. ' +
    'Only for packages the user owns or has explicit permission to modify. ' +
    'APK signing needs REA_KEYSTORE_PASS in the environment (never in the arguments).';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const repackager = new MobileRepackager();
      if (args.kind === 'apk') {
        if (!args.targetLib || !args.keystorePath) {
          return {
            content: 'rea_repackage (apk) needs targetLib and keystorePath.',
            isError: true,
          };
        }
        const keystorePass = process.env.REA_KEYSTORE_PASS;
        if (!keystorePass) {
          return {
            content: 'REA_KEYSTORE_PASS is not set. The keystore password is never taken in the arguments.',
            isError: true,
          };
        }
        const out = await repackager.repackageApk(
          args.packagePath,
          args.gadgetPath,
          args.targetLib,
          args.keystorePath,
          keystorePass,
          args.abi ?? 'arm64-v8a',
        );
        return { content: `Repackaged APK written to ${out}` };
      }
      if (!args.mobileProvisionPath || !args.signingIdentity) {
        return {
          content: 'rea_repackage (ipa) needs mobileProvisionPath and signingIdentity.',
          isError: true,
        };
      }
      const out = await repackager.repackageIpa(
        args.packagePath,
        args.gadgetPath,
        args.mobileProvisionPath,
        args.signingIdentity,
      );
      return { content: `Repackaged IPA written to ${out}` };
    } catch (e: any) {
      return { content: `rea_repackage failed: ${e?.message ?? e}`, isError: true };
    }
  }
}
