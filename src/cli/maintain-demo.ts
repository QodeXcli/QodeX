/**
 * `qodex maintain-demo` — a self-contained marketing/demo page for "Maintain in action": the
 * nightly self-improvement loop, told visually. buildMaintainDemoHtml is PURE (no data, no I/O)
 * so it's unit-testable; runMaintainDemo writes + opens it.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

const SCOPES: { name: string; blurb: string }[] = [
  { name: 'dead-code', blurb: 'remove one provably-unused item (zero references — or it blocks)' },
  { name: 'unused-imports', blurb: 'drop import bindings referenced zero times; never side-effect imports' },
  { name: 'unused-locals', blurb: 'remove unused consts — only side-effect-free initializers' },
  { name: 'unused-params', blurb: 'prefix `_` (never remove — signatures stay intact)' },
  { name: 'lint-fix', blurb: 'the linter’s autofixable rules only, bounded to a focus' },
  { name: 'dep-bump', blurb: 'one patch/minor bump, shipped only if the full suite passes' },
];

const STEPS = ['Code-graph analysis', 'Prove safe (or block)', 'Sandbox branch', 'Verify (tests + types)', 'Open PR', 'Trust receipt'];

/** Render the self-contained demo page. PURE. */
export function buildMaintainDemoHtml(): string {
  const stepFlow = STEPS.map((s, i) => `<div class="step"><span class="n">${i + 1}</span>${s}</div>${i < STEPS.length - 1 ? '<div class="arr">→</div>' : ''}`).join('');
  const scopeCards = SCOPES.map(s => `<div class="scope"><b>${s.name}</b><span>${s.blurb}</span></div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QodeX — Maintain in action</title><style>
  :root{--bg:#0b0e14;--panel:#131722;--line:#222838;--ink:#e6e9ef;--dim:#8a93a6;--accent:#7c9cff;--green:#5be3a7;--amber:#ffcf6b}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
  .wrap{max-width:900px;margin:0 auto;padding:48px 24px}
  h1{font-size:38px;margin:0 0 8px;background:linear-gradient(90deg,#7c9cff,#5be3a7);-webkit-background-clip:text;background-clip:text;color:transparent}
  .lead{color:var(--dim);font-size:18px;margin:0 0 36px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px;margin-bottom:20px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:0 0 16px}
  .flow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
  .step{display:flex;align-items:center;gap:8px;background:#1b2233;border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13px}
  .step .n{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--accent);color:#0b0e14;font-weight:700;font-size:11px}
  .arr{color:var(--dim)}
  .scopes{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .scope{background:#1b2233;border:1px solid var(--line);border-radius:10px;padding:12px}
  .scope b{color:var(--accent)}.scope span{display:block;color:var(--dim);font-size:13px;margin-top:3px}
  pre{margin:0;background:#0c0f17;border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--green)}
  .ok{color:var(--green)}.dim{color:var(--dim)}a{color:var(--accent)}
  @media(max-width:640px){.scopes{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
  <h1>A codebase that improves itself</h1>
  <p class="lead">Every night, QodeX uses its <b>code graph</b> to find one safe improvement, <b>verifies</b> it, and leaves you a <b>pull request you can trust</b> — or a receipt explaining why it safely did nothing. Autonomy you can audit, not a confident lie.</p>

  <div class="panel"><h2>The nightly loop</h2><div class="flow">${stepFlow}</div></div>

  <div class="panel"><h2>Scopes — each conservative + provable</h2><div class="scopes">${scopeCards}</div></div>

  <div class="panel"><h2>What lands in your inbox — a trust receipt</h2>
    <pre>✅ QodeX schedule: nightly-tidy   ·   maintain · unused-imports
🧾 Receipt
status: ✅ opened
PR: https://github.com/you/app/pull/318
verified: ✓ npm test · ✓ tsc
files: src/auth/session.ts, src/auth/jwt.ts</pre>
    <p class="dim" style="margin:12px 0 0">The <b>filesChanged</b> and <b>verification</b> are measured by QodeX from a real git diff + the checkers it ran — the model can’t fabricate a green receipt.</p>
  </div>

  <div class="panel"><h2>Proven on QodeX itself</h2>
    <p>This isn’t a mockup. The <span class="mono">maintain</span> loop has already cleaned this very codebase via verified PRs — 6 unused imports, then 4 unused consts (with the side-effect gate blocking 6 risky ones). The guardrails ran while no one was watching.</p>
    <p class="dim">Why a code-graph-less agent can’t copy this: it can’t prove an item is unused, can’t verify before shipping, and can’t produce a receipt of what actually ran.</p>
  </div>

  <p class="dim" style="text-align:center;margin-top:32px">qodex schedule add --recipe maintain --prompt "unused-imports" --deliver telegram:&lt;id&gt;</p>
</div></body></html>`;
}

export async function runMaintainDemo(): Promise<string> {
  const { QODEX_HOME } = await import('../config/defaults.js');
  const { ensureQodexHome } = await import('../config/loader.js');
  await ensureQodexHome().catch(() => {});
  const out = path.join(QODEX_HOME, 'maintain-demo.html');
  await fs.writeFile(out, buildMaintainDemoHtml());
  try { const { openUrl } = await import('../artifacts/open-browser.js'); await openUrl('file://' + out); } catch { /* best-effort */ }
  return out;
}
