/**
 * Static read of a Mach-O, PE, or ELF image.
 * Headers and names only. No disassembly, no decryption, no patch.
 */

export interface BinSection { name: string; size: number; fileOff?: number; fileSize?: number; }
export interface BinSlice {
  arch: string;
  bits: 32 | 64;
  kind: string;
  endian: 'le' | 'be';
  entry?: string;
  uuids: string[];
  dylibs: string[];
  rpaths: string[];
  sections: BinSection[];
  imports: string[];
  encrypted: boolean;
  signatureBlob: boolean;
  minOs?: string;
}

export interface BinRead {
  format: 'mach-o' | 'mach-o-fat' | 'pe' | 'elf' | 'java-class' | 'unknown';
  slices: BinSlice[];
  notes: string[];
}

const CPU: Record<number, string> = {
  0x7: 'i386',
  0x01000007: 'x86_64',
  0xc: 'arm',
  0x0100000c: 'arm64',
  0x12: 'ppc',
  0x01000012: 'ppc64',
};

const MACHO_KIND: Record<number, string> = {
  1: 'object', 2: 'execute', 6: 'dylib', 8: 'bundle', 9: 'dsym',
};

const PE_MACHINE: Record<number, string> = {
  0x14c: 'i386', 0x8664: 'x86_64', 0xaa64: 'arm64', 0x1c0: 'arm',
};

function u16(b: Buffer, o: number, le: boolean): number {
  if (o < 0 || o + 2 > b.length) return 0;
  return le ? b.readUInt16LE(o) : b.readUInt16BE(o);
}
function u32(b: Buffer, o: number, le: boolean): number {
  if (o < 0 || o + 4 > b.length) return 0;
  return le ? b.readUInt32LE(o) : b.readUInt32BE(o);
}
function u64(b: Buffer, o: number, le: boolean): bigint {
  if (o < 0 || o + 8 > b.length) return 0n;
  return le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o);
}

function cstr(b: Buffer, off: number, max = 240): string | null {
  if (off < 0 || off >= b.length) return null;
  const lim = Math.min(b.length, off + max);
  let end = off;
  while (end < lim && b[end] !== 0) end++;
  return b.toString('utf8', off, end).replace(/[^\t\x20-\x7e]/g, '?');
}

function emptySlice(arch: string, bits: 32 | 64, endian: 'le' | 'be', kind: string): BinSlice {
  return { arch, bits, kind, endian, uuids: [], dylibs: [], rpaths: [], sections: [], imports: [], encrypted: false, signatureBlob: false };
}

function machoMagic(b: Buffer, o: number): { bits: 32 | 64; endian: 'le' | 'be' } | null {
  if (o + 4 > b.length) return null;
  const m = b.readUInt32LE(o);
  if (m === 0xfeedface) return { bits: 32, endian: 'le' };
  if (m === 0xfeedfacf) return { bits: 64, endian: 'le' };
  if (m === 0xcefaedfe) return { bits: 32, endian: 'be' };
  if (m === 0xcffaedfe) return { bits: 64, endian: 'be' };
  return null;
}

function parseMacho(b: Buffer, base: number, notes: string[]): BinSlice | null {
  const mag = machoMagic(b, base);
  if (!mag) return null;
  const le = mag.endian === 'le';
  const header = mag.bits === 64 ? 32 : 28;
  if (base + header > b.length) { notes.push('mach-o header is truncated'); return null; }
  const cpu = u32(b, base + 4, le);
  const filetype = u32(b, base + 12, le);
  const ncmds = u32(b, base + 16, le);
  const slice = emptySlice(CPU[cpu] ?? `cpu:${cpu.toString(16)}`, mag.bits, mag.endian, MACHO_KIND[filetype] ?? `filetype:${filetype}`);
  let p = base + header;
  const limit = Math.min(ncmds, 512);
  if (ncmds > 512) notes.push('load-command count was capped at 512');
  for (let i = 0; i < limit; i++) {
    if (p + 8 > b.length) { notes.push('load commands ended early'); break; }
    const cmd = u32(b, p, le);
    const size = u32(b, p + 4, le);
    if (size < 8 || p + size > b.length) { notes.push('a load command ran past the buffer'); break; }
    if (cmd === 0xc || cmd === 0xd || cmd === 0x80000018 || cmd === 0x8000001f || cmd === 0x80000035 || cmd === 0x20) {
      const name = cstr(b, p + u32(b, p + 8, le));
      if (name) slice.dylibs.push(name);
    } else if (cmd === 0x8000001c) {
      const path = cstr(b, p + u32(b, p + 8, le));
      if (path) slice.rpaths.push(path);
    } else if (cmd === 0x1b && size >= 24) {
      slice.uuids.push([...b.subarray(p + 8, p + 24)].map(x => x.toString(16).padStart(2, '0')).join(''));
    } else if (cmd === 0x80000028 && size >= 16) {
      slice.entry = '0x' + u64(b, p + 8, le).toString(16);
    } else if (cmd === 0x1d) {
      slice.signatureBlob = true;
    } else if ((cmd === 0x21 || cmd === 0x2c) && size >= 20) {
      if (u32(b, p + 16, le) !== 0) slice.encrypted = true;
    } else if (cmd === 0x32 && size >= 24) {
      const plat = u32(b, p + 8, le);
      const min = u32(b, p + 12, le);
      const names: Record<number, string> = { 1: 'macos', 2: 'ios', 3: 'tvos', 4: 'watchos' };
      slice.minOs = `${names[plat] ?? 'platform:' + plat} ${(min >> 16) & 0xffff}.${(min >> 8) & 0xff}.${min & 0xff}`;
    } else if (cmd === 0x19 || cmd === 0x1) {
      const sectOff = cmd === 0x19 ? 64 : 48;
      const sectSize = cmd === 0x19 ? 80 : 68;
      const nsects = u32(b, p + sectOff, le);
      let s = p + (cmd === 0x19 ? 72 : 56);
      for (let n = 0; n < Math.min(nsects, 64) && s + 16 <= p + size; n++) {
        const name = cstr(b, s, 16) ?? '';
        const sz = cmd === 0x19 ? Number(u64(b, s + 40, le)) : u32(b, s + 36, le);
        const fileOff = cmd === 0x19 ? u32(b, s + 48, le) : u32(b, s + 40, le);
        if (name) slice.sections.push({ name, size: sz, fileOff, fileSize: sz });
        s += sectSize;
      }
    }
    p += size;
  }
  return slice;
}

function parseFat(b: Buffer, notes: string[]): BinRead | null {
  if (b.length < 8 || b.readUInt32BE(0) !== 0xcafebabe) return null;
  const n = b.readUInt32BE(4);
  if (n < 1 || n > 16) return null;
  const slices: BinSlice[] = [];
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 20;
    if (o + 20 > b.length) { notes.push('fat header is truncated'); break; }
    const offset = b.readUInt32BE(o + 8);
    const size = b.readUInt32BE(o + 12);
    if (!machoMagic(b, offset)) return null;
    const end = Math.min(b.length, offset + size);
    const slice = parseMacho(b.subarray(offset, end), 0, notes);
    if (slice) slices.push(slice);
  }
  if (!slices.length) return null;
  return { format: 'mach-o-fat', slices, notes };
}

function parsePe(b: Buffer, notes: string[]): BinRead | null {
  if (b.length < 0x40 || b.readUInt16LE(0) !== 0x5a4d) return null;
  const lfanew = b.readUInt32LE(0x3c);
  if (lfanew <= 0 || lfanew + 24 > b.length) return null;
  if (b.toString('ascii', lfanew, lfanew + 4) !== 'PE\0\0') return null;
  const coff = lfanew + 4;
  const machine = b.readUInt16LE(coff);
  const nsec = b.readUInt16LE(coff + 2);
  const optSize = b.readUInt16LE(coff + 16);
  const chars = b.readUInt16LE(coff + 18);
  const opt = coff + 20;
  if (opt + 2 > b.length) { notes.push('PE optional header is truncated'); return null; }
  const magic = b.readUInt16LE(opt);
  const bits: 32 | 64 = magic === 0x20b ? 64 : 32;
  const slice = emptySlice(PE_MACHINE[machine] ?? `machine:${machine.toString(16)}`, bits, 'le', chars & 0x2000 ? 'dll' : 'execute');
  if (opt + 20 <= b.length) slice.entry = '0x' + b.readUInt32LE(opt + 16).toString(16);
  const sections: { name: string; va: number; virtualSize: number; raw: number; rawSize: number }[] = [];
  let sp = opt + optSize;
  for (let i = 0; i < Math.min(nsec, 96); i++) {
    if (sp + 40 > b.length) { notes.push('PE section table is truncated'); break; }
    const name = cstr(b, sp, 8) ?? '';
    const virtualSize = b.readUInt32LE(sp + 8);
    const va = b.readUInt32LE(sp + 12);
    const rawSize = b.readUInt32LE(sp + 16);
    const raw = b.readUInt32LE(sp + 20);
    sections.push({ name, va, virtualSize, raw, rawSize });
    if (name) slice.sections.push({ name, size: virtualSize, fileOff: raw, fileSize: rawSize });
    sp += 40;
  }
  const rvaToOff = (rva: number): number | null => {
    for (const s of sections) {
      const span = Math.max(s.virtualSize, s.rawSize);
      if (span > 0 && rva >= s.va && rva < s.va + span) return s.raw + (rva - s.va);
    }
    return null;
  };
  const dirBase = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
  const nDir = dirBase > 0 && dirBase >= opt && dirBase + 4 <= b.length ? b.readUInt32LE(dirBase - 4) : 0;
  if (nDir > 1 && dirBase + 16 <= b.length) {
    const importRva = b.readUInt32LE(dirBase + 8);
    const off = importRva ? rvaToOff(importRva) : null;
    if (importRva && off == null) notes.push('PE import directory is outside the sections that were read');
    if (off != null) {
      for (let i = 0; i < 64; i++) {
        const d = off + i * 20;
        if (d + 20 > b.length) break;
        if (b.readUInt32LE(d) === 0 && b.readUInt32LE(d + 12) === 0 && b.readUInt32LE(d + 16) === 0) break;
        const nameOff = rvaToOff(b.readUInt32LE(d + 12));
        const dll = nameOff == null ? null : cstr(b, nameOff);
        if (dll) slice.imports.push(dll);
      }
    }
  }
  return { format: 'pe', slices: [slice], notes };
}

function parseElf(b: Buffer, notes: string[]): BinRead | null {
  if (b.length < 64 || b[0] !== 0x7f || b.toString('ascii', 1, 4) !== 'ELF') return null;
  const bits: 32 | 64 = b[4] === 2 ? 64 : 32;
  const le = b[5] !== 2;
  const type = u16(b, 16, le);
  const machine = u16(b, 18, le);
  const machines: Record<number, string> = { 3: 'i386', 62: 'x86_64', 183: 'arm64', 40: 'arm' };
  const kinds: Record<number, string> = { 1: 'relocatable', 2: 'execute', 3: 'dylib' };
  const slice = emptySlice(machines[machine] ?? `machine:${machine}`, bits, le ? 'le' : 'be', kinds[type] ?? `type:${type}`);
  if (bits !== 64) { notes.push('ELF32 is recognized; linked libraries are read from ELF64 only'); return { format: 'elf', slices: [slice], notes }; }
  const shoff = Number(u64(b, 40, le));
  const shentsize = u16(b, 58, le);
  const shnum = u16(b, 60, le);
  const shstrndx = u16(b, 62, le);
  if (shentsize < 64 || shoff <= 0) return { format: 'elf', slices: [slice], notes };
  const nameOf = (idx: number): string => {
    if (shstrndx >= shnum) return '';
    const stroff = Number(u64(b, shoff + shstrndx * shentsize + 24, le));
    return cstr(b, stroff + idx, 32) ?? '';
  };
  for (let i = 0; i < Math.min(shnum, 128); i++) {
    const sh = shoff + i * shentsize;
    if (sh + 64 > b.length) { notes.push('ELF section headers are truncated'); break; }
    const name = nameOf(u32(b, sh, le));
    const size = Number(u64(b, sh + 32, le));
    const fileOff = Number(u64(b, sh + 24, le));
    if (name) slice.sections.push({ name, size, fileOff, fileSize: size });
    if (u32(b, sh + 4, le) !== 6) continue;
    const link = u32(b, sh + 40, le);
    const dynOff = Number(u64(b, sh + 24, le));
    const dynSize = size;
    if (link >= shnum) continue;
    const strOff = Number(u64(b, shoff + link * shentsize + 24, le));
    for (let d = 0; d + 16 <= dynSize && dynOff + d + 16 <= b.length; d += 16) {
      const tag = u64(b, dynOff + d, le);
      if (tag === 0n) break;
      if (tag === 1n) {
        const lib = cstr(b, strOff + Number(u64(b, dynOff + d + 8, le)));
        if (lib) slice.dylibs.push(lib);
      }
    }
  }
  return { format: 'elf', slices: [slice], notes };
}

export function readBinary(buf: Buffer): BinRead {
  const notes: string[] = [];
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xcafebabe) {
    const fat = parseFat(buf, notes);
    if (fat) return fat;
    const major = buf.length >= 8 ? buf.readUInt16BE(6) : 0;
    if (major >= 45 && major <= 70) return { format: 'java-class', slices: [], notes: ['Java class files share the CAFEBABE magic. This is not a Mach-O fat binary.'] };
  }
  const macho = parseMacho(buf, 0, notes);
  if (macho) return { format: 'mach-o', slices: [macho], notes };
  const pe = parsePe(buf, notes);
  if (pe) return pe;
  const elf = parseElf(buf, notes);
  if (elf) return elf;
  return { format: 'unknown', slices: [], notes: notes.length ? notes : ['no Mach-O, PE, or ELF header'] };
}
