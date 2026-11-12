import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { assembleRewrite, parseRewriteDraft, rewriteSkillText, splitWitness } from '../src/skills/learning/rewrite.js';

const original = `---
name: fix-parser
description: Old description that is long enough.
provenance: machine
status: candidate
confidence: 70
allowed-tools:
  - read_file
  - shell
captured-at: 2026-01-01T00:00:00.000Z
---

# fix-parser

Read the parser, then run the tests. This sentence exists so the original body is long enough to compare.

## Tools this procedure used
- \`read_file\`
- \`shell\`

## Witness patch

\`\`\`diff
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -1 +1 @@
-old
+new
\`\`\`
`;

describe('skill rewrite gate', () => {
  it('rejects a model answer that is not the required shape', () => {
    expect(parseRewriteDraft('sure, here you go')).toEqual({ error: 'model did not return DESCRIPTION and BODY' });
    expect('error' in parseRewriteDraft('DESCRIPTION: hi\nBODY:\n' + 'x'.repeat(80))).toBe(true);
  });

  it('keeps the name, the tools, the candidate status, and the witness bytes', () => {
    const draft = parseRewriteDraft(
      'DESCRIPTION: Read the parser before changing it, then run the tests.\nBODY:\n# fix-parser\n\nRead the parser with the existing files. Then run the tests that already cover it. Do not add a new command.\n',
    );
    expect('body' in draft).toBe(true);
    if (!('body' in draft)) return;
    const built = assembleRewrite({
      name: 'fix-parser',
      original,
      description: draft.description,
      body: draft.body + '\n## Witness patch\n\nmodel tried to replace the diff\n',
      model: 'local:qwen',
      nowIso: '2026-11-12T00:00:00.000Z',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.skillMd).toContain('name: fix-parser');
    expect(built.skillMd).toContain('status: candidate');
    expect(built.skillMd).toContain('provenance: machine');
    expect(built.skillMd).toContain('  - read_file');
    expect(built.skillMd).toContain('  - shell');
    expect(built.skillMd).not.toContain('model tried to replace the diff');
    expect(built.skillMd).toContain(splitWitness(original).witness.trim());
    expect(built.skillMd).toContain('rewritten-by: "local:qwen"');
  });

  it('refuses a rewrite that tries to mark itself active', () => {
    const parsed = parseRewriteDraft('DESCRIPTION: A clear trigger for this procedure.\nBODY:\n' + 'step '.repeat(30) + '\nstatus: active\n');
    expect(parsed).toEqual({ error: 'rewrite tried to change provenance or status' });
  });
});

const active = `---
name: fix-parser
description: Old description that is long enough.
provenance: user
status: active
allowed-tools:
  - read_file
captured-at: 2026-01-01T00:00:00.000Z
---

# fix-parser

Read the parser, then run the tests. This sentence exists so the original body is long enough to compare.

## Witness patch

\`\`\`diff
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -1 +1 @@
-old
+new
\`\`\`
`;

const goodDraft = 'DESCRIPTION: Read the parser before changing it, then run the tests.\nBODY:\n# fix-parser\n\nRead the parser with the files already in the tree. Then run the tests that already cover it.\n';

describe('rewriteSkillText on disk', () => {
  let home: string;
  let cwd: string;
  let prev: string | undefined;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'qodex-rewrite-'));
    cwd = path.join(home, 'proj');
    await mkdir(path.join(cwd, '.qodex', 'skills', 'fix-parser'), { recursive: true });
    await writeFile(path.join(cwd, '.qodex', 'skills', 'fix-parser', 'SKILL.md'), active);
    prev = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  const activePath = () => path.join(cwd, '.qodex', 'skills', 'fix-parser', 'SKILL.md');
  const candidatePath = () => path.join(home, '.qodex', 'skills-candidates', 'fix-parser', 'SKILL.md');

  it('writes a candidate and does not touch the active skill', async () => {
    const res = await rewriteSkillText({
      name: 'fix-parser',
      cwd,
      nowIso: '2026-11-12T00:00:00.000Z',
      complete: async () => ({ text: goodDraft, model: 'local:qwen' }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.file).toBe(candidatePath());
    expect(await readFile(activePath(), 'utf-8')).toBe(active);
    const candidate = await readFile(candidatePath(), 'utf-8');
    expect(candidate).toContain('status: candidate');
    expect(candidate).toContain('provenance: machine');
    expect(candidate).toContain('rewritten-by: "local:qwen"');
    expect(candidate).toContain('+new');
    expect(candidate).not.toContain('status: active');
    const ledger = await readFile(path.join(home, '.qodex', 'learning-events.jsonl'), 'utf-8');
    expect(ledger).toContain('"event":"rewrite"');
  });

  it('a bad model answer writes nothing', async () => {
    const missing = await rewriteSkillText({
      name: 'no-such-skill',
      cwd,
      complete: async () => ({ text: goodDraft, model: 'local:qwen' }),
    });
    expect(missing.ok).toBe(false);
    const emptyModel = await rewriteSkillText({
      name: 'fix-parser',
      cwd,
      complete: async () => ({ text: goodDraft, model: ' ' }),
    });
    expect(emptyModel.ok).toBe(false);
    const bad = await rewriteSkillText({
      name: 'fix-parser',
      cwd,
      complete: async () => ({ text: 'sure', model: 'local:qwen' }),
    });
    expect(bad.ok).toBe(false);
    await expect(stat(candidatePath())).rejects.toThrow();
    expect(await readFile(activePath(), 'utf-8')).toBe(active);
  });

  it('a later bad answer does not replace a candidate that already passed the gate', async () => {
    const first = await rewriteSkillText({
      name: 'fix-parser',
      cwd,
      nowIso: '2026-11-12T00:00:00.000Z',
      complete: async () => ({ text: goodDraft, model: 'local:qwen' }),
    });
    expect(first.ok).toBe(true);
    const before = await readFile(candidatePath(), 'utf-8');
    const second = await rewriteSkillText({
      name: 'fix-parser',
      cwd,
      complete: async () => ({ text: 'DESCRIPTION: too short\nBODY:\nno', model: 'local:qwen' }),
    });
    expect(second.ok).toBe(false);
    expect(await readFile(candidatePath(), 'utf-8')).toBe(before);
    expect(await readFile(activePath(), 'utf-8')).toBe(active);
  });
});
