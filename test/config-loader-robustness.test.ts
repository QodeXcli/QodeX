import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config/loader.js';

/**
 * Regression for the "malformed YAML replaces the whole config" bug: a project
 * .qodex/config.yaml that is valid YAML but collapses to a scalar or top-level
 * array used to be handed to deepMerge, which replaced the entire QodexConfig
 * object with that scalar/array. loadConfig must instead ignore a non-mapping
 * config file and still return a well-formed config object.
 */
describe('loadConfig — malformed project config robustness', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {});
  });

  async function projectWith(configYaml: string | null): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-cfg-'));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, '.qodex'), { recursive: true });
    if (configYaml !== null) {
      await fs.writeFile(path.join(dir, '.qodex', 'config.yaml'), configYaml);
    }
    return dir;
  }

  function expectWellFormed(cfg: unknown) {
    expect(cfg).not.toBeNull();
    expect(typeof cfg).toBe('object');
    expect(Array.isArray(cfg)).toBe(false);
  }

  it('a bare-scalar-string config does NOT replace the config object', async () => {
    const cfg = await loadConfig(await projectWith('just a bare string'));
    expectWellFormed(cfg);
    expect(cfg as any).not.toBe('just a bare string');
  });

  it('a bare-number config is ignored, not adopted', async () => {
    const cfg = await loadConfig(await projectWith('42'));
    expectWellFormed(cfg);
  });

  it('a top-level array config is ignored, not adopted', async () => {
    const cfg = await loadConfig(await projectWith('- a\n- b\n- c'));
    expectWellFormed(cfg);
    expect(Array.isArray(cfg)).toBe(false);
  });

  it('a syntactically broken YAML is ignored without throwing', async () => {
    const cfg = await loadConfig(await projectWith(':\n  - [unbalanced\n\tmixed tabs'));
    expectWellFormed(cfg);
  });

  it('an empty / null YAML file is fine (falls back to defaults)', async () => {
    expectWellFormed(await loadConfig(await projectWith('')));
    expectWellFormed(await loadConfig(await projectWith('null')));
  });

  it('a valid mapping config still merges (keys land on the object)', async () => {
    const cfg: any = await loadConfig(await projectWith('subagents:\n  mode: parallel\n  maxConcurrent: 5'));
    expectWellFormed(cfg);
    expect(cfg.subagents?.mode).toBe('parallel');
    expect(cfg.subagents?.maxConcurrent).toBe(5);
  });

  it('no config file at all returns a well-formed default config', async () => {
    expectWellFormed(await loadConfig(await projectWith(null)));
  });
});
