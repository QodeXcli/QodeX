/**
 * Artifact Store — Layer 1 of the Living Artifact system.
 *
 * An "artifact" is a self-contained, named, VERSIONED output the model produces (a web
 * page, a React component, an SVG, a doc) that the user will keep, review, and iterate
 * on — as opposed to a throwaway line of chat. Each artifact lives under
 * `.qodex/artifacts/<id>/` with a manifest and one folder per version, so every revision
 * is preserved and you can diff or roll back.
 *
 * This module is the foundation: create / update (new version) / list / get / rollback.
 * It is deliberately I/O-light — the actual file writes go through a `WriteFn` supplied
 * by the caller, which in production is the journaled `transaction.write` (so artifacts
 * are undoable like any other edit) and in tests is a plain fs write. The pure helpers
 * (id slugging, version math, extension mapping, manifest shaping) are exported and
 * unit-tested separately.
 *
 * Layers 2 (browser preview) and 3 (vision self-correction loop) build ON this — they
 * are not required for an artifact to exist, so the base degrades gracefully when no
 * browser/vision is available.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

export type ArtifactType = 'html' | 'react' | 'svg' | 'markdown' | 'vue' | 'text';

export interface ArtifactVersion {
  v: number;
  file: string;        // path relative to the artifact dir, e.g. "v2/index.html"
  createdAt: string;
  note?: string;       // what changed in this version
}

export interface ArtifactManifest {
  id: string;
  title: string;
  type: ArtifactType;
  createdAt: string;
  updatedAt: string;
  current: number;     // which version is "current"
  versions: ArtifactVersion[];
}

export interface ArtifactSummary {
  id: string;
  title: string;
  type: ArtifactType;
  current: number;
  versionCount: number;
  updatedAt: string;
}

/** A write function — `transaction.write` in production, a plain fs write in tests. */
export type WriteFn = (absPath: string, content: string) => Promise<void>;

// ── pure helpers (no I/O) ─────────────────────────────────────────────────────

const VALID_TYPES: readonly ArtifactType[] = ['html', 'react', 'svg', 'markdown', 'vue', 'text'];

export function isArtifactType(t: string): t is ArtifactType {
  return (VALID_TYPES as readonly string[]).includes(t);
}

/** The file extension a given artifact type renders to. */
export function extensionForType(type: ArtifactType): string {
  switch (type) {
    case 'html': return 'html';
    case 'react': return 'jsx';
    case 'svg': return 'svg';
    case 'markdown': return 'md';
    case 'vue': return 'vue';
    case 'text': return 'txt';
  }
}

/** The canonical entry filename inside a version folder for a type. */
export function entryFileName(type: ArtifactType): string {
  // Web types use index.* so a static server / browser can open the folder directly.
  return type === 'react' ? `App.${extensionForType(type)}` : `index.${extensionForType(type)}`;
}

/** Turn a human title into a stable, filesystem-safe kebab id. */
export function slugifyArtifactId(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')  // keep letters/numbers (incl. Persian), rest → '-'
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
  return base || 'artifact';
}

/** Next version number for a manifest (max existing + 1). */
export function nextVersionNumber(manifest: ArtifactManifest): number {
  return manifest.versions.reduce((max, v) => Math.max(max, v.v), 0) + 1;
}

/** Build a fresh manifest for a new artifact's first version. */
export function buildManifest(id: string, title: string, type: ArtifactType, file: string, now: string, note?: string): ArtifactManifest {
  return {
    id, title, type,
    createdAt: now, updatedAt: now,
    current: 1,
    versions: [{ v: 1, file, createdAt: now, ...(note ? { note } : {}) }],
  };
}

/** Append a new version to a manifest and make it current (immutably). */
export function addVersion(manifest: ArtifactManifest, file: string, now: string, note?: string): ArtifactManifest {
  const v = nextVersionNumber(manifest);
  return {
    ...manifest,
    updatedAt: now,
    current: v,
    versions: [...manifest.versions, { v, file, createdAt: now, ...(note ? { note } : {}) }],
  };
}

// ── path helpers ──────────────────────────────────────────────────────────────

export function artifactsRoot(cwd: string): string {
  return path.join(cwd, '.qodex', 'artifacts');
}
function artifactDir(cwd: string, id: string): string {
  return path.join(artifactsRoot(cwd), id);
}
function manifestPath(cwd: string, id: string): string {
  return path.join(artifactDir(cwd, id), 'manifest.json');
}

// ── I/O operations (writes go through WriteFn) ────────────────────────────────

async function readManifest(cwd: string, id: string): Promise<ArtifactManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(cwd, id), 'utf-8');
    return JSON.parse(raw) as ArtifactManifest;
  } catch {
    return null;
  }
}

/** Resolve a unique id when the slug already exists (append -2, -3, …). */
async function uniqueId(cwd: string, base: string): Promise<string> {
  let id = base;
  let n = 2;
  while (await readManifest(cwd, id)) {
    id = `${base}-${n++}`;
  }
  return id;
}

export interface CreateInput { title: string; type: ArtifactType; content: string; note?: string; }

/** Create a new artifact: writes v1 file + manifest. Returns the manifest + the file path. */
export async function createArtifact(cwd: string, input: CreateInput, write: WriteFn, now = new Date().toISOString()): Promise<{ manifest: ArtifactManifest; absFile: string }> {
  const id = await uniqueId(cwd, slugifyArtifactId(input.title));
  const rel = path.join('v1', entryFileName(input.type));
  const absFile = path.join(artifactDir(cwd, id), rel);
  await write(absFile, input.content);
  const manifest = buildManifest(id, input.title, input.type, rel, now, input.note);
  await write(manifestPath(cwd, id), JSON.stringify(manifest, null, 2));
  return { manifest, absFile };
}

export interface UpdateInput { id: string; content: string; note?: string; }

/** Update an artifact: writes a NEW version file + updated manifest. */
export async function updateArtifact(cwd: string, input: UpdateInput, write: WriteFn, now = new Date().toISOString()): Promise<{ manifest: ArtifactManifest; absFile: string; version: number }> {
  const existing = await readManifest(cwd, input.id);
  if (!existing) throw new Error(`Artifact "${input.id}" not found.`);
  const v = nextVersionNumber(existing);
  const rel = path.join(`v${v}`, entryFileName(existing.type));
  const absFile = path.join(artifactDir(cwd, input.id), rel);
  await write(absFile, input.content);
  const manifest = addVersion(existing, rel, now, input.note);
  await write(manifestPath(cwd, input.id), JSON.stringify(manifest, null, 2));
  return { manifest, absFile, version: v };
}

/** List all artifacts (newest-updated first). */
export async function listArtifacts(cwd: string): Promise<ArtifactSummary[]> {
  const root = artifactsRoot(cwd);
  let ids: string[];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    ids = entries.filter((d: { isDirectory(): boolean; name: string }) => d.isDirectory()).map((d: { name: string }) => d.name);
  } catch {
    return [];
  }
  const out: ArtifactSummary[] = [];
  for (const id of ids) {
    const m = await readManifest(cwd, id);
    if (m) out.push({ id: m.id, title: m.title, type: m.type, current: m.current, versionCount: m.versions.length, updatedAt: m.updatedAt });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Read a specific version's content (defaults to current). */
export async function getArtifact(cwd: string, id: string, version?: number): Promise<{ manifest: ArtifactManifest; version: number; content: string; absFile: string }> {
  const manifest = await readManifest(cwd, id);
  if (!manifest) throw new Error(`Artifact "${id}" not found.`);
  const v = version ?? manifest.current;
  const entry = manifest.versions.find(x => x.v === v);
  if (!entry) throw new Error(`Artifact "${id}" has no version ${v}.`);
  const absFile = path.join(artifactDir(cwd, id), entry.file);
  const content = await fs.readFile(absFile, 'utf-8');
  return { manifest, version: v, content, absFile };
}

/** Roll the "current" pointer back to an earlier (existing) version — no new file. */
export async function rollbackArtifact(cwd: string, id: string, toVersion: number, write: WriteFn, now = new Date().toISOString()): Promise<ArtifactManifest> {
  const manifest = await readManifest(cwd, id);
  if (!manifest) throw new Error(`Artifact "${id}" not found.`);
  if (!manifest.versions.some(v => v.v === toVersion)) throw new Error(`Artifact "${id}" has no version ${toVersion}.`);
  const updated: ArtifactManifest = { ...manifest, current: toVersion, updatedAt: now };
  await write(manifestPath(cwd, id), JSON.stringify(updated, null, 2));
  return updated;
}
