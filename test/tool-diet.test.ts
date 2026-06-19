import { describe, it, expect } from 'vitest';
import { expandToolPatterns } from '../src/tools/registry.js';

const ALL = [
  'shell', 'read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep',
  'docker_ps', 'docker_logs', 'docker_exec', 'docker_build', 'docker_compose', 'docker_inspect',
  'media_probe', 'media_transform', 's3_sync', 'ci_status', 'network_optimize',
  'browser_open', 'browser_click', 'vision_analyze', 'todo_write',
];

describe('expandToolPatterns (tool diet)', () => {
  it('expands trailing-* prefix patterns', () => {
    expect(expandToolPatterns(['docker_*'], ALL)).toEqual([
      'docker_build', 'docker_compose', 'docker_exec', 'docker_inspect', 'docker_logs', 'docker_ps',
    ]);
  });

  it('mixes prefixes and exact names', () => {
    expect(expandToolPatterns(['media_*', 's3_sync'], ALL)).toEqual([
      'media_probe', 'media_transform', 's3_sync',
    ]);
  });

  it('never blocks core tools, even when named or matched', () => {
    expect(expandToolPatterns(['shell', 'read_file', 'docker_ps'], ALL)).toEqual(['docker_ps']);
    // "s*" matches shell by prefix but core protection strips it
    expect(expandToolPatterns(['s*'], ALL)).toEqual(['s3_sync']);
  });

  it('refuses a bare "*" (would block everything)', () => {
    expect(expandToolPatterns(['*'], ALL)).toEqual([]);
  });

  it('ignores unknown names and empty strings', () => {
    expect(expandToolPatterns(['nonexistent_tool', '', '  '], ALL)).toEqual([]);
  });
});
