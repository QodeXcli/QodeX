/**
 * MCP server scaffolder.
 *
 * Given a target directory and a small spec, writes a working `@modelcontextprotocol/sdk`
 * server with one example tool and a vitest setup. The output is ready to
 * `npm install && npm run build && npm start` — and ready to register in QodeX's
 * `mcp.servers` config.
 *
 * Templates live at `<repo>/mcp-templates/` (NOT under `src/`), so TypeScript
 * doesn't try to compile them. We resolve the path at runtime relative to this
 * module's location, the same trick the grammar loader uses.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as url from 'url';

export interface ScaffoldSpec {
  /** Target directory. Created if missing. */
  dir: string;
  /** Package + binary name (kebab-case). */
  name: string;
  /** One-line description for package.json / README. */
  description: string;
  /** stdio is the only transport supported by the default template. */
  transport: 'stdio';
}

export interface ScaffoldResult {
  dir: string;
  filesWritten: string[];
  configSnippet: string;
}

const TEMPLATE_FILES: Array<{ src: string; dest: string }> = [
  { src: 'package.json.tmpl', dest: 'package.json' },
  { src: 'tsconfig.json.tmpl', dest: 'tsconfig.json' },
  { src: 'README.md.tmpl', dest: 'README.md' },
  { src: '.gitignore.tmpl', dest: '.gitignore' },
  { src: 'src/index.ts.tmpl', dest: 'src/index.ts' },
  { src: 'src/tools/example.ts.tmpl', dest: 'src/tools/example.ts' },
  { src: 'test/example.test.ts.tmpl', dest: 'test/example.test.ts' },
];

export async function scaffoldMcpServer(spec: ScaffoldSpec, opts: { overwrite?: boolean } = {}): Promise<ScaffoldResult> {
  validateName(spec.name);

  const templateRoot = resolveTemplateRoot();

  // Refuse to clobber a non-empty dir unless explicitly told to.
  const targetExists = await dirExists(spec.dir);
  if (targetExists) {
    const entries = await fs.readdir(spec.dir);
    if (entries.length > 0 && !opts.overwrite) {
      throw new Error(`Target directory "${spec.dir}" is not empty. Pass overwrite=true to proceed.`);
    }
  }

  const absDist = path.resolve(spec.dir, 'dist');
  const vars: Record<string, string> = {
    NAME: spec.name,
    DESCRIPTION: escapeForJsonString(spec.description),
    TRANSPORT: spec.transport,
    ABSOLUTE_DIST_PATH: absDist,
  };

  const written: string[] = [];
  for (const f of TEMPLATE_FILES) {
    const srcPath = path.join(templateRoot, f.src);
    const destPath = path.join(spec.dir, f.dest);
    let body: string;
    try {
      body = await fs.readFile(srcPath, 'utf-8');
    } catch (e: any) {
      throw new Error(`Template missing: ${f.src} (looked at ${srcPath}). Re-run scripts/install-grammars.mjs or reinstall QodeX.`);
    }
    const rendered = applyVars(body, vars);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, rendered, 'utf-8');
    written.push(path.relative(spec.dir, destPath));
  }

  const configSnippet =
    `mcp:\n  servers:\n    ${spec.name}:\n      command: node\n      args: ["${absDist}/index.js"]\n      enabled: true\n`;

  return { dir: spec.dir, filesWritten: written, configSnippet };
}

function applyVars(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key]!;
    return whole; // leave unknown tokens alone so the failure is visible
  });
}

function validateName(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid name "${name}". Use lowercase letters, digits, and hyphens; must start with a letter.`);
  }
  if (name.length > 64) throw new Error(`Name too long (max 64): "${name}".`);
}

function escapeForJsonString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

async function dirExists(p: string): Promise<boolean> {
  try { const st = await fs.stat(p); return st.isDirectory(); } catch { return false; }
}

/**
 * The templates live at `<repo>/mcp-templates`. At dev-time this module lives at
 * `<repo>/src/mcp/scaffold/builder.ts` (so up 3 levels from import.meta.url's dir).
 * After `tsc` it lives at `<repo>/dist/mcp/scaffold/builder.js` (also up 3 levels).
 * Either way, ../../../mcp-templates is correct.
 *
 * Exposed for the test suite to point at a temp template root.
 */
export function resolveTemplateRoot(override?: string): string {
  if (override) return override;
  if (process.env.QODEX_MCP_TEMPLATE_ROOT) return process.env.QODEX_MCP_TEMPLATE_ROOT;
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'mcp-templates');
}
