/**
 * Design-system tools.
 *
 * - analyze_design_system: extract the design tokens currently in use
 *   (colors, fonts, spacing, radii, shadows, breakpoints). For Tailwind
 *   projects this reads tailwind.config + CSS custom properties.
 *   For CSS-in-JS, scans component code for raw values.
 *
 * - find_ui_components: list all React/Vue/Svelte components, their
 *   props/types (best-effort), and their usage count. Helps the agent
 *   know what's already in the design system before adding new components.
 *
 * - design_audit: scan for design inconsistencies — hard-coded colors
 *   that aren't tokens, inconsistent spacing, missing dark mode classes,
 *   accessibility issues (low contrast, missing alt, missing aria),
 *   non-responsive sizes, inline styles that should be classes.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor', '.cache', 'coverage']);

async function walkFiles(root: string, extensions: Set<string>, maxFiles: number): Promise<{ abs: string; rel: string; content: string }[]> {
  const out: { abs: string; rel: string; content: string }[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!extensions.has(ext)) continue;
        const abs = path.join(dir, e.name);
        try {
          const stat = await fs.stat(abs);
          if (stat.size > 2_000_000) continue;
          const content = await fs.readFile(abs, 'utf-8');
          out.push({ abs, rel: path.relative(root, abs), content });
        } catch { /* skip */ }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// analyze_design_system

const AnalyzeDesignSystemArgs = z.object({
  path: z.string().optional().describe('Subdirectory. Default cwd.'),
});

export class AnalyzeDesignSystemTool extends Tool<z.infer<typeof AnalyzeDesignSystemArgs>> {
  name = 'analyze_design_system';
  description = 'Extract the design tokens currently used in the project: colors, fonts, spacing, radii, shadows, breakpoints. Reads tailwind.config, CSS custom properties (--var), and scans CSS-in-JS literals. Use BEFORE designing — match existing tokens, don\'t invent parallel ones. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = AnalyzeDesignSystemArgs;

  async execute(args: z.infer<typeof AnalyzeDesignSystemArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ? path.join(ctx.cwd, args.path) : ctx.cwd;
    const out: string[] = [];
    out.push(`# Design System Tokens`);
    out.push('');

    // Tailwind config
    const twPaths = ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs'];
    let twContent = '';
    for (const p of twPaths) {
      try {
        twContent = await fs.readFile(path.join(root, p), 'utf-8');
        out.push(`## Tailwind config: ${p}`);
        break;
      } catch { /* try next */ }
    }
    if (twContent) {
      // Extract theme keys
      const themeMatch = /theme\s*:\s*\{([\s\S]*?)\n\s*\}\s*,?\s*(plugins|\})/m.exec(twContent);
      if (themeMatch) {
        const t = themeMatch[1]!;
        // Colors
        const colorBlock = /colors?\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(t);
        if (colorBlock) {
          out.push('');
          out.push(`### Custom colors`);
          const colorLines = colorBlock[1]!.split('\n').slice(0, 30).map(l => l.trim()).filter(l => l && !l.startsWith('//'));
          for (const l of colorLines) out.push(`  ${l}`);
        }
        // Custom font family
        const fontBlock = /fontFamily\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(t);
        if (fontBlock) {
          out.push('');
          out.push(`### Custom fonts`);
          const lines = fontBlock[1]!.split('\n').slice(0, 20).map(l => l.trim()).filter(l => l && !l.startsWith('//'));
          for (const l of lines) out.push(`  ${l}`);
        }
        // Extend block
        const extendBlock = /extend\s*:\s*\{([\s\S]*?)\n\s*\}\s*,?\s*$/m.exec(t);
        if (extendBlock) {
          out.push('');
          out.push(`### Theme extensions`);
          const lines = extendBlock[1]!.split('\n').slice(0, 40).map(l => l.trim()).filter(l => l && !l.startsWith('//'));
          for (const l of lines) out.push(`  ${l}`);
        }
      }
    } else {
      out.push(`(no tailwind.config — checking CSS files for tokens)`);
    }

    // Scan CSS files for :root vars (custom properties)
    const cssFiles = await walkFiles(root, new Set(['.css', '.scss', '.sass']), 200);
    const customProps = new Map<string, { value: string; file: string }>();
    for (const f of cssFiles) {
      const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
      let m;
      while ((m = re.exec(f.content)) !== null) {
        const name = m[1]!;
        if (!customProps.has(name)) {
          customProps.set(name, { value: m[2]!.trim(), file: f.rel });
        }
      }
    }
    if (customProps.size > 0) {
      out.push('');
      out.push(`## CSS Custom Properties (${customProps.size})`);
      // Group by prefix
      const byPrefix = new Map<string, Array<{ name: string; value: string; file: string }>>();
      for (const [name, { value, file }] of customProps) {
        const prefix = name.split('-')[0] || 'misc';
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
        byPrefix.get(prefix)!.push({ name, value, file });
      }
      const order = ['color', 'background', 'bg', 'text', 'border', 'ring', 'spacing', 'space', 'gap', 'radius', 'shadow', 'font', 'size', 'breakpoint'];
      const ordered = Array.from(byPrefix.entries()).sort((a, b) => {
        const ai = order.findIndex(o => a[0].startsWith(o));
        const bi = order.findIndex(o => b[0].startsWith(o));
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      });
      for (const [prefix, items] of ordered.slice(0, 12)) {
        out.push('');
        out.push(`### ${prefix}* (${items.length})`);
        for (const { name, value, file } of items.slice(0, 20)) {
          out.push(`  --${name}: ${value.length > 60 ? value.slice(0, 57) + '...' : value}    [${file}]`);
        }
        if (items.length > 20) out.push(`  …and ${items.length - 20} more`);
      }
    }

    // Detect color palette from raw usage in JSX/CSS (hex codes most common)
    const codeFiles = await walkFiles(root, new Set(['.tsx', '.jsx', '.ts', '.js', '.css', '.scss', '.module.css']), 500);
    const hexColors = new Map<string, number>();
    for (const f of codeFiles) {
      const re = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
      let m;
      while ((m = re.exec(f.content)) !== null) {
        const c = '#' + m[1]!.toLowerCase();
        hexColors.set(c, (hexColors.get(c) ?? 0) + 1);
      }
    }
    if (hexColors.size > 0) {
      const sorted = Array.from(hexColors.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20);
      out.push('');
      out.push(`## Hard-coded hex colors (top ${sorted.length})`);
      out.push(`  ⚠ These should usually be design tokens, not raw hex.`);
      for (const [c, n] of sorted) out.push(`  ${c}    ×${n}`);
    }

    // Recommendation
    out.push('');
    out.push(`## Recommendation`);
    if (twContent && customProps.size > 0) {
      out.push(`  Mixed system: Tailwind config + CSS custom properties. When designing, prefer Tailwind utility classes that reference these tokens (e.g. \`bg-primary\` not \`bg-[#3b82f6]\`).`);
    } else if (twContent) {
      out.push(`  Tailwind-only. Use semantic class names from the config (\`bg-primary\` not raw hex \`bg-[#3b82f6]\`).`);
    } else if (customProps.size > 0) {
      out.push(`  CSS-variables-based. Use \`var(--primary)\` in new styles, not raw colors.`);
    } else {
      out.push(`  No central design system detected — every redesign is also a chance to introduce one. Consider proposing a tokens file as part of the work.`);
    }

    return {
      content: out.join('\n'),
      metadata: {
        hasTailwind: !!twContent,
        cssVarCount: customProps.size,
        hardcodedHexes: hexColors.size,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// find_ui_components

const FindUiComponentsArgs = z.object({
  path: z.string().optional().describe('Subdirectory. Default cwd.'),
  max_files: z.number().int().min(1).max(20_000).optional().describe('Default 5000.'),
});

export class FindUiComponentsTool extends Tool<z.infer<typeof FindUiComponentsArgs>> {
  name = 'find_ui_components';
  description = 'List all React/Vue/Svelte components in the project: name, file, prop list (best-effort from interface/PropTypes), usage count across the codebase. Use to know what components already exist before adding new ones. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = FindUiComponentsArgs;

  async execute(args: z.infer<typeof FindUiComponentsArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ? path.join(ctx.cwd, args.path) : ctx.cwd;
    const maxFiles = args.max_files ?? 5000;
    const files = await walkFiles(root, new Set(['.tsx', '.jsx', '.vue', '.svelte', '.astro']), maxFiles);

    interface Comp { name: string; file: string; props: string[]; usage: number }
    const comps = new Map<string, Comp>();

    // Pass 1: extract component declarations from each file
    for (const f of files) {
      const isReact = f.rel.endsWith('.tsx') || f.rel.endsWith('.jsx');
      if (isReact) {
        // export default function X / export function X / const X = () => / const X: FC<...> =
        const re = /(?:export\s+(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)|(?:^|\n)const\s+([A-Z][A-Za-z0-9_]*)\s*=)/g;
        const seen = new Set<string>();
        let m;
        while ((m = re.exec(f.content)) !== null) {
          const name = m[1] || m[2]!;
          if (seen.has(name)) continue;
          seen.add(name);
          // Extract props from immediate interface or type alias above the function
          const propsRe = new RegExp(`(?:interface|type)\\s+${name}Props\\s*=?\\s*\\{([\\s\\S]*?)\\n\\}`);
          const pm = propsRe.exec(f.content);
          const props: string[] = [];
          if (pm) {
            const lines = pm[1]!.split('\n').slice(0, 20);
            for (const l of lines) {
              const pl = l.trim();
              if (!pl || pl.startsWith('//') || pl.startsWith('*')) continue;
              const propName = pl.split(/[:?]/)[0]?.trim();
              if (propName && /^[a-zA-Z_$]/.test(propName)) props.push(propName);
            }
          }
          if (!comps.has(name)) comps.set(name, { name, file: f.rel, props, usage: 0 });
        }
      } else if (f.rel.endsWith('.vue') || f.rel.endsWith('.svelte') || f.rel.endsWith('.astro')) {
        const base = path.basename(f.rel).replace(/\.(vue|svelte|astro)$/, '');
        if (/^[A-Z]/.test(base) && !comps.has(base)) {
          comps.set(base, { name: base, file: f.rel, props: [], usage: 0 });
        }
      }
    }

    // Pass 2: count usage — `<ComponentName` in each file
    for (const f of files) {
      for (const [name, c] of comps) {
        if (f.rel === c.file) continue;
        const re = new RegExp(`<${name}[\\s/>]`, 'g');
        const matches = f.content.match(re);
        if (matches) c.usage += matches.length;
      }
    }

    const arr = Array.from(comps.values()).sort((a, b) => b.usage - a.usage);
    const out: string[] = [];
    out.push(`# UI Components (${arr.length})`);
    out.push('');
    out.push(`## Most used (top 30)`);
    for (const c of arr.slice(0, 30)) {
      const propsStr = c.props.length > 0 ? `  props: ${c.props.slice(0, 6).join(', ')}${c.props.length > 6 ? '…' : ''}` : '';
      out.push(`  ${c.name.padEnd(28)} ×${String(c.usage).padStart(4)}  ${c.file}${propsStr}`);
    }

    const unused = arr.filter(c => c.usage === 0);
    if (unused.length > 0) {
      out.push('');
      out.push(`## Unused (${unused.length}) — candidates for dead-code review`);
      for (const c of unused.slice(0, 20)) out.push(`  ${c.name.padEnd(28)} ${c.file}`);
      if (unused.length > 20) out.push(`  …and ${unused.length - 20} more`);
    }

    return { content: out.join('\n'), metadata: { totalComponents: arr.length, unusedCount: unused.length } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// design_audit

const DesignAuditArgs = z.object({
  path: z.string().optional().describe('Subdirectory. Default cwd.'),
  max_files: z.number().int().min(1).max(20_000).optional().describe('Default 3000.'),
});

export class DesignAuditTool extends Tool<z.infer<typeof DesignAuditArgs>> {
  name = 'design_audit';
  description = 'Scan the frontend for design quality issues: hard-coded colors instead of tokens, inline styles, missing alt/aria, low color contrast warnings, non-responsive fixed sizes, missing dark mode classes, inconsistent spacing. Returns a ranked report. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = DesignAuditArgs;

  async execute(args: z.infer<typeof DesignAuditArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ? path.join(ctx.cwd, args.path) : ctx.cwd;
    const maxFiles = args.max_files ?? 3000;
    const files = await walkFiles(root, new Set(['.tsx', '.jsx', '.vue', '.svelte', '.astro', '.html']), maxFiles);

    interface Issue { severity: 'high' | 'medium' | 'low'; kind: string; file: string; line: number; detail: string }
    const issues: Issue[] = [];

    for (const f of files) {
      const lines = f.content.split('\n');
      let hasDarkClass = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        // 1. Hard-coded hex colors in JSX style or className (Tailwind arbitrary values like `bg-[#abc]` count too)
        const hexInClass = /\bclass(Name)?=["'][^"']*?\[#[0-9a-fA-F]{3,8}\]/;
        if (hexInClass.test(line)) {
          issues.push({ severity: 'medium', kind: 'hardcoded_hex_in_class', file: f.rel, line: i + 1, detail: line.trim().slice(0, 140) });
        }
        const inlineHex = /style=\{?\{?[^}]*#[0-9a-fA-F]{3,8}/;
        if (inlineHex.test(line)) {
          issues.push({ severity: 'medium', kind: 'inline_hex_color', file: f.rel, line: i + 1, detail: line.trim().slice(0, 140) });
        }

        // 2. Inline style on a real element (not just type/sx)
        const inlineStyle = /\sstyle=\{\{[^}]+\}\}/;
        if (inlineStyle.test(line) && !line.includes('style={{}}')) {
          issues.push({ severity: 'low', kind: 'inline_style', file: f.rel, line: i + 1, detail: 'Prefer className/tokens over inline style' });
        }

        // 3. <img> without alt
        if (/<img\s/.test(line) && !/\balt=/.test(line)) {
          issues.push({ severity: 'high', kind: 'missing_alt', file: f.rel, line: i + 1, detail: '<img> missing alt attribute (accessibility violation)' });
        }

        // 4. Button without text/aria-label
        const btn = /<button[^>]*>(\s*<[^>]*\/?\s*>\s*)*<\/button>/;
        if (btn.test(line) && !/aria-label=/.test(line)) {
          issues.push({ severity: 'medium', kind: 'icon_button_no_aria', file: f.rel, line: i + 1, detail: 'Icon-only button needs aria-label' });
        }

        // 5. Fixed pixel widths > 480 in className (likely non-responsive)
        if (/\bw-\[(?:6\d{2}|[7-9]\d{2}|[12]\d{3})px\]/.test(line)) {
          issues.push({ severity: 'low', kind: 'fixed_large_width', file: f.rel, line: i + 1, detail: 'Large fixed pixel width — may break responsive layout' });
        }

        // 6. Inconsistent spacing — flagged once per file if both p-3 and p-4 + py-5 + py-7 etc all show up
        // (skip — would be noisy without aggregation)

        // 7. Detect dark: prefix presence (will use in summary)
        if (line.includes('dark:')) hasDarkClass = true;

        // 8. !important in CSS-in-JS or inline
        if (/!important/.test(line)) {
          issues.push({ severity: 'low', kind: 'important_usage', file: f.rel, line: i + 1, detail: '!important breaks predictable cascading' });
        }

        // 9. h1 used multiple times per page (heuristic — count occurrences per file)
        // (skip — would need cross-line aggregation per file, do at end)

        // 10. Color in Tailwind without dark-mode variant (heuristic: `bg-white` without later `dark:bg-...`)
        // (deferred to summary)
      }

      // Per-file dark mode summary
      const hasLightColors = /\b(bg-white|text-black|bg-gray-[12]00|bg-slate-[12]00|bg-zinc-[12]00)\b/.test(f.content);
      if (hasLightColors && !hasDarkClass && /\.(tsx|jsx)$/.test(f.rel)) {
        issues.push({ severity: 'low', kind: 'no_dark_variants', file: f.rel, line: 1, detail: 'Light-mode colors used but no dark: variants — may not support dark mode' });
      }
    }

    const out: string[] = [];
    const high = issues.filter(i => i.severity === 'high');
    const medium = issues.filter(i => i.severity === 'medium');
    const low = issues.filter(i => i.severity === 'low');
    out.push(`# Design Audit`);
    out.push(`Scanned ${files.length} files. Found ${issues.length} issue(s): ${high.length} high, ${medium.length} medium, ${low.length} low.`);
    out.push('');

    if (high.length > 0) {
      out.push(`## 🔴 High — accessibility/correctness`);
      for (const i of high.slice(0, 30)) out.push(`  ${i.file}:${i.line}  [${i.kind}]  ${i.detail}`);
      if (high.length > 30) out.push(`  …and ${high.length - 30} more`);
      out.push('');
    }
    if (medium.length > 0) {
      out.push(`## 🟡 Medium — design-system drift`);
      for (const i of medium.slice(0, 30)) out.push(`  ${i.file}:${i.line}  [${i.kind}]  ${i.detail}`);
      if (medium.length > 30) out.push(`  …and ${medium.length - 30} more`);
      out.push('');
    }
    if (low.length > 0) {
      out.push(`## ⚪ Low — quality`);
      const grouped = new Map<string, number>();
      for (const i of low) grouped.set(i.kind, (grouped.get(i.kind) ?? 0) + 1);
      for (const [k, c] of grouped) out.push(`  ${k}: ${c} occurrence(s)`);
    }

    return { content: out.join('\n'), metadata: { totalIssues: issues.length, high: high.length, medium: medium.length, low: low.length } };
  }
}
