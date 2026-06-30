/**
 * "Run Maintain Now" (preview) — run the toolchain DETECTION the maintain recipe relies on, with
 * no model and no edits, so the dashboard can show what maintain WOULD find right now. Safe +
 * instant: it's just `tsc --noUnusedLocals` (read-only), parsed.
 *
 * parseUnusedDiagnostics is PURE (unit-tested); runMaintainPreview spawns tsc.
 */
import { spawnSync } from 'child_process';

export interface PreviewCandidate { file: string; name: string }
export interface MaintainPreview { count: number; sample: PreviewCandidate[]; ran: boolean }

/** Parse `tsc` TS6133/TS6196 "declared but never read/used" diagnostics. PURE. */
export function parseUnusedDiagnostics(output: string): { count: number; sample: PreviewCandidate[] } {
  const re = /^(.+?)\((\d+),\d+\): error TS6(?:133|196): '([^']+)'/gm;
  const out: PreviewCandidate[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) out.push({ file: m[1]!, name: m[3]! });
  return { count: out.length, sample: out.slice(0, 8) };
}

/** Run the read-only detection in `cwd`. Never edits anything. Best-effort. */
export function runMaintainPreview(cwd: string): MaintainPreview {
  try {
    const r = spawnSync('npx', ['tsc', '--noEmit', '--noUnusedLocals', '--noUnusedParameters'], {
      cwd, encoding: 'utf-8', timeout: 90_000,
    });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // tsc exits non-zero when it finds diagnostics — that's expected, not a failure.
    if (!text && r.status === null) return { count: 0, sample: [], ran: false };
    const { count, sample } = parseUnusedDiagnostics(text);
    return { count, sample, ran: true };
  } catch {
    return { count: 0, sample: [], ran: false };
  }
}
