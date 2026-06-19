import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { diagnoseDevEnv } from '../src/tools/browser/dev-server.js';

let broken: string;
let healthy: string;

beforeEach(() => {
  broken = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-broken-'));
  healthy = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-healthy-'));
  // Broken: node_modules with only the 2 stray packages we saw in the real log, no .bin.
  fs.mkdirSync(path.join(broken, 'node_modules', 'nanoid'), { recursive: true });
  fs.mkdirSync(path.join(broken, 'node_modules', 'resolve'), { recursive: true });
  // Healthy: populated node_modules with a .bin dir.
  fs.mkdirSync(path.join(healthy, 'node_modules', '.bin'), { recursive: true });
  for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(healthy, 'node_modules', `pkg${i}`), { recursive: true });
});

afterEach(() => {
  fs.rmSync(broken, { recursive: true, force: true });
  fs.rmSync(healthy, { recursive: true, force: true });
});

describe('diagnoseDevEnv', () => {
  it('flags a broken install when the output shows a missing binary', () => {
    const d = diagnoseDevEnv(broken, 'sh: vite: command not found');
    expect(d).toContain('[ENV_DEPS_BROKEN]');
    expect(d).toContain('npm install');
  });

  it('also catches the UNRESOLVED_IMPORT variant', () => {
    expect(diagnoseDevEnv(broken, '[UNRESOLVED_IMPORT] Could not resolve vite')).toContain('[ENV_DEPS_BROKEN]');
  });

  it('does NOT cry wolf when output has no not-found signal', () => {
    expect(diagnoseDevEnv(broken, 'VITE ready in 312 ms')).toBeNull();
  });

  it('does NOT blame deps when node_modules is healthy', () => {
    expect(diagnoseDevEnv(healthy, 'sh: vite: command not found')).toBeNull();
  });

  it('flags a totally missing node_modules', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-empty-'));
    try {
      expect(diagnoseDevEnv(empty, 'code 127')).toContain('does not exist');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
