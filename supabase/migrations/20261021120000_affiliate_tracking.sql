-- Affiliates: a link per person, the sales it brings, and what each is owed.
--
-- An affiliate's link is https://wavread.com/?from=aff-<code>. The label rides
-- the same path an advertisement's does (navigation.js, buy.js,
-- create-checkout), and stripe-webhook records it on the purchase. What is new
-- is that a label can now credit a person, so the webhook asks this database
-- whether it does: the code must be a row below, active, and not the buyer's
-- own email (attributable_affiliate). Anything else records the sale with no
-- affiliate. Attribution never blocks a sale.
--
-- Shape of the change:
--   wavread_private.affiliates      who can be credited, and at what rate
--   purchases.source                the ?from= label the buyer arrived with
--   purchases.affiliate_code        the affiliate the sale credits, or null
--   wavread_private.affiliate_sales every credited sale and where it stands
--   wavread_private.affiliate_earnings  what is payable, by affiliate and month
--   public.owner_affiliates()       the admin page's one read
--   public.owner_save_affiliate()   the admin page's one write
--
-- Only the owner reads or writes any of it. The owner is the identity
-- wavread_private.owner_can_grant() already pins for complimentary licences
-- (20260911002958_owner_licence_grants.sql); this migration names no person.
-- No affiliate is created here: rows are added through /admin/affiliates.
--
-- OPEN — for Erik to confirm before the first payout; nothing below pays anyone:
--   * Commission is on the GROSS amount the buyer paid (30% of $50 = $15),
--     before Stripe's fee. Net-of-fees would be 30% of roughly $48.25.
--   * Payouts are assumed MONTHLY, by the month the sale was made, once every
--     sale in that month is past the 30-day refund window.
--   * A commission rate is read from the affiliate's row when the report runs,
--     so changing a rate re-prices that affiliate's past sales too. Recording
--     the rate on each purchase would freeze it per sale; say if that is wanted.
--   * Nothing records that a month was paid out. A refund after a payout (past
--     the 30-day window) drops the sale from the report but claws nothing back.
--
-- Apply with apply_migration or the SQL editor, never with db push: production's
-- migration history does not match this directory's file names.

begin;

-- === affiliates ============================================================

create table wavread_private.affiliates (
  -- The code is permanent: it is in links already shared, and every credited
  -- purchase references it. Deactivate an affiliate rather than renaming one.
  -- The character class and length match labels.mjs's AFFILIATE_RE, so every
  -- code here has a link the site and the functions accept.
  code text primary key
    constraint affiliates_code_check check (code ~ '^[a-z0-9-]{2,32}$'),
  name text not null
    constraint affiliates_name_check check (name = btrim(name) and char_length(name) between 1 and 120),
  -- Kept for paying the affiliate and for refusing self-referral: a buyer whose
  -- checkout email is this address credits nobody.
  email text not null
    constraint affiliates_email_check check (
      char_length(email) between 3 and 254
      and email = lower(btrim(email))
      and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
  commission_pct numeric(5, 2) not null default 30
    constraint affiliates_commission_pct_check check (commission_pct between 0 and 100),
  -- An inactive affiliate's link still sells; it just credits no one from then
  -- on. Sales credited while active stay credited.
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table wavread_private.affiliates is
  'People whose ?from=aff-<code> links credit them with a share of the sales they '
  'bring. Read and written only by the owner, through owner_affiliates and '
  'owner_save_affiliate; the webhook asks attributable_affiliate and is told a '
  'code or nothing. Rows are never deleted — purchases reference them.';

-- Deny by default, as wavread_private.licence_grants is. The schema is not
-- exposed through the Data API and no client role holds a privilege on this
-- table, so every read and write goes through the owner-checked functions
-- below. The policies say the same thing again, so that a grant added here one
-- day by mistake still opens this table to the owner and to no one else.
alter table wavread_private.affiliates enable row level security;
revoke all on wavread_private.affiliates from public, anon, authenticated;

create policy "Only the owner reads affiliates"
on wavread_private.affiliates for select to authenticated
using ((select wavread_private.owner_can_grant()));

create policy "Only the owner adds affiliates"
on wavread_private.affiliates for insert to authenticated
with check ((select wavread_private.owner_can_grant()));

create policy "Only the owner changes affiliates"
on wavread_private.affiliates for update to authenticated
using ((select wavread_private.owner_can_grant()))
with check ((select wavread_private.owner_can_grant()));

-- === purchases: where a sale came from =====================================

-- Both columns are written once, by stripe-webhook, on the purchase's first
-- delivery. The source check is wider than any label labels.mjs accepts (at
-- most 36 characters, the same alphabet), so a label the function accepts can
-- never fail this constraint and take the purchase down with it.
alter table public.purchases
  add column source text
    constraint purchases_source_check check (source is null or source ~ '^[a-z0-9-]{1,40}$'),
  add column affiliate_code text
    constraint purchases_affiliate_code_fkey
      references wavread_private.affiliates (code) on update restrict on delete restrict;

comment on column public.purchases.source is
  'The ?from= label the buyer arrived with — an advertisement''s (reels-a) or an '
  'affiliate''s (aff-example) — or null. Recorded whether or not it credited anyone.';
comment on column public.purchases.affiliate_code is
  'The affiliate this sale credits. Null when there was no affiliate label, or '
  'the code was unknown or inactive at the time, or the buyer was the affiliate.';

create index purchases_affiliate_code_purchased_at_idx
  on public.purchases (affiliate_code, purchased_at)
  where affiliate_code is not null;

-- The webhook's question: does this code credit anyone, for this buyer? It
-- answers the code or null and nothing else, so the affiliate's email never
-- leaves the database. Callable by the service role alone.
create function public.attributable_affiliate(target_code text, buyer_email text)
returns text
language sql stable security definer set search_path = '' as $$
  select a.code
    from wavread_private.affiliates a
   where a.code = target_code
     and a.active
     and a.email <> lower(btrim(coalesce(buyer_email, '')));
$$;
revoke all on function public.attributable_affiliate(text, text) from public, anon, authenticated;
grant execute on function public.attributable_affiliate(text, text) to service_role;

-- === what each affiliate is owed ===========================================

-- Every credited sale, and where it stands. The single definition of the
-- rules; the earnings view and the admin page both read it.
--
--   excluded  nothing was charged ($0, as a full-discount promotion would make)
--   refunded  refunded, in whole or in part (the webhook marks either the same)
--   pending   paid, and still inside the 30-day refund window
--   payable   paid, and past it
--
-- Commission is on the gross amount the buyer paid — OPEN, see the header —
-- rounded to the cent per sale. Checkout charges USD only, so amounts are
-- summed without a currency split.
create view wavread_private.affiliate_sales
with (security_invoker = true) as
select p.id as purchase_id,
       p.affiliate_code,
       p.purchased_at,
       p.amount_cents,
       p.refunded_at,
       a.commission_pct,
       round(p.amount_cents * a.commission_pct / 100)::integer as commission_cents,
       case
         when p.amount_cents <= 0 then 'excluded'
         when p.status <> 'paid' then 'refunded'
         when p.purchased_at > now() - interval '30 days' then 'pending'
         else 'payable'
       end as state
  from public.purchases p
  join wavread_private.affiliates a on a.code = p.affiliate_code;

-- What is owed, by affiliate and by the month (UTC) the sales were made: paid,
-- not refunded, more than $0, and older than 30 days. 30% of a $50 sale is
-- $15. Monthly payout is OPEN — see the header.
create view wavread_private.affiliate_earnings
with (security_invoker = true) as
select affiliate_code,
       date_trunc('month', purchased_at at time zone 'UTC')::date as month,
       count(*)::integer as sales,
       sum(amount_cents)::bigint as gross_cents,
       sum(commission_cents)::bigint as commission_cents
  from wavread_private.affiliate_sales
 where state = 'payable'
 group by affiliate_code, date_trunc('month', purchased_at at time zone 'UTC');

comment on view wavread_private.affiliate_earnings is
  'Commission payable per affiliate per month: paid, not refunded, amount above '
  '0, older than 30 days, on the gross amount. OPEN for Erik: gross vs net of '
  'Stripe fees, and monthly payout. Owner-only, through owner_affiliates.';

revoke all on wavread_private.affiliate_sales, wavread_private.affiliate_earnings
  from public, anon, authenticated;

-- === the admin page's read and write =======================================
--
-- The same shape as the licence controls: a private security-definer function
-- that checks the owner before it touches anything, behind a public invoker
-- wrapper the browser can call. Anyone else gets 42501 and nothing more.

create function wavread_private.affiliate_overview()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(wavread_private.owner_can_grant(), false) then
    raise exception 'Owner access required' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'code', a.code,
             'name', a.name,
             'email', a.email,
             'commission_pct', a.commission_pct,
             'active', a.active,
             'created_at', a.created_at,
             'sales', coalesce(t.sales, 0),
             'gross_cents', coalesce(t.gross_cents, 0),
             'pending_sales', coalesce(t.pending_sales, 0),
             'pending_commission_cents', coalesce(t.pending_commission_cents, 0),
             'payable_commission_cents', coalesce(t.payable_commission_cents, 0),
             'refunds', coalesce(t.refunds, 0),
             'refunded_cents', coalesce(t.refunded_cents, 0),
             'months', coalesce(m.months, '[]'::jsonb)
           ) order by a.active desc, a.created_at, a.code), '[]'::jsonb)
      from wavread_private.affiliates a
      left join lateral (
        select count(*) filter (where s.state in ('pending', 'payable')) as sales,
               sum(s.amount_cents) filter (where s.state in ('pending', 'payable')) as gross_cents,
               count(*) filter (where s.state = 'pending') as pending_sales,
               sum(s.commission_cents) filter (where s.state = 'pending') as pending_commission_cents,
               sum(s.commission_cents) filter (where s.state = 'payable') as payable_commission_cents,
               count(*) filter (where s.state = 'refunded') as refunds,
               sum(s.amount_cents) filter (where s.state = 'refunded') as refunded_cents
          from wavread_private.affiliate_sales s
         where s.affiliate_code = a.code
      ) t on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
                 'month', to_char(e.month, 'YYYY-MM'),
                 'sales', e.sales,
                 'gross_cents', e.gross_cents,
                 'commission_cents', e.commission_cents
               ) order by e.month desc) as months
          from wavread_private.affiliate_earnings e
         where e.affiliate_code = a.code
      ) m on true
  );
end;
$$;
revoke all on function wavread_private.affiliate_overview() from public, anon;
grant execute on function wavread_private.affiliate_overview() to authenticated;

create function public.owner_affiliates()
returns jsonb
language sql stable security invoker set search_path = '' as $$
  select wavread_private.affiliate_overview();
$$;
revoke all on function public.owner_affiliates() from public, anon;
grant execute on function public.owner_affiliates() to authenticated;

-- 'create' adds an affiliate and refuses a code already taken; 'update'
-- changes name, email, rate and whether the affiliate is active, and never the
-- code. Deactivating is an update with target_active false.
create function wavread_private.save_affiliate(
  operation text,
  target_code text,
  target_name text,
  target_email text,
  target_pct numeric,
  target_active boolean default true
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  clean_code text := lower(btrim(target_code));
  clean_name text := btrim(target_name);
  clean_email text := lower(btrim(target_email));
  saved wavread_private.affiliates%rowtype;
begin
  if not coalesce(wavread_private.owner_can_grant(), false) then
    raise exception 'Owner access required' using errcode = '42501';
  end if;
  if operation is null or operation not in ('create', 'update') then
    raise exception 'Unknown operation' using errcode = '22023';
  end if;
  if clean_code is null or clean_code !~ '^[a-z0-9-]{2,32}$' then
    raise exception 'The code must be 2 to 32 lowercase letters, digits or hyphens' using errcode = '22023';
  end if;
  if clean_name is null or char_length(clean_name) not between 1 and 120 then
    raise exception 'Enter a name of up to 120 characters' using errcode = '22023';
  end if;
  if clean_email is null or char_length(clean_email) > 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email' using errcode = '22023';
  end if;
  if target_pct is null or target_pct < 0 or target_pct > 100 then
    raise exception 'The commission must be between 0 and 100 percent' using errcode = '22023';
  end if;

  if operation = 'create' then
    insert into wavread_private.affiliates (code, name, email, commission_pct, active)
    values (clean_code, clean_name, clean_email, target_pct, coalesce(target_active, true))
    on conflict (code) do nothing
    returning * into saved;
    if not found then
      raise exception 'That code is already taken' using errcode = '23505';
    end if;
  else
    update wavread_private.affiliates
       set name = clean_name,
           email = clean_email,
           commission_pct = target_pct,
           active = coalesce(target_active, active)
     where code = clean_code
    returning * into saved;
    if not found then
      raise exception 'No affiliate has that code' using errcode = 'P0002';
    end if;
  end if;
  return to_jsonb(saved);
end;
$$;
revoke all on function wavread_private.save_affiliate(text, text, text, text, numeric, boolean) from public, anon;
grant execute on function wavread_private.save_affiliate(text, text, text, text, numeric, boolean) to authenticated;

create function public.owner_save_affiliate(
  operation text,
  target_code text,
  target_name text,
  target_email text,
  target_pct numeric,
  target_active boolean default true
)
returns jsonb
language sql security invoker set search_path = '' as $$
  select wavread_private.save_affiliate(operation, target_code, target_name, target_email, target_pct, target_active);
$$;
revoke all on function public.owner_save_affiliate(text, text, text, text, numeric, boolean) from public, anon;
grant execute on function public.owner_save_affiliate(text, text, text, text, numeric, boolean) to authenticated;

commit;
