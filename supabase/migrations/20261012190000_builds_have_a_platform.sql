-- A build is for a platform. Mac and Windows share one catalog, one price and
-- one set of entitlements: has_build_access matches on version, so an owner of
-- 1.5.6 can download 1.5.6 for either. What must not be shared is the answer
-- to "what is newest": the Mac updater asks latest-build with no platform and
-- must keep being told about Mac builds only, and the Windows build asks with
-- ?platform=windows.
--
-- Every existing row is a Mac disk image, so the default is macos and nothing
-- that writes rows today has to change. The version is now unique per channel
-- and platform, not per channel, so one version can exist once for each.
--
-- Applied with apply_migration on 2026-10-12, never with db push: production's
-- migration history does not match this directory's file names.

alter table public.builds
  add column platform text not null default 'macos'
  constraint builds_platform_check check (platform in ('macos', 'windows'));

alter table public.builds drop constraint builds_version_channel_key;
alter table public.builds
  add constraint builds_version_channel_platform_key unique (version, channel, platform);
