/**
 * The terminal's masked login prompt (src/cli/prompts/secret-input.tsx), rendered by
 * the real Ink renderer into a fake TTY: what the human types lands in the vault,
 * the password never appears on screen (dots only), Esc cancels the REQUEST (the
 * tool reports a decline; nothing aborts), a mismatched repeat starts over, and a
 * prompt waiting behind a confirmation takes no keystrokes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import React from 'react';
import { render } from 'ink';
import { Vault } from '../src/vault/vault.js';
import { SecretRequestBroker } from '../src/vault/requests.js';
import { SecretPromptHost, secretSteps } from '../src/cli/prompts/secret-input.js';
import { readFileSync } from 'fs';

const SECRET = 'n0-one-may-see-th1s';

class FakeStdout extends EventEmitter {
  columns = 120;
  rows = 40;
  isTTY = true;
  out = '';
  write(s: string): boolean { this.out += s; return true; }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode(): void {}
  setEncoding(): void {}
  ref(): void {}
  unref(): void {}
  resume(): void {}
  pause(): void {}
  read(): string | null { return this.queue.shift() ?? null; }
  type(s: string): void { this.queue.push(s); this.emit('readable'); }
}

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(10);
  }
}

let tmp: string;
let vault: Vault;
let broker: SecretRequestBroker;
let stdout: FakeStdout;
let stdin: FakeStdin;
let app: ReturnType<typeof render> | null;
let activeLog: boolean[];

function mount(props: { blocked?: boolean } = {}) {
  activeLog = [];
  app = render(
    React.createElement(SecretPromptHost, { broker, blocked: props.blocked, onActiveChange: (a: boolean) => activeLog.push(a) }),
    { stdout: stdout as any, stdin: stdin as any, stderr: stdout as any, exitOnCtrlC: false, patchConsole: false, debug: false },
  );
}

async function key(s: string): Promise<void> {
  stdin.type(s);
  await tick();
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-v2-tui-'));
  vault = new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });
  broker = new SecretRequestBroker(() => vault);
  stdout = new FakeStdout();
  stdin = new FakeStdin();
  app = null;
});
afterEach(async () => {
  app?.unmount();
  broker.reset();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('terminal secret prompt', { timeout: 20_000 }, () => {
  it('orders the fields: username, password, repeat, then the optional 2FA key', () => {
    expect(secretSteps({ fields: ['username', 'password'] })).toEqual(['username', 'password', 'repeat']);
    expect(secretSteps({ fields: ['username', 'password', 'totp'] })).toEqual(['username', 'password', 'repeat', 'totp']);
  });

  it('registers the terminal surface only while mounted', async () => {
    expect(broker.availableSurfaces()).toEqual([]);
    mount();
    await tick();
    expect(broker.availableSurfaces()).toEqual(['terminal']);
    app!.unmount();
    app = null;
    await tick();
    expect(broker.availableSurfaces()).toEqual([]);
  });

  it('saves the typed login to the vault and only ever shows dots', async () => {
    mount();
    await tick();
    const done = broker.request({ entryName: 'github', origins: ['github.com'], fields: ['password'], reason: 'push the release', usernameHint: 'octo' });
    await waitFor(() => plain(stdout.out).includes('Login for github.com'), 'the prompt');
    await waitFor(() => activeLog.includes(true), 'keyboard ownership');
    expect(plain(stdout.out)).toContain('push the release');
    expect(plain(stdout.out)).toContain('octo'); // the username hint is pre-filled (not a secret)
    await key('\r'); // accept "octo"
    await key(SECRET);
    await waitFor(() => plain(stdout.out).includes('•'.repeat(SECRET.length)), 'masked password');
    await key('\r');
    await key(SECRET);
    await key('\r');
    const r = await done;
    expect(r).toMatchObject({ ok: true, code: 'saved', by: 'terminal' });
    const e = (await vault.get('github'))!;
    expect([e.username, e.secret]).toEqual(['octo', SECRET]);
    expect(stdout.out).not.toContain(SECRET);
    expect(stdout.out).not.toContain(SECRET.slice(0, 6));
    await waitFor(() => activeLog.at(-1) === false, 'keyboard released');
  });

  it('Esc cancels the request (the tool reports a decline) and nothing is stored', async () => {
    mount();
    await tick();
    const done = broker.request({ entryName: 'bank', origins: ['bank.example'], fields: ['password'], reason: 'pay' });
    await waitFor(() => activeLog.includes(true), 'keyboard ownership');
    await key('\r');
    await key('half-typed');
    await key('\u001b');
    expect(await done).toMatchObject({ ok: false, code: 'cancelled', by: 'terminal' });
    expect(await vault.get('bank')).toBeNull();
    expect(stdout.out).not.toContain('half-typed');
  });

  it('a mismatched repeat starts the password over', async () => {
    mount();
    await tick();
    const done = broker.request({ entryName: 'site', origins: ['site.example'], fields: ['password'], reason: 'x' });
    await waitFor(() => activeLog.includes(true), 'keyboard ownership');
    await key('\r');
    await key('first-secret');
    await key('\r');
    await key('other-secret');
    await key('\r');
    await waitFor(() => plain(stdout.out).includes('do not match'), 'mismatch error');
    await key(SECRET);
    await key('\r');
    await key(SECRET);
    await key('\r');
    expect(await done).toMatchObject({ ok: true });
    expect((await vault.get('site'))!.secret).toBe(SECRET);
  });

  it('asks for the 2FA key when wanted and re-asks after an invalid one', async () => {
    mount();
    await tick();
    const done = broker.request({ entryName: 'two', origins: ['two.example'], fields: ['password', 'totp'], reason: 'x' });
    await waitFor(() => activeLog.includes(true), 'keyboard ownership');
    await key('\r');
    await key(SECRET); await key('\r');
    await key(SECRET); await key('\r');
    await key('not-a-base32-key!'); await key('\r');
    await waitFor(() => plain(stdout.out).includes('TOTP_INVALID'), 'totp error');
    expect(plain(stdout.out)).not.toContain('not-a-base32-key');
    await key('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'); await key('\r');
    expect(await done).toMatchObject({ ok: true });
    expect((await vault.get('two'))!.totp).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  });

  it('waits behind another prompt without taking keystrokes', async () => {
    mount({ blocked: true });
    await tick();
    const done = broker.request({ entryName: 'later', origins: ['later.example'], fields: ['password'], reason: 'x' });
    await waitFor(() => plain(stdout.out).includes('answer the prompt above first'), 'blocked notice');
    await key('\u001b');
    await key('typed-elsewhere\r');
    expect(broker.pending()).toHaveLength(1);
    expect(activeLog.includes(true)).toBe(false);
    broker.cancel(broker.pending()[0]!.id, 'test');
    await done;
  });

  it('ui.tsx hands it the keyboard: chat input hidden, global shortcuts (Esc = stop run) stand aside', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'cli', 'ui.tsx'), 'utf8');
    expect(src).toMatch(/useInput\(\(_input, key\) => \{\s*if \(secretActiveRef\.current\) return;/);
    expect(src).toContain('<SecretPromptHost blocked={!!pendingPrompt} onActiveChange={setSecretActive} />');
    expect(src).toContain('{!pendingPrompt && !secretActive && (');
    // The ChatInput (and its history) lives only inside that block.
    const block = src.slice(src.indexOf('{!pendingPrompt && !secretActive && ('));
    expect(block).toContain('<ChatInput');
    expect(src.split('<ChatInput').length).toBe(2);
  });
});
