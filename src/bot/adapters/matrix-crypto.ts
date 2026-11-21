/**
 * Matrix E2EE via the official WASM crypto engine.
 * A missing key is not a message. Device trust is not claimed.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { residentHome } from '../../resident/paths.js';

export interface MatrixCrypto {
  deviceId: string;
  note: string;
  ingest(sync: unknown): Promise<void>;
  decrypt(event: unknown, roomId: string): Promise<string | null>;
  close(): void;
}

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>;

function cryptoDir(): string {
  return path.join(residentHome(), 'matrix');
}

async function loadDeviceId(explicit?: string): Promise<string> {
  if (explicit && /^[A-Za-z0-9._=+-]{1,64}$/.test(explicit)) return explicit;
  const file = path.join(cryptoDir(), 'device-id');
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (/^[A-Za-z0-9._=+-]{1,64}$/.test(existing)) return existing;
  } catch { /* create it */ }
  const id = 'QODEX' + randomBytes(6).toString('hex').toUpperCase();
  await fs.mkdir(cryptoDir(), { recursive: true });
  await fs.writeFile(file, id + '\n', { mode: 0o600 });
  return id;
}

function pathFor(req: { type: number; event_type?: string; txn_id?: string }): { method: string; path: string } | null {
  if (req.type === 0) return { method: 'POST', path: '/keys/upload' };
  if (req.type === 1) return { method: 'POST', path: '/keys/query' };
  if (req.type === 2) return { method: 'POST', path: '/keys/claim' };
  if (req.type === 3 && req.event_type && req.txn_id) {
    return { method: 'PUT', path: `/sendToDevice/${encodeURIComponent(req.event_type)}/${encodeURIComponent(req.txn_id)}` };
  }
  if (req.type === 4) return { method: 'POST', path: '/keys/signatures/upload' };
  return null;
}

export async function openMatrixCrypto(opts: { userId: string; deviceId?: string; send: Send }): Promise<MatrixCrypto> {
  const wasm = await import('@matrix-org/matrix-sdk-crypto-wasm');
  const deviceId = await loadDeviceId(opts.deviceId);
  const machine = await wasm.OlmMachine.initialize(new wasm.UserId(opts.userId), new wasm.DeviceId(deviceId));
  const settings = new wasm.DecryptionSettings(wasm.TrustRequirement.Untrusted);
  const keysFile = path.join(cryptoDir(), 'room-keys.json');
  let restored = 0;
  try {
    const exported = await fs.readFile(keysFile, 'utf8');
    if (exported.trim()) {
      const result = await machine.importRoomKeys(exported, () => {});
      const parsed = JSON.parse(result) as { imported_count?: number };
      restored = parsed.imported_count ?? 0;
    }
  } catch { /* first run, or the export is not readable */ }

  async function flush(): Promise<void> {
    const reqs = await machine.outgoingRequests();
    for (const req of reqs) {
      const dest = pathFor(req);
      if (!dest) continue;
      let body: unknown = {};
      try { body = JSON.parse(req.body); } catch { body = {}; }
      const response = await opts.send(dest.method, dest.path, body);
      if (req.id) await machine.markRequestAsSent(req.id, req.type, JSON.stringify(response ?? {}));
    }
  }

  async function persist(): Promise<void> {
    try {
      const exported = await machine.exportRoomKeys(() => true);
      if (!exported) return;
      await fs.mkdir(cryptoDir(), { recursive: true });
      const tmp = keysFile + '.tmp';
      await fs.writeFile(tmp, exported, { mode: 0o600 });
      await fs.rename(tmp, keysFile);
    } catch { /* a failed export does not drop the live machine */ }
  }

  await flush().catch(() => {});

  return {
    deviceId,
    note: restored
      ? `matrix e2ee on · device ${deviceId} · restored ${restored} room key(s). Unverified devices are still decrypted. A missing key is not a message.`
      : `matrix e2ee on · device ${deviceId}. Unverified devices are still decrypted. A missing key is not a message.`,
    async ingest(sync: unknown): Promise<void> {
      const page = sync as {
        to_device?: { events?: unknown[] };
        device_lists?: { changed?: string[]; left?: string[] };
        device_one_time_keys_count?: Record<string, number>;
      };
      const changed = (page.device_lists?.changed ?? []).filter(id => typeof id === 'string').map(id => new wasm.UserId(id));
      const left = (page.device_lists?.left ?? []).filter(id => typeof id === 'string').map(id => new wasm.UserId(id));
      const counts = new Map<string, number>();
      for (const [key, value] of Object.entries(page.device_one_time_keys_count ?? {})) {
        if (typeof value === 'number') counts.set(key, value);
      }
      await machine.receiveSyncChanges(
        JSON.stringify(page.to_device?.events ?? []),
        new wasm.DeviceLists(changed, left),
        counts,
        undefined,
        settings,
      );
      await flush();
      await persist();
    },
    async decrypt(event: unknown, roomId: string): Promise<string | null> {
      try {
        const dec = await machine.decryptRoomEvent(JSON.stringify(event), new wasm.RoomId(roomId), settings);
        const clear = JSON.parse(dec.event) as { content?: { body?: string; msgtype?: string } };
        const body = clear.content?.body;
        return typeof body === 'string' && body.trim() ? body : null;
      } catch {
        return null;
      }
    },
    close(): void {
      machine.close();
    },
  };
}
