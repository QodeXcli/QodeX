/**
 * Provider connectivity test — does this endpoint actually answer with the configured key?
 * For OpenAI-compatible providers we GET `{baseUrl}/models`; a 200 with a model list means the
 * URL + key work. Used by `qodex provider` and the dashboard's "Test" button so you find out a
 * provider is misconfigured here, not mid-task.
 *
 * buildModelsUrl is PURE (unit-tested); probeProvider does the fetch and never throws.
 */

/** OpenAI-compatible model-list endpoint for a base URL (which already includes /v1). PURE. */
export function buildModelsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/models';
}

export interface ProbeResult { ok: boolean; detail: string }

/** Probe a provider's `/models`. Reads the API key from `keyEnv` (the env var name, not the
 *  secret). Returns a friendly result; never throws. */
export async function probeProvider(opts: { baseUrl: string; keyEnv?: string; timeoutMs?: number }): Promise<ProbeResult> {
  if (!opts.baseUrl) return { ok: false, detail: 'no base URL' };
  const key = opts.keyEnv ? process.env[opts.keyEnv] : undefined;
  if (opts.keyEnv && !key) return { ok: false, detail: `${opts.keyEnv} is not set — add it to ~/.qodex/.env` };
  try {
    const res = await fetch(buildModelsUrl(opts.baseUrl), {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}${res.status === 401 ? ' — bad/expired key' : ''}` };
    const j: any = await res.json().catch(() => null);
    const n = Array.isArray(j?.data) ? j.data.length : (Array.isArray(j?.models) ? j.models.length : undefined);
    return { ok: true, detail: n != null ? `reachable — ${n} model(s)` : 'reachable' };
  } catch (e: any) {
    return { ok: false, detail: e?.name === 'TimeoutError' ? 'timed out — endpoint unreachable' : (e?.message ?? 'unreachable') };
  }
}
