/**
 * Tests for the partial model-matching logic added to RouterCore.resolveModel /
 * matchModelCandidates. Pure replication of the algorithm (the method only reads
 * a Map<string,{provider,info}>), so it runs without the full router/deps.
 * Run: node --experimental-strip-types test/model-resolve.test.ts
 */
type Info = { id: string };
type Val = { provider: { name: string }; info: Info };

function matchModelCandidates(index: Map<string, Val>, query: string): Val[] {
  const q = query.toLowerCase();
  const distinct = new Map<string, Val>();
  for (const val of index.values()) distinct.set(`${val.provider.name}/${val.info.id}`, val);
  const prefix: Val[] = [];
  const substr: Val[] = [];
  for (const val of distinct.values()) {
    const id = val.info.id.toLowerCase();
    const full = `${val.provider.name}/${val.info.id}`.toLowerCase();
    if (id.startsWith(q) || full.startsWith(q)) prefix.push(val);
    else if (id.includes(q) || full.includes(q)) substr.push(val);
  }
  return prefix.length > 0 ? prefix : substr;
}

// Build an index the way the router does: each model under `${provider}/${id}` AND `${id}`.
function buildIndex(models: Array<{ provider: string; id: string }>): Map<string, Val> {
  const m = new Map<string, Val>();
  for (const { provider, id } of models) {
    const val: Val = { provider: { name: provider }, info: { id } };
    m.set(`${provider}/${id}`, val);
    m.set(id, val);
  }
  return m;
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— partial model matching —');
{
  const idx = buildIndex([
    { provider: 'ollama', id: 'qwen2.5-coder:32b' },
    { provider: 'ollama', id: 'llama3.1:8b' },
    { provider: 'anthropic', id: 'claude-sonnet-4-6' },
  ]);

  const m1 = matchModelCandidates(idx, 'qwen2.5');
  check('the reported bug: "qwen2.5" → unique match qwen2.5-coder:32b',
    m1.length === 1 && m1[0]!.info.id === 'qwen2.5-coder:32b');

  check('case-insensitive: "QWEN2.5" matches too',
    matchModelCandidates(idx, 'QWEN2.5').length === 1);

  check('provider-qualified partial: "ollama/qwen" → qwen2.5-coder',
    matchModelCandidates(idx, 'ollama/qwen').length === 1);

  check('substring fallback: "sonnet" → claude-sonnet-4-6',
    (() => { const r = matchModelCandidates(idx, 'sonnet'); return r.length === 1 && r[0]!.info.id === 'claude-sonnet-4-6'; })());

  check('no match: "gpt-4o" → []', matchModelCandidates(idx, 'gpt-4o').length === 0);
}

console.log('— ambiguity is NOT silently resolved —');
{
  const idx = buildIndex([
    { provider: 'ollama', id: 'qwen2.5-coder:32b' },
    { provider: 'ollama', id: 'qwen2.5-coder:7b' },
  ]);
  const m = matchModelCandidates(idx, 'qwen2.5');
  check('"qwen2.5" matching two models returns BOTH (caller errors, never guesses)', m.length === 2);
  check('but the exact full id still uniquely resolves',
    matchModelCandidates(idx, 'qwen2.5-coder:7b').length === 1);
}

console.log('— prefix beats substring —');
{
  const idx = buildIndex([
    { provider: 'ollama', id: 'coder-special:7b' },   // prefix match for "coder"
    { provider: 'ollama', id: 'qwen2.5-coder:32b' },  // substring match for "coder"
  ]);
  const m = matchModelCandidates(idx, 'coder');
  check('"coder" prefers the prefix match, ignoring the substring one',
    m.length === 1 && m[0]!.info.id === 'coder-special:7b');
}

console.log('— defaults.provider breaks ties for a bare model id (regression) —');
{
  // Faithful replication of RouterCore.resolveModel (exact path) + the new
  // resolvePreferringDefaultProvider tie-break.
  const resolveExact = (index: Map<string, Val>, modelId: string, providers: Set<string>) => {
    const direct = index.get(modelId);
    if (!direct) return null;
    let resolvedId = modelId;
    if (modelId.includes('/')) {
      const [first, ...rest] = modelId.split('/');
      if (first && providers.has(first)) resolvedId = rest.join('/');
    }
    return { provider: direct.provider, resolvedId };
  };
  const resolvePreferringDefault = (index: Map<string, Val>, modelId: string, defProvider: string, providers: Set<string>) => {
    if (!modelId.includes('/')) {
      const q = resolveExact(index, `${defProvider}/${modelId}`, providers);
      if (q) return q;
    }
    return resolveExact(index, modelId, providers);
  };

  // Two providers serve glm-5.2; api-203668-xyz registers LAST so it owns the bare key.
  const idx = buildIndex([
    { provider: 'glm', id: 'glm-5.2' },
    { provider: 'api-203668-xyz', id: 'glm-5.2' },
  ]);
  const providers = new Set(['glm', 'api-203668-xyz']);

  check('the bug: bare "glm-5.2" resolves to the LAST-registered provider',
    resolveExact(idx, 'glm-5.2', providers)!.provider.name === 'api-203668-xyz');

  const r = resolvePreferringDefault(idx, 'glm-5.2', 'glm', providers)!;
  check('defaults.provider=glm wins the tie', r.provider.name === 'glm' && r.resolvedId === 'glm-5.2');

  const r2 = resolvePreferringDefault(idx, 'glm-5.2', 'ollama', providers)!;
  check('falls back to plain resolution when default provider lacks the model',
    r2.provider.name === 'api-203668-xyz');

  const r3 = resolvePreferringDefault(idx, 'glm/glm-5.2', 'api-203668-xyz', providers)!;
  check('an explicit provider/model is never overridden by the default',
    r3.provider.name === 'glm');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
