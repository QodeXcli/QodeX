import { describe, it, expect } from 'vitest';
import { parsePhpLint } from '../src/tools/diagnostics/parsers.js';

describe('parsePhpLint', () => {
  it('returns nothing for a clean file', () => {
    expect(parsePhpLint('No syntax errors detected in /path/class-cargo-admin.php')).toEqual([]);
  });

  it('parses a PHP Parse error with file and line', () => {
    const d = parsePhpLint(
      "PHP Parse error:  syntax error, unexpected '}' in /var/www/cargo-managment.php on line 754\n" +
      'Errors parsing /var/www/cargo-managment.php',
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      file: '/var/www/cargo-managment.php',
      line: 754,
      severity: 'error',
      code: 'php-syntax',
    });
    expect(d[0]!.message).toContain('unexpected');
  });

  it('parses the no-"PHP"-prefix variant', () => {
    const d = parsePhpLint('Parse error: syntax error, unexpected end of file in /x/multi-vendor-costs.php on line 399');
    expect(d).toHaveLength(1);
    expect(d[0]!.line).toBe(399);
  });

  it('parses Fatal error too', () => {
    const d = parsePhpLint('PHP Fatal error:  Cannot redeclare foo() in /x/y.php on line 12');
    expect(d).toHaveLength(1);
    expect(d[0]!.line).toBe(12);
  });

  it('ignores noise lines', () => {
    expect(parsePhpLint('some unrelated output\nblah blah')).toEqual([]);
  });
});
