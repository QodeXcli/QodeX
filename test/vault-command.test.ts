import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildVaultCommand, type VaultCommandIO } from '../src/vault/command.js';
import { Vault } from '../src/vault/vault.js';

let tmp: string;
let vault: Vault;
let out: string[];
let err: string[];

function run(args: string[], io: Partial<VaultCommandIO>) {
  const cmd = buildVaultCommand({ vault: () => vault, io: { out: l => out.push(l), err: l => err.push(l), ...io } });
  cmd.exitOverride();
  return cmd.parseAsync(args, { from: 'user' });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-vault-cmd-'));
  vault = new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });
  out = [];
  err = [];
  process.exitCode = 0;
});
afterEach(async () => {
  process.exitCode = 0;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('qodex vault', () => {
  it('adds from stdin (non-TTY) with a TOTP seed, lists, removes', async () => {
    await run(['add', 'github', '--origin', 'github.com,gist.github.com', '--username', 'octo', '--totp'], {
      isTTY: () => false, readStdin: async () => 'pa55word\nJBSWY3DPEHPK3PXP\n',
    });
    expect(err).toEqual([]);
    expect(out[0]).toBe('✓ Saved "github" — sites: github.com, gist.github.com — fields: username, password, totp');
    expect(await vault.get('github')).toMatchObject({ secret: 'pa55word', totp: 'JBSWY3DPEHPK3PXP', username: 'octo' });

    out = [];
    await run(['list'], {});
    expect(out.join('\n')).toContain('● github  (octo)');
    expect(out.join('\n')).toContain('sites: github.com, gist.github.com   fields: username, password, totp');
    expect(out.join('\n')).not.toContain('pa55word');

    out = [];
    await run(['ls', '--json'], {});
    expect(JSON.parse(out[0])[0]).toMatchObject({ name: 'github', totp: true });

    out = [];
    await run(['rm', 'github'], {});
    expect(out[0]).toBe('✓ Removed "github" from the vault.');
    await run(['rm', 'github'], {});
    expect(err[0]).toContain('No vault entry named "github"');
    expect(process.exitCode).toBe(1);
  });

  it('reads hidden input on a TTY and requires a matching repeat', async () => {
    const answers = ['s3cret', 's3cret'];
    const prompts: string[] = [];
    await run(['add', 'mail', '-o', 'mail.example.com'], {
      isTTY: () => true, readHidden: async (p) => { prompts.push(p); return answers.shift() ?? ''; },
    });
    expect(prompts[0]).toContain('(hidden)');
    expect((await vault.get('mail'))?.secret).toBe('s3cret');

    const bad = ['one', 'two'];
    await run(['add', 'mail2', '-o', 'mail.example.com'], { isTTY: () => true, readHidden: async () => bad.shift() ?? '' });
    expect(err.at(-1)).toContain('did not match');
    expect(await vault.get('mail2')).toBeNull();
  });

  it('rejects bad origins, duplicates without --force, and bad TOTP seeds', async () => {
    await run(['add', 'x', '--origin', 'http://example.com'], { isTTY: () => false, readStdin: async () => 'pw' });
    expect(err.at(-1)).toMatch(/VAULT_INVALID/);
    await run(['add', 'x', '--origin', 'example.com'], { isTTY: () => false, readStdin: async () => 'pw' });
    await run(['add', 'x', '--origin', 'example.com'], { isTTY: () => false, readStdin: async () => 'pw2' });
    expect(err.at(-1)).toMatch(/VAULT_EXISTS/);
    await run(['add', 'x', '--origin', 'example.com', '--force'], { isTTY: () => false, readStdin: async () => 'pw2' });
    expect((await vault.get('x'))?.secret).toBe('pw2');
    await run(['add', 'y', '--origin', 'y.example', '--totp'], { isTTY: () => false, readStdin: async () => 'pw\nnot-base32!' });
    expect(err.at(-1)).toMatch(/TOTP_INVALID/);
    expect(await vault.get('y')).toBeNull();
    await run(['add', 'z', '--origin', 'github.io'], { isTTY: () => false, readStdin: async () => 'pw' });
    expect(out.some(l => l.includes('shared hosting'))).toBe(true);
  });
});
