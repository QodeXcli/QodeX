import { describe, it, expect } from 'vitest';
import { handleSlashCommand } from '../src/cli/slash-commands.js';

/**
 * Regression: an input that starts with '/' but is actually a filesystem path (or URL)
 * must NOT be treated as a slash command. It should fall through (handled:false) so the
 * agent receives it as a normal message — e.g. "/Users/me/shot.png analyze this".
 */
describe('slash-command routing vs file paths', () => {
  const cases = [
    '/Users/you/Desktop/Screenshot 2026-05-22 at 10.56.21.png please analyze',
    '/tmp/diagram.png',
    '/home/user/notes.md what is this',
    '/var/log/system.log',
  ];

  for (const input of cases) {
    it(`treats path-like input as a message, not a command: ${input.slice(0, 28)}…`, async () => {
      const r = await handleSlashCommand(input, 'test', process.cwd());
      expect(r.handled).toBe(false);
    });
  }

  it('still flags a genuine mistyped command as Unknown', async () => {
    const r = await handleSlashCommand('/helpp', 'test', process.cwd());
    expect(r.handled).toBe(true);
    expect(r.message).toMatch(/Unknown command/);
  });

  it('non-slash input is not handled here', async () => {
    const r = await handleSlashCommand('just a normal message', 'test', process.cwd());
    expect(r.handled).toBe(false);
  });

  it('/effort high sets a reasoning-effort action', async () => {
    const r = await handleSlashCommand('/effort high', 'test', process.cwd());
    expect(r.handled).toBe(true);
    expect(r.action).toEqual({ type: 'set_effort', value: 'high' });
  });

  it('/effort with no/invalid arg shows usage, no action', async () => {
    const r = await handleSlashCommand('/effort', 'test', process.cwd());
    expect(r.handled).toBe(true);
    expect(r.action).toBeUndefined();
    expect(r.message).toMatch(/low\|medium\|high\|off/);
  });

  it('bare /model lists the configured models when config is passed', async () => {
    const cfg = { defaults: { model: 'qwen2.5-coder:32b' }, providers: { openai: { extraModels: [{ model: 'qwen3-coder-next' }] } } };
    const r = await handleSlashCommand('/model', 'test', process.cwd(), cfg);
    expect(r.handled).toBe(true);
    expect(r.message).toMatch(/qwen2\.5-coder:32b/);
    expect(r.message).toMatch(/qwen3-coder-next/);
  });

  it('/model <id> sets the model', async () => {
    const r = await handleSlashCommand('/model claude-sonnet-4-6', 'test', process.cwd());
    expect(r.action).toEqual({ type: 'set_model', model: 'claude-sonnet-4-6' });
  });
});
