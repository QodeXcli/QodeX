import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildDirectoryTree } from '../src/context/tree.js';
import { dedupHistory } from '../src/agent/dedup.js';
import type { Message } from '../src/session/store.js';

describe('buildDirectoryTree — semantic pruning', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-tree-'));
    // Build a project with both UI and backend folders so weighting has something to choose between
    await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'src', 'components'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'src', 'components', 'Header'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'src', 'api'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'src', 'api', 'users'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'src', 'styles'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(tmp, '.git'), { recursive: true });

    await fs.writeFile(path.join(tmp, 'package.json'), '{}');
    await fs.writeFile(path.join(tmp, 'src', 'components', 'Header', 'index.tsx'), '');
    await fs.writeFile(path.join(tmp, 'src', 'components', 'Header', 'styles.css'), '');
    await fs.writeFile(path.join(tmp, 'src', 'api', 'users', 'list.ts'), '');
    await fs.writeFile(path.join(tmp, 'src', 'styles', 'globals.css'), '');
    await fs.writeFile(path.join(tmp, 'node_modules', 'should-be-hidden.js'), '');
    await fs.writeFile(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('always excludes node_modules and .git regardless of hint', async () => {
    const tree = await buildDirectoryTree(tmp);
    expect(tree).not.toContain('node_modules');
    expect(tree).not.toContain('.git/');
  });

  it('with NO hint, expands all folders (legacy behaviour)', async () => {
    const tree = await buildDirectoryTree(tmp);
    expect(tree).toContain('components/');
    expect(tree).toContain('api/');
    expect(tree).toContain('styles/');
    // Without weighting, the marker note shouldn't be added
    expect(tree).not.toContain('tree weighted');
  });

  it('UI-related prompt keeps components/styles deep and SUMMARISES api', async () => {
    const tree = await buildDirectoryTree(tmp, {
      userPromptHint: 'Update the header component styles to use a new theme',
    });
    // components/ should be expanded (we see its child Header/)
    expect(tree).toContain('components/');
    expect(tree).toMatch(/Header\//);
    // api/ should be summarised (one-line item-count, no children)
    expect(tree).toMatch(/api\/\s+\(\d+ item/);
    expect(tree).not.toMatch(/users\//);
    // weighting note appears
    expect(tree).toContain('tree weighted');
  });

  it('backend-related prompt keeps api deep and SUMMARISES components', async () => {
    const tree = await buildDirectoryTree(tmp, {
      userPromptHint: 'Add a new API endpoint to the users handler',
    });
    expect(tree).toMatch(/api\//);
    expect(tree).toMatch(/users\//);
    expect(tree).toMatch(/components\/\s+\(\d+ item/);
  });

  it('still expands "src/" and "lib/" by default — generic source roots', async () => {
    const tree = await buildDirectoryTree(tmp, {
      userPromptHint: 'fix this bug',
    });
    // No specific topic match → no weighting (all expanded)
    expect(tree).not.toContain('tree weighted');
    expect(tree).toContain('src/');
  });

  it('respects maxDepth even when expanding', async () => {
    const tree = await buildDirectoryTree(tmp, { maxDepth: 1 });
    // Top-level should be present
    expect(tree).toContain('src/');
    // But the deep nested `Header/index.tsx` should NOT appear
    expect(tree).not.toContain('index.tsx');
  });

  it('weighting hint with no matching keyword falls back to full tree', async () => {
    const tree = await buildDirectoryTree(tmp, {
      userPromptHint: 'just a random phrase with no specific topic',
    });
    expect(tree).not.toContain('tree weighted');
  });
});

describe('dedupHistory', () => {
  function toolMsg(name: string, content: string, callId = 'c'): Message {
    return { role: 'tool', tool_call_id: callId, content, name } as Message;
  }

  function userMsg(text: string): Message {
    return { role: 'user', content: text };
  }

  function assistantWithCall(name: string, args: string): Message {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c', type: 'function', function: { name, arguments: args } }],
    };
  }

  it('returns input unchanged when no duplicates exist', () => {
    const msgs: Message[] = [
      userMsg('q'),
      assistantWithCall('read_file', '{}'),
      toolMsg('read_file', 'a'.repeat(500)),
    ];
    const r = dedupHistory(msgs);
    expect(r.replaced).toBe(0);
    expect(r.messages).toEqual(msgs);
  });

  it('replaces a duplicate tool result with a back-pointer', () => {
    const big = 'x'.repeat(2000);
    const msgs: Message[] = [
      userMsg('read a.ts'),
      assistantWithCall('read_file', '{}'),
      toolMsg('read_file', big, 'c1'),
      // ... lots of intervening turns ...
      userMsg('q2'), assistantWithCall('bash', '{}'), toolMsg('bash', 'out', 'b1'),
      userMsg('q3'), assistantWithCall('bash', '{}'), toolMsg('bash', 'out2', 'b2'),
      userMsg('q4'), assistantWithCall('bash', '{}'), toolMsg('bash', 'out3', 'b3'),
      // Re-read of a.ts — should become a pointer
      userMsg('read a.ts again'),
      assistantWithCall('read_file', '{}'),
      toolMsg('read_file', big, 'c2'),
      // Then more activity so this isn't in the recent tail. dedupHistory keeps
      // the last keepRecent=4 tool results full, so the re-read must sit beyond
      // the last 4 tool messages to be eligible — add enough trailing bash turns.
      userMsg('q5'), assistantWithCall('bash', '{}'), toolMsg('bash', 'out4', 'b4'),
      userMsg('q6'), assistantWithCall('bash', '{}'), toolMsg('bash', 'out5', 'b5'),
      userMsg('q7'), assistantWithCall('bash', '{}'), toolMsg('bash', 'out6', 'b6'),
      userMsg('q8'), assistantWithCall('bash', '{}'), toolMsg('bash', 'out7', 'b7'),
    ];
    const r = dedupHistory(msgs);
    expect(r.replaced).toBe(1);
    expect(r.bytesSaved).toBeGreaterThan(1500);
    // Find the deduped one
    const deduped = r.messages.filter(m => m.role === 'tool' && (m as any).name === 'read_file');
    expect(deduped).toHaveLength(2);
    // First kept full, second replaced
    expect(deduped[0]!.content!.length).toBeGreaterThan(1500);
    expect(deduped[1]!.content).toMatch(/\[DEDUP\]/);
    expect(deduped[1]!.content).toContain('sha=');
  });

  it('NEVER dedups bash results (state may have changed)', () => {
    const out = 'directory contents\n'.repeat(50); // ~1KB
    const msgs: Message[] = [
      userMsg('ls 1'), assistantWithCall('bash', '{}'), toolMsg('bash', out, 'b1'),
      userMsg('q1'), assistantWithCall('read_file', '{}'), toolMsg('read_file', 'a'.repeat(50), 'r1'),
      userMsg('q2'), assistantWithCall('read_file', '{}'), toolMsg('read_file', 'b'.repeat(50), 'r2'),
      userMsg('q3'), assistantWithCall('read_file', '{}'), toolMsg('read_file', 'c'.repeat(50), 'r3'),
      userMsg('ls 2'), assistantWithCall('bash', '{}'), toolMsg('bash', out, 'b2'),
      userMsg('q4'), assistantWithCall('read_file', '{}'), toolMsg('read_file', 'd'.repeat(50), 'r4'),
    ];
    const r = dedupHistory(msgs);
    expect(r.replaced).toBe(0);
  });

  it('keeps the most recent tool results intact even when duplicated', () => {
    const big = 'x'.repeat(2000);
    const msgs: Message[] = [
      // 4 read_file results, all with the SAME content, no intervening turns to push them out of "recent" tail
      userMsg('q1'), assistantWithCall('read_file', '{}'), toolMsg('read_file', big, 'c1'),
      userMsg('q2'), assistantWithCall('read_file', '{}'), toolMsg('read_file', big, 'c2'),
      userMsg('q3'), assistantWithCall('read_file', '{}'), toolMsg('read_file', big, 'c3'),
      userMsg('q4'), assistantWithCall('read_file', '{}'), toolMsg('read_file', big, 'c4'),
    ];
    // keepRecent default 4 → none should be replaced
    const r = dedupHistory(msgs);
    expect(r.replaced).toBe(0);
  });

  it('skips content under minBytes threshold', () => {
    const tiny = 'small'; // 5 bytes
    const msgs: Message[] = [
      userMsg('q1'), assistantWithCall('read_file', '{}'), toolMsg('read_file', tiny, 'c1'),
      userMsg('q2'), assistantWithCall('bash', '{}'), toolMsg('bash', 'noise', 'b1'),
      userMsg('q3'), assistantWithCall('bash', '{}'), toolMsg('bash', 'noise2', 'b2'),
      userMsg('q4'), assistantWithCall('bash', '{}'), toolMsg('bash', 'noise3', 'b3'),
      userMsg('q5'), assistantWithCall('bash', '{}'), toolMsg('bash', 'noise4', 'b4'),
      userMsg('q6'), assistantWithCall('read_file', '{}'), toolMsg('read_file', tiny, 'c2'),
    ];
    const r = dedupHistory(msgs);
    // Below minBytes — no dedup despite duplicate
    expect(r.replaced).toBe(0);
  });

  it('is pure — does not mutate the input array', () => {
    const big = 'x'.repeat(2000);
    const msgs: Message[] = [
      userMsg('q1'), assistantWithCall('read_file', '{}'), toolMsg('read_file', big, 'c1'),
      userMsg('q2'), assistantWithCall('bash', '{}'), toolMsg('bash', 'a', 'b1'),
      userMsg('q3'), assistantWithCall('bash', '{}'), toolMsg('bash', 'b', 'b2'),
      userMsg('q4'), assistantWithCall('bash', '{}'), toolMsg('bash', 'c', 'b3'),
      userMsg('q5'), assistantWithCall('bash', '{}'), toolMsg('bash', 'd', 'b4'),
      userMsg('q6'), assistantWithCall('read_file', '{}'), toolMsg('read_file', big, 'c2'),
    ];
    const before = JSON.stringify(msgs);
    dedupHistory(msgs);
    expect(JSON.stringify(msgs)).toBe(before);
  });
});
