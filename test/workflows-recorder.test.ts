import { describe, it, expect, afterEach } from 'vitest';
import {
  buildWorkflowFromRecords,
  canonicalAction,
  captureToRecord,
  captureScript,
  selectRecords,
  WorkflowRecorder,
  getActiveRecording,
  type RawRecord,
} from '../src/workflows/recorder.js';
import { validateWorkflow } from '../src/workflows/store.js';
import { FakeManager } from './workflows-fakes.js';

let t = 1_000_000;
function act(tool: string, args: Record<string, unknown>, element?: RawRecord['element'], extra: Partial<RawRecord> = {}): RawRecord {
  t += 1000;
  return { origin: 'action', tool, args, url: 'https://shop.example/', element, actor: 'agent', ts: t, ...extra };
}
function cap(tool: string, args: Record<string, unknown>, element?: RawRecord['element'], extra: Partial<RawRecord> = {}): RawRecord {
  t += 1000;
  return { origin: 'capture', tool, args, url: 'https://shop.example/', element, actor: 'human', ts: t, ...extra };
}

const search = { selector: '[name="q"]', role: 'searchbox', name: 'Search', tag: 'input', inputType: 'search' };
const go = { selector: '#go', role: 'button', name: 'Go', tag: 'button' };
const pw = { selector: '#password', role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', isPassword: true };

describe('canonicalAction', () => {
  it('maps agent tools, human events and noise', () => {
    expect(canonicalAction('browser_navigate').action).toBe('navigate');
    expect(canonicalAction('browser_click').action).toBe('click');
    expect(canonicalAction('browser_type').action).toBe('type');
    expect(canonicalAction('browser_fill_form').action).toBe('fill_form');
    expect(canonicalAction('browser_history', { action: 'forward' })).toEqual({ action: 'history', sub: 'forward' });
    expect(canonicalAction('human_back')).toEqual({ action: 'history', sub: 'back' });
    expect(canonicalAction('human_input', { type: 'scroll' }).action).toBe('scroll');
    expect(canonicalAction('browser_fill_secret').action).toBe('fill_secret');
    expect(canonicalAction('browser_evaluate').action).toBe('unsupported');
    for (const n of ['browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_status', 'browser_network', 'browser_agent']) {
      expect(canonicalAction(n).action).toBe('noise');
    }
  });
});

describe('buildWorkflowFromRecords', () => {
  it('converts agent actions, preferring element.selector and keeping role/name for healing', () => {
    const { workflow } = buildWorkflowFromRecords([
      act('browser_navigate', { url: 'https://shop.example/' }),
      act('browser_snapshot', {}),
      act('browser_click', { ref: 'e7', selector: 'text=Go', element: 'Go button' }, go),
      act('browser_screenshot', {}),
    ], { name: 'Go Shop', source: 'agent' });
    expect(workflow.name).toBe('go-shop');
    expect(workflow.title).toBe('Go Shop');
    expect(workflow.startUrl).toBe('https://shop.example/');
    expect(workflow.steps).toEqual([
      { kind: 'navigate', url: 'https://shop.example/', actor: 'agent' },
      { kind: 'click', selector: '#go', ref: 'e7', role: 'button', name: 'Go', note: 'Go button', actor: 'agent' },
    ]);
    expect(validateWorkflow(workflow).ok).toBe(true);
  });

  it('keeps click variants (double, right button, modifier keys) and wait durations', () => {
    const { workflow } = buildWorkflowFromRecords([
      act('browser_click', { double: true }, go),
      act('browser_click', { button: 'right', modifiers: ['Control', 'Bogus', 'Control'] }, go),
      act('browser_wait_for', { kind: 'time', timeout_ms: 750 }),
    ], { name: 'variants', source: 'agent' });
    expect(workflow.steps[0]).toMatchObject({ kind: 'click', double: true });
    expect(workflow.steps[1]).toMatchObject({ kind: 'click', button: 'right', modifiers: ['Control'] });
    expect(workflow.steps[2]).toMatchObject({ kind: 'wait', waitMs: 750 });
    const v = validateWorkflow(workflow);
    expect(v.ok).toBe(true);
    expect(v.workflow!.steps[1]!.modifiers).toEqual(['Control']);
  });

  it('merges consecutive typing into one fill and drops the focus click before it', () => {
    const { workflow } = buildWorkflowFromRecords([
      act('browser_navigate', { url: 'https://shop.example/' }),
      act('browser_click', { ref: 'e3' }, search),
      act('browser_type', { ref: 'e3', text: 'red' }, search),
      act('browser_type', { ref: 'e3', text: 'red shoes', submit: true }, search),
    ], { name: 'search', source: 'agent' });
    expect(workflow.steps.map(s => s.kind)).toEqual(['navigate', 'fill', 'press']);
    expect(workflow.steps[1]).toMatchObject({ selector: '[name="q"]', value: '{{search}}' });
    expect(workflow.steps[2]).toMatchObject({ key: 'Enter', selector: '[name="q"]' });
    expect(workflow.params).toEqual([{ name: 'search', description: 'Text for searchbox "Search"', example: 'red shoes' }]);
  });

  it('concatenates relayed human keystrokes', () => {
    const { workflow } = buildWorkflowFromRecords([
      act('browser_navigate', { url: 'https://shop.example/' }),
      { ...act('human_input', { type: 'type', text: 'blue ' }, search), actor: 'human' },
      { ...act('human_input', { type: 'type', text: 'jeans' }, search), actor: 'human' },
    ], { name: 'kb', source: 'mixed' });
    const fill = workflow.steps.find(s => s.kind === 'fill')!;
    expect(fill.value).toBe('{{search}}');
    expect(workflow.params[0]!.example).toBe('blue jeans');
  });

  it('turns password fields into secret params without storing the value', () => {
    const { workflow, warnings } = buildWorkflowFromRecords([
      act('browser_navigate', { url: 'https://acme.example/login' }),
      act('browser_type', { selector: '#user', text: 'ali@example.com' }, { selector: '#user', role: 'textbox', name: 'Email', autocomplete: 'email', tag: 'input', inputType: 'email' }),
      act('browser_type', { selector: '#password', text: '***' }, pw),
      act('browser_click', {}, { selector: '#login', role: 'button', name: 'Log in' }),
    ], { name: 'login', source: 'agent' });
    const json = JSON.stringify(workflow);
    expect(json).not.toContain('***');
    expect(workflow.params).toEqual([
      { name: 'email', description: 'Text for textbox "Email"', example: 'ali@example.com' },
      { name: 'password', description: 'Secret for textbox "Password"', secret: true, vaultField: 'password' },
    ]);
    expect(workflow.steps[2]).toMatchObject({ kind: 'fill', selector: '#password', value: '{{password}}' });
    expect(warnings.join()).toMatch(/secret params/);
  });

  it('treats one-time-code and card fields as secrets', () => {
    const { workflow } = buildWorkflowFromRecords([
      act('browser_type', { selector: '#otp', text: '123456' }, { selector: '#otp', autocomplete: 'one-time-code', tag: 'input' }),
      act('browser_type', { selector: '#cc', text: '4111111111111111' }, { selector: '#cc', autocomplete: 'cc-number', name: 'Card number', tag: 'input' }),
    ], { name: 'pay', source: 'agent' });
    expect(JSON.stringify(workflow)).not.toMatch(/123456|4111/);
    expect(workflow.params.map(p => [p.name, p.secret, p.vaultField])).toEqual([['otp', true, 'totp'], ['card_number', true, undefined]]);
  });

  it('treats PIN / CVV / verification-code fields as secrets even when they are type=text (EN + FA labels)', () => {
    const { workflow } = buildWorkflowFromRecords([
      act('browser_type', { text: '1234' }, { selector: '[name="card_pin"]', name: 'PIN', tag: 'input', inputType: 'text' }),
      act('browser_type', { text: '987' }, { selector: '#c2', name: 'CVV2', tag: 'input', inputType: 'tel' }),
      act('browser_type', { text: '554433' }, { selector: '#code', name: 'کد تایید', tag: 'input', inputType: 'text' }),
      act('browser_type', { text: 'p@ss' }, { selector: '#x', name: 'رمز عبور', tag: 'input', inputType: 'text' }),
      act('browser_type', { text: 'Opinion text' }, { selector: '#opinion', name: 'Your opinion', tag: 'textarea' }),
    ], { name: 'secrets', source: 'agent' });
    expect(JSON.stringify(workflow)).not.toMatch(/1234|987|554433|p@ss/);
    expect(workflow.params.map(p => [p.name, !!p.secret, p.vaultField])).toEqual([
      ['pin', true, undefined],
      ['cvv2', true, undefined],
      ['otp', true, 'totp'],
      ['password', true, 'password'],
      ['your_opinion', false, undefined],
    ]);
  });

  it('collapses the click echo of a double-click', () => {
    const first = act('click', { click_count: 1 }, go, { origin: 'capture', actor: 'human' });
    const second = { ...act('click', { click_count: 2 }, go, { origin: 'capture', actor: 'human' }), ts: first.ts + 200 };
    const { workflow } = buildWorkflowFromRecords([first, second], { name: 'dbl', source: 'human' });
    expect(workflow.steps).toEqual([expect.objectContaining({ kind: 'click', double: true, selector: '#go' })]);
  });

  it('records vault fills as params defaulting to the vault entry', () => {
    const { workflow } = buildWorkflowFromRecords([
      act('browser_navigate', { url: 'https://acme.example/login' }),
      act('browser_fill_secret', { selector: '#user', secret: 'acme', field: 'username' }, { selector: '#user', name: 'Email' }),
      act('browser_fill_secret', { selector: '#password', secret: 'acme', field: 'password' }, pw),
    ], { name: 'vault-login', source: 'agent' });
    expect(workflow.params).toEqual([
      { name: 'username', description: 'Username for "Email" (from vault entry "acme")', secret: false, vaultField: 'username', default: 'vault:acme' },
      { name: 'password', description: 'Secret for textbox "Password" (from vault entry "acme")', secret: true, vaultField: 'password', default: 'vault:acme' },
    ]);
    expect(validateWorkflow(workflow).ok).toBe(true);
  });

  it('reuses a param for the same field+value and follows the value into later URLs', () => {
    const { workflow } = buildWorkflowFromRecords([
      act('browser_navigate', { url: 'https://shop.example/' }),
      act('browser_fill', { selector: '[name="q"]', value: 'red shoes' }, search),
      act('browser_press', { key: 'Enter' }),
      act('browser_navigate', { url: 'https://shop.example/search?q=red+shoes&page=2' }),
    ], { name: 'paged', source: 'agent' });
    expect(workflow.steps[3]!.url).toBe('https://shop.example/search?q={{search}}&page=2');
  });

  it('drops noise, warns on unsupported tools, and parameterizes uploads', () => {
    const { workflow, warnings } = buildWorkflowFromRecords([
      act('browser_navigate', { url: 'https://jobs.example/apply' }),
      act('browser_evaluate', { script: 'document.cookie' }),
      act('browser_upload', { selector: '#cv', paths: ['/home/u/cv.pdf'] }, { selector: '#cv', name: 'CV' }),
      act('browser_wait_for', { kind: 'text', value: 'Uploaded' }),
      act('browser_extract', { format: 'markdown' }),
      act('browser_extract', { format: 'markdown' }),
    ], { name: 'apply', source: 'agent' });
    expect(workflow.steps.map(s => s.kind)).toEqual(['navigate', 'upload', 'wait', 'extract']);
    expect(workflow.steps[1]!.files).toEqual(['{{file}}']);
    expect(workflow.params[0]).toMatchObject({ name: 'file', example: '/home/u/cv.pdf' });
    expect(workflow.steps[2]).toMatchObject({ kind: 'wait', text: 'Uploaded' });
    expect(warnings.join()).toMatch(/browser_evaluate is not recorded/);
  });

  it('prepends the start page when the first step is not a navigation', () => {
    const { workflow } = buildWorkflowFromRecords([act('browser_click', {}, go)], { name: 'x', source: 'agent', startUrl: 'https://shop.example/home' });
    expect(workflow.steps[0]).toEqual({ kind: 'navigate', url: 'https://shop.example/home' });
  });

  it('collapses an auto-captured start page superseded by an explicit navigation', () => {
    const { workflow } = buildWorkflowFromRecords([
      { origin: 'start', tool: 'navigate', args: { url: 'https://old.example/' }, url: 'https://old.example/', actor: 'agent', ts: 1 },
      act('browser_navigate', { url: 'https://shop.example/' }),
      act('browser_click', {}, go),
    ], { name: 'x', source: 'agent' });
    expect(workflow.steps.map(s => s.url ?? s.selector)).toEqual(['https://shop.example/', '#go']);
  });

  it('skips clicks without element info and non-web navigations', () => {
    const { workflow, warnings } = buildWorkflowFromRecords([
      act('browser_navigate', { url: 'https://shop.example/' }),
      act('browser_navigate', { url: 'file:///etc/passwd' }),
      { ...act('human_click', { x: 10, y: 20 }), actor: 'human' },
    ], { name: 'x', source: 'mixed' });
    expect(workflow.steps).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/non-web URL/);
    expect(warnings.join('\n')).toMatch(/no element information at \(10, 20\)/);
  });
});

describe('selectRecords (sources + de-duplication)', () => {
  it('agent source ignores human events', () => {
    const recs = [act('browser_click', {}, go), cap('click', {}, go), { ...act('human_click', {}, go), actor: 'human' as const }];
    expect(selectRecords(recs, 'agent')).toEqual([recs[0]]);
  });

  it('human source keeps captures and the agent navigations that set up the demo', () => {
    const nav = act('browser_navigate', { url: 'https://shop.example/' });
    const agentClick = act('browser_click', {}, go);
    const c = cap('click', {}, go);
    expect(selectRecords([nav, agentClick, c], 'human')).toEqual([nav, c]);
  });

  it('human source falls back to relayed human actions when no in-page capture exists', () => {
    const h = { ...act('human_input', { type: 'click' }, go), actor: 'human' as const };
    expect(selectRecords([h], 'human')).toEqual([h]);
    const c = cap('click', {}, go);
    expect(selectRecords([h, c], 'human')).toEqual([c]);
  });

  it('mixed source drops the capture echo of an agent action (one-to-one, nearest)', () => {
    const echo = cap('click', {}, go);
    const agent = { ...act('browser_click', {}, go), ts: echo.ts + 40 };
    const humanAgain = { ...cap('click', {}, go), ts: echo.ts + 3000 };
    const kept = selectRecords([echo, agent, humanAgain], 'mixed');
    expect(kept).toEqual([agent, humanAgain]);
    const { workflow } = buildWorkflowFromRecords([echo, agent, humanAgain], { name: 'm', source: 'mixed' });
    expect(workflow.steps.filter(s => s.kind === 'click')).toHaveLength(2);
  });

  it('a missed echo never pins a human Back (followed by human typing) on a later agent Enter', () => {
    // The page capture can miss the agent's own Enter when the submit unloads the page
    // first (slow CI). The human went Back and typed BEFORE the agent pressed Enter.
    const base = t + 10_000;
    const back: RawRecord = { origin: 'nav', tool: 'navigate', args: { url: 'https://shop.example/' }, url: 'https://shop.example/', actor: 'human', ts: base };
    const typed = cap('fill', { value: 'mate' }, search, { ts: base + 600 });
    const results: RawRecord = { origin: 'nav', tool: 'navigate', args: { url: 'https://shop.example/results?q=mate' }, url: 'https://shop.example/results?q=mate', actor: 'human', ts: base + 1400 };
    const enter = act('browser_press', { key: 'Enter' }, search, { ts: base + 1500 });
    const kept = selectRecords([back, typed, results, enter], 'mixed');
    expect(kept).toContain(back);          // the human's Back stays
    expect(kept).not.toContain(results);   // the load the agent's Enter caused is still dropped
  });

  it('drops address-bar navigations caused by a recorded click, keeps typed URLs', () => {
    const click = cap('click', {}, go);
    const caused: RawRecord = { origin: 'nav', tool: 'navigate', args: { url: 'https://shop.example/results' }, url: 'https://shop.example/results', actor: 'human', ts: click.ts + 800 };
    const typed: RawRecord = { origin: 'nav', tool: 'navigate', args: { url: 'https://other.example/' }, url: 'https://other.example/', actor: 'human', ts: click.ts + 20_000 };
    expect(selectRecords([click, caused, typed], 'human')).toEqual([click, typed]);
  });
});

describe('capture payloads', () => {
  it('validates and converts page events (never trusting the page)', () => {
    expect(captureToRecord(null)).toBeNull();
    expect(captureToRecord({ type: 'eval', el: {} })).toBeNull();
    expect(captureToRecord({ type: 'click' })).toBeNull(); // no element
    const r = captureToRecord({ type: 'fill', el: { selector: '#pw', isPassword: true, role: 'textbox', evil: 'x' }, value: 'should-not-be-here', secret: true, url: 'https://a.example/' });
    expect(r).toMatchObject({ origin: 'capture', tool: 'fill', actor: 'human', args: { value: '', secret: true } });
    expect((r!.element as any).evil).toBeUndefined();
    const sel = captureToRecord({ type: 'select', el: { selector: '#size' }, values: ['m', 42] });
    expect(sel!.args).toEqual({ values: ['m', '42'] });
    const chk = captureToRecord({ type: 'check', el: { selector: '#tos' }, checked: true });
    const { workflow } = buildWorkflowFromRecords([chk!], { name: 'c', source: 'human' });
    expect(workflow.steps[0]).toMatchObject({ kind: 'fill', selector: '#tos', value: 'true' });
  });

  it('capture script embeds the nonce and never sends secret values', () => {
    const s = captureScript('abc123');
    expect(s).toContain('"abc123"');
    expect(s).toContain("ev.value = secret ? '' :");
    expect(s).toContain('__qxRecFlush_');
    // Must be syntactically valid JavaScript.
    expect(() => new Function(s)).not.toThrow();
  });
});

describe('WorkflowRecorder', () => {
  let rec: WorkflowRecorder | null = null;
  afterEach(async () => {
    await rec?.discard();
    rec = null;
  });

  it('records agent actions published by the browser manager', async () => {
    const mgr = new FakeManager();
    mgr.page.currentUrl = 'https://shop.example/';
    rec = new WorkflowRecorder();
    const st = await rec.start({ name: 'shop', description: 'Search the shop', mgr });
    expect(st.active).toBe(true);
    expect(st.steps).toBe(1); // the page that was open when recording began
    expect(getActiveRecording()).toBe(rec);
    mgr.recordAction({ tool: 'browser_type', args: { ref: 'e3', text: 'socks' }, url: mgr.activeUrl(), actor: 'agent', element: search });
    mgr.recordAction({ tool: 'browser_snapshot', args: {}, url: mgr.activeUrl(), actor: 'agent' });
    mgr.recordAction({ tool: 'browser_click', args: { ref: 'e9' }, url: mgr.activeUrl(), actor: 'human', element: go }); // ignored: agent source
    expect(rec.status().steps).toBe(2);
    const wf = await rec.stop();
    expect(wf.steps.map(s => s.kind)).toEqual(['navigate', 'fill']);
    expect(wf.description).toBe('Search the shop');
    expect(getActiveRecording()).toBeNull();
    expect(mgr.listeners.size).toBe(0);
  });

  it('resolves ref-only actions to element info via describeRef', async () => {
    const mgr = new FakeManager();
    mgr.running = false;
    mgr.refs.set('e5', { selector: '#buy', role: 'button', name: 'Buy now' });
    rec = new WorkflowRecorder();
    await rec.start({ name: 'buy', mgr });
    mgr.recordAction({ tool: 'browser_navigate', args: { url: 'https://shop.example/p/1' }, url: 'https://shop.example/p/1', actor: 'agent' });
    mgr.recordAction({ tool: 'browser_click', args: { ref: 'e5' }, url: 'https://shop.example/p/1', actor: 'agent' });
    const wf = await rec.stop();
    expect(wf.steps[1]).toMatchObject({ kind: 'click', selector: '#buy', role: 'button', name: 'Buy now', ref: 'e5' });
  });

  it('allows one recording per process and supports discard', async () => {
    const mgr = new FakeManager();
    rec = new WorkflowRecorder();
    await rec.start({ name: 'one', mgr });
    const other = new WorkflowRecorder();
    await expect(other.start({ name: 'two', mgr })).rejects.toThrow(/RECORDING_ACTIVE/);
    await expect(rec.start({ name: 'again', mgr })).rejects.toThrow(/RECORDING_ACTIVE/);
    await rec.discard();
    expect(getActiveRecording()).toBeNull();
    await expect(rec.stop()).rejects.toThrow(/NOT_RECORDING/);
    await other.start({ name: 'two', mgr });
    rec = other;
    expect(rec.status().name).toBe('two');
  });

  it('human recordings install the in-page capture on the running context and route by nonce', async () => {
    const mgr = new FakeManager();
    mgr.page.currentUrl = 'https://shop.example/';
    let binding: ((src: any, nonce: unknown, payload: unknown) => void) | null = null;
    const evaluated: string[] = [];
    const page = {
      frames: () => [{ evaluate: async (s: string) => { evaluated.push(s); return true; } }],
      mainFrame: () => null,
      url: () => 'https://shop.example/',
      on: () => {},
      off: () => {},
    };
    const disposed: string[] = [];
    mgr.ctx = {
      exposeBinding: async (_name: string, fn: any) => { binding = fn; return { dispose: async () => { disposed.push('binding'); } }; },
      addInitScript: async () => ({ dispose: async () => { disposed.push('init'); } }),
      pages: () => [page],
      on: () => {},
      off: () => {},
    };
    rec = new WorkflowRecorder();
    const st = await rec.start({ name: 'demo', source: 'human', mgr });
    expect(st.capturing).toBe(true);
    expect(evaluated[0]).toContain('__qxRecInstalled_');
    const nonce = /const NONCE = "([0-9a-f]+)"/.exec(evaluated[0]!)![1]!;
    // A forged call with the wrong nonce is ignored.
    binding!({ page }, 'forged', { type: 'click', el: { selector: '#buy', role: 'button', name: 'Buy' } });
    binding!({ page }, nonce, { type: 'fill', el: { selector: '#q', role: 'searchbox', name: 'Search', tag: 'input', inputType: 'search' }, value: 'tea' });
    binding!({ page }, nonce, { type: 'press', key: 'Enter', el: { selector: '#q' } });
    const wf = await rec.stop();
    expect(wf.source).toBe('human');
    expect(wf.steps.map(s => s.kind)).toEqual(['navigate', 'fill', 'press']);
    expect(wf.steps.some(s => s.selector === '#buy')).toBe(false);
    expect(disposed.sort()).toEqual(['binding', 'init']);
  });
});
