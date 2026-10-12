-- Owner lookup and reversible complimentary-grant controls. Purchases are read-only.
create function wavread_private.manage_licence(recipient_email text, operation text default 'lookup') returns jsonb
language plpgsql security definer set search_path='' as $$
declare target_email text := lower(btrim(recipient_email)); result jsonb;
begin
 if not coalesce(wavread_private.owner_can_grant(),false) then
  raise exception 'Owner access required' using errcode='42501';
 end if;
 if operation not in ('lookup','revoke','restore') or target_email is null or length(target_email)>254 or target_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
  raise exception 'Invalid email or operation' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(target_email,0));
 if operation='revoke' then
  update public.entitlements e set revoked_at=now()
   from wavread_private.licence_grants g
   where e.id=g.entitlement_id and g.recipient_email=target_email and e.source='grant' and e.revoked_at is null;
 elsif operation='restore' then
  -- Restore the latest grant only; earlier grant history remains revoked.
  update public.entitlements e set revoked_at=null
   where e.id=(select g.entitlement_id from wavread_private.licence_grants g
     where g.recipient_email=target_email order by g.id desc limit 1)
     and e.source='grant' and not exists (
       select 1 from public.entitlements a where a.tester_id=e.tester_id
       and a.entitlement=e.entitlement and a.build_version is not distinct from e.build_version
       and a.revoked_at is null);
 end if;
 select jsonb_build_object('email',target_email,'operation',operation,
  'account_status',a.status,'free_updates',a.free_updates,
  'licences',coalesce((select jsonb_agg(jsonb_build_object('source',e.source,'build_version',e.build_version,
     'granted_at',e.granted_at,'revoked_at',e.revoked_at,
     'owner_grant',exists(select 1 from wavread_private.licence_grants g where g.entitlement_id=e.id)))
     from public.entitlements e where e.tester_id=a.tester_id),'[]'::jsonb))
 into result from public.accounts a where a.email=target_email;
 return coalesce(result,jsonb_build_object('email',target_email,'account_status','not found','licences','[]'::jsonb));
end;
$$;
revoke all on function wavread_private.manage_licence(text,text) from public,anon;
grant execute on function wavread_private.manage_licence(text,text) to authenticated;
create function public.owner_manage_licence(recipient_email text, operation text default 'lookup') returns jsonb
language sql security invoker set search_path='' as $$
 select wavread_private.manage_licence(recipient_email,operation);
$$;
revoke all on function public.owner_manage_licence(text,text) from public,anon;
grant execute on function public.owner_manage_licence(text,text) to authenticated;
