/**
 * Pure EAN-13 barcode encoder — no I/O, no SVG, fully unit-testable.
 *
 * Produces the 95-module bit pattern (1 = bar, 0 = space) for a 12- or 13-digit
 * code. The SVG renderer turns this into rectangles at the right physical width.
 *
 * Structure (95 modules): start(101) + 6 left digits (7 each) + center(01010)
 *   + 6 right digits (7 each) + end(101). The FIRST digit isn't drawn as bars;
 *   it selects the L/G parity pattern of the left group.
 */

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
// Parity pattern of the 6 left digits, keyed by the first digit (L=odd, G=even).
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** EAN-13 check digit for a 12-digit numeric string. */
export function ean13CheckDigit(twelve: string): number {
  if (!/^\d{12}$/.test(twelve)) throw new Error('ean13CheckDigit expects exactly 12 digits');
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = twelve.charCodeAt(i) - 48;
    sum += (i % 2 === 0) ? d : d * 3; // positions 1,3,.. (0-indexed even) ×1; 2,4,.. ×3
  }
  return (10 - (sum % 10)) % 10;
}

/** Normalize input to a valid 13-digit code: accepts 12 (computes check) or 13 (validates). */
export function normalizeEan13(code: string): { digits: string; checkOk: boolean } {
  const clean = code.replace(/\s|-/g, '');
  if (/^\d{12}$/.test(clean)) {
    const c = ean13CheckDigit(clean);
    return { digits: clean + c, checkOk: true };
  }
  if (/^\d{13}$/.test(clean)) {
    const expected = ean13CheckDigit(clean.slice(0, 12));
    return { digits: clean, checkOk: expected === (clean.charCodeAt(12) - 48) };
  }
  throw new Error(`EAN-13 needs 12 or 13 digits (got ${clean.length})`);
}

/** Return the 95-char module string (1=bar, 0=space) for a 12/13-digit code. */
export function ean13Modules(code: string): { digits: string; modules: string; checkOk: boolean } {
  const { digits, checkOk } = normalizeEan13(code);
  const first = digits.charCodeAt(0) - 48;
  const leftDigits = digits.slice(1, 7);
  const rightDigits = digits.slice(7, 13);
  const parity = PARITY[first]!;

  let out = '101'; // start guard
  for (let i = 0; i < 6; i++) {
    const d = leftDigits.charCodeAt(i) - 48;
    out += parity[i] === 'L' ? L[d]! : G[d]!;
  }
  out += '01010'; // center guard
  for (let i = 0; i < 6; i++) {
    const d = rightDigits.charCodeAt(i) - 48;
    out += R[d]!;
  }
  out += '101'; // end guard
  return { digits, modules: out, checkOk };
}
