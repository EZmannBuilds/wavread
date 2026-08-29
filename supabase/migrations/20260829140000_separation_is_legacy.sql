-- Separation is a legacy feature, so the catalog stops having editions.
--
-- The edition column existed for one reason: an Engine build carried a Demucs
-- backend whose pretrained weights Meta licenses for scientific purposes only,
-- so that build could be given away and never sold, and the catalog needed a
-- word for the difference. WavRead now takes stems from the user and ships no
-- separation model at all. With one kind of build there is nothing for the
-- column to distinguish, so it goes.
--
-- Recorded before it goes: which builds actually carry Demucs. All three do —
-- verified on 2026-08-29 by fetching each artifact, matching it against the
-- sha256 in its own row and mounting it. Dropping the column without writing
-- that down somewhere would lose the only machine-readable trace of it, and
-- these three files are still in the storage bucket. notes is where a human
-- reading this catalog in a year will look.

begin;

update public.builds
set notes = notes || E'\n\nContains the Demucs separation backend (demucs 4.0.1, '
                     'openunmix, dora, treetable) and LGPL-3.0 lameenc, and '
                     'fetches Meta''s pretrained weights from '
                     'dl.fbaipublicfiles.com on first separation. Those weights '
                     'are licensed for scientific purposes only, so this build '
                     'may be given away but never sold. Unpublished 2026-08-29 '
                     'and superseded: WavRead ships no separation model.'
where edition = 'engine';

alter table public.builds drop constraint builds_engine_is_never_sold;
alter table public.builds drop constraint builds_desktop_is_priced;
alter table public.builds drop column edition;

-- price_cents stays `>= 0` rather than returning to `> 0`. The three legacy
-- builds sit at zero, and zero is the honest present price of something that
-- may not be sold — putting 500 back would say they are purchasable, which is
-- the claim this whole episode was about. A future free tier would still be a
-- deliberate act: publishing a build at zero, not a default anyone falls into.
comment on column public.builds.price_cents is
  'What this build costs. Zero means it is not for sale — as the three '
  'pre-2026-08-29 builds are, because they carry a separation backend whose '
  'weights may not be sold. A published build with a price is the normal case.';

-- The access rule loses the edition test it gained this morning; with no
-- editions there is nothing to test. Otherwise unchanged: the single
-- definition the RLS policy and download-build both consult.
create or replace function public.has_build_access(account uuid, build bigint)
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

commit;
