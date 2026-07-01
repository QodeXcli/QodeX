/**
 * `qodex maintain-demo` — a self-contained marketing/demo page for "Maintain in action": the
 * nightly self-improvement loop, told visually. buildMaintainDemoHtml is PURE (no data, no I/O)
 * so it's unit-testable; runMaintainDemo writes + opens it.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

interface ScopeDemo { name: string; blurb: string; verdict: 'opened' | 'blocked'; receipt: string }
const SCOPES: ScopeDemo[] = [
  { name: 'dead-code', blurb: 'remove one provably-unused item (zero references — or it blocks)', verdict: 'opened',
    receipt: 'status: ✅ opened\nPR: https://github.com/you/app/pull/311\nverified: ✓ npm test · ✓ tsc\nfiles: src/legacy/formatLegacyDate.ts' },
  { name: 'unused-imports', blurb: 'drop import bindings referenced zero times; never side-effect imports', verdict: 'opened',
    receipt: 'status: ✅ opened\nPR: https://github.com/you/app/pull/318\nverified: ✓ npm test · ✓ tsc\nfiles: src/auth/session.ts, src/auth/jwt.ts' },
  { name: 'unused-locals', blurb: 'remove unused consts — only side-effect-free initializers', verdict: 'blocked',
    receipt: 'status: ⛔ blocked\nverified: (no change shipped)\nreason: only candidate had a side-effect initializer (await loadConfig()) — kept it' },
  { name: 'unused-params', blurb: 'prefix `_` (never remove — signatures stay intact)', verdict: 'opened',
    receipt: 'status: ✅ opened\nPR: https://github.com/you/app/pull/322\nverified: ✓ npm test · ✓ tsc\nfiles: src/handlers/webhook.ts  (req → _req)' },
  { name: 'lint-fix', blurb: 'the linter’s autofixable rules only, bounded to a focus', verdict: 'opened',
    receipt: 'status: ✅ opened\nPR: https://github.com/you/app/pull/327\nverified: ✓ eslint · ✓ npm test\nfiles: src/ui/Button.tsx, src/ui/Card.tsx' },
  { name: 'dep-bump', blurb: 'one patch/minor bump, shipped only if the full suite passes', verdict: 'opened',
    receipt: 'status: ✅ opened\nPR: https://github.com/you/app/pull/331\nverified: ✓ npm test (full suite)\nfiles: package.json  (zod 3.22.4 → 3.23.8)' },
  { name: 'consolidate-dupes', blurb: 'merge ONE exact-duplicate helper pair — code-graph proves every caller', verdict: 'opened',
    receipt: 'status: ✅ opened\nPR: https://github.com/you/app/pull/338\nverified: ✓ npm test · ✓ tsc\nfiles: src/format.ts (removed dup toKebab → src/util/case.ts), src/routes/api.ts' },
];

const STEPS = ['Code-graph analysis', 'Prove safe (or block)', 'Sandbox branch', 'Verify (tests + types)', 'Open PR', 'Trust receipt'];
const DEFAULT_RECEIPT = SCOPES[1]!.receipt; // unused-imports (opened)

/** Render the self-contained, interactive demo page. PURE (no data, no I/O). */
export function buildMaintainDemoHtml(): string {
  const stepFlow = STEPS.map((s, i) => `<div class="step" data-step="${i}"><span class="n">${i + 1}</span>${s}</div>${i < STEPS.length - 1 ? '<div class="arr">→</div>' : ''}`).join('');
  const scopeCards = SCOPES.map((s, i) => `<button class="scope${i === 1 ? ' sel' : ''}" data-scope="${i}"><b>${s.name}</b> <i class="tag ${s.verdict}">${s.verdict === 'opened' ? 'PR' : 'safe-block'}</i><span>${s.blurb}</span></button>`).join('');
  const scopeData = JSON.stringify(SCOPES.map(s => ({ n: s.name, v: s.verdict, r: s.receipt })));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QodeX — Maintain in action</title><style>
  :root{--bg:#0b0e14;--panel:#131722;--line:#222838;--ink:#e6e9ef;--dim:#8a93a6;--accent:#7c9cff;--green:#5be3a7;--amber:#ffcf6b}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
  .wrap{max-width:900px;margin:0 auto;padding:48px 24px}
  h1{font-size:38px;margin:0 0 8px;background:linear-gradient(90deg,#7c9cff,#5be3a7);-webkit-background-clip:text;background-clip:text;color:transparent}
  .lead{color:var(--dim);font-size:18px;margin:0 0 36px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px;margin-bottom:20px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:0 0 16px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px}.row h2{margin:0}
  button.play{background:var(--accent);color:#0b0e14;border:0;border-radius:9px;padding:8px 14px;font-weight:700;cursor:pointer;font-size:13px}
  button.play:disabled{opacity:.5;cursor:default}
  .flow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
  .step{display:flex;align-items:center;gap:8px;background:#1b2233;border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13px;opacity:.5;transition:.25s}
  .step .n{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--accent);color:#0b0e14;font-weight:700;font-size:11px}
  .step.active{opacity:1;border-color:var(--accent);box-shadow:0 0 0 2px rgba(124,156,255,.25)}
  .step.done{opacity:1}.step.done .n{background:var(--green)}
  .arr{color:var(--dim)}
  .scopes{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .scope{text-align:left;background:#1b2233;border:1px solid var(--line);border-radius:10px;padding:12px;cursor:pointer;color:var(--ink);font:inherit;transition:.18s}
  .scope:hover{border-color:var(--accent)}.scope.sel{border-color:var(--accent);box-shadow:0 0 0 2px rgba(124,156,255,.25)}
  .scope b{color:var(--accent)}.scope span{display:block;color:var(--dim);font-size:13px;margin-top:3px}
  .tag{font-style:normal;font-size:10px;font-weight:700;padding:1px 6px;border-radius:20px;vertical-align:middle}
  .tag.opened{background:rgba(91,227,167,.16);color:var(--green)}.tag.blocked{background:rgba(255,207,107,.16);color:var(--amber)}
  pre{margin:0;background:#0c0f17;border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--green);min-height:120px}
  pre.blocked{color:var(--amber)}
  .ok{color:var(--green)}.dim{color:var(--dim)}a{color:var(--accent)}
  @media(max-width:640px){.scopes{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
  <h1>A codebase that improves itself</h1>
  <p class="lead">Every night, QodeX uses its <b>code graph</b> to find one safe improvement, <b>verifies</b> it, and leaves you a <b>pull request you can trust</b> — or a receipt explaining why it safely did nothing. Autonomy you can audit, not a confident lie.</p>

  <div class="panel"><div class="row"><h2>The nightly loop</h2><button class="play" id="play">▶ Play the nightly run</button></div><div class="flow" id="flow">${stepFlow}</div></div>

  <div class="panel"><h2>Pick a scope — watch the decision (each conservative + provable)</h2><div class="scopes" id="scopes">${scopeCards}</div></div>

  <div class="panel"><h2>What lands in your inbox — a trust receipt</h2>
    <pre id="receipt">✅ QodeX schedule: nightly-tidy   ·   maintain · <span id="rscope">unused-imports</span>
🧾 Receipt
${DEFAULT_RECEIPT}</pre>
    <p class="dim" style="margin:12px 0 0">The <b>filesChanged</b> and <b>verification</b> are measured by QodeX from a real git diff + the checkers it ran — the model can’t fabricate a green receipt. Click <b>unused-locals</b> above to see a <span style="color:var(--amber)">safe block</span>: when it can’t prove safety, it ships nothing and tells you why.</p>
  </div>

  <div class="panel"><h2>Proven on QodeX itself</h2>
    <p>This isn’t a mockup. The <span class="mono">maintain</span> loop has already cleaned this very codebase via verified PRs — 6 unused imports, then 4 unused consts (with the side-effect gate blocking 6 risky ones). The guardrails ran while no one was watching.</p>
    <p class="dim">Why a code-graph-less agent can’t copy this: it can’t prove an item is unused, can’t verify before shipping, and can’t produce a receipt of what actually ran.</p>
  </div>

  <p class="dim" style="text-align:center;margin-top:32px">qodex schedule add --recipe maintain --prompt "unused-imports" --deliver telegram:&lt;id&gt;</p>
</div>
<script>
(function(){
  var SCOPES=${scopeData};
  var steps=[].slice.call(document.querySelectorAll('.step'));
  var play=document.getElementById('play');
  var receipt=document.getElementById('receipt'), rscope=document.getElementById('rscope');
  var sel=1, timer=null;
  function showScope(i){
    sel=i; var s=SCOPES[i];
    [].forEach.call(document.querySelectorAll('.scope'),function(el,j){el.classList.toggle('sel',j===i);});
    rscope.textContent=s.n;
    receipt.firstChild.textContent='✅ QodeX schedule: nightly-tidy   ·   maintain · ';
    receipt.lastChild.textContent='\\n🧾 Receipt\\n'+s.r;
    receipt.classList.toggle('blocked',s.v==='blocked');
  }
  [].forEach.call(document.querySelectorAll('.scope'),function(el){el.addEventListener('click',function(){showScope(+el.getAttribute('data-scope'));});});
  function reset(){steps.forEach(function(s){s.classList.remove('active','done');});}
  function run(){
    if(timer)return; play.disabled=true; reset(); var i=0;
    timer=setInterval(function(){
      if(i>0)steps[i-1].classList.replace('active','done');
      if(i<steps.length){steps[i].classList.add('active');i++;}
      else{clearInterval(timer);timer=null;steps[steps.length-1].classList.add('done');play.disabled=false;showScope(sel);}
    },650);
  }
  play.addEventListener('click',run);
})();
</script>
</body></html>`;
}

/** Render the same "Maintain in action" story as shareable Markdown (README / blog / PR). PURE. */
export function buildMaintainDemoMarkdown(): string {
  const steps = STEPS.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const scopeRows = SCOPES.map(s => `| \`${s.name}\` | ${s.blurb} | ${s.verdict === 'opened' ? 'opens a PR' : 'safe-block'} |`).join('\n');
  const receiptEg = SCOPES[1]!.receipt;
  return `# QodeX — a codebase that improves itself

Every night, QodeX uses its **code graph** to find one safe improvement, **verifies** it, and
leaves you a **pull request you can trust** — or a receipt explaining why it safely did nothing.
Autonomy you can audit, not a confident lie.

## The nightly loop

${steps}

## Scopes — each conservative + provable

| Scope | What it does | Verdict |
|-------|--------------|---------|
${scopeRows}

## What lands in your inbox — a trust receipt

\`\`\`
✅ QodeX schedule: nightly-tidy   ·   maintain · unused-imports
🧾 Receipt
${receiptEg}
\`\`\`

The **filesChanged** and **verification** are measured by QodeX from a real git diff + the
checkers it ran — the model can't fabricate a green receipt. When a scope can't prove safety
(e.g. \`unused-locals\` finds only a side-effect initializer) it ships nothing and tells you why.

## Why a code-graph-less agent can't copy this

It can't prove an item is unused, can't verify before shipping, and can't produce a receipt of
what actually ran. That verify-or-block gate — running while no one is watching — is the moat.

> Get started: \`qodex schedule add --recipe maintain --prompt "unused-imports" --deliver telegram:<id>\`
`;
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
