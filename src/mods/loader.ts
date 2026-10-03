/**
 * Mod discovery and loading.
 *
 * Where mods come from (a name found in several places loads once; the first wins):
 *   1. --mod-dir <dir> / QODEX_MOD_DIRS — session only; a dir that is itself a mod, or a
 *      dir of mods. Trusted: the user named it.
 *   2. ~/.qodex/mods/<name>/ — user mods.
 *   3. <cwd>/.qodex/mods/<name>/ — project mods. Code from the repository: they load only
 *      after `qodex mod trust <name>` recorded the dir and a content hash of its files in
 *      ~/.qodex/mods.json. Any change to the files needs a new trust.
 *   4. src|dist/mods/builtin/<name>/ — shipped with QodeX; on or off by the manifest's
 *      `defaultEnabled` until the user flips it.
 *
 * Two layouts: mod.json + register.(js|mjs|ts|mts), or the Claude Code plugin layout
 * (.claude-plugin/plugin.json + hooks/hooks.json { "modules": ["./register.js"] }).
 *
 * Every entry is copied into ~/.qodex/cache/mods/<hash>.mjs before import — TypeScript
 * stripped with node:module stripTypeScriptTypes (Node ≥ 22.13), relative imports pointed
 * back at the mod dir, `qodex/testing` / `claude-code/testing` at QodeX's test kit — and
 * imported under a fresh URL, so a reload always runs the new code.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { builtinModsDirs, modsCacheDir, modsStateFile, projectModsDir, userModsDir } from './paths.js';
import { MOD_LIMITS, type ModInfo, type ModManifest, type ModRegisterFn, type ModScope } from './types.js';

export interface ModsState {
  /** Mods switched on by the user (wins over a built-in's default). */
  enabled: string[];
  /** Mods switched off by the user. */
  disabled: string[];
  /** Trusted project mod dirs (absolute) → name + content hash at trust time. */
  trusted: Record<string, { name: string; hash: string; at: string }>;
  /** userConfig values per mod. */
  config: Record<string, Record<string, unknown>>;
}

export interface DiscoveredMod {
  info: ModInfo;
  manifest: ModManifest | null;
  layout: 'qodex' | 'claude';
  /** Load rank: lower runs first (outermost in every chain). */
  rank: number;
  /** Content hash of the mod's files (project mods, and every loaded mod for hot reload). */
  hash?: string;
}

const ENTRY_NAMES = ['register.js', 'register.mjs', 'register.ts', 'register.mts'];
const TS_EXT = new Set(['.ts', '.mts']);
const RANK: Record<ModScope, number> = { user: 0, project: 1, builtin: 2 };

// ── ~/.qodex/mods.json ───────────────────────────────────────────────────────

export function emptyModsState(): ModsState {
  return { enabled: [], disabled: [], trusted: {}, config: {} };
}

export async function readModsState(): Promise<ModsState> {
  try {
    const raw = JSON.parse(await fs.readFile(modsStateFile(), 'utf-8')) as Partial<ModsState>;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});
    return { enabled: strs(raw.enabled), disabled: strs(raw.disabled), trusted: obj(raw.trusted), config: obj(raw.config) };
  } catch {
    return emptyModsState();
  }
}

export async function writeModsState(state: ModsState): Promise<void> {
  await fs.mkdir(path.dirname(modsStateFile()), { recursive: true });
  await writeFileAtomic(modsStateFile(), JSON.stringify(state, null, 2) + '\n', { fsyncDir: false });
}

/** Switch a mod on or off in ~/.qodex/mods.json. */
export async function setModEnabled(name: string, enabled: boolean): Promise<void> {
  const s = await readModsState();
  s.enabled = s.enabled.filter(n => n !== name);
  s.disabled = s.disabled.filter(n => n !== name);
  (enabled ? s.enabled : s.disabled).push(name);
  await writeModsState(s);
}

export async function trustModDir(dir: string, name: string, hash: string): Promise<void> {
  const s = await readModsState();
  s.trusted[path.resolve(dir)] = { name, hash, at: new Date().toISOString() };
  await writeModsState(s);
}

export async function untrustModDir(dir: string): Promise<boolean> {
  const s = await readModsState();
  const key = path.resolve(dir);
  if (!(key in s.trusted)) return false;
  delete s.trusted[key];
  await writeModsState(s);
  return true;
}

// ── manifests ────────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function readJson(file: string): Promise<{ ok: true; value: any } | { ok: false; error: string }> {
  let text: string;
  try { text = await fs.readFile(file, 'utf-8'); } catch (e: any) { return { ok: false, error: `cannot read ${path.basename(file)}: ${e?.code ?? e?.message}` }; }
  try { return { ok: true, value: JSON.parse(text) }; } catch (e: any) { return { ok: false, error: `${path.basename(file)} is not valid JSON: ${e?.message}` }; }
}

/** Is `dir` a mod (either layout)? */
export async function isModDir(dir: string): Promise<boolean> {
  return (await exists(path.join(dir, 'mod.json'))) || (await exists(path.join(dir, '.claude-plugin', 'plugin.json')));
}

function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The built-in default of a manifest (`defaultEnabled`, or `enabledByDefault` / `enabled`). */
export function manifestDefaultEnabled(m: ModManifest | null): boolean {
  const raw = m as (ModManifest & { enabledByDefault?: unknown; enabled?: unknown }) | null;
  for (const v of [raw?.defaultEnabled, raw?.enabledByDefault, raw?.enabled]) if (typeof v === 'boolean') return v;
  return true;
}

/**
 * Read a mod dir's manifest and find its entry. Errors are returned, never thrown: a bad
 * manifest shows up in `qodex mod list` instead of breaking discovery.
 */
export async function readModManifest(dir: string): Promise<
  { ok: true; manifest: ModManifest; entry: string; layout: 'qodex' | 'claude' } | { ok: false; error: string; name?: string }
> {
  const modJson = path.join(dir, 'mod.json');
  const pluginJson = path.join(dir, '.claude-plugin', 'plugin.json');
  let manifest: ModManifest;
  let entry: string | null = null;
  let layout: 'qodex' | 'claude';
  if (await exists(modJson)) {
    layout = 'qodex';
    const r = await readJson(modJson);
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return { ok: false, error: 'mod.json must be an object' };
    manifest = r.value as ModManifest;
    if (manifest.main !== undefined) {
      if (typeof manifest.main !== 'string' || !manifest.main.trim()) return { ok: false, error: 'mod.json "main" must be a path', name: manifest.name };
      const p = path.resolve(dir, manifest.main);
      if (!inside(dir, p)) return { ok: false, error: `"main" (${manifest.main}) points outside the mod dir`, name: manifest.name };
      if (!(await exists(p))) return { ok: false, error: `"main" (${manifest.main}) does not exist`, name: manifest.name };
      entry = p;
    } else {
      for (const n of ENTRY_NAMES) {
        if (await exists(path.join(dir, n))) { entry = path.join(dir, n); break; }
      }
    }
  } else if (await exists(pluginJson)) {
    layout = 'claude';
    const r = await readJson(pluginJson);
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return { ok: false, error: 'plugin.json must be an object' };
    manifest = { name: r.value.name, description: r.value.description, version: r.value.version, userConfig: r.value.userConfig };
    const hooksJson = path.join(dir, 'hooks', 'hooks.json');
    const h = await readJson(hooksJson);
    if (!h.ok) return { ok: false, error: `hooks/hooks.json: ${h.error}`, name: manifest.name };
    const modules = h.value?.modules;
    if (!Array.isArray(modules) || modules.length === 0 || typeof modules[0] !== 'string') {
      return { ok: false, error: 'hooks/hooks.json has no "modules": ["./register.js"] entry', name: manifest.name };
    }
    const p = path.resolve(path.dirname(hooksJson), modules[0]);
    if (!inside(dir, p)) return { ok: false, error: `hooks module ${modules[0]} points outside the mod dir`, name: manifest.name };
    if (!(await exists(p))) return { ok: false, error: `hooks module ${modules[0]} does not exist`, name: manifest.name };
    entry = p;
  } else {
    return { ok: false, error: 'no mod.json and no .claude-plugin/plugin.json' };
  }
  if (typeof manifest.name !== 'string' || !MOD_LIMITS.nameRe.test(manifest.name)) {
    return { ok: false, error: `the manifest needs a "name" of letters, digits, _ and - (up to 64 characters)${manifest.name ? `, got "${String(manifest.name)}"` : ''}` };
  }
  if (!entry) return { ok: false, error: 'no entry file (register.js / .mjs / .ts / .mts, or "main")', name: manifest.name };
  if (manifest.userConfig !== undefined && (typeof manifest.userConfig !== 'object' || Array.isArray(manifest.userConfig))) {
    return { ok: false, error: '"userConfig" must be an object of fields', name: manifest.name };
  }
  return { ok: true, manifest, entry, layout };
}

/** userConfig values: manifest defaults, then ~/.qodex/mods.json `config.<name>` (coerced). */
export function resolveModOptions(manifest: ModManifest | null, saved: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(manifest?.userConfig ?? {})) {
    if (spec && typeof spec === 'object' && 'default' in spec) out[k] = (spec as { default?: unknown }).default;
  }
  for (const [k, v] of Object.entries(saved ?? {})) {
    const type = (manifest?.userConfig?.[k] as { type?: string } | undefined)?.type;
    if (type === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
    else if (type === 'boolean') out[k] = v === true || v === 'true' || v === 1;
    else if (type === 'string') out[k] = String(v);
    else out[k] = v;
  }
  return out;
}

// ── content hash ─────────────────────────────────────────────────────────────

const HASH_LIMITS = { files: 5_000, bytes: 64 * 1024 * 1024 };

/** Tests only: lower the limits of a trust hash (null restores them). */
export function setModHashLimitsForTesting(limits: { files: number; bytes: number } | null): void {
  Object.assign(HASH_LIMITS, limits ?? { files: 5_000, bytes: 64 * 1024 * 1024 });
}

/** A project mod too large to verify: it cannot be trusted (every byte must count). */
export class ModHashLimitError extends Error {}

export interface HashModDirOptions {
  /**
   * The trust hash of a project mod: EVERY file counts — node_modules included, symlinks
   * followed (the link and what it points at, even outside the dir), no byte or file
   * shortcut — and a mod past the limits throws ModHashLimitError instead of hashing part
   * of itself. Without it the hash is a change detector for hot reload (node_modules
   * skipped, sizes only past the byte limit).
   */
  strict?: boolean;
}

/**
 * sha256 over every file of a mod dir: relative paths, symlink targets and contents
 * (.git skipped; node_modules too unless `strict`).
 */
export async function hashModDir(dir: string, opts: HashModDirOptions = {}): Promise<string> {
  const strict = opts.strict === true;
  const tooLarge = () => new ModHashLimitError(
    `${dir} is too large to verify for trust (more than ${HASH_LIMITS.files} files or ${Math.round(HASH_LIMITS.bytes / 1024 / 1024)} MiB) — keep a project mod small`,
  );
  const files: Array<{ rel: string; abs: string; link?: string; dir?: boolean }> = [];
  const visited = new Set<string>();
  let truncated = false;
  const walk = async (d: string, relBase: string): Promise<void> => {
    try {
      const real = await fs.realpath(d);
      if (visited.has(real)) return; // a symlink loop
      visited.add(real);
    } catch { return; }
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length >= HASH_LIMITS.files) {
        if (strict) throw tooLarge();
        truncated = true;
        return;
      }
      if (ent.name === '.git' || (!strict && ent.name === 'node_modules')) continue;
      const p = path.join(d, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) {
        // What the link points at runs as the mod's code: hash the link AND its target.
        let link = '';
        try { link = await fs.readlink(p); } catch { /* */ }
        let st: import('fs').Stats | null = null;
        try { st = await fs.stat(p); } catch { /* dangling */ }
        if (st?.isDirectory()) {
          files.push({ rel, abs: p, link, dir: true });
          await walk(p, rel);
        } else {
          files.push({ rel, abs: p, link });
        }
      } else if (ent.isDirectory()) {
        await walk(p, rel);
      } else if (ent.isFile()) {
        files.push({ rel, abs: p });
      }
    }
  };
  await walk(dir, '');
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = createHash('sha256');
  if (truncated) h.update(`truncated:${files.length}\0`);
  let bytes = 0;
  for (const f of files) {
    h.update(f.rel);
    h.update('\0');
    if (f.link !== undefined) { h.update(`link:${f.link}`); h.update('\0'); }
    if (f.dir) continue;
    try {
      const buf = await fs.readFile(f.abs);
      bytes += buf.length;
      if (bytes > HASH_LIMITS.bytes) {
        if (strict) throw tooLarge();
        h.update(`size:${buf.length}`);
      } else {
        h.update(buf);
      }
    } catch (e) {
      if (e instanceof ModHashLimitError) throw e;
      h.update('unreadable');
    }
    h.update('\0');
  }
  return h.digest('hex');
}

// ── discovery ────────────────────────────────────────────────────────────────

async function subdirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
      .map(e => path.join(root, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Extra mod dirs from QODEX_MOD_DIRS (path-delimiter separated). */
export function envModDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.QODEX_MOD_DIRS ?? '').split(path.delimiter).map(s => s.trim()).filter(Boolean);
}

export interface DiscoverOptions {
  cwd: string;
  /** --mod-dir dirs (and QODEX_MOD_DIRS): a mod dir or a dir of mods. */
  extraDirs?: string[];
  /** Skip the built-in mods (validate / test). */
  noBuiltins?: boolean;
  state?: ModsState;
}

function baseInfo(name: string, scope: ModScope, dir: string): ModInfo {
  return { name, scope, dir, entry: '', description: '', enabled: false, trusted: scope !== 'project', loaded: false, events: [], commands: [], tools: [] };
}

/**
 * Every mod QodeX can see, in load order, with enabled / trusted / error filled in.
 * Shadowed duplicates are listed with an error and never load.
 */
export async function discoverMods(opts: DiscoverOptions): Promise<DiscoveredMod[]> {
  const state = opts.state ?? await readModsState();
  const candidates: Array<{ dir: string; scope: ModScope; fromModDir: boolean }> = [];
  for (const extra of opts.extraDirs ?? []) {
    const d = path.resolve(opts.cwd, extra);
    if (await isModDir(d)) candidates.push({ dir: d, scope: 'user', fromModDir: true });
    else for (const s of await subdirs(d)) candidates.push({ dir: s, scope: 'user', fromModDir: true });
  }
  const userRoot = userModsDir();
  for (const s of await subdirs(userRoot)) candidates.push({ dir: s, scope: 'user', fromModDir: false });
  const projRoot = projectModsDir(opts.cwd);
  if (path.resolve(projRoot) !== path.resolve(userRoot)) {
    for (const s of await subdirs(projRoot)) candidates.push({ dir: s, scope: 'project', fromModDir: false });
  }
  if (!opts.noBuiltins) {
    for (const root of builtinModsDirs()) {
      const dirs = await subdirs(root);
      if (dirs.length === 0) continue;
      for (const s of dirs) candidates.push({ dir: s, scope: 'builtin', fromModDir: false });
      break; // the first builtin dir that exists is the shipped set
    }
  }

  const out: DiscoveredMod[] = [];
  const byName = new Map<string, DiscoveredMod>();
  for (const c of candidates) {
    const m = await readModManifest(c.dir);
    const name = m.ok ? m.manifest.name : (m.name && MOD_LIMITS.nameRe.test(m.name) ? m.name : path.basename(c.dir));
    const info = baseInfo(name, c.scope, c.dir);
    if (c.fromModDir) info.fromModDir = true;
    const d: DiscoveredMod = { info, manifest: m.ok ? m.manifest : null, layout: m.ok ? m.layout : 'qodex', rank: RANK[c.scope] };
    if (!m.ok) {
      info.error = m.error;
    } else {
      info.entry = m.entry;
      info.description = typeof m.manifest.description === 'string' ? m.manifest.description : '';
    }
    const prior = byName.get(name);
    if (prior) {
      info.error = `shadowed by the ${prior.info.fromModDir ? '--mod-dir' : prior.info.scope} mod at ${prior.info.dir}`;
      out.push(d);
      continue;
    }
    byName.set(name, d);
    if (state.disabled.includes(name)) info.enabled = false;
    else if (state.enabled.includes(name)) info.enabled = true;
    else info.enabled = c.scope === 'builtin' ? manifestDefaultEnabled(d.manifest) : true;
    if (c.scope === 'project') {
      const t = state.trusted[path.resolve(c.dir)];
      try {
        d.hash = await hashModDir(c.dir, { strict: true });
      } catch (e: any) {
        // Too large to verify: it never loads (a partial hash would let unhashed files change).
        info.error = e?.message ?? String(e);
      }
      info.trusted = !!t && !!d.hash && t.hash === d.hash;
      info.trustState = !t ? 'untrusted' : info.trusted ? 'trusted' : 'changed';
    } else {
      info.trustState = 'not-needed';
    }
    out.push(d);
  }
  return out;
}

// ── import ───────────────────────────────────────────────────────────────────

/** import() of a prepared file URL (a fresh URL per load, so nothing is served from cache). */
const importUrl = (u: string): Promise<any> => import(/* @vite-ignore */ u);

let loadSeq = 0;

const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;
const TESTING_SPECS = new Set(['qodex/testing', 'claude-code/testing', '@qodex/cli/mods/testing']);

/** Global key the test kit installs itself under (src/mods/testing.ts). */
export const MOD_TESTING_GLOBAL = Symbol.for('qodex.mods.testing');

/**
 * The module a mod test imports as 'qodex/testing' / 'claude-code/testing': a shim that
 * re-exports the kit from globalThis, so it works whatever loaded QodeX (tsx, the built
 * CLI, vitest) — the test file itself is imported natively.
 */
async function testingShimUrl(): Promise<string> {
  const file = path.join(modsCacheDir(), 'qodex-testing-shim.mjs');
  const body = [
    "const kit = globalThis[Symbol.for('qodex.mods.testing')];",
    "if (!kit) throw new Error('qodex/testing is only available under qodex mod test');",
    'export const test = kit.test, expect = kit.expect, mock = kit.mock, tier = kit.tier, createTestHarness = kit.createTestHarness;',
    'export default kit;',
    '',
  ].join('\n');
  await fs.mkdir(modsCacheDir(), { recursive: true });
  await fs.writeFile(file, body, 'utf-8');
  return pathToFileURL(file).href;
}

async function resolveRelative(fromDir: string, spec: string): Promise<string | null> {
  const base = path.resolve(fromDir, spec);
  for (const cand of [base, `${base}.ts`, `${base}.mts`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
    try { if ((await fs.stat(cand)).isFile()) return cand; } catch { /* next */ }
  }
  return null;
}

/** Strip TypeScript types (node:module stripTypeScriptTypes, Node ≥ 22.13). */
async function stripTypes(source: string, file: string): Promise<string> {
  const mod = await import('node:module') as { stripTypeScriptTypes?: (code: string, opts?: { mode?: string }) => string };
  if (typeof mod.stripTypeScriptTypes !== 'function') {
    throw new Error(`${path.basename(file)} is TypeScript, and this Node (${process.version}) cannot strip types — use a .js entry or upgrade Node to 22.13+`);
  }
  // Node prints an ExperimentalWarning for this API to stderr, which would scribble over
  // the TUI: keep just that one warning quiet.
  const emit = process.emitWarning;
  process.emitWarning = function (this: unknown, w: string | Error, ...rest: unknown[]) {
    if (/stripTypeScriptTypes/.test(typeof w === 'string' ? w : String(w?.message))) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  } as typeof process.emitWarning;
  try {
    return mod.stripTypeScriptTypes(source, { mode: 'strip' });
  } catch (e: any) {
    throw new Error(`${path.basename(file)}: ${e?.message ?? e} (only erasable TypeScript is supported: no enums, namespaces or parameter properties)`);
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * Copy `file` (and the TypeScript files it imports) into the cache as ES modules and
 * return the URL to import. Relative JS imports point back at the original files.
 */
async function prepareModule(file: string, loadId: string, seen: Map<string, string>): Promise<string> {
  const known = seen.get(file);
  if (known) return known;
  if (seen.size > 64) throw new Error('too many TypeScript files imported by one mod (64 max)');
  let source = await fs.readFile(file, 'utf-8');
  if (TS_EXT.has(path.extname(file))) source = await stripTypes(source, file);
  const hashName = createHash('sha256').update(file).update('\0').update(source).digest('hex').slice(0, 32);
  const out = path.join(modsCacheDir(), `${hashName}.mjs`);
  const url = `${pathToFileURL(out).href}?v=${loadId}`;
  seen.set(file, url);
  const replacements: Array<[string, string]> = [];
  for (const m of source.matchAll(SPEC_RE)) {
    const spec = m[3]!;
    if (TESTING_SPECS.has(spec)) {
      replacements.push([spec, await testingShimUrl()]);
    } else if (spec.startsWith('./') || spec.startsWith('../')) {
      const target = await resolveRelative(path.dirname(file), spec);
      if (!target) continue;
      const targetUrl = TS_EXT.has(path.extname(target))
        ? await prepareModule(target, loadId, seen)
        : `${pathToFileURL(target).href}?v=${loadId}`;
      replacements.push([spec, targetUrl]);
    }
  }
  if (replacements.length) {
    const map = new Map(replacements);
    source = source.replace(SPEC_RE, (all, pre: string, q: string, spec: string) => (map.has(spec) ? `${pre}${q}${map.get(spec)}${q}` : all));
  }
  await fs.mkdir(modsCacheDir(), { recursive: true });
  await fs.writeFile(out, source, 'utf-8');
  return url;
}

/** Import a module file fresh (new URL every call). TypeScript is stripped first. */
export async function importModFile(file: string): Promise<any> {
  const loadId = `${Date.now().toString(36)}-${++loadSeq}`;
  const url = await prepareModule(path.resolve(file), loadId, new Map());
  return importUrl(url);
}

/** Import a mod's entry and return its register function. */
export async function importModEntry(entry: string): Promise<ModRegisterFn> {
  const mod = await importModFile(entry);
  const fn = typeof mod?.register === 'function' ? mod.register
    : typeof mod?.default?.register === 'function' ? mod.default.register
      : typeof mod?.default === 'function' ? mod.default
        : null;
  if (!fn) throw new Error(`${path.basename(entry)} exports no register(on, options) function`);
  return fn as ModRegisterFn;
}
