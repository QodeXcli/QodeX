import { describe, it, expect } from 'vitest';
import { deriveAutoDisabledTools, ratchetAutoDisabled, type InfraSignals } from '../src/agent/tool-profile.js';

const ALL = [
  'shell', 'read_file', 'docker_ps', 'docker_logs', 'docker_exec', 'docker_build',
  'docker_compose', 'docker_inspect', 'media_probe', 'media_transform', 's3_sync',
  'ci_status', 'network_optimize', 'openapi_digest', 'backend_routemap',
  'browser_open', 'todo_write',
];
const NO_INFRA: InfraSignals = {
  hasDocker: false, hasCi: false, hasOpenApi: false,
  hasMediaDeps: false, hasBackendDeps: false, hasCloudConfig: false,
};

describe('deriveAutoDisabledTools', () => {
  it('disables all 13 infra tools on a pure frontend project with an unrelated task', () => {
    const d = deriveAutoDisabledTools(NO_INFRA, 'قسمت هیرو ریسپانسیو نیست درستش کن', ALL);
    expect(d).toHaveLength(13);
    expect(d).not.toContain('browser_open'); // browser group is not managed
    expect(d).not.toContain('shell');
  });

  it('keeps the docker group when the prompt asks for docker, even with no Dockerfile', () => {
    const d = deriveAutoDisabledTools(NO_INFRA, 'این اپ رو dockerize کن', ALL);
    expect(d.some(n => n.startsWith('docker_'))).toBe(false);
  });

  it('keeps the docker group when a Dockerfile exists', () => {
    const d = deriveAutoDisabledTools({ ...NO_INFRA, hasDocker: true }, 'fix the css', ALL);
    expect(d.some(n => n.startsWith('docker_'))).toBe(false);
  });

  it('keeps media tools on a Persian video prompt', () => {
    const d = deriveAutoDisabledTools(NO_INFRA, 'این ویدیو رو برای تبلیغ آماده کن', ALL);
    expect(d.some(n => n.startsWith('media_'))).toBe(false);
  });
});

describe('ratchetAutoDisabled', () => {
  it('re-enables a group when a later prompt mentions it', () => {
    const initial = deriveAutoDisabledTools(NO_INFRA, 'fix the css', ALL);
    const after = ratchetAutoDisabled(initial, 'حالا برای این پروژه Dockerfile و compose بساز');
    expect(after.some(n => n.startsWith('docker_'))).toBe(false);
    expect(after).toContain('media_probe'); // unrelated groups stay disabled
  });

  it('changes nothing on an unrelated prompt (stable tool list = stable cache)', () => {
    const initial = deriveAutoDisabledTools(NO_INFRA, 'fix the css', ALL);
    expect(ratchetAutoDisabled(initial, 'یه سوال ساده')).toEqual(initial);
  });

  it('is a no-op on an empty set', () => {
    expect(ratchetAutoDisabled([], 'anything docker')).toEqual([]);
  });
});
