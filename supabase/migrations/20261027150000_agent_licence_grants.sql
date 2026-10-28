-- WavRead's agents grant complimentary licences without the owner's session.
--
-- Approved by Erik as G1, 2026-10-26. The Product Manager, Sales and Support
-- agents grant a free full licence when an evidence-sprint contact says yes.
-- Until now only the owner could, through grant_licence, which demands the
-- owner's own JWT and a live auth session (owner_can_grant). The agents hold
-- neither, and the Supabase connector's SQL access is not a grant path (blocked
-- 2026-10-23). This adds a second path and leaves the owner's untouched:
--
--   agent-grant-licence   Edge Function; Bearer OWNER_GRANT_SECRET
--     -> auth.admin.createUser                 sign-in identity only, no email
--     -> public.agent_grant_licence_service    service role only
--     -> wavread_private.agent_grant_licence   service role only
--
-- owner_can_grant() is neither called nor changed. Nothing here is executable
-- by anon or authenticated, so no browser session reaches it, the owner's
-- included; the only key that does is the service role's, which exists only
-- inside Edge Functions.
--
-- Each grant is recorded twice. wavread_private.licence_grants gets the row an
-- owner grant writes, with the owner as its actor, so manage_licence (lookup,
-- revoke, restore) treats an agent's grant exactly as one of the owner's: the
-- owner stays the one authority licences are granted under, and the agents get
-- no identity of their own. agent_licence_grant_log records which agent asked
-- and why, including the requests that found a licence already there.

create table wavread_private.agent_licence_grant_log (
  id bigint generated always as identity primary key,
  recipient_email text not null
    constraint agent_licence_grant_log_email_check
      check (char_length(recipient_email) between 3 and 254 and recipient_email = lower(btrim(recipient_email))),
  -- Free text, so a new agent needs no migration: "product-manager", "sales",
  -- "support". The bounds are agent_grant_licence's, and the Edge Function's.
  requester text not null
    constraint agent_licence_grant_log_requester_check check (char_length(requester) between 1 and 64),
  reason text not null
    constraint agent_licence_grant_log_reason_check check (char_length(reason) between 1 and 500),
  -- The licence this request granted, or the one it found. Null only when the
  -- account's contributor standing (free_updates) already covered it.
  entitlement_id bigint references public.entitlements (id),
  already_owned boolean not null default false,
  created_at timestamptz not null default now()
);

create index agent_licence_grant_log_created_at_idx
  on wavread_private.agent_licence_grant_log (created_at);

comment on table wavread_private.agent_licence_grant_log is
  'One row per agent-grant-licence request that reached the database: who asked '
  '(requester), why, for whom, and whether a licence was already there. Written '
  'only by agent_grant_licence; no client role can read it.';

-- Deny by default, as licence_grants is: RLS on, no policies, and no client
-- role holds a privilege on the table.
alter table wavread_private.agent_licence_grant_log enable row level security;
revoke all on wavread_private.agent_licence_grant_log from public, anon, authenticated;

create function wavread_private.agent_grant_licence(recipient_email text, requester text, reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  -- The identity owner_can_grant() pins. Agent grants are made under it, so
  -- that grant history and manage_licence need no second kind of grant.
  owner_id constant uuid := '58940f22-aebc-4561-81c8-73cffeda9259';
  -- At most this many requests an hour across every agent. An honest sprint
  -- grants a handful a day; a leaked secret is held to this many licences an
  -- hour, every one logged and revocable with manage_licence.
  hourly_limit constant integer := 20;
  target_email text := lower(btrim(recipient_email));
  asked_by text := btrim(requester);
  why text := btrim(reason);
  target_auth uuid;
  target_account public.accounts%rowtype;
  target_entitlement bigint;
  owned boolean;
begin
  if target_email is null or length(target_email) > 254
     or target_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid recipient email' using errcode = '22023';
  end if;
  if asked_by is null or length(asked_by) not between 1 and 64 then
    raise exception 'Say who is asking (requester, 1 to 64 characters)' using errcode = '22023';
  end if;
  if why is null or length(why) not between 1 and 500 then
    raise exception 'Give a short reason (1 to 500 characters)' using errcode = '22023';
  end if;

  -- One agent grant at a time, so the hourly count is exact. Then the
  -- recipient's own lock, the one grant_licence and manage_licence take, so an
  -- agent's grant and the owner's action on the same address never interleave.
  perform pg_advisory_xact_lock(hashtextextended('wavread_private.agent_grant_licence', 0));
  if (select count(*) from wavread_private.agent_licence_grant_log
       where created_at > now() - interval '1 hour') >= hourly_limit then
    raise exception 'Too many agent licence grants in the last hour' using errcode = '53400';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target_email, 0));

  -- agent-grant-licence creates the sign-in identity before it calls this, as
  -- grant-licence does before grant_licence.
  select id into target_auth from auth.users where lower(email) = target_email;
  if target_auth is null then
    raise exception 'Recipient sign-in account is not ready' using errcode = '22023';
  end if;

  -- From here on, the account and the licence exactly as grant_licence does it.
  select * into target_account from public.accounts where email = target_email for update;
  if found then
    if target_account.status <> 'active' then
      raise exception 'This account is inactive; review its status first' using errcode = '22023';
    end if;
    if target_account.auth_user_id is not null and target_account.auth_user_id <> target_auth then
      raise exception 'Account identity mismatch' using errcode = '22023';
    end if;
    update public.accounts set auth_user_id = target_auth
     where tester_id = target_account.tester_id and auth_user_id is null;
  else
    insert into public.accounts (email, status, auth_user_id)
      values (target_email, 'active', target_auth) returning * into target_account;
  end if;

  -- A trial is not a licence. No trial rows exist yet; the 14-day trial
  -- (feat/trial-14-day-s1) adds them and makes grant_licence look past them
  -- and end a running one. The two trial clauses here do the same, so an
  -- agent's grant stays the owner's whichever of the two merges first.
  select id into target_entitlement from public.entitlements
   where tester_id = target_account.tester_id and entitlement = 'early_build'
     and build_version is null and revoked_at is null and source <> 'trial';
  owned := target_entitlement is not null or target_account.free_updates;
  if not owned then
    insert into public.entitlements (tester_id, entitlement, source, build_version)
      values (target_account.tester_id, 'early_build', 'grant', null) returning id into target_entitlement;
    insert into wavread_private.licence_grants (actor_id, tester_id, entitlement_id, recipient_email)
      values (owner_id, target_account.tester_id, target_entitlement, target_email);
    update public.entitlements set revoked_at = now()
     where tester_id = target_account.tester_id and source = 'trial' and revoked_at is null;
  end if;

  insert into wavread_private.agent_licence_grant_log (recipient_email, requester, reason, entitlement_id, already_owned)
    values (target_email, asked_by, why, target_entitlement, owned);
  return jsonb_build_object('email', target_email, 'already_owned', owned, 'granted', not owned,
    'requester', asked_by);
end;
$$;
revoke all on function wavread_private.agent_grant_licence(text, text, text) from public, anon, authenticated;
grant execute on function wavread_private.agent_grant_licence(text, text, text) to service_role;

-- The Data API's way in. wavread_private is not exposed, and the service role
-- holds no usage on it, so this is security definer rather than invoker like
-- the owner wrappers: it runs as its owner, and only the service role may call
-- it — the same arrangement as attributable_affiliate.
create function public.agent_grant_licence_service(recipient_email text, requester text, reason text)
returns jsonb
language sql security definer set search_path = '' as $$
  select wavread_private.agent_grant_licence(recipient_email, requester, reason);
$$;
revoke all on function public.agent_grant_licence_service(text, text, text) from public, anon, authenticated;
grant execute on function public.agent_grant_licence_service(text, text, text) to service_role;

comment on function public.agent_grant_licence_service(text, text, text) is
  'Grants a complimentary early_build licence on an agent''s request. Service role '
  'only: called by the agent-grant-licence Edge Function, never by a browser.';
