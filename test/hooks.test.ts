import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runHook } from '../src/hooks/executor.js';
import { HooksManager, extractFilePathsFromArgs } from '../src/hooks/manager.js';
import type { HookConfig } from '../src/hooks/types.js';

describe('Hook executor', () => {
  it('captures stdout and returns exit code 0 on success', async () => {
    const r = await runHook(
      { command: 'echo hello-from-hook', name: 'echo' },
      { event: 'PostToolUse', sessionId: 's1', cwd: process.cwd() },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello-from-hook');
    expect(r.timedOut).toBe(false);
  });

  it('captures stderr and non-zero exit', async () => {
    const r = await runHook(
      { command: 'echo nope >&2 && exit 42', name: 'fail' },
      { event: 'PreToolUse', sessionId: 's1', cwd: process.cwd() },
    );
    expect(r.exitCode).toBe(42);
    expect(r.stderr.trim()).toBe('nope');
  });

  it('exposes context as environment variables', async () => {
    // The hook prints env vars; we then verify in stdout
    const r = await runHook(
      { command: 'echo "$QODEX_HOOK_EVENT/$QODEX_TOOL_NAME/$QODEX_SESSION_ID"', name: 'env-probe' },
      {
        event: 'PostToolUse',
        sessionId: 'sess-42',
        cwd: process.cwd(),
        toolName: 'write_file',
        toolArgsJson: '{"path":"x"}',
      },
    );
    expect(r.stdout.trim()).toBe('PostToolUse/write_file/sess-42');
  });

  it('redacts secret-ish values when serialising toolArgsJson into env', async () => {
    const r = await runHook(
      { command: 'echo "$QODEX_TOOL_ARGS_JSON"' },
      {
        event: 'PostToolUse',
        sessionId: 's1',
        cwd: process.cwd(),
        toolName: 'http_request',
        toolArgsJson: JSON.stringify({ url: 'https://api.example/x', api_key: 'sk-supersecret' }),
      },
    );
    expect(r.stdout).not.toContain('sk-supersecret');
    expect(r.stdout).toContain('https://api.example/x');
  });

  it('times out after the configured limit and kills the process', async () => {
    const r = await runHook(
      { command: 'sleep 10', timeout: 1, name: 'slow' },
      { event: 'PostToolUse', sessionId: 's1', cwd: process.cwd() },
    );
    expect(r.timedOut).toBe(true);
    // SIGTERM → exitCode 124 in our mapping
    expect([124, 137, 130]).toContain(r.exitCode);
    expect(r.durationMs).toBeLessThan(4000);
  }, 8000);

  it('exposes QODEX_FILE_PATHS as a space-separated string', async () => {
    const r = await runHook(
      { command: 'echo "$QODEX_FILE_PATHS"' },
      {
        event: 'PostToolUse',
        sessionId: 's1',
        cwd: process.cwd(),
        toolName: 'multi_edit',
        filePaths: ['src/a.ts', 'src/b.ts'],
      },
    );
    expect(r.stdout.trim()).toBe('src/a.ts src/b.ts');
  });
});

describe('extractFilePathsFromArgs', () => {
  it('picks up path / file_path / filename', () => {
    expect(extractFilePathsFromArgs({ path: 'x' })).toEqual(['x']);
    expect(extractFilePathsFromArgs({ file_path: 'y' })).toEqual(['y']);
    expect(extractFilePathsFromArgs({ filename: 'z' })).toEqual(['z']);
  });
  it('picks up arrays from files / paths / file_paths', () => {
    expect(extractFilePathsFromArgs({ files: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(extractFilePathsFromArgs({ paths: ['c'] })).toEqual(['c']);
  });
  it('returns empty for unrelated args', () => {
    expect(extractFilePathsFromArgs({ command: 'ls' })).toEqual([]);
    expect(extractFilePathsFromArgs({})).toEqual([]);
    expect(extractFilePathsFromArgs(null)).toEqual([]);
  });
});

describe('HooksManager — matching', () => {
  it('matches by regex against tool name', () => {
    const hm = new HooksManager({
      PostToolUse: [
        { matcher: 'write_file|edit_file', command: 'echo a' },
        { matcher: '^bash$', command: 'echo b' },
        { command: 'echo always' },
      ],
    });
    expect(hm.matching('PostToolUse', 'write_file')).toHaveLength(2); // first + bare
    expect(hm.matching('PostToolUse', 'bash')).toHaveLength(2);       // second + bare
    expect(hm.matching('PostToolUse', 'ls')).toHaveLength(1);         // bare only
  });

  it('non-tool events return all hooks regardless of matcher', () => {
    const hm = new HooksManager({
      SessionStart: [{ command: 'echo start' }, { matcher: 'ignored', command: 'echo always-runs' }],
    });
    expect(hm.matching('SessionStart')).toHaveLength(2);
  });

  it('falls back to literal substring match when matcher is not a valid regex', () => {
    const hm = new HooksManager({
      PostToolUse: [{ matcher: '[invalid(', command: 'echo x' }],
    });
    // Should not throw, should fall back to .includes()
    expect(hm.matching('PostToolUse', 'tool_with_[invalid(_substring')).toHaveLength(1);
    expect(hm.matching('PostToolUse', 'unrelated')).toHaveLength(0);
  });
});

describe('HooksManager — dispatch semantics', () => {
  it('PreToolUse blocking hook with non-zero exit produces a vetoMessage', async () => {
    const hm = new HooksManager({
      PreToolUse: [{ command: 'echo "do not touch this file" && exit 1', name: 'audit' }],
    });
    const r = await hm.dispatch('PreToolUse', {
      event: 'PreToolUse',
      sessionId: 's1',
      cwd: process.cwd(),
      toolName: 'write_file',
    });
    expect(r.vetoMessage).toBeDefined();
    expect(r.vetoMessage).toContain('do not touch');
  });

  it('PreToolUse with blocking=false does NOT veto even on non-zero exit', async () => {
    const hm = new HooksManager({
      PreToolUse: [{ command: 'exit 5', blocking: false, name: 'soft-warn' }],
    });
    const r = await hm.dispatch('PreToolUse', {
      event: 'PreToolUse',
      sessionId: 's1',
      cwd: process.cwd(),
      toolName: 'bash',
    });
    expect(r.vetoMessage).toBeUndefined();
    expect(r.ranCount).toBe(1);
  });

  it('PostToolUse non-zero exit is informational — no veto', async () => {
    const hm = new HooksManager({
      PostToolUse: [{ command: 'echo lint-warn && exit 1', name: 'linter' }],
    });
    const r = await hm.dispatch('PostToolUse', {
      event: 'PostToolUse',
      sessionId: 's1',
      cwd: process.cwd(),
      toolName: 'write_file',
      toolResult: 'wrote x.ts',
    });
    expect(r.vetoMessage).toBeUndefined();
    expect(r.outputs.join('\n')).toContain('lint-warn');
  });

  it('hooks run sequentially in declaration order', async () => {
    // Create a temp file the hooks will append to in a known order
    const tmp = path.join(os.tmpdir(), `qodex-hook-order-${Date.now()}.txt`);
    await fs.writeFile(tmp, '');
    try {
      const hm = new HooksManager({
        PostToolUse: [
          { command: `echo first >> ${tmp}` },
          { command: `echo second >> ${tmp}` },
          { command: `echo third >> ${tmp}` },
        ],
      });
      await hm.dispatch('PostToolUse', {
        event: 'PostToolUse', sessionId: 's1', cwd: process.cwd(), toolName: 'any',
      });
      const content = await fs.readFile(tmp, 'utf-8');
      expect(content.trim().split('\n')).toEqual(['first', 'second', 'third']);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  });

  it('no-op when no hooks are registered for the event', async () => {
    const hm = new HooksManager({});
    const r = await hm.dispatch('PreToolUse', {
      event: 'PreToolUse', sessionId: 's1', cwd: process.cwd(), toolName: 'write_file',
    });
    expect(r.ranCount).toBe(0);
    expect(r.outputs).toEqual([]);
    expect(r.vetoMessage).toBeUndefined();
  });
});

describe('HooksManager — list', () => {
  it('enumerates registered hooks across all events', () => {
    const hm = new HooksManager({
      PreToolUse: [{ command: 'a' }, { command: 'b' }],
      PostToolUse: [{ command: 'c' }],
      SessionStart: [{ command: 'd' }],
    });
    const list = hm.list();
    expect(list).toHaveLength(4);
    expect(list.map(l => l.event)).toEqual(['PreToolUse', 'PreToolUse', 'PostToolUse', 'SessionStart']);
  });
});
