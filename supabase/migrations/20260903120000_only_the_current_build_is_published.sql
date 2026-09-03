-- Only the current build is published.
--
-- Migration 20260829140000 removed stem separation and wrote "Unpublished"
-- into builds.notes for the three Demucs-era builds — but it never set
-- published = false, and in the same transaction it dropped the `edition`
-- column whose 'desktop' guard had made that state unrepresentable. So the
-- fact lived in a sentence in a notes string and nowhere a query could check.
--
-- Read live on 2026-09-03: all three are in fact published = false, and four
-- independent gates agree that they were never reachable — the single RLS
-- policy on builds requires published = true, download-build refuses an
-- unpublished row a second time, the builds bucket is private, and
-- storage.objects carries no policies at all. There was no exposure.
--
-- This migration changes no row today. It exists so the state is reproducible
-- from source rather than from a sentence, and so a replay onto a fresh
-- database cannot arrive at a different answer than production. 1.4.8, 1.4.37
-- and 1.4.39 bundle a separation model WavRead no longer ships, under a
-- licence that does not permit distributing it; they must not become
-- downloadable again by accident.

update public.builds
   set published = false
 where version in ('1.4.8', '1.4.37', '1.4.39')
   and published is distinct from false;

-- Belt and braces: nothing that predates the separation removal is publishable.
-- Scoped by version rather than by id, because serials differ on a branch
-- database and mispricing or republishing the wrong row is the failure this
-- whole file exists to prevent.

do $$
declare
  leaked text;
begin
  select string_agg(version, ', ' order by version)
    into leaked
    from public.builds
   where published = true
     and version in ('1.4.8', '1.4.37', '1.4.39');

  if leaked is not null then
    raise exception 'Demucs-era builds are still published: %', leaked;
  end if;
end $$;
