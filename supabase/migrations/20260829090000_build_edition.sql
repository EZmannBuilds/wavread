-- Which edition a build is, and the rule that an Engine build is never sold.
--
-- Found on 2026-08-29: every build in this catalog is the Engine edition, and
-- 1.4.39 was published and on sale at $5. This was not inferred. Each of the
-- three artifacts was fetched, checked against the sha256 recorded in its own
-- row, mounted, and found to contain demucs 4.0.1, openunmix, dora, treetable
-- and lameenc. The pretrained weights are not inside the bundle — the shipped
-- demucs/remote/htdemucs.yaml points at dl.fbaipublicfiles.com and they arrive
-- on first run — but LICENSING.md names that as the same blocked case, in as
-- many words: selling WavRead with separation "bundled or auto-downloaded".
-- lameenc is LGPL-3.0 and has no business in a proprietary paid bundle either.
--
-- Nobody chose this. wavread.spec defaults WAVREAD_EDITION to "engine", no
-- build or signing script ever set it, and this catalog had no column that
-- could contradict the artifact. So the edition that may not be sold was the
-- one you got by not thinking about it, and no part of the system was in a
-- position to notice. The column below gives the catalog a word for the
-- distinction. The constraints make the sale of an Engine build a state the
-- database will not hold, so that noticing is no longer required.

begin;

alter table public.builds
  add column edition text not null default 'desktop'
    check (edition in ('engine', 'desktop'));

comment on column public.builds.edition is
  'engine — carries a separation backend, and with it Meta''s weights, which '
  'are licensed for scientific purposes only; may be given away, never sold. '
  'desktop — no separation backend and no LGPL lameenc; the edition that may '
  'be sold. This is a licensing constraint, not a product tier: which artifact '
  'an account may have is decided by law before it is decided by price.';

-- 'desktop' is the safe default for rows added from here on, because from here
-- on the build path states its edition and the publish step checks it. These
-- three rows predate both, so they are set to what inspection actually found
-- rather than to what the default would prefer.
update public.builds set edition = 'engine';

-- A price of zero used to be impossible, which was the right rule while every
-- build was for sale. It is the wrong rule now: an Engine build has to be able
-- to cost nothing, because costing something is precisely what it may not do.
-- One check becomes three, and together they say — a desktop build always has
-- a price, an engine build never does, and neither can be written otherwise.
alter table public.builds drop constraint builds_price_cents_check;

alter table public.builds
  add constraint builds_price_cents_check
    check (price_cents >= 0);

-- Zeroing the price of the three Engine rows does not erase what was charged.
-- purchases.amount_cents is the receipt and keeps its 500; builds.price_cents
-- is the present asking price, and the honest present answer for a build that
-- may not be sold is nothing.
update public.builds set price_cents = 0 where edition = 'engine';

alter table public.builds
  add constraint builds_desktop_is_priced
    check (edition <> 'desktop' or price_cents > 0);

alter table public.builds
  add constraint builds_engine_is_never_sold
    check (edition <> 'engine' or price_cents = 0);

comment on constraint builds_engine_is_never_sold on public.builds is
  'The licensing rule, held by the database rather than by whoever remembers '
  'it: an Engine build carries weights that may not be sold, so it may not '
  'carry a price. Nothing downstream has to be trusted to check.';

-- The access rule gains the one thing it could not previously say. An
-- entitlement is a record of payment, so resolving one against an Engine build
-- would hand over the unsellable artifact as the thing that was bought. It
-- stays a single definition that the RLS policy and download-build both use.
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
      -- No entitlement resolves to an Engine build, however it was acquired.
      and b.edition = 'desktop'
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
  'Whether an account may download one build: the build is the sellable '
  'edition, and the account has contributor standing, an entitlement for that '
  'build, or a legacy all-access entitlement. The single definition the RLS '
  'policy and the download function both use.';

commit;
