import { describe, it, expect } from 'vitest';
import { buildTunnelArgs } from '../src/cli/ssh-tunnel.ts';

describe('buildTunnelArgs', () => {
  it('builds a no-shell local forward with keepalive', () => {
    expect(buildTunnelArgs({ host: 'workstation', localPort: 11434, remotePort: 11434 })).toEqual([
      '-N', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes',
      '-L', '11434:localhost:11434', 'workstation',
    ]);
  });
  it('includes user, custom port, and identity file when given', () => {
    const a = buildTunnelArgs({ host: 'h', user: 'me', port: 2222, localPort: 1234, remotePort: 11434, identityFile: '~/.ssh/id' });
    expect(a).toContain('me@h');
    expect(a.join(' ')).toContain('-p 2222');
    expect(a.join(' ')).toContain('-i ~/.ssh/id');
    expect(a.join(' ')).toContain('-L 1234:localhost:11434');
  });
  it('maps distinct local/remote ports', () => {
    expect(buildTunnelArgs({ host: 'h', localPort: 8080, remotePort: 1234 }).join(' ')).toContain('-L 8080:localhost:1234');
  });
});
