import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

/**
 * `backend_routemap` — give the model a native understanding of a Python backend
 * the way wp_find_hook gives it WordPress. It scans .py files and extracts:
 *   - FastAPI / Flask routes: @app.get / @router.post(...) → method, path, handler
 *   - Django URLConf: path()/re_path()/url() → route → view
 *   - Django REST Framework routers: router.register(prefix, ViewSet)
 *   - Django ORM models: class X(models.Model) → fields + types
 *
 * So the agent can refactor/debug routes and models with real structure instead
 * of grepping blindly. Read-only.
 *
 * HONEST CAVEAT (also stated in output): this is regex/heuristic-based, not a full
 * Python parser. It catches the common decorator/urlconf/model idioms; exotic
 * dynamic route registration or metaclass tricks may be missed. It's a fast map,
 * not a compiler.
 */

const Args = z.object({
  dir: z.string().optional().describe('Directory to scan. Default current working directory.'),
  framework: z.enum(['auto', 'fastapi', 'django', 'flask']).optional().describe('Force a framework, or auto-detect (default).'),
  max_files: z.number().int().min(1).max(5000).optional().describe('Safety cap on files scanned. Default 1500.'),
});

const IGNORE_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env', '.mypy_cache', '.pytest_cache', 'migrations', 'site-packages', 'dist', 'build']);

async function walkPy(root: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    if (out.length >= maxFiles) return;
    let entries: any[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await rec(path.join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.py')) {
        out.push(path.join(dir, e.name));
      }
    }
  }
  await rec(root);
  return out;
}

interface Route { method: string; route: string; handler: string; file: string; }
interface Model { name: string; fields: string[]; file: string; }

// FastAPI / Flask: @app.get("/x") / @router.post("/y") / @app.route("/z", methods=[...])
const DECORATOR_RE = /@(\w+)\.(get|post|put|patch|delete|head|options|route)\s*\(\s*['"]([^'"]+)['"]([^)]*)\)/g;
// next def after a decorator
const DEF_RE = /def\s+(\w+)\s*\(/;
// APIRouter prefix: APIRouter(prefix="/api")
const PREFIX_RE = /APIRouter\s*\([^)]*prefix\s*=\s*['"]([^'"]+)['"]/;
// Django urls: path("x/", view, ...) / re_path(r"^x$", view) / url(r"...", view)
const DJANGO_URL_RE = /\b(?:path|re_path|url)\s*\(\s*[rR]?['"]([^'"]*)['"]\s*,\s*([\w.]+)/g;
// DRF router.register("prefix", SomeViewSet)
const DRF_RE = /\.register\s*\(\s*[rR]?['"]([^'"]+)['"]\s*,\s*(\w+)/g;
// Django model: class Foo(models.Model) ... field = models.XField(
const MODEL_RE = /class\s+(\w+)\s*\(\s*(?:[\w.]*[Mm]odel[\w.]*)\s*\)\s*:/g;
const FIELD_RE = /^\s{4,}(\w+)\s*=\s*(?:models|serializers)\.(\w+)\s*\(/gm;

export class BackendRoutemapTool extends Tool<z.infer<typeof Args>> {
  name = 'backend_routemap';
  description = 'Map a Python backend: extract FastAPI/Flask routes (@app.get/@router.post), Django URLConf (path/re_path), DRF router registrations, and Django ORM models with their fields. Use this to understand or refactor a FastAPI/Django/Flask codebase structurally before editing — the Python analogue of wp_find_hook. Read-only; regex-based best-effort.';
  isReadOnly = true; isDestructive = false; argsSchema = Args;

  async execute(a: z.infer<typeof Args>, ctx: ToolContext): Promise<ToolResult> {
    const root = a.dir ?? ctx.cwd ?? process.cwd();
    const files = await walkPy(root, a.max_files ?? 1500);
    if (files.length === 0) return { content: `No .py files found under ${root}.` };

    const routes: Route[] = [];
    const drf: Route[] = [];
    const models: Model[] = [];
    const fwHits = { fastapi: 0, django: 0, flask: 0 };

    for (const file of files) {
      let src: string;
      try { src = await fs.readFile(file, 'utf8'); } catch { continue; }
      const rel = path.relative(root, file);

      if (/from\s+fastapi|import\s+fastapi|APIRouter/.test(src)) fwHits.fastapi++;
      if (/from\s+django|django\.urls|models\.Model/.test(src)) fwHits.django++;
      if (/from\s+flask|import\s+flask|Flask\(/.test(src)) fwHits.flask++;

      const prefixMatch = PREFIX_RE.exec(src);
      const prefix = prefixMatch?.[1] ?? '';

      // FastAPI/Flask decorators → pair with the def that follows.
      DECORATOR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DECORATOR_RE.exec(src))) {
        const verb = m[2]!.toLowerCase();
        const route = (verb === 'route' ? '' : prefix) + m[3]!;
        const after = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
        const def = DEF_RE.exec(after);
        const methodsAttr = /methods\s*=\s*\[([^\]]*)\]/.exec(m[4] ?? '');
        const method = methodsAttr ? methodsAttr[1]!.replace(/['"\s]/g, '') : (verb === 'route' ? 'GET' : verb.toUpperCase());
        routes.push({ method, route, handler: def?.[1] ?? '?', file: rel });
      }

      // Django URLConf
      DJANGO_URL_RE.lastIndex = 0;
      while ((m = DJANGO_URL_RE.exec(src))) {
        routes.push({ method: 'URL', route: '/' + (m[1] ?? '').replace(/^\^?\/?/, ''), handler: m[2] ?? '?', file: rel });
      }

      // DRF routers
      DRF_RE.lastIndex = 0;
      while ((m = DRF_RE.exec(src))) {
        drf.push({ method: 'VIEWSET', route: '/' + (m[1] ?? ''), handler: m[2] ?? '?', file: rel });
      }

      // Django models
      MODEL_RE.lastIndex = 0;
      let mm: RegExpExecArray | null;
      while ((mm = MODEL_RE.exec(src))) {
        const name = mm[1]!;
        // Capture the model body until the next top-level class/def or EOF.
        const bodyStart = mm.index + mm[0].length;
        const rest = src.slice(bodyStart);
        const nextClass = rest.search(/\nclass\s|\ndef\s/);
        const body = nextClass === -1 ? rest : rest.slice(0, nextClass);
        const fields: string[] = [];
        FIELD_RE.lastIndex = 0;
        let fm: RegExpExecArray | null;
        while ((fm = FIELD_RE.exec(body))) fields.push(`${fm[1]}: ${fm[2]}`);
        models.push({ name, fields, file: rel });
      }
    }

    const detected = a.framework && a.framework !== 'auto'
      ? a.framework
      : (Object.entries(fwHits).sort((x, y) => y[1] - x[1])[0]?.[1] ? Object.entries(fwHits).sort((x, y) => y[1] - x[1])[0]![0] : 'unknown');

    const lines: string[] = [];
    lines.push(`# Backend route map  (detected: ${detected}, ${files.length} files scanned)`);
    lines.push('');
    if (routes.length) {
      lines.push(`## Routes (${routes.length})`);
      for (const r of routes) lines.push(`  ${r.method.padEnd(7)} ${r.route.padEnd(36)} → ${r.handler}   [${r.file}]`);
      lines.push('');
    }
    if (drf.length) {
      lines.push(`## DRF ViewSets (${drf.length})`);
      for (const r of drf) lines.push(`  ${r.route.padEnd(28)} → ${r.handler}   [${r.file}]`);
      lines.push('');
    }
    if (models.length) {
      lines.push(`## ORM models (${models.length})`);
      for (const md of models) {
        lines.push(`  ${md.name}  [${md.file}]`);
        for (const f of md.fields) lines.push(`      ${f}`);
      }
      lines.push('');
    }
    if (!routes.length && !drf.length && !models.length) {
      lines.push('No routes or models matched. If this is an unusual setup, the regex heuristics may have missed them — fall back to grep/semantic_search.');
    } else {
      lines.push('_Heuristic (regex-based) extraction — verify exotic/dynamic registrations manually._');
    }
    return { content: lines.join('\n') };
  }
}
