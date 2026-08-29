-- Update 1.4.8 — Early Build ownership, device links, and problem reports.
--
-- Builds on 20260816170852_beta_tester_experience.sql. The durable identity
-- model is unchanged: `beta_testers.tester_id` is the stable WavRead-owned
-- account record (the table keeps its historical name), and the Supabase Auth
-- UUID stays a replaceable sign-in binding. This migration adds what a $5
-- Early Build purchase needs around that identity:
--
--   purchases      — what was paid, held to Stripe's checkout session id
--   entitlements   — what an account owns (currently only 'early_build')
--   builds         — the gated download catalog behind entitlements
--   link_codes     — short-lived codes that connect the desktop app
--   devices        — the app's revocable report link (a hashed opaque token)
--   crash_reports  — crash and failure reports sent by the app
--
-- The browser can never write ownership: purchases, entitlements, builds,
-- devices (except revoking one's own), and crash_reports accept writes only
-- from the service role inside Edge Functions. Browser state is never the
-- authorization boundary; RLS and explicit grants are.

begin;

create extension if not exists pgcrypto with schema extensions;

comment on table public.beta_testers is
  'Durable WavRead account record (the table name predates paid accounts). '
  'tester_id is the stable WavRead-owned identity that purchases, '
  'entitlements, devices, reports, and feedback attach to; the replaceable '
  'auth binding cannot own or erase it.';

-- === purchases =============================================================

create table public.purchases (
  id bigint generated always as identity primary key,
  tester_id uuid not null references public.beta_testers(tester_id) on delete restrict,
  product text not null check (product in ('early_build')),
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'usd'
    check (currency = lower(currency) and char_length(currency) = 3),
  stripe_checkout_session_id text not null unique
    check (char_length(stripe_checkout_session_id) between 8 and 255),
  stripe_payment_intent text
    check (stripe_payment_intent is null or char_length(stripe_payment_intent) <= 255),
  email text not null check (
    char_length(email) between 3 and 254
    and email = lower(btrim(email))
  ),
  status text not null default 'paid' check (status in ('paid', 'refunded')),
  purchased_at timestamptz not null default now(),
  refunded_at timestamptz,
  check ((status = 'refunded') = (refunded_at is not null))
);

create index purchases_tester_id_purchased_at_idx
  on public.purchases (tester_id, purchased_at desc);

comment on table public.purchases is
  'One row per completed Stripe Checkout session, written only by the '
  'stripe-webhook Edge Function after signature verification. The unique '
  'session id makes fulfillment idempotent.';

-- === entitlements ==========================================================

create table public.entitlements (
  id bigint generated always as identity primary key,
  tester_id uuid not null references public.beta_testers(tester_id) on delete restrict,
  entitlement text not null check (entitlement in ('early_build')),
  source text not null check (source in ('purchase', 'grant')),
  purchase_id bigint references public.purchases(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index entitlements_one_active_idx
  on public.entitlements (tester_id, entitlement)
  where revoked_at is null;

comment on table public.entitlements is
  'What an account owns. ''purchase'' rows come from the Stripe webhook; '
  '''grant'' rows are written by the operator for complimentary access. '
  'Revoking (a refund) sets revoked_at rather than deleting history.';

-- === builds: the gated download catalog ====================================

create table public.builds (
  id bigint generated always as identity primary key,
  version text not null check (char_length(version) between 1 and 40),
  channel text not null check (channel in ('early', 'stable')),
  file_name text not null check (char_length(file_name) between 5 and 120),
  storage_path text not null check (char_length(storage_path) between 5 and 300),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  notes text check (notes is null or char_length(notes) <= 4000),
  published boolean not null default false,
  released_at timestamptz not null default now(),
  unique (version, channel)
);

comment on table public.builds is
  'Gated build catalog. Files live in the private ''builds'' storage bucket; '
  'the download-build Edge Function verifies the entitlement and issues a '
  'short-lived signed URL. Public stable releases stay on GitHub.';

-- === link codes: connecting the desktop app ================================

create table public.link_codes (
  code text primary key,
  tester_id uuid not null references public.beta_testers(tester_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz
);

comment on table public.link_codes is
  'Short-lived single-use codes shown on the dashboard and typed into the '
  'desktop app. A trigger writes the server-generated code and expiry, so a '
  'browser can request a code but never choose one.';

-- The browser inserts a bare row for itself; the trigger decides every value
-- that matters. It runs with no elevated rights — it only constrains the
-- caller's own insert, granting nothing.
create function public.issue_link_code()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  raw bytea;
  generated text := '';
  i integer;
begin
  if (select count(*) from public.link_codes
      where link_codes.tester_id = new.tester_id
        and link_codes.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Too many link codes requested. Wait a while and try again.';
  end if;
  raw := extensions.gen_random_bytes(8);
  for i in 0..7 loop
    generated := generated
      || substr(alphabet, (get_byte(raw, i) % length(alphabet)) + 1, 1);
  end loop;
  new.code := generated;
  new.created_at := now();
  new.expires_at := now() + interval '15 minutes';
  new.claimed_at := null;
  return new;
end;
$$;

create trigger link_codes_issue
  before insert on public.link_codes
  for each row execute function public.issue_link_code();

-- === devices: the app's revocable report link ==============================

create table public.devices (
  id bigint generated always as identity primary key,
  tester_id uuid not null references public.beta_testers(tester_id) on delete restrict,
  install_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label text check (label is null or char_length(label) <= 120),
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create index devices_tester_id_linked_at_idx
  on public.devices (tester_id, linked_at desc);

comment on table public.devices is
  'One row per linked desktop install. The app holds an opaque token; only '
  'its SHA-256 lands here, so a database read cannot impersonate a device. '
  'revoked_at non-null ends the link; the desktop app itself stays account-free.';

-- === crash reports =========================================================

create table public.crash_reports (
  id bigint generated always as identity primary key,
  tester_id uuid references public.beta_testers(tester_id) on delete set null,
  device_id bigint references public.devices(id) on delete set null,
  install_id uuid not null,
  app_version text not null check (char_length(app_version) between 1 and 40),
  os_version text check (os_version is null or char_length(os_version) <= 120),
  arch text check (arch is null or char_length(arch) <= 40),
  kind text not null check (kind in ('exception', 'crash', 'startup_failure')),
  summary text not null check (char_length(summary) between 3 and 300),
  detail text not null check (char_length(detail) between 1 and 20000),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{16}$'),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  status text not null default 'new'
    check (status in ('new', 'seen', 'fixed', 'ignored'))
);

create index crash_reports_tester_id_created_at_idx
  on public.crash_reports (tester_id, created_at desc);
create index crash_reports_fingerprint_created_at_idx
  on public.crash_reports (fingerprint, created_at desc);
create index crash_reports_install_id_created_at_idx
  on public.crash_reports (install_id, created_at desc);

comment on table public.crash_reports is
  'Crash and failure reports sent by the desktop app, only with reporting '
  'turned on there. Content is scrubbed on the device before sending: no '
  'audio, no track names, no usernames. Written only by the crash-report and '
  'submit-report Edge Functions, which validate and rate-limit.';

-- === beta_feedback gains an app-side source ================================

alter table public.beta_feedback
  add column source text not null default 'web' check (source in ('web', 'app')),
  add column install_id uuid,
  add column crash_report_id bigint references public.crash_reports(id) on delete set null,
  add column log_excerpt text check (log_excerpt is null or char_length(log_excerpt) <= 10000);

comment on column public.beta_feedback.source is
  'web = dashboard form; app = the desktop Report a Problem page, inserted '
  'by the submit-report Edge Function through a linked device.';

-- Browser inserts stay possible but can no longer claim to be the app or
-- attach app-only fields; the service role is not subject to this policy.
drop policy "Active testers can submit their own feedback" on public.beta_feedback;
create policy "Active testers can submit their own feedback"
on public.beta_feedback for insert
to authenticated
with check (
  exists (
    select 1 from public.beta_testers
    where beta_testers.tester_id = beta_feedback.tester_id
      and beta_testers.auth_user_id = (select auth.uid())
      and beta_testers.status = 'active'
  )
  and beta_feedback.source = 'web'
  and beta_feedback.install_id is null
  and beta_feedback.crash_report_id is null
  and beta_feedback.log_excerpt is null
);

-- === row level security ====================================================

alter table public.purchases enable row level security;
alter table public.entitlements enable row level security;
alter table public.builds enable row level security;
alter table public.link_codes enable row level security;
alter table public.devices enable row level security;
alter table public.crash_reports enable row level security;

revoke all on table public.purchases from anon, authenticated;
revoke all on table public.entitlements from anon, authenticated;
revoke all on table public.builds from anon, authenticated;
revoke all on table public.link_codes from anon, authenticated;
revoke all on table public.devices from anon, authenticated;
revoke all on table public.crash_reports from anon, authenticated;
revoke all on sequence public.purchases_id_seq from anon, authenticated;
revoke all on sequence public.entitlements_id_seq from anon, authenticated;
revoke all on sequence public.builds_id_seq from anon, authenticated;
revoke all on sequence public.devices_id_seq from anon, authenticated;
revoke all on sequence public.crash_reports_id_seq from anon, authenticated;

grant select on table public.purchases to authenticated;
grant select on table public.entitlements to authenticated;
grant select on table public.builds to authenticated;
grant select, insert on table public.link_codes to authenticated;
grant select on table public.devices to authenticated;
grant update (revoked_at) on table public.devices to authenticated;
grant select on table public.crash_reports to authenticated;

-- Newer Supabase projects no longer auto-grant the Data API roles, and the
-- Edge Functions do all privileged writes as service_role — grant it
-- explicitly so a fresh project behaves like an old one.
grant all on table public.beta_testers,
             public.beta_known_issues,
             public.beta_feedback,
             public.purchases,
             public.entitlements,
             public.builds,
             public.link_codes,
             public.devices,
             public.crash_reports
  to service_role;
grant usage, select on all sequences in schema public to service_role;

create policy "Owners can read their own purchases"
on public.purchases for select
to authenticated
using (
  exists (
    select 1 from public.beta_testers
    where beta_testers.tester_id = purchases.tester_id
      and beta_testers.auth_user_id = (select auth.uid())
  )
);

create policy "Owners can read their own entitlements"
on public.entitlements for select
to authenticated
using (
  exists (
    select 1 from public.beta_testers
    where beta_testers.tester_id = entitlements.tester_id
      and beta_testers.auth_user_id = (select auth.uid())
  )
);

create policy "Published builds are visible to entitled accounts"
on public.builds for select
to authenticated
using (
  published = true
  and (
    channel = 'stable'
    or exists (
      select 1
      from public.entitlements
      join public.beta_testers
        on beta_testers.tester_id = entitlements.tester_id
      where beta_testers.auth_user_id = (select auth.uid())
        and beta_testers.status = 'active'
        and entitlements.entitlement = 'early_build'
        and entitlements.revoked_at is null
    )
  )
);

create policy "Accounts can request link codes for themselves"
on public.link_codes for insert
to authenticated
with check (
  exists (
    select 1 from public.beta_testers
    where beta_testers.tester_id = link_codes.tester_id
      and beta_testers.auth_user_id = (select auth.uid())
      and beta_testers.status = 'active'
  )
);

create policy "Accounts can read their own link codes"
on public.link_codes for select
to authenticated
using (
  exists (
    select 1 from public.beta_testers
    where beta_testers.tester_id = link_codes.tester_id
      and beta_testers.auth_user_id = (select auth.uid())
  )
);

create policy "Accounts can see their own linked devices"
on public.devices for select
to authenticated
using (
  exists (
    select 1 from public.beta_testers
    where beta_testers.tester_id = devices.tester_id
      and beta_testers.auth_user_id = (select auth.uid())
  )
);

-- The only browser write to devices: revoking one's own. The column grant
-- limits the reachable columns to revoked_at, and the check keeps a revoked
-- device revoked — null would re-arm the token.
create policy "Accounts can revoke their own devices"
on public.devices for update
to authenticated
using (
  exists (
    select 1 from public.beta_testers
    where beta_testers.tester_id = devices.tester_id
      and beta_testers.auth_user_id = (select auth.uid())
  )
)
with check (revoked_at is not null);

create policy "Accounts can read their own crash reports"
on public.crash_reports for select
to authenticated
using (
  exists (
    select 1 from public.beta_testers
    where beta_testers.tester_id = crash_reports.tester_id
      and beta_testers.auth_user_id = (select auth.uid())
  )
);

-- === storage: the private bucket gated builds live in ======================

insert into storage.buckets (id, name, public)
values ('builds', 'builds', false)
on conflict (id) do nothing;

commit;
