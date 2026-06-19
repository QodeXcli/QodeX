/**
 * Stack-specialist expertise layer.
 *
 * The task-class addendum (task-addenda.ts) shapes *how* the agent works (debug vs
 * feature vs review). This layer is orthogonal: it injects deep, opinionated, CURRENT
 * domain knowledge for the specific TECHNOLOGY in play — Django, WordPress, Next.js,
 * React+Vite, three.js/R3F, Node. A turn can carry a task class AND one or two stack
 * profiles (e.g. "feature" + "nextjs").
 *
 * Why this disproportionately matters for a local-first agent: the primary model is a
 * quantized local model whose recall of framework-specific gotchas (RSC boundaries,
 * select_related, WP nonce/sanitization, R3F render-loop discipline) is weaker than a
 * frontier model's. Putting the expert checklist directly in front of it closes most of
 * that gap — the model doesn't have to remember the rule, it just has to follow it.
 *
 * Detection is split:
 *   - `detectStacksFromText`  — pure, from the user's words (what they're asking for).
 *   - `detectStacksFromProject` — pure, from already-gathered project signals (deps/files).
 * `detectProjectSignals` does the (tiny) I/O to gather those signals from disk.
 * Everything that builds the prompt string is pure and unit-tested.
 *
 * Cap: at most 2 profiles per turn (the most specific win) so the prompt doesn't bloat
 * and the cache prefix stays manageable.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

export type StackId = 'django' | 'wordpress' | 'nextjs' | 'react-vite' | 'threejs' | 'node';

// ── Expert profiles ─────────────────────────────────────────────────────────────
// Dense, actionable, current (2024–2025 idioms). Each is "how a senior in THIS stack
// actually builds it" — the non-obvious rules, the performance traps, the modern API.

const DJANGO = `# Django specialist
Production-grade Django + DRF. Hold yourself to a senior backend bar.

## ORM — performance is correctness here
- Kill N+1: \`select_related\` for FK/OneToOne (SQL JOIN), \`prefetch_related\` for M2M/reverse FK. Use \`Prefetch()\` to filter/order the prefetched set.
- Fetch only what you use: \`.only()\`/\`.defer()\`, \`.values()\`/\`.values_list()\` for read paths.
- Aggregate in the DB: \`annotate\`/\`aggregate\`/\`Subquery\`/\`OuterRef\`/conditional \`Case/When\`, not in Python loops.
- Bulk ops: \`bulk_create\`/\`bulk_update\`/\`in_bulk\`; \`update()\`/\`delete()\` on querysets to avoid loading rows.
- Wrap multi-write flows in \`transaction.atomic\`; use \`select_for_update\` for row locks. Add DB indexes (\`Meta.indexes\`, \`db_index\`) for filtered/ordered columns; constraints via \`Meta.constraints\` (UniqueConstraint/CheckConstraint).

## Architecture
- Fat models / service functions, thin views. Custom \`Manager\`/\`QuerySet\` methods for reusable query logic.
- Migrations: never edit an applied migration; keep them reversible; separate schema from data migrations; use \`RunPython\` with a reverse. Watch for migrations that lock big tables.

## DRF
- Validate at the serializer (\`validate_<field>\`/\`validate()\`); never trust client input. \`ModelSerializer\` + explicit \`fields\`. Use \`SerializerMethodField\` sparingly (N+1 risk).
- ViewSets + routers; \`get_queryset\`/\`get_serializer_class\` for variation. Always paginate lists. Set \`permission_classes\`/\`throttle_classes\` on sensitive endpoints. Return correct status codes.

## Security & async
- Settings: \`DEBUG=False\` in prod, \`ALLOWED_HOSTS\`, secrets from env (django-environ), CSRF + auth + object-level perms. ORM params only — no f-string SQL.
- Offload slow work to Celery (idempotent tasks, retries, no passing ORM objects — pass ids). Cache with the cache framework / Redis; invalidate deliberately.
- Tests: pytest-django, factory_boy, \`assertNumQueries\` to lock query counts.`;

const WORDPRESS = `# WordPress specialist
Modern WordPress (PHP) — plugin/theme dev that's secure, fast, and update-safe.

## The cardinal rules
- NEVER edit core or a third-party theme/plugin directly — it's wiped on update. Use a child theme, a custom plugin, hooks, or \`functions.php\`.
- Everything is hooks: \`add_action\`/\`add_filter\` with the right priority & arg count. Know the order (\`init\`, \`wp_enqueue_scripts\`, \`template_redirect\`, \`rest_api_init\`, \`save_post\`).

## Security — WP is a big attack surface
- Escape on OUTPUT: \`esc_html\`/\`esc_attr\`/\`esc_url\`/\`wp_kses_post\`. Sanitize on INPUT: \`sanitize_text_field\`/\`sanitize_email\`/\`absint\`.
- Nonces on every form/AJAX/action: \`wp_nonce_field\` + \`check_admin_referer\`/\`wp_verify_nonce\`. Capability checks: \`current_user_can\`.
- DB access through \`$wpdb->prepare()\` — always parameterized. Prefer the API (\`WP_Query\`, \`get_posts\`, meta/options API) over raw SQL.

## Performance
- Enqueue assets properly (\`wp_enqueue_script/style\` with deps + version), never hardcode \`<script>\`. Don't load on pages that don't need them.
- \`WP_Query\`: avoid \`posts_per_page => -1\`; set \`no_found_rows => true\` when you don't paginate; avoid uncached \`meta_query\`/\`tax_query\` on hot paths. Use the Transients API / object cache for expensive queries.
- Beware the \`save_post\`/\`init\` hooks running on every request — guard with autosave/revision/capability checks.

## Modern WP
- Blocks (Gutenberg) with \`@wordpress/scripts\` + \`block.json\`; \`register_block_type\`. Register REST routes via \`register_rest_route\` (with \`permission_callback\` — never \`__return_true\` for writes). Custom post types/taxonomies with proper labels & \`show_in_rest\` for the editor/REST. WP-CLI for automation. Follow WP coding standards (PHPCS + WPCS).`;

const NEXTJS = `# Next.js specialist (App Router)
Modern Next.js (13+/14/15, App Router + React Server Components). Get the server/client boundary right — it's where most bugs and perf wins live.

## Server vs Client
- Components are Server Components by default: they can be async, fetch directly, and never ship to the client. Add \`'use client'\` ONLY at the leaf that needs interactivity/hooks/browser APIs — push it as far down the tree as possible.
- Never import server-only code (DB clients, secrets, \`fs\`) into a client component. Pass data down as props; pass server work down as Server Actions.
- Don't \`useEffect\`+fetch for initial data — fetch in a Server Component. Use \`useEffect\` only for genuine client effects.

## Data & caching (know the model)
- \`fetch\` is cached/deduped by default; control with \`{ next: { revalidate } }\` or \`cache: 'no-store'\`. Use \`revalidatePath\`/\`revalidateTag\` after mutations. Mutations = Server Actions (\`'use server'\`) or route handlers, then revalidate.
- Streaming: \`loading.tsx\` + \`<Suspense>\` for progressive render; \`error.tsx\` for boundaries; \`not-found.tsx\`. \`generateStaticParams\` for SSG, \`generateMetadata\` for per-route SEO.

## Performance & SEO
- \`next/image\` (sizes/priority for LCP), \`next/font\` (no layout shift), \`next/link\` for prefetch. Watch bundle size — keep heavy/interactive libs in client leaves, lazy-load with \`next/dynamic\` (\`ssr:false\` for browser-only like three.js).
- Metadata API + JSON-LD for rich results; sitemap/robots via the file conventions. Mind the Core Web Vitals (LCP/CLS/INP).
- Route handlers under \`app/api/*/route.ts\`; validate input (zod); set proper caching headers.`;

const REACT_VITE = `# React + Vite specialist
Fast React SPA on Vite. Modern hooks-first React, lean and correct.

## React discipline
- Correct \`useEffect\`: complete dependency arrays, cleanup functions, no effects for derived state (compute during render or \`useMemo\`). Don't fetch in effects when a data lib fits.
- Keys must be stable & unique (never array index for dynamic lists). Lift state only as far as needed; colocate otherwise. \`useMemo\`/\`useCallback\` only at proven hot spots — measure, don't sprinkle.
- Data fetching: TanStack Query (caching, dedupe, retries, mutations + invalidation) over hand-rolled effects. Forms: react-hook-form + zod resolver.

## Vite
- Env vars must be \`VITE_\`-prefixed to reach the client (\`import.meta.env\`). Lazy-load routes/heavy components with \`React.lazy\` + \`<Suspense>\`; let Vite code-split. Use the \`@/\` path alias (configure in vite.config + tsconfig).
- Keep the dependency pre-bundle happy; avoid importing huge libs eagerly. Use \`vite-plugin-*\` ecosystem; \`build.rollupOptions\` for manual chunks when a vendor bundle gets big.

## Quality
- TypeScript strict; type props and API payloads. Accessibility: semantic elements, labels, focus management, keyboard nav. Test with Vitest + Testing Library (behavior, not implementation). Error boundaries around lazy/async regions.`;

const THREEJS = `# three.js / R3F motion specialist
High-end 3D & full-motion on the web. The goal is cinematic AND 60fps — discipline in the render loop is everything.

## React Three Fiber (preferred in React)
- Build the scene declaratively with R3F; reach for @react-three/drei helpers (OrbitControls, Environment, useGLTF, Html, Instances, shaderMaterial). Animate in \`useFrame\` — NEVER setState per frame (it re-renders React); mutate refs (\`mesh.current.rotation.y += delta\`) instead. Scale motion by \`delta\` so it's frame-rate independent.
- \`useGLTF\`/\`useTexture\` with Suspense; \`useGLTF.preload\`. Reuse geometries/materials; use \`<Instances>\`/InstancedMesh for many repeated objects. Dispose on unmount (drei/R3F mostly handle it — don't leak in manual three).

## Performance (the part beginners miss)
- Draw calls are the budget: merge geometry, instance, share materials, atlas textures. Compressed textures (KTX2/basis) + Draco/meshopt for glTF. Keep poly counts sane; LOD for distant objects. Cap pixel ratio: \`gl.setPixelRatio(Math.min(devicePixelRatio, 2))\`.
- Lighting/shadows are expensive: bake where possible, limit shadow-casting lights, tune shadow map size. Use \`frustumCulled\`, \`renderOrder\`, and on-demand rendering (\`frameloop="demand"\` + \`invalidate()\`) for static scenes.
- Post-processing via @react-three/postprocessing (selective bloom, DOF) — measure cost. Profile with stats / Spector.js.

## Motion & polish
- Tween with GSAP or react-spring; scroll-driven scenes with @react-three/drei \`ScrollControls\` or Lenis + GSAP ScrollTrigger. Custom GLSL via shaderMaterial for unique looks. Respect \`prefers-reduced-motion\`. Lazy-load the whole canvas (\`next/dynamic ssr:false\`) so 3D never blocks first paint; always dispose the renderer on teardown to avoid WebGL context leaks.`;

const NODE = `# Node.js specialist
Server-side JS/TS — APIs, services, tooling. Correct async, resilient I/O.

## Async correctness
- Always await / return promises (no floating promises — they swallow errors). \`Promise.all\` for independent work, \`Promise.allSettled\` when partial failure is OK; bound concurrency for large fan-out (don't fire 10k requests at once). Never block the event loop — offload CPU-bound work to worker_threads.
- Errors: try/catch around awaits, an error-handling middleware (Express) or the framework's error hook (Fastify/Nest), and a \`process.on('unhandledRejection')\` safety net. Don't swallow errors silently.

## API & data
- Validate every input at the boundary (zod/valibot). Parameterized queries / an ORM (Prisma/Drizzle) — never string-concatenate SQL. Stream large payloads instead of buffering. Set timeouts on outbound calls; add retries with backoff for idempotent ops.
- Config & secrets from env (never commit). Structured logging (pino). Graceful shutdown (drain server, close DB) on SIGTERM.

## Modern Node & quality
- ESM, top-level await, \`node:\` import prefixes, native \`fetch\`/\`AbortController\`. Prefer built-ins before adding deps; audit what you add. TypeScript strict. Test with Vitest/node:test; integration-test the real I/O paths.`;

export const STACK_PROFILES: Record<StackId, string> = {
  django: DJANGO,
  wordpress: WORDPRESS,
  nextjs: NEXTJS,
  'react-vite': REACT_VITE,
  threejs: THREEJS,
  node: NODE,
};

// ── Detection signals ───────────────────────────────────────────────────────────
// Persian terms are matched WITHOUT \b (JS word boundaries don't fire around non-ASCII
// letters — same gotcha as the task classifier).

interface StackSignal {
  /** ASCII keyword regex (word-boundaried). */
  text: RegExp;
  /** Persian / non-ASCII keyword regex (no \b). */
  textFa?: RegExp;
  /** package.json dependency names that imply this stack. */
  deps?: string[];
  /** Marker files (relative) whose presence implies this stack. */
  files?: string[];
}

const SIGNALS: Record<StackId, StackSignal> = {
  django: {
    text: /\b(django|drf|django ?rest|serializer|viewset|queryset|orm|migration|makemigrations|models?\.py|celery|wsgi|asgi|manage\.py|select_related|prefetch_related)\b/i,
    textFa: /(جنگو|جنگوو|دی ?آر ?اف)/,
    files: ['manage.py', 'requirements.txt', 'pyproject.toml'],
  },
  wordpress: {
    text: /\b(wordpress|wp|woocommerce|gutenberg|wp-content|wp_query|wpdb|elementor|wp-cli|shortcode|enqueue_script|register_block_type|the_loop|custom post type|cpt)\b/i,
    textFa: /(وردپرس|وردپرسی|ووکامرس|قالب ?وردپرس|افزونه)/,
    files: ['wp-config.php', 'wp-content', 'style.css'],
  },
  nextjs: {
    text: /\b(next\.?js|app router|server component|rsc|server action|use server|generatemetadata|generatestaticparams|revalidatepath|revalidatetag|next\/image|next\/font|getserversideprops|getstaticprops)\b/i,
    textFa: /(نکست ?جی ?اس|نکست|نکست‌جی‌اس)/,
    deps: ['next'],
    files: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
  },
  'react-vite': {
    text: /\b(vite|react ?spa|tanstack|react-query|react ?router|vite\.config)\b/i,
    textFa: /(ویت|ری‌اکت ?ویت)/,
    deps: ['vite', '@vitejs/plugin-react'],
    files: ['vite.config.js', 'vite.config.ts'],
  },
  threejs: {
    text: /\b(three\.?js|react ?three|r3f|react-three-fiber|@react-three|webgl|webgpu|shader|glsl|gltf|glb|drei|instancedmesh|useframe|orbitcontrols|3d ?scene|particles?)\b/i,
    textFa: /(تری ?جی ?اس|سه ?بعدی|اسکنه|شیدر|انیمیشن ?سه ?بعدی|موشن)/,
    deps: ['three', '@react-three/fiber', '@react-three/drei'],
  },
  node: {
    text: /\b(node\.?js|express|fastify|nest\.?js|nestjs|prisma|drizzle|worker_threads|backend ?api|rest ?api|graphql ?server)\b/i,
    textFa: /(نود ?جی ?اس|نود|اکسپرس|بک‌?اند ?نود)/,
    deps: ['express', 'fastify', '@nestjs/core', 'prisma', 'drizzle-orm'],
    files: ['server.js', 'server.ts'],
  },
};

/** Detect stacks the user's words point at. Pure. */
export function detectStacksFromText(text: string): StackId[] {
  const lower = text.toLowerCase();
  const out: StackId[] = [];
  for (const id of Object.keys(SIGNALS) as StackId[]) {
    const sig = SIGNALS[id];
    if (sig.text.test(lower) || (sig.textFa && sig.textFa.test(text))) out.push(id);
  }
  return out;
}

export interface ProjectSignals {
  /** Lower-cased dependency names from package.json (deps + devDeps). */
  deps?: string[];
  /** Marker file/dir basenames present at the project root. */
  files?: string[];
}

/** Detect stacks implied by what's installed / present on disk. Pure. */
export function detectStacksFromProject(signals: ProjectSignals): StackId[] {
  const deps = new Set((signals.deps ?? []).map(d => d.toLowerCase()));
  const files = new Set((signals.files ?? []).map(f => f.toLowerCase()));
  const out: StackId[] = [];
  for (const id of Object.keys(SIGNALS) as StackId[]) {
    const sig = SIGNALS[id];
    const depHit = sig.deps?.some(d => deps.has(d.toLowerCase()));
    const fileHit = sig.files?.some(f => files.has(f.toLowerCase()));
    if (depHit || fileHit) out.push(id);
  }
  return out;
}

/**
 * Combine text + project detection into the final ordered, capped list. Text signals
 * (what the user is asking for THIS turn) outrank ambient project signals; we keep at
 * most `max` profiles so the prompt stays tight.
 */
export function detectStacks(text: string, project: ProjectSignals = {}, max = 2): StackId[] {
  const fromText = detectStacksFromText(text);
  const fromProject = detectStacksFromProject(project);
  const ordered: StackId[] = [];
  for (const id of [...fromText, ...fromProject]) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered.slice(0, max);
}

/** Build the combined stack-expertise addendum (empty string when no stack detected). */
export function buildStackAddendum(stacks: StackId[]): string {
  if (stacks.length === 0) return '';
  return stacks.map(id => STACK_PROFILES[id]).join('\n\n');
}

const PKG_MARKERS = [
  'manage.py', 'requirements.txt', 'pyproject.toml',
  'wp-config.php', 'wp-content', 'style.css',
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'vite.config.js', 'vite.config.ts',
  'server.js', 'server.ts',
];

/**
 * Gather project signals from disk (best-effort, tiny I/O): package.json deps + a quick
 * scan for marker files at the project root. Never throws — returns empty signals on any
 * failure so the caller can always proceed.
 */
export async function detectProjectSignals(cwd: string): Promise<ProjectSignals> {
  const signals: ProjectSignals = { deps: [], files: [] };
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    signals.deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
  } catch { /* no package.json — fine */ }

  try {
    const entries = await fs.readdir(cwd);
    const present = new Set(entries);
    signals.files = PKG_MARKERS.filter(m => present.has(m));
  } catch { /* unreadable cwd — fine */ }

  return signals;
}
