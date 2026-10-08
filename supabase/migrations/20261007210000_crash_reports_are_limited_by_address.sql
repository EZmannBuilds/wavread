-- crash-report takes reports from installs that have no account yet, so it
-- cannot ask who is sending. Its only limit was per install id, and the install
-- id is whatever the sender writes in the body: a script that wrote a fresh one
-- into every request could store reports without end, each up to the 20,000
-- characters the detail column allows.
--
-- These counters add two limits a sender cannot rewrite. One per network
-- address, keyed by an HMAC digest the function computes (the address itself
-- never reaches the database), and one for the whole service, so a flood from
-- many addresses costs at most an hour of reports rather than the database.
-- Every row expires with the hour it counts and is deleted on the next call.
--
-- The numbers: an honest install is already held to 20 reports an hour, so 30
-- per address leaves room for two installs behind one connection. 200 an hour
-- across everyone is far above what WavRead's installed base has ever sent,
-- and the app keeps a refused report and retries it later, so reaching either
-- limit delays honest reports rather than losing them.
create table public.wavread_report_rate_limits (
  scope text not null,
  bucket_start timestamptz not null,
  expires_at timestamptz not null,
  attempts integer not null default 1,
  primary key (scope, bucket_start)
);
create index wavread_report_rate_expiry on public.wavread_report_rate_limits (expires_at);
alter table public.wavread_report_rate_limits enable row level security;
revoke all on table public.wavread_report_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.wavread_report_rate_limits to service_role;

-- True when one more crash report may be stored now. A sender already over its
-- own limit is refused before it can use up the service-wide count.
create function public.take_crash_report_slot(address_digest text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare from_address integer; from_everyone integer;
begin
  if address_digest is null or address_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid address digest';
  end if;
  delete from public.wavread_report_rate_limits where expires_at < now();
  insert into public.wavread_report_rate_limits as limits (scope, bucket_start, expires_at)
    values ('crash:address:' || address_digest, date_trunc('hour', now()), date_trunc('hour', now()) + interval '1 hour')
    on conflict (scope, bucket_start) do update set attempts = least(limits.attempts + 1, 1000000)
    returning attempts into from_address;
  if from_address > 30 then return false; end if;
  insert into public.wavread_report_rate_limits as limits (scope, bucket_start, expires_at)
    values ('crash:everyone', date_trunc('hour', now()), date_trunc('hour', now()) + interval '1 hour')
    on conflict (scope, bucket_start) do update set attempts = least(limits.attempts + 1, 1000000)
    returning attempts into from_everyone;
  return from_everyone <= 200;
end;
$$;
revoke all on function public.take_crash_report_slot(text) from public, anon, authenticated;
grant execute on function public.take_crash_report_slot(text) to service_role;
comment on table public.wavread_report_rate_limits is
  'Hourly crash-report counters keyed by HMAC digests of network addresses, plus one service-wide count. Never an address; every row expires within the hour.';
