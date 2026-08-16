# WavRead Web Design System

Update 1.4.7 keeps the desktop identity—dark measurement surfaces, blue action,
teal signal—and gives the website a more deliberate studio-software hierarchy.

## Tokens

All reusable values live in `docs/site.css` under `:root`.

- Background: `--wr-bg`, `--wr-bg-deep`, `--wr-surface-1`, `--wr-elevated`
- Text: `--wr-text`, `--wr-text-2`, `--wr-muted`
- Action and signal: `--wr-accent`, `--wr-accent-2`, `--wr-signal`
- State: `--wr-success`, `--wr-warning`, `--wr-error`, `--wr-focus`
- Structure: border, spacing, radius, and motion token families

The type stack uses system fonts to avoid a blocking font request. Large headings
use tight tracking and plain, high-contrast language. Monospace labels identify
measurements, state, and release information rather than decorating every surface.

## Layout and motion

The main breakpoints are 900px and 560px, covering the required desktop, tablet,
and mobile layouts. Product screenshots always keep their intrinsic aspect ratio.
Motion is limited to the first viewport and one-time scroll reveals; reduced-motion
preferences remove both animation and smooth scrolling.

The app icon is referenced as a standalone asset (`favicon.png`) in the wordmark.
It is not baked into product composites, so a later icon replacement requires one
central asset change rather than a layout redesign.
