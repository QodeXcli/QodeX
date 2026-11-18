/**
 * What the header does not say by itself: printable strings, section entropy,
 * and a dependency list. Still no disassembly and no decryption.
 */
import type { BinRead, BinSection } from './binary.js';

export interface SurfaceString { kind: 'url' | 'path' | 'text'; text: string; }
export interface SectionEntropy { name: string; entropy: number | null; bytes: number; }
export interface DepEdge { from: string; to: string; }

export interface Surface {
  strings: SurfaceString[];
  omittedSecrets: number;
  entropy: SectionEntropy[];
  edges: DepEdge[];
}

const STR_CAP = 200;
const STR_MIN = 6;

function looksSecret(s: string): boolean {
  return /BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(s) || /AKIA[0-9A-Z]{16}/.test(s);
}

export function shannon(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (const byte of buf) counts[byte] = (counts[byte] ?? 0) + 1;
  let h = 0;
  for (const c of counts) {
    if (!c) continue;
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 100) / 100;
}

export function extractStrings(buf: Buffer): { strings: SurfaceString[]; omittedSecrets: number } {
  const strings: SurfaceString[] = [];
  let omittedSecrets = 0;
  let run = '';
  const flush = () => {
    if (run.length >= STR_MIN) {
      if (looksSecret(run)) omittedSecrets++;
      else if (strings.length < STR_CAP) {
        const kind = /^https?:\/\//.test(run) ? 'url' : (run.startsWith('/') || run.includes('\\') || /\.(dylib|dll|so)$/.test(run) ? 'path' : 'text');
        strings.push({ kind, text: run });
      }
    }
    run = '';
  };
  for (const byte of buf) {
    if (byte >= 0x20 && byte <= 0x7e) run += String.fromCharCode(byte);
    else flush();
  }
  flush();
  return { strings, omittedSecrets };
}

export function sectionEntropy(buf: Buffer, sections: BinSection[]): SectionEntropy[] {
  const out: SectionEntropy[] = [];
  for (const sec of sections.slice(0, 32)) {
    if (sec.fileOff == null || sec.fileSize == null || sec.fileSize <= 0) {
      out.push({ name: sec.name, entropy: null, bytes: 0 });
      continue;
    }
    const end = sec.fileOff + sec.fileSize;
    if (sec.fileOff < 0 || end > buf.length) {
      out.push({ name: sec.name, entropy: null, bytes: 0 });
      continue;
    }
    const slice = buf.subarray(sec.fileOff, end);
    out.push({ name: sec.name, entropy: shannon(slice), bytes: slice.length });
  }
  return out;
}

export function dependencyEdges(root: string, bin: BinRead): DepEdge[] {
  const edges: DepEdge[] = [];
  const seen = new Set<string>();
  for (const slice of bin.slices) {
    for (const lib of [...slice.dylibs, ...slice.imports]) {
      const key = `${root} ${lib}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: root, to: lib });
    }
  }
  return edges;
}

export function buildSurface(root: string, buf: Buffer, bin: BinRead): Surface {
  const { strings, omittedSecrets } = extractStrings(buf);
  const sections = bin.format === 'mach-o-fat' ? [] : bin.slices.flatMap(s => s.sections);
  return {
    strings,
    omittedSecrets,
    entropy: sectionEntropy(buf, sections),
    edges: dependencyEdges(root, bin),
  };
}
