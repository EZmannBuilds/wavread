# Web Update 2 — The Early Build

Web Update 2 turns the website's account area commercial, carefully. The
public site stays account-free and the public beta stays free; what changes is
that the next build, and a place to see your own reports, can now be bought
for five dollars.

## What ships

- **`/early-build`** — the purchase page. $5, one time, through Stripe's
  hosted checkout; the page itself never touches a card. It says what the
  money buys, what it does not (no 1.0 licence, no subscription, no signed
  installer yet), and how refunds work.
- **`/purchase-complete`** — where Stripe returns to; points at sign-in.
- **Dashboard** — grows Early Build ownership, a gated-builds list with
  per-build SHA-256 and signed-URL downloads, linked devices with link-code
  generation and revocation, and a live view of the account's own reports:
  feedback (web and app) and crash reports, each with status.
- **Sign-in** — now for Early Build owners as well as invited testers. Still
  one-time email links, still no open signup.
- **Privacy and FAQ** — updated first, not after: problem reports (off by
  default, scrubbed, fully listed), the purchase record, and Stripe's role
  are all disclosed on the pages people actually read.
- **Backend** — one new migration
  (`20260827150000_early_build_ownership_and_reports.sql`) and six Edge
  Functions. Ownership is written only by the verified Stripe webhook; device
  tokens are stored only as hashes; crash intake is validated, deduplicated,
  and rate-limited. `BETA_BACKEND.md` is the full model and the provisioning
  runbook.

## Boundaries kept

- The desktop app remains account-free. A linked device holds one revocable
  report token — never an email, session, or password.
- Browser state is never the authorization boundary; RLS and explicit grants
  are. The browser reads ownership and reports; it can write only its own
  feedback, its own link-code request, and the revocation of its own device.
- The A1 Clinical Signal design system is unchanged: same tokens, same type,
  same restraint. New surfaces reuse the existing component vocabulary.

## Not provisioned by this update

No Supabase project, Stripe account, secret, or production deployment is
created or changed by this branch. `BETA_BACKEND.md` lists the provisioning
steps in order; each is a separate approval, and the site degrades honestly
(setup notices, 503s) until they happen.
