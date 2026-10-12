-- Sole grant authority is the existing, verified founder identity, never client metadata.
create schema if not exists wavread_private;
revoke all on schema wavread_private from public, anon;
grant usage on schema wavread_private to authenticated;
create table wavread_private.licence_grants (
 id bigint generated always as identity primary key,
 actor_id uuid not null references auth.users(id),
 tester_id uuid not null references public.accounts(tester_id),
 entitlement_id bigint not null references public.entitlements(id),
 recipient_email text not null,
 created_at timestamptz not null default now(),
 unique(entitlement_id)
);
alter table wavread_private.licence_grants enable row level security;
revoke all on wavread_private.licence_grants from public,anon,authenticated;
create function wavread_private.owner_can_grant() returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() = '58940f22-aebc-4561-81c8-73cffeda9259'::uuid
 and exists(select 1 from auth.users u join public.accounts a on a.auth_user_id=u.id
   where u.id=auth.uid() and lower(u.email)='erikiszxxn@gmail.com'
   and u.email_confirmed_at is not null and a.status='active')
 and exists(select 1 from auth.sessions s where s.user_id=auth.uid()
   and s.id::text=auth.jwt()->>'session_id');
$$;
revoke all on function wavread_private.owner_can_grant() from public,anon;
grant execute on function wavread_private.owner_can_grant() to authenticated;
create function public.owner_licence_status() returns boolean
language sql stable security invoker set search_path='' as $$
 select coalesce(wavread_private.owner_can_grant(),false);
$$;
revoke all on function public.owner_licence_status() from public,anon;
grant execute on function public.owner_licence_status() to authenticated;
create function wavread_private.grant_licence(recipient_email text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 target_email text := lower(btrim(recipient_email));
 target_auth uuid; target_account public.accounts%rowtype;
 entitlement_id bigint; already_owned boolean;
begin
 if not coalesce(wavread_private.owner_can_grant(),false) then
  raise exception 'Only the designated owner may grant licences' using errcode='42501';
 end if;
 if target_email is null or length(target_email)>254 or target_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
  raise exception 'Enter a valid recipient email' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(target_email,0));
 select id into target_auth from auth.users where lower(email)=target_email;
 if target_auth is null then raise exception 'Recipient sign-in account is not ready' using errcode='22023'; end if;
 select * into target_account from public.accounts where email=target_email for update;
 if found then
  if target_account.status <> 'active' then raise exception 'This account is inactive; review its status first' using errcode='22023'; end if;
  if target_account.auth_user_id is not null and target_account.auth_user_id<>target_auth then
   raise exception 'Account identity mismatch' using errcode='22023';
  end if;
  update public.accounts set auth_user_id=target_auth where tester_id=target_account.tester_id and auth_user_id is null;
 else
  insert into public.accounts(email,status,auth_user_id) values(target_email,'active',target_auth) returning * into target_account;
 end if;
 select id into entitlement_id from public.entitlements where tester_id=target_account.tester_id
  and entitlement='early_build' and build_version is null and revoked_at is null;
 already_owned := entitlement_id is not null or target_account.free_updates;
 if not already_owned then
  insert into public.entitlements(tester_id,entitlement,source,build_version)
   values(target_account.tester_id,'early_build','grant',null) returning id into entitlement_id;
  insert into wavread_private.licence_grants(actor_id,tester_id,entitlement_id,recipient_email)
   values(auth.uid(),target_account.tester_id,entitlement_id,target_email);
 end if;
 return jsonb_build_object('email',target_email,'already_owned',already_owned,'granted',not already_owned);
end;
$$;
revoke all on function wavread_private.grant_licence(text) from public,anon;
grant execute on function wavread_private.grant_licence(text) to authenticated;
create function public.owner_grant_licence(recipient_email text) returns jsonb
language sql security invoker set search_path='' as $$
 select wavread_private.grant_licence(recipient_email);
$$;
revoke all on function public.owner_grant_licence(text) from public,anon;
grant execute on function public.owner_grant_licence(text) to authenticated;
