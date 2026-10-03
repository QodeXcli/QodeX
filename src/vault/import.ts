/**
 * Password-manager CSV exports → vault entries (`qodex vault import`). PURE.
 *
 * Formats (header detection, case-insensitive):
 *   chrome     name,url,username,password[,note]                (Chrome / Edge / Brave / Opera)
 *   firefox    url,username,password,httpRealm,formActionOrigin,guid,…
 *   bitwarden  folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
 *   1password  Title,Url,Username,Password,OTPAuth,…            (1Password 7/8 CSV)
 *
 * Rows that cannot be bound to a web origin are skipped and COUNTED (android:// and
 * other app URLs, plain http on a non-local host, rows without a password, non-login
 * Bitwarden items). Nothing here ever puts a cell value into an error or the report:
 * problems are reported by row number and reason only. Notes are not imported (they
 * often hold recovery codes, and `qodex vault list` prints notes).
 */

import { formatOrigin, normalizeOrigin, type VaultEntryInput } from './vault.js';
import { parseTotpInput } from './totp.js';

export type ImportFormat = 'chrome' | 'firefox' | 'bitwarden' | '1password';
export const IMPORT_FORMATS: readonly ImportFormat[] = ['chrome', 'firefox', 'bitwarden', '1password'];

/** RFC 4180 CSV: quoted fields, "" escapes, CRLF / LF, newlines inside quotes, BOM. Throws [VAULT_IMPORT_INVALID] with a row number only. */
export function parseCsv(text: string): string[][] {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let rowNo = 1;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (c === '\n') rowNo++;
      field += c; i++; continue;
    }
    if (c === '"') {
      if (field.length) throw new Error(`[VAULT_IMPORT_INVALID] row ${rowNo}: a quote in the middle of an unquoted field — is this a CSV export?`);
      quoted = true; i++; continue;
    }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
      if (c === '\r' && s[i + 1] === '\n') i++;
      i++; rowNo++;
      continue;
    }
    field += c; i++;
  }
  if (quoted) throw new Error(`[VAULT_IMPORT_INVALID] row ${rowNo}: a quoted field is never closed — is this a CSV export?`);
  row.push(field);
  if (!(row.length === 1 && row[0] === '')) rows.push(row);
  return rows;
}

interface Columns { name?: number; url?: number; username?: number; password?: number; totp?: number; type?: number }

function columnsFor(format: ImportFormat, header: string[]): Columns | null {
  const h = header.map(x => x.trim().toLowerCase());
  const at = (...names: string[]) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return undefined; };
  let c: Columns;
  switch (format) {
    case 'chrome': c = { name: at('name'), url: at('url'), username: at('username'), password: at('password') }; break;
    case 'firefox': c = { url: at('url'), username: at('username'), password: at('password') }; break;
    case 'bitwarden': c = { name: at('name'), url: at('login_uri'), username: at('login_username'), password: at('login_password'), totp: at('login_totp'), type: at('type') }; break;
    case '1password': c = { name: at('title', 'name'), url: at('url', 'website', 'urls'), username: at('username'), password: at('password'), totp: at('otpauth', 'one-time password', 'otp') }; break;
  }
  return c.url !== undefined && c.password !== undefined ? c : null;
}

/** The format a header row belongs to, or null. PURE. */
export function detectFormat(header: string[]): ImportFormat | null {
  const h = new Set(header.map(x => x.trim().toLowerCase()));
  if (h.has('login_uri') && h.has('login_password')) return 'bitwarden';
  if (h.has('url') && h.has('password') && (h.has('httprealm') || h.has('formactionorigin') || h.has('guid'))) return 'firefox';
  if (h.has('title') && h.has('password') && (h.has('url') || h.has('website') || h.has('urls'))) return '1password';
  if (h.has('name') && h.has('url') && h.has('password')) return 'chrome';
  if (h.has('url') && h.has('username') && h.has('password')) return 'firefox';
  return null;
}

export type SkipReason = 'app-or-no-url' | 'insecure-http' | 'no-password' | 'not-a-login' | 'invalid';

export interface ImportPlan {
  format: ImportFormat;
  /** Data rows (header excluded). */
  rows: number;
  entries: VaultEntryInput[];
  /** Row index (1-based, header = row 1) for each entry, for messages. */
  rowOf: number[];
  skipped: Record<SkipReason, number>;
  /** Rows imported without their TOTP seed because it could not be parsed (Steam / HOTP…). */
  totpDropped: number;
}

const NAME_BAD = /[^\p{L}\p{N} ._@+-]+/gu;

/** A valid vault entry name from a title / host, or ''. PURE. */
export function toEntryName(raw: string): string {
  return String(raw ?? '').replace(NAME_BAD, '-').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 64).replace(/[ .-]+$/u, '').trim();
}

/** The web origin of an exported URL, or why it cannot be used. PURE. */
function originOf(rawUrl: string): { origin: string; host: string } | { skip: SkipReason } {
  const urls = String(rawUrl ?? '').split(/[\s,]+/).map(u => u.trim()).filter(Boolean);
  let sawHttp = false;
  for (const u of urls) {
    const m = u.match(/^([a-z][a-z0-9+.-]*):/i);
    const scheme = m ? m[1].toLowerCase() : 'https';
    if (scheme !== 'http' && scheme !== 'https') continue;
    let url: URL;
    try { url = new URL(m ? u : `https://${u}`); } catch { continue; }
    const n = normalizeOrigin(url.origin);
    if (!n) { if (scheme === 'http') sawHttp = true; continue; }
    return { origin: formatOrigin(n), host: n.host };
  }
  return { skip: sawHttp ? 'insecure-http' : 'app-or-no-url' };
}

/**
 * Plan an import: parse, detect the format, map rows to entries with unique valid names.
 * Throws [VAULT_IMPORT_INVALID] for an unknown layout (header names only, never values).
 */
export function planImport(text: string, format: ImportFormat | 'auto' = 'auto'): ImportPlan {
  const table = parseCsv(text);
  if (!table.length) throw new Error('[VAULT_IMPORT_INVALID] the file is empty');
  const header = table[0];
  const fmt = format === 'auto' ? detectFormat(header) : format;
  if (!fmt) throw new Error(`[VAULT_IMPORT_INVALID] unknown CSV layout (${header.length} columns) — export from Chrome, Firefox, Bitwarden or 1Password as CSV, or pass --format`);
  const cols = columnsFor(fmt, header);
  if (!cols) throw new Error(`[VAULT_IMPORT_INVALID] the header does not look like a ${fmt} export (needs url and password columns)`);

  const plan: ImportPlan = {
    format: fmt, rows: table.length - 1, entries: [], rowOf: [], totpDropped: 0,
    skipped: { 'app-or-no-url': 0, 'insecure-http': 0, 'no-password': 0, 'not-a-login': 0, invalid: 0 },
  };
  const taken = new Set<string>();
  const cell = (r: string[], i?: number) => (i === undefined ? '' : String(r[i] ?? ''));
  for (let ri = 1; ri < table.length; ri++) {
    const r = table[ri];
    if (cols.type !== undefined) {
      const t = cell(r, cols.type).trim().toLowerCase();
      if (t && t !== 'login' && t !== '1') { plan.skipped['not-a-login']++; continue; }
    }
    const password = cell(r, cols.password);
    if (!password) { plan.skipped['no-password']++; continue; }
    const o = originOf(cell(r, cols.url));
    if ('skip' in o) { plan.skipped[o.skip]++; continue; }
    const base = toEntryName(cell(r, cols.name)) || toEntryName(o.host) || 'login';
    // "github.com" twice (two accounts) → github.com, github.com-2
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, 60)}-${n}`;
    taken.add(name.toLowerCase());
    const entry: VaultEntryInput = { name, origins: [o.origin], secret: password };
    const username = cell(r, cols.username).trim();
    if (username) entry.username = username;
    const seed = cell(r, cols.totp).trim();
    if (seed) {
      try { parseTotpInput(seed); entry.totp = seed; } catch { plan.totpDropped++; }
    }
    plan.entries.push(entry);
    plan.rowOf.push(ri + 1);
  }
  return plan;
}

/** File names of known plaintext password exports (Sentinel blocks the agent from reading them). */
export { EXPORT_FILE_RE, isPasswordExportFile } from './paths.js';
