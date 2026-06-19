import { defineConfig } from 'vitest/config';

/**
 * Scope the test runner to QodeX's OWN suite. Without this, vitest globs the entire
 * working tree and tries to run third-party test files that don't belong to QodeX —
 * e.g. a `camofox-browser/` checkout written for Jest, which fails with
 * "describe is not defined" / "Do not import @jest/globals" because those are Jest
 * globals, not vitest's. Those failures are noise, not QodeX bugs.
 *
 * QodeX's tests all live in `test/*.test.ts` (82 files), so we point `include` there
 * and exclude sibling projects + build/vendor dirs explicitly as a second guard.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'camofox-browser/**',
      'vscode-extension/**',
      'services/**',
      'finetune/**',
    ],
  },
});
