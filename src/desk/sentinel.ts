/**
 * Sentinel — the pause Muse puts in front of send/spend, on this machine.
 *
 * A desk run does not auto-deny the ask. It parks the exact call, waits, and
 * returns yes only after `qodex desk allow-call` or the local console. Deny
 * and timeout are no. The tool then runs or it doesn't. Nothing is simulated.
 */
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { classifySensitive } from './policy.js';
import { desksDir } from './store.js';
import { withLock } from '../utils/file-lock.js';

export type SentinelStatus = 'pending' | 'allowed' | 'denied';

export interface SentinelRequest {
  id: string;
  deskId: string;
  goalId: string;
  prompt: string;
  kind: string;
  reason: string;
  status: SentinelStatus;
  createdAt: string;
  decidedAt?: string;
}

export interface SentinelFile {
  version: 1;
  requests: SentinelRequest[];
}

export function emptySentinel(): SentinelFile {
  return { version: 1, requests: [] };
}

/** Label an ask. Every ask waits; the kind is what the console shows. */
export function classifyAsk(prompt: string): { kind: string; reason: string } {
  const body = prompt ?? '';
  if (/will change what is on screen/i.test(body) || /computer_use_(click|type|key)/i.test(body)) {
    return { kind: 'screen', reason: 'this call changes the screen' };
  }
  const sensitive = classifySensitive(body);
  if (sensitive.sensitive) return { kind: sensitive.kind, reason: sensitive.reason };
  if (/\brm\s+-[a-z]*r/i.test(body) || /\bgit\s+push\b/i.test(body) || /\b(npm|pnpm|yarn)\s+publish\b/i.test(body)) {
    return { kind: 'irreversible', reason: 'irreversible command — one call, one yes' };
  }
  return { kind: 'ask', reason: 'the agent asked before acting' };
}

export function decideInFile(
  file: SentinelFile,
  id: string,
  allow: boolean,
  now: string,
): { ok: true; file: SentinelFile; request: SentinelRequest } | { ok: false; file: SentinelFile; error: string } {
  const req = file.requests.find(r => r.id === id);
  if (!req) return { ok: false, file, error: `no call "${id}"` };
  if (req.status !== 'pending') return { ok: false, file, error: `call is ${req.status}, not waiting` };
  const request: SentinelRequest = {
    ...req,
    status: allow ? 'allowed' : 'denied',
    decidedAt: now,
  };
  return {
    ok: true,
    request,
    file: { ...file, requests: file.requests.map(r => r.id === id ? request : r) },
  };
}

export async function pollSentinel(
  id: string,
  opts: {
    timeoutMs: number;
    pollMs: number;
    load: () => Promise<SentinelRequest | undefined>;
    sleep: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<'allowed' | 'denied' | 'timeout'> {
  const now = opts.now ?? Date.now;
  const start = now();
  for (;;) {
    const row = await opts.load();
    if (row?.status === 'allowed') return 'allowed';
    if (row?.status === 'denied') return 'denied';
    if (now() - start >= opts.timeoutMs) return 'timeout';
    await opts.sleep(opts.pollMs);
  }
}

function sentinelPath(): string {
  return path.join(desksDir(), 'sentinel.json');
}

function sentinelLockPath(): string {
  return path.join(desksDir(), 'sentinel.lock');
}

async function withSentinelLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(desksDir(), { recursive: true });
  return withLock(sentinelLockPath(), fn);
}

export async function loadSentinel(): Promise<SentinelFile> {
  try {
    const raw = await fs.readFile(sentinelPath(), 'utf-8');
    const parsed = JSON.parse(raw) as SentinelFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.requests)) return emptySentinel();
    return parsed;
  } catch {
    return emptySentinel();
  }
}

async function saveSentinel(file: SentinelFile): Promise<void> {
  const dest = sentinelPath();
  const tmp = dest + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await fs.rename(tmp, dest);
}

export async function listPending(): Promise<SentinelRequest[]> {
  const file = await loadSentinel();
  return file.requests.filter(r => r.status === 'pending');
}

export async function parkSentinel(input: {
  deskId: string;
  goalId: string;
  prompt: string;
  kind: string;
  reason: string;
  now?: string;
}): Promise<SentinelRequest> {
  const req: SentinelRequest = {
    id: randomBytes(4).toString('hex'),
    deskId: input.deskId,
    goalId: input.goalId,
    prompt: input.prompt.replace(/\s+/g, ' ').trim().slice(0, 500),
    kind: input.kind,
    reason: input.reason,
    status: 'pending',
    createdAt: input.now ?? new Date().toISOString(),
  };
  await withSentinelLock(async () => {
    const file = await loadSentinel();
    file.requests.push(req);
    file.requests = file.requests.slice(-200);
    await saveSentinel(file);
  });
  return req;
}

export async function decideSentinel(id: string, allow: boolean, now = new Date().toISOString()): Promise<{ ok: boolean; request?: SentinelRequest; error?: string }> {
  return withSentinelLock(async () => {
    const file = await loadSentinel();
    const decided = decideInFile(file, id, allow, now);
    if (!decided.ok) return { ok: false, error: decided.error };
    await saveSentinel(decided.file);
    return { ok: true, request: decided.request };
  });
}

export async function waitForSentinel(id: string, timeoutMs: number): Promise<'allowed' | 'denied' | 'timeout'> {
  return pollSentinel(id, {
    timeoutMs,
    pollMs: 400,
    load: async () => (await loadSentinel()).requests.find(r => r.id === id),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  });
}
