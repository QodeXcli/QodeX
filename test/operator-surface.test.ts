import { describe, it, expect } from 'vitest';
import { fillTemplate, isSafeToolName } from '../src/plugins/user-tool.js';
import { renderIdentitySection } from '../src/context/identity.js';
import { formatHandoff } from '../src/session/handoff.js';
import { startSideRun, listSideRuns } from '../src/agent/side-runs.js';

describe('plugin shell templates', () => {
  it('quotes substituted args so spaces cannot break the command', () => {
    expect(fillTemplate('echo {{title}}', { title: "it's a test" })).toBe("echo 'it'\\''s a test'");
  });
  it('leaves unknown tokens in place', () => {
    expect(fillTemplate('x {{missing}}', {})).toBe('x {{missing}}');
  });
  it('rejects unsafe tool names', () => {
    expect(isSafeToolName('deploy_staging')).toBe(true);
    expect(isSafeToolName('../rm')).toBe(false);
    expect(isSafeToolName('Deploy')).toBe(false);
  });
});

describe('identity block', () => {
  it('is empty when there is nothing to inject (zero token cost)', () => {
    expect(renderIdentitySection('')).toBe('');
    expect(renderIdentitySection('  ')).toBe('');
  });
  it('wraps standing constraints for the stable prefix', () => {
    const s = renderIdentitySection('Never commit to main.');
    expect(s).toMatch(/Standing identity/);
    expect(s).toContain('Never commit to main.');
  });
});

describe('handoff formatting', () => {
  it('shows a short session id and cwd', () => {
    const s = formatHandoff({
      sessionId: 'abcdefghijklmnop',
      cwd: '/work/app',
      updatedAt: new Date().toISOString(),
    });
    expect(s).toMatch(/abcdefgh/);
    expect(s).toContain('/work/app');
  });
});

describe('side runs', () => {
  it('refuses to start without a sub-agent runner (no silent spawn)', () => {
    const r = startSideRun('write the tests', 'sess');
    expect(r).toEqual({ error: expect.stringMatching(/sub-agents/i) });
    expect(listSideRuns()).toHaveLength(0);
  });
  it('refuses an empty prompt', () => {
    const r = startSideRun('   ', 'sess');
    expect(r).toHaveProperty('error');
  });
});
