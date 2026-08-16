# WavRead Web Design System

Web Update 1 establishes **A1 Clinical Signal**: a scientific, precise, and
restrained presentation for the public website and registered tester surfaces.
It complements the desktop product without redesigning the desktop UI.

## Brand principles

- Lead with measured information and real product evidence.
- Use open composition, hairline structure, and quiet hierarchy instead of
  decorative glow, oversized rounding, or dense card grids.
- Distinguish measurements, estimates, and listening prompts in both words and
  color. Never rely on color alone.
- Keep public WavRead account-free. Website tester identity remains a separate,
  access-controlled system.

## Core tokens

The source of truth is `docs/site.css` under `:root`.

| Role | Token | Value |
| --- | --- | --- |
| Studio Black | `--wr-bg` | `#0B0D10` |
| Elevated Surface | `--wr-surface-1` | `#12161B` |
| Secondary Surface | `--wr-surface-2` | `#1A2027` |
| Primary Text | `--wr-text` | `#F3F6F8` |
| Muted Text | `--wr-muted` | `#929CA7` |
| Signal Blue | `--wr-accent` | `#4DA8FF` |
| Analysis Cyan | `--wr-signal` | `#53E0D4` |
| Meter Amber | `--wr-warning` | `#FFB454` |

Signal Blue is for actions and active navigation. Analysis Cyan identifies
measured signal and positive analytical state. Meter Amber is reserved for
warnings, caution, and unresolved issues; it is not a normal CTA color.

## Typography

Space Grotesk is the display face and Inter is the body face. Both are
self-hosted WOFF2 files in `docs/fonts/` with their upstream licences. Monospace
is reserved for values, states, release metadata, and short analytical labels.
All fonts use `font-display: swap` and have system fallbacks.

## Mark

`docs/img/wavread-mark.svg` is the approved, clean vector recreation of the
current uploaded WavRead mark. It contains only vector geometry, gradients, and
filters—no embedded raster image. It is used in website wordmarks; the existing
favicon and app/install assets remain unchanged in this update.

## Layout and evidence

- Desktop composition is capped at 1240px with open, asymmetric product stories.
- Responsive checks target 1280px, 768px, and 375px viewports.
- Real screenshots retain their intrinsic aspect ratio and receive only a thin
  analytical frame.
- Measurement rails, timelines, and status labels use tabular values and
  hairlines. Bulky cards and shadows are limited to genuine app-window previews.

## Motion and accessibility

Motion is short, one-time, and connected to signal reading: a restrained scan on
the first product preview plus 10–12px content reveals. There is no looping
ambient motion. `prefers-reduced-motion: reduce` disables scan, reveal,
transitions, and smooth scrolling.

Every page keeps a skip link, one H1, keyboard-visible focus, semantic landmarks,
and text labels for measurement state. Mobile navigation supports keyboard focus
and Escape-to-close. Core text and semantic colors are checked against their
intended dark surfaces during release validation.

## Deferred branding work

The logo is faithfully vectorized, not redesigned. A future icon exploration may
consider app icon, favicon, installer, and export variants as one reviewed system;
none of those production assets are changed by Web Update 1.
