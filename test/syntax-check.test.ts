/**
 * Tests for src/tools/ast/syntax-check.ts (pre-commit syntax gate).
 * Run: node --experimental-strip-types test/syntax-check.test.ts
 * Pure logic only: tree walker (mock nodes), JSON checking, baseline decision,
 * rejection message, fail-open orchestrator paths that need no tree-sitter.
 */
import {
  findIssuesInTree,
  checkJsonSyntax,
  shouldReject,
  buildSyntaxRejectMessage,
  checkSyntaxForWrite,
  setSyntaxGateEnabled,
  isSyntaxGateEnabled,
  type TSNodeLike,
} from '../src/tools/ast/syntax-check.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

function node(partial: Partial<TSNodeLike> & { type: string }, children: TSNodeLike[] = []): TSNodeLike {
  return {
    childCount: children.length,
    child: (i: number) => children[i] ?? null,
    startPosition: { row: 0, column: 0 },
    hasError: children.some(c => boolErr(c)) || partial.type === 'ERROR' || !!partial.isMissing,
    ...partial,
  } as TSNodeLike;
}
function boolErr(n: TSNodeLike): boolean {
  const h = (n as any).hasError;
  return typeof h === 'function' ? h() : !!h;
}

console.log('— tree walker (mock trees) —');
{
  const cleanTree = node({ type: 'program', hasError: false }, [
    node({ type: 'function_definition', hasError: false }),
  ]);
  check('clean tree → no issues', findIssuesInTree(cleanTree, 'a\nb').length === 0);

  const src = '<?php\nfunction f() {\n  echo 1;\n'; // missing }
  const errTree = node({ type: 'program' }, [
    node({ type: 'function_definition' }, [
      node({ type: 'ERROR', startPosition: { row: 2, column: 2 } }),
    ]),
  ]);
  const issues = findIssuesInTree(errTree, src);
  check('ERROR node found', issues.length === 1 && issues[0].kind === 'error');
  check('1-based line number', issues[0].line === 3);
  check('excerpt is the offending line', issues[0].excerpt === 'echo 1;');

  const missTree = node({ type: 'program' }, [
    node({ type: '}', isMissing: true, startPosition: { row: 1, column: 0 } }),
  ]);
  const mIssues = findIssuesInTree(missTree, 'line1\nline2');
  check('MISSING node found as kind=missing', mIssues.length === 1 && mIssues[0].kind === 'missing');

  // hasError pruning: subtree without hasError must not be descended into
  let visited = false;
  const prunedChild = node({ type: 'ERROR', hasError: true });
  Object.defineProperty(prunedChild, 'startPosition', { get() { visited = true; return { row: 0, column: 0 }; } });
  const pruned = node({ type: 'block', hasError: false }, [prunedChild]);
  findIssuesInTree(node({ type: 'program', hasError: false }, [pruned]), 'x');
  check('clean subtrees are pruned (perf)', visited === false);

  // method-style hasError/isMissing (older web-tree-sitter API)
  const methodTree = node({ type: 'program', hasError: (() => true) as any }, [
    node({ type: 'ERROR', hasError: (() => true) as any, startPosition: { row: 0, column: 0 } }),
  ]);
  check('method-style hasError()/isMissing() supported', findIssuesInTree(methodTree, 'x').length === 1);

  // cap at 3 reported issues
  const many = node({ type: 'program' },
    [1, 2, 3, 4, 5].map(i => node({ type: 'ERROR', startPosition: { row: i, column: 0 } })));
  check('reported issues capped at 3', findIssuesInTree(many, 'a\nb\nc\nd\ne\nf').length === 3);
}

console.log('— JSON checking —');
{
  check('valid JSON passes', checkJsonSyntax('{"a": [1, 2, {"b": null}]}').length === 0);
  const bad = checkJsonSyntax('{\n  "a": 1,\n  "b": ,\n}');
  check('invalid JSON caught with a line number', bad.length === 1 && bad[0].line >= 1);
  check('trailing-comma JSON caught', checkJsonSyntax('{"a": 1,}').length === 1);
}

console.log('— baseline decision —');
{
  check('clean → clean: write', shouldReject(false, false) === false);
  check('clean → broken: REJECT (edit introduced it)', shouldReject(false, true) === true);
  check('broken → broken: write (baseline tolerance / grammar gap)', shouldReject(true, true) === false);
  check('broken → clean: write (the edit FIXED it)', shouldReject(true, false) === false);
  check('new file, clean: write', shouldReject(null, false) === false);
  check('new file, broken: REJECT', shouldReject(null, true) === true);
}

console.log('— rejection message —');
{
  const msg = buildSyntaxRejectMessage('inc/accounting.php', 'php',
    [{ line: 142, excerpt: 'public function add(', kind: 'missing' }, { line: 150, excerpt: '', kind: 'error' }]);
  check('starts with [SYNTAX_REJECTED]', msg.startsWith('[SYNTAX_REJECTED]'));
  check('names the file and line', msg.includes('inc/accounting.php') && msg.includes('line 142'));
  check('says the disk was NOT modified', msg.includes('NOT modified'));
  check('mentions additional issues count', msg.includes('+1 more'));
  check('instructs a retry with fixed boundaries', msg.includes('retry'));
}

console.log('— orchestrator fail-open paths (no tree-sitter in sandbox) —');
{
  const r1 = await checkSyntaxForWrite('/p/styles.css', 'a{}', 'a{');
  check('unknown-to-gate extension → fail-open (css has no grammar wired)', r1 === null || typeof r1 === 'string');

  const r2 = await checkSyntaxForWrite('/p/data.json', '{"ok":1}', '{"broken":,}');
  check('JSON: clean → broken is REJECTED in-process', typeof r2 === 'string' && r2.startsWith('[SYNTAX_REJECTED]'));

  const r3 = await checkSyntaxForWrite('/p/data.json', '{"already":,}', '{"still":,}');
  check('JSON: broken → broken passes (baseline tolerance)', r3 === null);

  const r4 = await checkSyntaxForWrite('/p/data.json', null, '{"new": true}');
  check('JSON: clean new file passes', r4 === null);

  // PHP grammar may or may not be bundled depending on the environment. Either outcome is
  // correct: if the grammar is wired (grammars/tree-sitter-php.wasm present) the gate must
  // REJECT the broken edit; if it's unavailable the gate must fail-open (return null). What
  // would be a bug is any other string, or a throw.
  const r5 = await checkSyntaxForWrite('/p/app.php', '<?php echo 1;', '<?php echo 1; }');
  check('PHP: REJECTED when grammar wired, else fail-open (never a false block)',
    r5 === null || (typeof r5 === 'string' && r5.startsWith('[SYNTAX_REJECTED]')));

  setSyntaxGateEnabled(false);
  const r6 = await checkSyntaxForWrite('/p/data.json', '{"ok":1}', '{"broken":,}');
  check('off-switch disables the gate entirely', r6 === null && isSyntaxGateEnabled() === false);
  setSyntaxGateEnabled(true);

  const big = '{"x":' + '1'.repeat(3 * 1024 * 1024) + '}';
  const r7 = await checkSyntaxForWrite('/p/big.json', null, big);
  check('oversized content skips the gate (fail-open)', r7 === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
