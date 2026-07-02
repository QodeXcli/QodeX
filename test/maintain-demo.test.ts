import { describe, it, expect } from 'vitest';
import { buildMaintainDemoHtml, buildMaintainDemoMarkdown } from '../src/cli/maintain-demo.ts';

describe('buildMaintainDemoHtml', () => {
  const html = buildMaintainDemoHtml();

  it('is a self-contained page with the headline pitch', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('A codebase that improves itself');
    expect(html).not.toContain('cdn');                 // fully self-contained, no external deps
  });

  it('shows the nightly loop steps and all six scopes', () => {
    for (const step of ['Code-graph analysis', 'Verify (tests + types)', 'Open PR', 'Trust receipt']) expect(html).toContain(step);
    for (const scope of ['dead-code', 'unused-imports', 'unused-locals', 'unused-params', 'lint-fix', 'dep-bump', 'consolidate-dupes', 'extract-helper']) expect(html).toContain(scope);
  });

  it('shows a trust receipt and the honesty claim (measured, not fabricated)', () => {
    expect(html).toContain('🧾 Receipt');
    expect(html).toContain('verified: ✓ npm test');
    expect(html).toMatch(/can’t fabricate a green receipt/);
  });

  it('is interactive: a play button animates the loop and a scope picker swaps the receipt', () => {
    expect(html).toContain('▶ Play the nightly run');         // animate the nightly run
    expect(html).toContain('id="play"');
    expect(html).toContain('data-scope="2"');                  // clickable scope cards
    expect(html).toContain('<script>');                        // self-contained JS, no deps
    expect(html).not.toContain('http://');                     // no external scripts/styles
  });

  it('teaches the verify-or-block gate with a real safe-block example', () => {
    expect(html).toContain('safe-block');                      // the unused-locals verdict tag
    expect(html).toMatch(/blocked[\s\S]*side-effect initializer/); // ships nothing, says why
  });
});

describe('buildMaintainDemoMarkdown', () => {
  const md = buildMaintainDemoMarkdown();

  it('is a shareable writeup: heading, numbered loop, a scope table, and a receipt block', () => {
    expect(md.startsWith('# QodeX')).toBe(true);
    expect(md).toContain('## The nightly loop');
    expect(md).toMatch(/1\. Code-graph analysis/);              // numbered steps
    expect(md).toContain('| Scope | What it does | Verdict |'); // markdown table header
    for (const scope of ['dead-code', 'unused-imports', 'consolidate-dupes']) expect(md).toContain(`\`${scope}\``);
    expect(md).toContain('🧾 Receipt');                         // the trust receipt example
    expect(md).toMatch(/can't fabricate a green receipt/);
  });

  it('is plain Markdown — no HTML tags or CDN links', () => {
    expect(md).not.toContain('<div');
    expect(md).not.toContain('<script');
    expect(md).not.toContain('http://');
  });
});
