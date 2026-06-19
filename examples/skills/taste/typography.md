# Typography Scale

| Role      | Size                          | Weight | Tracking | Leading |
| --------- | ----------------------------- | ------ | -------- | ------- |
| Hero      | clamp(2.75rem, 7vw, 5.75rem)  | 700    | -0.025em | 1.02    |
| Display   | clamp(2rem, 4.5vw, 3.5rem)    | 700    | -0.02em  | 1.05    |
| H1        | clamp(1.75rem, 3vw, 2.5rem)   | 600    | -0.015em | 1.1     |
| H2        | clamp(1.375rem, 2.2vw, 1.875rem) | 600  | -0.01em  | 1.15    |
| H3        | 1.25rem                       | 600    | -0.005em | 1.2     |
| Body      | clamp(1rem, 1.05vw, 1.125rem) | 400    | 0        | 1.65    |
| Body-lg   | 1.25rem                       | 400    | 0        | 1.55    |
| UI        | 0.9375rem                     | 500    | 0        | 1.4     |
| Caption   | 0.8125rem                     | 500    | 0.01em   | 1.3     |
| Eyebrow   | 0.75rem (uppercase)           | 600    | 0.08em   | 1.2     |

## Font-loading
```html
<link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>
<link rel="preload" as="font" type="font/woff2"
      href="/fonts/Geist-Variable.woff2" crossorigin>
```
Use `font-display: swap` and **subset** to Latin + the punctuation you actually use.

## Pairings that work
- Geist Display + Geist Sans + Geist Mono   (cohesive, modern)
- Tiempos + Inter                            (editorial)
- General Sans + JetBrains Mono              (techy)
- Instrument Serif + Geist                   (warm display + neutral body)
