/**
 * agentskills.io interop — import/export skills in the open standard so QodeX's (more rigorous)
 * skills can be shared, and community skills pulled in.
 *
 * QodeX SKILL.md is already frontmatter + markdown; the only difference is QodeX-internal keys
 * (provenance / status / confidence) that aren't part of the standard. Export strips them down to
 * the standard surface; import re-stamps `provenance: imported` so the skill is clearly external
 * (and, being human-installed, protected from machine overwrite). All transforms are PURE.
 */

/** Frontmatter keys that are QodeX-internal, never emitted in a standard skill. */
const INTERNAL = new Set(['provenance', 'status', 'confidence', 'capturedat', 'captured_at', 'version']);
/** Standard keys we carry through verbatim when present. */
const STANDARD_EXTRA = ['license', 'allowed-tools', 'allowed_tools', 'metadata'];

export interface Frontmatter { keys: [string, string][]; body: string }

/** Split `---\n…\n---\nbody`. No frontmatter ⇒ empty keys + the whole text as body. PURE. */
export function splitFrontmatter(md: string): Frontmatter {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md);
  if (!m) return { keys: [], body: md };
  const keys: [string, string][] = [];
  for (const line of m[1]!.split('\n')) {
    const mm = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (mm) keys.push([mm[1]!, mm[2]!.trim()]);
  }
  return { keys, body: m[2]! };
}

export function serializeFrontmatter(keys: [string, string][], body: string): string {
  return `---\n${keys.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

const lookup = (keys: [string, string][], k: string): string | undefined =>
  keys.find(([kk]) => kk.toLowerCase() === k.toLowerCase())?.[1];

/** QodeX SKILL.md → agentskills.io-standard SKILL.md (drops internal keys). PURE. */
export function toAgentSkill(md: string, fallbackName = ''): string {
  const { keys, body } = splitFrontmatter(md);
  const out: [string, string][] = [
    ['name', lookup(keys, 'name') || fallbackName],
    ['description', lookup(keys, 'description') || ''],
  ];
  for (const k of STANDARD_EXTRA) { const v = lookup(keys, k); if (v && !out.some(([ok]) => ok === k)) out.push([k, v]); }
  return serializeFrontmatter(out, body);
}

/** agentskills.io SKILL.md → QodeX SKILL.md (stamps provenance: imported). PURE. */
export function fromAgentSkill(md: string, opts: { name?: string } = {}): string {
  const { keys, body } = splitFrontmatter(md);
  const out: [string, string][] = [
    ['name', lookup(keys, 'name') || opts.name || ''],
    ['description', lookup(keys, 'description') || ''],
    ['provenance', 'imported'],
  ];
  for (const [k, v] of keys) {
    const kl = k.toLowerCase();
    if (kl === 'name' || kl === 'description' || INTERNAL.has(kl)) continue;
    if (!out.some(([ok]) => ok.toLowerCase() === kl)) out.push([k, v]);
  }
  return serializeFrontmatter(out, body);
}

/** Slug for a skill dir name from its frontmatter name. PURE. */
export function skillSlug(md: string, fallback = 'skill'): string {
  const name = lookup(splitFrontmatter(md).keys, 'name') || fallback;
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}
