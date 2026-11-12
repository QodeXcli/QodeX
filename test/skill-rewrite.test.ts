import { describe, it, expect } from 'vitest';
import { assembleRewrite, parseRewriteDraft, splitWitness } from '../src/skills/learning/rewrite.js';

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
