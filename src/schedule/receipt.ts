/**
 * Trust receipts — proof-carrying autonomy.
 *
 * An unattended run is only trustworthy if you can AUDIT it. Because QodeX verifies (the
 * completion gate + auto-verify won't let the agent claim a pass it didn't earn), an
 * autonomous run can emit a structured **receipt**: what it set out to do, the branch it
 * worked on, which verification commands ran and whether they passed, the files it touched,
 * and the PR it opened (or why it didn't). The runner extracts this from the run's output,
 * stores it, and leads the chat delivery with it — so "the agent did X overnight" becomes a
 * checkable record, not a claim. This is the half a cron-around-a-chatbot structurally lacks.
 *
 * Parsing + formatting are PURE and unit-tested.
 */

export interface ReceiptCheck { command: string; passed: boolean }

export interface RunReceipt {
  /** opened a PR · blocked (verification failed / unsure) · done (non-PR task) · failed. */
  status: 'opened' | 'blocked' | 'done' | 'failed';
  goal?: string;
  branch?: string;
  prUrl?: string;
  reason?: string;
  filesChanged?: string[];
  verification?: ReceiptCheck[];
  summary?: string;
}

const STATUSES = new Set(['opened', 'blocked', 'done', 'failed']);

/**
 * Extract a receipt from a run's stdout. Prefers a fenced ```qodex-receipt {json} ``` block;
 * falls back to the `VERIFIED-PR: opened <url>` / `blocked — <reason>` headline line. Returns
 * null when neither is present. Best-effort — malformed JSON yields null, not a throw.
 */
export function parseReceipt(output: string): RunReceipt | null {
  const fenced = /```(?:qodex-receipt)\s*\n([\s\S]*?)\n```/i.exec(output)
    ?? /~~~(?:qodex-receipt)\s*\n([\s\S]*?)\n~~~/i.exec(output);
  if (fenced) {
    try {
      const obj = JSON.parse(fenced[1]!.trim());
      const coerced = coerce(obj);
      if (coerced) return coerced;
    } catch { /* fall through to the headline */ }
  }
  // Headline fallback (also the recipe's human-facing status line).
  const opened = /VERIFIED-PR:\s*opened\s+(\S+)/i.exec(output);
  if (opened) return { status: 'opened', prUrl: opened[1] };
  const blocked = /VERIFIED-PR:\s*blocked\s*[—:-]+\s*(.+)/i.exec(output);
  if (blocked) return { status: 'blocked', reason: blocked[1]!.trim() };
  return null;
}

function coerce(o: any): RunReceipt | null {
  if (!o || typeof o !== 'object') return null;
  const status = STATUSES.has(o.status) ? o.status : (o.prUrl || o.pr_url ? 'opened' : undefined);
  if (!status) return null;
  const checks = Array.isArray(o.verification)
    ? o.verification.map((c: any) => ({ command: String(c?.command ?? ''), passed: !!c?.passed })).filter((c: ReceiptCheck) => c.command)
    : undefined;
  const files = Array.isArray(o.filesChanged ?? o.files)
    ? (o.filesChanged ?? o.files).map((f: any) => String(f)).filter(Boolean)
    : undefined;
  return {
    status,
    goal: str(o.goal),
    branch: str(o.branch),
    prUrl: str(o.prUrl ?? o.pr_url),
    reason: str(o.reason),
    summary: str(o.summary),
    filesChanged: files,
    verification: checks,
  };
}

const str = (x: any): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : undefined);

/**
 * Assemble a receipt from QodeX's OWN ground-truth signals (a git diff it ran, checkers it
 * ran) rather than the model's say-so. Verification entries are deduped by command keeping the
 * LAST result (the repair loop re-runs a checker; the final pass/fail is what counts). PURE.
 * This is the uncounterfeitable half: filesChanged + verification are facts QodeX measured.
 */
export function buildGroundTruthReceipt(input: {
  status: RunReceipt['status'];
  prUrl?: string;
  reason?: string;
  filesChanged?: string[];
  verification?: ReceiptCheck[];
  summary?: string;
}): RunReceipt {
  const byCmd = new Map<string, boolean>();
  for (const c of input.verification ?? []) if (c.command) byCmd.set(c.command, !!c.passed);
  const verification = [...byCmd].map(([command, passed]) => ({ command, passed }));
  return {
    status: input.status,
    prUrl: str(input.prUrl),
    reason: str(input.reason),
    summary: str(input.summary),
    filesChanged: input.filesChanged?.length ? dedupeStr(input.filesChanged) : undefined,
    verification: verification.length ? verification : undefined,
  };
}

function dedupeStr(xs: string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const x of xs) if (x && !seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

/** Read a receipt JSON file QodeX wrote at end-of-run. Returns null if absent/unreadable. */
export async function readReceiptFile(filePath: string): Promise<RunReceipt | null> {
  try {
    const { promises: fs } = await import('fs');
    const raw = await fs.readFile(filePath, 'utf-8');
    const obj = JSON.parse(raw);
    return coerce(obj);
  } catch { return null; }
}

/** Compact, scannable receipt for a chat message. PURE. */
export function formatReceipt(r: RunReceipt): string {
  const lines = ['🧾 Receipt'];
  const icon = r.status === 'opened' ? '✅ opened' : r.status === 'done' ? '✅ done' : r.status === 'blocked' ? '⛔ blocked' : '❌ failed';
  lines.push(`status: ${icon}`);
  if (r.prUrl) lines.push(`PR: ${r.prUrl}`);
  if (r.branch) lines.push(`branch: ${r.branch}`);
  if (r.verification?.length) {
    lines.push('verified: ' + r.verification.map(c => `${c.passed ? '✓' : '✗'} ${c.command}`).join(' · '));
  }
  if (r.filesChanged?.length) {
    const shown = r.filesChanged.slice(0, 4).join(', ');
    lines.push(`files: ${shown}${r.filesChanged.length > 4 ? ` (+${r.filesChanged.length - 4})` : ''}`);
  }
  if (r.status !== 'opened' && r.reason) lines.push(`reason: ${r.reason}`);
  return lines.join('\n');
}
