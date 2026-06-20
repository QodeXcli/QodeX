import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// One-time guard so a recurring rotation failure doesn't spam stderr.
let warnedRotateFailed = false;

class Logger {
  private logFile: string;
  private minLevel: LogLevel = 'info';
  private initialized = false;
  private buffer: string[] = [];

  constructor() {
    this.logFile = path.join(os.homedir(), '.qodex', 'qodex.log');
  }

  async init(minLevel: LogLevel = 'info'): Promise<void> {
    this.minLevel = minLevel;
    const dir = path.dirname(this.logFile);
    await fs.mkdir(dir, { recursive: true });

    // Truncate if larger than 10MB
    try {
      const stat = await fs.stat(this.logFile);
      if (stat.size > 10 * 1024 * 1024) {
        await fs.writeFile(this.logFile, '');
      }
    } catch (err) {
      // The logger can't reliably log about itself; warn once on stderr so an
      // unbounded log file (rotation truncate failing) doesn't go unnoticed.
      if (!warnedRotateFailed) {
        warnedRotateFailed = true;
        try {
          process.stderr.write(`qodex: log rotation check failed for ${this.logFile}: ${(err as any)?.message ?? err}\n`);
        } catch { /* intentional: logger must never throw */ }
      }
    }

    this.initialized = true;
    if (this.buffer.length > 0) {
      await fs.appendFile(this.logFile, this.buffer.join('\n') + '\n');
      this.buffer = [];
    }
  }

  private async write(level: LogLevel, msg: string, meta?: Record<string, unknown>): Promise<void> {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;
    const ts = new Date().toISOString();
    const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
    const line = `${ts} [${level.toUpperCase()}] ${msg}${metaStr}`;

    if (!this.initialized) {
      this.buffer.push(line);
      return;
    }
    try {
      await fs.appendFile(this.logFile, line + '\n');
    } catch { /* intentional: logger must never throw */ }
  }

  debug(msg: string, meta?: Record<string, unknown>): void { void this.write('debug', msg, meta); }
  info(msg: string, meta?: Record<string, unknown>): void { void this.write('info', msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>): void { void this.write('warn', msg, meta); }
  error(msg: string, meta?: Record<string, unknown>): void { void this.write('error', msg, meta); }
}

export const logger = new Logger();
