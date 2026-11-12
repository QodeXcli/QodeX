/**
 * Model rewrite of skill prose.
 *
 * The model may clarify the trigger and the steps. It may not change the name,
 * the tool list, the witness patch, or the fact that this is still a candidate.
 * The active skill is never overwritten. Promotion is still a witness or an
 * independent judge, not this rewrite.
 */
import { loadConfig } from '../../config/loader.js';
import { ModelRouter } from '../../llm/router.js';
import { loadSkillByName, projectSkillsDir, userSkillsDir } from '../loader.js';
import { readCandidate, writeCandidate } from './candidate-store.js';
import { recordLearningEvent } from './ledger.js';
import { promises as fs } from 'fs';
import * as path from 'path';

export function splitWitness(md: string): { prose: string; witness: string } {
  const m = md.match(/\n## Witness (?:patch|replay)\b[\s\S]*$/);
  if (!m || m.index == null) return { prose: md.trimEnd(), witness: '' };
  return { prose: md.slice(0, m.index).trimEnd(), witness: md.slice(m.index).trim() + '\n' };
}

export function skillToolList(md: string): string[] {
  const lines = md.split('\n');
  const start = lines.findIndex(l => l.startsWith('allowed-tools:'));
  if (start < 0) return [];
  const inline = lines[start].slice('allowed-tools:'.length).trim();
  if (inline === '[]' || inline === '') {
    if (inline === '[]') return [];
  } else {
    return [...inline.matchAll(/[a-z][a-z0-9_:-]*/g)].map(m => m[0]).filter(t => t.length > 1);
  }
  const tools: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const item = lines[i].match(/^\s+-\s+(.+)$/);
    if (!item) break;
    tools.push(item[1].trim());
  }
  return tools;
}

/** Fail closed. Anything that is not DESCRIPTION + BODY is not a rewrite. */
export function parseRewriteDraft(text: string): { description: string; body: string } | { error: string } {
  const raw = (text ?? '').trim();
  const desc = raw.match(/^DESCRIPTION:\s*(.+)$/m);
  const parts = raw.split(/^BODY:\s*$/m);
  if (!desc || parts.length < 2) return { error: 'model did not return DESCRIPTION and BODY' };
  const description = desc[1].trim();
  if (description.length < 8 || description.length > 200) return { error: 'description must be 8–200 characters' };
  let body = parts.slice(1).join('BODY:\n').trim();
  body = body.replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '').trim();
  if (body.length < 80) return { error: 'body is too short to be a procedure' };
  if (body.length > 12000) return { error: 'body is too long' };
  if (/^---/.test(body) || /\nprovenance:\s*human\b/i.test(body) || /\nstatus:\s*active\b/i.test(body)) {
    return { error: 'rewrite tried to change provenance or status' };
  }
  return { description, body };
}

export function assembleRewrite(input: {
  name: string;
  original: string;
  description: string;
  body: string;
  model: string;
  nowIso: string;
}): { ok: true; skillMd: string } | { ok: false; reason: string } {
  if (!/^[a-z][a-z0-9-]*$/.test(input.name)) return { ok: false, reason: 'bad skill name' };
  const tools = skillToolList(input.original);
  const { witness } = splitWitness(input.original);
  const prose = splitWitness(input.body).prose.trim();
  if (prose.length < 80) return { ok: false, reason: 'body is too short to be a procedure' };
  const originalLen = splitWitness(stripFrontmatter(input.original)).prose.length;
  if (prose.length > Math.max(8000, originalLen * 3)) return { ok: false, reason: 'rewrite grew far past the original' };
  const captured = input.original.match(/^captured-at:\s*(.+)$/m)?.[1]?.trim();
  const confidence = input.original.match(/^confidence:\s*(\d+)/m)?.[1];
  const toolLine = tools.length
    ? `allowed-tools:\n${tools.map(t => `  - ${t}`).join('\n')}`
    : 'allowed-tools: []';
  const model = input.model.replace(/[\r\n"]/g, '').trim().slice(0, 80);
  if (!model) return { ok: false, reason: 'rewrite has no model name' };
  const description = input.description.replace(/\s+/g, ' ').trim();
  const skillMd = `---
name: ${input.name}
description: ${description}
provenance: machine
status: candidate${confidence ? `\nconfidence: ${confidence}` : ''}
${toolLine}
captured-at: ${captured ?? input.nowIso}
rewritten-by: "${model}"
rewritten-at: ${input.nowIso}
---

${prose}
${witness ? `\n${witness.trim()}\n` : ''}`;
  if (!skillMd.includes('status: candidate') || skillMd.includes('provenance: human')) {
    return { ok: false, reason: 'refusing to write a rewrite that is not a machine candidate' };
  }
  return { ok: true, skillMd };
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---[\s\S]*?---\s*/, '');
}

async function readOriginal(name: string, cwd: string): Promise<string | null> {
  const candidate = await readCandidate(name);
  if (candidate) return candidate;
  const spec = await loadSkillByName(name, cwd);
  if (!spec) return null;
  for (const root of [projectSkillsDir(cwd), userSkillsDir()]) {
    try {
      return await fs.readFile(path.join(root, name, 'SKILL.md'), 'utf-8');
    } catch { /* next */ }
  }
  return null;
}

const SYSTEM = [
  'You rewrite the prose of one existing skill so a person can follow it.',
  'Do not add tools, files, commands, or steps that are not already in the skill.',
  'Do not claim the skill was verified, promoted, or written by a human.',
  'Return exactly this shape and nothing else:',
  'DESCRIPTION: <one line, 8 to 200 characters>',
  'BODY:',
  '<markdown only. No YAML frontmatter.>',
].join('\n');

export async function rewriteSkillText(opts: {
  name: string;
  cwd: string;
  nowIso?: string;
  complete?: (input: { system: string; user: string }) => Promise<{ text: string; model: string }>;
}): Promise<{ ok: true; file: string; model: string } | { ok: false; reason: string }> {
  const name = opts.name.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return { ok: false, reason: 'bad skill name' };
  const original = await readOriginal(name, opts.cwd);
  if (!original) return { ok: false, reason: `no skill named "${name}"` };
  let text = '';
  let model = '';
  try {
    const done = opts.complete
      ? await opts.complete({ system: SYSTEM, user: original.slice(0, 12000) })
      : await completeWithRouter(opts.cwd, original);
    text = done.text;
    model = done.model;
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? 'model call failed' };
  }
  if (!model.trim()) return { ok: false, reason: 'no model is configured — nothing was written' };
  const parsed = parseRewriteDraft(text);
  if ('error' in parsed) return { ok: false, reason: parsed.error };
  const built = assembleRewrite({
    name,
    original,
    description: parsed.description,
    body: parsed.body,
    model,
    nowIso: opts.nowIso ?? new Date().toISOString(),
  });
  if (!built.ok) return built;
  const file = await writeCandidate({ name, description: parsed.description, skillMd: built.skillMd });
  await recordLearningEvent({ event: 'rewrite', name, judge: model });
  return { ok: true, file, model };
}

async function completeWithRouter(cwd: string, original: string): Promise<{ text: string; model: string }> {
  try {
    const { loadEnvFileIntoProcess } = await import('../../setup/env-writer.js');
    await loadEnvFileIntoProcess();
  } catch { /* no env file */ }
  const config = await loadConfig(cwd);
  const router = new ModelRouter(config);
  await router.initialize();
  const explicit = String((config as any).learning?.rewriteModel ?? '').trim();
  const route = router.route('reflection', 2000, explicit ? { explicitModel: explicit } : {});
  if (!route?.model) throw new Error('no model is configured — nothing was written');
  let text = '';
  for await (const ev of route.provider.complete({
    model: route.model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: original.slice(0, 12000) }],
    temperature: 0,
  } as any)) {
    if (ev?.type === 'text_delta') text += ev.delta ?? '';
  }
  return { text, model: route.model };
}
