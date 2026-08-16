# Web Update 1 — A1 Clinical Signal Branding

Status: implemented locally for review; not deployed, merged, or published.

## Goal

Make WavRead feel like credible music-analysis software: measured, technically
literate, and calm, while keeping the public product account-free and preserving
the registered tester architecture delivered in Update 1.4.7.

## Delivered

- A1 Clinical Signal tokens, typography, structure, motion, and semantic states.
- A redesigned first viewport built around real WavRead analysis evidence.
- The approved vector recreation of the current mark in website wordmarks.
- A one-time signal-acquisition animation inside the vector mark, with a quiet
  wordmark hover response and a fully static reduced-motion state.
- Consistent public navigation across the landing and supporting pages.
- Restyled sign-in, loading, setup, unauthorized, dashboard, feedback, and empty
  states without changing authentication or RLS behavior.
- Self-hosted Space Grotesk and Inter with upstream licence files.
- Responsive and accessibility safeguards for 375px, 768px, and 1280px layouts.

## Intentionally unchanged

- WavRead desktop application UI and application source.
- Public account-free behavior and local audio analysis claims.
- Supabase tester authorization, ownership checks, and fail-closed behavior.
- Existing favicon, app icon, installer art, and other production icon exports.
- Release number and public 1.4.4 download destination.

## Review boundary

This branch is a local review candidate. Deployment, merge, and publication need
separate approval after visual and configured-backend review.
