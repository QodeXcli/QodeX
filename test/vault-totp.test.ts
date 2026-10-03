import { describe, it, expect } from 'vitest';
import { totp, totpFromKey, hotp, base32Decode, base32Encode, parseTotpInput, totpRemainingSeconds } from '../src/vault/totp.js';

// RFC 6238 Appendix B seeds.
const SHA1_KEY = Buffer.from('12345678901234567890');
const SHA256_KEY = Buffer.from('12345678901234567890123456789012');
const SHA512_KEY = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');

describe('RFC 4226 HOTP', () => {
  it('matches the Appendix D vectors', () => {
    const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    want.forEach((code, counter) => expect(hotp(SHA1_KEY, counter)).toBe(code));
  });
});

describe('RFC 6238 TOTP', () => {
  const vectors: Array<[number, string, string, string]> = [
    // time (s), SHA1, SHA256, SHA512 — 8 digits
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [t, s1, s256, s512] of vectors) {
    it(`T=${t}`, () => {
      expect(totpFromKey(SHA1_KEY, { time: t * 1000, digits: 8 })).toBe(s1);
      expect(totpFromKey(SHA256_KEY, { time: t * 1000, digits: 8, algorithm: 'sha256' })).toBe(s256);
      expect(totpFromKey(SHA512_KEY, { time: t * 1000, digits: 8, algorithm: 'sha512' })).toBe(s512);
      expect(totpFromKey(SHA1_KEY, { time: t * 1000 })).toBe(s1.slice(-6));
    });
  }
  it('works from a base32 secret (what authenticator apps store)', () => {
    const b32 = base32Encode(SHA1_KEY);
    expect(b32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totp(b32.toLowerCase().replace(/(.{4})/g, '$1 '), { time: 59_000, digits: 8 })).toBe('94287082');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ====').equals(SHA1_KEY)).toBe(true);
    expect(() => base32Decode('ABC1')).toThrow(/TOTP_INVALID/);
  });
  it('reports seconds left in the window', () => {
    expect(totpRemainingSeconds(30, 59_000)).toBe(1);
    expect(totpRemainingSeconds(30, 60_000)).toBe(30);
  });
});

describe('parseTotpInput', () => {
  it('accepts base32 and otpauth URIs', () => {
    expect(parseTotpInput('jbsw y3dp ehpk 3pxp')).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'sha1' });
    const u = parseTotpInput('otpauth://totp/GitHub:me%40x.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256');
    expect(u).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP', digits: 8, period: 60, algorithm: 'sha256', issuer: 'GitHub', label: 'GitHub:me@x.com' });
  });
  it('rejects bad input', () => {
    expect(() => parseTotpInput('')).toThrow(/TOTP_INVALID/);
    expect(() => parseTotpInput('ABCD')).toThrow(/too short/);
    expect(() => parseTotpInput('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP')).toThrow(/HOTP/);
    expect(() => parseTotpInput('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=4')).toThrow(/digits/);
  });
});
