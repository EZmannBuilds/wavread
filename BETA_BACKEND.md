# WavRead Beta Backend

The tester area is optional website infrastructure. WavRead itself remains local,
account-free, and unaware of tester identities.

## Model

- Supabase Auth sends a one-time email link to pre-invited testers. Public signup is
  disabled and `shouldCreateUser` is false in the browser.
- `beta_testers.tester_id` is the stable, WavRead-owned identity and entitlement
  record. The optional `auth_user_id` is only a replaceable sign-in binding. Deleting
  the Supabase Auth user sets that binding to null without deleting tester history.
  Browser clients can read only their own row and cannot grant or change eligibility.
- `beta_known_issues` is readable only by active testers and only when published.
- `beta_feedback` accepts inserts only from an active tester for their stable tester ID.
  A tester may read their own rows but cannot update or delete them.
- `complimentary_release_eligible` is a future marker only. No license, checkout,
  or commercial entitlement behavior exists in this update.

## Setup for a preview

1. Create or select a Supabase project. Do not use production data for review.
2. Apply `supabase/migrations/20260816170852_beta_tester_experience.sql`.
3. In Supabase Auth, keep public signup disabled and add the preview and eventual
   production `beta-dashboard` URLs to the redirect allow-list.
4. In Vercel preview settings, add `SUPABASE_URL` and
   `SUPABASE_PUBLISHABLE_KEY`. Never add a service-role or secret key to the site.
5. Invite a tester through Supabase Auth. After the user exists, grant eligibility
   with the SQL below, substituting the real Auth user UUID and canonical lowercase
   email address:

```sql
insert into public.beta_testers (auth_user_id, email)
values ('00000000-0000-0000-0000-000000000000', 'tester@example.com');
```

No tester emails belong in source control. Known issues are inserted by an admin
and become visible only when `published = true`.

## Security and operations

The publishable key is intentionally available to the browser; RLS and explicit
grants are the authorization boundary. The config endpoint is `no-store`. Feedback
has database length constraints plus browser validation. Supabase Auth rate limits
protect sign-in email delivery; before a large recruitment wave, add an Edge Function
or server-side rate limit for feedback if abuse becomes visible.

The site does not silently record build downloads. If build-access history becomes
necessary for support or eligibility, add it as an explicit, disclosed server-side
event linked to `tester_id`, with a retention policy, before collecting it.

## Release channels

- Every GitHub beta release must be marked as a **prerelease**. The desktop updater
  queries GitHub's `/releases/latest` endpoint, so publishing a beta as a normal
  release would offer it to stable users.
- Every installable release needs a `.dmg` asset and a matching 64-character SHA-256
  checksum in the release body. The app verifies that checksum before installing.
- A gated tester DMG cannot be installed by the current in-app updater, which performs
  an unauthenticated HTTPS download. Gated builds must be downloaded manually from
  the tester dashboard; the dashboard must label public and private builds clearly.
- Update 1.4.7 adds website infrastructure only. There is no private 1.4.7 app build
  or application authentication in this branch.

The migration must be checked with Supabase database advisors against the selected
project before production use. This branch does not apply the migration, create users,
publish releases, or deploy anything. `deploy.sh` runs checks, tests, and the build
before staging both the static site and `/api/beta-config`; invoking its final
production deployment still requires separate approval.
