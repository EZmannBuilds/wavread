# Auth email templates

HTML sources for the emails Supabase Auth sends for WavRead accounts. **These
are files only.** Nothing in this repository applies them, and this branch makes
no change to the live project's SMTP settings or email templates.

| File | Supabase Auth template | Suggested subject |
|---|---|---|
| `confirm-signup.html` | Confirm signup | Confirm your WavRead account |
| `magic-link.html` | Magic Link | Your WavRead sign-in link |
| `reset-password.html` | Reset Password | Reset your WavRead password |
| `password-changed.html` | Security notifications → Password changed | Your WavRead password was changed |
| `change-email.html` | Change Email Address (stub, see below) | Confirm your new WavRead email |

## Before pasting anything

1. **Custom SMTP comes first.** Supabase's built-in mailer is for testing: it
   sends only a handful of messages an hour and only to team addresses. Set up
   a sender (Resend or Postmark) under Project Settings → Auth → SMTP, verify
   the sending domain (SPF, DKIM, and a DMARC record for `wavread.com`), and
   send yourself a test. Pasting branded templates into the built-in mailer
   changes nothing a customer sees.
2. **Then paste each file** into Authentication → Email Templates, in the
   matching template, with the subject from the table. Paste the whole file;
   the comment at the top is harmless in an email.
3. **Send one of each** to an address you control and open it in at least one
   web client and one phone client before relying on it.

Do not apply these with the Management API or `supabase config push` from this
branch. `supabase/config.toml` describes a local stack only.

## What the templates use

Supabase fills these Go template variables; the files use no others:

- `{{ .ConfirmationURL }}`: the one-time link. Every template that has a link
  shows it twice, as the button and as plain text for clients that hide
  buttons.
- `{{ .Email }}`: the account's address. `{{ .NewEmail }}` in change-email only.

The logo is the published `https://wavread.com/apple-touch-icon.png` (180 px,
shown at 36 px). The colours are the site's light theme: ink `#142039` for the
one primary button and the headings, paper `#f0f3f7`, muted `#536175`, hairline
`#ced5df`. Styles are inline because email clients drop `<style>` blocks; that
is why these files are outside `docs/`, where the site forbids inline styles.

## Notes

- Links land where the site expects: sign-in links on `/dashboard` (or the page
  that asked), sign-up confirmation on `/account`, password reset on
  `/reset-password`. Each of those must be in Authentication → URL
  Configuration → Redirect URLs, or Supabase sends people to the Site URL
  instead.
- **change-email is a stub.** The site has no "change email" screen, and
  `accounts.email`, which purchases are matched on, does not follow an Auth
  email change. Keep email changes unavailable until a follow-up makes the
  account row follow the sign-in's email; until then this template is never
  sent.
- None of these emails says whether an address has an account beyond what the
  person asked for, and none contains a password.
