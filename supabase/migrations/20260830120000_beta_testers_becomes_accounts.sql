-- beta_testers becomes accounts.
--
-- The name predates the product. It was written when WavRead was a free beta
-- with testers in it; the table has since become the durable identity behind a
-- paid account — it carries the email people sign in with, contributor
-- standing, and the tester_id every purchase, entitlement, device and crash
-- report hangs off. Calling that "beta_testers" tells a new reader the wrong
-- thing about what the row is, and there are no beta testers any more.
--
-- What Postgres carries across a rename by itself, because it tracks these by
-- object id rather than by name: the six foreign keys pointing here, and the
-- twelve row-level-security policies whose expressions name the table. Those
-- keep working untouched.
--
-- What it does NOT carry: has_build_access, whose body is stored as text and
-- would keep naming a table that no longer exists — failing at call time, not
-- at rename time. It is recreated below, in the same transaction, so the two
-- can never be apart.
--
-- The constraints and indexes are renamed too. Postgres leaves them alone on a
-- table rename, and a table called accounts whose primary key is called
-- beta_testers_pkey is a half-finished job that reads as a mistake later.
--
-- The column stays tester_id. It is the identity key referenced by six tables,
-- the access function, the policies and the app's own reporting client, and
-- renaming it is a wider change than renaming the table it lives in.

begin;

alter table public.beta_testers rename to accounts;

comment on table public.accounts is
  'One row per WavRead account: the email it signs in with, its status, and '
  'contributor standing. tester_id is the durable identity that purchases, '
  'entitlements, devices, link codes and crash reports all reference. Named '
  'beta_testers until 2026-08-30, when the beta it was named for had been a '
  'paid product for three days.';

alter table public.accounts rename constraint beta_testers_pkey to accounts_pkey;
alter table public.accounts rename constraint beta_testers_auth_user_id_fkey to accounts_auth_user_id_fkey;
alter table public.accounts rename constraint beta_testers_auth_user_id_key to accounts_auth_user_id_key;
alter table public.accounts rename constraint beta_testers_check to accounts_check;
alter table public.accounts rename constraint beta_testers_email_check to accounts_email_check;
alter table public.accounts rename constraint beta_testers_free_updates_note_check to accounts_free_updates_note_check;
alter table public.accounts rename constraint beta_testers_status_check to accounts_status_check;

alter index public.beta_testers_email_unique_idx rename to accounts_email_unique_idx;

-- The access rule, pointed at the table's new name. Unchanged in substance:
-- contributor standing, an entitlement for this build, or a legacy all-access
-- entitlement. It stays the single definition the RLS policy and the download
-- function both consult.
create or replace function public.has_build_access(account uuid, build bigint)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.accounts t
    join public.builds b on b.id = build
    where t.tester_id = account
      and t.status = 'active'
      and (
        t.free_updates
        or exists (
          select 1 from public.entitlements e
          where e.tester_id = t.tester_id
            and e.revoked_at is null
            and e.entitlement = 'early_build'
            and (e.build_version = b.version
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
