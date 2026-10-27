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
- `purchases` and `entitlements` record what was bought. **$5 buys the whole
  Early Launch**: the entitlement is granted unscoped (`build_version` null),
  which `has_build_access` reads as every build. `purchases.build_version`
  records which build was current at the time — a receipt detail, never a
  limit. They are written only by the `stripe-webhook` Edge Function after
  Stripe's signature verifies; fulfillment is idempotent on the checkout
  session id. A refund marks the purchase and revokes the entitlement.
- The per-build columns from migration `20260828040000` stay in place because
  they cost nothing and the schema already honours both shapes. If a future
  build is ever sold on its own, scope its entitlement; today nothing does.
- `beta_testers.free_updates` is **contributor standing**: it covers every
  build, and it is the marker for the promise that the **$49 final 1.0
  release** stays theirs for the $5 already paid. Granted by hand, with the
  reason in `free_updates_note`, and deliberately not computed from a report
  count — a threshold that grants itself rewards twenty empty reports over one
  useful one. When 1.0 ships, this flag is what separates who pays $49 from
  who does not. Find candidates by reading their reports, then:
  `update public.beta_testers set free_updates = true, free_updates_note = '…' where email = '…';`
- `public.has_build_access(account, build)` is the single access rule, used by
  both the builds RLS policy and `download-build`, so the dashboard and the
  download cannot drift apart. There is no free tier: `builds.price_cents` is
  checked `> 0`, and an account with no purchase and no standing reaches
  nothing.
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
| `create-checkout` | no | email in, Stripe hosted-checkout URL out ($5, `early_build`, optional campaign or affiliate label) |
| `stripe-webhook` | no (Stripe signature) | verified fulfillment: account, purchase, entitlement, auth user |
| `link-device` | no (one-time code) | trades a link code for a hashed device token; releases tokens |
| `crash-report` | no (optional token) | validated, deduplicated crash intake, rate-limited per install, per address and overall |
| `submit-report` | no (token required) | the app's Report a Problem submissions |
| `download-build` | yes | `has_build_access` → 60-second signed URL + SHA-256; an ended trial is refused with `trial_expired: true` |
| `start-trial` | no (rate-limited) | email in, one 14-day trial entitlement out; creates the account and sign-in identity if needed |

Secrets the functions need, set with `supabase secrets set` (never in source,
never in the browser): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`SITE_URL`, `ALLOWED_ORIGINS`. `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
are injected by the platform.

Two optional settings widen CORS, and both are off unless set
(`supabase/functions/_shared/callers.mjs` holds the rules):

- `VERCEL_TEAM` (`lorehouse-team`) lets this project's Vercel previews call
  the functions, in Vercel's own two hostname shapes only. Leave it unset in
  production unless a preview has to reach the live backend; checkout from a
  preview takes real money.
- `ALLOW_LOCAL_ORIGINS=true` admits the local preview on port 4173. It is for
  the local Supabase stack, never the hosted project.

`crash-report` is limited per install (20 an hour), per network address (30)
and across everyone (200), through `take_crash_report_slot`; the address is
counted only as a keyed digest that expires with its hour.

## Trials

A trial is fourteen days of WavRead, Mac and Windows, once per account, ever,
through the trial build. Migration
`20261026120000_a_trial_lasts_fourteen_days.sql` holds the rules:

- `start-trial` (public, like `create-checkout`) takes an email, rate-limits by
  keyed digests of the address and the email and across everyone
  (`take_trial_slot`: 5 an hour, 5 a day, 100 an hour), makes sure a Supabase
  Auth user exists, and calls `start_trial`. That writes an `entitlements` row
  with `source = 'trial'` and `expires_at = granted_at + 14 days`, and nothing
  else: no purchase, no Stripe object, no affiliate credit. It refuses an
  account that has had a trial (running, expired or revoked) or that owns
  WavRead (an active purchase or grant, or contributor standing). No email is
  sent; the person signs in at `/signin` as a buyer would.
- Active is `entitlement_is_active(revoked_at, expires_at)`: not revoked, and
  not past `expires_at`. Only trial rows have an `expires_at` (a check
  constraint), so purchases and grants are active exactly as before.
  `has_build_access` reads it, so an expired trial downloads nothing.
- One trial ever is `entitlements_one_trial_ever_idx`, over every trial row.
  **Never delete a trial row** — that would hand the account a second trial.
  End one by setting `revoked_at`.
- Paid wins: `stripe-webhook` grants the permanent purchase entitlement, then
  revokes any trial on the account. An owner grant (or restoring one) does the
  same. A trial never occupies the one-active-purchase-or-grant index, so a
  purchase or grant is never blocked by one. A refund revokes the purchase
  entitlement only; the trial it ended stays ended.
- `link-device` caps an account whose only claim is a trial (running or ended)
  at 2 linked installs; owning WavRead keeps the existing policy (no cap).
  Relinking an install that is already linked is not a new device.
- A trial downloads the **trial build**, and only a trial does
  (`20261027120000_a_trial_downloads_the_trial_build.sql`). Every `builds` row
  has a `kind`: `full` (the default, the paid build, which has no account) or
  `trial`. `has_build_access` gives a `trial` row to an active trial and
  nothing else, and a `full` row to everything but a trial. The dashboard lists
  each account its own kind; `latest-build` answers with `full` rows only.
- The trial build is made by `tools/build.py --trial` in the app repo, which
  stamps it. It links to the account once (the usual dashboard code), then
  asks `link-device` with `action: "standing"` every 3 days. The answer is
  `owned`, `trial` and `trial_expires_at`, and an unknown or revoked token gets
  401 `unknown_device`. Offline, it keeps working for 7 days after its last
  answer, never past the trial's end. When the trial ends, it opens, plays and
  exports what it already analysed and starts nothing new. Buying unlocks it
  in place.
- **Publishing a release means two rows per platform**: the paid file with
  `kind = 'full'` and the `-Trial` file with `kind = 'trial'`. Check each file
  with `python tools/check_build_kind.py <bundle> full|trial` (app repo)
  before its row is written. A trial build in a `full` row asks a buyer for an
  account; a paid build in a `trial` row never ends. Until a trial row exists
  for a platform, a trial account on that platform has nothing to download.

To end a test account's trial early (a throwaway email, never a customer's),
shift its window back fifteen days, which keeps `expires_at > granted_at`:

```sql
update public.entitlements
   set granted_at = granted_at - interval '15 days',
       expires_at = expires_at - interval '15 days'
 where source = 'trial'
   and tester_id = (select tester_id from public.accounts where email = 'throwaway@example.com');
```

## Email

Sign-in links go out through **Resend** as `noreply@wavread.com`, configured
in Supabase auth as custom SMTP (`smtp.resend.com:465`, user `resend`, the
password being a Resend API key scoped to sending only). Supabase's built-in
sender is not used: it arrives from a `supabase.io` address, which for a paid
product reads like phishing, and it is rate-limited to a handful an hour,
which would silently drop sign-ins during any burst of buyers.

DNS on Cloudflare, verified in public DNS rather than trusted from a
dashboard:

| Purpose | Record |
| --- | --- |
| DKIM (sending) | `resend._domainkey` TXT, the Resend key |
| SPF (bounces) | `send` TXT `v=spf1 include:amazonses.com ~all` |
| Bounce path | `send` MX → `feedback-smtp.us-east-1.amazonses.com` |
| SPF (root) | `v=spf1 include:amazonses.com include:_spf.mx.cloudflare.net ~all` |
| DMARC | `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:erikmann509@gmail.com` |
| Receiving | root MX → `route{1,2,3}.mx.cloudflare.net` + `cf2024-1._domainkey` |

The root SPF names **both** senders deliberately. Cloudflare Email Routing
adds only itself, but Resend sends *as* `wavread.com`; DMARC would still pass
on DKIM alignment alone, and a filter that checks SPF against the From domain
would otherwise score the sign-in mail as unauthenticated.

`support@wavread.com` forwards to the operator's inbox through Cloudflare
Email Routing. There is no mailbox behind `noreply@` — it is a From address
only, and mail sent to it is not received.

### The campaign label

An advertisement's link carries `?from=<label>` — `reels-a` and the like. The
purchase page reads it from the address bar and sends it once with the
checkout request; `create-checkout` validates it and, when it is recognized,
writes it to the Stripe session as `metadata[source]`. Attribution then lives
beside the revenue in Stripe, and WavRead needs no analytics script, no cookie,
and no third-party host — none of which the site's CSP or its privacy page
would permit anyway.

The label is bounded on purpose: the channel must be one of
`CAMPAIGN_CHANNELS` in `_shared/labels.mjs` and the variant after it is at most
twelve characters, so a stranger cannot write prose into a payment record.
An unrecognized label is dropped rather than refused — attribution must never
be able to block a sale.

**Adding a channel means redeploying:** `supabase functions deploy
create-checkout`. New *variants* of an existing channel need no deploy, which
is why the shape is a known channel plus a free suffix rather than a fixed
list. Until that function is redeployed, `metadata[source]` is never written
and links carrying `?from=` still sell normally.

### Affiliate links

An affiliate's link is `https://wavread.com/?from=aff-<code>`. It follows the
campaign label's path with three differences:

- The browser keeps it. `navigation.js` stores the newest affiliate label in
  `localStorage` (`wavread-referral`, with the time it was followed) for 30
  days, and `buy.js` sends it when the purchase page carries no label of its
  own. Advertisement labels are still never stored. The privacy page says so.
- `create-checkout` also sets `client_reference_id` to the label and
  `metadata[affiliate]` to the code, so an affiliate sale is easy to find in
  Stripe.
- `stripe-webhook` records `purchases.source` (any recognized label) and
  `purchases.affiliate_code`. The code is credited only if
  `attributable_affiliate` finds it in `wavread_private.affiliates`, active, and
  with an email that is not the buyer's. A failed lookup records the sale with
  no affiliate; it never blocks fulfillment.

Affiliates are managed by the owner at `/admin/affiliates` (linked from the
dashboard's owner controls) through `owner_affiliates` and
`owner_save_affiliate`, which check the same owner identity as the licence
controls. What each affiliate is owed is the view
`wavread_private.affiliate_earnings`: paid, not refunded, more than $0, older
than 30 days, by month, on the gross amount. Gross-versus-net and the payout
cadence are open decisions recorded in
`20261021120000_affiliate_tracking.sql`.

## Provisioning status — 2026-08-27

Provisioned against the dedicated Supabase project **`aodccnadwomafotizssk`**
(us-east-1, $10/month, approved):

- Both migrations applied and recorded under their file versions; the
  database security advisors report zero findings.
- All six Edge Functions deployed and smoke-tested; only `download-build`
  requires a JWT at the gateway, matching `[functions.*]` in `config.toml`.
- Secrets set: `SITE_URL`, `ALLOWED_ORIGINS`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET` — **Stripe LIVE mode** since 2026-08-27. The live
  account is `acct_1U99tmFqkBB7rT8v`; its webhook endpoint
  `we_1U9GQbFqkBB7rT8vVs1cQpaf` carries the three fulfillment events. The key
  and the secret that validates it were set in one call, so there was never a
  window where a real payment could be taken without fulfillment wired.
  Verified after the swap: checkout issues `cs_live_…` sessions and a forged
  signature is still rejected.

  *The earlier test-mode account (`acct_1U99uPC2IxgG0EgS`) and its webhook are
  a different Stripe account entirely and no longer participate. Erik's
  test-mode purchase remains in the database as a real, owned entitlement —
  its `stripe_checkout_session_id` starts `cs_test_`, which is the honest
  record of how it was made.*
- Auth: site URL `https://wavread.com` — the apex, matching the canonical
  domain; this file said `www` until 2026-09-01, when the hosted project was
  read and it did not. Redirect URLs allow-listed for the apex, the `www`
  host, the vercel.app hostname and the local preview, for both
  `/dashboard` only — the `/beta-dashboard` entries were carried alongside
  from 2026-09-01 and removed on 2026-09-03, once every link sent under the
  old path had passed `jwt_expiry`; public signup disabled.
- Vercel project `wavread`: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`
  set for Production and Preview. They take effect on the next deployment;
  running `./deploy.sh` remains its own approval.

The site is deployed and live at **https://www.wavread.com** (the apex
redirects to www; the vercel.app hostname still answers).

The full purchase chain was proven end to end in test mode on 2026-08-27:
paid session → delivered webhook → account, purchase and entitlement written →
sign-in accepted → signed download whose bytes matched the catalog SHA-256.
A signed-in non-owner got 403 and an empty builds list.

Still open: the first real purchase on the live account, and code signing —
see the app repository's roadmap for the Developer ID gate.

## Provisioning, in order

The original checklist, kept for rebuilding from nothing. Each numbered step
is a separate decision.

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
   `SITE_URL` is the canonical origin (`https://www.wavread.com`) and
   `ALLOWED_ORIGINS` lists every other host the site answers to — a browser
   judges CORS by the exact name in the address bar, so a site reachable at
   three names needs all three here or checkout fails on the ones missing.
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

**The catalog is what says a build exists.** Publishing a `builds` row with
`published = true` does two jobs: it makes the build downloadable by an entitled
account, and it makes the `latest-build` function report that version. The
desktop app reads it through `https://wavread.com/api/latest-build`, which
forwards to the function and caches the answer for five minutes. There is no
second place to remember, which is the point: 1.4.47 and 1.4.48 were both
published and downloadable while every installation was still being told 1.4.46
was current, because the updater read a GitHub release nobody had cut.

- The function returns a version, a release date, a checksum and a size, and
  nothing else. No storage path, no signed URL. Learning that a build exists is
  public; getting the file needs an account with an entitlement.
- **A build that must not be offered to everyone must not be `published`.**
  That flag now gates the announcement as well as the download — it is what
  keeps the three Demucs-era builds both unreachable and unmentioned.
- **Installations from before 1.4.49 ask GitHub instead**, because that is what
  their copy of `update.py` was built with, and an installed app cannot be
  changed from here. Until those are replaced, each release also needs an
  **announce-only GitHub release**: the tag, notes carrying the
  64-character SHA-256, and **no `.dmg` asset**. The app says a newer version
  exists and sends the user to their account, which is right for a paid build.
  Attaching the DMG there would publish the paid build to anyone with the link.
- Every GitHub release for an actual beta must still be marked a **prerelease**,
  for the same reason as before: `/releases/latest` skips prereleases, so a beta
  published as a normal release would be announced to everyone.
- If a build is ever given away openly, attach its DMG and checksum to the
  GitHub release: the app's verified-install path — download, checksum, confirm
  the version inside the image, swap with the old app kept aside — is written
  and tested and takes over from there.

No account emails belong in source control. Known issues are inserted by an
admin and become visible only when `published = true`. Report triage (status
changes on `beta_feedback` and `crash_reports`) happens in Supabase Studio;
owners see status changes on their dashboard.
