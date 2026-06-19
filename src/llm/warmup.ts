import type { ModelRouter } from './router.js';
import type { QodexConfig } from '../config/defaults.js';
import { logger } from '../utils/logger.js';

/**
 * Cold-start killer. On a local backend (LM Studio / Ollama) the FIRST request to a model
 * that isn't resident pays a multi-GB load — tens of seconds — before a single token streams.
 * That's the bulk of the "why did my first prompt take a minute?" pain. This fires a tiny
 * 1-token completion at the configured default model so the server loads it into memory while
 * the user is still reading the welcome screen / typing — by the time they hit Enter it's warm.
 *
 * Rules:
 *  - LOCAL models only. We never spend money warming a paid cloud model.
 *  - Fully non-blocking and silent: the UI must come up instantly; any failure (server down,
 *    model missing) is swallowed — warming is best-effort, never a hard dependency.
 *  - Cheap: one token, temperature 0, no tools.
 *
 * Caveat (honest): a machine can usually hold ONE large model resident. If your work bounces
 * between, say, a 235B default and a smaller coder model, warming the default helps the first
 * prompt but a later task that routes to the other model still pays a swap. Point
 * `defaults.model` at whatever you actually use most, and raise LM Studio's model TTL so it
 * doesn't auto-unload while idle.
 */
export async function warmModel(
  router: ModelRouter,
  config: QodexConfig,
  opts: { timeoutMs?: number } = {},
): Promise<{ warmed: boolean; reason: string }> {
  try {
    const modelId = config.defaults.model;
    const resolved = router.resolveModel(modelId);
    if (!resolved) return { warmed: false, reason: 'model-not-resolved' };
    if (!resolved.provider.isLocal) return { warmed: false, reason: 'cloud-skip' };

    const timeoutMs = opts.timeoutMs ?? 120_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const gen = resolved.provider.complete({
        model: resolved.resolvedId,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        temperature: 0,
        signal: ac.signal,
      } as any);
      // Draining the first event is enough — the server loads the model before it streams.
      for await (const _ev of gen) break;
      logger.info('Model warmed', { model: resolved.resolvedId });
      return { warmed: true, reason: 'ok' };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    logger.warn('Model warm-up skipped', { err: (e as Error)?.message });
    return { warmed: false, reason: 'error' };
  }
}
