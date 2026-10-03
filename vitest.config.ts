import { defineConfig } from 'vitest/config';

/**
 * Scope the test runner to QodeX's OWN suite. Without this, vitest globs the entire
 * working tree and tries to run third-party test files that don't belong to QodeX —
 * e.g. a `camofox-browser/` checkout written for Jest, which fails with
 * "describe is not defined" / "Do not import @jest/globals" because those are Jest
 * globals, not vitest's. Those failures are noise, not QodeX bugs.
 *
 * QodeX's tests all live in `test/*.test.ts`, so we point `include` there
 * and exclude sibling projects + build/vendor dirs explicitly as a second guard.
 *
 * NOTE: a handful of files under `test/` are NOT vitest suites — they're standalone
 * Node scripts with their own `check()` harness that end in `process.exit()`, meant to
 * be run directly (e.g. `tsx test/artifact-store.test.ts`, or `npm run test:scripts`).
 * vitest would mis-collect them ("No test suite found" / "process.exit unexpectedly
 * called"), so they're listed in STANDALONE_SCRIPTS and excluded below.
 */
const STANDALONE_SCRIPTS = [
  'test/artifact-preview.test.ts',
  'test/artifact-review.test.ts',
  'test/artifact-store.test.ts',
  'test/completion-gate.test.ts',
  'test/custom-config.test.ts',
  'test/edit-approval.test.ts',
  'test/efficiency-profile.test.ts',
  'test/explain-stream-error.test.ts',
  'test/gateways.test.ts',
  'test/model-resolve.test.ts',
  'test/prompt-tiering.test.ts',
  'test/read-ledger.test.ts',
  'test/security-scan.test.ts',
  'test/syntax-check.test.ts',
  'test/task-addenda.test.ts',
  'test/tool-relevance.test.ts',
  'test/viewport.test.ts',
  'test/visual-gate.test.ts',
  'test/web-backends.test.ts',
];

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Isolate git-spawning tests from the developer's personal ~/.gitconfig
    // (e.g. SSH commit signing). See test/setup-git-env.ts.
    setupFiles: ['./test/setup-git-env.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'camofox-browser/**',
      'vscode-extension/**',
      'services/**',
      'finetune/**',
      ...STANDALONE_SCRIPTS,
    ],
  },
});
