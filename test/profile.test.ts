import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertProfileName,
  InvalidProfileNameError,
  UnknownProfileError,
  resolveProfileName,
  loadProfileOverlay,
  listProfiles,
  resetProfileState,
} from '../src/config/profile.js';
import { loadConfig } from '../src/config/loader.js';

afterEach(() => { resetProfileState(); });

describe('assertProfileName', () => {
  it('accepts a simple token', () => {
    expect(assertProfileName('studio')).toBe('studio');
    expect(assertProfileName('Cloud-2')).toBe('Cloud-2');
  });
  it('rejects path traversal and junk', () => {
    expect(() => assertProfileName('../etc')).toThrow(InvalidProfileNameError);
    expect(() => assertProfileName('a/b')).toThrow(InvalidProfileNameError);
    expect(() => assertProfileName('')).toThrow(InvalidProfileNameError);
    expect(() => assertProfileName('1bad')).toThrow(InvalidProfileNameError);
  });
});

describe('resolveProfileName', () => {
  it('flag beats env beats sticky beats configured', () => {
    expect(resolveProfileName({
      flag: 'cli',
      env: 'env',
      sticky: 'sticky',
      configured: 'yaml',
    })).toBe('cli');
    expect(resolveProfileName({ env: 'env', sticky: 'sticky', configured: 'yaml' })).toBe('env');
    expect(resolveProfileName({ sticky: 'sticky', configured: 'yaml' })).toBe('sticky');
    expect(resolveProfileName({ configured: 'yaml' })).toBe('yaml');
    expect(resolveProfileName({})).toBeUndefined();
  });
});

describe('loadConfig — profile overlay is last word', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {});
  });

  async function homeWith(opts: {
    user?: string;
    profile?: { name: string; yaml: string };
    project?: string;
  }): Promise<{ home: string; cwd: string }> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-prof-'));
    dirs.push(home);
    await fs.mkdir(path.join(home, '.qodex', 'profiles'), { recursive: true });
    if (opts.user) await fs.writeFile(path.join(home, '.qodex', 'config.yaml'), opts.user);
    if (opts.profile) {
      await fs.writeFile(path.join(home, '.qodex', 'profiles', `${opts.profile.name}.yaml`), opts.profile.yaml);
    }
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-proj-'));
    dirs.push(cwd);
    if (opts.project) {
      await fs.mkdir(path.join(cwd, '.qodex'), { recursive: true });
      await fs.writeFile(path.join(cwd, '.qodex', 'config.yaml'), opts.project);
    }
    return { home, cwd };
  }

  it('file profile overrides user + project defaults.model', async () => {
    const { home, cwd } = await homeWith({
      user: 'defaults:\n  model: user-model\n  provider: ollama\n',
      project: 'defaults:\n  model: project-model\n',
      profile: { name: 'cloud', yaml: 'defaults:\n  model: claude-sonnet-4-6\n  provider: anthropic\n' },
    });
    const cfg = await loadConfig(cwd, { home, profile: 'cloud' });
    expect(cfg.defaults.model).toBe('claude-sonnet-4-6');
    expect(cfg.defaults.provider).toBe('anthropic');
  });

  it('keeps project keys the profile does not set', async () => {
    const { home, cwd } = await homeWith({
      project: 'subagents:\n  mode: parallel\n  maxConcurrent: 4\n',
      profile: { name: 'studio', yaml: 'defaults:\n  model: qwen3-coder\n' },
    });
    const cfg = await loadConfig(cwd, { home, profile: 'studio' });
    expect(cfg.defaults.model).toBe('qwen3-coder');
    expect((cfg as any).subagents?.mode).toBe('parallel');
    expect((cfg as any).subagents?.maxConcurrent).toBe(4);
  });

  it('inline profiles.<name> works when no file exists', async () => {
    const { home, cwd } = await homeWith({
      user: 'defaults:\n  model: base\nprofiles:\n  cloud:\n    defaults:\n      model: from-inline\n',
    });
    const cfg = await loadConfig(cwd, { home, profile: 'cloud' });
    expect(cfg.defaults.model).toBe('from-inline');
  });

  it('file beats an inline block of the same name', async () => {
    const { home, cwd } = await homeWith({
      user: 'profiles:\n  studio:\n    defaults:\n      model: inline\n',
      profile: { name: 'studio', yaml: 'defaults:\n  model: from-file\n' },
    });
    const hit = await loadProfileOverlay('studio', {
      profileDir: path.join(home, '.qodex', 'profiles'),
      userConfigPath: path.join(home, '.qodex', 'config.yaml'),
    });
    expect(hit.source).toBe('file');
    expect(hit.overlay.defaults?.model).toBe('from-file');
    const cfg = await loadConfig(cwd, { home, profile: 'studio' });
    expect(cfg.defaults.model).toBe('from-file');
  });

  it('unknown profile is a hard error', async () => {
    const { home, cwd } = await homeWith({});
    await expect(loadConfig(cwd, { home, profile: 'nope' })).rejects.toBeInstanceOf(UnknownProfileError);
  });

  it('a profile file that is not a mapping is a hard error', async () => {
    const { home, cwd } = await homeWith({
      profile: { name: 'studio', yaml: 'just a string\n' },
    });
    await expect(loadConfig(cwd, { home, profile: 'studio' })).rejects.toThrow(/not a YAML mapping/);
  });

  it('defaults.profile in user yaml selects the overlay without a flag', async () => {
    const { home, cwd } = await homeWith({
      user: 'defaults:\n  profile: studio\n  model: base\n',
      profile: { name: 'studio', yaml: 'defaults:\n  model: from-default\n' },
    });
    const cfg = await loadConfig(cwd, { home });
    expect(cfg.defaults.model).toBe('from-default');
  });

  it('listProfiles sees files and leftover inline names', async () => {
    const { home } = await homeWith({
      user: 'profiles:\n  cloud:\n    defaults:\n      model: x\n',
      profile: { name: 'studio', yaml: 'defaults:\n  model: y\n' },
    });
    const rows = await listProfiles({
      profileDir: path.join(home, '.qodex', 'profiles'),
      userConfigPath: path.join(home, '.qodex', 'config.yaml'),
    });
    expect(rows.map(r => r.name).sort()).toEqual(['cloud', 'studio']);
    expect(rows.find(r => r.name === 'studio')?.source).toBe('file');
    expect(rows.find(r => r.name === 'cloud')?.source).toBe('inline');
  });
});
