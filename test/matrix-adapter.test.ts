import { describe, it, expect } from 'vitest';
import {
  MatrixTransport,
  eventsFromSync,
  isMatrixRoomId,
  matrixHomeserver,
  matrixReplaceBody,
  matrixTextBody,
  resolveMatrixBase,
} from '../src/bot/adapters/matrix.js';
import { parseDeliveryTarget } from '../src/schedule/delivery.js';
import { isAuthorized } from '../src/bot/auth.js';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('matrix homeserver', () => {
  it('accepts https and local http, and rejects the rest', () => {
    expect(matrixHomeserver('https://matrix.example')).toBe('https://matrix.example');
    expect(matrixHomeserver('http://127.0.0.1:8008')).toBe('http://127.0.0.1:8008');
    expect(matrixHomeserver('http://matrix.example')).toBeNull();
    expect(matrixHomeserver('https://user:pass@matrix.example')).toBeNull();
    expect(matrixHomeserver('https://matrix.example/extra')).toBeNull();
    expect(isMatrixRoomId('!room:example.org')).toBe(true);
    expect(isMatrixRoomId('#room:example.org')).toBe(false);
  });

  it('uses a delegated base only when that base is also a homeserver origin', async () => {
    const fetchImpl = async (url: string) => {
      expect(String(url)).toBe('https://chat.example/.well-known/matrix/client');
      return json({ 'm.homeserver': { base_url: 'https://matrix.example' } }) as any;
    };
    expect(await resolveMatrixBase('https://chat.example', fetchImpl as any)).toBe('https://matrix.example');
    const bad = async () => json({ 'm.homeserver': { base_url: 'http://evil.example' } });
    expect(await resolveMatrixBase('https://chat.example', bad as any)).toBe('https://chat.example');
  });
});

describe('matrix sync', () => {
  const payload = {
    next_batch: 's2',
    rooms: {
      join: {
        '!room:example.org': {
          timeline: {
            events: [
              { type: 'm.room.message', sender: '@bot:example.org', content: { msgtype: 'm.text', body: 'own' } },
              { type: 'm.room.message', sender: '@a:example.org', content: { msgtype: 'm.text', body: 'hello' } },
              { type: 'm.room.message', sender: '@a:example.org', content: { msgtype: 'm.text', body: 'edit', 'm.relates_to': { rel_type: 'm.replace', event_id: '$old' } } },
              { type: 'm.room.encrypted', sender: '@a:example.org', content: { body: 'secret' } },
              { type: 'm.room.message', sender: '@a:example.org', content: { msgtype: 'm.image', body: 'pic' } },
            ],
          },
        },
        '#alias:example.org': { timeline: { events: [{ type: 'm.room.message', sender: '@a:example.org', content: { msgtype: 'm.text', body: 'no' } }] } },
      },
    },
  };

  it('keeps a new text message and drops self, edits, encryption, and aliases', () => {
    expect(eventsFromSync(payload, '@bot:example.org')).toEqual([
      { platform: 'matrix', chatId: '!room:example.org', userId: '@a:example.org', text: 'hello' },
    ]);
  });

  it('does not replay the first sync, then delivers the next one', async () => {
    const seen: string[] = [];
    const calls: string[] = [];
    let syncs = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/account/whoami')) return json({ user_id: '@bot:example.org' });
      if (u.includes('/sync')) {
        syncs++;
        if (u.includes('timeout=0')) return json(payload);
        if (syncs === 2) {
          return json({
            next_batch: 's3',
            rooms: { join: { '!room:example.org': { timeline: { events: [
              { type: 'm.room.message', sender: '@a:example.org', content: { msgtype: 'm.text', body: 'next' } },
            ] } } } },
          });
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return json({ event_id: '$evt1' });
    };
    const bot = new MatrixTransport({ base: 'https://matrix.example', token: 'secret-token', fetchImpl: fetchImpl as any });
    await bot.start(m => seen.push(m.text));
    await new Promise(r => setTimeout(r, 30));
    expect(seen).toEqual(['next']);
    expect(calls.some(c => c.includes('secret-token'))).toBe(false);
    const sent = await bot.send('!room:example.org', 'ok', [[{ label: 'Allow', data: 'yes' }]]);
    expect(sent.id).toBe('$evt1');
    const put = calls.find(c => c.startsWith('PUT'));
    expect(put).toContain('/rooms/!room%3Aexample.org/send/m.room.message/');
    expect(matrixTextBody('ok', [[{ label: 'Allow', data: 'yes' }]]).body).toContain('Allow');
    expect(matrixReplaceBody('$evt1', 'edited')['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$evt1' });
    await bot.stop();
  });

  it('is deny-by-default and delivery rejects an alias', () => {
    expect(isAuthorized('matrix', '@a:example.org', {})).toBe(false);
    expect(isAuthorized('matrix', '@a:example.org', { matrix: { allowedUsers: ['@a:example.org'] } })).toBe(true);
    expect(parseDeliveryTarget('matrix:!room:example.org')).toEqual({ platform: 'matrix', chatId: '!room:example.org' });
    expect(parseDeliveryTarget('matrix:#room:example.org')).toBeNull();
  });
});
