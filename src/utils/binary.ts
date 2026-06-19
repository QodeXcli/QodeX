/**
 * Heuristically detect whether a buffer is binary content.
 * Used to refuse read/write of binary files (images, executables, sqlite DBs, etc.)
 * which would otherwise be corrupted by utf-8 round-tripping.
 */
/**
 * Well-known binary file signatures (magic numbers). These headers contain no
 * null byte and few control bytes, so the heuristics below miss them — e.g. the
 * PNG signature 0x89 'PNG' ... The lone 0x89 looks like a utf-8 lead byte, so
 * match the magic explicitly.
 */
const BINARY_MAGIC: number[][] = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
  [0xff, 0xd8, 0xff],                               // JPEG
  [0x47, 0x49, 0x46, 0x38],                         // GIF8
  [0x25, 0x50, 0x44, 0x46],                         // %PDF
  [0x50, 0x4b, 0x03, 0x04],                         // ZIP / docx / jar
  [0x50, 0x4b, 0x05, 0x06],                         // empty ZIP
  [0x7f, 0x45, 0x4c, 0x46],                         // ELF
  [0x1f, 0x8b],                                     // gzip
  [0x42, 0x5a, 0x68],                               // bzip2 (BZh)
  [0x52, 0x61, 0x72, 0x21],                         // RAR (Rar!)
  [0x00, 0x61, 0x73, 0x6d],                         // WASM (\0asm)
];

function hasBinaryMagic(buf: Buffer): boolean {
  for (const sig of BINARY_MAGIC) {
    if (buf.length < sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buf[i] !== sig[i]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

export function isBinaryBuffer(buf: Buffer, sampleSize = 8000): boolean {
  if (buf.length === 0) return false;

  // Fast path: known binary signatures that the byte heuristics would miss.
  if (hasBinaryMagic(buf)) return true;

  const sample = buf.subarray(0, Math.min(sampleSize, buf.length));

  // Heuristic 1: any null byte in the first sample → binary
  // (Valid utf-8 text files do not contain null bytes.)
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0x00) return true;
  }

  // Heuristic 2: high proportion of control / non-printable bytes
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!;
    // Tab(9), LF(10), CR(13) are printable; everything 0..31 except those is suspect.
    // 0x7F (DEL) is also suspect. 0x80+ is fine (utf-8 multi-byte).
    if ((b < 0x09) || (b > 0x0d && b < 0x20) || b === 0x7f) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.3;
}

/** Quick check by extension for common binary file types. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac', '.ogg',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.sqlite', '.db', '.mdb',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.wasm', '.class', '.jar', '.pyc', '.pyo',
]);

export function hasBinaryExtension(filePath: string): boolean {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  return BINARY_EXTENSIONS.has(ext);
}
