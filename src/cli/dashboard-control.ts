/**
 * Dashboard control plane — turns the read-only dashboard into a CONTROL panel.
 *
 * Every controllable capability is one entry in a small action registry (the same shape as the
 * bot command registry): add an action here and the dashboard can drive it. The dashboard server
 * (dashboard-server.ts) dispatches `{action, params}` POSTs through `dispatchAction`.
 *
 * Safety is deliberate:
 *   - Config writes go through a strict WHITELIST of (path, type) pairs — the dashboard can never
 *     write an arbitrary config key.
 *   - The validators are PURE and unit-tested; only the appliers touch disk / the store.
 */

export interface ActionResult { ok: boolean; message: string; }

/** Config paths the dashboard is allowed to set, with how to validate the value. */
export interface ConfigKnob { path: string; type: 'bool' | 'enum'; values?: string[]; label: string; group: string; }

export const CONFIG_KNOBS: ConfigKnob[] = [
  { path: 'providers.anthropic.useCaching', type: 'bool', label: 'Prompt caching (Anthropic)', group: 'Performance' },
  { path: 'context.efficient', type: 'bool', label: 'Efficient mode (sliding token window)', group: 'Performance' },
  { path: 'memory.mode', type: 'enum', values: ['full', 'lightweight', 'auto'], label: 'Memory injection', group: 'Memory' },
  { path: 'subagents.mode', type: 'enum', values: ['off', 'sequential', 'parallel'], label: 'Sub-agents', group: 'Performance' },
  { path: 'learning.enabled', type: 'bool', label: 'Skill learning', group: 'Learning' },
  { path: 'learning.episodicMemory.enabled', type: 'bool', label: 'Episodic memory', group: 'Learning' },
  { path: 'learning.failureLessons.enabled', type: 'bool', label: 'Failure lessons', group: 'Learning' },
];

const KNOB_BY_PATH = new Map(CONFIG_KNOBS.map(k => [k.path, k]));

/** Validate + coerce a config-set against the whitelist. PURE. */
export function validateConfigSet(path: string, value: unknown): { ok: true; coerced: boolean | string } | { ok: false; error: string } {
  const knob = KNOB_BY_PATH.get(path);
  if (!knob) return { ok: false, error: `"${path}" is not a controllable setting` };
  if (knob.type === 'bool') {
    if (value === true || value === false) return { ok: true, coerced: value };
    if (value === 'true' || value === 'false') return { ok: true, coerced: value === 'true' };
    return { ok: false, error: `${knob.label} expects true/false` };
  }
  // enum
  if (typeof value === 'string' && knob.values!.includes(value)) return { ok: true, coerced: value };
  return { ok: false, error: `${knob.label} expects one of: ${knob.values!.join(', ')}` };
}

/** Set a dotted path on a plain object, creating intermediate objects. PURE. */
export function setDeep(obj: Record<string, any>, dottedPath: string, value: unknown): void {
  const parts = dottedPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Read a dotted path from a plain object (for rendering current values). PURE. */
export function getDeep(obj: Record<string, any> | undefined, dottedPath: string): unknown {
  let cur: any = obj;
  for (const k of dottedPath.split('.')) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}

// ── appliers (impure) ────────────────────────────────────────────────────────────

async function writeConfigKnob(path: string, coerced: boolean | string | number): Promise<void> {
  const fs = await import('fs/promises');
  const yaml = await import('js-yaml');
  const { QODEX_CONFIG_FILE } = await import('../config/defaults.js');
  const { writeFileAtomic } = await import('../utils/atomic-write.js');
  let raw = ''; try { raw = await fs.readFile(QODEX_CONFIG_FILE, 'utf-8'); } catch { /* new file */ }
  const cfg: any = raw.trim() ? (yaml.load(raw) ?? {}) : {};
  setDeep(cfg, path, coerced);
  await writeFileAtomic(QODEX_CONFIG_FILE, yaml.dump(cfg, { lineWidth: 100, noRefs: true }));
}

/** Dispatch a dashboard action by name. Unknown actions are rejected. */
export async function dispatchAction(name: string, params: any, cwd: string): Promise<ActionResult> {
  try {
    switch (name) {
      case 'config.set': {
        const v = validateConfigSet(String(params?.key ?? ''), params?.value);
        if (!v.ok) return { ok: false, message: v.error };
        await writeConfigKnob(String(params.key), v.coerced);
        return { ok: true, message: `Set ${params.key} = ${v.coerced}. Takes effect on the next run.` };
      }
      case 'model.set': {
        // role: main (default) | subagent | vision | all — "all" points every role at one model,
        // which is all you need when that model has vision (no separate vision model required).
        const model = String(params?.model ?? '').trim();
        const role = String(params?.role ?? 'main').trim();
        if (!model) return { ok: false, message: 'Pick a model.' };
        if (!['main', 'subagent', 'vision', 'all'].includes(role)) return { ok: false, message: `Unknown role "${role}".` };
        const { inferProvider } = await import('../llm/role-resolver.js');
        const { looksVisionCapable } = await import('../setup/model-detector.js');
        const provider = inferProvider(model);
        const seesImages = looksVisionCapable(model);
        if (role === 'main' || role === 'all') await writeConfigKnob('defaults.model', model);
        if (role === 'subagent' || role === 'all') { await writeConfigKnob('roles.subagent.model', model); await writeConfigKnob('roles.subagent.provider', provider); }
        if (role === 'vision' || role === 'all') { await writeConfigKnob('roles.vision.model', model); await writeConfigKnob('roles.vision.provider', provider); }
        const visionNote = role === 'vision' && !seesImages
          ? ' ⚠️ this model does not look vision-capable — screenshots may fail.'
          : seesImages && role !== 'subagent' ? ' 👁 has vision — no separate vision model needed.' : '';
        const label = role === 'all' ? 'ALL roles (main + subagent + vision)' : role === 'main' ? 'Default model' : `${role} model`;
        return { ok: true, message: `${label} → ${model}.${visionNote} Takes effect on the next run.` };
      }
      case 'recall.query': {
        const q = String(params?.query ?? '').trim();
        if (!q) return { ok: false, message: 'Type what to recall.' };
        const { rankApproaches } = await import('../context/approach-recall.js');
        const { renderApproachDiffs } = await import('../context/approach-diff.js');
        const { getSessionStore } = await import('../session/store.js');
        const store = getSessionStore();
        const worklog = (() => { try { return store.getWorklog(cwd, 100).map((w: any) => ({ kind: 'worklog' as const, text: w.entry, when: String(w.created_at ?? '').slice(0, 10), at: w.created_at, detail: w.kind })); } catch { return []; } })();
        const episodes = await (async () => {
          try { const { readEpisodes } = await import('../context/episodic-memory.js'); return (await readEpisodes(cwd)).map((e: any) => ({ kind: 'episode' as const, text: `${e.prompt} ${e.summary}`, when: String(e.ts ?? '').slice(0, 10), at: e.ts, files: e.filesChanged, detail: e.summary })); }
          catch { return []; }
        })();
        const facts = (() => { try { return store.getFactsForCwd(cwd, 200).map((f: string) => ({ kind: 'fact' as const, text: f, when: '', detail: 'fact' })); } catch { return []; } })();
        const matches = rankApproaches(q, [...episodes, ...worklog, ...facts], { topK: 4, nowMs: Date.now(), diversity: 0.35 });
        return { ok: true, message: renderApproachDiffs(q, matches) };
      }
      case 'memory.add': {
        const fact = String(params?.fact ?? '').trim();
        if (!fact) return { ok: false, message: 'Nothing to remember.' };
        const scope = params?.scope === 'user' ? 'user' : 'project';
        const { getSessionStore } = await import('../session/store.js');
        getSessionStore().addFact('dashboard', cwd, fact, scope);
        try { const { exportMemory } = await import('../context/memory-mirror.js'); await exportMemory(cwd); } catch { /* mirror best-effort */ }
        return { ok: true, message: `Remembered (${scope}): ${fact.slice(0, 60)}` };
      }
      case 'skill.promote': {
        const name = String(params?.name ?? '').trim();
        if (!name) return { ok: false, message: 'No candidate named.' };
        const { promoteCandidate } = await import('../skills/learning/candidate-store.js');
        const r = await promoteCandidate(name, cwd);
        return r.promoted ? { ok: true, message: `Promoted "${name}".` } : { ok: false, message: r.reason ?? 'Promotion blocked.' };
      }
      case 'skill.reject': {
        const name = String(params?.name ?? '').trim();
        if (!name) return { ok: false, message: 'No candidate named.' };
        const { archiveCandidate } = await import('../skills/learning/candidate-store.js');
        const ok = await archiveCandidate(name);
        return ok ? { ok: true, message: `Rejected "${name}".` } : { ok: false, message: 'No such candidate.' };
      }
      case 'memory.forget': {
        const sub = String(params?.substring ?? '').trim();
        if (!sub) return { ok: false, message: 'Provide a substring to forget.' };
        const { getSessionStore } = await import('../session/store.js');
        const db = (getSessionStore() as any).db;
        const r = db.prepare(`DELETE FROM session_facts WHERE fact LIKE ?`).run(`%${sub}%`);
        try { const { exportMemory } = await import('../context/memory-mirror.js'); await exportMemory(cwd); } catch { /* mirror best-effort */ }
        return { ok: true, message: `Forgot ${r.changes} fact(s) matching "${sub}".` };
      }
      case 'schedule.add': {
        const name = String(params?.name ?? '').trim();
        const cron = String(params?.cron ?? '').trim();
        const prompt = String(params?.prompt ?? '').trim();
        if (!name || !cron || !prompt) return { ok: false, message: 'Need a name, cron, and prompt.' };
        const recipe = String(params?.recipe ?? '').trim() || undefined;
        const deliver = String(params?.deliver ?? '').trim() || undefined;
        if (recipe) { const { isRecipe } = await import('../schedule/recipes.js'); if (!isRecipe(recipe)) return { ok: false, message: `Unknown recipe "${recipe}".` }; }
        if (deliver) { const { parseDeliveryTarget } = await import('../schedule/delivery.js'); if (!parseDeliveryTarget(deliver)) return { ok: false, message: 'Deliver must be telegram:<id> / discord:<id> / slack:<id>.' }; }
        const { getScheduleStore } = await import('../schedule/store.js');
        try {
          const e = getScheduleStore().add({ name, cron, prompt, cwd, recipe, deliver }); // parseCron throws on bad cron
          return { ok: true, message: `Scheduled "${e.name}"${e.next_run_at ? ` — next ${new Date(e.next_run_at).toLocaleString()}` : ''}. Run \`qodex schedule install\` once.` };
        } catch (e: any) { return { ok: false, message: `Bad cron or input: ${e?.message}` }; }
      }
      case 'schedule.setEnabled': {
        const { getScheduleStore } = await import('../schedule/store.js');
        const e = getScheduleStore().setEnabled(String(params?.id ?? ''), !!params?.enabled);
        return e ? { ok: true, message: `${params.enabled ? 'Enabled' : 'Disabled'} "${e.name}".` } : { ok: false, message: 'No such schedule.' };
      }
      case 'schedule.remove': {
        const { getScheduleStore } = await import('../schedule/store.js');
        const ok = getScheduleStore().remove(String(params?.id ?? ''));
        return ok ? { ok: true, message: 'Schedule removed.' } : { ok: false, message: 'No such schedule.' };
      }
      case 'provider.add': {
        const name = String(params?.name ?? '').trim();
        const baseUrl = String(params?.baseUrl ?? '').trim();
        const keyEnv = String(params?.keyEnv ?? '').trim();
        if (!name || !baseUrl || !keyEnv) return { ok: false, message: 'Need a name, base URL, and key-env var.' };
        try {
          const { buildCustomEntry } = await import('../setup/gateways.js');
          const { addProviderToConfig } = await import('../setup/provider-writer.js');
          const entry = buildCustomEntry({ name, baseUrl, apiKeyEnv: keyEnv, modelId: params?.model ? String(params.model) : undefined });
          await addProviderToConfig(entry, params?.model ? { defaultModel: String(params.model) } : {});
          const { probeProvider } = await import('../setup/provider-test.js');
          const test = await probeProvider({ baseUrl, keyEnv });
          return { ok: true, message: `Added "${name}". Test: ${test.ok ? '✓ ' : '✗ '}${test.detail}` };
        } catch (e: any) { return { ok: false, message: `Add failed: ${e?.message ?? e}` }; }
      }
      case 'provider.test': {
        const name = String(params?.name ?? '').trim();
        const { loadConfig } = await import('../config/loader.js');
        const cfg: any = await loadConfig(cwd).catch(() => ({}));
        const builtin = cfg?.providers?.[name];
        const custom = (cfg?.providers?.custom ?? []).find((c: any) => c?.name === name);
        const p = custom ?? builtin;
        if (!p) return { ok: false, message: `No provider "${name}".` };
        const { probeProvider } = await import('../setup/provider-test.js');
        const r = await probeProvider({ baseUrl: p.baseUrl, keyEnv: p.apiKeyEnv });
        return { ok: r.ok, message: `${name}: ${r.ok ? '✓ ' : '✗ '}${r.detail}` };
      }
      case 'provider.remove': {
        const name = String(params?.name ?? '').trim();
        const fs = await import('fs/promises');
        const yaml = await import('js-yaml');
        const { QODEX_CONFIG_FILE } = await import('../config/defaults.js');
        let raw = ''; try { raw = await fs.readFile(QODEX_CONFIG_FILE, 'utf-8'); } catch { return { ok: false, message: 'No config file.' }; }
        const cfg: any = raw.trim() ? (yaml.load(raw) ?? {}) : {};
        const custom = cfg?.providers?.custom;
        if (!Array.isArray(custom) || !custom.some((c: any) => c?.name === name)) return { ok: false, message: `No custom provider "${name}".` };
        cfg.providers.custom = custom.filter((c: any) => c?.name !== name);
        const { writeFileAtomic } = await import('../utils/atomic-write.js');
        await writeFileAtomic(QODEX_CONFIG_FILE, yaml.dump(cfg, { lineWidth: 100, noRefs: true }));
        return { ok: true, message: `Removed "${name}".` };
      }
      case 'maintain.preview': {
        const { runMaintainPreview } = await import('./maintain-preview.js');
        const p = runMaintainPreview(cwd);
        if (!p.ran) return { ok: false, message: 'Couldn\'t run the detection (is this a TS project with tsc?).' };
        if (p.count === 0) return { ok: true, message: '✓ Nothing to clean — no unused symbols detected.' };
        const eg = p.sample.slice(0, 3).map(c => c.name).join(', ');
        return { ok: true, message: `🔍 ${p.count} unused symbol(s) maintain could clean (e.g. ${eg}). Schedule \`unused-imports\` / \`unused-locals\`.` };
      }
      case 'app.update': {
        const { selfUpdate } = await import('./self-update.js');
        const r = await selfUpdate();
        return { ok: r.ok, message: r.message };
      }
      case 'bot.start': {
        const { startBot } = await import('./bot-process.js');
        return startBot(cwd);
      }
      case 'bot.stop': {
        const { stopBot } = await import('./bot-process.js');
        return stopBot();
      }
      case 'offload.apply': {
        const { loadConfig } = await import('../config/loader.js');
        const cfg: any = await loadConfig(cwd).catch(() => ({}));
        const baseUrl = cfg?.providers?.ollama?.baseUrl ?? 'http://localhost:11434';
        const model = String(params?.model ?? cfg?.defaults?.model ?? '');
        if (!model) return { ok: false, message: 'No model to plan for.' };
        const { planOffload } = await import('../setup/offload-detect.js');
        const sug = await planOffload({ baseUrl, model, vramBudgetGB: params?.vram ? Number(params.vram) : undefined });
        if (!sug) return { ok: false, message: `Couldn't auto-detect VRAM/model facts for "${model}".` };
        await writeConfigKnob('providers.ollama.options.num_gpu', sug.plan.numGpu as any);
        return { ok: true, message: `Set num_gpu = ${sug.plan.numGpu} (${sug.plan.numGpu}/${sug.facts.totalLayers} layers on GPU).` };
      }
      default:
        return { ok: false, message: `Unknown action "${name}".` };
    }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}
