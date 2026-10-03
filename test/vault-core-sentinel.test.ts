import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyAction, classifyNavigation, isGuardedTool, type PolicyContext } from '../src/sentinel/policy.js';
import { Sentinel } from '../src/sentinel/guard.js';
import { DEFAULT_SENTINEL_CONFIG, type SentinelConfig } from '../src/config/agent-config.js';
import { QODEX_HOME } from '../src/config/defaults.js';
import { QODEX_VAULT_KEYSTORE_FILE, QODEX_VAULT_KEY_DPAPI_FILE } from '../src/vault/paths.js';
import { isProtectedQodexPath } from '../src/tools/browser/session.js';
import { isProtectedQodexTarget } from '../src/tools/computer/use.js';
import { isForbiddenUpload } from '../src/workflows/replay.js';
import { ApprovalBroker } from '../src/control/approvals.js';
import { getBus } from '../src/control/bus.js';
import { PermissionEngine, setApprovalMode } from '../src/security/permissions.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { ToolContext } from '../src/tools/base.js';

const cfg = (over: Partial<SentinelConfig> = {}): SentinelConfig => ({ ...DEFAULT_SENTINEL_CONFIG, ...over });
const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({ config: cfg(), cwd: '/home/u/project', ...over });
const blocked = (tool: string, args: Record<string, unknown>, c: PolicyContext = ctx()) => classifyAction(tool, args, c).block === true;

describe('password-manager exports are off limits to the agent', () => {
  const exports = ['~/Downloads/Chrome Passwords.csv', '/home/u/Downloads/Microsoft Edge Passwords.csv', '/tmp/logins.csv', 'bitwarden_export_20261003.json', '/x/1PasswordExport-AB12.csv', '/x/vault.1pux'];

  it('file tools cannot read them; deleting one stays possible', () => {
    for (const p of exports) {
      for (const tool of ['read_file', 'csv_read', 'grep', 'edit_text', 'pdf_read']) expect(blocked(tool, { path: p }), `${tool} ${p}`).toBe(true);
    }
    const c = classifyAction('read_file', { path: exports[0] }, ctx());
    expect(c.category).toBe('credential');
    expect(c.risk).toBe('critical');
    expect(c.reason).toMatch(/password-manager export/);
    expect(blocked('safe_delete_file', { path: exports[0] })).toBe(false);
    expect(blocked('read_file', { path: '/home/u/project/data/passwords-report.csv' })).toBe(false);
    expect(blocked('read_file', { path: 'src/logins.ts' })).toBe(false);
  });

  it('shell, desktop, upload, file:// and workflow uploads are refused too', () => {
    for (const command of ['cat ~/Downloads/Chrome\\ Passwords.csv', 'head "Microsoft Edge Passwords.csv"', 'python -c "print(open(\'logins.csv\').read())"', 'cp bitwarden_export_1.json /tmp/x', 'unzip vault.1pux']) {
      expect(blocked('shell', { command }), command).toBe(true);
    }
    expect(blocked('shell', { command: 'cat data.csv' })).toBe(false);
    expect(blocked('computer_use_type', { text: 'cat ~/Downloads/Chrome\\ Passwords.csv', submit: true })).toBe(true);
    expect(blocked('computer_use_open', { target: '/home/u/Downloads/Chrome Passwords.csv' })).toBe(true);
    expect(blocked('browser_upload', { paths: ['/home/u/Downloads/logins.csv'] })).toBe(true);
    expect(classifyNavigation('file:///home/u/Downloads/Chrome%20Passwords.csv', ctx()).block).toBe(true);
    expect(isProtectedQodexTarget('/home/u/Downloads/Chrome Passwords.csv')).toBe(true);
    expect(isForbiddenUpload('/home/u/Downloads/bitwarden_export_x.csv')).toBe(true);
    expect(isForbiddenUpload('/home/u/project/report.csv')).toBe(false);
  });
});

describe('vault key artifacts are protected like the key file', () => {
  it('keystore record + DPAPI blob in all three lists', () => {
    for (const f of [QODEX_VAULT_KEYSTORE_FILE, QODEX_VAULT_KEY_DPAPI_FILE]) {
      expect(blocked('read_file', { path: f }), f).toBe(true);
      expect(blocked('write_file', { path: f, content: '{}' }), f).toBe(true);
      expect(blocked('shell', { command: `cat ${f}` }), f).toBe(true);
      expect(blocked('browser_upload', { paths: [f] }), f).toBe(true);
      expect(classifyNavigation(`file://${f}`, ctx()).block).toBe(true);
      expect(isProtectedQodexPath(f), f).toBe(true);
      expect(isProtectedQodexTarget(f), f).toBe(true);
    }
    expect(blocked('shell', { command: 'rm vault-keystore.json' }, ctx({ cwd: QODEX_HOME }))).toBe(true);
    expect(blocked('shell', { command: 'cat ~/.qodex/vault-keystore.json' })).toBe(true);
  });

  it('reading the key out of the OS keychain is blocked (shell and desktop typing)', () => {
    for (const command of [
      'security find-generic-password -s qodex-vault-key -w',
      'secret-tool lookup service qodex-vault-key account qodex-abc',
      'powershell -c "Get-StoredCredential qodex-vault-key"',
    ]) {
      expect(blocked('shell', { command }), command).toBe(true);
      expect(blocked('computer_use_type', { text: command, submit: true }), command).toBe(true);
    }
    expect(blocked('shell', { command: 'security find-generic-password -s github.com' })).toBe(false);
  });
});

describe('mutating vault subcommands are human-only; reads stay allowed', () => {
  it('import / edit / rotate / key migrate are critical integrity', () => {
    for (const command of [
      'qodex vault import ~/Downloads/export.csv', 'qx vault edit github --add-origin evil.example', 'qodex vault rotate github --undo',
      'qodex vault key migrate file', 'npx qodex vault import x.csv --on-conflict replace', 'printf "pw" | qodex vault rotate github',
    ]) {
      const c = classifyAction('shell', { command }, ctx());
      expect(c.risk, command).toBe('critical');
      expect(c.integrity, command).toBe(true);
    }
    for (const command of ['qodex vault list', 'qodex vault ls --json', 'qodex vault key status']) {
      const c = classifyAction('shell', { command }, ctx());
      expect(c.risk === 'critical' || !!c.block, command).toBe(false);
    }
    expect(classifyAction('computer_use_type', { text: 'qodex vault rotate github', submit: true }, ctx()).integrity).toBe(true);
  });
});

describe('new vault tools are classified (fixed high credential)', () => {
  it('browser_login and vault_generate_and_fill', () => {
    expect(isGuardedTool('browser_login')).toBe(true);
    expect(isGuardedTool('vault_generate_and_fill')).toBe(true);
    const login = classifyAction('browser_login', { secret: 'github', url: 'github.com/login' }, ctx());
    expect(login).toMatchObject({ category: 'credential', risk: 'high', domain: 'github.com' });
    expect(login.summary).toBe('sign in with vault entry "github" on github.com');
    const fillOnly = classifyAction('browser_login', { secret: 'github', submit: false }, ctx({ url: 'https://github.com/login' }));
    expect(fillOnly.summary).toBe('sign in with vault entry "github" on github.com (fill only)');
    expect(classifyAction('browser_login', { secret: 'x', url: 'https://evil.example/' }, ctx({ config: cfg({ blockedDomains: ['evil.example'] }) })).block).toBe(true);
    const gen = classifyAction('vault_generate_and_fill', { ref: 'e5', name: 'shop' }, ctx({ url: 'https://shop.example.com/register' }));
    expect(gen).toMatchObject({ category: 'credential', risk: 'high', domain: 'shop.example.com' });
    expect(gen.summary).toMatch(/create and save a new password for vault entry "shop" and fill it into "e5" on shop\.example\.com/);
  });
});

// ── through the real guard: auto mode silent, manual asks, never critical ──

let tmp: string;
let broker: ApprovalBroker;

function makeCtx(answer: string): { ctx: ToolContext; asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    ctx: {
      cwd: tmp, sessionId: 's', transaction: {} as any, permissions: new PermissionEngine(DEFAULT_CONFIG),
      askUser: async (_p, options) => { asked.push(options ?? []); return answer; }, emit: () => {},
    },
  };
}
const sentinel = () => new Sentinel({
  config: () => ({ ...DEFAULT_SENTINEL_CONFIG, audit: false }), audit: null, broker: () => broker, interactive: () => true,
  browser: () => ({ isRunning: () => true, activeUrl: () => 'https://github.com/login', describeRef: async () => null, describeSelector: async () => null } as any),
  workflowsDir: path.join(tmp, 'wf'),
});

describe('guard behaviour', () => {
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-vc-sent-')); broker = new ApprovalBroker(); getBus().reset(); });
  afterEach(async () => { setApprovalMode('manual'); broker.reset(); await fs.rm(tmp, { recursive: true, force: true }); });

  it('auto mode runs a vault login / generated password silently; manual asks yes/no/always', async () => {
    for (const [tool, args] of [['browser_login', { secret: 'github' }], ['vault_generate_and_fill', { ref: 'e3' }]] as const) {
      setApprovalMode('auto');
      let m = makeCtx('no');
      expect(await sentinel().beforeTool(tool, args, m.ctx), tool).toBeNull();
      expect(m.asked).toHaveLength(0);
      setApprovalMode('manual');
      m = makeCtx('no');
      const r = await sentinel().beforeTool(tool, args, m.ctx);
      expect(m.asked).toEqual([['yes', 'no', 'always']]);
      expect(r?.content).toMatch(/^\[SENTINEL_DENIED\]/);
    }
  });
});
