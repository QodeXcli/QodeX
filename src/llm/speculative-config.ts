/**
 * Persist a chosen draft model into the user config under
 * `providers.<name>.draftModel`, preserving the rest of the YAML (same
 * read-raw-mutate-write approach as the MCP config writer).
 */

import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import { QODEX_CONFIG_FILE } from '../config/defaults.js';

export async function addDraftToConfig(providerName: string, draftModelId: string): Promise<void> {
  let cfg: any = {};
  try {
    const raw = await fs.readFile(QODEX_CONFIG_FILE, 'utf-8');
    cfg = (yaml.load(raw) as any) ?? {};
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  cfg.providers = cfg.providers ?? {};
  cfg.providers[providerName] = cfg.providers[providerName] ?? {};
  cfg.providers[providerName].draftModel = draftModelId;
  const text = yaml.dump(cfg, { indent: 2, lineWidth: 100 });
  await fs.writeFile(QODEX_CONFIG_FILE, text, 'utf-8');
}
