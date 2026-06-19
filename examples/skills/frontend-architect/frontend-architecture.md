# Frontend Architecture — reference

## Next.js App Router layout
```
app/
  layout.tsx          # root: <html>, fonts, providers (Server Component)
  page.tsx            # route (Server Component by default)
  loading.tsx         # Suspense fallback for the segment
  error.tsx           # error boundary ('use client')
  (group)/...         # route groups; nested layouts per section
  api/<route>/route.ts# route handlers (server)
components/
  server/             # non-interactive, render on the server
  client/             # 'use client' islands (state/effects/handlers)
lib/                  # data access, fetchers, server-only utils (import 'server-only')
styles/ tokens.ts     # design tokens (colors, type scale, spacing, motion)
```

## Server vs Client Component — decision table
| Needs… | Component type |
|--------|----------------|
| Data fetching, secrets, DB/ORM access | **Server** (default) |
| Heavy deps you don't want in the client bundle | **Server**, or client island `dynamic(ssr:false)` |
| `useState`/`useReducer`, event handlers | **Client** (`'use client'`) |
| `useEffect`, browser APIs, refs to DOM | **Client** |
| Context provider consumed by client subtree | **Client** (thin wrapper) |
Rule: push `'use client'` as far DOWN the tree as possible. A client parent makes its imported
children client too — keep interactive bits as small leaves.

## Data fetching
- Fetch in the component that renders the data. Parallel: `const [a,b] = await Promise.all([...])`.
- Stream slow parts behind `<Suspense fallback={…}>` so the shell paints immediately.
- Caching is explicit: `fetch(url, { next: { revalidate: N, tags: [...] } })`; revalidate on
  mutation with `revalidateTag`/`revalidatePath`. Don't rely on implicit defaults you didn't choose.
- No client waterfalls (component mounts → fetch → child mounts → fetch). Hoist to the server.

## GSAP cleanup pattern (React) — the leak-proof shape
```tsx
'use client';
import { useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';
gsap.registerPlugin(ScrollTrigger, useGSAP);

export function Hero() {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const tl = gsap.timeline();
    tl.from('.headline', { y: 40, opacity: 0, duration: 0.6 });   // transform+opacity only
    gsap.to('.panel', {
      yPercent: -20,
      scrollTrigger: { trigger: root.current, scrub: true, start: 'top bottom', end: 'bottom top' },
    });
  }, { scope: root }); // useGSAP reverts everything (tweens + ScrollTriggers) on unmount
  return <div ref={root}>…</div>;
}
```
Without `useGSAP`: do it in `useEffect` and return `() => ctx.revert()` from a `gsap.context(...)`.
Either way: animate transform/opacity, never layout; kill every ScrollTrigger on unmount.

## Three.js / r3f disposal + performance checklist
```tsx
'use client';
import dynamic from 'next/dynamic';
const Scene = dynamic(() => import('./Scene'), { ssr: false }); // keep WebGL out of SSR + first paint
```
- **Dispose** anything you create imperatively: `geometry.dispose()`, `material.dispose()`,
  `texture.dispose()`, `renderer.dispose()`. r3f auto-disposes objects it owns in the JSX tree;
  manual `new THREE.*` is your responsibility — do it in the effect cleanup.
- **Reuse** geometries/materials across meshes; don't allocate inside `useFrame`/the render loop.
- **InstancedMesh** for many similar objects (one draw call). Watch draw-call count and triangle
  budget; merge static geometry.
- `dpr={[1, 2]}` (cap pixel ratio); `frameloop="demand"` + `invalidate()` for static/idle scenes
  (don't burn the GPU rendering an unchanging frame 60×/s).
- Handle resize (update camera aspect + renderer size) and WebGL context loss.
- Lazy-load heavy GLTF/textures behind `<Suspense>`; compress (draco/ktx2); show a fallback.

## Core Web Vitals targets (measure, don't assume)
| Metric | Good | Main levers |
|--------|------|-------------|
| LCP | < 2.5s | server-render hero, prioritize hero image/font, avoid client waterfalls |
| INP | < 200ms | keep main thread free — split/defer heavy JS, avoid long tasks |
| CLS | < 0.1 | reserve dimensions for images/embeds/ads; no late layout shifts |
- Code-split per route; `dynamic()` heavy/3D/chart libs. Optimize images (`next/image`) and fonts
  (`next/font`, `display: swap`). Treat the client bundle as a budget you spend deliberately.
