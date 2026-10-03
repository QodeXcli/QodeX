import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WorkflowStore,
  validateWorkflow,
  requiredParams,
} from '../src/workflows/store.js';
import {
  normalizeWorkflowName,
  substitute,
  placeholdersIn,
  workflowPlaceholders,
  describeStep,
  toParamName,
  type Workflow,
} from '../src/workflows/types.js';

function sample(over: Partial<Workflow> = {}): Workflow {
  return {
    name: 'shop-search',
    description: 'Search the shop',
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    source: 'agent',
    startUrl: 'https://shop.example/',
    params: [{ name: 'query', description: 'Search text', example: 'red shoes' }],
    steps: [
      { kind: 'navigate', url: 'https://shop.example/' },
      { kind: 'fill', selector: '[name="q"]', role: 'searchbox', name: 'Search', value: '{{query}}' },
      { kind: 'press', key: 'Enter', selector: '[name="q"]' },
      { kind: 'extract', selector: '#results' },
    ],
    ...over,
  };
}

describe('workflow names', () => {
  it('normalizes ASCII names to kebab-case ids', () => {
    expect(normalizeWorkflowName('My Flow')).toBe('my-flow');
    expect(normalizeWorkflowName('  Order_Coffee.v2 ')).toBe('order-coffee-v2');
    expect(normalizeWorkflowName('')).toBe('');
    expect(normalizeWorkflowName('---')).toMatch(/^wf-[0-9a-f]{6}$/);
  });

  it('gives Persian names a deterministic hash suffix that never collides', () => {
    const a = normalizeWorkflowName('خرید از دیجی‌کالا');
    const b = normalizeWorkflowName('خرید از دیوار');
    expect(a).toMatch(/^wf-[0-9a-f]{6}$/);
    expect(a).toBe(normalizeWorkflowName('خرید از دیجی‌کالا'));
    expect(a).not.toBe(b);
    expect(normalizeWorkflowName('digikala خرید')).toMatch(/^digikala-[0-9a-f]{6}$/);
  });

  it('builds snake_case param names', () => {
    expect(toParamName('Email address')).toBe('email_address');
    expect(toParamName('given-name')).toBe('given_name');
    expect(toParamName('نام کاربری')).toBe('');
    expect(toParamName('2fa code')).toBe('f_2fa_code');
  });
});

describe('placeholders', () => {
  it('substitutes raw for a whole-string placeholder and encodes inside URLs', () => {
    expect(substitute('{{start}}', { start: 'https://a.example/x?y=1' }, { urlEncode: true })).toBe('https://a.example/x?y=1');
    expect(substitute('https://s.example/?q={{q}}', { q: 'red shoes&x' }, { urlEncode: true })).toBe('https://s.example/?q=red%20shoes%26x');
    expect(substitute('Hello {{ name }}!', { name: 'Ali' })).toBe('Hello Ali!');
    expect(substitute('keep {{unknown}}', {})).toBe('keep {{unknown}}');
    expect(placeholdersIn('{{a}} and {{ b }} {{a}}')).toEqual(['a', 'b', 'a']);
  });

  it('collects placeholders from step fields in first-use order', () => {
    const wf = sample({ steps: [{ kind: 'navigate', url: 'https://x.example/{{city}}' }, { kind: 'fill', selector: '#q', value: '{{query}}' }, { kind: 'select', selector: '#s', values: ['{{size}}'] }] });
    expect(workflowPlaceholders(wf)).toEqual(['city', 'query', 'size']);
    expect(workflowPlaceholders(wf, 1)).toEqual(['query', 'size']);
  });

  it('describes steps without revealing values', () => {
    expect(describeStep({ kind: 'fill', role: 'textbox', name: 'Password', value: '{{password}}' })).toBe('fill textbox "Password" with "{{password}}"');
    expect(describeStep({ kind: 'navigate', url: 'https://a.example' })).toBe('go to https://a.example');
    expect(describeStep({ kind: 'wait', waitMs: 500 })).toBe('wait 500ms');
  });
});

describe('validateWorkflow', () => {
  it('accepts and cleans a valid workflow', () => {
    const v = validateWorkflow({ ...sample(), junk: 1, steps: [...sample().steps, { kind: 'click', selector: '#go', extra: 'x', button: 'left' }] });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect((v.workflow as any).junk).toBeUndefined();
    expect((v.workflow!.steps[4] as any).extra).toBeUndefined();
    expect(v.workflow!.steps[4]!.button).toBeUndefined(); // 'left' is the default
  });

  it('rejects structural problems with clear messages', () => {
    expect(validateWorkflow(null).ok).toBe(false);
    expect(validateWorkflow({ ...sample(), steps: [] }).errors.join()).toMatch(/no steps/);
    expect(validateWorkflow({ ...sample(), steps: [{ kind: 'teleport' }] }).errors.join()).toMatch(/unknown kind/);
    expect(validateWorkflow({ ...sample(), steps: [{ kind: 'navigate' }] }).errors.join()).toMatch(/missing url/);
    expect(validateWorkflow({ ...sample(), steps: [{ kind: 'press' }] }).errors.join()).toMatch(/missing key/);
    expect(validateWorkflow({ ...sample(), params: [{ name: 'q' }, { name: 'q' }] }).errors.join()).toMatch(/duplicate param/);
    expect(validateWorkflow({ ...sample(), params: [{ name: 'Bad Name' }] }).errors.join()).toMatch(/invalid name/);
    expect(validateWorkflow({ ...sample(), version: 2 }).errors.join()).toMatch(/unsupported version/);
  });

  it('warns about undeclared placeholders, ref-only targets, and never keeps secret examples', () => {
    const v = validateWorkflow({
      ...sample(),
      params: [
        { name: 'password', secret: true, example: 'hunter2', default: 'hunter2' },
        { name: 'otp', secret: true, default: 'vault:github' },
      ],
      steps: [
        { kind: 'fill', selector: '#pw', value: '{{password}}' },
        { kind: 'fill', selector: '#q', value: '{{query}}' },
        { kind: 'click', ref: 'e12' },
      ],
    });
    expect(v.ok).toBe(true);
    const pw = v.workflow!.params.find(p => p.name === 'password')!;
    expect(pw.example).toBeUndefined();
    expect(pw.default).toBeUndefined();
    expect(v.workflow!.params.find(p => p.name === 'otp')!.default).toBe('vault:github');
    expect(v.warnings.join('\n')).toMatch(/\{\{query\}\} has no param definition/);
    expect(v.warnings.join('\n')).toMatch(/only a snapshot ref/);
    expect(JSON.stringify(v.workflow)).not.toContain('hunter2');
  });

  it('normalizes an unusable name instead of failing', () => {
    const v = validateWorkflow({ ...sample(), name: 'My Shop Search' });
    expect(v.ok).toBe(true);
    expect(v.workflow!.name).toBe('my-shop-search');
  });

  it('computes required params (defaults are optional, undeclared refs are required)', () => {
    const wf = sample({
      params: [{ name: 'query' }, { name: 'password', secret: true, default: 'vault:shop' }, { name: 'unused' }],
      steps: [
        { kind: 'fill', selector: '#q', value: '{{query}}' },
        { kind: 'fill', selector: '#pw', value: '{{password}}' },
        { kind: 'fill', selector: '#c', value: '{{city}}' },
      ],
    });
    expect(requiredParams(wf).sort()).toEqual(['city', 'query']);
    expect(requiredParams(wf, 2)).toEqual(['city']);
  });
});

describe('WorkflowStore', () => {
  let dir: string;
  let store: WorkflowStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-wf-store-'));
    store = new WorkflowStore(path.join(dir, 'workflows'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips save/load/list/remove', async () => {
    const { file, workflow } = await store.save(sample());
    expect(file).toBe(path.join(dir, 'workflows', 'shop-search.json'));
    expect(workflow.name).toBe('shop-search');
    const loaded = await store.load('shop-search');
    expect(loaded).toEqual(workflow);
    expect(await store.load('Shop Search')).toEqual(workflow); // normalized lookup
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'shop-search', steps: 4, params: [{ name: 'query', required: true }] });
    expect(await store.remove('shop-search')).toBe(true);
    expect(await store.remove('shop-search')).toBe(false);
    expect(await store.load('shop-search')).toBeNull();
  });

  it('writes files private (0600) and as pretty JSON', async () => {
    const { file } = await store.save(sample());
    const st = await fs.stat(file);
    if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600);
    const text = await fs.readFile(file, 'utf-8');
    expect(text).toContain('\n  "name": "shop-search"');
  });

  it('refuses to overwrite unless asked', async () => {
    await store.save(sample());
    await expect(store.save(sample())).rejects.toThrow(/WORKFLOW_EXISTS/);
    const r = await store.save(sample({ description: 'changed' }), { overwrite: true });
    expect(r.workflow.description).toBe('changed');
  });

  it('rejects invalid workflows on save and flags corrupt files on list/load', async () => {
    await expect(store.save(sample({ steps: [] }))).rejects.toThrow(/WORKFLOW_INVALID/);
    await fs.mkdir(store.dir, { recursive: true });
    await fs.writeFile(path.join(store.dir, 'broken.json'), '{ not json');
    await fs.writeFile(path.join(store.dir, 'empty.json'), JSON.stringify({ name: 'empty', steps: [] }));
    await expect(store.load('broken')).rejects.toThrow(/WORKFLOW_INVALID/);
    const list = await store.list();
    expect(list.map(w => w.name).sort()).toEqual(['broken', 'empty']);
    expect(list.every(w => 'invalid' in w)).toBe(true);
  });

  it('returns an empty list when the directory does not exist', async () => {
    expect(await new WorkflowStore(path.join(dir, 'nope')).list()).toEqual([]);
  });

  it('never escapes the workflows dir', () => {
    expect(store.filePath('../../etc/passwd')).toBe(path.join(store.dir, 'etc-passwd.json'));
    expect(() => store.filePath('')).toThrow(/WORKFLOW_NAME/);
  });
});
