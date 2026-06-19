---
name: taste
description: Apply opinionated modern visual taste — fluid type, generous whitespace, OKLCH palette, no Tailwind cliches. Load whenever the user asks for landing pages, marketing sites, hero sections, dashboards, or "make this look good".
version: 0.1.0
author: QodeX
triggers:
  - frontend
  - landing
  - hero
  - design
  - ui
  - css
  - tailwind
  - زیبا
  - طراحی
  - فرانت
slash-aliases:
  - taste
allowed-tools:
  - read_file
  - write_file
  - edit_text
  - edit_symbol
  - multi_edit
  - multi_file_edit
  - ls
  - glob
  - grep
  - bash
  - detect_frontend_stack
  - analyze_design_system
  - find_ui_components
  - design_audit
files:
  - palette.md
  - typography.md
---
# Taste — Opinionated Design Playbook

The user wants the page/component to FEEL premium. Follow these rules unless they
explicitly override one.

## Layout
- **8px grid.** Spacing is `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 / 128`. Don't use `13px`, `27px`, etc.
- **Container.** `max-width: 1200px` for content sites, `1440px` for dashboards, `680px` for long-form text. Center with `margin-inline: auto; padding-inline: clamp(16px, 4vw, 32px)`.
- **Vertical rhythm.** Section padding `padding-block: clamp(64px, 12vw, 160px)`. Never `py-12` everywhere — it's flat.
- **Asymmetry.** Hero rows are 7-of-12 left / 5-of-12 right (or 60/40) — NEVER 50/50. Symmetry reads as a placeholder.

## Typography
See `typography.md` for the full table. Default stack:
- Display: **Geist**, **Inter Display**, or **General Sans** (700/600)
- UI: **Geist Sans** or **Inter** (400/500)
- Mono: **Geist Mono** or **JetBrains Mono**
- Sizes: `clamp()` everything. Hero `clamp(2.5rem, 6vw, 5.5rem)`, body `clamp(1rem, 1.1vw, 1.125rem)`.
- Tracking: tighten display headings (`letter-spacing: -0.02em`). Body stays at `0`.
- Leading: headings `1.05–1.1`, body `1.6–1.7`, UI `1.4`.

## Color
- Use **OKLCH**, not HEX. `oklch(0.62 0.18 264)` is more controllable than `#5B5BD6`.
- Light theme base: `oklch(0.99 0 0)` background, `oklch(0.18 0 0)` text.
- One accent hue. Tint by varying L while holding C and h. Don't introduce a second hue unless you're building a multi-brand system.
- See `palette.md` for ready-to-paste ramps.

## Surfaces
- **Shadows < 12px blur** look cheap. Use `0 24px 60px -20px oklch(0 0 0 / 0.15)` for floating cards.
- Borders: `1px solid oklch(0.92 0 0)`. Avoid `border-gray-200` cliches — pick the lightness yourself.
- Glass: only when there's content moving behind it. `backdrop-filter: blur(14px) saturate(140%)` + a translucent `oklch(1 0 0 / 0.6)` fill.
- Gradients: subtle, multi-stop OKLCH, animated `background-position` on hover. Mesh gradients > linear.

## Motion
- Default ease: `cubic-bezier(0.16, 1, 0.3, 1)` (a.k.a. easeOutExpo). NOT `ease-in-out`.
- Duration: 200–320ms for UI, 500–800ms for hero reveals.
- Always respect `@media (prefers-reduced-motion: reduce)`.

## Hard "Don't"s
- ❌ Random `purple-to-blue` gradients without a reason.
- ❌ Pure `#000` on `#FFF` for hero body text — feels harsh. Use `oklch(0.18 0 0)` on `oklch(0.99 0 0)`.
- ❌ `text-center` everything. Left-align long-form unless the line is < ~25ch.
- ❌ Stock hero illustrations from Storyset / undraw / unDraw — they signal "template".
- ❌ Adding a "Get Started" button AND a "Sign Up" button in the same hero. One primary CTA.
- ❌ `box-shadow: 0 4px 6px rgba(0,0,0,0.1)` (Tailwind default). Make a real one.

## Verification before claiming done
1. `design_audit` the page — contrast, hierarchy, spacing scale.
2. Screenshot via `browser_screenshot` if a dev server is up.
3. Check at three widths: 360px, 768px, 1280px.
4. Toggle `prefers-color-scheme` if a dark theme exists.

If a constraint here contradicts an explicit user instruction, the user wins.
