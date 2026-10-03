/**
 * `qodex checkup` / `/checkup` — opt-in health checks that write a report and change nothing.
 * Today there is one check, `prompt-audit`; `/checkup` alone lists them so new checks are
 * discoverable without reading the docs.
 */

import type { PromptAuditResult } from './prompt-audit.js';

export interface CheckupCheck {
  name: string;
  description: string;
  usage: string;
}

export const CHECKUP_CHECKS: readonly CheckupCheck[] = [
  {
    name: 'prompt-audit',
    description: 'Audit QODEX.md / AGENTS.md / CLAUDE.md / GEMINI.md / AI.md, skills, custom commands and mod manifests for stale paths, stale model names, ALL-CAPS shouting, contradictions, duplicates, unknown tools/commands and oversized files. Writes PROMPT_AUDIT.md + prompt-audit.patch in the project root; applies nothing.',
    usage: 'prompt-audit [--no-model]',
  },
];

/** The `/checkup` listing. PURE. */
export function describeChecks(prefix = '/checkup'): string {
  const lines = ['Available checks:', ''];
  for (const c of CHECKUP_CHECKS) {
    lines.push(`  ${prefix} ${c.usage}`);
    lines.push(`      ${c.description}`);
  }
  lines.push('', 'Each check only reads; its findings and proposed edits go to files you review.');
  return lines.join('\n');
}

/**
 * The model pass through the configured router: the reflection role (falls back to the default
 * model, as `route` does). Returns a reason instead of a model when nothing can be routed —
 * the deterministic findings are still written in that case.
 */
export async function routerAuditModel(cwd: string, config?: any): Promise<
  { model: { name: string; complete: (system: string, user: string, signal?: AbortSignal) => Promise<string> } } | { reason: string }
> {
  try {
    // Outside the main bootstrap ~/.qodex/.env is not loaded yet; without it cloud keys are invisible.
    try {
      const { loadEnvFileIntoProcess } = await import('../setup/env-writer.js');
      await loadEnvFileIntoProcess();
    } catch { /* best-effort */ }
    const cfg = config ?? (await (await import('../config/loader.js')).loadConfig(cwd));
    const { ModelRouter } = await import('../llm/router.js');
    const router = new ModelRouter(cfg);
    await router.initialize();
    if (router.listAvailableModels().length === 0) return { reason: 'no model available' };
    const route = router.route('reflection', 4000);
    return {
      model: {
        name: `${route.provider.name}/${route.model}`,
        complete: async (system, user, signal) => {
          let text = '';
          const stream = route.provider.complete({
            model: route.model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            maxTokens: 8000, // room for thinking on models that always think, plus the JSON
            signal,
          });
          for await (const ev of stream) {
            if (ev.type === 'text_delta') text += ev.delta ?? '';
            else if (ev.type === 'error') throw new Error(ev.error ?? 'model error');
          }
          return text;
        },
      },
    };
  } catch (e: any) {
    return { reason: `no model available (${e?.message ?? String(e)})` };
  }
}

/** Tool-name check against the live registry (aliases included). */
export async function registryToolCheck(): Promise<((name: string) => boolean) | undefined> {
  try {
    const { getRegistry } = await import('../tools/registry.js');
    const reg = getRegistry();
    return (name: string) => !!reg.get(name);
  } catch {
    return undefined;
  }
}

/**
 * Run `prompt-audit` the way the CLI and the slash command do: registry-backed tool check, the
 * router model unless `noModel`. Never touches the audited files.
 */
export async function runPromptAuditCheck(cwd: string, opts: { noModel?: boolean; config?: any } = {}): Promise<PromptAuditResult> {
  const { runPromptAudit } = await import('./prompt-audit.js');
  let model: { name: string; complete: (s: string, u: string, signal?: AbortSignal) => Promise<string> } | undefined;
  let modelUnavailableReason: string | undefined;
  if (!opts.noModel) {
    const r = await routerAuditModel(cwd, opts.config);
    if ('model' in r) model = r.model;
    else modelUnavailableReason = r.reason;
  }
  const targetModel = typeof opts.config?.defaults?.model === 'string' && /claude/i.test(opts.config.defaults.model)
    ? opts.config.defaults.model : undefined;
  return runPromptAudit({
    cwd,
    noModel: opts.noModel,
    model,
    modelUnavailableReason,
    isKnownTool: await registryToolCheck(),
    targetModel,
  });
}
