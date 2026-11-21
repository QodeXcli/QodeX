/**
 * What the desktop may show about the host and the window list.
 * Missing data is an empty list, not a guess.
 */

export interface HostRow {
  id: string;
  state: string;
  turns: number;
  maxTurns: number;
  prompt: string;
  resumeAt?: string;
}

const HOST_ORDER = ['running', 'paused', 'queued', 'held', 'error', 'done'];

export function hostJobRows(raw: unknown): HostRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: HostRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const job = item as Record<string, unknown>;
    if (typeof job.id !== 'string' || typeof job.state !== 'string') continue;
    rows.push({
      id: job.id.slice(0, 16),
      state: job.state,
      turns: typeof job.turns === 'number' ? job.turns : 0,
      maxTurns: typeof job.maxTurns === 'number' ? job.maxTurns : 0,
      prompt: String(job.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      resumeAt: typeof job.resumeAt === 'string' ? job.resumeAt : undefined,
    });
  }
  rows.sort((a, b) => {
    const ia = HOST_ORDER.indexOf(a.state);
    const ib = HOST_ORDER.indexOf(b.state);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return rows.slice(0, 8);
}

export function windowNames(text: string): string[] {
  return text.split(/\r?\n/)
    .map(line => line.trim().replace(/^[-*]\s+/, ''))
    .filter(line => line && !line.startsWith('[COMPUTER_USE_ERROR]') && !/^Windows of /.test(line))
    .slice(0, 24)
    .map(line => line.slice(0, 80));
}

export function focusTarget(line: string): string {
  const cut = line.indexOf(':');
  const name = (cut > 0 ? line.slice(0, cut) : line).trim();
  return name.slice(0, 80);
}
