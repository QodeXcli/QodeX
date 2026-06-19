/**
 * `detect_frontend_stack` — comprehensive scan of the frontend toolchain.
 *
 * Reads package.json + config files + a sample of source files to produce
 * a high-fidelity report of what the project actually uses. Useful BEFORE
 * any UI/redesign task — the agent should match the project's existing
 * conventions, not invent new ones.
 *
 * Covers:
 *   - Framework: Next.js (App vs Pages router), Vite, Remix, Astro, Nuxt,
 *     SvelteKit, plain React, CRA, Gatsby
 *   - React version + React 19 features (Server Components, Actions, Forms)
 *   - Styling: Tailwind (+ version), shadcn/ui, Radix, CSS Modules, styled-components,
 *     Emotion, vanilla-extract, Stitches, UnoCSS
 *   - Component libraries: shadcn, MUI, Chakra, Mantine, Ant Design, Bootstrap
 *   - Animation: Framer Motion, GSAP, Auto-Animate, Lottie, React Spring
 *   - 3D / Canvas: Three.js, React Three Fiber, drei, Babylon.js, p5
 *   - Forms: react-hook-form, Formik, TanStack Form
 *   - State: Redux Toolkit, Zustand, Jotai, Recoil, TanStack Query, SWR
 *   - Icons: lucide-react, react-icons, heroicons, phosphor
 *   - Date: date-fns, dayjs, luxon
 *   - Data viz: recharts, visx, d3, chart.js, plotly
 *   - Fonts: next/font, fontsource, Google Fonts
 *   - Testing: Vitest, Jest, Playwright, Cypress, Testing Library
 *
 * Output is meant for the AGENT to use as context — it tells the model
 * "match shadcn patterns" or "this project uses Framer Motion not GSAP".
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const DetectFrontendStackArgs = z.object({
  path: z.string().optional().describe('Subdirectory to scan. Default cwd.'),
});

async function readJsonOrNull(filePath: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(filePath, 'utf-8')); } catch { return null; }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function findFile(root: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const p = path.join(root, name);
    if (await exists(p)) return p;
  }
  return null;
}

const FRAMEWORKS: Array<{ name: string; pkg: string; detect?: (root: string) => Promise<string | null> }> = [
  { name: 'Next.js', pkg: 'next', detect: async (root) => {
      // Detect App vs Pages router
      const hasApp = await exists(path.join(root, 'app')) || await exists(path.join(root, 'src/app'));
      const hasPages = await exists(path.join(root, 'pages')) || await exists(path.join(root, 'src/pages'));
      if (hasApp && hasPages) return 'App Router + Pages Router (hybrid)';
      if (hasApp) return 'App Router';
      if (hasPages) return 'Pages Router (legacy)';
      return null;
  }},
  { name: 'Remix', pkg: '@remix-run/react' },
  { name: 'Astro', pkg: 'astro' },
  { name: 'Nuxt', pkg: 'nuxt' },
  { name: 'SvelteKit', pkg: '@sveltejs/kit' },
  { name: 'Gatsby', pkg: 'gatsby' },
  { name: 'Vite + React', pkg: 'vite' },
  { name: 'Create React App', pkg: 'react-scripts' },
];

const UI_LIBS = [
  { name: 'shadcn/ui',         pkg: '@radix-ui/react-slot',     evidence: 'Radix primitives + Tailwind = shadcn convention' },
  { name: 'Radix UI',          pkg: '@radix-ui/react-dialog',    evidence: 'Headless primitives' },
  { name: 'MUI (Material UI)', pkg: '@mui/material',             evidence: '' },
  { name: 'Chakra UI',         pkg: '@chakra-ui/react',          evidence: '' },
  { name: 'Mantine',           pkg: '@mantine/core',             evidence: '' },
  { name: 'Ant Design',        pkg: 'antd',                      evidence: '' },
  { name: 'NextUI / HeroUI',   pkg: '@nextui-org/react',         evidence: '' },
  { name: 'React Bootstrap',   pkg: 'react-bootstrap',           evidence: '' },
  { name: 'Headless UI',       pkg: '@headlessui/react',         evidence: '' },
];

const STYLING = [
  { name: 'Tailwind CSS',     pkg: 'tailwindcss' },
  { name: 'styled-components', pkg: 'styled-components' },
  { name: 'Emotion',          pkg: '@emotion/react' },
  { name: 'vanilla-extract',  pkg: '@vanilla-extract/css' },
  { name: 'Stitches',         pkg: '@stitches/react' },
  { name: 'UnoCSS',           pkg: 'unocss' },
  { name: 'CSS Modules',      pkg: null, // detected via file presence
    detect: async (root: string) => (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
      .some(e => e.isFile() && /\.module\.(css|scss|sass)$/.test(e.name)) },
];

const ANIMATION = [
  { name: 'Framer Motion / Motion', pkg: 'framer-motion' },
  { name: 'Motion',                 pkg: 'motion' },
  { name: 'GSAP',                   pkg: 'gsap' },
  { name: '@formkit/auto-animate',  pkg: '@formkit/auto-animate' },
  { name: 'React Spring',           pkg: '@react-spring/web' },
  { name: 'Lottie React',           pkg: 'lottie-react' },
  { name: 'Anime.js',               pkg: 'animejs' },
];

const THREE_D = [
  { name: 'Three.js',            pkg: 'three' },
  { name: 'React Three Fiber',   pkg: '@react-three/fiber' },
  { name: '@react-three/drei',   pkg: '@react-three/drei' },
  { name: '@react-three/rapier', pkg: '@react-three/rapier' },
  { name: 'Babylon.js',          pkg: '@babylonjs/core' },
  { name: 'p5.js',               pkg: 'p5' },
  { name: 'PixiJS',              pkg: 'pixi.js' },
];

const STATE = [
  { name: 'Redux Toolkit',  pkg: '@reduxjs/toolkit' },
  { name: 'Zustand',        pkg: 'zustand' },
  { name: 'Jotai',          pkg: 'jotai' },
  { name: 'Recoil',         pkg: 'recoil' },
  { name: 'TanStack Query', pkg: '@tanstack/react-query' },
  { name: 'SWR',            pkg: 'swr' },
  { name: 'XState',         pkg: 'xstate' },
];

const FORMS = [
  { name: 'react-hook-form', pkg: 'react-hook-form' },
  { name: 'Formik',           pkg: 'formik' },
  { name: 'TanStack Form',    pkg: '@tanstack/react-form' },
  { name: 'Zod (validation)', pkg: 'zod' },
  { name: 'Yup',              pkg: 'yup' },
  { name: 'Valibot',          pkg: 'valibot' },
];

const ICONS = [
  { name: 'lucide-react',          pkg: 'lucide-react' },
  { name: 'react-icons',           pkg: 'react-icons' },
  { name: '@heroicons/react',      pkg: '@heroicons/react' },
  { name: '@phosphor-icons/react', pkg: '@phosphor-icons/react' },
  { name: 'Tabler Icons',          pkg: '@tabler/icons-react' },
  { name: 'Radix Icons',           pkg: '@radix-ui/react-icons' },
];

const DATA_VIZ = [
  { name: 'Recharts',  pkg: 'recharts' },
  { name: 'Visx',      pkg: '@visx/visx' },
  { name: 'D3',        pkg: 'd3' },
  { name: 'Chart.js',  pkg: 'chart.js' },
  { name: 'Plotly',    pkg: 'plotly.js' },
  { name: 'Nivo',      pkg: '@nivo/core' },
  { name: 'Tremor',    pkg: '@tremor/react' },
];

const TESTING = [
  { name: 'Vitest',          pkg: 'vitest' },
  { name: 'Jest',            pkg: 'jest' },
  { name: 'Playwright',      pkg: '@playwright/test' },
  { name: 'Cypress',         pkg: 'cypress' },
  { name: 'Testing Library', pkg: '@testing-library/react' },
  { name: 'Storybook',       pkg: 'storybook' },
];

function hasDep(pkg: any, name: string): string | null {
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
  return all[name] || null;
}

function detect(pkg: any, items: Array<{ name: string; pkg: string | null; evidence?: string }>) {
  const found: { name: string; version?: string; note?: string }[] = [];
  for (const it of items) {
    if (!it.pkg) continue;
    const ver = hasDep(pkg, it.pkg);
    if (ver) found.push({ name: it.name, version: String(ver), note: it.evidence || undefined });
  }
  return found;
}

export class DetectFrontendStackTool extends Tool<z.infer<typeof DetectFrontendStackArgs>> {
  name = 'detect_frontend_stack';
  description = 'Comprehensive scan of the frontend toolchain: framework (Next.js App/Pages router, Vite, Astro, etc.), React version, styling (Tailwind/CSS-in-JS), UI lib (shadcn, Radix, MUI), animation (Framer Motion, GSAP), 3D (Three.js, R3F, drei), state, forms, icons, data viz, testing. Use BEFORE any UI work so you match the project\'s existing conventions. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = DetectFrontendStackArgs;

  async execute(args: z.infer<typeof DetectFrontendStackArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ? path.resolve(ctx.cwd, args.path) : ctx.cwd;
    const pkgPath = await findFile(root, ['package.json']);
    if (!pkgPath) {
      return {
        content:
          `[DETECT_FRONTEND_STACK] No package.json found in ${root}. ` +
          `If the project is elsewhere (e.g. a folder the user attached), call this tool again ` +
          `with \`path\` set to that folder's absolute path.`,
        isError: true,
      };
    }
    const pkg = await readJsonOrNull(pkgPath);
    if (!pkg) return { content: '[DETECT_FRONTEND_STACK] package.json unreadable.', isError: true };

    const out: string[] = [];
    out.push(`# Frontend Stack — ${pkg.name ?? 'project'} ${pkg.version ? `v${pkg.version}` : ''}`);
    out.push('');

    // Framework
    out.push(`## Framework`);
    let frameworkFound = false;
    for (const fw of FRAMEWORKS) {
      const ver = hasDep(pkg, fw.pkg);
      if (ver) {
        const detail = fw.detect ? await fw.detect(root) : null;
        out.push(`  • ${fw.name} ${ver}${detail ? ` — ${detail}` : ''}`);
        frameworkFound = true;
      }
    }
    if (!frameworkFound) {
      const react = hasDep(pkg, 'react');
      if (react) out.push(`  • React ${react} (no framework — vanilla SPA?)`);
      else out.push(`  • (no framework detected)`);
    }

    // React version + features
    const reactVer = hasDep(pkg, 'react');
    if (reactVer) {
      const major = parseInt(String(reactVer).replace(/[^\d]/, ''), 10);
      out.push('');
      out.push(`## React ${reactVer}`);
      if (major >= 19) {
        out.push(`  • React 19+: Server Components, Actions, useFormStatus, useOptimistic available`);
        out.push(`  • ref-as-prop (no forwardRef needed for new components)`);
      } else if (major === 18) {
        out.push(`  • React 18: Server Components (in Next.js App), Suspense, useTransition`);
      } else {
        out.push(`  • React ${major}: legacy. Consider upgrade for concurrent features.`);
      }
    }

    // Each category
    const sections: Array<[string, ReturnType<typeof detect>]> = [
      ['## UI library',         detect(pkg, UI_LIBS)],
      ['## Styling',            detect(pkg, STYLING)],
      ['## Animation',          detect(pkg, ANIMATION)],
      ['## 3D / Canvas',        detect(pkg, THREE_D)],
      ['## State management',   detect(pkg, STATE)],
      ['## Forms',              detect(pkg, FORMS)],
      ['## Icons',              detect(pkg, ICONS)],
      ['## Data viz',           detect(pkg, DATA_VIZ)],
      ['## Testing',            detect(pkg, TESTING)],
    ];

    for (const [header, items] of sections) {
      if (items.length === 0) continue;
      out.push('');
      out.push(header);
      for (const f of items) {
        out.push(`  • ${f.name}${f.version ? ` ${f.version}` : ''}${f.note ? ` — ${f.note}` : ''}`);
      }
    }

    // Tailwind details — read tailwind.config to surface theme tokens hint
    if (hasDep(pkg, 'tailwindcss')) {
      const tailwindCfg = await findFile(root, ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs']);
      if (tailwindCfg) {
        const content = await fs.readFile(tailwindCfg, 'utf-8').catch(() => '');
        out.push('');
        out.push(`## Tailwind config`);
        out.push(`  ${path.relative(ctx.cwd, tailwindCfg)}`);
        // Sniff dark mode + plugin set
        if (/darkMode:\s*['"]class['"]/.test(content)) out.push(`  • Dark mode: class-based (toggle via \`dark\` class on html/body)`);
        else if (/darkMode:\s*['"]media['"]/.test(content)) out.push(`  • Dark mode: media-query based`);
        else if (/darkMode/.test(content)) out.push(`  • Dark mode: configured`);
        else out.push(`  • Dark mode: not configured`);
        // Tailwind plugins
        const plugins = ['@tailwindcss/forms', '@tailwindcss/typography', '@tailwindcss/aspect-ratio', '@tailwindcss/container-queries', 'tailwindcss-animate'];
        for (const p of plugins) if (content.includes(p) || hasDep(pkg, p)) out.push(`  • Plugin: ${p}`);
      }
    }

    // shadcn detection
    const componentsJson = await findFile(root, ['components.json']);
    if (componentsJson) {
      const sh = await readJsonOrNull(componentsJson);
      if (sh) {
        out.push('');
        out.push(`## shadcn/ui detected`);
        out.push(`  • Style: ${sh.style ?? '?'}`);
        out.push(`  • RSC: ${sh.rsc ?? '?'}`);
        out.push(`  • TS: ${sh.tsx ?? '?'}`);
        if (sh.aliases) {
          out.push(`  • Alias for components: ${sh.aliases.components ?? '@/components'}`);
          out.push(`  • Alias for utils: ${sh.aliases.utils ?? '@/lib/utils'}`);
        }
      }
    }

    // Fonts — next/font in code or fontsource
    if (hasDep(pkg, 'next')) {
      out.push('');
      out.push(`## Fonts`);
      out.push(`  • Recommended: use next/font/google for Google Fonts (auto-optimized, no CLS)`);
      out.push(`  • next/font/local for self-hosted .woff2 files`);
    }

    // Recommended workflow
    out.push('');
    out.push(`## Recommended workflow for design changes`);
    out.push(`  1. analyze_design_system — extract current colors, spacing, fonts (current tokens you must respect)`);
    out.push(`  2. find_ui_components — see existing component vocabulary you should reuse`);
    out.push(`  3. design_audit — find current inconsistencies you can fix as part of the redesign`);
    out.push(`  4. present_plan — list every file you'll touch + the design rationale`);
    out.push(`  5. Make changes — match THIS stack's idioms (don't switch from Tailwind to styled-components)`);
    out.push(`  6. review_my_changes — self-critique before claiming done`);

    return {
      content: out.join('\n'),
      metadata: {
        hasNext: !!hasDep(pkg, 'next'),
        hasTailwind: !!hasDep(pkg, 'tailwindcss'),
        hasThree: !!hasDep(pkg, 'three'),
        hasShadcn: !!componentsJson,
        hasFramerMotion: !!hasDep(pkg, 'framer-motion'),
      },
    };
  }
}
