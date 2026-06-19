---
name: ui-ux-pro-max
description: Deep UX audit playbook — accessibility (WCAG AA), state machines for every interactive component, microinteractions, responsive breakpoints, motion principles, and empty/error/loading states. Load whenever the user asks for UI/UX work, "make it usable", flow audits, or accessibility passes.
version: 0.1.0
author: QodeX
triggers:
  - ux
  - accessibility
  - a11y
  - wcag
  - usability
  - flow
  - states
  - empty state
  - microinteraction
  - دسترسی‌پذیری
  - رابط کاربری
slash-aliases:
  - ux
  - uxpm
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
  - browser_navigate
  - browser_screenshot
  - browser_get_text
  - browser_console
---
# UI/UX Pro Max — UX Quality Playbook

This is the playbook the user installs when they care about UI/UX seriously.
Run through the relevant phases in order — don't skip the audit and jump to changes.

## Phase 1 — Map states (BEFORE editing)
Every interactive surface has these states. Make a table for the component you're about to touch:

| State        | Visible elements | Source of truth |
| ------------ | ---------------- | --------------- |
| empty        | "Nothing here yet" + CTA to seed | no data |
| loading      | skeleton OR spinner — never blank | request in flight |
| partial      | what you have + "loading more" | streaming/paged |
| populated    | the happy path  | normal |
| error        | recovery action + cause | request failed |
| denied       | why + how to gain access | auth/perms |
| offline      | cached snapshot + "stale" marker | network down |
| disabled     | reason + when it'll re-enable | feature-flag/perm |

Most bugs the user reports are missing states 1, 5, 6, 7. ALWAYS check all eight.

## Phase 2 — Accessibility (WCAG 2.2 AA)
Run through this list for every change. Don't say "done" if any item fails.

### Perceivable
- All non-decorative `<img>` have `alt`. Decorative → `alt=""` + `role="presentation"`.
- Text contrast ≥ 4.5:1 (body) and ≥ 3:1 (large/UI). Use OKLCH; check both themes.
- No information conveyed by color alone. Pair with icon/text.
- Focus indicator is visible AND ≥ 3:1 contrast against adjacent background.

### Operable
- Every interactive element is reachable by `Tab`. Logical order matches visual order.
- `:focus-visible` ring is custom, not the default browser blue (but never `outline: none` without a replacement).
- Skip-to-content link as the first focusable element on every page.
- Targets ≥ 24×24 CSS px (44×44 on touch). `padding` counts.
- No keyboard traps. `Esc` closes modals/menus.

### Understandable
- Form fields have visible labels, NOT placeholder-as-label.
- Errors are announced (`aria-live="polite"`) AND show inline next to the field.
- Language declared on `<html lang>`. Switch dir/lang for RTL content (Persian/Arabic/Hebrew).

### Robust
- Use semantic HTML before ARIA. `<button>` not `<div role="button">`.
- Test with a screen reader (VoiceOver `Cmd+F5`, NVDA `Insert+Q`) at least on the changed component.

## Phase 3 — Microinteractions
A polished UI has motion that explains causality.

- **Confirmation:** state change → 200–300ms subtle transform. Button press → 80ms scale-down.
- **Loading:** if > 200ms → skeleton; > 1s → progress; > 10s → cancel button + ETA.
- **Hover:** color shift OR slight lift, not both. Never simultaneous translation + glow + scale.
- **Empty inputs:** the placeholder fades, never jumps.
- **Modals:** scale-in from `0.96` + fade. Background dim is `oklch(0 0 0 / 0.5)` with `backdrop-filter: blur(8px)`.
- **Page transitions:** `view-transitions API` if available; otherwise `prefers-reduced-motion`-safe fades.

## Phase 4 — Responsive (mobile-first)
Breakpoints (the only four you need):
```
sm:  640px   tablet portrait
md:  768px   tablet landscape
lg:  1024px  small desktop
xl:  1280px  wide desktop
2xl: 1536px  cinematic
```

Stack desktop → tablet → mobile:
- Replace multi-column grids with a single column.
- Sticky nav becomes a bottom tab bar OR a hamburger that opens a full-screen menu (NOT a tiny dropdown).
- Tap targets ≥ 44px square.
- Inputs use `font-size: 16px` minimum on iOS to prevent zoom.
- Test in Safari (the iOS rendering engine) — not just Chrome DevTools.

## Phase 5 — Performance budget (UX-impacting only)
- LCP < 2.5s on a 4× CPU throttle.
- CLS < 0.1. Reserve space for images (`width`/`height` attrs).
- INP < 200ms. Heavy `JSON.parse` and large list renders → defer to `requestIdleCallback` or move off main thread.

## Phase 6 — Internationalization
If the user is in Iran/Persian-speaking, the UI may need RTL:
- Use `dir="auto"` on text containers and `:dir(rtl)` selectors for RTL-specific tweaks.
- Use logical CSS: `margin-inline-start`, `padding-inline-end` — NOT `margin-left`/`padding-right`.
- Mirror only directional icons (arrows, chevrons). Leave logos/play-buttons untouched.
- Test with a long Persian word — text won't break the same way as English.

## Hand-off
Before declaring done:
1. List which states you implemented.
2. Run `design_audit`.
3. Run `browser_screenshot` at 360 / 768 / 1280.
4. Note any WCAG items that need follow-up (open a TODO; don't silently skip).
