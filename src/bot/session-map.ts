/**
 * Conversation → session mapping, persisted as JSON under ~/.qodex.
 *
 * Each chat (telegram chat / discord channel) gets one durable QodeX session, so context
 * survives bot restarts. Keyed by the composite `platform:chatId`. Tiny, synchronous, and
 * file-path-injectable for tests.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

const DEFAULT_FILE = path.join(os.homedir(), '.qodex', 'bot-sessions.json');

export class SessionMap {
  private map: Record<string, string> = {};
  private loaded = false;
  constructor(private file: string = DEFAULT_FILE) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    try { this.map = JSON.parse(await fs.readFile(this.file, 'utf-8')); }
    catch { this.map = {}; }
    this.loaded = true;
  }

  async get(key: string): Promise<string | undefined> {
    await this.load();
    return this.map[key];
  }

  async set(key: string, sessionId: string): Promise<void> {
    await this.load();
    this.map[key] = sessionId;
    await fs.mkdir(path.dirname(this.file), { recursive: true }).catch(() => {});
    await fs.writeFile(this.file, JSON.stringify(this.map, null, 2)).catch(() => {});
  }

  async clear(key: string): Promise<void> {
    await this.load();
    delete this.map[key];
    await fs.writeFile(this.file, JSON.stringify(this.map, null, 2)).catch(() => {});
  }
}
