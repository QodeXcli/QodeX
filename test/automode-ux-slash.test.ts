/**
 * Slash commands for the approval mode: /auto (and its /mode alias) and /status.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { handleSlashCommand } from '../src/cli/slash-commands.js';
import { SLASH_CATALOG } from '../src/cli/slash-catalog.js';
import { setApprovalMode } from '../src/security/permissions.js';

afterEach(() => { setApprovalMode('manual'); });

describe('/mode is /auto', () => {
  it('sets the mode with the same words', async () => {
    for (const [arg, mode] of [['auto', 'auto'], ['on', 'auto'], ['edits', 'edits'], ['manual', 'manual'], ['off', 'manual']] as const) {
      const r = await handleSlashCommand(`/mode ${arg}`, 'sess-1234', process.cwd());
      expect(r.handled).toBe(true);
      expect(r.action).toEqual({ type: 'set_approval_mode', mode });
    }
  });

  it('bare /auto and /mode explain the modes and every way to turn auto on', async () => {
    for (const cmd of ['/auto', '/mode']) {
      const r = await handleSlashCommand(cmd, 'sess-1234', process.cwd());
      expect(r.action).toBeUndefined();
      expect(r.message).toMatch(/Approval: manual/);
      expect(r.message).toMatch(/Shift\+Tab/);
      expect(r.message).toMatch(/--auto/);
      expect(r.message).toMatch(/approval\.defaultMode/);
      expect(r.message).toMatch(/approval\.extraRoots/);
      expect(r.message).toMatch(/purchases, payments, passwords/);
    }
  });

  it('a bad value is a usage message, not a mode change', async () => {
    const r = await handleSlashCommand('/mode sometimes', 'sess-1234', process.cwd());
    expect(r.action).toBeUndefined();
    expect(r.message).toMatch(/Usage/);
  });
});

describe('/status', () => {
  it('shows the approval mode (and the strict mode / session)', async () => {
    setApprovalMode('auto');
    const r = await handleSlashCommand('/status', 'abcdef123456', '/tmp/proj', { defaults: { model: 'fake-model' } });
    expect(r.handled).toBe(true);
    expect(r.message).toMatch(/^Approval: auto — Autonomous/);
    expect(r.message).toMatch(/Strict mode: (ON|OFF)/);
    expect(r.message).toContain('abcdef12');
    expect(r.message).toContain('fake-model');
    setApprovalMode('edits');
    expect((await handleSlashCommand('/status', 'abcdef123456', '/tmp/proj')).message).toMatch(/^Approval: edits/);
  });
});

describe('catalog and help', () => {
  it('lists /auto with the new modes, /mode and /status', async () => {
    const byName = new Map(SLASH_CATALOG.map(e => [e.name, e]));
    expect(byName.get('auto')?.args).toBe('[manual|edits|auto]');
    expect(byName.has('mode')).toBe(true);
    expect(byName.has('status')).toBe(true);
    const help = (await handleSlashCommand('/help', 's', process.cwd())).message ?? '';
    expect(help).toMatch(/\/auto \[manual\|edits\|auto\]/);
    expect(help).toMatch(/\/status/);
    expect(help).not.toMatch(/on=always/);
  });
});
