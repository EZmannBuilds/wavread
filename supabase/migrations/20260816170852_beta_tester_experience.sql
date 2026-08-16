begin;

create table public.beta_testers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  recognized_at timestamptz not null default now(),
  complimentary_release_eligible boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.beta_known_issues (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 3 and 140),
  summary text not null check (char_length(summary) between 10 and 2000),
  affected_versions text,
  status text not null default 'investigating' check (status in ('investigating', 'confirmed', 'fix_planned', 'resolved')),
  workaround text check (workaround is null or char_length(workaround) <= 2000),
  published boolean not null default false,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.beta_feedback (
  id bigint generated always as identity primary key,
  tester_id uuid not null references auth.users(id) on delete cascade,
  feedback_type text not null check (feedback_type in ('bug', 'feature', 'general')),
  title text not null check (char_length(title) between 3 and 120),
  description text not null check (char_length(description) between 20 and 4000),
  reproduction_steps text check (reproduction_steps is null or char_length(reproduction_steps) <= 3000),
  app_version text not null check (char_length(app_version) between 1 and 40),
  operating_system text check (operating_system is null or char_length(operating_system) <= 120),
  follow_up_allowed boolean not null default false,
  status text not null default 'new' check (status in ('new', 'reviewing', 'planned', 'closed')),
  created_at timestamptz not null default now()
);

create index beta_feedback_tester_id_created_at_idx on public.beta_feedback (tester_id, created_at desc);
create index beta_known_issues_published_sort_idx on public.beta_known_issues (published, sort_order);

alter table public.beta_testers enable row level security;
alter table public.beta_known_issues enable row level security;
alter table public.beta_feedback enable row level security;

revoke all on table public.beta_testers from anon, authenticated;
revoke all on table public.beta_known_issues from anon, authenticated;
revoke all on table public.beta_feedback from anon, authenticated;
revoke all on sequence public.beta_known_issues_id_seq from anon, authenticated;
revoke all on sequence public.beta_feedback_id_seq from anon, authenticated;

grant select on table public.beta_testers to authenticated;
grant select on table public.beta_known_issues to authenticated;
grant select, insert on table public.beta_feedback to authenticated;
grant usage, select on sequence public.beta_feedback_id_seq to authenticated;

create policy "Testers can read only their own eligibility"
on public.beta_testers for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Active testers can read published known issues"
on public.beta_known_issues for select
to authenticated
using (
  published = true
  and exists (
    select 1 from public.beta_testers
    where beta_testers.user_id = (select auth.uid())
      and beta_testers.status = 'active'
  )
);

create policy "Active testers can submit their own feedback"
on public.beta_feedback for insert
to authenticated
with check (
  tester_id = (select auth.uid())
  and exists (
    select 1 from public.beta_testers
    where beta_testers.user_id = (select auth.uid())
      and beta_testers.status = 'active'
  )
);

create policy "Testers can read only their own feedback"
on public.beta_feedback for select
to authenticated
using (tester_id = (select auth.uid()));

comment on table public.beta_testers is 'Server-controlled WavRead beta eligibility. Browser clients cannot insert or update tester status.';
comment on column public.beta_testers.complimentary_release_eligible is 'Future entitlement marker only; no commercial license behavior is implemented.';
comment on table public.beta_feedback is 'Minimal tester-submitted feedback protected by ownership and active-tester RLS policies.';

commit;
