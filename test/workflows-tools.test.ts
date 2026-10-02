import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WORKFLOW_TOOL_CLASSES,
  WorkflowRecordTool,
  WorkflowListTool,
  WorkflowShowTool,
  WorkflowRunTool,
} from '../src/workflows/tools.js';
import { setWorkflowsDirForTests, WorkflowStore } from '../src/workflows/store.js';
import { setWorkflowSkillsDirForTests } from '../src/workflows/skillgen.js';
import { setWorkflowGuard, setWorkflowSecretFiller, resolveDefaultGuard, resolveDefaultSecretFiller } from '../src/workflows/replay.js';
import { getActiveRecording } from '../src/workflows/recorder.js';
import { buildWorkflowCommand } from '../src/workflows/command.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import { getBus } from '../src/control/bus.js';
import type { ToolContext, ToolUIEvent } from '../src/tools/base.js';
import { FakeManager, FakePage } from './workflows-fakes.js';

function ctx(events: ToolUIEvent[] = []): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: 'test',
    transaction: {} as any,
    permissions: {} as any,
    askUser: async () => 'no',
    emit: (e) => { events.push(e); },
  };
}

describe('workflow tools', () => {
  let dir: string;
  let mgr: FakeManager;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-wf-tools-'));
    setWorkflowsDirForTests(path.join(dir, 'workflows'));
    setWorkflowSkillsDirForTests(path.join(dir, 'skills'));
    setWorkflowGuard(null);
    setWorkflowSecretFiller(null);
    const page = new FakePage([
      { tag: 'input', type: 'search', role: 'searchbox', name: 'Search', selectors: ['[name="q"]'] },
      { tag: 'button', role: 'button', name: 'Go', selectors: ['#go'], onClick: p => { p.currentUrl = 'https://shop.example/results'; } },
    ]);
    page.currentUrl = 'https://shop.example/';
    mgr = new FakeManager(page);
    setBrowserManagerForTests(mgr);
  });
  afterEach(async () => {
    await new WorkflowRecordTool().execute({ action: 'discard' }, ctx());
    setBrowserManagerForTests(null);
    setWorkflowsDirForTests(null);
    setWorkflowSkillsDirForTests(null);
    setWorkflowGuard(undefined);
    setWorkflowSecretFiller(undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exports four tools with valid names and object schemas (descriptions survive)', () => {
    const tools = WORKFLOW_TOOL_CLASSES.map(C => new C());
    expect(tools.map(t => t.name)).toEqual(['workflow_record', 'workflow_list', 'workflow_show', 'workflow_run']);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
      const s = t.schema().function.parameters as any;
      expect(s.type).toBe('object');
    }
    const run = new WorkflowRunTool();
    const params = (run.schema().function.parameters as any).properties.params;
    expect(params.type).toBe('array');
    expect(params.description).toMatch(/params/);
    expect(params.items.properties.value.description).toMatch(/vault:<entry>/);
    expect(run.timeoutSeconds).toBe(600);
    expect(run.untrustedOutput).toBe(false); // page text is fenced by the tool itself
    expect(run.isReadOnly).toBe(false);
    expect(new WorkflowListTool().isReadOnly).toBe(true);
    expect(new WorkflowShowTool().isReadOnly).toBe(true);
    const rec = (new WorkflowRecordTool().schema().function.parameters as any).properties;
    expect(rec.source.enum).toEqual(['agent', 'human', 'both']);
    expect(rec.name.description).toMatch(/Workflow name/);
  });

  it('record → stop saves the workflow + skill; list/show/run use it', async () => {
    const record = new WorkflowRecordTool();
    const start = await record.execute({ action: 'start', name: 'Shop Search', description: 'Search the shop for a product' }, ctx());
    expect(start.isError).toBeFalsy();
    expect(start.content).toMatch(/Recording workflow "shop-search" \(from "Shop Search"\)/);
    expect((await record.execute({ action: 'start', name: 'other' }, ctx())).content).toMatch(/RECORDING_ACTIVE/);

    // The agent works with browser tools; they publish action records.
    mgr.recordAction({ tool: 'browser_snapshot', args: {}, url: mgr.activeUrl(), actor: 'agent' });
    mgr.recordAction({ tool: 'browser_type', args: { ref: 'e2', text: 'green tea' }, url: mgr.activeUrl(), actor: 'agent', element: { selector: '[name="q"]', role: 'searchbox', name: 'Search', tag: 'input', inputType: 'search' } });
    mgr.recordAction({ tool: 'browser_click', args: { ref: 'e3' }, url: mgr.activeUrl(), actor: 'agent', element: { selector: '#go', role: 'button', name: 'Go' } });

    const status = await record.execute({ action: 'status' }, ctx());
    expect(status.content).toMatch(/3 step\(s\) so far/);

    const busEvents: string[] = [];
    const unsub = getBus().subscribe(e => { if (e.kind === 'agent' && e.source === 'workflows') busEvents.push(e.type); });
    const stop = await record.execute({ action: 'stop' }, ctx());
    unsub();
    expect(stop.isError).toBeFalsy();
    expect(stop.content).toMatch(/Saved workflow "shop-search" — 3 step\(s\), params: search e\.g\. "green tea"/);
    expect(stop.content).toMatch(/Skill "workflow-shop-search" written/);
    expect(busEvents).toEqual(['workflow.saved']);
    expect(getActiveRecording()).toBeNull();
    const skill = await fs.readFile(path.join(dir, 'skills', 'workflow-shop-search', 'SKILL.md'), 'utf-8');
    expect(skill).toContain("description: Replay the recorded 'Shop Search' workflow: Search the shop for a product");

    const list = await new WorkflowListTool().execute({}, ctx());
    expect(list.content).toMatch(/- shop-search \(Shop Search\) — Search the shop for a product \[3 steps; search\]/);

    const show = await new WorkflowShowTool().execute({ name: 'Shop Search' }, ctx());
    expect(show.content).toMatch(/2\. fill searchbox "Search" with "\{\{search\}\}"   \[selector \[name="q"\]; role searchbox "Search"\]/);
    expect(show.content).toMatch(/- search: Text for searchbox "Search"; example: "green tea"; required/);

    // Replay with a different value; the model passes params as an object (coerced).
    const run = new WorkflowRunTool();
    const events: ToolUIEvent[] = [];
    const args = run.argsSchema.parse(run.coerceArgs({ name: 'shop-search', params: { search: 'black tea' } }));
    const res = await run.execute(args, ctx(events));
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/✓ Workflow "shop-search" replayed: 3\/3/);
    expect(mgr.page.log).toEqual(['goto https://shop.example/', 'fill Search=black tea', 'click Go']);
    expect(events.filter(e => e.type === 'progress').length).toBe(3);
    expect(res.metadata).toMatchObject({ workflow: 'shop-search', ok: true, finalUrl: 'https://shop.example/results' });
  });

  it('refuses to start over an existing workflow unless overwrite, and never loses a recording on stop', async () => {
    const store = new WorkflowStore();
    await store.save({ name: 'taken', description: '', version: 1, createdAt: 'x', source: 'agent', params: [], steps: [{ kind: 'navigate', url: 'https://a.example/' }] });
    const record = new WorkflowRecordTool();
    expect((await record.execute({ action: 'start', name: 'taken' }, ctx())).content).toMatch(/WORKFLOW_EXISTS/);
    const ok = await record.execute({ action: 'start', name: 'fresh' }, ctx());
    expect(ok.isError).toBeFalsy();
    mgr.recordAction({ tool: 'browser_click', args: {}, url: mgr.activeUrl(), actor: 'agent', element: { selector: '#go', role: 'button', name: 'Go' } });
    // Someone saved "fresh" meanwhile → the recording is kept under a free name.
    await store.save({ name: 'fresh', description: '', version: 1, createdAt: 'x', source: 'agent', params: [], steps: [{ kind: 'navigate', url: 'https://a.example/' }] });
    const stop = await record.execute({ action: 'stop' }, ctx());
    expect(stop.content).toMatch(/Saved workflow "fresh-2"/);
    expect(stop.content).toMatch(/"fresh" already exists — saved as "fresh-2"/);
  });

  it('stop with nothing replayable reports WORKFLOW_EMPTY; stop/discard without a recording are clear', async () => {
    const record = new WorkflowRecordTool();
    expect((await record.execute({ action: 'stop' }, ctx())).content).toMatch(/NOT_RECORDING/);
    expect((await record.execute({ action: 'discard' }, ctx())).content).toMatch(/No workflow recording is active/);
    mgr.running = false;
    await record.execute({ action: 'start', name: 'empty' }, ctx());
    mgr.recordAction({ tool: 'browser_snapshot', args: {}, url: '', actor: 'agent' });
    const stop = await record.execute({ action: 'stop' }, ctx());
    expect(stop.isError).toBe(true);
    expect(stop.content).toMatch(/WORKFLOW_EMPTY/);
    expect(await new WorkflowStore().exists('empty')).toBe(false);
  });

  it('start needs a name; human source explains how to demonstrate', async () => {
    const record = new WorkflowRecordTool();
    expect((await record.execute({ action: 'start' }, ctx())).content).toMatch(/WORKFLOW_NAME/);
    mgr.running = false;
    const res = await record.execute({ action: 'start', name: 'demo', source: 'human' }, ctx());
    expect(res.content).toMatch(/Take over/);
    expect(res.content).toMatch(/browser is not running yet/);
  });

  it('workflow_run reports unknown workflows with the available names, and dry runs', async () => {
    const store = new WorkflowStore();
    await store.save({ name: 'alpha', description: '', version: 1, createdAt: 'x', source: 'agent', params: [{ name: 'q', example: 'x' }], steps: [{ kind: 'navigate', url: 'https://a.example/?q={{q}}' }] });
    const run = new WorkflowRunTool();
    const nf = await run.execute({ name: 'beta' }, ctx());
    expect(nf.isError).toBe(true);
    expect(nf.content).toMatch(/WORKFLOW_NOT_FOUND.*Available: alpha/);
    const missing = await run.execute({ name: 'alpha' }, ctx());
    expect(missing.content).toMatch(/WORKFLOW_MISSING_PARAMS/);
    const dry = await run.execute({ name: 'alpha', dry_run: true, use_examples: true }, ctx());
    expect(dry.isError).toBeFalsy();
    expect(dry.content).toMatch(/Dry run/);
    expect(mgr.page.log).toEqual([]);
  });

  it('coerces JSON-string params and non-string values', () => {
    const run = new WorkflowRunTool();
    expect(run.coerceArgs({ name: 'a', params: '{"q": 5}' })).toEqual({ name: 'a', params: [{ name: 'q', value: '5' }] });
    expect(run.coerceArgs({ name: 'a', params: [{ name: 'q', value: 7 }] })).toEqual({ name: 'a', params: [{ name: 'q', value: '7' }] });
    expect(run.coerceArgs({ name: 'a' })).toEqual({ name: 'a' });
  });
});

describe('optional integrations', () => {
  it('auto-detection degrades to null when Sentinel / the vault are not part of the build', async () => {
    setWorkflowGuard(undefined);
    setWorkflowSecretFiller(undefined);
    const g = await resolveDefaultGuard();
    const f = await resolveDefaultSecretFiller();
    expect(g === null || typeof g.beforeTool === 'function').toBe(true);
    expect(f === null || typeof f === 'function').toBe(true);
    const custom = { beforeTool: async () => null };
    setWorkflowGuard(custom);
    expect(await resolveDefaultGuard()).toBe(custom);
    setWorkflowGuard(undefined);
  });
});

describe('qodex workflow command', () => {
  it('builds the subcommands', () => {
    const cmd = buildWorkflowCommand();
    expect(cmd.name()).toBe('workflow');
    expect(cmd.aliases()).toContain('workflows');
    const subs = cmd.commands.map(c => c.name()).sort();
    expect(subs).toEqual(['list', 'record', 'rm', 'run', 'show']);
    const run = cmd.commands.find(c => c.name() === 'run')!;
    expect(run.options.map(o => o.long)).toEqual(expect.arrayContaining(['--param', '--dry-run', '--use-examples', '--start-step', '--headed']));
    const record = cmd.commands.find(c => c.name() === 'record')!;
    expect(record.options.map(o => o.long)).toEqual(expect.arrayContaining(['--url', '--description', '--force', '--profile']));
  });
});
