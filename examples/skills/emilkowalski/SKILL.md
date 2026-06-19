---
name: emilkowalski
description: Emil Kowalski's signature UI style — buttery smooth spring animations, deliberate micro-interactions, minimal but high-impact visuals, framer-motion mastery. Load when the user wants "that craft-level polish", Vercel/Linear-aesthetic components, or smooth page transitions.
version: 1.0.0
author: QodeX
triggers:
  - animation
  - smooth
  - framer
  - micro-interaction
  - transition
  - spring
  - motion
  - polish
  - craft
  - انیمیشن
  - روان
  - میکرو
slash-aliases:
  - emil
  - emilkowalski
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
  - design_audit
  - browser_screenshot
---

# Emil Kowalski Style — Craft-Level Animation Playbook

Emil Kowalski is known for UI that *feels alive*. His work at Vercel, Sonos, and
personal projects shares a signature: every interaction has weight, every transition
has purpose, and nothing feels "out of the box."

Load this skill when the user wants components that feel genuinely polished —
not animated-for-the-sake-of-it, but alive because each state transition earns its
motion.

---

## Core Philosophy

**Motion = meaning.** Every animation communicates something:
- **Spring physics** (not easing curves) because springs feel physical.
  `type: "spring", stiffness: 400, damping: 30` is the starting point.
  Stiffer (600-900) for snappy UI, softer (200-300) for content reveals.
- **Stagger reveals** for lists — children animate in sequence, not all at once.
  `staggerChildren: 0.06` is the sweet spot; never exceed 0.15.
- **Layout animations** (`layout` prop in Framer Motion) for reflow — let the
  physics engine interpolate position changes, don't hard-code them.
- **Exit animations** always present. Content that disappears abruptly feels broken.
  Every `AnimatePresence` child has an `exit` variant.

**Restraint > excess.** One well-crafted animation beats five mediocre ones.
If an element isn't interactive, it probably shouldn't animate on idle.

---

## Animation Primitives

### Spring Configurations

```js
// Snappy (buttons, toggles, chips)
const SPRING_SNAPPY = { type: "spring", stiffness: 500, damping: 35 };

// Smooth (cards, modals, drawers)
const SPRING_SMOOTH = { type: "spring", stiffness: 300, damping: 30 };

// Gentle (page transitions, reveals)
const SPRING_GENTLE = { type: "spring", stiffness: 200, damping: 25 };

// Bouncy (notifications, badges — use sparingly)
const SPRING_BOUNCE = { type: "spring", stiffness: 400, damping: 17 };
```

### Standard Variants

```jsx
// Fade + slide up (content reveals)
const fadeUp = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { ...SPRING_SMOOTH } },
  exit:    { opacity: 0, y: -8, transition: { duration: 0.15 } },
};

// Scale in (modals, popovers)
const scaleIn = {
  hidden:  { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: { ...SPRING_SNAPPY } },
  exit:    { opacity: 0, scale: 0.96, transition: { duration: 0.12 } },
};

// Slide from right (drawers, sheets)
const slideRight = {
  hidden:  { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0, transition: { ...SPRING_SMOOTH } },
  exit:    { opacity: 0, x: 24, transition: { duration: 0.18 } },
};

// Stagger container
const stagger = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
};
```

---

## Button Design

Emil's buttons feel tactile. The key is `whileTap` with scale + a subtle shadow
collapse that sells the "press" feel:

```jsx
<motion.button
  whileHover={{ scale: 1.02, y: -1 }}
  whileTap={{ scale: 0.97, y: 0 }}
  transition={SPRING_SNAPPY}
  className="relative px-5 py-2.5 rounded-xl bg-black text-white text-sm
             font-medium tracking-tight
             shadow-[0_1px_0_0_rgba(255,255,255,0.1)_inset,0_0_0_1px_rgba(255,255,255,0.08)_inset,0_4px_12px_rgba(0,0,0,0.25)]
             hover:shadow-[0_1px_0_0_rgba(255,255,255,0.15)_inset,0_0_0_1px_rgba(255,255,255,0.12)_inset,0_8px_24px_rgba(0,0,0,0.35)]"
>
  {label}
</motion.button>
```

**Ghost / outline buttons:** thin border `1px solid rgba(0,0,0,0.1)`, barely-there
background `rgba(0,0,0,0.03)`. On hover, the border darkens slightly, the background
barely shifts. The key is that the change is *detectable*, not *dramatic*.

---

## Cards & Surfaces

Emil's cards have three layers that sell depth:
1. **Border** — `1px solid` with ~8% opacity, matching the card's shadow hue
2. **Inset highlight** — a 1px top edge in white/20 (simulates ambient light)
3. **Shadow** — large, soft, low-opacity (not hard drop shadows)

```css
/* The Emil card shadow recipe */
box-shadow:
  0 0 0 1px rgba(0,0,0,0.06),         /* border */
  0 1px 0 0 rgba(255,255,255,0.8) inset, /* highlight */
  0 4px 8px rgba(0,0,0,0.04),
  0 12px 24px rgba(0,0,0,0.06),
  0 24px 48px rgba(0,0,0,0.04);
```

On hover, the shadow deepens and the card lifts (`y: -2`). The transition is
`SPRING_SMOOTH` — never CSS transition-duration.

---

## Interactive States — The Full Table

Before writing any interactive component, map all 8 states:

| State      | Behavior |
|------------|----------|
| default    | Resting shadow, no motion |
| hover      | +shadow depth, y: -1...-2, border opacity up |
| pressed    | scale: 0.97-0.98, shadow collapses, y: 0 |
| focus      | Ring outline, NOT box-shadow (don't fight with hover shadow) |
| loading    | Spinner OR skeleton — never just "disabled + spinner" |
| disabled   | opacity: 0.4, cursor: not-allowed, no hover effect |
| success    | Green checkmark animation (scale from 0, spring bounce) |
| error      | Shake animation: `x: [0, -4, 4, -4, 4, 0]` in 0.4s |

---

## Typography

Emil's type is tight and intentional:

- **Tracking:** `letter-spacing: -0.02em` on headings (Geist, Inter, or Cal Sans)
- **Weight contrast:** display is `font-weight: 700` or `800`; body is `400`; UI
  labels are `500`. Never `600` for body — it reads as shouting.
- **Line heights:** heading `1.1`, body `1.6`, UI label `1.4`.
- **Gradient text** is used sparingly — one per hero, never in body copy.

```jsx
// Emil heading style
<h1 className="text-4xl font-bold tracking-tight leading-[1.1]
               bg-gradient-to-b from-white to-white/70
               bg-clip-text text-transparent">
  Something that matters
</h1>
```

---

## Page Transitions

Full-page transitions use `AnimatePresence` with `mode="wait"`:

```jsx
<AnimatePresence mode="wait">
  <motion.div
    key={pathname}
    initial={{ opacity: 0, filter: "blur(4px)", y: 8 }}
    animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
    exit={{ opacity: 0, filter: "blur(4px)", y: -8 }}
    transition={{ ...SPRING_GENTLE, duration: 0.25 }}
  >
    {children}
  </motion.div>
</AnimatePresence>
```

The `filter: blur()` trick is Emil's signature for page transitions — it sells
"focus shifting" between pages and masks any layout jump.

---

## Dark Mode Craft

Emil's dark surfaces are NOT just `bg-gray-900`. They use a near-black with slight
blue-tint (`oklch(0.11 0.01 260)`) which feels warmer and less harsh than pure black.

- Borders: `rgba(255,255,255,0.06)` — barely visible, just enough to define edges
- Cards: `oklch(0.14 0.01 260)` with the same inset-highlight trick (white/5)
- Text hierarchy: white/90 → white/60 → white/35 (not gray-100/400/600)

---

## What Emil Does NOT Do

- ❌ Infinite loop animations on static content (no `repeat: Infinity` on hero text)
- ❌ Rotate or skew transforms just for visual interest
- ❌ `ease-in` on exit (always `ease-out` or spring)
- ❌ Delays > 300ms (feels slow, not deliberate)
- ❌ Animating opacity without also animating position (combine always)
- ❌ CSS transitions on things that need spring (use Framer, not Tailwind `transition-all`)

---

## Quick Reference: When to Use Which Config

| Use case | Config |
|----------|--------|
| Button press | SPRING_SNAPPY (stiffness 500) |
| Card hover lift | SPRING_SMOOTH (stiffness 300) |
| Modal open | SPRING_SMOOTH + scaleIn variant |
| Page transition | SPRING_GENTLE + blur trick |
| List stagger | stagger container + fadeUp children |
| Notification pop | SPRING_BOUNCE (stiffness 400, damping 17) |
| Sidebar slide | SPRING_SMOOTH + slideRight variant |
| Error shake | keyframes x: [0,-4,4,-4,4,0] |

---

Recommended tools: `write_file`, `edit_text`, `multi_file_edit`, `browser_screenshot`,
`design_audit`. After implementing, always take a screenshot and check for jank.
