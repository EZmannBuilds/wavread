alter table public.builds
  add column platform text not null default 'macos'
  constraint builds_platform_check check (platform in ('macos', 'windows'));

alter table public.builds drop constraint builds_version_channel_key;
alter table public.builds
  add constraint builds_version_channel_platform_key unique (version, channel, platform);
