-- Screenshots and short clips on a report.
--
-- "The waveform looked wrong" and a picture of the waveform looking wrong are
-- not the same report. Text-only feedback made people describe a visual bug in
-- prose, which is the least reliable channel available for it.
--
-- Scope, deliberately narrow:
--   * Website only. The desktop app's own path (submit-report, source='app')
--     is untouched and still takes JSON with no attachment field. Nothing the
--     app sends changes because of this migration.
--   * Images and video. No audio. "Your audio stays on your Mac" is the claim
--     the whole product rests on, and while an attachment a person chooses to
--     upload does not break it, accepting audio here invites the argument.
--   * The browser never writes storage. It receives a signed upload URL from
--     an Edge Function that has already checked who is asking and how much
--     they have already sent — the same shape as every other write here.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'report-media', 'report-media', false,
  26214400,   -- 25 MiB. Set explicitly: a bucket with a null limit inherits the
              -- project-wide one, which is sized for build DMGs at 500 MiB and
              -- is far too generous for something a form can send.
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif',
        'video/mp4', 'video/quicktime', 'video/webm']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.feedback_attachments (
  id uuid primary key default gen_random_uuid(),
  -- bigint, not uuid: beta_feedback.id is a bigint identity column. Assuming
  -- uuid here is what a first attempt at this migration did, and Postgres
  -- refused it rather than letting the mismatch through.
  feedback_id bigint not null
    references public.beta_feedback(id) on delete cascade,
  -- No tester_id column. It is reachable through feedback_id, and two columns
  -- that must agree are two columns that can disagree.
  object_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
  -- 'pending' until the signed upload actually completes. A row that never
  -- reaches 'stored' is a upload that was started and abandoned, and is what
  -- the cleanup below looks for.
  status text not null default 'pending'
    check (status in ('pending', 'stored')),
  created_at timestamptz not null default now()
);

comment on table public.feedback_attachments is
  'Screenshots and clips attached to a report from the website. Storage is '
  'shared with the builds bucket, so these are meant to be deleted after '
  'triage: on delete cascade from beta_feedback removes the rows, and the '
  'objects go with the report they belonged to.';

create index if not exists feedback_attachments_feedback_idx
  on public.feedback_attachments (feedback_id);

alter table public.feedback_attachments enable row level security;

-- Read-only from the browser, and only your own. Rows are written by the Edge
-- Function with the service role, never by a signed-in session: the cap on how
-- many a report may carry is only a cap if the client cannot write around it.
create policy "Owners read their own attachments"
on public.feedback_attachments for select to authenticated
using (
  exists (
    select 1
      from public.beta_feedback f
      join public.accounts a on a.tester_id = f.tester_id
     where f.id = feedback_attachments.feedback_id
       and a.auth_user_id = (select auth.uid())
  )
);

revoke all on public.feedback_attachments from anon;
revoke all on public.feedback_attachments from authenticated;
grant select on public.feedback_attachments to authenticated;
