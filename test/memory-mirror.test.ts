import { describe, it, expect } from 'vitest';
import { serializeMemory, parseMemory, memoryPaths } from '../src/context/memory-mirror.ts';
import { SessionStore } from '../src/session/store.ts';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('memory markdown mirror', () => {
  it('serializes facts as a titled, commented bullet list', () => {
    const md = serializeMemory(['build is `npm run build:prod`', 'auth lives in src/auth'], 'my-project');
    expect(md).toContain('# QodeX memory — my-project');
    expect(md).toContain('mirrored from ~/.qodex/sessions.db'); // the round-trip hint comment
    expect(md).toContain('- build is `npm run build:prod`');
    expect(md).toContain('- auth lives in src/auth');
  });

  it('renders a placeholder when there are no facts', () => {
    expect(serializeMemory([], 'empty')).toContain('_(none yet)_');
  });

  it('parses bullets and ignores the header, comment, blanks and the placeholder', () => {
    const md = [
      '# QodeX memory — x',
      '<!-- mirrored from ~/.qodex/sessions.db … -->',
      '',
      '- first fact',
      '* second fact (asterisk bullet)',
      '_(none yet)_',
      '   - indented third',
    ].join('\n');
    expect(parseMemory(md)).toEqual(['first fact', 'second fact (asterisk bullet)', 'indented third']);
  });

  it('round-trips: parse(serialize(facts)) === facts (newlines folded)', () => {
    const facts = ['one', 'two with `code`', 'three — em dash', 'a\nmultiline\nfact'];
    const got = parseMemory(serializeMemory(facts, 't'));
    expect(got).toEqual(['one', 'two with `code`', 'three — em dash', 'a multiline fact']);
  });

  it('places user memory under ~/.qodex and project memory under <cwd>/.qodex', () => {
    const p = memoryPaths('/work/proj');
    expect(p.user).toMatch(/\.qodex\/memory\.md$/);
    expect(p.project).toBe('/work/proj/.qodex/MEMORY.md');
  });

  // End-to-end of the SAME operations export/import run (store + serialize/parse + fs), against a
  // TEMP store + dir so it never touches the real ~/.qodex.
  it('round-trips DB → MEMORY.md → hand-edit → import (additive) on a temp store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-'));
    try {
      const store = new SessionStore(path.join(dir, 's.db'));
      store.addFact('s1', dir, 'build is `npm run build:prod`', 'project');

      // DB → MD
      const file = path.join(dir, 'MEMORY.md');
      await fs.writeFile(file, serializeMemory(store.getFactsByScope('project', dir, 100), 'proj'));
      expect(await fs.readFile(file, 'utf8')).toContain('- build is `npm run build:prod`');

      // a human edits the file: adds a fact
      await fs.appendFile(file, '- the API key is in .env under SVC_KEY\n');

      // MD → DB (additive import)
      const inDb = new Set(store.getFactsByScope('project', dir, 100));
      let added = 0;
      for (const fact of parseMemory(await fs.readFile(file, 'utf8'))) {
        if (!inDb.has(fact)) { store.addFact('import', dir, fact, 'project'); added++; }
      }
      expect(added).toBe(1);
      const final = store.getFactsByScope('project', dir, 100);
      expect(final).toContain('the API key is in .env under SVC_KEY');
      expect(final).toContain('build is `npm run build:prod`');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
