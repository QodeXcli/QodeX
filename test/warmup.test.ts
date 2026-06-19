import { describe, it, expect } from 'vitest';
import { warmModel } from '../src/llm/warmup.js';

// Minimal stubs — we only care about the warm-up decision + that complete() fires for local.
function makeRouter(opts: { isLocal: boolean; resolves?: boolean; onComplete?: () => void }) {
  return {
    resolveModel(_id: string) {
      if (opts.resolves === false) return null;
      return {
        resolvedId: 'test-model',
        modelInfo: {} as any,
        provider: {
          isLocal: opts.isLocal,
          async *complete(_req: any) {
            opts.onComplete?.();
            yield { type: 'text', text: 'x' } as any;
          },
        } as any,
      };
    },
  } as any;
}

const cfg = (model = 'test-model') => ({ defaults: { model } }) as any;

describe('warmModel', () => {
  it('warms a LOCAL model (calls complete)', async () => {
    let called = false;
    const r = makeRouter({ isLocal: true, onComplete: () => { called = true; } });
    const res = await warmModel(r, cfg());
    expect(res).toEqual({ warmed: true, reason: 'ok' });
    expect(called).toBe(true);
  });

  it('SKIPS a cloud model (never spends money)', async () => {
    let called = false;
    const r = makeRouter({ isLocal: false, onComplete: () => { called = true; } });
    const res = await warmModel(r, cfg());
    expect(res.warmed).toBe(false);
    expect(res.reason).toBe('cloud-skip');
    expect(called).toBe(false);
  });

  it('is silent when the model cannot be resolved', async () => {
    const r = makeRouter({ isLocal: true, resolves: false });
    const res = await warmModel(r, cfg());
    expect(res).toEqual({ warmed: false, reason: 'model-not-resolved' });
  });
});
