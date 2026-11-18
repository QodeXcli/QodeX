import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { hangupPolicy, residentChildArgs, spawnResident } from '../src/resident/detach.js';
import { reachSummary, recordReach, readPresence } from '../src/resident/presence.js';
import { serviceFile, servicePlatform } from '../src/resident/service.js';

describe('resident detach', () => {
  it('drops --detach and ignores hangup only in the child', () => {
    expect(residentChildArgs(['up', '--detach', '--no-bots'])).toEqual(['up', '--no-bots']);
    expect(hangupPolicy({ QODEX_RESIDENT_DETACHED: '1' })).toBe('ignore');
    expect(hangupPolicy({})).toBe('default');
  });

  it('spawns a detached process and does not keep the parent alive', () => {
    let seen: { detached?: boolean; env?: NodeJS.ProcessEnv; cmd: string } | null = null;
    const pid = spawnResident({
      args: ['up', '--no-bots'],
      logPath: '/tmp/qodex-resident-test.log',
      execPath: '/usr/bin/node',
      script: '/usr/bin/qodex',
      spawnFn: (cmd, args, options) => {
        seen = { detached: options.detached, env: options.env, cmd: [cmd, ...args].join(' ') };
        return { pid: 4242, unref() {} };
      },
    });
    expect(pid).toBe(4242);
    expect(seen!.detached).toBe(true);
    expect(seen!.env?.QODEX_RESIDENT_DETACHED).toBe('1');
    expect(seen!.cmd).toContain('qodex up --no-bots');
  });

  it('remembers the last reach without keeping a bearer token', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qodex-presence-'));
    const prev = process.env.HOME;
    process.env.HOME = dir;
    try {
      expect(reachSummary('use Bearer abc.def now')).toBe('use Bearer [omitted] now');
      await recordReach({ project: '/work', channel: 'telegram:9', text: 'ship the patch', at: '2026-11-18T00:00:00.000Z' });
      const p = await readPresence();
      expect(p?.channel).toBe('telegram:9');
      expect(p?.summary).toBe('ship the patch');
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes a user service and refuses to pretend there is a cloud', () => {
    const linux = serviceFile('linux', '/home/a', '/usr/bin/qodex');
    expect(linux?.body).toContain('ExecStart=/usr/bin/qodex up');
    expect(linux?.body).toContain('Restart=on-failure');
    expect(linux?.body).not.toMatch(/https?:\/\//);
    const mac = serviceFile('darwin', '/Users/a', '/usr/bin/qodex');
    expect(mac?.body).toContain('<string>up</string>');
    expect(servicePlatform('win32')).toBe('unsupported');
    expect(serviceFile('unsupported', '/x', '/qodex')).toBeNull();
  });
});
