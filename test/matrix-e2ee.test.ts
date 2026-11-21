import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { encryptedFromSync, eventsFromSync } from '../src/bot/adapters/matrix.js';
import { openMatrixCrypto } from '../src/bot/adapters/matrix-crypto.js';

const payload = {
  rooms: {
    join: {
      '!room:example.org': {
        timeline: {
          events: [
            { type: 'm.room.encrypted', sender: '@a:example.org', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
            { type: 'm.room.encrypted', sender: '@bot:example.org', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
            { type: 'm.room.message', sender: '@a:example.org', content: { msgtype: 'm.text', body: 'clear' } },
          ],
        },
      },
    },
  },
};

describe('matrix encrypted rooms', () => {
  it('keeps an encrypted event separate from clear text, and does not invent plaintext', () => {
    expect(eventsFromSync(payload, '@bot:example.org')).toEqual([
      { platform: 'matrix', chatId: '!room:example.org', userId: '@a:example.org', text: 'clear' },
    ]);
    expect(encryptedFromSync(payload, '@bot:example.org')).toEqual([
      { roomId: '!room:example.org', sender: '@a:example.org', event: payload.rooms.join['!room:example.org'].timeline.events[0] },
    ]);
  });

  it('loads the crypto engine and reuses the device id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qodex-matrix-'));
    const prev = process.env.HOME;
    process.env.HOME = dir;
    try {
      const sent: string[] = [];
      const first = await openMatrixCrypto({
        userId: '@bot:example.org',
        send: async (method, p) => { sent.push(`${method} ${p}`); return {}; },
      });
      expect(first.deviceId).toMatch(/^QODEX/);
      expect(first.note).toContain('matrix e2ee on');
      expect(sent.some(s => s === 'POST /keys/upload')).toBe(true);
      const missing = await first.decrypt({ type: 'm.room.encrypted', content: {} }, '!room:example.org');
      expect(missing).toBeNull();
      first.close();
      const second = await openMatrixCrypto({
        userId: '@bot:example.org',
        send: async () => ({}),
      });
      expect(second.deviceId).toBe(first.deviceId);
      second.close();
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
