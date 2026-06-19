# Generative UI — Streaming Recipes

Concrete, copy-ready patterns for the `generative-ui-expert` skill. **Verify imports against the
project's installed `ai` version first** (`npm ls ai`) — this library moves fast and the surface below
targets AI SDK 5 (2026). Everything here assumes a Next.js App Router project with a server route that
can reach a model.

---

## 0. The contract: schemas + component registry come first

Define the schema and the type→component map BEFORE any streaming code. This is the whole safety model.

```ts
// lib/genui/schema.ts
import { z } from 'zod';

// Each renderable thing the model may emit gets a zod schema. The model fills these
// fields; it never decides layout. Keep numbers/enums tight so a drifting model can't
// smuggle garbage in.
export const chartSpec = z.object({
  kind: z.literal('chart'),
  title: z.string().max(80),
  series: z.array(z.object({ label: z.string(), value: z.number() })).max(60),
});

export const statCardSpec = z.object({
  kind: z.literal('statCard'),
  label: z.string().max(40),
  value: z.number(),
  deltaPct: z.number().optional(),
});

export const uiSpec = z.discriminatedUnion('kind', [chartSpec, statCardSpec]);
export type UiSpec = z.infer<typeof uiSpec>;
```

```tsx
// lib/genui/registry.tsx
import { LineChart, StatCard, FallbackCard } from '@/components/genui';
import type { UiSpec } from './schema';

// The ONE place that maps a validated spec to a real component. Unknown kind ⇒ fallback,
// never a throw. This is "The UI Hydrator".
export function renderSpec(spec: UiSpec) {
  switch (spec.kind) {
    case 'chart':    return <LineChart title={spec.title} series={spec.series} />;
    case 'statCard': return <StatCard label={spec.label} value={spec.value} deltaPct={spec.deltaPct} />;
    default:         return <FallbackCard raw={spec} />; // exhaustiveness + runtime safety
  }
}
```

---

## 1. Server: tools streamed via the UI message stream (AI SDK 5, preferred)

```ts
// app/api/chat/route.ts
import { streamText, tool, convertToModelMessages } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-5'),               // or your local provider adapter
    // T <= 0.1 for STRUCTURED output: pushes the softmax distribution toward
    // deterministic so the JSON/schema doesn't drift and break. Higher temp = broken specs.
    temperature: 0.1,
    messages: convertToModelMessages(messages),
    tools: {
      renderSalesChart: tool({
        description: 'Render a sales chart. Fill the data points; do not compute totals.',
        inputSchema: z.object({
          title: z.string(),
          series: z.array(z.object({ label: z.string(), value: z.number() })),
        }),
        // execute returns DATA the client maps to a component. Business logic (auth, DB,
        // real numbers) is fetched HERE, server-side — never trusted from the model.
        execute: async ({ title, series }) => ({ kind: 'chart', title, series }),
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
```

## 2. Client: useChat + typed tool-invocation parts, with per-state UI

```tsx
// app/chat.tsx
'use client';
import { useChat } from '@ai-sdk/react';
import { renderSpec } from '@/lib/genui/registry';
import { uiSpec } from '@/lib/genui/schema';

export default function Chat() {
  const { messages, sendMessage, status, error, reload } = useChat();

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          {m.parts.map((part, i) => {
            if (part.type === 'text') return <p key={i}>{part.text}</p>;

            // Tool parts carry the lifecycle state. Render a different UI per state:
            // skeleton while args stream, live as data arrives, final when done, error on fail.
            if (part.type === 'tool-renderSalesChart') {
              switch (part.state) {
                case 'input-streaming':
                case 'input-available':
                  return <ChartSkeleton key={i} />;          // fallback/loading UI
                case 'output-available': {
                  const parsed = uiSpec.safeParse(part.output); // validate at the boundary
                  return parsed.success
                    ? <div key={i}>{renderSpec(parsed.data)}</div>
                    : <FallbackCard key={i} raw={part.output} />; // Zod fail ⇒ decay to safe UI
                }
                case 'output-error':
                  return <ErrorCard key={i} message={part.errorText} />;
              }
            }
            return null;
          })}
        </div>
      ))}

      {error && <button onClick={() => reload()}>Reconnect</button>}
      <Composer disabled={status !== 'ready'} onSend={(t) => sendMessage({ text: t })} />
    </div>
  );
}
```

## 3. Single streamed object (one chart/form): useObject

```tsx
'use client';
import { experimental_useObject as useObject } from '@ai-sdk/react';
import { chartSpec } from '@/lib/genui/schema';
import { renderSpec } from '@/lib/genui/registry';

export function LiveChart() {
  const { object, submit, isLoading } = useObject({ api: '/api/chart', schema: chartSpec });
  // `object` is a DEEP-PARTIAL during streaming — render what's valid so far, assert nothing.
  return (
    <div>
      <button disabled={isLoading} onClick={() => submit('Q2 sales for Seven Gum')}>Generate</button>
      {object?.kind === 'chart' && object.series
        ? renderSpec({ kind: 'chart', title: object.title ?? '…', series: (object.series ?? []).filter(Boolean) as any })
        : <ChartSkeleton />}
    </div>
  );
}
```

## 4. streamUI (RSC) — only for RSC-only apps

`streamUI` from `ai/rsc` streams actual Server Components. Valid, but prefer the tool-parts pattern
above unless the project is committed to RSC streaming. If you use it, the same guardrails apply:
schema-validated tool inputs, a fallback for every branch, secrets server-side.

---

## Algorithm A — Partial JSON parsing (stack-based auto-heal)

A streamed JSON is invalid until the closing brace, so `JSON.parse` throws mid-stream. Track open
`{ [ "` on a stack and virtually close them to get a renderable object every frame.

> In practice, prefer the SDK's built-in partial parsing (`useObject`'s partial object, or AI SDK's
> `parsePartialJson`) — it's battle-tested. Hand-roll ONLY when you control the raw stream yourself.

```ts
// Minimal auto-healing parser for a raw token stream you own.
export function healPartialJson(buf: string): unknown | undefined {
  const stack: string[] = [];     // holds only '}' and ']' — string state is tracked separately
  let inStr = false, esc = false;
  for (const ch of buf) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;   // close string; nothing on the brace stack
      continue;
    }
    if (ch === '"') inStr = true;           // open string (do NOT push to the brace stack)
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let healed = buf;
  if (inStr) healed += '"';                 // close a dangling string
  for (let i = stack.length - 1; i >= 0; i--) healed += stack[i]; // close open containers, innermost first
  // strip a trailing comma/colon that would still be invalid: {"a":1,  -> {"a":1}
  healed = healed.replace(/[,:]\s*([}\]])/g, '$1').replace(/[,:]\s*$/, '');
  try { return JSON.parse(healed); } catch { return undefined; } // undefined ⇒ keep last good
}
```

---

## Algorithm B — Frame-budget token coalescing (rAF)

Cap render rate at the display refresh regardless of token rate `λ`. Buffer deltas; flush once per
animation frame. `Δt_frame` is 16.67 ms at 60 Hz, 8.33 ms at 120 Hz — `requestAnimationFrame` adapts
to the actual display automatically, so you don't hardcode it.

```ts
import { useRef, useState, useEffect, useCallback } from 'react';

export function useCoalescedState<T>(initial: T) {
  const [state, setState] = useState<T>(initial);
  const pending = useRef<T | null>(null);
  const raf = useRef<number | null>(null);

  const flush = useCallback(() => {
    raf.current = null;
    if (pending.current !== null) { setState(pending.current); pending.current = null; }
  }, []);

  const push = useCallback((next: T) => {
    pending.current = next;                       // coalesce: keep only the latest within the frame
    if (raf.current === null) raf.current = requestAnimationFrame(flush);
  }, [flush]);

  // cleanup: cancel a pending frame on unmount (memory-leak guard)
  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current); }, []);

  return [state, push] as const;
}
```

Stability: with rAF coalescing, render rate `R = min(λ, refreshRate)` — the main thread never renders
faster than the screen can show, so no flicker/jank no matter how fast the model streams.

---

## Algorithm C — Full-jitter reconnect backoff

```ts
// delay(n) = random(0, min(cap, base * 2^n))  — AWS full jitter, anti thundering-herd.
export function fullJitterDelay(attempt: number, base = 500, cap = 30_000): number {
  const expo = Math.min(cap, base * 2 ** attempt);
  return Math.random() * expo;
}

export async function withReconnect(
  open: (signal: AbortSignal) => Promise<void>,
  { maxAttempts = 6, signal }: { maxAttempts?: number; signal: AbortSignal },
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) return;
    try { await open(signal); return; }            // success ⇒ done
    catch (err) {
      if (signal.aborted || attempt === maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, fullJitterDelay(attempt)));
    }
  }
}
```

Stop after `maxAttempts` and show a manual reconnect button — never retry forever.

---

## Algorithm D — Recency-weighted sliding-window truncation

Bound the prompt: keep recent turns verbatim, compress the rest into one summary. Budget `B = 0.75·W`.

```ts
type Msg = { role: string; content: string; tokens: number; ts: number };

export function windowHistory(
  msgs: Msg[],
  contextWindow: number,
  opts: { summaryReservePct?: number; gamma?: number } = {},
): { kept: Msg[]; toSummarize: Msg[] } {
  const B = Math.floor(contextWindow * 0.75);
  const summaryReserve = Math.floor(B * (opts.summaryReservePct ?? 0.15));
  const verbatimBudget = B - summaryReserve;
  const gamma = opts.gamma ?? 0.9;                 // positional recency decay, 0<γ<1

  const kept: Msg[] = [];
  let used = 0;
  // newest → oldest; recency weight w_i = γ^(age) only matters when over budget (drop low-weight first)
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (used + msgs[i].tokens <= verbatimBudget) { kept.unshift(msgs[i]); used += msgs[i].tokens; }
    else break;
  }
  const toSummarize = msgs.slice(0, msgs.length - kept.length); // older tail ⇒ compress to 1 block
  void gamma; // weight is available if you need finer eviction than pure recency
  return { kept, toSummarize };
}
```

Feed `[summaryOf(toSummarize), ...kept]` to the model: bounded prompt, still remembers the thread.

---

## Guardrail checklist (paste into the PR description)

- [ ] Model fills props only — no totals/auth/DB logic trusted from the stream
- [ ] `temperature ≤ 0.1` for structured/tool output
- [ ] Every registry component has skeleton + empty + error states; unknown kind ⇒ fallback (no throw)
- [ ] zod-validate every tool input/output and streamed object at the server boundary
- [ ] Secrets + `execute` server-side only; client renders typed parts
- [ ] rAF coalescing on the render path (no `setState` per token)
- [ ] Full-jitter backoff + max attempts + manual reconnect (no infinite retry)
- [ ] Recency-windowed history before each model call
- [ ] `AbortController` on unmount; rAF cancelled; `EventSource`/stream torn down
