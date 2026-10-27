-- A trial downloads the trial build, and only a trial does.
--
-- The 14-day trial (20261026120000) gated downloads, but a trial copy and a
-- paid copy were the same file, and the desktop app has no account. A trial
-- that had downloaded WavRead kept a working copy after day 14. Erik's
-- decision, 2026-10-27: the trial is a separate build. It links to the account
-- once with the dashboard code, checks in every few days (link-device's
-- "standing" action), and stops starting analyses when the trial ends. Paid
-- copies are untouched and never need an account.
--
-- So every catalog row says which build it is, from the stamp the app's build
-- writes into the bundle (tools/check_build_kind.py in the app repo). Every
-- existing row is the paid build, so the default is 'full' and nothing that
-- writes rows today has to change. One version may exist once per channel,
-- platform and kind.
--
-- The access rule follows the row's kind:
--   full   contributor standing, or an active purchase or grant (never a trial)
--   trial  an active trial, and nothing else
-- A buyer is never handed the build that asks for an account, and a trial is
-- never handed the build that does not end.
--
-- File only. Apply with apply_migration after 20261026120000, never db push:
-- production's migration history does not match this directory's file names.

alter table public.builds
  add column kind text not null default 'full'
  constraint builds_kind_check check (kind in ('full', 'trial'));

alter table public.builds drop constraint builds_version_channel_platform_key;
alter table public.builds
  add constraint builds_version_channel_platform_kind_key unique (version, channel, platform, kind);

comment on column public.builds.kind is
  'full: the paid build, which has no account. trial: the 14-day trial build, '
  'which links to an account and ends. Must match the stamp inside the file.';

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
      and case b.kind
        when 'trial' then exists (
          select 1 from public.entitlements e
          where e.tester_id = t.tester_id
            and e.entitlement = 'early_build'
            and e.source = 'trial'
            and public.entitlement_is_active(e.revoked_at, e.expires_at)
        )
        else (
          t.free_updates
          or exists (
            select 1 from public.entitlements e
            where e.tester_id = t.tester_id
              and e.entitlement = 'early_build'
              and e.source <> 'trial'
              and public.entitlement_is_active(e.revoked_at, e.expires_at)
              and (e.build_version = b.version
                   or e.build_version is null)
          )
        )
      end
  );
$$;

comment on function public.has_build_access is
  'Whether an account may download one build. A paid (full) build: contributor '
  'standing, or an active purchase or grant for that build or for all builds. '
  'A trial build: an active trial. The single definition download-build uses.';
