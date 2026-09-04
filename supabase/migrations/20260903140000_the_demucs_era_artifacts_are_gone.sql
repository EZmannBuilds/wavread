-- The Demucs-era artifacts are gone; the rows stay.
--
-- Deleted from the builds bucket on 2026-09-03, by request:
--
--   early/WavRead-1.4.8.dmg           247,112,828 bytes
--   early/WavRead-1.4.37.dmg          211,800,418 bytes
--   early/1.4.39/WavRead-1.4.39.dmg   211,847,132 bytes
--
-- (A fourth object, early/WavRead-1.4.39.dmg, went on 2026-09-03 as well. It
-- was a second, earlier build that also called itself 1.4.39 — 211,810,321
-- bytes, a different etag — which no build row had ever pointed at.)
--
-- These three bundle a separation model WavRead removed on 2026-08-29, under a
-- licence that permits giving away but not selling. They were unpublished and
-- unreachable, so this frees ~640 MB rather than closing a hole. They can never
-- be published again, which is what makes deleting the artifacts safe.
--
-- The rows are NOT deleted. They carry version, sha256, size and released_at —
-- the record of what was signed and notarised, and the only remaining way to
-- identify a copy of one of these builds if one turns up. Losing that to
-- reclaim nothing would be a bad trade.
--
-- What this migration fixes is the row claiming a file it no longer has.
-- storage_path is kept (it says where the object was) and the absence is
-- stated in notes, so a reader is not sent looking for something deleted on
-- purpose. download-build never reaches storage for these anyway: it refuses
-- on published = false first.

update public.builds
   set notes = notes || ' Artifact deleted 2026-09-03: the disk image is no '
                     || 'longer stored. The sha256 and size above remain the '
                     || 'record of the build that was signed and notarised.'
 where version in ('1.4.8', '1.4.37', '1.4.39')
   and notes not like '%Artifact deleted 2026-09-03%';

-- The live build must still have its object. This is the check that would have
-- caught a fat-fingered path in the delete loop above.

do $$
declare
  missing text;
begin
  select string_agg(b.version, ', ' order by b.version)
    into missing
    from public.builds b
   where b.published = true
     and not exists (
           select 1 from storage.objects o
            where o.bucket_id = 'builds'
              and o.name = b.storage_path);

  if missing is not null then
    raise exception 'Published build has no stored object: %', missing;
  end if;
end $$;
