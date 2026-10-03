/**
 * Fixes for code-scanning findings on the agent-platform PR.
 */
import { describe, it, expect } from 'vitest';
import { htmlToPlain } from '../src/channels/telegram/format.js';

describe('htmlToPlain — tag stripping is complete', () => {
  it('a removed tag cannot splice a new one together', () => {
    expect(htmlToPlain('<<b>b>alert(1)<</b>/b>')).not.toMatch(/<\/?b>/);
    expect(htmlToPlain('<scr<b>ipt>x</scr</b>ipt>')).not.toMatch(/<script/i);
  });

  it('keeps text, line breaks and escaped characters', () => {
    expect(htmlToPlain('<b>Hi</b><br>a &lt;b&gt; &amp; "c"')).toBe('Hi\na <b> & "c"');
  });
});

describe('control center login bounce stays on the server', () => {
  it('isLocalRedirect accepts paths and refuses other origins', async () => {
    const { isLocalRedirect, stripTokenFromUrl } = await import('../src/control/server.js');
    expect(isLocalRedirect('/')).toBe(true);
    expect(isLocalRedirect('/missions?x=1')).toBe(true);
    expect(isLocalRedirect('//evil.example/')).toBe(false);
    expect(isLocalRedirect('/\\evil.example')).toBe(false);
    expect(isLocalRedirect('https://evil.example/')).toBe(false);
    expect(isLocalRedirect('javascript:alert(1)')).toBe(false);
    for (const raw of ['//evil.example/?k=t', '/\\evil.example?k=t', '/ok?k=t&a=1']) {
      const t = stripTokenFromUrl(raw);
      expect(isLocalRedirect(t)).toBe(true);
      expect(t).not.toMatch(/k=t/);
    }
  });
});
