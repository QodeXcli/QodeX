/**
 * `workflow_*` tools — let the agent learn browser procedures and replay them.
 *
 *   workflow_record  start | stop | status | discard a recording. Records the
 *                    agent's own browser_* actions, a human demonstrating in the
 *                    QodeX browser, or both. `stop` saves the workflow JSON and a
 *                    companion skill (`workflow-<name>`) so the model rediscovers
 *                    it next time the user asks for the same thing.
 *   workflow_list    saved workflows with their params.
 *   workflow_show    one workflow: params (examples), numbered steps, files.
 *   workflow_run     replay a workflow with params (self-healing targets, Sentinel
 *                    checks per consequential step, resumable via start_step).
 *
 * workflow_run returns page text from `extract` steps; it fences that part
 * itself (Sentinel's scanner when installed) instead of marking the whole result
 * `untrustedOutput`, so its resume instructions stay trusted. It can run for
 * minutes, so it gets its own 600s timeout.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../tools/base.js';
import { getBus } from '../control/bus.js';
import { getWorkflowRecorder, getActiveRecording, type RecordingStatus } from './recorder.js';
import { formatReplayReport, resolveDefaultFence, runWorkflow, type ReplayReport } from './replay.js';
import { writeWorkflowSkill, workflowSkillName } from './skillgen.js';
import { WorkflowStore, requiredParams, summarize } from './store.js';
import { describeStep, normalizeWorkflowName, type Workflow, type WorkflowSource } from './types.js';

function err(content: string): ToolResult {
  return { content, isError: true };
}

/** Pick a free name (`name`, `name-2`, …) so a finished recording is never lost to a clash. */
async function freeName(store: WorkflowStore, name: string): Promise<string> {
  if (!(await store.exists(name))) return name;
  for (let i = 2; i < 1000; i++) {
    const n = `${name.slice(0, 60)}-${i}`;
    if (!(await store.exists(n))) return n;
  }
  return `${name.slice(0, 50)}-${Date.now().toString(36)}`;
}

function paramLine(wf: Workflow): string {
  if (!wf.params.length) return 'none';
  const req = new Set(requiredParams(wf));
  return wf.params
    .map(p => `${p.name}${p.secret ? ' (secret)' : ''}${req.has(p.name) ? '' : ' (optional)'}${!p.secret && p.example !== undefined ? ` e.g. ${JSON.stringify(p.example.length > 40 ? p.example.slice(0, 39) + '…' : p.example)}` : ''}`)
    .join(', ');
}

function statusText(s: RecordingStatus): string {
  if (!s.active) return 'No workflow recording is active.';
  const secs = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
  const lines = [
    `● Recording "${s.name}"${s.title ? ` (${s.title})` : ''} — source: ${s.source}, ${secs}s, ${s.events} event(s) → ${s.steps} step(s) so far${s.source !== 'agent' ? `, human capture ${s.capturing ? 'active' : 'waiting for the browser'}` : ''}.`,
  ];
  if (s.preview.length) lines.push('Latest steps:', ...s.preview.map(p => `  - ${p}`));
  for (const w of s.warnings) lines.push(`Note: ${w}`);
  return lines.join('\n');
}

// ── workflow_record ──────────────────────────────────────────────────────────

const RecordArgs = z.object({
  action: z.enum(['start', 'stop', 'status', 'discard']).describe('start a recording; stop it (saves the workflow and a reusable skill); status; or discard it'),
  name: z.string().describe('Workflow name (required for start), e.g. "digikala-search". Lowercase letters, digits and dashes; other names are normalized.').optional(),
  description: z.string().describe('What the workflow does in the user\'s words (any language). Becomes the skill description and its trigger words.').optional(),
  source: z.enum(['agent', 'human', 'both']).describe('Whose actions to record. agent (default) = your own browser_* calls; human = a person demonstrating in the QodeX browser (control center takeover or a headed window); both = mixed.').optional(),
  overwrite: z.boolean().describe('Replace an existing workflow with the same name (default false).').optional(),
});

export class WorkflowRecordTool extends Tool<z.infer<typeof RecordArgs>> {
  name = 'workflow_record';
  description =
    'Learn a browser workflow from a demonstration so it can be replayed later with workflow_run. ' +
    'action=start begins capturing (source agent = your own browser_* actions, human = a person demonstrating in the QodeX browser, both); ' +
    'do the task; then action=stop saves it as a parameterized workflow (typed values become params, password fields become secret params that are never stored) ' +
    'plus a skill "workflow-<name>" so it is found next time. Snapshots/screenshots are not recorded. One recording at a time.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = RecordArgs;

  async execute(args: z.infer<typeof RecordArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const store = new WorkflowStore();
    const recorder = getWorkflowRecorder();
    switch (args.action) {
      case 'start': {
        if (!args.name?.trim()) return err('[WORKFLOW_NAME] workflow_record start needs a name, e.g. {"action": "start", "name": "order-coffee", "description": "..."}');
        const active = getActiveRecording();
        if (active) return err(`[RECORDING_ACTIVE] already recording "${active.options().name}". Call workflow_record {"action": "stop"} (save) or {"action": "discard"} first.`);
        const id = normalizeWorkflowName(args.name);
        if (!id) return err(`[WORKFLOW_NAME] unusable name ${JSON.stringify(args.name)}`);
        if (!args.overwrite && await store.exists(id)) {
          return err(`[WORKFLOW_EXISTS] a workflow named "${id}" already exists. Pick another name, or pass overwrite: true to replace it (see workflow_show {"name": "${id}"}).`);
        }
        const source: WorkflowSource = args.source === 'human' ? 'human' : args.source === 'both' ? 'mixed' : 'agent';
        let status: RecordingStatus;
        try {
          status = await recorder.start({ name: args.name, description: args.description, source, overwrite: args.overwrite });
        } catch (e: any) {
          return err(String(e?.message ?? e));
        }
        const lines = [`● Recording workflow "${status.name}"${id !== args.name.trim() ? ` (from "${args.name.trim()}")` : ''} — source: ${source}.`];
        if (source === 'agent') {
          lines.push('Now do the task with the browser_* tools. Every successful action (navigate, click, type, select, press, upload, extract...) is captured; snapshots, screenshots and console reads are ignored.');
        } else {
          lines.push(
            'A person should now demonstrate the task in the QodeX browser: in the control center (/control or `qodex control`) press "Take over", or use a headed browser window.',
            'Clicks, typing, selections, checkboxes and Enter presses are captured with stable selectors; password / one-time-code / card fields are recorded as secret params without their values.',
          );
          if (!status.capturing) lines.push('The browser is not running yet — open the start page with browser_navigate; capture attaches as soon as it launches.');
          if (source === 'mixed') lines.push('Your own browser_* actions are recorded too.');
        }
        if (status.steps) lines.push(`Starting page captured as step 1 (${status.preview[0] ?? ''}).`);
        lines.push('Typed values become parameters ({{name}}) with the typed text as the example. When finished call workflow_record {"action": "stop"}; to abandon, {"action": "discard"}.');
        return { content: lines.join('\n') };
      }

      case 'status':
        return { content: statusText(recorder.status()) };

      case 'discard': {
        if (!getActiveRecording()) return { content: 'No workflow recording is active.' };
        const name = recorder.options().name;
        await recorder.discard();
        return { content: `Recording "${normalizeWorkflowName(name)}" discarded — nothing was saved.` };
      }

      case 'stop': {
        if (!getActiveRecording()) return err('[NOT_RECORDING] no workflow recording is active. Start one with workflow_record {"action": "start", "name": "..."}.');
        const opts = recorder.options();
        let wf: Workflow;
        try {
          wf = await recorder.stop();
        } catch (e: any) {
          return err(String(e?.message ?? e));
        }
        const warnings = [...recorder.warnings];
        if (!wf.steps.length) {
          return err(`[WORKFLOW_EMPTY] nothing replayable was recorded for "${wf.name}" (only observation calls or no browser actions) — recording discarded.${warnings.length ? `\nNotes: ${warnings.join('; ')}` : ''}`);
        }
        const overwrite = args.overwrite ?? opts.overwrite ?? false;
        let finalName = wf.name;
        if (!overwrite) finalName = await freeName(store, wf.name);
        if (finalName !== wf.name) warnings.push(`"${wf.name}" already exists — saved as "${finalName}" instead`);
        const replacing = overwrite && await store.exists(finalName);
        let saved: Workflow;
        let file: string;
        try {
          const r = await store.save({ ...wf, name: finalName, ...(replacing ? { updatedAt: new Date().toISOString() } : {}) }, { overwrite: true });
          saved = r.workflow;
          file = r.file;
          warnings.push(...r.warnings);
        } catch (e: any) {
          return err(`${String(e?.message ?? e)}\nThe recording could not be saved.`);
        }
        let skillLine: string;
        try {
          const sk = await writeWorkflowSkill(saved);
          skillLine = sk.written ? `Skill "${sk.name}" written (${sk.file}) — future requests for this task will surface it.` : `Skill not written: ${sk.reason}`;
        } catch (e: any) {
          skillLine = `Skill not written: ${String(e?.message ?? e)}`;
        }
        getBus().publish({ kind: 'agent', source: 'workflows', type: 'workflow.saved', data: { name: saved.name, steps: saved.steps.length, source: saved.source } });
        const lines = [
          `✓ Saved workflow "${saved.name}" — ${saved.steps.length} step(s), params: ${paramLine(saved)}.`,
          `File: ${file}`,
          skillLine,
          'Steps:',
          ...saved.steps.slice(0, 40).map((s, i) => `  ${i + 1}. ${describeStep(s)}`),
          ...(saved.steps.length > 40 ? [`  … ${saved.steps.length - 40} more`] : []),
          ...[...new Set(warnings)].map(w => `Note: ${w}`),
          `Replay: workflow_run {"name": "${saved.name}"${saved.params.length ? ', "params": [{"name": "...", "value": "..."}]' : ''}} (dry_run: true to preview).`,
        ];
        return { content: lines.join('\n') };
      }
    }
  }
}

// ── workflow_list ────────────────────────────────────────────────────────────

const ListArgs = z.object({});

export class WorkflowListTool extends Tool<z.infer<typeof ListArgs>> {
  name = 'workflow_list';
  description = 'List saved browser workflows (learned with workflow_record) with their descriptions and parameters. Replay one with workflow_run.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ListArgs;

  async execute(_args: z.infer<typeof ListArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const store = new WorkflowStore();
    const active = getActiveRecording();
    return { content: renderWorkflowList(await store.list(), store.dir, active ? normalizeWorkflowName(active.options().name) : undefined) };
  }
}

/** Text listing of saved workflows (shared by workflow_list and `qodex workflow list`). */
export function renderWorkflowList(all: Awaited<ReturnType<WorkflowStore['list']>>, dir: string, recording?: string): string {
  const head = recording ? [`(recording in progress: "${recording}")`] : [];
  if (!all.length) return [...head, `No saved workflows yet (${dir}). Record one with workflow_record {"action": "start", "name": "..."} or \`qodex workflow record <name> --url <start>\`.`].join('\n');
  const lines = [...head, `${all.length} workflow(s):`];
  for (const w of all) {
    if ('invalid' in w) { lines.push(`- ${w.name} — INVALID: ${w.invalid}`); continue; }
    const params = w.params.length
      ? w.params.map(p => `${p.name}${p.secret ? '*' : ''}${p.required ? '' : '?'}`).join(', ')
      : 'no params';
    lines.push(`- ${w.name}${w.title ? ` (${w.title})` : ''} — ${w.description || '(no description)'} [${w.steps} steps; ${params}]`);
  }
  lines.push('(* = secret, ? = optional). Details: workflow_show {"name": "..."}.');
  return lines.join('\n');
}

// ── workflow_show ────────────────────────────────────────────────────────────

const ShowArgs = z.object({
  name: z.string().min(1).describe('Workflow name (as listed by workflow_list).'),
  json: z.boolean().describe('Also include the raw workflow JSON (default false).').optional(),
});

export class WorkflowShowTool extends Tool<z.infer<typeof ShowArgs>> {
  name = 'workflow_show';
  description = 'Show one saved workflow: description, parameters (with recorded examples; secrets never shown), numbered steps with their selectors, and its file/skill.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ShowArgs;

  async execute(args: z.infer<typeof ShowArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const store = new WorkflowStore();
    let wf: Workflow | null;
    try {
      wf = await store.load(args.name);
    } catch (e: any) {
      return err(String(e?.message ?? e));
    }
    if (!wf) return err(await notFound(store, args.name));
    return { content: renderWorkflowDetail(wf, store.filePath(wf.name), args.json === true) };
  }
}

/** Full text description of one workflow (shared by workflow_show and `qodex workflow show`). */
export function renderWorkflowDetail(wf: Workflow, file: string, json = false): string {
  const req = new Set(requiredParams(wf));
  const lines = [
    `Workflow "${wf.name}"${wf.title ? ` (${wf.title})` : ''} — ${wf.description || '(no description)'}`,
    `Source: ${wf.source}; created ${wf.createdAt}${wf.updatedAt ? `; updated ${wf.updatedAt}` : ''}${wf.startUrl ? `; starts at ${wf.startUrl}` : ''}`,
    `File: ${file}   Skill: ${workflowSkillName(wf.name)}`,
    'Params:',
    ...(wf.params.length ? wf.params.map(p => {
      const bits = [
        p.description,
        p.secret ? 'secret' : undefined,
        p.vaultField ? `vault field: ${p.vaultField} (pass "vault:<entry>")` : undefined,
        !p.secret && p.example !== undefined ? `example: ${JSON.stringify(p.example)}` : undefined,
        p.default !== undefined ? `default: ${JSON.stringify(p.default)}` : undefined,
        req.has(p.name) ? 'required' : 'optional',
      ].filter(Boolean);
      return `  - ${p.name}: ${bits.join('; ')}`;
    }) : ['  (none)']),
    'Steps:',
    ...wf.steps.map((s, i) => {
      const where = [s.selector ? `selector ${s.selector}` : '', s.role && s.name ? `role ${s.role} "${s.name}"` : ''].filter(Boolean).join('; ');
      return `  ${i + 1}. ${describeStep(s)}${s.optional ? ' (optional)' : ''}${where ? `   [${where}]` : ''}${s.note ? `   — ${s.note}` : ''}`;
    }),
  ];
  if (json) lines.push('JSON:', JSON.stringify(wf, null, 2));
  return lines.join('\n');
}

async function notFound(store: WorkflowStore, name: string): Promise<string> {
  const all = await store.list().catch(() => []);
  const names = all.map(w => w.name);
  return `[WORKFLOW_NOT_FOUND] no workflow named "${normalizeWorkflowName(name) || name}".${names.length ? ` Available: ${names.slice(0, 30).join(', ')}` : ' None saved yet — record one with workflow_record.'}`;
}

// ── workflow_run ─────────────────────────────────────────────────────────────

const RunArgs = z.object({
  name: z.string().min(1).describe('Workflow to replay (see workflow_list).'),
  params: z.array(z.object({
    name: z.string().describe('Param name, e.g. "query"'),
    value: z.string().describe('Value. For a secret param use "vault:<entry>" to fill it from the QodeX vault.'),
  })).describe('Values for the workflow\'s {{params}}.').optional(),
  dry_run: z.boolean().describe('Only validate params and list the steps; don\'t touch the browser.').optional(),
  start_step: z.number().describe('1-based step to start from — resume after you finished a failed step by hand.').optional(),
  use_examples: z.boolean().describe('Use the recorded example value for any param you don\'t pass (default false).').optional(),
});

export class WorkflowRunTool extends Tool<z.infer<typeof RunArgs>> {
  name = 'workflow_run';
  description =
    'Replay a saved browser workflow in the QodeX browser with the given params — much faster than redoing it step by step. ' +
    'Targets self-heal (selector → role/name → text → label) when the page changed; purchases, payments, sending and credentials still need Sentinel approval. ' +
    'If a step fails the report says where: take over with browser_snapshot + browser_* tools, then resume with start_step. Use dry_run to see required params.';
  isReadOnly = false;
  isDestructive = false;
  timeoutSeconds = 600;
  /**
   * Deliberately false: page-derived text (extracted content, page title) is
   * fenced by the tool itself (Sentinel's scanner/fence when installed), so the
   * report's own status lines and resume instructions are NOT wrapped as
   * untrusted data the model must ignore.
   */
  untrustedOutput = false;
  argsSchema = RunArgs;

  /** Models often pass params as an object ({"query": "x"}) or a JSON string — accept both. */
  coerceArgs(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const r = { ...(raw as Record<string, unknown>) };
    let p = r.params;
    if (typeof p === 'string') {
      try { p = JSON.parse(p); } catch { /* leave for validation */ }
    }
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      p = Object.entries(p as Record<string, unknown>).map(([name, value]) => ({ name, value: typeof value === 'string' ? value : JSON.stringify(value) }));
    }
    if (Array.isArray(p)) {
      p = p.map(it => (it && typeof it === 'object' && 'value' in it && typeof (it as any).value !== 'string')
        ? { ...(it as object), value: (it as any).value === undefined || (it as any).value === null ? '' : String((it as any).value) }
        : it);
    }
    if (p !== undefined) r.params = p;
    return r;
  }

  async execute(args: z.infer<typeof RunArgs>, ctx: ToolContext): Promise<ToolResult> {
    const store = new WorkflowStore();
    let wf: Workflow | null;
    try {
      wf = await store.load(args.name);
    } catch (e: any) {
      return err(String(e?.message ?? e));
    }
    if (!wf) return err(await notFound(store, args.name));
    const params = args.params ?? [];
    let report: ReplayReport;
    try {
      report = await runWorkflow(wf, params, {
        signal: ctx.signal,
        ctx,
        cwd: ctx.cwd,
        dryRun: args.dry_run === true,
        startStep: args.start_step,
        useExamples: args.use_examples === true,
        onStep: ev => {
          if (ev.type === 'start') ctx.emit({ type: 'progress', message: `workflow ${wf!.name}: step ${ev.step || 'start'}/${ev.total} ${ev.description}` });
          else if (ev.type === 'waiting') ctx.emit({ type: 'progress', message: `workflow ${wf!.name}: waiting — a human has control of the browser` });
        },
      });
    } catch (e: any) {
      return err(`[WORKFLOW_ERROR] ${String(e?.message ?? e)}`);
    }
    const content = formatReplayReport(report, wf, params, await resolveDefaultFence());
    if (!report.dryRun) {
      getBus().publish({
        kind: 'agent', source: 'workflows', type: report.ok ? 'workflow.completed' : 'workflow.failed',
        data: { name: wf.name, steps: report.steps.length, failedStep: report.failedStep, error: report.error },
      });
    }
    return {
      content,
      ...(report.ok ? {} : { isError: true }),
      metadata: { workflow: wf.name, ok: report.ok, failedStep: report.failedStep, finalUrl: report.finalUrl, summary: summarize(wf, store.filePath(wf.name)) },
    };
  }
}

export const WORKFLOW_TOOL_CLASSES = [WorkflowRecordTool, WorkflowListTool, WorkflowShowTool, WorkflowRunTool] as const;
