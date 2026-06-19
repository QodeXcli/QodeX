/**
 * Auto tool profile — the "F1 driver" layer for tool selection.
 *
 * Instead of asking the user to hand-maintain `tools.disabled` in config, QodeX
 * inspects the project (what infrastructure actually exists) and the current
 * request (what the user is asking for) and disables tool groups that are dead
 * weight for THIS project — automatically, per session.
 *
 * Design rules, in order of authority:
 *   1. The USER is the boss: explicit `tools.disabled` entries always apply, and
 *      `tools.autoProfile: false` turns this layer off entirely.
 *   2. The PROMPT wins over project state: "dockerize this app" re-enables the
 *      docker group even if no Dockerfile exists yet (the user wants to CREATE
 *      one). Detection is bidirectional — absence of infra disables a group,
 *      mention of it in the request keeps it.
 *   3. Conservative by default: a group is auto-disabled only on a STRONG
 *      negative signal (no Dockerfile/compose anywhere AND no docker words in
 *      the prompt). When in doubt, keep the tool.
 *   4. Session ratchet (cache stability): groups can be re-ENABLED mid-session
 *      (prompt mentions them) but never newly disabled mid-session — the tool
 *      list only ever grows within a session, so the serialized tool schemas
 *      change at most a handful of times instead of oscillating every turn.
 *
 * Honest scope: this removes configuration friction and dead-weight tokens. It
 * does not make the model smarter — it makes the car lighter, not the driver
 * faster.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ProjectSignals } from '../llm/prompts/stack-profiles.js';

export interface InfraSignals {
  hasDocker: boolean;
  hasCi: boolean;
  hasOpenApi: boolean;
  hasMediaDeps: boolean;
  hasBackendDeps: boolean;
  hasCloudConfig: boolean;
}

/** Cheap filesystem + dependency sniff. Each check is fs.access on a fixed path —
 * a handful of stat calls, no directory walks. Best-effort: errors mean "absent". */
export async function gatherInfraSignals(cwd: string, signals: ProjectSignals): Promise<InfraSignals> {
  const exists = async (p: string) => {
    try { await fs.access(path.join(cwd, p)); return true; } catch { return false; }
  };
  const deps = new Set((signals.deps ?? []).map(d => d.toLowerCase()));

  const [dockerfile, composeYml, composeYaml, ghWorkflows, gitlabCi, circleci, openapiY, openapiJ, swaggerY, awsDir] =
    await Promise.all([
      exists('Dockerfile'), exists('docker-compose.yml'), exists('compose.yaml'),
      exists('.github/workflows'), exists('.gitlab-ci.yml'), exists('.circleci'),
      exists('openapi.yaml'), exists('openapi.json'), exists('swagger.yaml'),
      exists('.aws'),
    ]);

  return {
    hasDocker: dockerfile || composeYml || composeYaml,
    hasCi: ghWorkflows || gitlabCi || circleci,
    hasOpenApi: openapiY || openapiJ || swaggerY,
    hasMediaDeps: ['ffmpeg', 'fluent-ffmpeg', 'ffmpeg-static', 'sharp'].some(d => deps.has(d)),
    hasBackendDeps: ['express', 'fastify', 'koa', '@nestjs/core', 'hono', 'h3'].some(d => deps.has(d)),
    hasCloudConfig: awsDir,
  };
}

/** Tool groups this layer manages, with their member-name prefixes/names and the
 * prompt words that force-keep them. Browser/dev-server tools are deliberately
 * NOT managed: this user base is web-heavy and mis-disabling them costs far more
 * than their schema weight saves. */
const GROUPS: Array<{
  id: keyof InfraSignals | 'cloud';
  members: (name: string) => boolean;
  keepIfPrompt: RegExp;
  keepIfInfra: (s: InfraSignals) => boolean;
}> = [
  {
    id: 'hasDocker',
    members: n => n.startsWith('docker_'),
    keepIfPrompt: /docker|container|compose|image\s+build|dockerize|کانتینر|داکر/i,
    keepIfInfra: s => s.hasDocker,
  },
  {
    id: 'hasCi',
    members: n => n === 'ci_status',
    keepIfPrompt: /\bci\b|pipeline|workflow|github\s*action|gitlab|سی‌آی|پایپ‌لاین/i,
    keepIfInfra: s => s.hasCi,
  },
  {
    id: 'hasOpenApi',
    members: n => n === 'openapi_digest',
    keepIfPrompt: /openapi|swagger|api\s*spec|سوئگر/i,
    keepIfInfra: s => s.hasOpenApi,
  },
  {
    id: 'hasMediaDeps',
    members: n => n.startsWith('media_'),
    keepIfPrompt: /video|audio|ffmpeg|\bmp4\b|\bmp3\b|\bwav\b|media\s*(file|transform|convert)|ویدیو|ویدئو|صوت|فیلم/i,
    keepIfInfra: s => s.hasMediaDeps,
  },
  {
    id: 'hasBackendDeps',
    members: n => n === 'backend_routemap',
    keepIfPrompt: /\broutes?\b|endpoints?|backend|روت|بک‌اند/i,
    keepIfInfra: s => s.hasBackendDeps,
  },
  {
    id: 'cloud',
    members: n => n === 's3_sync' || n === 'network_optimize',
    keepIfPrompt: /\bs3\b|bucket|\bcdn\b|deploy|upload.*cloud|آپلود.*ابر|دیپلوی/i,
    keepIfInfra: s => s.hasCloudConfig,
  },
];

/**
 * Pure decision: given infra signals, the user's request, and all registered tool
 * names, return the tool names to auto-disable for this session. A group survives
 * if EITHER its infrastructure exists OR the prompt mentions it.
 */
export function deriveAutoDisabledTools(
  infra: InfraSignals,
  prompt: string,
  allNames: string[],
): string[] {
  const out = new Set<string>();
  for (const g of GROUPS) {
    if (g.keepIfInfra(infra)) continue;
    if (g.keepIfPrompt.test(prompt)) continue;
    for (const n of allNames) if (g.members(n)) out.add(n);
  }
  return [...out].sort();
}

/**
 * Session ratchet: given the previously auto-disabled set and a NEW prompt,
 * return the set with any now-mentioned groups re-enabled (removed). Disables
 * are never added mid-session — the tool list only grows. Pure.
 */
export function ratchetAutoDisabled(prevDisabled: string[], prompt: string): string[] {
  if (prevDisabled.length === 0) return prevDisabled;
  const keep = new Set(prevDisabled);
  for (const g of GROUPS) {
    if (!g.keepIfPrompt.test(prompt)) continue;
    for (const n of [...keep]) if (g.members(n)) keep.delete(n);
  }
  return [...keep].sort();
}
