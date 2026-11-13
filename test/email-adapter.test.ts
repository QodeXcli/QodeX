import { describe, it, expect } from 'vitest';
import { connect as netConnect, createServer, type Server, type Socket } from 'net';
import { EmailTransport } from '../src/bot/adapters/email.js';
import { buildSmtpData, decodeQuotedPrintable, mailEndpoint, parseAddress, parseRfc5322 } from '../src/bot/email/parse.js';
import { imapPoll, smtpSend } from '../src/bot/email/wire.js';
import { isAuthorized } from '../src/bot/auth.js';
import { parseDeliveryTarget } from '../src/schedule/delivery.js';

function listen(handler: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

function localSocket(port: number): () => Promise<Socket> {
  return () => new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.pause();
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

describe('mail parsing', () => {
  it('rejects a public cleartext server and a broken address', () => {
    expect(mailEndpoint('imap.example.com', 143, false)).toBeNull();
    expect(mailEndpoint('127.0.0.1', 143, false)).toEqual({ host: '127.0.0.1', port: 143, secure: false });
    expect(mailEndpoint('imap.example.com', 993)).toEqual({ host: 'imap.example.com', port: 993, secure: true });
    expect(parseAddress('Ann <Ann@Ex.com>')).toBe('ann@ex.com');
    expect(parseAddress('Ann <ann@ex.com>\r\nBcc: x@y.z')).toBeNull();
    expect(decodeQuotedPrintable('caf=C3=A9=')).toBe('café=');
  });

  it('reads the plain part of a multipart letter and stuffs SMTP dots', () => {
    const raw = [
      'From: Ann <Ann@Ex.com>',
      'Subject: Hi',
      'Message-ID: <m1@ex.com>',
      'Content-Type: multipart/alternative; boundary=b',
      '',
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'hello=20there',
      '--b',
      'Content-Type: text/html',
      '',
      '<p>no</p>',
      '--b--',
      '',
    ].join('\r\n');
    expect(parseRfc5322(raw)).toEqual({ from: 'ann@ex.com', subject: 'Hi', messageId: '<m1@ex.com>', text: 'hello there' });
    const htmlOnly = 'From: a@b.co\r\nSubject: S\r\nContent-Type: text/html\r\n\r\n<p>Hello<br>there</p>';
    expect(parseRfc5322(htmlOnly)?.text).toBe('Hello\nthere');
    expect(buildSmtpData({
      from: 'me@ex.com', to: 'ann@ex.com', subject: 'Re: Hi', text: '.secret\nline', messageId: '<a@ex.com>', inReplyTo: '<m1@ex.com>',
    })).toContain('..secret');
    expect(isAuthorized('email', 'Ann@Ex.com', { email: { allowedUsers: ['ann@ex.com'] } })).toBe(true);
    expect(isAuthorized('email', 'ann@ex.com', {})).toBe(false);
    expect(parseDeliveryTarget('email:Ann@Ex.com')).toEqual({ platform: 'email', chatId: 'ann@ex.com' });
    expect(parseDeliveryTarget('email:not-an-email')).toBeNull();
  });
});

describe('imap and smtp on localhost', () => {
  it('skips the mailbox on the first poll, then fetches only the new uid', async () => {
    const stored: number[] = [];
    const { server, port } = await listen(socket => {
      socket.write('* OK ready\r\n');
      let buf = '';
      let authTag = '';
      let awaitingAuth = false;
      socket.on('data', chunk => {
        buf += chunk.toString('utf8');
        for (;;) {
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (awaitingAuth) {
            awaitingAuth = false;
            const decoded = Buffer.from(line, 'base64').toString('utf8');
            socket.write(decoded === '\u0000me@ex.com\u0000secret' ? `${authTag} OK\r\n` : `${authTag} NO\r\n`);
            continue;
          }
          const tag = line.split(' ')[0] ?? 'A';
          if (line.includes('AUTHENTICATE PLAIN')) {
            awaitingAuth = true;
            authTag = tag;
            socket.write('+\r\n');
          } else if (line.includes('SELECT')) {
            socket.write(`* OK [UIDNEXT 10] Predicted\r\n${tag} OK selected\r\n`);
          } else if (line.includes('UID SEARCH')) {
            socket.write(`* SEARCH 4 12\r\n${tag} OK\r\n`);
          } else if (line.includes('UID FETCH 12')) {
            const msg = 'From: Ann <Ann@Ex.com>\r\nSubject: Hi\r\nMessage-ID: <m1@ex.com>\r\n\r\nhello there\r\n';
            socket.write(`* 1 FETCH (UID 12 BODY[] {${Buffer.byteLength(msg)}}\r\n${msg})\r\n${tag} OK\r\n`);
          } else if (line.includes('UID STORE')) {
            stored.push(Number(line.match(/UID STORE (\d+)/)?.[1]));
            socket.write(`${tag} OK\r\n`);
          } else if (line.includes('LOGOUT')) {
            socket.write(`${tag} OK bye\r\n`);
          } else {
            socket.write(`${tag} BAD ${line}\r\n`);
          }
        }
      });
    });
    const box = { host: '127.0.0.1', port, secure: false, user: 'me@ex.com', password: 'secret', socketFactory: localSocket(port) };
    try {
      const first = await imapPoll(box, 0, false);
      expect(first.messages).toEqual([]);
      expect(first.cursor).toBe(9);
      const second = await imapPoll(box, first.cursor, true);
      expect(second.messages.map(m => m.text)).toEqual(['hello there']);
      expect(second.messages[0]!.from).toBe('ann@ex.com');
      expect(stored).toEqual([12]);
    } finally {
      server.close();
    }
  });

  it('sends one SMTP letter and dot-stuffs the body', async () => {
    let data = '';
    const { server, port } = await listen(socket => {
      socket.write('220 ready\r\n');
      let buf = '';
      let mode: 'cmd' | 'data' = 'cmd';
      socket.on('data', chunk => {
        buf += chunk.toString('utf8');
        if (mode === 'data') {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data = buf.slice(0, end);
          buf = '';
          mode = 'cmd';
          socket.write('250 accepted\r\n');
          return;
        }
        for (;;) {
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (line.startsWith('EHLO')) socket.write('250-hi\r\n250 AUTH PLAIN\r\n');
          else if (line.startsWith('AUTH PLAIN')) socket.write('235 ok\r\n');
          else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 ok\r\n');
          else if (line === 'DATA') { mode = 'data'; socket.write('354 go\r\n'); }
          else if (line === 'QUIT') socket.write('221 bye\r\n');
          else socket.write('250 ok\r\n');
        }
      });
    });
    try {
      await smtpSend({
        host: '127.0.0.1', port, secure: false, user: 'me@ex.com', password: 'secret',
        from: 'me@ex.com', to: 'ann@ex.com',
        data: buildSmtpData({ from: 'me@ex.com', to: 'ann@ex.com', subject: 'QodeX', text: '.hidden', messageId: '<a@ex.com>' }),
        socketFactory: localSocket(port),
      });
      expect(data).toContain('Subject: QodeX');
      expect(data).toContain('..hidden');
      expect(data).not.toContain('secret');
    } finally {
      server.close();
    }
  });
});

describe('email transport', () => {
  it('does not replay the prime poll and sends one letter for a stream of edits', async () => {
    const seen: string[] = [];
    const sent: Array<{ to: string; subject: string; text: string; inReplyTo?: string }> = [];
    let phase = 0;
    const queued: Array<() => void> = [];
    const bot = new EmailTransport({
      from: 'me@ex.com',
      imap: { host: '127.0.0.1', port: 1, secure: false, user: 'me', password: 'x' },
      smtp: { host: '127.0.0.1', port: 1, secure: false, user: 'me', password: 'x' },
      pollMs: 20,
      flushMs: 5000,
      later: fn => {
        queued.push(fn);
        return { cancel() { const at = queued.indexOf(fn); if (at >= 0) queued.splice(at, 1); } };
      },
      poll: async () => {
        phase++;
        if (phase === 1) return { cursor: 9, messages: [] };
        if (phase === 2) return { cursor: 12, messages: [{ uid: 12, from: 'ann@ex.com', subject: 'Hi', messageId: '<m1@ex.com>', text: 'hello there' }] };
        return { cursor: 12, messages: [] };
      },
      deliver: async msg => { sent.push(msg); },
    });
    await bot.start(m => seen.push(m.text));
    await new Promise(r => setTimeout(r, 80));
    expect(seen).toEqual(['hello there']);
    const ref = await bot.send('ann@ex.com', 'draft', [[{ label: 'Allow', data: 'yes' }]]);
    await bot.edit('ann@ex.com', ref, 'final answer');
    expect(sent).toEqual([]);
    await bot.stop();
    expect(sent).toEqual([{ to: 'ann@ex.com', subject: 'Re: Hi', text: 'final answer', inReplyTo: '<m1@ex.com>' }]);
    expect(queued).toEqual([]);
  });
});
