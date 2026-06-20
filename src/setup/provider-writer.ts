/**
 * Provider config writer — adds a custom (OpenAI-compatible) provider to ~/.qodex/config.yaml
 * WITHOUT clobbering anything else in the file.
 *
 * This is the counterpart to the MCP config-writer: it reads the raw user YAML, merges in one
 * providers.custom[] entry (replacing a same-named one in place), and writes it back. It exists
 * because the natural-but-wrong way to add a provider — `cat > config.yaml` — overwrites the
 * whole file and silently drops every other provider the user had configured.
 */
import * as fs from 'fs/promises';
import * as yaml from 'js-yaml';
import { QODEX_CONFIG_FILE } from '../config/defaults.js';
import { mergeCustomProvider, type CustomProviderEntry } from './gateways.js';

export interface AddProviderResult {
  configPath: string;
  /** The merged provider name. */
  name: string;
  /** Whether defaults.{provider,model} were updated. */
  setDefault: boolean;
}

/**
 * Read the current config (empty object if none), merge in the provider entry, write back.
 * Pure I/O around the pure mergeCustomProvider — so the merge logic stays unit-tested without
 * touching disk.
 */
export async function addProviderToConfig(
  entry: CustomProviderEntry,
  opts?: { setDefault?: boolean; defaultModel?: string },
): Promise<AddProviderResult> {
  let raw = '';
  try {
    raw = await fs.readFile(QODEX_CONFIG_FILE, 'utf-8');
  } catch (e: any) {
    // Only a missing file means "no config yet — start fresh". Any other read
    // error (permission denied, IO failure) must NOT be swallowed: doing so
    // would merge into an empty object and overwrite the file, dropping every
    // previously-configured provider. Surface it before the merge-and-write.
    if (e?.code !== 'ENOENT') {
      throw new Error(
        `Could not read ${QODEX_CONFIG_FILE} (${e?.message ?? e}). ` +
        `Refusing to overwrite it to avoid dropping existing providers. Fix the file/permissions, then retry.`,
      );
    }
    raw = ''; // no config yet — start fresh
  }

  let parsed: any = {};
  if (raw.trim()) {
    try {
      parsed = yaml.load(raw) ?? {};
    } catch (e: any) {
      throw new Error(`Could not parse ${QODEX_CONFIG_FILE}: ${e?.message ?? e}. Fix the YAML or move it aside, then retry.`);
    }
  }

  const merged = mergeCustomProvider(parsed, entry, opts);
  const out = yaml.dump(merged, { lineWidth: 100, noRefs: true });

  // Ensure the directory exists (first-run case).
  const dir = QODEX_CONFIG_FILE.slice(0, QODEX_CONFIG_FILE.lastIndexOf('/'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(QODEX_CONFIG_FILE, out, 'utf-8');

  return { configPath: QODEX_CONFIG_FILE, name: entry.name, setDefault: !!opts?.setDefault };
}
