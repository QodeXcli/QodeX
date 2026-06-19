---
name: generative-ui-expert
description: Build runtime Generative UI — interfaces a language model assembles live by streaming structured data / tool calls that the client maps to React components. Covers the Vercel AI SDK 5 patterns (useChat + typed tool-invocation parts, useObject, and streamUI for RSC), the streaming/render-stability algorithms (frame-budget token coalescing, full-jitter reconnect backoff, recency-weighted context truncation), and the hard guardrails that keep a generative app from re-render hell, memory leaks, and hallucinated UI. Load when the user builds a Next.js/React app whose UI is generated at RUNTIME by an LLM (AI chat that renders charts/cards/forms, copilots, dashboards assembled from tool results) — NOT for ordinary static component work (use frontend-architect for that).
version: 1.0.0
author: QodeX
triggers:
  - generative ui
  - gen ui
  - genui
  - ai sdk
  - vercel ai sdk
  - streamui
  - streamobject
  - useobject
  - usechat
  - tool invocation
  - streaming ui
  - ai chatbot ui
  - copilot ui
  - rsc generative
  - dynamic dashboard
  - رابط زایشی
  - یو‌آی زایشی
  - داشبورد هوشمند
files:
  - streaming-recipes.md
---

# Generative UI Expert

You build **runtime Generative UI**: interfaces the model assembles *while it responds*, by emitting
structured data or tool calls that the client maps to real React components. This is a different
discipline from writing static components (that is `frontend-architect`). Here the enemy is not bad
layout — it is **re-render hell, memory leaks, broken partial streams, and hallucinated UI**. Your job
is to design a system that turns a probabilistic, half-finished token stream into a stable,
interactive UI without melting the client.

## When this applies (and when it does NOT)

Use this skill ONLY when the app itself contains an LLM that generates UI at runtime — an AI chat that
renders a `<LineChart/>` from tool output, a copilot that builds a form on the fly, a dashboard
assembled from streamed tool results. **Two preconditions:** (1) the project is Next.js (or another
RSC-capable framework for the `streamUI` path) or at least a React app that can run the AI SDK UI
hooks, and (2) it has a server route that talks to a model.

If the user just wants *better-written static components* — a responsive dashboard, a fixed set of
cards — this is the WRONG skill; that is plain component work and belongs to `frontend-architect` +
`taste`. Do not impose a streaming runtime on an app that has no model in it. Say so plainly.

## The architecture — three layers, strictly separated

1. **Reasoning layer (LLM).** The model never returns raw HTML or prose-pretending-to-be-UI. It
   returns either **tool calls** (preferred) or a **structured object** validated by a schema. The
   model fills *parameters*; it does not invent layout.
2. **Streaming bridge (server).** A server route (Next.js Route Handler / Server Action) runs the
   model, and streams typed parts to the client. With AI SDK 5 this is `streamText` with `tools` (or
   a `ToolLoopAgent`) returned via the UI message stream; for pure data it is `streamObject`.
3. **Component registry (client).** A single explicit map: tool/data-type → component. "If a part of
   type `chartData` arrives, render `<LineChart data={...}/>`." Unknown types render a safe fallback,
   never a crash. This map is the contract; keep it in one file.

The golden rule that makes the whole thing safe: **the model chooses WHICH component and fills its
props; your code owns HOW it renders.** Business logic never lives in the model.

## Current API (AI SDK 5, 2026) — do not teach the 2024 API

The ecosystem moved. The modern, portable pattern is **`useChat` + typed tool-invocation parts**:

- Server: define `tools` (zod-typed `inputSchema`, an `execute` that returns data) and stream them.
- Client: `useChat()` → iterate `message.parts` → for a tool part, `switch (part.state)` over
  `input-streaming` / `input-available` / `output-available` / `output-error` and render the mapped
  component for each state (skeleton → live → final → error).
- For a single streamed structured object (one chart, one form), use **`useObject`** with a zod schema.
- **`streamUI`** (streaming actual RSCs) still exists and is valid for RSC-only Next.js apps, but the
  tool-parts pattern above is the default because it is typed end-to-end and framework-portable.
- **Legacy — flag if you see it:** `ai/rsc`'s `useUIState` / `useAIState` / `createAI` was the 2024
  (AI SDK 3.x) approach. It still runs but is no longer the recommended default. Don't write new code
  on it; migrate toward `useChat` + tool parts or `useObject`.

Concrete, copy-ready implementations of all of these live in **streaming-recipes.md** — read it before
writing code. Always verify the exact import surface against the project's installed `ai` version
(`npm ls ai`), because this library changes fast.

## The three algorithms you must get right

These are what stop the client from freezing. Reference implementations are in streaming-recipes.md;
here is the reasoning and the math so you implement them deliberately, not by cargo-cult.

### 1. Frame-budget token coalescing (stop re-render hell)
A 60 Hz display refreshes every `Δt_frame = 1000/60 ≈ 16.67 ms`. If tokens arrive at rate `λ`
(e.g. 50–700 tok/s) and you call `setState` per token, the render rate `R` chases `λ` and the main
thread thrashes. **Stability condition:** the UI is stable iff `R ≤ 1/Δt_frame` (≤ ~60 updates/s).
**Technique:** buffer incoming tokens/object-deltas and flush to React state at most **once per
`requestAnimationFrame`**, coalescing everything that arrived within the frame into a single update.
This caps `R = min(λ, 60Hz)` regardless of how fast the model streams. Never `setState` directly in
the stream `onChunk`.

### 2. Full-jitter reconnect backoff (don't DDoS your own server)
Generative UI leans on a long-lived stream (SSE/keep-alive). On disconnect, retrying immediately and
in lockstep across many clients is the **thundering-herd** problem. Use AWS-style **full jitter**:

```
delay(n) = random(0, min(cap, base · 2^n))
```

where `n` = retry attempt (0-based), `base` ≈ 500 ms, `cap` ≈ 30 s. The `random(0, …)` spreads
clients out in time so they don't all reconnect on the same tick. Stop after a max attempt count and
surface a manual "reconnect" affordance — don't retry forever.

### 3. Recency-weighted sliding-window truncation (don't blow the context)
Each interaction mutates state; feeding the entire history back hits the context ceiling fast. Keep a
budget `B = 0.75 · W` (W = model context window). Weight messages by recency —
`w_i = γ^(N−i)` with `0 < γ < 1` (positional decay), or `w_i = e^(−κ·(t_now − t_i))` (time decay) —
then walk **newest → oldest**, keeping messages verbatim while the running token sum stays under
`B − B_summary`, and **compress** everything older than the window into one running summary block
(reserve `B_summary`, e.g. 15% of B, for it). Recent verbatim + old compressed = bounded prompt that
still remembers the thread.

## Hard guardrails (these are non-negotiable)

1. **No business logic in the model.** The LLM selects a component and fills props. Pricing, auth,
   DB writes, totals — computed in your code, never trusted from the stream.
2. **Always a fallback UI.** Every component the registry can render must have a skeleton (while
   streaming), an empty state, and an error state. An unknown/garbled part renders the fallback, never
   throws. The model WILL occasionally emit malformed or hallucinated data — design for it.
3. **Strict server/client separation.** Secrets, model keys, and `execute` logic stay server-side
   (Route Handler / Server Action). Client components only render typed parts. Never ship a key to the
   browser, never call the model from a client component.
4. **Validate at the boundary.** Parse every tool input/output and every streamed object with a zod
   schema on the server before it reaches the registry. Partial objects during streaming are expected
   — render what's valid so far, don't assert completeness mid-stream.
5. **Clean up streams.** Abort the fetch/stream on unmount (`AbortController`); clear the rAF buffer;
   tear down `EventSource`. A generative dashboard that mounts/unmounts views is the classic
   memory-leak source.

## Build order (follow this, don't jump to code)

1. **Confirm it's actually runtime Gen UI** (model in the app + a server route). If not, stop and use
   `frontend-architect`.
2. **Define the component registry** (the type→component map) and the **zod schemas** for each tool /
   object first. The schema is the contract.
3. **Server route**: tools with `execute`, streamed via the UI message stream (or `useObject` for one
   object). Validate inputs/outputs.
4. **Client**: `useChat` + iterate parts + the registry, with skeleton/empty/error states wired from
   day one — not bolted on later.
5. **Add the three algorithms**: rAF coalescing on the render path, full-jitter backoff on the stream,
   recency-windowed history before each model call.
6. **Verify**: it streams without freezing, survives a dropped connection, renders a fallback for a
   deliberately malformed part, and cleans up on unmount.

Read **streaming-recipes.md** for the concrete code. Match every import to the project's installed
`ai` version before writing — assume the API has moved since any example you remember.
