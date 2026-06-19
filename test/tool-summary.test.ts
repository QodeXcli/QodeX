import { describe, it, expect } from 'vitest';
import { summarizeToolResult } from '../src/cli/render/tool-summary.js';

describe('summarizeToolResult', () => {
  it('collapses a large read_file to just a line count — no body dumped', () => {
    const body = '[LARGE FILE — 541 lines. Showing a structural map]\n' + Array.from({ length: 40 }, (_, i) => `${i} code`).join('\n');
    const d = summarizeToolResult('read_file', body, false);
    expect(d.headline).toBe('541 lines');
    expect(d.lines).toEqual([]); // critical: the file body is never echoed
  });

  it('falls back to a raw line count when read_file has no header', () => {
    const d = summarizeToolResult('read_file', 'line1\nline2\nline3', false);
    expect(d.headline).toBe('3 lines');
    expect(d.lines).toEqual([]);
  });

  it('shows a count + capped preview for glob/ls', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`).join('\n');
    const d = summarizeToolResult('glob', paths, false);
    expect(d.headline).toBe('20 item(s)');
    expect(d.lines.length).toBe(9); // 8 entries + a "+N more" footer
    expect(d.lines[d.lines.length - 1]).toMatch(/\+12 more/);
  });

  it('uses match(es) wording for grep/search', () => {
    const d = summarizeToolResult('grep', 'a\nb\nc', false);
    expect(d.headline).toBe('3 match(es)');
  });

  it('shows exit code + output tail for shell', () => {
    const out = '> build\nstep1\nstep2\n✓ done\n[exit code: 0]';
    const d = summarizeToolResult('shell', out, false);
    expect(d.headline).toBe('exit 0');
    expect(d.lines).not.toContain('[exit code: 0]'); // the exit line is lifted into the headline
    expect(d.lines[d.lines.length - 1]).toBe('✓ done');
  });

  it('surfaces the message (capped) for errors, with no headline', () => {
    const d = summarizeToolResult('cd', '[ERROR] Unknown tool: cd.', true);
    expect(d.headline).toBe('');
    expect(d.lines[0]).toContain('Unknown tool');
  });

  it('caps a generic tool result preview', () => {
    const d = summarizeToolResult('something', Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), false);
    expect(d.lines.length).toBe(9); // 8 + footer
    expect(d.lines[d.lines.length - 1]).toMatch(/\+22 more/);
  });
});
