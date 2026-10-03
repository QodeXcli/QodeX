import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ToolRegistry } from '../src/tools/registry.js';
import { classifyAction } from '../src/sentinel/policy.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';

const ROOT = path.resolve(__dirname, '..');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Modules whose exports create or widen standing grants / mail rules. */
const WRITER_MODULE_RE = /from\s+['"][^'"]*\/grants\/(?:store|command|index)(?:\.js)?['"]|import\(\s*['"][^'"]*\/grants\/(?:store|command|index)(?:\.js)?['"]\s*\)|from\s+['"][^'"]*\/mail\/rules(?:\.js)?['"]|import\(\s*['"][^'"]*\/mail\/rules(?:\.js)?['"]\s*\)/;

/**
 * Human surfaces (and the plumbing they use) — the ONLY files allowed to reach the
 * grant / rule writers. Anything else importing them needs a security review.
 */
const ALLOWED = new Set([
  'src/grants/store.ts', 'src/grants/command.ts', 'src/grants/index.ts', 'src/grants/mail-scope.ts', 'src/grants/received.ts',
  'src/sentinel/guard.ts',            // a human clicking "always allow replies like this"
  'src/mail/rules.ts', 'src/mail/watcher.ts', // rule store (human commands) + the watcher (reads rules, bareAddress)
  'src/cli/platform-slash.ts',        // TUI /allow, /mail
  'src/channels/telegram/mail.ts',    // paired chat /allow, /mail
  'src/control/mail-bridge.ts',       // read + revoke only
  'src/index.ts',                     // qodex grant …, qodex mail rule …
]);

describe('no model-callable tool can create, widen or read grants', () => {
  it('the tool registry has no grant / rule / allow tool', () => {
    const reg = new ToolRegistry();
    const tools = reg.list();
    expect(tools.length).toBeGreaterThan(20);
    for (const t of tools) {
      expect(t.name, t.name).not.toMatch(/grant|allow|standing|mail_rule|rule_add|reply_?all|auto_?reply/i);
      const schema = JSON.stringify(t.schema());
      expect(schema, t.name).not.toMatch(/standing grant|grants\.json|mail-auto/i);
    }
  });

  it('only human surfaces import the grant / rule writers', async () => {
    const files = await walk(path.join(ROOT, 'src'));
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      const text = await fs.readFile(f, 'utf-8');
      if (WRITER_MODULE_RE.test(text) && !ALLOWED.has(rel)) offenders.push(rel);
      // A file that defines a model tool must never touch them, allowed or not.
      if (/extends\s+Tool\s*</.test(text) && WRITER_MODULE_RE.test(text)) offenders.push(`${rel} (defines a tool)`);
    }
    expect(offenders).toEqual([]);
  });

  it('the approval path creates a grant only for the explicit option, only from a human answer', async () => {
    const guard = await fs.readFile(path.join(ROOT, 'src/sentinel/guard.ts'), 'utf-8');
    const adds = guard.match(/\.add\(\{ kind: 'mail-reply'/g) ?? [];
    expect(adds.length).toBe(1);
    const i = guard.indexOf(".add({ kind: 'mail-reply'");
    const before = guard.slice(Math.max(0, i - 700), i);
    expect(before).toContain('picked === ALWAYS_REPLIES_OPTION');
    expect(before).toContain('!NON_HUMAN_BY.has(by)');
  });
});

describe('secrets never reach prompts or classifications', () => {
  it('a key in an email body is masked in the approval prompt lines and summary', () => {
    const c = classifyAction('mail_send', { to: 'a@x.org', subject: 'token sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', body: 'here: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' }, { config: { ...DEFAULT_SENTINEL_CONFIG } });
    const all = JSON.stringify(c);
    expect(all).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(c.category).toBe('credential');
  });
});
