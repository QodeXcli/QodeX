---
name: artifacts
description: Produce a standalone, versioned deliverable (web page, React/Vue component, SVG, diagram, doc) the user will keep and iterate on. Use the built-in artifact_* tools — NOT write_file — so the artifact is versioned, undoable, and previewable in a real browser. Load whenever the user asks for "an artifact", "a file", "a mockup", "a component", a one-off page, a chart, or anything they'll take away and refine.
version: 0.2.0
author: QodeX
triggers:
  - artifact
  - mockup
  - component
  - standalone html
  - svg
  - chart
  - one-pager
  - preview
slash-aliases:
  - artifact
  - artifacts
allowed-tools:
  - artifact_create
  - artifact_update
  - artifact_list
  - artifact_get
  - artifact_rollback
  - artifact_preview
  - browser_navigate
  - browser_screenshot
  - vision_analyze
  - read_file
---
# Artifacts — Versioned, Previewable Deliverables

When the user wants a standalone deliverable (a web page, a React/Vue component,
an SVG, a chart, a doc) — something they'll keep and refine, not project source
code — use the built-in **artifact tools**. Do NOT hand-write the file with
`write_file` and tell the user to open it. The artifact tools give you
versioning, rollback, undo, and one-step browser preview for free.

## The tools (use these — not write_file)

- **`artifact_create`** `{ title, type, content, note? }` → creates v1, returns an `id`.
  `type` is one of: `html`, `react`, `svg`, `markdown`, `vue`, `text`.
  For a React component, pass the component source as `type: "react"` — you do
  NOT need to write an HTML wrapper, CDN script tags, or a Babel harness. The
  preview builds that for you.
- **`artifact_update`** `{ id, content, note? }` → saves a NEW version (old ones kept).
- **`artifact_preview`** `{ id }` → builds a self-contained preview page, starts a
  local static server, returns a URL. React/Vue render with NO build step.
- **`artifact_list` / `artifact_get` / `artifact_rollback`** → browse / read / revert.

## The standard flow

1. **Create**: call `artifact_create` with the right `type`. For React, the
   `content` is just the component (e.g. a `function Counter() { ... }` plus a
   render call, or a default export) — no boilerplate HTML.
2. **Preview**: call `artifact_preview` with the returned `id`. It returns a URL.
3. **See it**: call `browser_navigate` with that URL, then `browser_screenshot`.
   Optionally `vision_analyze` the screenshot to check it actually looks right.
4. **Iterate**: if something's off, call `artifact_update` with the fixed content
   (a new version), then preview again.

## Type-specific notes

- **react** — write the component source directly. The harness pulls React +
  Babel in-browser, so JSX renders immediately. If you define a top-level
  component, the preview auto-mounts it; or include your own `ReactDOM` render.
- **vue** — single-file component or a root component; rendered via an in-browser
  loader, no bundler.
- **html** — full document or a fragment; rendered as-is.
- **svg** — use `viewBox`, no fixed pixel dims.
- **markdown** — rendered with a markdown renderer in the preview.

## Quality checklist before declaring done

1. You called `artifact_create` (and `artifact_preview` if the user wants to see it) —
   not `write_file`.
2. For visual artifacts, you actually previewed and (ideally) screenshotted it,
   rather than assuming it renders.
3. No baked-in `localhost:` URLs in the artifact source, no secrets/tokens.
4. Reported the artifact `id` so the user can ask for revisions by id.

## What artifacts is NOT for

- Project source files — edit those in place with the normal file tools.
- README / docs that live with the code and get checked into git.
