-- Profiles, password standing, and article submissions.
--
-- FILE ONLY. Do not apply this to the hosted project from this branch. It
-- lands after Erik approves, in the order the PR lists (migration, then the
-- functions, then the Auth settings, then the site). Apply it with
-- apply_migration or the SQL editor, never with db push: production's
-- migration history does not match this directory's file names.
--
-- What it adds:
--
--   accounts.display_name / bio / public_slug / profile_updated_at
--       A thin public profile on the existing account row, edited by its
--       holder through a column-limited grant. A profile is public only once
--       its holder picks a public_slug.
--   public.article_submissions
--       Articles written in the site's editor, from draft to published. The
--       writer edits through RLS; review and publishing are the service
--       role's alone, and a trigger enforces the status moves for every role.
--   public.article_publish_queue
--       The Markdown file a published article becomes, waiting for the owner
--       to copy it into content/articles/community/ and build. Service role
--       only.
--   public.ensure_my_account()
--       Gives a confirmed sign-in without an account row (a writer who signed
--       up before buying) a plain account: no purchase, no entitlement.
--   public.account_password_status()
--       Whether the caller's sign-in has a password yet, so /account can offer
--       "Set a password" to buyers who only ever used email links.
--   public.public_profile(slug)
--       The one public read: a profile's name, bio and published articles.
--       Never an email, never an account id.
--   public.publish_approved_submission(...)
--       The only way an article becomes published: approved first, then this,
--       called by the publish function with the service role.
--
-- Approval never publishes. Nothing in this file lets a writer, a reviewer's
-- decision, or the browser reach "published"; only an explicit publish call on
-- an approved article does.
--
-- The account binding rules are the ones the licence grant already follows
-- (20260911002958): the email is the identity, a binding is set only when
-- there is none, and an account already bound to a different sign-in is never
-- rebound. Entitlements hang off tester_id and are untouched by any of this.

begin;

-- === profiles ==============================================================

alter table public.accounts
  add column display_name text
    constraint accounts_display_name_check check (
      display_name is null
      or (display_name = btrim(display_name) and char_length(display_name) between 1 and 80)
    ),
  add column bio text
    constraint accounts_bio_check check (bio is null or char_length(bio) <= 1000),
  -- The address of the public profile, /u/<slug>. Reserved words keep a writer
  -- from taking a name that reads as the site's own voice.
  add column public_slug text
    constraint accounts_public_slug_check check (
      public_slug is null
      or (
        public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        and char_length(public_slug) between 3 and 40
        and public_slug <> all (array[
          'admin', 'account', 'accounts', 'articles', 'community', 'staff',
          'support', 'team', 'help', 'owner', 'index', 'wavread', 'ezmannbuilds'
        ])
      )
    ),
  add column profile_updated_at timestamptz,
  add constraint accounts_public_slug_key unique (public_slug);

comment on column public.accounts.public_slug is
  'The holder''s public profile address (/u/<slug>), or null for no public '
  'profile. Setting it is opting in: public_profile() finds nothing without it.';

-- The server decides when a profile last changed; the browser cannot write it.
create function public.stamp_profile_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.display_name, new.bio, new.public_slug)
     is distinct from (old.display_name, old.bio, old.public_slug) then
    new.profile_updated_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.stamp_profile_update() from public, anon, authenticated;

create trigger accounts_profile_updated
  before update on public.accounts
  for each row execute function public.stamp_profile_update();

-- The holder edits three columns of their own row and nothing else: not the
-- email, the status, contributor standing or the sign-in binding. The same
-- shape as revoking one's own device (20260827150000).
grant update (display_name, bio, public_slug) on table public.accounts to authenticated;

create policy "Account holders edit their own profile"
on public.accounts for update
to authenticated
using ((select auth.uid()) = auth_user_id and status = 'active')
with check ((select auth.uid()) = auth_user_id and status = 'active');

-- === a confirmed sign-in without an account ================================

-- A writer can sign up before buying. Their sign-in exists; their account row
-- does not, and nothing in the browser may create one. This does, for the
-- caller only, once their email is confirmed: it finds the account for that
-- email and binds it if it has no sign-in yet, or creates a plain account
-- with no purchase and no entitlement. An account bound to someone else is
-- refused, never rebound. It takes the same per-email lock the licence grant
-- and the trial take, so the three cannot race each other into two rows.
create function wavread_private.ensure_account()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  caller_email text;
  confirmed timestamptz;
  existing public.accounts%rowtype;
begin
  if caller is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select lower(btrim(u.email)), u.email_confirmed_at
    into caller_email, confirmed
    from auth.users u
   where u.id = caller;
  if caller_email is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if confirmed is null then
    raise exception 'Confirm your email address first' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller_email, 0));

  select * into existing from public.accounts where auth_user_id = caller;
  if found then
    return jsonb_build_object('tester_id', existing.tester_id, 'created', false, 'bound', false);
  end if;

  select * into existing from public.accounts where email = caller_email for update;
  if found then
    if existing.auth_user_id is not null then
      raise exception 'This email''s account is bound to a different sign-in' using errcode = '22023';
    end if;
    update public.accounts set auth_user_id = caller
     where tester_id = existing.tester_id and auth_user_id is null;
    return jsonb_build_object('tester_id', existing.tester_id, 'created', false, 'bound', true);
  end if;

  insert into public.accounts (email, status, auth_user_id)
  values (caller_email, 'active', caller)
  returning * into existing;
  return jsonb_build_object('tester_id', existing.tester_id, 'created', true, 'bound', true);
end;
$$;
revoke all on function wavread_private.ensure_account() from public, anon;
grant execute on function wavread_private.ensure_account() to authenticated;

create function public.ensure_my_account()
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select wavread_private.ensure_account();
$$;
revoke all on function public.ensure_my_account() from public, anon;
grant execute on function public.ensure_my_account() to authenticated;

-- === password standing =====================================================

-- Whether the caller's own sign-in has a password. Buyers and trialists are
-- created by the webhook and the trial with email links only, so most
-- accounts have none until they set one on /account. Answers a boolean about
-- the caller and nothing else. plpgsql, so the body is resolved when it runs
-- rather than when it is created.
create function wavread_private.caller_has_password()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce(
    (select coalesce(u.encrypted_password, '') <> '' from auth.users u where u.id = auth.uid()),
    false
  );
end;
$$;
revoke all on function wavread_private.caller_has_password() from public, anon;
grant execute on function wavread_private.caller_has_password() to authenticated;

create function public.account_password_status()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select wavread_private.caller_has_password();
$$;
revoke all on function public.account_password_status() from public, anon;
grant execute on function public.account_password_status() to authenticated;

-- === article submissions ===================================================

create table public.article_submissions (
  id uuid primary key default gen_random_uuid(),
  author_tester_id uuid not null references public.accounts (tester_id) on delete restrict,
  title text not null default ''
    constraint article_submissions_title_check check (char_length(title) <= 140),
  summary text not null default ''
    constraint article_submissions_summary_check check (char_length(summary) <= 300),
  lanes text[] not null default '{}'
    constraint article_submissions_lanes_check check (
      lanes <@ array['developer', 'ai', 'musician']::text[] and cardinality(lanes) <= 3
    ),
  body_markdown text not null default ''
    constraint article_submissions_body_check check (char_length(body_markdown) <= 40000),
  status text not null default 'draft'
    constraint article_submissions_status_check check (
      status in ('draft', 'pending', 'needs_changes', 'approved', 'rejected', 'published')
    ),
  reviewer_notes text
    constraint article_submissions_reviewer_notes_check check (
      reviewer_notes is null or char_length(reviewer_notes) <= 4000
    ),
  published_slug text
    constraint article_submissions_published_slug_check check (
      published_slug is null
      or (published_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
          and char_length(published_slug) between 3 and 80
          and published_slug <> 'index')
    ),
  published_path text
    constraint article_submissions_published_path_check check (
      published_path is null
      or published_path = 'content/articles/community/' || published_slug || '.md'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  published_at timestamptz,
  -- Anything past a draft was complete when it was submitted. The functions
  -- say what is missing in sentences; this is the floor they cannot go under.
  constraint article_submissions_ready_check check (
    status = 'draft'
    or (char_length(btrim(title)) >= 3
        and char_length(btrim(summary)) >= 20
        and cardinality(lanes) >= 1
        and char_length(btrim(body_markdown)) >= 200)
  ),
  constraint article_submissions_submitted_check check (status = 'draft' or submitted_at is not null),
  -- Published, and only published, carries where it went.
  constraint article_submissions_published_check check (
    (status = 'published') = (published_slug is not null)
    and (published_slug is null) = (published_path is null)
    and (published_slug is null) = (published_at is null)
  )
);

comment on table public.article_submissions is
  'Articles written in the site''s editor. The writer creates and edits drafts '
  'and submits them through RLS; review (needs_changes, approved, rejected) and '
  'publishing are the service role''s, through article-review and '
  'article-publish-approved. Approval never publishes. The '
  'article_submissions_guard trigger enforces the status moves for every role.';

create index article_submissions_status_idx
  on public.article_submissions (status, submitted_at);
create index article_submissions_author_idx
  on public.article_submissions (author_tester_id, updated_at desc);
create unique index article_submissions_published_slug_key
  on public.article_submissions (published_slug)
  where published_slug is not null;

-- The status machine. The same table as TRANSITIONS in
-- supabase/functions/_shared/submissions.mjs; tests/articles-db.test.mjs walks
-- every pair and checks the two agree.
--
--   author (the signed-in writer, through RLS)
--     draft, needs_changes  ->  draft, pending
--   reviewer (service role, or the database owner in the SQL editor)
--     the author's moves, and
--     pending   ->  needs_changes, approved, rejected
--     approved  ->  needs_changes, rejected, published
--   rejected and published are final.
--
-- Once an article leaves the writer's hands its words are fixed: what is
-- approved is what is published.
create function public.article_submissions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  author boolean := current_user in ('authenticated', 'anon');
  allowed text[];
  open_count integer;
  pending_count integer;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A new article starts as a draft' using errcode = '55000';
    end if;
    select count(*) into open_count
      from public.article_submissions s
     where s.author_tester_id = new.author_tester_id
       and s.status in ('draft', 'pending', 'needs_changes');
    if open_count >= 25 then
      raise exception 'You have 25 unfinished articles. Finish or delete one before starting another.'
        using errcode = '54000';
    end if;
    new.reviewer_notes := null;
    new.submitted_at := null;
    new.reviewed_at := null;
    new.published_slug := null;
    new.published_path := null;
    new.published_at := null;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  new.id := old.id;
  new.author_tester_id := old.author_tester_id;
  new.created_at := old.created_at;

  allowed := case old.status
    when 'draft' then array['draft', 'pending']
    when 'needs_changes' then array['draft', 'pending']
    else array[]::text[]
  end;
  if not author then
    allowed := allowed || case old.status
      when 'pending' then array['needs_changes', 'approved', 'rejected']
      when 'approved' then array['needs_changes', 'rejected', 'published']
      else array[]::text[]
    end;
  end if;
  if not (new.status = any (allowed)) then
    raise exception 'An article that is % cannot become %', old.status, new.status
      using errcode = '55000';
  end if;

  if old.status not in ('draft', 'needs_changes')
     and (new.title, new.summary, new.lanes, new.body_markdown)
         is distinct from (old.title, old.summary, old.lanes, old.body_markdown) then
    raise exception 'An article that is % can no longer be edited', old.status
      using errcode = '55000';
  end if;

  if new.status = 'pending' and old.status <> 'pending' then
    select count(*) into pending_count
      from public.article_submissions s
     where s.author_tester_id = new.author_tester_id
       and s.status = 'pending';
    if pending_count >= 5 then
      raise exception 'You have 5 articles waiting for review. Submit this one once one of them is reviewed.'
        using errcode = '54000';
    end if;
    new.submitted_at := now();
  end if;
  if new.status in ('needs_changes', 'approved', 'rejected') and new.status <> old.status then
    new.reviewed_at := now();
  end if;
  if new.status = 'published' and old.status <> 'published' then
    new.published_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.article_submissions_guard() from public, anon, authenticated;

create trigger article_submissions_guard
  before insert or update on public.article_submissions
  for each row execute function public.article_submissions_guard();

alter table public.article_submissions enable row level security;
revoke all on table public.article_submissions from anon, authenticated;

-- The writer's columns, and nothing a reviewer decides. Status is writable so
-- a draft can be submitted; the policies and the trigger say which values.
grant select, delete on table public.article_submissions to authenticated;
grant insert (author_tester_id, title, summary, lanes, body_markdown)
  on table public.article_submissions to authenticated;
grant update (title, summary, lanes, body_markdown, status)
  on table public.article_submissions to authenticated;
-- New tables are not exposed to the Data API roles by default any more, the
-- service role included, so the functions' access is granted by name.
grant select, insert, update on table public.article_submissions to service_role;

create policy "Authors read their own submissions"
on public.article_submissions for select
to authenticated
using (
  exists (
    select 1 from public.accounts a
    where a.tester_id = article_submissions.author_tester_id
      and a.auth_user_id = (select auth.uid())
  )
);

create policy "Active authors start their own drafts"
on public.article_submissions for insert
to authenticated
with check (
  status = 'draft'
  and exists (
    select 1 from public.accounts a
    where a.tester_id = article_submissions.author_tester_id
      and a.auth_user_id = (select auth.uid())
      and a.status = 'active'
  )
);

create policy "Authors edit and submit their own drafts"
on public.article_submissions for update
to authenticated
using (
  status in ('draft', 'needs_changes')
  and exists (
    select 1 from public.accounts a
    where a.tester_id = article_submissions.author_tester_id
      and a.auth_user_id = (select auth.uid())
      and a.status = 'active'
  )
)
with check (
  status in ('draft', 'pending')
  and exists (
    select 1 from public.accounts a
    where a.tester_id = article_submissions.author_tester_id
      and a.auth_user_id = (select auth.uid())
      and a.status = 'active'
  )
);

create policy "Authors delete their own drafts"
on public.article_submissions for delete
to authenticated
using (
  status = 'draft'
  and exists (
    select 1 from public.accounts a
    where a.tester_id = article_submissions.author_tester_id
      and a.auth_user_id = (select auth.uid())
  )
);

-- === the publish queue =====================================================

-- What a published article becomes: one Markdown file for
-- content/articles/community/. Writing to the repository from a function would
-- need a GitHub credential in the function's environment, so the file waits
-- here instead and the owner exports it (tools/export-publish-queue.mjs),
-- commits it, and builds. Service role only.
create table public.article_publish_queue (
  id bigint generated always as identity primary key,
  submission_id uuid not null unique references public.article_submissions (id) on delete restrict,
  slug text not null unique,
  path text not null
    constraint article_publish_queue_path_check check (path = 'content/articles/community/' || slug || '.md'),
  markdown text not null
    constraint article_publish_queue_markdown_check check (char_length(markdown) between 1 and 50000),
  queued_at timestamptz not null default now(),
  exported_at timestamptz
);

comment on table public.article_publish_queue is
  'Markdown files for content/articles/community/, written by '
  'publish_approved_submission and exported by the owner with '
  'tools/export-publish-queue.mjs. Nothing reads this from the browser.';

alter table public.article_publish_queue enable row level security;
revoke all on table public.article_publish_queue from anon, authenticated;
grant select, update (exported_at) on table public.article_publish_queue to service_role;

-- The only path to "published": the article must be approved, and the slug
-- free. Status, slug, path and the queued file change in one transaction.
create function public.publish_approved_submission(target_id uuid, target_slug text, target_markdown text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.article_submissions%rowtype;
  target_path text := 'content/articles/community/' || target_slug || '.md';
begin
  select * into target from public.article_submissions where id = target_id for update;
  if not found then
    raise exception 'No article has that id' using errcode = 'P0002';
  end if;
  if target.status <> 'approved' then
    raise exception 'Only an approved article can be published; this one is %', target.status
      using errcode = '55000';
  end if;
  if exists (select 1 from public.article_submissions where published_slug = target_slug)
     or exists (select 1 from public.article_publish_queue where slug = target_slug) then
    raise exception 'That slug is taken' using errcode = '23505';
  end if;
  update public.article_submissions
     set status = 'published', published_slug = target_slug, published_path = target_path
   where id = target_id;
  insert into public.article_publish_queue (submission_id, slug, path, markdown)
  values (target_id, target_slug, target_path, target_markdown);
  return jsonb_build_object('id', target_id, 'slug', target_slug, 'path', target_path);
end;
$$;
revoke all on function public.publish_approved_submission(uuid, text, text) from public, anon, authenticated;
grant execute on function public.publish_approved_submission(uuid, text, text) to service_role;

-- === the one public read ===================================================

-- A profile by its slug: name, bio, and the titles of what its holder has
-- published. Nothing else about the account leaves the database here.
create function public.public_profile(profile_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'display_name', a.display_name,
           'bio', a.bio,
           'public_slug', a.public_slug,
           'articles', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'title', s.title,
                      'summary', s.summary,
                      'lanes', s.lanes,
                      'slug', s.published_slug,
                      'published_at', s.published_at
                    ) order by s.published_at desc)
               from public.article_submissions s
              where s.author_tester_id = a.tester_id
                and s.status = 'published'
           ), '[]'::jsonb)
         )
    from public.accounts a
   where a.public_slug = lower(btrim(profile_slug))
     and a.status = 'active';
$$;
revoke all on function public.public_profile(text) from public;
grant execute on function public.public_profile(text) to anon, authenticated;

commit;
