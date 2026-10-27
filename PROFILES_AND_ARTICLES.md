# Profiles, passwords and community articles

Branch `feat/profiles-and-submissions`. Option A plus passwords, decided by Erik
on 2026-10-26. **Nothing here is live.** The migration is a file, the functions
are not deployed, and no Auth, SMTP, Stripe or site setting was changed.

## The product rules

- Buying and the trial need only an email. Nobody is asked for a password
  before `/buy`.
- A buyer or trialist signs in with an email link, as today, and can set a
  password afterwards on `/account` ("Set a password").
- A writer who wants an account before buying can create one at `/signup` with
  an email and a password. The account they get owns nothing.
- Sign-in offers the password first and keeps "Email me a link" as the fallback
  for every existing account.
- An article is reviewed by a person before it is published, and approval
  never publishes. Publishing is a separate, explicit owner step.

## Pages

| Page | What it does |
|---|---|
| `/signin` | Email and password, then "Or email me a link" (the existing one-time link). Links to `/forgot-password` and `/signup`. |
| `/signup` | Email, password, confirm. Sends the confirm-signup email; the link opens `/account`. |
| `/forgot-password` | Sends a reset link. Answers the same way for every address. |
| `/reset-password` | Where the reset link lands: new password and confirm, then signs out other devices. |
| `/account` | Standing (owned, trial, or not owned), Set a password or Change password, profile (name, bio, address), and the writer's articles with their status. |
| `/account/articles/new`, `/account/articles/edit?id=` | The editor: Markdown and a live preview side by side (stacked on a phone), a formatting toolbar, title, lanes, summary, the checks the submit step applies, and house style notes. Save draft and Submit for review; no publish button. |
| `/u/<slug>` (`/u.html?slug=` locally) | A writer's public profile: name, bio, published articles. Exists only once the writer chooses an address. |

The header's "Sign in" reads "Account" when this browser holds a session
(`navigation.js`), and the dashboard links to `/account`.

## Data

Migration `supabase/migrations/20261027090000_profiles_and_article_submissions.sql`:

- `accounts` gains `display_name`, `bio`, `public_slug` (unique, reserved words
  refused) and `profile_updated_at` (set by a trigger). The holder can update
  those three columns of their own row and nothing else.
- `article_submissions`: one row per article, with the status machine enforced
  by a trigger for every role. Writers create, edit, submit and delete their own
  drafts through RLS. Only the service role reviews and publishes. Words are
  frozen once an article leaves the writer, so what was approved is what is
  published.
- `article_publish_queue`: the Markdown file each published article becomes.
  Service role only.
- `ensure_my_account()`: a confirmed sign-in with no account row gets a plain
  account (no purchase, no entitlement), or is bound to the unbound account for
  its email. An account bound to another sign-in is never rebound.
- `account_password_status()`: whether the caller's sign-in has a password.
- `public_profile(slug)`: name, bio and published titles. Never an email.
- `publish_approved_submission(...)`: the only way to `published`.

Entitlements are untouched. Setting a password changes how someone signs in,
not who they are: the Auth user id, the account row and everything hanging off
`tester_id` stay as they were.

## Edge Functions (not deployed)

| Function | Caller | Does |
|---|---|---|
| `article-submission-save` | signed-in writer (JWT) | Creates or saves a draft, under RLS as the writer. |
| `article-submission-submit` | signed-in writer (JWT) | Checks the article is complete, then draft to pending. |
| `article-review` | owner signed in, or service role key | needs_changes, approved or rejected, with notes. Never publishes. |
| `article-publish-approved` | owner signed in, or service role key | Approved only: writes `content/articles/community/<slug>.md` into the queue and marks it published. |

## Reviewing and publishing, step by step

```sh
# 1. What is waiting, with a proposed decision and notes for each.
SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
  node tools/review-submissions.mjs

# 2. Read the article. Then send your decision (the helper prints this call).
curl -sS -X POST "$SUPABASE_URL/functions/v1/article-review" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  --data '{"id":"<uuid>","decision":"approved"}'

# 3. Only when you mean to publish it.
curl -sS -X POST "$SUPABASE_URL/functions/v1/article-publish-approved" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  --data '{"id":"<uuid>"}'

# 4. Write the queued files into the repository, then commit and build.
node tools/export-publish-queue.mjs --mark-exported
```

The helper never sends anything. `tools/article-review-prompt.md` is a prompt
for a second opinion from a language model. The publish step needs the writer
to have a profile address, because the file names its author by it.

## After merge, in this order, each with Erik's go-ahead

1. Apply the migration (SQL editor or `apply_migration`, not `db push`).
2. Deploy the four functions. `verify_jwt` for each is in `supabase/config.toml`.
3. Supabase Auth → Providers → Email: make sure email and password sign-in is
   on, **Confirm email is on**, and set the minimum password length to 10. Turn
   on leaked password protection if the plan has it.
4. Turn on "Allow new users to sign up" only when writer sign-up should open
   (see the security note below first). Until then `/signup` explains that
   sign-up is not open, and everything else works.
5. Add the new redirect URLs: `https://wavread.com/account`,
   `https://wavread.com/account/articles/new`, `https://wavread.com/reset-password`.
6. Configure custom SMTP (Resend or Postmark), then paste `email-templates/`
   (see its README).
7. Deploy the site.
8. Smoke test: sign in with a link, set a password on `/account`, sign out, sign
   in with the password, reset it, write and submit an article, review it with
   the helper and `article-review`, publish it, export it.

## Open items for Erik

- **Pre-account takeover, before sign-up opens.** With open sign-up, someone
  could create an unconfirmed account with another person's email and a
  password they chose. If that person later buys with that email and confirms
  it by clicking a sign-in link, the password set by the first party may still
  work. I could not confirm whether Supabase clears it. Before step 4, add one
  change where the webhook, the licence grant and the trial bind to an existing
  sign-in: if that sign-in is unconfirmed, replace its password with a random
  one first (`auth.admin.updateUserById(id, { password })`). This PR does not
  touch `stripe-webhook` or the trial (PR #7) to keep them separate.
- **Email changes stay off.** `accounts.email` is what purchases are matched
  on, and it does not follow an Auth email change. `email-templates/change-email.html`
  is a stub for when that is fixed.
- **Community pages need PR #8** and the follow-on described in
  `content/articles/community/README.md`.
- **Profiles are `noindex`** and `/u/` is disallowed in `robots.txt` for now.
  Opening them to search is a one-line change each when wanted.
