/**
 * Regression tests for capability-tiered system prompt (src/llm/prompts/system.ts).
 * The module has a runtime .js import that strip-types can't resolve, so we verify
 * the pure string-assembly behavior by extracting the two Core Principles blocks
 * from source. The critical guarantee: WEAK/LOCAL models keep the FULL prompt.
 * Run: node --experimental-strip-types test/prompt-tiering.test.ts
 */
import { readFileSync } from 'fs';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const src = readFileSync(new URL('../src/llm/prompts/system.ts', import.meta.url), 'utf-8');

const terseM = /if \(capable\) sections\.push\(`(# Core Principles[\s\S]*?)(?<!\\)`\);/.exec(src);
const fullM = /if \(!capable\) sections\.push\(`(# Core Principles[\s\S]*?)(?<!\\)`\);/.exec(src);
const terse = terseM?.[1] ?? '';
const full = fullM?.[1] ?? '';

console.log('— both variants exist and are gated correctly —');
check('capable → terse Core Principles exists', terse.length > 0);
check('non-capable → full Core Principles exists', full.length > 0);
check('terse is materially smaller', terse.length > 0 && full.length > 0 && terse.length < full.length * 0.5);

console.log('— terse keeps ALL 10 principles (no behavior dropped, only examples) —');
for (const n of ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '7b.', '8.', '9.', '10.']) {
  check(`terse has principle ${n}`, terse.includes(`\n${n}`) || terse.startsWith(n));
}

console.log('— terse keeps the key tool names (capable models still know the tools) —');
for (const tool of ['edit_symbol', 'read_file', 'shell', 'task', 'project_overview', 'analyze_impact', 'present_plan', 'safe_rename', 'safe_delete_file', 'find_dead_code', 'orchestrate']) {
  check(`terse names ${tool}`, terse.includes(tool));
}

console.log('— delegation principle survives in terse (it is the token lever) —');
check('terse mentions SEPARATE context window', terse.includes('SEPARATE context window'));
check('terse warns against single-file delegation', terse.toLowerCase().includes('single-file'));

console.log('— ZERO REGRESSION: weak/local full prompt is unchanged (still has examples) —');
check('full keeps the delegate examples block', full.includes('Examples that SHOULD delegate'));
check('full keeps the read_file truncation note', full.includes('chars omitted — agent sees full result'));
check('full keeps the architect enforcement note', full.includes('gently blocked once until a plan exists'));

console.log('— gemini is now a recognized (capable) family —');
check('detectModelFamily maps gemini', /lower\.includes\('gemini'\)\) return 'gemini'/.test(src));
check('capable flag includes gemini', /modelFamily === 'gemini'/.test(src));
check('capable flag includes claude + gpt', /modelFamily === 'claude'/.test(src) && /modelFamily === 'gpt'/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
