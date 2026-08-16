# Update 1.4.7 — Beta Tester Experience & Website Redesign

## Scope

This update redesigns the public website around the real WavRead application and
adds a separate, secure resource area for registered beta testers. Production is
not changed from this branch.

## Repositories and systems

- `EZmannBuilds/wavread` owns the static Vercel website, releases, tester UI,
  Supabase migration, web design tokens, and website test/build scripts.
- `EZmannBuilds/wavread-app` owns the local Python desktop application. Update
  1.4.7 does not add authentication to it and does not change its analysis engine.

## Product decisions

- Current beta stays free; no price or release date is hard-coded into the site.
- Public visitors need no account. Only invited testers use website authentication.
- Current release metadata and downloads still point to the real 1.4.4 GitHub release.
- No private 1.4.7 app build exists. Future gated builds are manual dashboard
  downloads because the desktop updater can access only public GitHub releases.
- GitHub beta releases must be prereleases and include a DMG plus a SHA-256 checksum.
- Real 1.4.4 screenshots are used; no application interface is fabricated.
- No analytics or third-party tracking was added.
- The tester registry—not local storage, routes, or auth user metadata—controls access.
- A WavRead-owned tester ID, email, and join date survive auth-provider deletion so
  feedback history and future complimentary-release eligibility remain portable.
- This is a website-only update; it does not require or introduce desktop app changes.

## Verification and deployment

Run `npm run check`, `npm test`, and `npm run build`. The production helper now runs
those gates and stages the built site, including the config API, before Vercel. Apply the Supabase migration
only to an approved preview project, run database advisors, configure preview-only
environment variables, and test an invited and non-invited account before approval.

Production deployment, database application, tester invitation, and release 1.4.7
publication remain explicitly outside this branch.
