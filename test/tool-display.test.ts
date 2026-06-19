import { describe, it, expect } from 'vitest';
import { describeToolActivity, extractTarget, formatTarget } from '../src/cli/prompts/tool-display.js';

describe('describeToolActivity — exact matches', () => {
  it('maps core tools to friendly verbs + colours', () => {
    expect(describeToolActivity('read_file').verb).toBe('Reading');
    expect(describeToolActivity('write_file').verb).toBe('Writing');
    expect(describeToolActivity('edit_symbol').verb).toBe('Refactoring');
    expect(describeToolActivity('bash').verb).toBe('Running');
    expect(describeToolActivity('diagnostics').verb).toBe('Type-checking');
    expect(describeToolActivity('semantic_search').verb).toBe('Recalling');
    expect(describeToolActivity('vision_analyze').verb).toBe('Looking');
    expect(describeToolActivity('task').verb).toBe('Delegating');
  });
  it('every activity carries a hex colour and a single icon', () => {
    for (const name of ['read_file', 'grep', 'git_commit', 'browser_navigate', 'diagnostics']) {
      const a = describeToolActivity(name);
      expect(a.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(a.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('describeToolActivity — prefix families', () => {
  it('handles code_graph_*, git_*, browser_*, dev_server*, background_job*', () => {
    expect(describeToolActivity('code_graph_find_callers').category).toBe('search');
    expect(describeToolActivity('git_status').verb).toBe('Git');
    expect(describeToolActivity('browser_click').verb).toBe('Browsing');
    expect(describeToolActivity('dev_server_start').verb).toBe('Dev server');
    expect(describeToolActivity('background_job_start').category).toBe('background');
  });
  it('falls back to a sensible default for unknown tools', () => {
    const a = describeToolActivity('totally_made_up_tool');
    expect(a.verb).toBe('Working');
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('extractTarget', () => {
  it('pulls a closed path/query/command value', () => {
    expect(extractTarget('{"file_path":"src/app.ts"}')).toBe('src/app.ts');
    expect(extractTarget('{"query":"order cancellation"}')).toBe('order cancellation');
    expect(extractTarget('{"command":"npm test"}')).toBe('npm test');
  });
  it('recovers a value from a stream cut mid-string', () => {
    expect(extractTarget('{"file_path":"src/components/Heade')).toBe('src/components/Heade');
  });
  it('prefers the first meaningful key', () => {
    expect(extractTarget('{"path":"a.ts","id":"x"}')).toBe('a.ts');
  });
  it('unescapes common JSON escapes', () => {
    expect(extractTarget('{"command":"echo \\"hi\\""}')).toBe('echo "hi"');
  });
  it('returns null when nothing useful is present', () => {
    expect(extractTarget('')).toBeNull();
    expect(extractTarget('{"recursive":true}')).toBeNull();
  });
});

describe('formatTarget', () => {
  it('leaves short targets untouched', () => {
    expect(formatTarget('src/app.ts')).toBe('src/app.ts');
  });
  it('collapses whitespace', () => {
    expect(formatTarget('foo   bar\tbaz')).toBe('foo bar baz');
  });
  it('middle-truncates long targets to the max', () => {
    const long = 'src/very/deeply/nested/directory/structure/with/a/long/file/name.tsx';
    const out = formatTarget(long, 30);
    expect(out.length).toBe(30);
    expect(out).toContain('…');
    expect(out.startsWith('src/')).toBe(true);
    expect(out.endsWith('.tsx')).toBe(true);
  });
});
