import { mkdtemp, mkdir, symlink, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readBinary } from '../src/re/binary.js';
import { formatReport, inspectPath } from '../src/re/inspect.js';
import { buildSurface, extractStrings, shannon } from '../src/re/surface.js';

function macho64(opts: { dylib: string; uuid: Buffer; encrypted?: boolean }): Buffer {
  const name = Buffer.from(opts.dylib + '\0');
  const dylibSize = 24 + name.length + (8 - ((24 + name.length) % 8)) % 8;
  const uuidSize = 24;
  const encSize = 24;
  const sect = Buffer.alloc(80);
  sect.write('__text', 0);
  sect.writeBigUInt64LE(128n, 40);
  const segSize = 72 + 80;
  const ncmds = 4;
  const sizeofcmds = dylibSize + uuidSize + encSize + segSize;
  const buf = Buffer.alloc(32 + sizeofcmds);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(0x0100000c, 4);
  buf.writeUInt32LE(2, 12);
  buf.writeUInt32LE(ncmds, 16);
  buf.writeUInt32LE(sizeofcmds, 20);
  let p = 32;
  buf.writeUInt32LE(0xc, p);
  buf.writeUInt32LE(dylibSize, p + 4);
  buf.writeUInt32LE(24, p + 8);
  name.copy(buf, p + 24);
  p += dylibSize;
  buf.writeUInt32LE(0x1b, p);
  buf.writeUInt32LE(uuidSize, p + 4);
  opts.uuid.copy(buf, p + 8);
  p += uuidSize;
  buf.writeUInt32LE(0x2c, p);
  buf.writeUInt32LE(encSize, p + 4);
  buf.writeUInt32LE(opts.encrypted ? 1 : 0, p + 16);
  p += encSize;
  buf.writeUInt32LE(0x19, p);
  buf.writeUInt32LE(segSize, p + 4);
  buf.writeUInt32LE(1, p + 64);
  sect.copy(buf, p + 72);
  return buf;
}

function peExe(): Buffer {
  const buf = Buffer.alloc(0x220);
  buf.write('MZ', 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80);
  buf.writeUInt16LE(0x8664, 0x84);
  buf.writeUInt16LE(1, 0x86);
  buf.writeUInt16LE(0xf0, 0x94);
  buf.writeUInt16LE(0x20b, 0x98);
  buf.writeUInt32LE(0x1000, 0xa8);
  buf.writeUInt32LE(2, 0x104);
  buf.writeUInt32LE(0x2000, 0x110);
  const sec = 0x98 + 0xf0;
  buf.write('rdata', sec);
  buf.writeUInt32LE(0x200, sec + 8);
  buf.writeUInt32LE(0x2000, sec + 12);
  buf.writeUInt32LE(0x80, sec + 16);
  buf.writeUInt32LE(0x1c0, sec + 20);
  const desc = 0x1c0;
  buf.writeUInt32LE(0x2010, desc + 12);
  buf.write('KERNEL32.dll\0', 0x1d0);
  return buf;
}

describe('static re', () => {
  it('reads a Mach-O and does not pretend an encrypted image is open', () => {
    const uuid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const bin = readBinary(macho64({ dylib: '/usr/lib/libSystem.B.dylib', uuid, encrypted: true }));
    expect(bin.format).toBe('mach-o');
    expect(bin.slices[0]?.arch).toBe('arm64');
    expect(bin.slices[0]?.dylibs).toEqual(['/usr/lib/libSystem.B.dylib']);
    expect(bin.slices[0]?.uuids[0]).toBe('00112233445566778899aabbccddeeff');
    expect(bin.slices[0]?.encrypted).toBe(true);
    expect(bin.slices[0]?.sections[0]?.name).toBe('__text');
    expect(bin.slices[0]?.sections[0]?.size).toBe(128);
    expect(formatReport({ path: 'a', format: bin.format, binary: bin, notes: [], limits: ['not a decompiler'] })).toContain('not decrypted');
  });

  it('reads PE imports and does not call a Java class a Mach-O', () => {
    const pe = readBinary(peExe());
    expect(pe.format).toBe('pe');
    expect(pe.slices[0]?.arch).toBe('x86_64');
    expect(pe.slices[0]?.imports).toEqual(['KERNEL32.dll']);
    const java = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x37]);
    expect(readBinary(java).format).toBe('java-class');
  });

  it('reads an app bundle and refuses a plist that leaves it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qodex-re-'));
    const app = path.join(dir, 'Demo.app');
    await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleIdentifier</key><string>com.demo.app</string>
<key>CFBundleExecutable</key><string>Demo</string>
<key>CFBundleShortVersionString</key><string>1.4</string>
</dict></plist>`);
    const exe = macho64({ dylib: '/usr/lib/libobjc.A.dylib', uuid: Buffer.alloc(16, 7) });
    await writeFile(path.join(app, 'Contents', 'MacOS', 'Demo'), exe);
    const report = await inspectPath(app);
    expect(report.format).toBe('app-bundle');
    expect(report.bundle?.id).toBe('com.demo.app');
    expect(report.binary?.slices[0]?.dylibs).toEqual(['/usr/lib/libobjc.A.dylib']);

    const evil = path.join(dir, 'Evil.app');
    await mkdir(path.join(evil, 'Contents'), { recursive: true });
    await symlink(path.join(dir, 'secret.txt'), path.join(evil, 'Contents', 'Info.plist'));
    await writeFile(path.join(dir, 'secret.txt'), '<key>CFBundleIdentifier</key><string>stolen</string>');
    const refused = await inspectPath(evil);
    expect(refused.bundle?.id).toBeUndefined();
    expect(refused.notes.join(' ')).toContain('left the bundle');
    await rm(dir, { recursive: true, force: true });
  });

  it('builds a dependency list, entropy, and capped strings without secrets', () => {
    expect(shannon(Buffer.alloc(32))).toBe(0);
    const body = Buffer.concat([
      Buffer.from('https://example.com/app\0'),
      Buffer.from('hello_symbol\0'),
      Buffer.from('-----BEGIN PRIVATE KEY-----\nMII\0'),
    ]);
    const got = extractStrings(body);
    expect(got.strings.map(s => s.text)).toEqual(['https://example.com/app', 'hello_symbol']);
    expect(got.strings[0]?.kind).toBe('url');
    expect(got.omittedSecrets).toBe(1);
    const bin = readBinary(macho64({ dylib: '/usr/lib/libSystem.B.dylib', uuid: Buffer.alloc(16, 1) }));
    const surface = buildSurface('Demo', Buffer.concat([macho64({ dylib: '/usr/lib/libSystem.B.dylib', uuid: Buffer.alloc(16, 1) }), body]), bin);
    expect(surface.edges).toEqual([{ from: 'Demo', to: '/usr/lib/libSystem.B.dylib' }]);
    expect(surface.strings.some(s => s.text.includes('PRIVATE'))).toBe(false);
  });
});
