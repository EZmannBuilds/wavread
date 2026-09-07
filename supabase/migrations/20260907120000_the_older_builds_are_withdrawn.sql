-- Only the current build is offered.
--
-- 1.4.48 and 1.4.49 were published within an hour of each other on 2026-09-06,
-- which left three builds downloadable at once — those two and 1.4.46 from
-- August. Erik withdrew the older two on 2026-09-07. What a purchase buys is
-- the current build; a menu of superseded ones helps nobody, and every one of
-- them is a version someone could be running when they ask for help.
--
-- Withdrawn, not deleted. The disk images stay in the private bucket and the
-- rows keep version, sha256, size and released_at, which is the record of what
-- was signed and notarised. Publishing one again is a single update if a reason
-- ever appears. The Demucs-era artifacts were deleted instead, which was a
-- different decision for a different reason: those could never be sold again.
--
-- Scoped by version rather than by id, because serials differ on a branch
-- database and unpublishing the wrong row is the failure this file prevents.

update public.builds
   set published = false
 where version in ('1.4.46', '1.4.48')
   and published is distinct from false;

-- One published build at a time, from here on. `published` now decides two
-- things: what an account may download, and what the desktop updater announces
-- as newest. A second published build is not just an extra download — it is a
-- second answer to "what version is current", and the whole reason the updater
-- was moved onto this table was to stop that question having two answers.
do $$
declare
  live text;
  n int;
begin
  select string_agg(version, ', ' order by version), count(*)
    into live, n
    from public.builds
   where published = true;

  if n <> 1 then
    raise exception 'expected exactly one published build, found %: %',
                    n, coalesce(live, 'none');
  end if;
end $$;
