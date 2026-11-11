import { describe, it, expect } from 'vitest';
import { createServer } from 'net';
import { buildSshArgs } from '../src/tools/remote/ssh.js';
import { buildTelnetSteps, consumeTelnet, runTelnetSession } from '../src/tools/remote/telnet.js';
import { classifyAsk } from '../src/desk/sentinel.js';

describe('ssh argv', () => {
  it('puts the command last, keeps host checking, and never embeds a password', () => {
    const ok = buildSshArgs({
      host: 'router.local', user: 'admin', port: 2222, command: 'uname -a',
      askpass: false, connectTimeoutSec: 10,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.args).toContain('BatchMode=yes');
    expect(ok.args[ok.args.length - 1]).toBe('uname -a');
    expect(ok.args).toContain('admin@router.local');
    expect(ok.args.join(' ')).not.toContain('StrictHostKeyChecking=no');

    const keyed = buildSshArgs({
      host: '10.0.0.2', command: 'uptime', askpass: true, connectTimeoutSec: 5, identityFile: '/tmp/id',
    });
    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;
    expect(keyed.args).not.toContain('BatchMode=yes');
    expect(keyed.args).toContain('/tmp/id');
    expect(keyed.args.join(' ')).not.toContain('s3cret');

    expect(buildSshArgs({
      host: '-oProxyCommand=x', command: 'id', askpass: false, connectTimeoutSec: 5,
    }).ok).toBe(false);
    expect(buildSshArgs({
      host: '::1', user: 'me', command: 'id', askpass: false, connectTimeoutSec: 5,
    }).ok && true).toBe(true);
  });
});

describe('telnet client', () => {
  it('refuses an option and strips it from the text', () => {
    const eaten = consumeTelnet(Buffer.from([255, 253, 1, 65]));
    expect(eaten.text).toBe('A');
    expect([...eaten.reply]).toEqual([255, 252, 1]);
  });

  it('talks to a local device and does not echo the secret', async () => {
    const steps = buildTelnetSteps(['show ver'], 's3cret', 0);
    expect(steps[0]).toEqual({ text: 's3cret', secret: true });
    const server = createServer(sock => {
      sock.write(Buffer.from([255, 253, 1]));
      sock.write('Password: ');
      let got = Buffer.alloc(0);
      sock.on('data', d => {
        got = Buffer.concat([got, d]);
        if (got.includes('show ver')) {
          sock.write('version 1 s3cret echo\n');
          sock.end();
        }
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const result = await runTelnetSession({
        host: '127.0.0.1', port, timeoutMs: 4000, steps, secret: 's3cret',
      });
      expect(result.text).toContain('[secret sent]');
      expect(result.text).toContain('version 1');
      expect(result.text).not.toContain('s3cret');
      expect(result.text).toContain('[redacted]');
    } finally {
      await new Promise(r => server.close(() => r(undefined)));
    }
  });
});

describe('sentinel sees a remote call', () => {
  it('labels ssh as remote, and still labels a remote rm -rf as irreversible', () => {
    expect(classifyAsk('ssh leaves this machine: admin@router uname -a').kind).toBe('remote');
    expect(classifyAsk('ssh leaves this machine: router rm -rf /').kind).toBe('delete');
  });
});
