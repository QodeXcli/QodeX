/**
 * vault_request_login — the model asks, the human types the login into QodeX's
 * secure prompt, the value lands in the vault, and the tool result carries only the
 * entry name. Plus: Sentinel classifies it (credential, fixed high), relevance gating
 * ships it only for login / password-manager / browser tasks, and its schema stays
 * small (every tool definition is re-sent on each request).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Vault, setVaultForTests } from '../src/vault/vault.js';
import { VaultRequestLoginTool, VAULT_TOOL_CLASSES } from '../src/vault/tools.js';
import { SecretRequestBroker, setSecretRequestBrokerForTests } from '../src/vault/requests.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import { classifyAction, isGuardedTool } from '../src/sentinel/policy.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';
import { selectRelevantToolNames } from '../src/agent/tool-relevance.js';
import { getBus } from '../src/control/bus.js';
import { getRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/base.js';

const SECRET = 'Pl3ase-n0t-in-the-chat!';

let tmp: string;
let vault: Vault;
let broker: SecretRequestBroker;

function ctx(signal?: AbortSignal): ToolContext & { progress: string[] } {
  const progress: string[] = [];
  return {
    cwd: os.tmpdir(), sessionId: 's', transaction: {} as any, permissions: {} as any,
    askUser: async () => { throw new Error('a secret must never go through askUser'); },
    emit: (e: any) => { if (e.type === 'progress') progress.push(e.message); },
    signal,
    progress,
  };
}

const tool = new VaultRequestLoginTool();
const run = (args: Record<string, unknown>, c = ctx()) => tool.execute(tool.argsSchema.parse(args), c);

/** Plays the human at the terminal prompt: answers the first pending request. */
function humanTypes(values: { username?: string; password?: string; totp?: string } | 'cancel'): Promise<void> {
  return new Promise((resolve) => {
    const off = broker.onChange(list => {
      const p = list[0];
      if (!p) return;
      off();
      if (values === 'cancel') broker.cancel(p.id, 'terminal');
      else void broker.answer(p.id, values, 'terminal');
      resolve();
    });
  });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-v2-tool-'));
  vault = new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });
  setVaultForTests(vault);
  broker = new SecretRequestBroker();
  setSecretRequestBrokerForTests(broker);
  getBus().reset();
});
afterEach(async () => {
  broker.reset();
  setSecretRequestBrokerForTests(null);
  setVaultForTests(null);
  setBrowserManagerForTests(null);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('vault_request_login', () => {
  it('is registered as a vault tool, mutating (it waits for a human), without a loop timeout', () => {
    expect(VAULT_TOOL_CLASSES).toContain(VaultRequestLoginTool);
    expect(tool.isReadOnly).toBe(false);
    expect(tool.timeoutSeconds).toBe(0);
    expect(getRegistry().get('vault_request_login')).toBeDefined();
  });

  it('stores what the human typed and returns only the entry name', async () => {
    broker.attachSurface('terminal');
    const typing = humanTypes({ username: 'octo', password: SECRET });
    const c = ctx();
    const r = await run({ site: 'https://github.com/login', reason: 'push the release', username_hint: 'octo' }, c);
    await typing;
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/vault entry "github\.com"/);
    expect(r.content).toMatch(/browser_fill_secret/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(c.progress.join(' ')).toMatch(/secure prompt/);
    expect((await vault.get('github.com'))?.secret).toBe(SECRET);
    expect(JSON.stringify(getBus().recent(300))).not.toContain(SECRET);
  });

  it('rotates the existing entry of that site when no name is given', async () => {
    await vault.add({ name: 'gh', origins: ['github.com'], username: 'octo', secret: 'old' });
    broker.attachSurface('terminal');
    const typing = humanTypes({ password: SECRET });
    const r = await run({ site: 'github.com', reason: 'the password was changed' });
    await typing;
    expect(r.content).toMatch(/updated the login .* "gh"/);
    const e = (await vault.get('gh'))!;
    expect([e.username, e.secret]).toEqual(['octo', SECRET]);
  });

  it('fails fast with the CLI hint when no secure input exists', async () => {
    const r = await run({ site: 'github.com', reason: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^\[NO_SECURE_INPUT\]/);
    expect(r.content).toMatch(/qodex vault add github\.com --origin github\.com/);
    expect(r.content).toMatch(/never ask for the password in chat/);
  });

  it('reports a decline (Esc / Cancel) without failing the run, and honors the abort signal', async () => {
    broker.attachSurface('terminal');
    const typing = humanTypes('cancel');
    const r = await run({ site: 'github.com', reason: 'x' });
    await typing;
    expect(r.content).toMatch(/^\[SECRET_REQUEST_CANCELLED\]/);
    const ac = new AbortController();
    const p = run({ site: 'gitlab.com', reason: 'x' }, ctx(ac.signal));
    await new Promise(res => setTimeout(res, 20));
    ac.abort();
    expect((await p).content).toMatch(/^\[CANCELLED\]/);
  });

  it('warns the human when the agent\'s browser is on another site, and shows punycode hosts decoded', async () => {
    setBrowserManagerForTests({ isRunning: () => true, activeUrl: () => 'https://xn--80ak6aa92e.com/login' } as any);
    broker.attachSurface('terminal');
    let seen: any;
    const off = broker.onChange(list => { if (list[0]) { seen = list[0]; off(); broker.cancel(list[0].id, 'terminal'); } });
    await run({ site: 'apple.com', reason: 'x' });
    expect(seen.warning).toBe('The agent\'s browser is on аррӏе.com (xn--80ak6aa92e.com), not apple.com.');
    expect(seen.displayHost).toBe('apple.com');
  });

  it('rejects unusable sites', async () => {
    broker.attachSurface('terminal');
    expect((await run({ site: 'http://bank.example', reason: 'x' })).content).toMatch(/^\[VAULT_INVALID\]/);
    expect((await run({ site: 'javascript:alert(1)', reason: 'x' })).content).toMatch(/^\[VAULT_INVALID\]/);
  });
});

describe('Sentinel and tool gating', () => {
  it('is a guarded credential action with a FIXED high risk (the human typing is the consent)', () => {
    expect(isGuardedTool('vault_request_login')).toBe(true);
    const c = classifyAction('vault_request_login', { site: 'https://accounts.google.com/x', reason: 'r', name: 'google' }, { config: DEFAULT_SENTINEL_CONFIG } as any);
    expect(c.category).toBe('credential');
    expect(c.risk).toBe('high');
    expect(c.domain).toBe('accounts.google.com');
    expect(c.summary).toMatch(/type the login for accounts\.google\.com .*vault entry "google"/);
    expect(c.block).toBeFalsy();
  });

  it('ships only for login / password-manager / browser tasks', () => {
    const all = getRegistry().list().map(t => t.name);
    const has = (signal: string) => selectRelevantToolNames(all, signal).selected.has('vault_request_login');
    expect(has('save my github password in the vault')).toBe(true);
    expect(has('log in to github.com and star the repo')).toBe(true);
    expect(has('رمز عبور سایت دیجی کالا رو ذخیره کن')).toBe(true);
    expect(has('update my login for the bank')).toBe(true);
    expect(has('fix the failing assertion in src/agent/loop.ts and run the tests')).toBe(false);
    expect(has('search the web for the current recommended vite config')).toBe(false);
  });

  it('keeps a small schema (no zod describe after optional, short description)', () => {
    const s = tool.schema();
    expect(s.function.description.length).toBeLessThan(140);
    expect(JSON.stringify(s).length).toBeLessThan(450);
    expect(s.function.parameters.required).toEqual(['site', 'reason']);
  });
});
