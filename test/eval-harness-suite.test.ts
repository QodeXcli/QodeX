/**
 * The deterministic harness suite, tested from BOTH directions.
 *
 * A check that cannot fail is decoration, and a suite of decorations is worse than no
 * suite at all — it manufactures confidence. So every task here is proved twice:
 *
 *   1. GREEN on the real harness (it reflects reality today), and
 *   2. RED when handed a deliberately broken harness (it would actually catch the
 *      regression it claims to catch).
 *
 * Plus: the suite is deterministic across runs, costs no model call, and a probe that
 * cannot run reports `skip` — never `pass`.
 */

import { describe, it, expect } from 'vitest';
import {
  createHarnessSuite, runSuite, DEFAULT_BUDGETS, CONTRADICTION_PAIRS, GATING_SCENARIOS,
  getSuite, listSuites, realProbes,
  type HarnessProbes, type HarnessSuiteOptions, type TaskResult,
} from '../src/eval/index.js';
import type { Message, ToolSchema } from '../src/llm/types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TIMEOUT = 60_000;

async function runAll(opts: HarnessSuiteOptions = {}) {
  return runSuite(createHarnessSuite(opts), { timeoutMs: TIMEOUT });
}

/** Run exactly one task and return its result. */
async function runOne(id: string, opts: HarnessSuiteOptions = {}): Promise<TaskResult> {
  const run = await runSuite(createHarnessSuite(opts), { timeoutMs: TIMEOUT, filter: { ids: [id] } });
  expect(run.results, `task ${id} not found in the suite`).toHaveLength(1);
  return run.results[0]!;
}

/** Assert a task goes RED when the harness is broken in the given way. */
async function expectFailsWith(id: string, probes: Partial<HarnessProbes>, opts: Omit<HarnessSuiteOptions, 'probes'> = {}) {
  const r = await runOne(id, { ...opts, probes });
  expect(r.status, `${id} should FAIL on a broken harness, got ${r.status} (${r.reason ?? r.detail})`).toBe('fail');
  expect(r.reason, `${id} must explain the failure`).toBeTruthy();
  return r;
}

const schema = (name: string, description: string): ToolSchema => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: {} } },
});

// ---------------------------------------------------------------------------
// the real harness
// ---------------------------------------------------------------------------

describe('harness suite — on the REAL harness', () => {
  it('every task passes, nothing is skipped, and it costs no model call', async () => {
    const run = await runAll();
    const bad = run.results.filter(r => r.status !== 'pass')
      .map(r => `${r.id}: ${r.status} — ${r.reason ?? ''}\n${r.detail ?? ''}`);
    expect(bad.join('\n\n')).toBe('');
    expect(run.summary.failed).toBe(0);
    // A skip here would mean a probe could not run — honest, but it means the property is
    // UNMEASURED, and the whole point is that this layer measures it for free.
    expect(run.summary.skipped).toBe(0);
    expect(run.summary.score0to100).toBe(100);
    expect(run.results.every(r => r.kind === 'deterministic')).toBe(true);
  }, TIMEOUT);

  it('covers every declared harness area', async () => {
    const run = await runAll();
    expect([...new Set(run.results.map(r => r.category))].sort())
      .toEqual(['cache', 'history', 'prompt', 'recovery', 'tool-surface']);
  }, TIMEOUT);

  it('every task reports a DETAIL string with the measured value', async () => {
    const run = await runAll();
    for (const r of run.results) {
      expect(r.detail, `${r.id} has no detail`).toBeTruthy();
      expect(r.detail!.length, `${r.id} detail is too thin to diagnose from`).toBeGreaterThan(20);
    }
  }, TIMEOUT);

  it('is deterministic — two runs produce identical statuses and metrics', async () => {
    const a = await runAll();
    const b = await runAll();
    const shape = (run: typeof a) => run.results.map(r => ({ id: r.id, status: r.status, metrics: r.metrics }));
    expect(shape(b)).toEqual(shape(a));
    // ...and repeating a task within one run must not make it flaky.
    const rep = await runSuite(createHarnessSuite(), { timeoutMs: TIMEOUT, repeat: 2 });
    expect(rep.results.filter(r => r.flaky).map(r => r.id)).toEqual([]);
  }, TIMEOUT);

  it('is registered as a free suite the runner can look up by name', async () => {
    const entry = listSuites().find(s => s.name === 'harness');
    expect(entry?.free).toBe(true);
    const suite = getSuite('harness');
    expect(suite?.name).toBe('harness');
    expect(suite!.tasks.length).toBeGreaterThan(10);
    expect(getSuite('does-not-exist')).toBeNull();
  });

  it('measures the real harness within declared budgets, with headroom', async () => {
    const run = await runAll();
    const byId = new Map(run.results.map(r => [r.id, r]));
    const tools = byId.get('tools.definition-budget')!;
    expect(tools.metrics.toolCount).toBeGreaterThan(50);
    expect(tools.metrics.toolTokens).toBeGreaterThan(1_000);
    expect(tools.metrics.toolTokens).toBeLessThanOrEqual(DEFAULT_BUDGETS.toolTokensNormal);
    const prompt = byId.get('prompt.token-budget')!;
    expect(prompt.metrics.promptTokens_normal_compressed).toBeLessThan(prompt.metrics.promptTokens_normal_full!);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// FAILABILITY — the part that makes the suite worth having
// ---------------------------------------------------------------------------

describe('tool-surface tasks fail on a broken harness', () => {
  it('definition-budget fails when the tool block bloats', async () => {
    const real = realProbes();
    const r = await expectFailsWith('tools.definition-budget', {
      toolSchemas: mode => real.toolSchemas(mode).map(s => ({
        ...s,
        function: { ...s.function, description: s.function.description + ' '.padEnd(4_000, 'bloat ') },
      })),
    });
    expect(r.metrics.toolTokens).toBeGreaterThan(DEFAULT_BUDGETS.toolTokensNormal);
    expect(r.detail).toContain('vs budget');
  }, TIMEOUT);

  it('gating-keeps-essentials fails when the gate drops the edit tool', async () => {
    const real = realProbes();
    const r = await expectFailsWith('tools.gating-keeps-essentials', {
      gateSchemas: (schemas, signal) =>
        real.gateSchemas(schemas, signal).filter(s => s.function.name !== 'edit_text'),
    });
    expect(r.reason).toContain('edit_text');
  }, TIMEOUT);

  it('gating-keeps-essentials fails when the gate stops gating (payload over budget)', async () => {
    const r = await expectFailsWith('tools.gating-keeps-essentials', { gateSchemas: schemas => schemas });
    expect(r.reason).toMatch(/exceeds the .* budget/);
  }, TIMEOUT);

  it('description-ambiguity fails on two tools that describe themselves identically', async () => {
    const real = realProbes();
    const dupe = 'Run a shell command in the project working directory and return combined stdout and stderr output.';
    const r = await expectFailsWith('tools.description-ambiguity', {
      toolSchemas: mode => [...real.toolSchemas(mode), schema('run_cmd', dupe), schema('exec_cmd', dupe)],
    });
    expect(r.metrics.maxSimilarity).toBeGreaterThan(DEFAULT_BUDGETS.maxDescriptionSimilarity);
    expect(r.reason).toContain('run_cmd');
  }, TIMEOUT);

  it('schema-validity fails on an empty description', async () => {
    const real = realProbes();
    const r = await expectFailsWith('tools.schema-validity', {
      toolSchemas: mode => [...real.toolSchemas(mode), schema('ghost_tool', '   ')],
    });
    expect(r.detail).toContain('ghost_tool: empty description');
  }, TIMEOUT);

  it('schema-validity fails on a malformed parameter schema', async () => {
    const real = realProbes();
    const r = await expectFailsWith('tools.schema-validity', {
      toolSchemas: mode => [
        ...real.toolSchemas(mode),
        {
          type: 'function',
          function: {
            name: 'bad_schema_tool',
            description: 'looks fine',
            parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'nope'] },
          },
        } as unknown as ToolSchema,
      ],
    });
    expect(r.detail).toContain('required names not in properties: nope');
  }, TIMEOUT);
});

describe('prompt tasks fail on a broken harness', () => {
  it('token-budget fails when the prompt bloats', async () => {
    const real = realProbes();
    const r = await expectFailsWith('prompt.token-budget', {
      buildPrompt: ctx => real.buildPrompt(ctx) + '\n' + 'filler sentence about nothing. '.repeat(4_000),
    });
    expect(r.reason).toContain('over budget');
  }, TIMEOUT);

  it('no-contradiction fails when a declared contradiction is reintroduced', async () => {
    const real = realProbes();
    const r = await expectFailsWith('prompt.no-contradiction', {
      buildPrompt: ctx => real.buildPrompt(ctx) + '\n\nYou are Claude, made by Anthropic.',
    });
    expect(r.reason).toContain('identity');
    expect(r.metrics.contradictionsFound).toBeGreaterThan(0);
  }, TIMEOUT);

  it('no-contradiction fails on a reversed tool preference', async () => {
    const real = realProbes();
    await expectFailsWith('prompt.no-contradiction', {
      buildPrompt: ctx => real.buildPrompt(ctx) + '\n\nAlways prefer `edit_text` over `edit_symbol`.',
    });
  }, TIMEOUT);

  it('no-phantom-tools fails on the exact bug class this repo hit twice (edit_file)', async () => {
    const real = realProbes();
    const r = await expectFailsWith('prompt.no-phantom-tools', {
      buildPrompt: ctx => real.buildPrompt(ctx) + '\n\nTo change code, call `edit_file` with the old and new strings.',
    });
    expect(r.reason).toContain('edit_file');
    expect(r.metrics.phantomToolRefs).toBeGreaterThan(0);
  }, TIMEOUT);

  it('no-phantom-tools does NOT flag family references or ordinary snake_case prose', async () => {
    const real = realProbes();
    const r = await runOne('prompt.no-phantom-tools', {
      probes: {
        buildPrompt: ctx =>
          real.buildPrompt(ctx) +
          '\n\nUse the code_graph family for symbol lookups. The package_manager and type_checker are auto-detected.',
      },
    });
    expect(r.status).toBe('pass');
  }, TIMEOUT);
});

describe('cache tasks fail on a broken harness', () => {
  it('prefix-byte-stable fails when prompt assembly is non-deterministic', async () => {
    const real = realProbes();
    let n = 0;
    const r = await expectFailsWith('cache.prefix-byte-stable', {
      buildPrompt: ctx => real.buildPrompt(ctx) + `\n<!-- build ${n++} -->`,
    });
    expect(r.reason).toContain('not byte-stable');
  }, TIMEOUT);

  it('prefix-byte-stable fails when the tool list stops being sorted deterministically', async () => {
    const real = realProbes();
    let flip = false;
    await expectFailsWith('cache.prefix-byte-stable', {
      toolSchemas: mode => {
        const s = real.toolSchemas(mode);
        flip = !flip;
        return flip ? s : s.slice().reverse();
      },
    });
  }, TIMEOUT);

  it('volatile-sections-last fails when the directory tree moves to the top', async () => {
    const r = await expectFailsWith('cache.volatile-sections-last', {
      buildPrompt: ctx =>
        `# Directory Tree\n\`\`\`\n${ctx.directoryTree}\n\`\`\`\n\n` +
        `# Environment\ncwd: ${ctx.cwd}\n\n# Core Principles\nread before write\n\n` +
        `task class: ${ctx.taskClass ?? 'general'}`,
    });
    expect(r.reason).toContain('precedes # Environment');
  }, TIMEOUT);

  it('volatile-sections-last fails when the per-message addendum moves ahead of the tree', async () => {
    const r = await expectFailsWith('cache.volatile-sections-last', {
      buildPrompt: ctx =>
        `# Environment\ncwd: ${ctx.cwd}\n\n` +
        `# Task addendum for ${ctx.taskClass ?? 'general'}\nfocus accordingly\n\n` +
        `# Directory Tree\n\`\`\`\n${ctx.directoryTree}\n\`\`\``,
    });
    expect(r.reason).toMatch(/BEFORE the directory tree|diverges at byte/);
  }, TIMEOUT);

  it('breakpoint-layout fails when every tool gets a breakpoint (blows the 4-marker limit)', async () => {
    const real = realProbes();
    const r = await expectFailsWith('cache.breakpoint-layout', {
      cacheBreakpoints: (sys, msgs, tools, boundary) => {
        const out = real.cacheBreakpoints(sys, msgs, tools, boundary);
        return { ...out, tools: (tools ?? []).map(t => ({ ...(t as object), cache_control: { type: 'ephemeral' } })) };
      },
    });
    // The probe reports the measured layout, then names the specific defect. Assert on the
    // DEFECT (too many cached tool blocks), not on prose wording — the count is what matters.
    expect(r.detail).toMatch(/expected exactly 1 cached tool, got 2/);
    expect(r.detail).toMatch(/breakpoints:.*total=/);
  }, TIMEOUT);

  it('breakpoint-layout fails when the VOLATILE system tail gets cached', async () => {
    const real = realProbes();
    const r = await expectFailsWith('cache.breakpoint-layout', {
      cacheBreakpoints: (sys, msgs, tools, boundary) => {
        const out = real.cacheBreakpoints(sys, msgs, tools, boundary);
        const blocks = (out.system as any[]).map(b => ({ ...b, cache_control: { type: 'ephemeral' } }));
        return { ...out, system: blocks };
      },
    });
    expect(r.detail).toContain('VOLATILE system tail is cached');
  }, TIMEOUT);
});

describe('gating-follows-intent fails in BOTH directions', () => {
  it('fails when a natural phrasing loses the tool it needs', async () => {
    const real = realProbes();
    const r = await expectFailsWith('tools.gating-follows-intent', {
      // Simulate the old behaviour: artifact_* survives only if the word "artifact" is used.
      gateSchemas: (schemas, signal) =>
        real.gateSchemas(schemas, signal)
          .filter(s => !s.function.name.startsWith('artifact_') || /artifact/i.test(signal)),
    });
    expect(r.reason).toMatch(/lose the tool they need|artifact_create/);
  }, TIMEOUT);

  it('ALSO fails when gating stops trimming — passing must not be achievable by giving up', async () => {
    const r = await expectFailsWith('tools.gating-follows-intent', {
      gateSchemas: schemas => schemas, // every tool, every turn
    });
    expect(r.reason).toMatch(/stopped trimming/);
  }, TIMEOUT);

  it('passes on the real harness', async () => {
    const r = await runOne('tools.gating-follows-intent');
    expect(r.status).toBe('pass');
    expect(r.metrics.intentCasesKept).toBeGreaterThan(0);
  }, TIMEOUT);
});

describe('usage-calibration fails on a description with no exit criterion', () => {
  it('flags a ceremony tool that only says when TO use it', async () => {
    const r = await expectFailsWith('tools.usage-calibration', {
      toolSchemas: () => [
        schema('todo_write', 'Update the visible todo list. Use this to track multi-step work. Update frequently — after every meaningful step.'),
      ],
    });
    expect(r.reason).toMatch(/when NOT to use/i);
    // The unconditional imperative is called out too, since that is what drives over-use.
    expect(r.detail).toMatch(/unconditional/i);
  });

  it('passes once the description carries a threshold and an exclusion', async () => {
    const r = await runOne('tools.usage-calibration', {
      probes: {
        toolSchemas: () => [
          schema('todo_write', 'Track work with 3+ distinct steps. Do NOT use it for a single-file edit or anything you can finish in one pass.'),
        ],
      },
    });
    expect(r.status).toBe('pass');
  });

  it('accepts restraint phrased as a budget, not only as a prohibition', async () => {
    // `remember` says "Use SPARINGLY … should stay in conversation". An earlier version of
    // this probe missed that and flagged a description that was already correct.
    const r = await runOne('tools.usage-calibration', {
      probes: {
        toolSchemas: () => [
          schema('remember', 'Persist a fact across sessions. Use SPARINGLY: transient task details should stay in conversation.'),
        ],
      },
    });
    expect(r.status).toBe('pass');
  });

  it('ignores non-ceremony tools entirely', async () => {
    const r = await runOne('tools.usage-calibration', {
      probes: { toolSchemas: () => [schema('read_file', 'Read a file. Use it to read files.')] },
    });
    expect(r.status).toBe('pass'); // read_file is an action tool — over-use is not a concern
  });
});

describe('history tasks fail on a broken harness', () => {
  it('tool-call-pairing fails when a layer strands a tool_call (the bd62ab4 bug class)', async () => {
    const r = await expectFailsWith('history.tool-call-pairing', {
      // A pruner that drops tool RESULTS but keeps the assistant messages carrying their
      // tool_calls — precisely what OpenAI-format providers 400 on.
      loadPrune: async () => (messages: Message[]) =>
        messages.filter((m, i) => m.role !== 'tool' || i > messages.length - 3),
    });
    expect(r.reason).toMatch(/orphaned tool_call/);
  }, TIMEOUT);

  it('tool-call-pairing fails when the orphan repair stops repairing', async () => {
    const real = realProbes();
    await expectFailsWith('history.tool-call-pairing', {
      loadPrune: async () => (messages: Message[]) => messages.filter(m => m.role !== 'tool').slice(0, 4),
      repairOrphans: m => m,
      dedupHistory: real.dedupHistory,
    });
  }, TIMEOUT);

  it('tool-call-pairing fails (not passes) when a stage silently does nothing', async () => {
    // The vacuity guard: a no-op pruner would make the pairing assertion trivially true.
    const r = await expectFailsWith('history.tool-call-pairing', {
      loadPrune: async () => (messages: Message[]) => messages,
    });
    expect(r.reason).toContain('dropped nothing');
  }, TIMEOUT);

  it('tool-call-pairing SKIPS (never passes) when the real pruner cannot be loaded', async () => {
    const r = await runOne('history.tool-call-pairing', { probes: { loadPrune: async () => null } });
    expect(r.status).toBe('skip');
    expect(r.reason).toContain('NOT measured');
    // ...and an all-skip run scores 0, not 100 — a skip is never credited as a pass.
    const run = await runSuite(createHarnessSuite({ probes: { loadPrune: async () => null } }), {
      timeoutMs: TIMEOUT, filter: { ids: ['history.tool-call-pairing'] },
    });
    expect(run.summary.scored).toBe(0);
    expect(run.summary.score0to100).toBe(0);
  }, TIMEOUT);

  it('orphan-repair fails when the repair is a no-op', async () => {
    const r = await expectFailsWith('history.orphan-repair', { repairOrphans: m => m });
    expect(r.reason).toContain('orphaned tool_call');
  }, TIMEOUT);

  it('orphan-repair fails when the repair mutates a HEALTHY history', async () => {
    const real = realProbes();
    const r = await expectFailsWith('history.orphan-repair', {
      repairOrphans: msgs => [...real.repairOrphans(msgs), { role: 'system', content: 'spurious' } as Message],
    });
    expect(r.reason).toMatch(/exactly 1 synthetic result|MUTATED a healthy history/);
  }, TIMEOUT);

  it('compaction-preserves-goal fails when the goal never reaches the summarizer', async () => {
    const r = await expectFailsWith('history.compaction-preserves-goal', {
      compact: async (messages, summarize) => {
        await summarize([{ role: 'user', content: '(transcript redacted)' } as Message]);
        return { messages: messages.slice(-4), turnsCompacted: 3 };
      },
    });
    expect(r.reason).toContain('original goal');
  }, TIMEOUT);

  it('compaction-preserves-goal fails when the recent tail is not preserved verbatim', async () => {
    const real = realProbes();
    const r = await expectFailsWith('history.compaction-preserves-goal', {
      compact: async (messages, summarize) => {
        const out = await real.compact(messages, summarize);
        return {
          ...out,
          messages: out.messages.map(m =>
            m.role === 'assistant' ? ({ ...m, content: 'REWRITTEN' } as Message) : m),
        };
      },
    });
    expect(r.reason).toMatch(/not preserved verbatim|summary/);
  }, TIMEOUT);

  it('dedup-rewrites-only fails when a layer REMOVES a message', async () => {
    const real = realProbes();
    const r = await expectFailsWith('history.dedup-rewrites-only', {
      dedupHistory: msgs => {
        const out = real.dedupHistory(msgs);
        return { messages: out.messages.filter((_, i) => i !== 5), replaced: out.replaced };
      },
    });
    expect(r.reason).toContain('changed message count');
  }, TIMEOUT);

  it('dedup-rewrites-only fails when aging touches a non-tool message', async () => {
    const real = realProbes();
    const r = await expectFailsWith('history.dedup-rewrites-only', {
      ageHistory: msgs =>
        real.ageHistory(msgs).map(m => (m.role === 'user' ? ({ ...m, content: 'trimmed' } as Message) : m)),
    });
    expect(r.reason).toContain('rewrote a user message');
  }, TIMEOUT);

  it('dedup-rewrites-only fails when dedup silently stops deduping', async () => {
    const r = await expectFailsWith('history.dedup-rewrites-only', {
      dedupHistory: msgs => ({ messages: msgs, replaced: 0 }),
    });
    expect(r.reason).toContain('vacuous');
  }, TIMEOUT);
});

describe('recovery tasks fail on a broken harness', () => {
  it('stuck-loop detector task fails on a detector that NEVER fires', async () => {
    const r = await expectFailsWith('recovery.stuck-loop-detector', { detectStuckLoop: () => false });
    expect(r.reason).toContain('FALSE NEGATIVE');
  }, TIMEOUT);

  it('stuck-loop detector task fails on a detector that ALWAYS fires', async () => {
    const r = await expectFailsWith('recovery.stuck-loop-detector', { detectStuckLoop: () => true });
    expect(r.reason).toContain('FALSE POSITIVE');
  }, TIMEOUT);

  it('error-loop task fails when the detector goes silent', async () => {
    const r = await expectFailsWith('recovery.error-loop-detector', { detectErrorLoop: () => null });
    expect(r.reason).toContain('FALSE NEGATIVE');
  }, TIMEOUT);

  it('error-loop task fails when soft failures stop being recognised', async () => {
    const r = await expectFailsWith('recovery.error-loop-detector', { looksFutile: () => false });
    expect(r.reason).toContain('soft failure');
  }, TIMEOUT);

  it('error-loop task fails when healthy output is misclassified as futile', async () => {
    const r = await expectFailsWith('recovery.error-loop-detector', { looksFutile: () => true });
    expect(r.reason).toContain('FALSE POSITIVE');
  }, TIMEOUT);

  it('read-loop ladder fails when escalation is disabled', async () => {
    const r = await expectFailsWith('recovery.read-loop-ladder', { readLoopAction: () => 'none' });
    expect(r.reason).toContain('expected summarize');
  }, TIMEOUT);

  it('read-loop ladder fails when the ladder regresses', async () => {
    const r = await expectFailsWith('recovery.read-loop-ladder', {
      readLoopAction: n => (n >= 5 ? 'summarize' : n >= 3 ? 'abort' : 'none'),
    });
    expect(r.reason).toMatch(/expected|regressed/);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// declared knowledge is well-formed
// ---------------------------------------------------------------------------

describe('declared budgets and pairs', () => {
  it('every contradiction pair is distinct and documented', () => {
    expect(new Set(CONTRADICTION_PAIRS.map(p => p.id)).size).toBe(CONTRADICTION_PAIRS.length);
    for (const p of CONTRADICTION_PAIRS) {
      expect(p.why.length, `${p.id} needs a why`).toBeGreaterThan(10);
      expect(p.a.source).not.toBe(p.b.source);
    }
  });

  it('every gating scenario declares required tools that actually exist', () => {
    const all = new Set(realProbes().registeredToolNames());
    for (const sc of GATING_SCENARIOS) {
      expect(sc.required.length).toBeGreaterThan(0);
      for (const n of sc.required) expect(all.has(n), `${sc.id} requires unknown tool ${n}`).toBe(true);
    }
  }, TIMEOUT);

  it('budgets leave headroom but are not vacuous', () => {
    expect(DEFAULT_BUDGETS.maxDescriptionSimilarity).toBeLessThan(1);
    expect(DEFAULT_BUDGETS.maxCacheBreakpoints).toBe(4); // Anthropic hard limit
    expect(DEFAULT_BUDGETS.promptTokensFull).toBeGreaterThan(DEFAULT_BUDGETS.promptTokensCompressed);
  });
});
