/**
 * Pure mail parsing. No sockets. IMAP and SMTP both use this so a header
 * cannot inject a second recipient and a multipart letter still has a body.
 */

const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

export function mailEndpoint(
  host: string,
  port: number,
  secure?: boolean,
): { host: string; port: number; secure: boolean } | null {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!name || name.length > 253 || !/^[a-z0-9.:-]+$/.test(name) || name.includes('..')) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const local = LOCAL.has(name);
  const tls = secure ?? !local;
  if (!tls && !local) return null;
  return { host: name, port, secure: tls };
}

/** Angle-addr or bare addr. Rejects header injection. */
export function parseAddress(raw: string): string | null {
  if (!raw || /[\r\n]/.test(raw)) return null;
  const angled = raw.match(/<([^<>\s]+)>/);
  const candidate = (angled?.[1] ?? raw).trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate)) return null;
  return candidate;
}

export function decodeQuotedPrintable(input: string): string {
  const stripped = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const hex = stripped.slice(i + 1, i + 3);
    if (stripped[i] === '=' && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(stripped.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeBody(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? '7bit').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function unfold(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
}

function headerMap(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of unfold(block).split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return headers;
}

function splitMessage(raw: string): { headers: Map<string, string>; body: string } | null {
  const text = raw.replace(/^\uFEFF/, '');
  const match = text.match(/\r?\n\r?\n/);
  if (!match || match.index == null) return null;
  return { headers: headerMap(text.slice(0, match.index)), body: text.slice(match.index + match[0].length) };
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&/gi, '&')
    .replace(/</gi, '<')
    .replace(/>/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function partText(headers: Map<string, string>, body: string): string {
  const type = headers.get('content-type') ?? 'text/plain';
  const decoded = decodeBody(body, headers.get('content-transfer-encoding'));
  if (/text\/html/i.test(type)) return htmlToText(decoded);
  return decoded.replace(/\r\n/g, '\n').trim();
}

export interface ParsedMail {
  from: string;
  subject: string;
  messageId: string;
  text: string;
}

/** Prefer text/plain. HTML-only mail is stripped to text. Empty body is not a letter. */
export function parseRfc5322(raw: string): ParsedMail | null {
  const top = splitMessage(raw);
  if (!top) return null;
  const from = parseAddress(top.headers.get('from') ?? '');
  if (!from) return null;
  const subject = (top.headers.get('subject') ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  const messageId = (top.headers.get('message-id') ?? '').trim();
  const type = top.headers.get('content-type') ?? 'text/plain';
  let text = '';
  const boundary = type.match(/boundary="?([^";]+)"?/i)?.[1];
  if (/multipart\//i.test(type) && boundary) {
    const chunks = top.body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    let html = '';
    for (const chunk of chunks) {
      if (!chunk.trim() || chunk.trim().startsWith('--')) continue;
      const part = splitMessage(chunk.replace(/^\r?\n/, ''));
      if (!part) continue;
      const partType = part.headers.get('content-type') ?? 'text/plain';
      if (/text\/plain/i.test(partType)) {
        text = partText(part.headers, part.body);
        break;
      }
      if (/text\/html/i.test(partType) && !html) html = partText(part.headers, part.body);
    }
    if (!text) text = html;
  } else {
    text = partText(top.headers, top.body);
  }
  text = text.replace(/\u0000/g, '').trim().slice(0, 20_000);
  if (!text) return null;
  return { from, subject, messageId: /^<[^>\s]+>$/.test(messageId) ? messageId : '', text };
}

export function replySubject(subject: string): string {
  const clean = subject.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return 'QodeX';
  return /^re:/i.test(clean) ? clean.slice(0, 200) : `Re: ${clean}`.slice(0, 200);
}

/** One SMTP DATA payload, without the terminating dot. */
export function buildSmtpData(opts: {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
}): string {
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject.replace(/[\r\n]+/g, ' ').slice(0, 200)}`,
    `Message-ID: ${opts.messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (opts.inReplyTo && /^<[^>\s]+>$/.test(opts.inReplyTo)) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  }
  const lines = opts.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const stuffed = lines.map(line => (line.startsWith('.') ? `.${line}` : line)).join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${stuffed}\r\n`;
}
