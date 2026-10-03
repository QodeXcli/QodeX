# Contributing to QodeX

Thanks for helping improve QodeX! This guide gets you from clone to merged PR.

## Prerequisites

- **Node 20+** (Node 22 LTS recommended; CI runs on 22).
- **Git**.
- Optional: `playwright` + `npx playwright install chromium` for the `browser_*` tools.

> QodeX uses the native `better-sqlite3` module (code-graph + sessions). If it fails to
> build on your platform, install your OS build tools — see the **Install** section of the
> [README](README.md#install) (Windows users: build tools or WSL2).

## Set up

```bash
git clone https://github.com/QodeXcli/QodeX.git qodex && cd qodex
npm ci            # lockfile-exact install (use `npm install` if you're changing deps)
npm run build     # dist/ is NOT committed — building is required
```

## The dev loop

QodeX is **TypeScript + ESM**. Source lives in `src/`, tests in `test/`.

```bash
npm run typecheck   # tsc --noEmit — must be clean
npm test            # vitest run — the full suite
npm run build       # tsc over the project — catches bad imports / type errors
```

- Tests are `test/*.test.ts`. Add one next to the behaviour you change — pure logic should
  be unit-tested; prefer a small deterministic test over a broad integration one.
- A few legacy suites are standalone `process.exit` scripts (run with
  `node --experimental-strip-types test/<name>.test.ts`); they're excluded from `vitest`.

## Submitting a change

1. Branch off `main` (`git switch -c feat/your-thing main`).
2. Keep the change focused; match the surrounding code's style and comment density.
3. **Green before you push:** `npm run typecheck && npm test && npm run build`.
4. Open a PR against `main`. CI (build + typecheck + test) must pass.
5. Write a clear PR description: what changed, why, and how you verified it.

## Design philosophy (so your change fits)

QodeX's edge is **deterministic guardrails around the model**, not just prompting — a syntax
gate, completion gate, per-language auto-verification, and a git-backed sandbox so even a
weak local model can't ship broken or unverified code. When adding a capability, prefer a
**pure, testable core** with a thin I/O wrapper, and gate anything risky behind config
(off by default). New model-facing tools should be relevance-gated so they don't bloat the
prompt.

### Extending the self-improvement loop

The `maintain` recipe is how QodeX improves a codebase unattended without ever shipping an
unverified change. To add a new cleanup **scope** (or just to understand how it stays safe),
read **[docs/MAINTAIN.md](docs/MAINTAIN.md)** — it covers the verified-PR protocol, the existing
scopes, and a step-by-step guide to adding one.

## Reporting bugs

Open an issue at https://github.com/QodeXcli/QodeX/issues with the QodeX version
(`qodex --version`), your OS + Node version, and the relevant lines from `~/.qodex/qodex.log`.

By contributing you agree your contributions are licensed under the project's
[Apache-2.0 license](LICENSE).
