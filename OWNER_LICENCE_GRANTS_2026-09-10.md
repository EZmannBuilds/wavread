# Owner-only complimentary licences

Erik requested that only Erikiszxxn@gmail.com be able to grant free WavRead licences by recipient email. The existing confirmed Supabase user ID is pinned server-side, and current email, active account and a live authentication session must also match. No client metadata or caller-supplied admin flags are trusted. The email is not embedded in public HTML or browser JavaScript.

Sign in at https://wavread.com/dashboard with that account. The Owner controls section provides Creator email and Grant free licence. A new recipient gets an Auth identity and a normal grant entitlement using the existing owner-download rules. The recipient verifies control of the email by requesting the usual sign-in link. They do not inherit grant authority. Repeating an existing grant returns Already owned; purchases are not rewritten. Inactive accounts are refused.

The operation creates no email, invitation or marketing subscription. Share https://wavread.com/signin with the recipient separately. The five-creator pilot is planned; no creators or email addresses have been selected, and zero real licences were granted during implementation.

Implementation: private security-definer functions with explicit identity/session checks; public invoker RPC wrappers; private audit table with RLS and no direct client access; JWT-protected grant-licence Edge Function. Owner checks run before account creation and again during the transactional grant.

Verification: 48 website/handler tests pass. Rolled-back database fixtures verified actual grant creation, duplicate handling, owner-download eligibility, one audit record, inactive-account denial and lack of recipient grant authority. Verified the real owner is authorized; another UUID carrying a spoofed owner email is denied. Anonymous Edge requests return 401. Anonymous RPC execution and direct client audit access are denied. Zero fixtures persisted and zero emails were sent.

Supabase security advisor returned no new warning: the new private audit table intentionally has RLS without direct-access policies (deny by default). Existing project warnings concerned password protection and MFA options; these were not changed. References: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy and https://supabase.com/docs/guides/auth/auth-mfa .

Live website deployment: dpl_N2QYieGW4DsWghqmBfDqGfwwtVpG. Edge Function grant-licence version 1. Migration: 20260911002958_owner_licence_grants.sql.

## Priorities confirmed by Erik

1. Customer journey: Erik reports completion and successful testing. Recorded as user-verified, distinct from earlier agent-only checks.
2. Case study: a constructed First version of What the Light Remembers now provides the starting point, with preserved originals and documented deliberate problems.
3. Creator pilot: five complimentary licences, recipients to be selected. Do not infer outreach permission or subscribe recipients to marketing.
