import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseSkill } from '../src/skills/loader.js';

// Flagship data-collector skill: guards frontmatter, the ethical boundary, and the
// pure-stdlib reference patterns (its value is robust+ethical collection, so the
// no-evasion stance and the runnable patterns must not silently regress).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..', 'examples', 'skills', 'data-collector');

async function loadShipped() {
  const raw = await fs.readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  return parseSkill(raw, 'data-collector', SKILL_DIR, 'builtin');
}

describe('data-collector bundled skill', () => {
  it('parses through the real loader with required fields', async () => {
    const spec = await loadShipped();
    expect(spec).not.toBeNull();
    expect(spec!.name).toBe('data-collector');
    expect(spec!.description.length).toBeGreaterThan(80);
    expect(spec!.version).toBe('1.0.0');
  });

  it('registers collection slash aliases', async () => {
    const spec = await loadShipped();
    expect(spec!.slashAliases).toContain('collect');
    expect(spec!.slashAliases).toContain('scrape');
  });

  it('has bilingual triggers (English + Persian)', async () => {
    const spec = await loadShipped();
    expect(spec!.triggers).toContain('web scraping');
    expect(spec!.triggers?.some(t => /[\u0600-\u06FF]/.test(t))).toBe(true);
  });

  it('prefers official APIs (openapi_digest) and grants real collection tools', async () => {
    const spec = await loadShipped();
    expect(spec!.allowedTools).toContain('openapi_digest'); // API-first
    expect(spec!.allowedTools).toContain('code_run');
    expect(spec!.allowedTools).toContain('tavily');
    const realTools = new Set([
      'openapi_digest', 'web_fetch', 'tavily', 'code_run', 'browser_navigate',
      'browser_get_text', 'browser_evaluate', 'csv_write', 'db_query', 'read_file',
      'write_file', 'multi_file_edit', 'ls', 'glob', 'grep',
    ]);
    for (const t of spec!.allowedTools ?? []) {
      expect(realTools.has(t), `allowed-tool "${t}" is not a known QodeX tool`).toBe(true);
    }
  });

  it('encodes the ethical boundary and API-first method hierarchy', async () => {
    const spec = await loadShipped();
    const b = spec!.body.toLowerCase();
    expect(b).toContain('robots.txt');
    expect(b).toContain('captcha');         // names what it refuses
    expect(b).toContain('official api');     // method #1
    expect(b).toContain('sp-api');           // Amazon → SP-API, not scraping
    expect(b).toContain('personal data');    // privacy boundary
  });

  it('ships a playbook + pure-stdlib runnable patterns', async () => {
    const spec = await loadShipped();
    expect(spec!.files).toContain('collection-playbook.md');
    expect(spec!.files).toContain('patterns.py');
    const py = await fs.readFile(path.join(SKILL_DIR, 'patterns.py'), 'utf8');
    // Must stay stdlib-only so it runs with zero install.
    expect(py).not.toContain('import requests');
    expect(py).not.toContain('import httpx');
    expect(py).not.toContain('from bs4');
    // Core robustness primitives present.
    expect(py).toContain('def backoff_delays');
    expect(py).toContain('def robots_allows');
    expect(py).toContain('def diff_record');
    expect(py).toContain('class Store');
  });
});
