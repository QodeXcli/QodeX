import { describe, it, expect } from 'vitest';
import { instructionFileHit, instructionFileReason } from '../src/security/instruction-files.js';

const cwd = '/work/app';
const home = '/home/u';

describe('agent instruction files', () => {
  it('project instruction files and dirs', () => {
    for (const p of ['QODEX.md', 'AGENTS.md', 'claude.md', '.cursorrules', '.qodex/config.yaml', '.qodex/skills/x/SKILL.md', '.cursor/rules/a.mdc', '.github/copilot-instructions.md', '/work/app/AGENTS.md']) {
      expect(instructionFileHit(p, cwd, home), p).toMatchObject({ scope: 'project' });
    }
  });

  it('user-level skills, rules, hooks and memory', () => {
    expect(instructionFileHit('~/.qodex/skills/deploy/SKILL.md', cwd, home)).toEqual({ label: '~/.qodex/skills/deploy/SKILL.md', scope: 'user' });
    expect(instructionFileHit('/home/u/.qodex/QODEX.md', cwd, home)).toMatchObject({ scope: 'user' });
    expect(instructionFileHit('/home/u/.qodex/memory/facts.json', cwd, home)).toMatchObject({ scope: 'user' });
  });

  it('ordinary project files and other QodeX state are not instruction files', () => {
    for (const p of ['src/agents.ts', 'docs/AGENTS.md', 'README.md', 'src/claude.md.ts', '../other/AGENTS.md']) {
      expect(instructionFileHit(p, cwd, home), p).toBeNull();
    }
    expect(instructionFileHit('/home/u/.qodex/sessions.db', cwd, home)).toBeNull();
    expect(instructionFileHit('/home/u/.qodex/browser/profiles/default/x', cwd, home)).toBeNull();
  });

  it('explains why it asks', () => {
    expect(instructionFileReason({ label: 'AGENTS.md', scope: 'project' })).toMatch(/standing instructions/);
  });
});
