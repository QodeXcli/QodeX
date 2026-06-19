import { describe, it, expect } from 'vitest';
import { parseSegments } from '../src/cli/render/assistant-message.js';

describe('parseSegments (assistant message code/prose split)', () => {
  it('splits prose and fenced code into ordered segments', () => {
    const msg = 'Intro line.\n\n```bash\nnpm run build\n```\n\nOutro line.';
    const segs = parseSegments(msg);
    expect(segs.map(s => s.kind)).toEqual(['text', 'code', 'text']);
    const code = segs.find(s => s.kind === 'code') as any;
    expect(code.lang).toBe('bash');
    expect(code.body).toBe('npm run build');
  });

  it('handles multiple code blocks with different languages', () => {
    const msg = '```bash\nls\n```\nmiddle\n```typescript\nconst x = 1;\n```';
    const segs = parseSegments(msg);
    const codes = segs.filter(s => s.kind === 'code') as any[];
    expect(codes).toHaveLength(2);
    expect(codes[0].lang).toBe('bash');
    expect(codes[1].lang).toBe('typescript');
  });

  it('treats a message with no code as a single text segment', () => {
    const segs = parseSegments('Just a plain answer with no code.');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
  });

  it('handles a fenced block with no language label', () => {
    const segs = parseSegments('```\nraw\n```');
    const code = segs.find(s => s.kind === 'code') as any;
    expect(code.lang).toBe('');
    expect(code.body).toBe('raw');
  });

  it('never returns an empty array', () => {
    expect(parseSegments('').length).toBeGreaterThan(0);
  });
});

import { tokenizeCodeLine, renderInline, parseSegments as parse2 } from '../src/cli/render/assistant-message.js';

describe('parseSegments — streaming (unterminated fence)', () => {
  it('renders an open trailing fence as an incomplete code segment', () => {
    const midStream = 'Here is the fix:\n```typescript\nconst x = 1;\nconst y = 2;';
    const segs = parse2(midStream);
    expect(segs[0].kind).toBe('text');
    const code = segs.find(s => s.kind === 'code') as any;
    expect(code).toBeTruthy();
    expect(code.lang).toBe('typescript');
    expect(code.incomplete).toBe(true);
    expect(code.body).toContain('const x = 1;');
    expect(code.body).toContain('const y = 2;');
  });

  it('still splits a fully-closed block normally (no incomplete flag)', () => {
    const segs = parse2('text\n```js\ncode\n```\nmore');
    const code = segs.find(s => s.kind === 'code') as any;
    expect(code.incomplete).toBeUndefined();
  });
});

describe('tokenizeCodeLine — verbatim safety contract', () => {
  const samples: Array<[string, string]> = [
    ['const x = 1;', 'js'],
    ['  return await fetch("https://x.com?a=1&b=2");', 'ts'],
    ['def foo(self, x): # comment "with quotes"', 'py'],
    ['const s = `tpl ${a + b}`;', 'js'],
    ['// full comment with `ticks` and 123', 'js'],
    ['let weird = "unterminated', 'js'],
    ['x = 0xFF + 1.5e-10', 'js'],
    ['', 'js'],
    ['   ', 'js'],
    ['émoji π ≈ 3.14 中文', 'js'],
    ['a"b\'c`d', 'js'],
    ['\t\tindented = true', 'js'],
    ['plain text no lang', ''],
    ['SELECT * FROM users WHERE id = 1', 'sql'],
  ];
  for (const [line, lang] of samples) {
    it(`preserves every character: ${JSON.stringify(line).slice(0, 40)} (${lang || 'none'})`, () => {
      const joined = tokenizeCodeLine(line, lang).map(t => t.text).join('');
      expect(joined).toBe(line);
    });
  }

  it('colours a keyword but leaves identifiers plain', () => {
    const toks = tokenizeCodeLine('const foo = 1', 'js');
    const kw = toks.find(t => t.text === 'const');
    expect(kw?.color).toBe('magenta');
    const id = toks.find(t => t.text.includes('foo'));
    expect(id?.color).toBeUndefined();
  });
});

describe('renderInline', () => {
  it('returns nodes (does not crash) for bold + code', () => {
    const nodes = renderInline('use **bold** and `code` here');
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(1);
  });

  it('handles plain text as a single node', () => {
    const nodes = renderInline('no markup at all');
    expect(nodes.length).toBe(1);
  });
});
