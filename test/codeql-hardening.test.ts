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
