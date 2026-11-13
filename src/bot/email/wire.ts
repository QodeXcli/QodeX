/**
 * IMAP poll and SMTP send over the user's own server.
 * Cleartext is refused except to localhost. The first poll only reads UIDNEXT,
 * so mail that was already in the box is not replayed and is not marked seen.
 */
import { connect as netConnect, Socket } from 'net';
import { connect as tlsConnect } from 'tls';
import { parseRfc5322 } from './parse.js';

export interface MailLogin {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  socketFactory?: () => Promise<Socket>;
}

export interface ImapHit {
  uid: number;
  from: string;
  subject: string;
  messageId: string;
  text: string;
}

class Reader {
  private buf = Buffer.alloc(0);
  private closed = false;
  private wake: (() => void) | null = null;

  constructor(private socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.wake?.();
    });
    const stop = () => { this.closed = true; this.wake?.(); };
    socket.on('close', stop);
    socket.on('error', stop);
    socket.resume();
  }

  private wait(ready: () => boolean): Promise<void> {
    if (ready()) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error('mail connection closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mail timeout')), 15000);
      this.wake = () => {
        if (ready()) { clearTimeout(timer); this.wake = null; resolve(); }
        else if (this.closed) { clearTimeout(timer); this.wake = null; reject(new Error('mail connection closed')); }
      };
    });
  }

  async readLine(): Promise<Buffer> {
    for (;;) {
      const at = this.buf.indexOf(0x0a);
      if (at >= 0) {
        const line = Buffer.from(this.buf.subarray(0, at + 1));
        this.buf = this.buf.subarray(at + 1);
        return line;
      }
      await this.wait(() => this.buf.indexOf(0x0a) >= 0);
    }
  }

  async readBytes(n: number): Promise<Buffer> {
    await this.wait(() => this.buf.length >= n);
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }
}

async function openSocket(opts: MailLogin): Promise<Socket> {
  if (opts.socketFactory) return opts.socketFactory();
  return new Promise((resolve, reject) => {
    const socket = opts.secure
      ? tlsConnect({ host: opts.host, port: opts.port, servername: opts.host })
      : netConnect({ host: opts.host, port: opts.port });
    const fail = (err: Error) => { socket.destroy(); reject(err); };
    socket.once('error', fail);
    socket.setTimeout(15000, () => fail(new Error('mail timeout')));
    socket.once(opts.secure ? 'secureConnect' : 'connect', () => {
      socket.setTimeout(0);
      socket.pause();
      socket.off('error', fail);
      resolve(socket);
    });
  });
}

async function readTagged(reader: Reader, tag: string, stopOnContinue: boolean): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (;;) {
    const line = await reader.readLine();
    chunks.push(line);
    const text = line.toString('utf8');
    const literal = text.match(/\{(\d+)\}\r?\n$/);
    if (literal) {
      chunks.push(await reader.readBytes(Number(literal[1])));
      continue;
    }
    if (stopOnContinue && text.startsWith('+')) return Buffer.concat(chunks);
    if (text.startsWith(`${tag} `)) {
      const rest = text.slice(tag.length + 1);
      if (!/^OK\b/i.test(rest)) throw new Error(text.trim().slice(0, 180));
      return Buffer.concat(chunks);
    }
  }
}

function authToken(user: string, password: string): string {
  return Buffer.from(`\u0000${user}\u0000${password}`).toString('base64');
}

async function login(socket: Socket, opts: MailLogin, tag: () => string): Promise<Reader> {
  const reader = new Reader(socket);
  const greeting = (await reader.readLine()).toString('utf8');
  if (!greeting.startsWith('*') && !/^220 /.test(greeting)) {
    throw new Error('mail server did not greet');
  }
  const id = tag();
  socket.write(`${id} AUTHENTICATE PLAIN\r\n`);
  await readTagged(reader, id, true);
  socket.write(`${authToken(opts.user, opts.password)}\r\n`);
  await readTagged(reader, id, false);
  return reader;
}

function firstLiteral(raw: Buffer): Buffer | null {
  const text = raw.toString('utf8');
  const at = text.search(/\{\d+\}\r\n/);
  if (at < 0) return null;
  const head = text.slice(at).match(/^\{(\d+)\}\r\n/);
  if (!head) return null;
  const start = Buffer.byteLength(text.slice(0, at + head[0].length));
  return raw.subarray(start, start + Number(head[1]));
}

export async function imapPoll(
  opts: MailLogin,
  cursor: number,
  primed: boolean,
): Promise<{ cursor: number; messages: ImapHit[] }> {
  const socket = await openSocket(opts);
  let n = 0;
  const tag = () => `A${++n}`;
  try {
    const reader = await login(socket, opts, tag);
    const select = tag();
    socket.write(`${select} SELECT INBOX\r\n`);
    const selected = await readTagged(reader, select, false);
    if (!primed) {
      const next = selected.toString('utf8').match(/\[UIDNEXT (\d+)\]/);
      const uidNext = next ? Number(next[1]) : cursor;
      socket.write(`${tag()} LOGOUT\r\n`);
      return { cursor: Math.max(cursor, uidNext - 1), messages: [] };
    }
    const search = tag();
    socket.write(`${search} UID SEARCH UNSEEN\r\n`);
    const found = (await readTagged(reader, search, false)).toString('utf8');
    const searchLine = found.split(/\r?\n/).filter(line => line.startsWith('* SEARCH')).join(' ');
    const uids = [...searchLine.matchAll(/(?:^|\s)(\d+)/g)].map(m => Number(m[1])).filter(uid => uid > cursor);
    const messages: ImapHit[] = [];
    for (const uid of uids) {
      const fetchId = tag();
      socket.write(`${fetchId} UID FETCH ${uid} BODY.PEEK[]\r\n`);
      const fetched = await readTagged(reader, fetchId, false);
      const literal = firstLiteral(fetched);
      const parsed = literal ? parseRfc5322(literal.toString('utf8')) : null;
      if (!parsed) continue;
      const store = tag();
      socket.write(`${store} UID STORE ${uid} +FLAGS (\\Seen)\r\n`);
      await readTagged(reader, store, false);
      messages.push({ uid, ...parsed });
    }
    socket.write(`${tag()} LOGOUT\r\n`);
    const highest = messages.reduce((max, m) => Math.max(max, m.uid), cursor);
    return { cursor: highest, messages };
  } finally {
    socket.end();
  }
}

async function smtpReply(reader: Reader): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  for (;;) {
    const line = (await reader.readLine()).toString('utf8').replace(/\r?\n$/, '');
    const match = line.match(/^(\d{3})([ -])(.*)$/);
    if (!match) throw new Error(`smtp: ${line.slice(0, 120)}`);
    lines.push(match[3] ?? '');
    if (match[2] === ' ') return { code: Number(match[1]), text: lines.join('\n') };
  }
}

export async function smtpSend(opts: MailLogin & {
  from: string;
  to: string;
  data: string;
}): Promise<void> {
  const socket = await openSocket(opts);
  const reader = new Reader(socket);
  try {
    const hello = await smtpReply(reader);
    if (hello.code !== 220) throw new Error(`smtp greeting ${hello.code}`);
    socket.write('EHLO qodex\r\n');
    const ehlo = await smtpReply(reader);
    if (ehlo.code !== 250) throw new Error(`smtp ehlo ${ehlo.code}`);
    socket.write(`AUTH PLAIN ${authToken(opts.user, opts.password)}\r\n`);
    const auth = await smtpReply(reader);
    if (auth.code !== 235) throw new Error(`smtp auth ${auth.code}`);
    socket.write(`MAIL FROM:<${opts.from}>\r\n`);
    if ((await smtpReply(reader)).code !== 250) throw new Error('smtp rejected the sender');
    socket.write(`RCPT TO:<${opts.to}>\r\n`);
    if ((await smtpReply(reader)).code !== 250) throw new Error('smtp rejected the recipient');
    socket.write('DATA\r\n');
    if ((await smtpReply(reader)).code !== 354) throw new Error('smtp refused data');
    socket.write(`${opts.data}\r\n.\r\n`);
    if ((await smtpReply(reader)).code !== 250) throw new Error('smtp did not accept the letter');
    socket.write('QUIT\r\n');
  } finally {
    socket.end();
  }
}
