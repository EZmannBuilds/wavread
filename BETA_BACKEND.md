# WavRead Backend — accounts, ownership, and reports

The account area is optional website infrastructure. WavRead itself remains
local and account-free; the only thing a desktop install can ever hold is a
revocable report token, and only after its user typed a link code.

## Model

- `beta_testers.tester_id` is the stable, WavRead-owned identity — the durable
  account record (the table name predates paid accounts). The optional
  `auth_user_id` is only a replaceable sign-in binding. Deleting the Supabase
  Auth user sets that binding to null without deleting account history.
  Browser clients can read only their own row and cannot grant or change
  anything about it.
- `purchases` and `entitlements` record the $5 Early Build. They are written
  only by the `stripe-webhook` Edge Function after Stripe's signature
  verifies; fulfillment is idempotent on the checkout session id. A refund
  marks the purchase and revokes the entitlement without deleting either.
- `builds` is the gated download catalog. Files live in the private `builds`
  storage bucket; `download-build` checks the entitlement and issues a 60-second
  signed URL. Public stable releases stay on GitHub, exactly as before.
- `link_codes` are server-generated (a trigger overwrites whatever the browser
  sends), last 15 minutes, work once, and are rate-limited to 5 per account
  per hour.
- `devices` holds one row per linked install: install id, label, and the
  SHA-256 of the report token — never the token itself. Revoking (dashboard or
  app) sets `revoked_at`; the browser's only write to the table is that column,
  and it cannot be set back to null.
- `crash_reports` accepts writes only from the `crash-report` and
  `submit-report` Edge Functions, which validate against the same bounds the
  database enforces, deduplicate one failure per install per day, and
  rate-limit per install. Reports with a valid token are attributed to the
  account; anonymous ones carry only the random install id.
- `beta_feedback` now records `source` (`web` or `app`). The browser can only
  insert `web` rows for itself; `app` rows come from `submit-report` through a
  linked device and may carry a crash reference and a user-approved log excerpt.
- `beta_known_issues` is unchanged: readable by active accounts when published.
- `complimentary_release_eligible` remains a future marker only. The $5 Early
  Build is recorded as a purchase and entitlement, not as a 1.0 licence.

## Edge Functions

| Function | JWT | Purpose |
| --- | --- | --- |
| `create-checkout` | no | email in, Stripe hosted-checkout URL out ($5, `early_build`) |
| `stripe-webhook` | no (Stripe signature) | verified fulfillment: account, purchase, entitlement, auth user |
| `link-device` | no (one-time code) | trades a link code for a hashed device token; releases tokens |
| `crash-report` | no (optional token) | validated, deduplicated, rate-limited crash intake |
| `submit-report` | no (token required) | the app's Report a Problem submissions |
| `download-build` | yes | entitlement check → 60-second signed URL + SHA-256 |

Secrets the functions need, set with `supabase secrets set` (never in source,
never in the browser): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`SITE_URL`. `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected by the
platform.

## Provisioning, in order

Nothing below is provisioned yet. Each numbered step is a separate decision.

1. **Supabase project.** Create a dedicated `wavread` project (the org's next
   project bills at $10/month — a standing cost to approve deliberately). Do
   not reuse another product's project.
2. **Migrations.** Apply `supabase/migrations/` in order:
   `20260816170852_beta_tester_experience.sql`, then
   `20260827150000_early_build_ownership_and_reports.sql`. Run the database
   advisors afterwards and read what they say.
3. **Auth.** Keep public signup disabled. Add the production and preview
   `/beta-dashboard` URLs to the redirect allow-list. Purchasers get their
   auth user from the webhook; testers are still invited by hand.
4. **Edge Functions.** Deploy all six from `supabase/functions/` —
   `verify_jwt` on for `download-build` only. Set the three secrets first;
   `SITE_URL` is the production origin (`https://wavread.vercel.app`).
5. **Stripe.** Create the Stripe account (live mode needs business details),
   copy the secret key, then add a webhook endpoint pointing at
   `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
   subscribed to `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, and `charge.refunded`; copy its
   signing secret into `STRIPE_WEBHOOK_SECRET`. Test the whole loop in Stripe
   test mode before switching the key to live.
6. **Vercel.** Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in the
   environment. Never add a service-role or secret key to the site.
7. **First gated build.** Build the DMG, `shasum -a 256` it, upload it to the
   `builds` bucket (path like `early/WavRead-1.4.8.dmg`), and insert its
   `builds` row with `published = true` and `channel = 'early'`. The dashboard
   lists it from that moment.
8. **Deploy the site** with `./deploy.sh` (runs checks, tests, and the build
   first). Production deployment remains its own approval.

Test mode: with no Stripe secrets set, `create-checkout` answers 503 and the
purchase page shows its honest "not configured" notice; the rest of the site,
sign-in, and dashboard work normally. With no Supabase env on Vercel, the
account area falls back to its existing setup-state pages.

## Security and operations

The publishable key is intentionally available to the browser; RLS and explicit
grants are the authorization boundary. The config endpoint is `no-store`.
Feedback has database length constraints plus browser validation, and the
app-side paths have server-side rate limits in the Edge Functions. Supabase
Auth rate limits protect sign-in email delivery.

Device tokens exist in exactly two places: the user's own machine and, hashed,
in `devices`. Function logs never print them. Crash reports are scrubbed on
the device before they are sent; the service enforces sizes and shapes, not
content, so the app-side scrubber is the privacy boundary and is tested in the
app repository (`tests/test_reporting.py`).

The site does not silently record build downloads. `download-build` issues
signed URLs on request; if download history ever becomes necessary for support
or eligibility, add it as an explicit, disclosed server-side event linked to
`tester_id`, with a retention policy, before collecting it.

## Release channels

- Every GitHub beta release must be marked as a **prerelease**. The desktop
  updater queries GitHub's `/releases/latest` endpoint, so publishing a beta
  as a normal release would offer it to stable users.
- Every installable release needs a `.dmg` asset and a matching
  64-character SHA-256 checksum in the release body. The app verifies that
  checksum before installing.
- A gated early-channel DMG cannot be installed by the in-app updater, which
  performs an unauthenticated HTTPS download. Early builds are downloaded
  manually from the dashboard, which labels public and gated builds clearly
  and shows the SHA-256 to verify.
- Promoting an early build to public means publishing the same DMG and
  checksum as a GitHub release; the updater takes over from there.

No account emails belong in source control. Known issues are inserted by an
admin and become visible only when `published = true`. Report triage (status
changes on `beta_feedback` and `crash_reports`) happens in Supabase Studio;
owners see status changes on their dashboard.
