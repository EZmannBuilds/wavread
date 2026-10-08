-- A separate list: a purchase or an owner account never implies email consent.
create table public.wavread_notification_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(btrim(email))
    and length(email) between 3 and 254
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  windows_requested boolean not null default true,
  marketing_requested boolean not null default false,
  consent_version text not null default 'windows-2026-09-10',
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'unsubscribed')),
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'confirmed' or confirmed_at is not null),
  check (status <> 'unsubscribed' or unsubscribed_at is not null)
);
create table public.wavread_notification_rate_limits (
  scope text not null,
  bucket_start timestamptz not null,
  expires_at timestamptz not null,
  attempts integer not null default 1,
  primary key (scope, bucket_start)
);
create index wavread_notification_rate_expiry on public.wavread_notification_rate_limits (expires_at);
alter table public.wavread_notification_signups enable row level security;
alter table public.wavread_notification_rate_limits enable row level security;
revoke all on table public.wavread_notification_signups, public.wavread_notification_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.wavread_notification_signups, public.wavread_notification_rate_limits to service_role;

-- Only the Edge Function service role can execute this transaction or access either table.
create function public.record_wavread_notification_signup(signup_email text, marketing boolean, ip_digest text, email_digest text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare ip_attempts integer; email_attempts integer;
begin
  if ip_digest !~ '^[a-f0-9]{64}$' or email_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid rate digest';
  end if;
  delete from public.wavread_notification_rate_limits where expires_at < now();
  insert into public.wavread_notification_rate_limits as limits (scope, bucket_start, expires_at)
    values ('ip:' || ip_digest, date_trunc('hour', now()), date_trunc('hour', now()) + interval '1 hour')
    on conflict (scope, bucket_start) do update set attempts = least(limits.attempts + 1, 10000)
    returning attempts into ip_attempts;
  if ip_attempts > 10 then return false; end if;
  insert into public.wavread_notification_rate_limits as limits (scope, bucket_start, expires_at)
    values ('email:' || email_digest, date_trunc('day', now()), date_trunc('day', now()) + interval '1 day')
    on conflict (scope, bucket_start) do update set attempts = least(limits.attempts + 1, 10000)
    returning attempts into email_attempts;
  if email_attempts > 3 then return false; end if;
  insert into public.wavread_notification_signups (email, marketing_requested)
    values (signup_email, marketing) on conflict (email) do nothing;
  -- Anonymous resubmission cannot overwrite consent or reactivate an opt-out.
  return true;
end;
$$;
revoke all on function public.record_wavread_notification_signup(text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.record_wavread_notification_signup(text, boolean, text, text) to service_role;
comment on table public.wavread_notification_signups is
  'Notification requests, not verified email ownership. Campaigns require marketing_requested and a delivery workflow with confirmation and unsubscribe. Never import account emails as consent.';
