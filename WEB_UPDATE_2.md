# Web Update 2 — The paid beta

Web Update 2 turns the website into a storefront. WavRead is now sold: five
dollars, once, buys the beta — every build while it runs, and a place where
your reports actually land. Reading the site still needs no account, and using
the app still needs no account; buying is what gets you the download.

## What ships

- **`/early-build`** — the purchase page, and the site's main call to action.
  $5, one time, through Stripe's hosted checkout; the page itself never
  touches a card. It says what the money buys, what it does not (no 1.0
  licence, no subscription, no signed installer yet), that it is beta software
  sold as beta software, and how refunds work.
- **`/purchase-complete`** — where Stripe returns to; points at sign-in.
- **Dashboard** — grows Early Build ownership, a gated-builds list with
  per-build SHA-256 and signed-URL downloads, linked devices with link-code
  generation and revocation, and a live view of the account's own reports:
  feedback (web and app) and crash reports, each with status.
- **Sign-in** — for owners as well as invited testers. Still one-time email
  links, still no open signup — and an unknown address is now told exactly
  that ("there is no WavRead account for that email") instead of being blamed
  on an outage.
- **Privacy and FAQ** — updated first, not after: problem reports (off by
  default, scrubbed, fully listed), the purchase record, and Stripe's role
  are all disclosed on the pages people actually read.
- **Backend** — one new migration
  (`20260827150000_early_build_ownership_and_reports.sql`) and six Edge
  Functions. Ownership is written only by the verified Stripe webhook; device
  tokens are stored only as hashes; crash intake is validated, deduplicated,
  and rate-limited. `BETA_BACKEND.md` is the full model and the provisioning
  runbook.

## What the price changed

Every page that advertised a free download now sells the beta instead: the
homepage hero and download section, the purchase page, the FAQ, the dashboard
(which no longer carries a public DMG button), and the EULA's "free beta"
line. A test asserts no page links a build directly — downloads go through
signed URLs earned by an entitlement.

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
