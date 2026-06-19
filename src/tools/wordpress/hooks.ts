/**
 * WordPress-specific helpers.
 *
 * Hamed has a heavy WordPress stack: sg-commerce-pro (custom WP plugin),
 * SEO Pro Engine, EasyGo CRM, Seven Gum theme, ChinPost theme. Default
 * code-search tools work, but WordPress has invisible call edges:
 *
 *   - `do_action('event_name', $args)` fires every registered callback
 *   - `apply_filters('filter_name', $val)` runs through every filter
 *   - Hook names are STRINGS, so grep finds them but understanding the
 *     graph requires custom parsing.
 *
 * Two tools:
 *
 *   wp_find_hook: given a hook name, list every place it's fired
 *     (do_action/apply_filters) AND every callback registered for it
 *     (add_action/add_filter). The cross-reference grep can't easily do.
 *
 *   wp_list_hooks: discover all custom hooks defined in the project
 *     (do_action/apply_filters call sites). Useful when joining a
 *     WordPress codebase and you want to know the event surface.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.cache', 'wp-includes', 'wp-admin']);

async function walkPhp(root: string, maxFiles: number, cb: (filePath: string, content: string) => void): Promise<void> {
  let count = 0;
  const stack = [root];
  while (stack.length > 0 && count < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (count >= maxFiles) break;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.php')) {
        const abs = path.join(dir, entry.name);
        try {
          const stat = await fs.stat(abs);
          if (stat.size > 2_000_000) continue;
          const content = await fs.readFile(abs, 'utf-8');
          cb(abs, content);
          count++;
        } catch { /* skip */ }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// wp_find_hook

const WpFindHookArgs = z.object({
  hook_name: z.string().min(1).describe('Exact hook name to look up. Examples: "init", "wp_enqueue_scripts", "woocommerce_order_status_changed".'),
  max_files: z.number().int().min(1).max(50_000).optional().describe('File scan cap. Default 5000.'),
});

export class WpFindHookTool extends Tool<z.infer<typeof WpFindHookArgs>> {
  name = 'wp_find_hook';
  description = 'WordPress: cross-reference a hook name. Lists every do_action/apply_filters call (where it fires) AND every add_action/add_filter (where callbacks register). Use to map invisible WP call edges. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = WpFindHookArgs;

  async execute(args: z.infer<typeof WpFindHookArgs>, ctx: ToolContext): Promise<ToolResult> {
    const maxFiles = args.max_files ?? 5000;
    const hook = args.hook_name;
    const escaped = hook.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Patterns
    const fireRe = new RegExp(`\\b(do_action|apply_filters|do_action_ref_array|apply_filters_ref_array)\\s*\\(\\s*['"]${escaped}['"]`, 'g');
    const registerRe = new RegExp(`\\b(add_action|add_filter)\\s*\\(\\s*['"]${escaped}['"]\\s*,\\s*([^,)]+)(?:\\s*,\\s*(\\d+))?(?:\\s*,\\s*(\\d+))?`, 'g');

    const fires: { file: string; line: number; text: string }[] = [];
    const registrations: { file: string; line: number; callback: string; priority?: string; argCount?: string }[] = [];

    await walkPhp(ctx.cwd, maxFiles, (abs, content) => {
      const rel = path.relative(ctx.cwd, abs);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (fireRe.test(line)) {
          fires.push({ file: rel, line: i + 1, text: line.trim().slice(0, 200) });
        }
        fireRe.lastIndex = 0;
        let m;
        while ((m = registerRe.exec(line)) !== null) {
          registrations.push({
            file: rel,
            line: i + 1,
            callback: m[2]!.trim(),
            priority: m[3],
            argCount: m[4],
          });
        }
        registerRe.lastIndex = 0;
      }
    });

    const out: string[] = [];
    out.push(`# WordPress hook: \`${hook}\``);
    out.push('');
    out.push(`## Fires (${fires.length}) — where do_action/apply_filters is called`);
    if (fires.length === 0) {
      out.push(`  Not fired in this codebase. Likely a WordPress core / plugin hook fired externally.`);
    } else {
      for (const f of fires.slice(0, 30)) out.push(`  ${f.file}:${f.line}  ${f.text}`);
      if (fires.length > 30) out.push(`  …and ${fires.length - 30} more`);
    }
    out.push('');
    out.push(`## Registered callbacks (${registrations.length}) — where add_action/add_filter wires up`);
    if (registrations.length === 0) {
      out.push(`  Nothing in this codebase listens for it. (Could be fired but unused, or naming mismatch.)`);
    } else {
      for (const r of registrations.slice(0, 40)) {
        const meta = r.priority ? ` (priority=${r.priority}${r.argCount ? `, args=${r.argCount}` : ''})` : '';
        out.push(`  ${r.file}:${r.line}  → ${r.callback}${meta}`);
      }
      if (registrations.length > 40) out.push(`  …and ${registrations.length - 40} more`);
    }

    return {
      content: out.join('\n'),
      metadata: { fires: fires.length, registrations: registrations.length },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// wp_list_hooks

const WpListHooksArgs = z.object({
  path_filter: z.string().optional().describe('Subdirectory to scan (relative to cwd). Default whole project.'),
  kind: z.enum(['actions', 'filters', 'both']).optional().describe('Default both.'),
  max_files: z.number().int().min(1).max(50_000).optional().describe('Default 5000.'),
});

export class WpListHooksTool extends Tool<z.infer<typeof WpListHooksArgs>> {
  name = 'wp_list_hooks';
  description = 'WordPress: discover every custom hook (do_action/apply_filters) defined in the project. Returns hook name + fire count + sample file. Use to map the project\'s event surface. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = WpListHooksArgs;

  async execute(args: z.infer<typeof WpListHooksArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path_filter ? path.join(ctx.cwd, args.path_filter) : ctx.cwd;
    const maxFiles = args.max_files ?? 5000;
    const kind = args.kind ?? 'both';

    const re = kind === 'actions' ? /\bdo_action(?:_ref_array)?\s*\(\s*['"]([^'"]+)['"]/g
             : kind === 'filters' ? /\bapply_filters(?:_ref_array)?\s*\(\s*['"]([^'"]+)['"]/g
             : /\b(do_action|apply_filters)(?:_ref_array)?\s*\(\s*['"]([^'"]+)['"]/g;

    const hooks = new Map<string, { kind: 'action' | 'filter'; count: number; firstFile: string; firstLine: number }>();

    await walkPhp(root, maxFiles, (abs, content) => {
      const rel = path.relative(ctx.cwd, abs);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        let m;
        while ((m = re.exec(line)) !== null) {
          const fn = kind === 'both' ? m[1]! : (kind === 'actions' ? 'do_action' : 'apply_filters');
          const name = kind === 'both' ? m[2]! : m[1]!;
          const hookKind: 'action' | 'filter' = fn.startsWith('do_action') ? 'action' : 'filter';
          const existing = hooks.get(name);
          if (existing) existing.count++;
          else hooks.set(name, { kind: hookKind, count: 1, firstFile: rel, firstLine: i + 1 });
        }
        re.lastIndex = 0;
      }
    });

    const out: string[] = [];
    out.push(`# WordPress hooks discovered (${hooks.size})`);
    out.push(`Scope: ${args.path_filter ?? 'whole project'} (${kind})`);
    out.push('');

    // Group action vs filter
    const actions = Array.from(hooks.entries()).filter(([, v]) => v.kind === 'action').sort((a, b) => b[1].count - a[1].count);
    const filters = Array.from(hooks.entries()).filter(([, v]) => v.kind === 'filter').sort((a, b) => b[1].count - a[1].count);

    if (actions.length > 0) {
      out.push(`## Actions (${actions.length})`);
      for (const [n, v] of actions.slice(0, 50)) {
        out.push(`  ${n.padEnd(48)}  ×${v.count}  first: ${v.firstFile}:${v.firstLine}`);
      }
      if (actions.length > 50) out.push(`  …and ${actions.length - 50} more`);
      out.push('');
    }
    if (filters.length > 0) {
      out.push(`## Filters (${filters.length})`);
      for (const [n, v] of filters.slice(0, 50)) {
        out.push(`  ${n.padEnd(48)}  ×${v.count}  first: ${v.firstFile}:${v.firstLine}`);
      }
      if (filters.length > 50) out.push(`  …and ${filters.length - 50} more`);
    }

    return { content: out.join('\n'), metadata: { actionCount: actions.length, filterCount: filters.length } };
  }
}
