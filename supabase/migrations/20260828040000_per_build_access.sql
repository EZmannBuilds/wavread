-- Early Launch pricing: each build is bought, and contributors keep theirs.
--
-- The Early Build programme sold one $5 payment for every build. The model is
-- now per build: $5 buys the build you bought, and the next one is another $5
-- — except for people who actually report problems, who keep every later
-- build for the five dollars they already paid. Nothing is free: an account
-- with no purchase and no contribution can download nothing.
--
-- Shape of the change:
--   entitlements.build_version  which build a purchase unlocked (null = the
--                               original all-access grants, honoured forever)
--   beta_testers.free_updates   contributor standing: later builds included
--   beta_testers.free_updates_note  why it was granted, in words
--
-- free_updates is set deliberately by the operator, never computed from a
-- report count in the database. A threshold that grants itself is a threshold
-- someone can farm with twenty empty reports, and the point of the exemption
-- is useful reporting, which only a person can judge.

begin;

alter table public.entitlements
  add column build_version text
    check (build_version is null or char_length(build_version) between 1 and 40);

comment on column public.entitlements.build_version is
  'The build this entitlement unlocks. NULL means an all-access entitlement '
  'from the original Early Build programme, which stays honoured — people who '
  'bought under the old terms keep what they bought.';

-- One active entitlement per account per build, rather than per account.
drop index if exists entitlements_one_active_idx;
create unique index entitlements_one_active_idx
  on public.entitlements (tester_id, entitlement, coalesce(build_version, ''))
  where revoked_at is null;

alter table public.beta_testers
  add column free_updates boolean not null default false,
  add column free_updates_note text
    check (free_updates_note is null or char_length(free_updates_note) <= 500);

comment on column public.beta_testers.free_updates is
  'Contributor standing: every later build included, for the price already '
  'paid. Granted by hand for reports that actually helped — never computed '
  'from a count, which would reward volume over usefulness.';

-- Purchases record which build the money was for, so a receipt can be matched
-- to a download years later.
alter table public.purchases
  add column build_version text
    check (build_version is null or char_length(build_version) between 1 and 40);

comment on column public.purchases.build_version is
  'The build this payment bought. NULL for the original all-access purchases.';

-- Builds may now name their own price, so a future build could cost more or
-- less without a code change. Nothing is free: the check forbids zero.
alter table public.builds
  add column price_cents integer not null default 500
    check (price_cents > 0);

comment on column public.builds.price_cents is
  'What this build costs. Always positive — the Early Launch has no free tier, '
  'and a zero here would silently create one.';

-- === the access rule, in one place ========================================
--
-- Both the browser (through RLS) and the download function must agree on who
-- may have a build. Writing it twice is how they drift apart, so it lives in
-- one function that both consult.
create function public.has_build_access(account uuid, build bigint)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.beta_testers t
    join public.builds b on b.id = build
    where t.tester_id = account
      and t.status = 'active'
      and (
        -- contributor standing covers every build
        t.free_updates
        -- an entitlement for this exact build
        or exists (
          select 1 from public.entitlements e
          where e.tester_id = t.tester_id
            and e.revoked_at is null
            and e.entitlement = 'early_build'
            and (e.build_version = b.version
                 -- legacy all-access from the original programme
                 or e.build_version is null)
        )
      )
  );
$$;

comment on function public.has_build_access is
  'Whether an account may download one build: contributor standing, an '
  'entitlement for that build, or a legacy all-access entitlement. The single '
  'definition the RLS policy and the download function both use.';

grant execute on function public.has_build_access(uuid, bigint) to authenticated, service_role;

-- Published builds are listed to any signed-in account — people need to see
-- what exists in order to buy it — but the list says nothing about access,
-- and the file itself is only ever handed out by download-build.
drop policy "Published builds are visible to entitled accounts" on public.builds;
create policy "Published builds are visible to signed-in accounts"
on public.builds for select
to authenticated
using (
  published = true
  and exists (
    select 1 from public.beta_testers t
    where t.auth_user_id = (select auth.uid())
      and t.status = 'active'
  )
);

commit;
