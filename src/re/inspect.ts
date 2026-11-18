/**
 * Point this at an executable or a Mac .app. It reads that file.
 * It does not walk a disk looking for programs, and it does not follow a
 * symlink out of the bundle.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { readBinary, type BinRead } from './binary.js';

const CAP = 48 * 1024 * 1024;

export interface AppBundle {
  id?: string;
  name?: string;
  version?: string;
  executable?: string;
  minOs?: string;
}

export interface ReReport {
  path: string;
  format: BinRead['format'] | 'app-bundle';
  bundle?: AppBundle;
  binary?: BinRead;
  notes: string[];
  limits: string[];
}

const LIMITS = [
  'This is a header read, not a decompiler and not a disassembler.',
  'A signature blob is not a notarization check.',
  'An encrypted image is reported. It is not decrypted.',
  'A license check is not patched.',
];

function plistString(xml: string, key: string): string | undefined {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  const m = xml.match(re);
  return m?.[1]?.trim() || undefined;
}

async function readCapped(file: string, notes: string[]): Promise<Buffer> {
  const st = await fs.stat(file);
  const fh = await fs.open(file, 'r');
  try {
    const n = Math.min(st.size, CAP);
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, 0);
    if (st.size > CAP) notes.push(`read the first ${CAP} bytes of ${st.size}; the rest was not loaded`);
    return buf;
  } finally {
    await fh.close();
  }
}

function inside(root: string, target: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target === root || target.startsWith(prefix);
}

export async function inspectPath(file: string): Promise<ReReport> {
  const notes: string[] = [];
  const resolved = path.resolve(file);
  let st;
  try { st = await fs.stat(resolved); }
  catch (e: any) { return { path: resolved, format: 'unknown', notes: [e?.code === 'ENOENT' ? 'file not found' : (e?.message ?? 'unreadable')], limits: LIMITS }; }
  if (st.isDirectory()) {
    if (!resolved.toLowerCase().endsWith('.app')) {
      return { path: resolved, format: 'unknown', notes: ['a directory is not an executable. Point at a file, or at a .app bundle.'], limits: LIMITS };
    }
    return inspectBundle(resolved, notes);
  }
  const buf = await readCapped(resolved, notes);
  const binary = readBinary(buf);
  return { path: resolved, format: binary.format, binary, notes, limits: LIMITS };
}

async function inspectBundle(root: string, notes: string[]): Promise<ReReport> {
  const realRoot = await fs.realpath(root);
  const plistPath = path.join(realRoot, 'Contents', 'Info.plist');
  let bundle: AppBundle = {};
  try {
    const realPlist = await fs.realpath(plistPath);
    if (!inside(realRoot, realPlist)) notes.push('Info.plist left the bundle and was not read');
    else {
      const text = await fs.readFile(realPlist, 'utf8');
      if (text.startsWith('bplist')) notes.push('Info.plist is binary and was not decoded');
      else {
        bundle = {
          id: plistString(text, 'CFBundleIdentifier'),
          name: plistString(text, 'CFBundleName') ?? plistString(text, 'CFBundleDisplayName'),
          version: plistString(text, 'CFBundleShortVersionString'),
          executable: plistString(text, 'CFBundleExecutable'),
          minOs: plistString(text, 'LSMinimumSystemVersion'),
        };
      }
    }
  } catch {
    notes.push('Contents/Info.plist was not readable');
  }
  let binary: BinRead | undefined;
  if (bundle.executable && !bundle.executable.includes('/') && !bundle.executable.includes('..')) {
    const exe = path.join(realRoot, 'Contents', 'MacOS', bundle.executable);
    try {
      const realExe = await fs.realpath(exe);
      if (!inside(realRoot, realExe)) notes.push('the executable left the bundle and was not read');
      else {
        const buf = await readCapped(realExe, notes);
        binary = readBinary(buf);
      }
    } catch {
      notes.push('Contents/MacOS executable was not readable');
    }
  } else if (!bundle.executable) {
    notes.push('no CFBundleExecutable, so the inner binary was not opened');
  }
  return { path: realRoot, format: 'app-bundle', bundle, binary, notes, limits: LIMITS };
}

export function formatReport(report: ReReport): string {
  const lines: string[] = ['QodeX re — static read, not a decompiler', `path: ${report.path}`, `format: ${report.format}`];
  if (report.bundle) {
    const b = report.bundle;
    lines.push(`bundle: ${b.id ?? '—'}  ${b.name ?? ''}  ${b.version ?? ''}  min ${b.minOs ?? '—'}`.trim());
    if (b.executable) lines.push(`executable: ${b.executable}`);
  }
  const bin = report.binary;
  if (bin) {
    if (report.format !== 'app-bundle') lines[2] = `format: ${bin.format}`;
    else lines.push(`inner: ${bin.format}`);
    for (const s of bin.slices) {
      lines.push(`image: ${s.arch} ${s.bits}-bit ${s.endian} ${s.kind}${s.minOs ? '  ' + s.minOs : ''}`);
      if (s.entry) lines.push(`  entry: ${s.entry}`);
      if (s.uuids.length) lines.push(`  uuid: ${s.uuids.join(', ')}`);
      lines.push(`  encrypted: ${s.encrypted ? 'yes — not decrypted' : 'no'}`);
      lines.push(`  signature blob: ${s.signatureBlob ? 'present, not verified' : 'none in the header'}`);
      if (s.dylibs.length) lines.push('  linked:', ...s.dylibs.slice(0, 80).map(d => `    ${d}`));
      if (s.imports.length) lines.push('  imports:', ...s.imports.slice(0, 80).map(d => `    ${d}`));
      if (s.rpaths.length) lines.push('  rpath:', ...s.rpaths.map(d => `    ${d}`));
      if (s.sections.length) lines.push('  sections: ' + s.sections.slice(0, 24).map(sec => `${sec.name} ${sec.size}`).join(', '));
    }
    for (const n of bin.notes) lines.push(`note: ${n}`);
  }
  for (const n of report.notes) lines.push(`note: ${n}`);
  lines.push('limits:', ...report.limits.map(l => `  - ${l}`));
  return lines.join('\n');
}
