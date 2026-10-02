/**
 * Workflow store — JSON files under ~/.qodex/workflows/<name>.json.
 *
 * Files are plain, pretty-printed JSON so a user can read, diff and hand-edit a
 * recorded workflow (fix a selector, mark a step `optional`, add a `wait`).
 * Because files can be edited by hand, EVERYTHING read from disk goes through
 * `validateWorkflow`, which returns a cleaned, fully-typed copy plus errors /
 * warnings — the replay engine never sees a malformed step.
 *
 * Writes are atomic (temp + rename) with mode 0600: workflows can contain values
 * the user typed (emails, addresses), never secrets (secret params have no
 * example and password fields are stored as `{{param}}`).
 *
 * The directory is injectable for tests (`setWorkflowsDirForTests` or the
 * constructor argument).
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_WORKFLOWS_DIR } from '../config/paths.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import {
  STEP_KINDS,
  PARAM_NAME_RE,
  isValidWorkflowName,
  normalizeWorkflowName,
  placeholdersIn,
  stepHasReplayableTarget,
  stepNeedsTarget,
  workflowPlaceholders,
  type VaultField,
  type Workflow,
  type WorkflowParam,
  type WorkflowSource,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowSummary,
} from './types.js';

let dirOverride: string | null = null;

/** Test hook: point the default store at a temp dir (null = back to ~/.qodex/workflows). */
export function setWorkflowsDirForTests(dir: string | null): void {
  dirOverride = dir;
}

export function getWorkflowsDir(): string {
  return dirOverride ?? QODEX_WORKFLOWS_DIR;
}

// ── validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Cleaned workflow (only when ok). */
  workflow?: Workflow;
}

const MAX_STEPS = 500;
const MAX_STR = 20_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function optStr(v: unknown, max = MAX_STR): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  return v.length > max ? v.slice(0, max) : v;
}
function optNum(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function optStrList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(String);
  return out.length ? out : undefined;
}

const SOURCES: readonly WorkflowSource[] = ['agent', 'human', 'mixed'];
const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
const BUTTONS = ['left', 'right', 'middle'] as const;
const MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift'] as const;
const VAULT_FIELDS: readonly VaultField[] = ['username', 'password', 'totp'];

function cleanStep(raw: unknown, i: number, errors: string[], warnings: string[]): WorkflowStep | null {
  const n = i + 1;
  if (!isObj(raw)) { errors.push(`step ${n}: not an object`); return null; }
  const kind = raw.kind as WorkflowStepKind;
  if (!(STEP_KINDS as readonly unknown[]).includes(kind)) {
    errors.push(`step ${n}: unknown kind ${JSON.stringify(raw.kind)} (expected one of ${STEP_KINDS.join(', ')})`);
    return null;
  }
  const s: WorkflowStep = { kind };
  const str = (k: keyof WorkflowStep, max?: number) => {
    const v = optStr(raw[k as string], max);
    if (v !== undefined) (s as any)[k] = v;
  };
  str('url', 4000); str('selector', 2000); str('ref', 40); str('role', 60); str('name', 500);
  str('text', 2000); str('value'); str('key', 80); str('note', 1000);
  const values = optStrList(raw.values); if (values) s.values = values;
  const files = optStrList(raw.files); if (files) s.files = files;
  if ((DIRECTIONS as readonly unknown[]).includes(raw.direction)) s.direction = raw.direction as WorkflowStep['direction'];
  const amount = optNum(raw.amount, 1, 100_000); if (amount !== undefined) s.amount = amount;
  const index = optNum(raw.index, 0, 1000); if (index !== undefined) s.index = index;
  if (raw.newTab === true) s.newTab = true;
  if (raw.double === true) s.double = true;
  if ((BUTTONS as readonly unknown[]).includes(raw.button) && raw.button !== 'left') s.button = raw.button as WorkflowStep['button'];
  if (Array.isArray(raw.modifiers)) {
    const mods = raw.modifiers.filter((m): m is NonNullable<WorkflowStep['modifiers']>[number] => (MODIFIERS as readonly unknown[]).includes(m));
    if (mods.length) s.modifiers = [...new Set(mods)];
  }
  const waitMs = optNum(raw.waitMs, 0, 600_000); if (waitMs !== undefined) s.waitMs = waitMs;
  if (raw.optional === true) s.optional = true;
  if (raw.actor === 'agent' || raw.actor === 'human') s.actor = raw.actor;

  // Per-kind requirements.
  switch (kind) {
    case 'navigate':
      if (!s.url) { errors.push(`step ${n} (navigate): missing url`); return null; }
      break;
    case 'fill': case 'type':
      if (s.value === undefined) { errors.push(`step ${n} (${kind}): missing value`); return null; }
      break;
    case 'select':
      if (!s.values?.length && s.value === undefined) { errors.push(`step ${n} (select): missing value(s)`); return null; }
      break;
    case 'press':
      if (!s.key) { errors.push(`step ${n} (press): missing key`); return null; }
      break;
    case 'upload':
      if (!s.files?.length) { errors.push(`step ${n} (upload): missing files`); return null; }
      break;
    case 'wait':
      if (s.waitMs === undefined && !s.text && !s.selector && !s.url) {
        errors.push(`step ${n} (wait): needs waitMs, text, selector or url`);
        return null;
      }
      break;
    case 'history':
      if (!s.value) s.value = 'back';
      if (!['back', 'forward', 'reload'].includes(s.value)) { errors.push(`step ${n} (history): value must be back|forward|reload`); return null; }
      break;
    case 'tab':
      if (!s.value) s.value = 'new';
      if (!['new', 'switch', 'close'].includes(s.value)) { errors.push(`step ${n} (tab): value must be new|switch|close`); return null; }
      if (s.value === 'switch' && s.index === undefined) { errors.push(`step ${n} (tab switch): missing index`); return null; }
      break;
    default:
      break;
  }
  if (stepNeedsTarget(s) && !stepHasReplayableTarget(s)) {
    warnings.push(`step ${n} (${kind}): no selector/role/name — only a snapshot ref; replay will stop here (edit the workflow to add a selector)`);
  }
  return s;
}

function cleanParam(raw: unknown, i: number, errors: string[], warnings: string[]): WorkflowParam | null {
  if (!isObj(raw)) { errors.push(`param ${i + 1}: not an object`); return null; }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!PARAM_NAME_RE.test(name)) {
    errors.push(`param ${i + 1}: invalid name ${JSON.stringify(raw.name)} (use [a-z_][a-z0-9_]*)`);
    return null;
  }
  const p: WorkflowParam = { name };
  const description = optStr(raw.description, 500); if (description) p.description = description;
  if (raw.secret === true) p.secret = true;
  const example = optStr(raw.example, 2000);
  if (example !== undefined) {
    if (p.secret) warnings.push(`param ${name}: secret params never keep an example — dropped`);
    else p.example = example;
  }
  const def = optStr(raw.default, 2000);
  if (def !== undefined) {
    // A literal secret default would sit on disk in clear text; only vault references are allowed.
    if (p.secret && !/^vault:\S+$/.test(def)) warnings.push(`param ${name}: secret params may only default to "vault:<entry>" — dropped`);
    else p.default = def;
  }
  if ((VAULT_FIELDS as readonly unknown[]).includes(raw.vaultField)) p.vaultField = raw.vaultField as VaultField;
  return p;
}

/** Validate + normalize a workflow object (from disk, the recorder or a user). PURE. */
export function validateWorkflow(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['workflow must be a JSON object'], warnings };

  const rawName = typeof raw.name === 'string' ? raw.name : '';
  const name = isValidWorkflowName(rawName) ? rawName : normalizeWorkflowName(rawName);
  if (!name) errors.push('missing name');
  else if (name !== rawName) warnings.push(`name normalized to "${name}"`);

  if (raw.version !== undefined && raw.version !== 1) errors.push(`unsupported version ${JSON.stringify(raw.version)} (expected 1)`);

  const source: WorkflowSource = (SOURCES as readonly unknown[]).includes(raw.source) ? raw.source as WorkflowSource : 'agent';

  const params: WorkflowParam[] = [];
  const seenParams = new Set<string>();
  if (raw.params !== undefined && !Array.isArray(raw.params)) errors.push('params must be an array');
  for (const [i, p] of (Array.isArray(raw.params) ? raw.params : []).entries()) {
    const c = cleanParam(p, i, errors, warnings);
    if (!c) continue;
    if (seenParams.has(c.name)) { errors.push(`duplicate param ${c.name}`); continue; }
    seenParams.add(c.name);
    params.push(c);
  }

  const steps: WorkflowStep[] = [];
  if (!Array.isArray(raw.steps)) errors.push('steps must be an array');
  else {
    if (raw.steps.length === 0) errors.push('workflow has no steps');
    if (raw.steps.length > MAX_STEPS) errors.push(`too many steps (${raw.steps.length} > ${MAX_STEPS})`);
    for (const [i, st] of raw.steps.slice(0, MAX_STEPS).entries()) {
      const c = cleanStep(st, i, errors, warnings);
      if (c) steps.push(c);
    }
  }

  const startUrl = optStr(raw.startUrl, 4000);
  const used = workflowPlaceholders({ steps });
  for (const p of used) {
    if (!seenParams.has(p)) warnings.push(`step placeholder {{${p}}} has no param definition (it will still be required at run time)`);
  }
  for (const p of placeholdersIn(startUrl)) {
    if (!seenParams.has(p)) warnings.push(`startUrl placeholder {{${p}}} has no param definition`);
  }

  if (errors.length) return { ok: false, errors, warnings };

  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString();
  const wf: Workflow = {
    name,
    ...(typeof raw.title === 'string' && raw.title.trim() && raw.title.trim() !== name ? { title: raw.title.trim().slice(0, 200) } : {}),
    description: typeof raw.description === 'string' ? raw.description.slice(0, 2000) : '',
    version: 1,
    createdAt,
    ...(typeof raw.updatedAt === 'string' && raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
    source,
    ...(startUrl ? { startUrl } : {}),
    params,
    steps,
  };
  return { ok: true, errors, warnings, workflow: wf };
}

/** Params a run must supply: referenced, declared-or-not, with no default. */
export function requiredParams(wf: Workflow, fromIndex = 0): string[] {
  const byName = new Map(wf.params.map(p => [p.name, p]));
  const refs = workflowPlaceholders(wf, fromIndex);
  if (fromIndex === 0) for (const p of placeholdersIn(wf.startUrl)) if (!refs.includes(p)) refs.push(p);
  return refs.filter(n => byName.get(n)?.default === undefined);
}

// ── store ────────────────────────────────────────────────────────────────────

export class WorkflowError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`[${code}] ${message}`);
  }
}

export class WorkflowStore {
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? getWorkflowsDir();
  }

  /** Resolve the file for a (possibly un-normalized) name. Throws on an unusable name. */
  filePath(name: string): string {
    const id = isValidWorkflowName(name) ? name : normalizeWorkflowName(name);
    if (!id) throw new WorkflowError('WORKFLOW_NAME', `invalid workflow name ${JSON.stringify(name)}`);
    return path.join(this.dir, `${id}.json`);
  }

  async exists(name: string): Promise<boolean> {
    try { await fs.access(this.filePath(name)); return true; } catch { return false; }
  }

  /** Validate + write. Returns the cleaned workflow, its path and validation warnings. */
  async save(wf: Workflow, opts: { overwrite?: boolean } = {}): Promise<{ workflow: Workflow; file: string; warnings: string[] }> {
    const v = validateWorkflow(wf);
    if (!v.ok || !v.workflow) throw new WorkflowError('WORKFLOW_INVALID', v.errors.join('; '));
    const file = this.filePath(v.workflow.name);
    if (!opts.overwrite && await this.exists(v.workflow.name)) {
      throw new WorkflowError('WORKFLOW_EXISTS', `a workflow named "${v.workflow.name}" already exists — pick another name or overwrite it explicitly`);
    }
    await fs.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(file, JSON.stringify(v.workflow, null, 2) + '\n', { mode: 0o600 });
    return { workflow: v.workflow, file, warnings: v.warnings };
  }

  /** Load by name (normalized). null when missing; throws WORKFLOW_INVALID for a corrupt file. */
  async load(name: string): Promise<Workflow | null> {
    const file = this.filePath(name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf-8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      throw new WorkflowError('WORKFLOW_INVALID', `${file} is not valid JSON: ${e?.message ?? e}`);
    }
    const v = validateWorkflow(parsed);
    if (!v.ok || !v.workflow) throw new WorkflowError('WORKFLOW_INVALID', `${file}: ${v.errors.join('; ')}`);
    return v.workflow;
  }

  async list(): Promise<Array<WorkflowSummary | { name: string; file: string; invalid: string }>> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: Array<WorkflowSummary | { name: string; file: string; invalid: string }> = [];
    for (const f of entries.sort()) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      const name = f.slice(0, -'.json'.length);
      const file = path.join(this.dir, f);
      try {
        const wf = await this.load(name);
        if (!wf) continue;
        out.push(summarize(wf, file));
      } catch (e: any) {
        out.push({ name, file, invalid: String(e?.message ?? e) });
      }
    }
    return out;
  }

  async remove(name: string): Promise<boolean> {
    try {
      await fs.unlink(this.filePath(name));
      return true;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return false;
      throw e;
    }
  }
}

export function summarize(wf: Workflow, file: string): WorkflowSummary {
  const required = new Set(requiredParams(wf));
  return {
    name: wf.name,
    ...(wf.title ? { title: wf.title } : {}),
    description: wf.description,
    source: wf.source,
    steps: wf.steps.length,
    params: wf.params.map(p => ({ name: p.name, ...(p.secret ? { secret: true } : {}), required: required.has(p.name) })),
    createdAt: wf.createdAt,
    ...(wf.updatedAt ? { updatedAt: wf.updatedAt } : {}),
    ...(wf.startUrl ? { startUrl: wf.startUrl } : {}),
    file,
  };
}
