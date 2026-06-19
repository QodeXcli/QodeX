# OKLCH Palette Recipes

Drop one of these as `:root` custom properties and reference everywhere.

## Neutral (the workhorse)
```css
:root {
  --bg:       oklch(0.99 0 0);
  --bg-soft:  oklch(0.97 0 0);
  --bg-mute:  oklch(0.94 0 0);
  --border:   oklch(0.92 0 0);
  --text:     oklch(0.18 0 0);
  --text-mute:oklch(0.45 0 0);
  --text-dim: oklch(0.62 0 0);
}
[data-theme="dark"] {
  --bg:       oklch(0.13 0 0);
  --bg-soft:  oklch(0.16 0 0);
  --bg-mute:  oklch(0.20 0 0);
  --border:   oklch(0.26 0 0);
  --text:     oklch(0.97 0 0);
  --text-mute:oklch(0.72 0 0);
  --text-dim: oklch(0.55 0 0);
}
```

## Accent — pick ONE hue, vary L
```css
/* Indigo (h=264). Swap h to retune the whole ramp. */
--accent-50:  oklch(0.97 0.02 264);
--accent-100: oklch(0.93 0.05 264);
--accent-300: oklch(0.78 0.13 264);
--accent-500: oklch(0.62 0.18 264);  /* primary */
--accent-700: oklch(0.46 0.16 264);
--accent-900: oklch(0.28 0.10 264);
```

Hue cheat sheet:
- `h=24`  → warm red
- `h=70`  → sunflower
- `h=145` → emerald
- `h=200` → teal
- `h=264` → indigo
- `h=320` → magenta

## Signal colors (semantic, not chromatic)
```css
--success: oklch(0.68 0.15 145);
--warning: oklch(0.78 0.16 70);
--danger:  oklch(0.62 0.20 27);
--info:    oklch(0.68 0.13 230);
```
