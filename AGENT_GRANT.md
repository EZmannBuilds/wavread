# Agent licence grants

> **Not live.** Do not merge, deploy `agent-grant-licence`, apply the migration
> or set `OWNER_GRANT_SECRET` in any project until Erik says so. Each step
> below waits for his approval.

Approved by Erik as G1 (2026-10-26). When an evidence-sprint contact says yes,
the Product Manager, Sales or Support agent can grant them a free full WavRead
licence without Erik's signed-in dashboard session.

The owner's own path is unchanged. `grant-licence` still needs Erik's JWT and a
live session (`owner_can_grant()`), and nothing here calls or changes it.

## What a grant does

```
POST /functions/v1/agent-grant-licence   Authorization: Bearer <OWNER_GRANT_SECRET>
  -> auth.admin.createUser({ email, email_confirm: false })   sign-in identity only
  -> public.agent_grant_licence_service(email, requester, reason)   service role only
       -> wavread_private.agent_grant_licence                       service role only
```

In one transaction, the function:

- makes or links the `accounts` row (active, bound to the sign-in identity),
  and refuses inactive accounts and identity mismatches, exactly as
  `grant_licence` does;
- writes an unscoped `early_build` entitlement with `source = 'grant'`, the
  same full licence an owner grant gives;
- writes the usual `wavread_private.licence_grants` row with Erik's pinned
  owner id as the actor. The owner dashboard's lookup, revoke and restore
  (`manage_licence`) therefore treat an agent's grant like one of Erik's;
- writes `wavread_private.agent_licence_grant_log` with who asked
  (`requester`), why (`reason`), the entitlement, and whether it was already
  owned.

If the contact already has a licence (an active purchase or grant, or
contributor standing), nothing new is granted. The request is still logged and
the answer is `already_owned: true`. A running 14-day trial (once that PR
lands) does not count as owning a licence: the grant replaces the trial, the
same way an owner grant does.

**No email is sent.** Nothing touches Stripe, no `purchases` row is written,
and no affiliate is credited. The agent tells the contact to go to
<https://wavread.com/signin>, request the usual magic link with the same email,
and download from the dashboard.

## Calling it (after Erik has set it up)

The secret lives in the agent vault. Read it into an environment variable and
never paste it into a command line, a ticket or a chat.

```sh
curl -sS -X POST "https://<project-ref>.supabase.co/functions/v1/agent-grant-licence" \
  -H "Authorization: Bearer $OWNER_GRANT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"contact@example.com","requester":"product-manager","reason":"Said yes on the evidence-sprint call, 2026-11-02"}'
```

| Field | Rule |
| --- | --- |
| `email` | the contact's address; trimmed and lowercased |
| `requester` | who is asking, 1–64 characters: `product-manager`, `sales`, `support` |
| `reason` | why, 1–500 characters. Required. |

A success returns `200`:

```json
{ "email": "contact@example.com", "already_owned": false, "granted": true,
  "signin_url": "https://wavread.com/signin", "email_sent": false }
```

| Status | Meaning | What to do |
| --- | --- | --- |
| 400 | email, requester or reason missing or out of bounds | fix the request |
| 401 | no bearer token, or the wrong one | check the vault entry |
| 405 | not a POST | use POST |
| 409 | the account is inactive or bound to another sign-in | ask Erik; do not retry |
| 429 | 20 requests have reached the database in the last hour, across all agents | wait an hour |
| 503 | the secret isn't configured, or account set-up or the database failed | retry later; if it keeps happening, tell Erik |

Errors never include database text, stack traces or the secret. The function
logs only an error code.

## Limits and safety

- **Secret.** `OWNER_GRANT_SECRET` must be at least 32 characters. If it is
  unset or shorter, the function refuses every request with 503. The
  comparison hashes both sides first, so it takes the same time wherever the
  guess goes wrong.
- **Rate.** 20 requests an hour across every agent, already-owned ones
  included. The cap is counted in the database under one lock, so it holds
  across every Edge Function instance. If the secret leaks, the most it can do
  is 20 licences an hour, each one logged and revocable.
- **Roles.** Neither function is executable by `anon` or `authenticated`, the
  owner's own session included. The log table has RLS on, no policies, and no
  client grants.
- **Revoking a grant.** Use the owner controls on the dashboard (lookup, then
  revoke), the same as for any owner grant.
- **Rotating the secret.** Set a new value with `supabase secrets set`.
  Supabase applies it without a redeploy, and the old value stops working.
  Update the vault at the same time.

Erik can read the log in the SQL editor:

```sql
select created_at, requester, recipient_email, reason, already_owned, entitlement_id
from wavread_private.agent_licence_grant_log order by id desc limit 50;
```

## Going live: Erik's steps, in order, each only when he approves

The 2026-10-27 ship order puts G1 after the trial stack (#7 + #11). The
migration does not depend on theirs and was tested on top of #7 + #11, and on
`main` without them, so either order works.

1. **Apply this one migration**,
   `supabase/migrations/20261027150000_agent_licence_grants.sql`, on its own.
   Never use `supabase db push`, which would also apply any other pending
   migration in the folder.
2. **Set the secret** in the project's Edge Function secrets. Generate it
   locally and never commit it:
   `supabase secrets set OWNER_GRANT_SECRET="$(openssl rand -hex 32)"`.
   Keep the value for step 5.
3. **Deploy the function:**
   `supabase functions deploy agent-grant-licence --no-verify-jwt`
   (`config.toml` sets `verify_jwt = false` too). If a call answers
   `Invalid JWT` rather than the function's own `{"error":"Not authorized."}`,
   the gateway is still checking JWTs: redeploy with the flag.
4. **Smoke-test with a throwaway email.** Make three calls: one without the
   header (expect 401), one granting the throwaway (expect `granted: true`),
   then the same again (expect `already_owned: true`). Then revoke it from the
   dashboard's owner controls and delete the throwaway's Auth user if you
   want. The log rows stay as the record.
5. **Store the same secret in the agent vault** for the agents that will call
   it. Support Desk owns licence-grant operations once this is live; the
   Product Manager agent gets it too, as the G1 brief asked.
