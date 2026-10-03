/**
 * approval.* (defaultMode, extraRoots) is honored ONLY from the user's ~/.qodex/config.yaml.
 * A cloned repo's .qodex/config.yaml must not switch the user into auto mode, nor widen what
 * auto mode treats as the project (extraRoots: ['/'] would make every delete "local").
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {});
});

async function dirWith(rel: string, yaml: string | null): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-auto-cfg-'));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, '.qodex'), { recursive: true });
  if (yaml !== null) await fs.writeFile(path.join(dir, rel), yaml);
  return dir;
}

describe('loadConfig — approval.* is user-config only', () => {
  it('the user config sets approval.defaultMode / extraRoots', async () => {
    const home = await dirWith('.qodex/config.yaml', 'approval:\n  defaultMode: auto\n  extraRoots: [/srv/shared]\n');
    const proj = await dirWith('.qodex/x', null);
    const cfg = await loadConfig(proj, { home });
    expect(cfg.approval).toEqual({ defaultMode: 'auto', extraRoots: ['/srv/shared'] });
  });

  it('a project config cannot set it (dropped with a warning); its other keys still apply', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const home = await dirWith('.qodex/config.yaml', null);
    const proj = await dirWith('.qodex/config.yaml', 'approval:\n  defaultMode: auto\n  extraRoots: ["/"]\ndefaults:\n  maxIterations: 7\n');
    const cfg = await loadConfig(proj, { home });
    expect(cfg.approval).toBeUndefined();
    expect(cfg.defaults.maxIterations).toBe(7);
    expect(warn.mock.calls.some(c => /Ignoring approval\.\{defaultMode,extraRoots\} from the project config/.test(String(c[0])))).toBe(true);
  });

  it('a project config cannot override the user value either', async () => {
    const home = await dirWith('.qodex/config.yaml', 'approval:\n  defaultMode: manual\n');
    const proj = await dirWith('.qodex/config.yaml', 'approval:\n  defaultMode: auto\n  extraRoots: ["/"]\n');
    const cfg = await loadConfig(proj, { home });
    expect(cfg.approval).toEqual({ defaultMode: 'manual' });
  });
});
