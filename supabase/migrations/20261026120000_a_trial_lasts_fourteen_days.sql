-- A trial lasts fourteen days, and then it is over.
--
-- Anyone can start one by email (the start-trial Edge Function), once. It is
-- the same entitlement a purchase grants — every build, Mac and Windows — with
-- an end date: the clock starts when the trial row is written and runs for
-- fourteen days. After that the account downloads nothing until it buys, and
-- buying is the existing $50 checkout, unchanged. A trial is not a purchase:
-- no purchases row, no Stripe object, no affiliate credit.
--
-- Shape of the change:
--   entitlements.expires_at          when an entitlement stops counting; set on
--                                    trial rows only, null on purchase and grant
--   entitlements.source 'trial'      the third way an account comes to own WavRead
--   entitlement_is_active()          the one definition of "active"
--   entitlements_one_trial_ever_idx  one trial per account, ever — expiry and
--                                    revocation do not free the slot
--   has_build_access()               now ignores an expired trial
--   account_standing()               owned / trial / linked devices, for the
--                                    download refusal and the trial device cap
--   take_trial_slot()                start-trial's rate limit (address, email, everyone)
--   start_trial()                    the trial itself, under the same per-email
--                                    lock an owner grant takes
--   grant_licence(), manage_licence()  an owner grant is never blocked by a
--                                    trial, and ends one the way a purchase does
--
-- "Active" means: revoked_at is null and (expires_at is null or expires_at >
-- now()). Purchase and grant rows never expire, so for them active is what it
-- always was. A trial is inactive once it expires or once it is revoked, and the
-- two look the same to every access check.
--
-- A trial row is never deleted. The unique index below is over every trial row,
-- revoked or not, expired or not, so deleting one would hand that account a
-- second trial. End a trial by setting revoked_at.
--
-- Apply with apply_migration or the SQL editor, never with db push: production's
-- migration history does not match this directory's file names.

begin;

-- === entitlements can end on their own =====================================

alter table public.entitlements
  add column expires_at timestamptz;

comment on column public.entitlements.expires_at is
  'When this entitlement stops counting. Set on trial rows only, explicitly, to '
  'granted_at + 14 days by start_trial(); null on purchase and grant rows, which '
  'last until revoked. Read through entitlement_is_active(), never on its own.';

alter table public.entitlements drop constraint entitlements_source_check;
alter table public.entitlements
  add constraint entitlements_source_check
    check (source in ('purchase', 'grant', 'trial'));

-- A trial always ends and nothing else ever does. A purchase with an end date
-- would quietly sell a rental; a trial without one would be a free licence.
alter table public.entitlements
  add constraint entitlements_only_trials_expire
    check ((source = 'trial') = (expires_at is not null));

alter table public.entitlements
  add constraint entitlements_expiry_follows_grant
    check (expires_at is null or expires_at > granted_at);

-- A trial is the whole product for a while, never one build of it, and it is
-- never paid for, so it can reference no purchase.
alter table public.entitlements
  add constraint entitlements_trial_is_unscoped_and_unpaid
    check (source <> 'trial' or (build_version is null and purchase_id is null));

-- One unrevoked purchase or grant per account per build, as before — but a
-- trial no longer takes that slot. A trial that is still running, or that ran
-- out without being revoked, must never make a purchase's entitlement insert
-- collide: the webhook reads that collision as a lost retry race and would
-- record the payment with no entitlement behind it.
drop index if exists public.entitlements_one_active_idx;
create unique index entitlements_one_active_idx
  on public.entitlements (tester_id, entitlement, coalesce(build_version, ''))
  where revoked_at is null and source <> 'trial';

-- One trial per account, ever. Over every trial row rather than the live ones,
-- so a second public trial is refused after the first expires and after it is
-- revoked. accounts.email is unique, so this is also one trial per email.
-- Purchases and owner grants are untouched by it.
create unique index entitlements_one_trial_ever_idx
  on public.entitlements (tester_id)
  where source = 'trial';

comment on table public.entitlements is
  'What an account owns. ''purchase'' rows come from the Stripe webhook; '
  '''grant'' rows are written by the owner for complimentary access; ''trial'' '
  'rows by start-trial, one per account ever, with expires_at 14 days out. '
  'Revoking (a refund, a purchase ending a trial) sets revoked_at rather than '
  'deleting history. Active = entitlement_is_active(revoked_at, expires_at).';

-- === the one definition of active ==========================================

create function public.entitlement_is_active(revoked_at timestamptz, expires_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select revoked_at is null and (expires_at is null or expires_at > now());
$$;

comment on function public.entitlement_is_active(timestamptz, timestamptz) is
  'Whether an entitlement counts right now: not revoked, and not past its '
  'expiry if it has one. Every access check reads this rather than revoked_at '
  'alone, so an expired trial and a revoked one are refused alike.';

grant execute on function public.entitlement_is_active(timestamptz, timestamptz)
  to authenticated, service_role;

-- The access rule, reading active through the definition above. Otherwise
-- unchanged: contributor standing, an entitlement for this build, or an
-- unscoped one. A trial row is unscoped, so while it lasts it covers every
-- build on every platform, and the moment it expires it covers none.
create or replace function public.has_build_access(account uuid, build bigint)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.accounts t
    join public.builds b on b.id = build
    where t.tester_id = account
      and t.status = 'active'
      and (
        t.free_updates
        or exists (
          select 1 from public.entitlements e
          where e.tester_id = t.tester_id
            and public.entitlement_is_active(e.revoked_at, e.expires_at)
            and e.entitlement = 'early_build'
            and (e.build_version = b.version
                 or e.build_version is null)
        )
      )
  );
$$;

comment on function public.has_build_access is
  'Whether an account may download one build: contributor standing, an active '
  'entitlement for that build, or an active unscoped one (a purchase, a grant, '
  'or a trial before it expires). The single definition download-build uses.';

-- === what an account stands on =============================================
--
-- download-build asks this only after has_build_access said no, to tell an
-- ended trial from never having owned anything. link-device asks it to cap a
-- trial at two devices. Both read it from here, so "owns WavRead" and "is on a
-- trial" mean the same thing to each.
--
--   owned           contributor standing, or an active purchase or grant
--   trial           'active', 'ended' (expired or revoked), or null for none
--   trial_expires_at  when the trial ends or ended, or null
--   linked_devices  installs linked right now (unrevoked), counted once each
--   install_linked  whether the given install is one of them
create function public.account_standing(account uuid, install uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'owned', t.free_updates or exists (
      select 1 from public.entitlements e
      where e.tester_id = t.tester_id
        and e.entitlement = 'early_build'
        and e.source <> 'trial'
        and public.entitlement_is_active(e.revoked_at, e.expires_at)),
    'trial', (
      select case when public.entitlement_is_active(e.revoked_at, e.expires_at)
                  then 'active' else 'ended' end
      from public.entitlements e
      where e.tester_id = t.tester_id and e.source = 'trial'),
    'trial_expires_at', (
      select e.expires_at from public.entitlements e
      where e.tester_id = t.tester_id and e.source = 'trial'),
    'linked_devices', (
      select count(distinct d.install_id) from public.devices d
      where d.tester_id = t.tester_id and d.revoked_at is null),
    'install_linked', install is not null and exists (
      select 1 from public.devices d
      where d.tester_id = t.tester_id and d.install_id = install and d.revoked_at is null)
  )
  from public.accounts t
  where t.tester_id = account;
$$;

revoke all on function public.account_standing(uuid, uuid) from public, anon, authenticated;
grant execute on function public.account_standing(uuid, uuid) to service_role;

-- === start-trial's rate limit ==============================================
--
-- start-trial is public and creates a sign-in identity, so it is limited the
-- way crash-report is: by a keyed digest of the network address (the address
-- never reaches the database), by a keyed digest of the email, and across the
-- whole service. Every attempt counts, including refused ones, which also keeps
-- the endpoint from being a fast way to ask whether an address owns WavRead.
--
-- The numbers: 5 an hour from one address leaves room for a shared office or
-- campus connection; 5 a day for one email covers retries after an error; 100
-- an hour across everyone is far above any day WavRead has had, and caps how
-- many accounts a scripted flood from many addresses can create in an hour.
create table public.wavread_trial_rate_limits (
  scope text not null,
  bucket_start timestamptz not null,
  expires_at timestamptz not null,
  attempts integer not null default 1,
  primary key (scope, bucket_start)
);
create index wavread_trial_rate_expiry on public.wavread_trial_rate_limits (expires_at);
alter table public.wavread_trial_rate_limits enable row level security;
revoke all on table public.wavread_trial_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.wavread_trial_rate_limits to service_role;

comment on table public.wavread_trial_rate_limits is
  'start-trial counters keyed by HMAC digests of network addresses and emails, '
  'plus one service-wide count. Never an address or an email; every row expires '
  'within the hour or the day it counts.';

-- True when one more start-trial attempt may proceed now. An address over its
-- own limit is refused before it can use up the email's or everyone's count.
create function public.take_trial_slot(address_digest text, email_digest text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare from_address integer; for_email integer; from_everyone integer;
begin
  if address_digest is null or address_digest !~ '^[a-f0-9]{64}$'
     or email_digest is null or email_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid digest';
  end if;
  delete from public.wavread_trial_rate_limits where expires_at < now();
  insert into public.wavread_trial_rate_limits as limits (scope, bucket_start, expires_at)
    values ('trial:address:' || address_digest, date_trunc('hour', now()), date_trunc('hour', now()) + interval '1 hour')
    on conflict (scope, bucket_start) do update set attempts = least(limits.attempts + 1, 1000000)
    returning attempts into from_address;
  if from_address > 5 then return false; end if;
  insert into public.wavread_trial_rate_limits as limits (scope, bucket_start, expires_at)
    values ('trial:email:' || email_digest, date_trunc('day', now()), date_trunc('day', now()) + interval '1 day')
    on conflict (scope, bucket_start) do update set attempts = least(limits.attempts + 1, 1000000)
    returning attempts into for_email;
  if for_email > 5 then return false; end if;
  insert into public.wavread_trial_rate_limits as limits (scope, bucket_start, expires_at)
    values ('trial:everyone', date_trunc('hour', now()), date_trunc('hour', now()) + interval '1 hour')
    on conflict (scope, bucket_start) do update set attempts = least(limits.attempts + 1, 1000000)
    returning attempts into from_everyone;
  return from_everyone <= 100;
end;
$$;

revoke all on function public.take_trial_slot(text, text) from public, anon, authenticated;
grant execute on function public.take_trial_slot(text, text) to service_role;

-- === the trial itself ======================================================
--
-- Called by start-trial (service role only) after it has made sure a Supabase
-- Auth user exists for the email, so the account can sign in with the same
-- one-time links buyers use. Answers a status and never raises for a refusal:
--
--   started           the trial row was written; expires_at is 14 days out
--   already_owned     contributor standing, or an active purchase or grant
--   trial_used        this account has had its trial (running, expired or revoked)
--   account_inactive  the account is paused or ended
--   account_mismatch  the account is bound to a different sign-in identity
--
-- No purchases row, no Stripe call, no affiliate: a trial is not a sale.
create function public.start_trial(trial_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_email text := lower(btrim(trial_email));
  target_auth uuid;
  target_account public.accounts%rowtype;
  existing boolean;
  previous public.entitlements%rowtype;
  granted public.entitlements%rowtype;
  started timestamptz := now();
begin
  if target_email is null or length(target_email) > 254
     or target_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email' using errcode = '22023';
  end if;
  -- The lock grant_licence takes, so a trial and an owner grant for one address
  -- run one after the other, never interleaved.
  perform pg_advisory_xact_lock(hashtextextended(target_email, 0));

  select id into target_auth from auth.users where lower(email) = target_email;
  if target_auth is null then
    raise exception 'The sign-in account is not ready' using errcode = '22023';
  end if;

  select * into target_account from public.accounts where email = target_email for update;
  existing := found;
  if existing then
    if target_account.status <> 'active' then
      return jsonb_build_object('status', 'account_inactive', 'email', target_email);
    end if;
    if target_account.auth_user_id is not null and target_account.auth_user_id <> target_auth then
      return jsonb_build_object('status', 'account_mismatch', 'email', target_email);
    end if;
    if target_account.free_updates or exists (
      select 1 from public.entitlements e
      where e.tester_id = target_account.tester_id
        and e.entitlement = 'early_build'
        and e.source <> 'trial'
        and public.entitlement_is_active(e.revoked_at, e.expires_at)
    ) then
      return jsonb_build_object('status', 'already_owned', 'email', target_email);
    end if;
    select * into previous from public.entitlements
      where tester_id = target_account.tester_id and source = 'trial';
    if found then
      return jsonb_build_object('status', 'trial_used', 'email', target_email,
        'trial_active', public.entitlement_is_active(previous.revoked_at, previous.expires_at),
        'expires_at', previous.expires_at);
    end if;
    update public.accounts set auth_user_id = target_auth
      where tester_id = target_account.tester_id and auth_user_id is null;
  else
    insert into public.accounts (email, status, auth_user_id)
      values (target_email, 'active', target_auth)
      returning * into target_account;
  end if;

  -- Both ends written explicitly from one clock reading, so the row says
  -- exactly what was promised: granted now, over fourteen days from now.
  insert into public.entitlements (tester_id, entitlement, source, build_version, granted_at, expires_at)
    values (target_account.tester_id, 'early_build', 'trial', null, started, started + interval '14 days')
    returning * into granted;

  return jsonb_build_object('status', 'started', 'email', target_email,
    'granted_at', granted.granted_at, 'expires_at', granted.expires_at);
end;
$$;

comment on function public.start_trial(text) is
  'Starts the one 14-day trial an account may ever have. Service role only, '
  'called by start-trial; answers a status rather than raising for a refusal.';

revoke all on function public.start_trial(text) from public, anon, authenticated;
grant execute on function public.start_trial(text) to service_role;

-- === owner grants are never blocked by a trial =============================
--
-- grant_licence decided "already owned" from any unrevoked unscoped row, which
-- a running trial now is: granting a licence to someone mid-trial would have
-- answered already_owned and granted nothing. It now looks past trial rows,
-- and a grant ends a running trial the way a purchase does. Otherwise the
-- function is unchanged from 20260911002958_owner_licence_grants.sql.
create or replace function wavread_private.grant_licence(recipient_email text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 target_email text := lower(btrim(recipient_email));
 target_auth uuid; target_account public.accounts%rowtype;
 entitlement_id bigint; already_owned boolean;
begin
 if not coalesce(wavread_private.owner_can_grant(),false) then
  raise exception 'Only the designated owner may grant licences' using errcode='42501';
 end if;
 if target_email is null or length(target_email)>254 or target_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
  raise exception 'Enter a valid recipient email' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(target_email,0));
 select id into target_auth from auth.users where lower(email)=target_email;
 if target_auth is null then raise exception 'Recipient sign-in account is not ready' using errcode='22023'; end if;
 select * into target_account from public.accounts where email=target_email for update;
 if found then
  if target_account.status <> 'active' then raise exception 'This account is inactive; review its status first' using errcode='22023'; end if;
  if target_account.auth_user_id is not null and target_account.auth_user_id<>target_auth then
   raise exception 'Account identity mismatch' using errcode='22023';
  end if;
  update public.accounts set auth_user_id=target_auth where tester_id=target_account.tester_id and auth_user_id is null;
 else
  insert into public.accounts(email,status,auth_user_id) values(target_email,'active',target_auth) returning * into target_account;
 end if;
 select id into entitlement_id from public.entitlements where tester_id=target_account.tester_id
  and entitlement='early_build' and build_version is null and revoked_at is null and source<>'trial';
 already_owned := entitlement_id is not null or target_account.free_updates;
 if not already_owned then
  insert into public.entitlements(tester_id,entitlement,source,build_version)
   values(target_account.tester_id,'early_build','grant',null) returning id into entitlement_id;
  insert into wavread_private.licence_grants(actor_id,tester_id,entitlement_id,recipient_email)
   values(auth.uid(),target_account.tester_id,entitlement_id,target_email);
  -- The grant wins over a trial, as a purchase does.
  update public.entitlements set revoked_at=now()
   where tester_id=target_account.tester_id and source='trial' and revoked_at is null;
 end if;
 return jsonb_build_object('email',target_email,'already_owned',already_owned,'granted',not already_owned);
end;
$$;
revoke all on function wavread_private.grant_licence(text) from public,anon;
grant execute on function wavread_private.grant_licence(text) to authenticated;

-- Restoring a grant is refused while another unrevoked licence exists; a trial
-- is not one, and a restored grant ends a running trial as granting it did.
-- The lookup also reports expires_at, so the owner can tell a running trial
-- from one that ran out. Otherwise unchanged from
-- 20260912085832_owner_licence_controls.sql.
create or replace function wavread_private.manage_licence(recipient_email text, operation text default 'lookup') returns jsonb
language plpgsql security definer set search_path='' as $$
declare target_email text := lower(btrim(recipient_email)); result jsonb;
begin
 if not coalesce(wavread_private.owner_can_grant(),false) then
  raise exception 'Owner access required' using errcode='42501';
 end if;
 if operation not in ('lookup','revoke','restore') or target_email is null or length(target_email)>254 or target_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
  raise exception 'Invalid email or operation' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(target_email,0));
 if operation='revoke' then
  update public.entitlements e set revoked_at=now()
   from wavread_private.licence_grants g
   where e.id=g.entitlement_id and g.recipient_email=target_email and e.source='grant' and e.revoked_at is null;
 elsif operation='restore' then
  -- Restore the latest grant only; earlier grant history remains revoked.
  update public.entitlements e set revoked_at=null
   where e.id=(select g.entitlement_id from wavread_private.licence_grants g
     where g.recipient_email=target_email order by g.id desc limit 1)
     and e.source='grant' and not exists (
       select 1 from public.entitlements a where a.tester_id=e.tester_id
       and a.entitlement=e.entitlement and a.build_version is not distinct from e.build_version
       and a.revoked_at is null and a.source<>'trial');
  if found then
   update public.entitlements t set revoked_at=now()
    from public.accounts a
    where a.email=target_email and t.tester_id=a.tester_id and t.source='trial' and t.revoked_at is null;
  end if;
 end if;
 select jsonb_build_object('email',target_email,'operation',operation,
  'account_status',a.status,'free_updates',a.free_updates,
  'licences',coalesce((select jsonb_agg(jsonb_build_object('source',e.source,'build_version',e.build_version,
     'granted_at',e.granted_at,'revoked_at',e.revoked_at,'expires_at',e.expires_at,
     'owner_grant',exists(select 1 from wavread_private.licence_grants g where g.entitlement_id=e.id)))
     from public.entitlements e where e.tester_id=a.tester_id),'[]'::jsonb))
 into result from public.accounts a where a.email=target_email;
 return coalesce(result,jsonb_build_object('email',target_email,'account_status','not found','licences','[]'::jsonb));
end;
$$;
revoke all on function wavread_private.manage_licence(text,text) from public,anon;
grant execute on function wavread_private.manage_licence(text,text) to authenticated;

commit;
