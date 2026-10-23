-- Affiliate payouts: a ledger of the months the owner has paid, by hand.
--
-- 20261021120000_affiliate_tracking.sql reports what each affiliate is owed,
-- but nothing recorded that a month was paid. This adds that record and makes
-- the report read from it. The owner's monthly routine is AFFILIATE_PAYOUTS.md.
--
-- Shape of the change:
--   wavread_private.affiliate_payouts       one row per affiliate per month paid:
--                                           amount, sales, the rate it was paid
--                                           at, when, by whom (auth user id), how
--   wavread_private.affiliate_payout_items  each sale a payout covered and the
--                                           commission paid on it, frozen
--   purchases.amount_refunded_cents         how much of a sale Stripe refunded,
--                                           so a partial refund can be told from
--                                           a full one (written by stripe-webhook)
--   wavread_private.affiliate_sales         rebuilt: a paid sale reads its frozen
--                                           commission; adds the paid,
--                                           needs_review and clawback states
--   wavread_private.affiliate_earnings      rebuilt on the same rules
--   wavread_private.affiliate_overview      rebuilt: paid-out and clawback totals
--   public.owner_affiliate_payable_by_month()  the admin page's Payouts read
--   public.owner_mark_month_paid()          its one write
--
-- The rules, settled by the owner (they replace the OPEN notes in
-- 20261021120000 on payout cadence, freezing the rate, and recording payouts):
--   * Commission is the affiliate's rate (30% by default) of the GROSS amount
--     the buyer paid, rounded to the cent per sale: $15 on a $50 sale. A $0
--     sale earns nothing.
--   * Paid monthly, by the UTC month the sale was made, once every sale in that
--     month is past the 30-day refund window: month M can be marked paid from
--     the first of M + 1, plus 30 days.
--   * Payable means paid, above $0, and never refunded in any amount. A full
--     refund drops out as before. Any other refund — partial, or one whose
--     amount was not recorded — is excluded too and listed as needs_review for
--     the owner to look at in Stripe.
--   * A paid month is never re-priced. Its sales read the commission frozen in
--     affiliate_payout_items (and the payout's commission_pct_at_payout), so
--     changing an affiliate's rate moves only sales not yet paid.
--   * A refund after payout flags that sale as a clawback, with the commission
--     paid on it. Nothing is adjusted automatically.
--   * The ledger is append-only. A mistaken entry is corrected by hand with the
--     SQL in AFFILIATE_PAYOUTS.md; there is no unmark or void function.
--
-- Only the owner reads or writes any of it, through owner-checked functions
-- (wavread_private.owner_can_grant(), as for the licence controls). This
-- migration names no person and pays no one.
--
-- Apply with apply_migration or the SQL editor, never with db push: production's
-- migration history does not match this directory's file names.

begin;

-- === purchases: how much was refunded ======================================

-- Stripe sends charge.refunded for a partial refund as well as a full one, and
-- stripe-webhook marks the purchase refunded either way. Its charge carries
-- amount_refunded (a running total), which the webhook now records here. Null
-- means not recorded: every refund before this migration, and any refund
-- handled by a webhook deployed before it. No upper bound is checked, so a
-- figure Stripe sends can never fail this constraint and stall the refund.
alter table public.purchases
  add column amount_refunded_cents integer
    constraint purchases_amount_refunded_cents_check
      check (amount_refunded_cents is null or amount_refunded_cents >= 0);

comment on column public.purchases.amount_refunded_cents is
  'How much of this purchase Stripe has refunded, in cents, as charge.refunded '
  'reported it (a running total). Null when not recorded. A refund for less '
  'than amount_cents is partial.';

-- === the ledger ============================================================

create table wavread_private.affiliate_payouts (
  id bigint generated always as identity primary key,
  affiliate_code text not null
    constraint affiliate_payouts_affiliate_code_fkey
      references wavread_private.affiliates (code) on update restrict on delete restrict,
  -- The first of the UTC month the paid sales were made in.
  period_month date not null
    constraint affiliate_payouts_period_month_check
      check (period_month = date_trunc('month', period_month)::date),
  amount_cents integer not null
    constraint affiliate_payouts_amount_cents_check check (amount_cents > 0),
  sales_count integer not null
    constraint affiliate_payouts_sales_count_check check (sales_count > 0),
  commission_pct_at_payout numeric(5, 2) not null
    constraint affiliate_payouts_commission_pct_check check (commission_pct_at_payout between 0 and 100),
  paid_at timestamptz not null default now(),
  -- Who recorded it: the owner's auth user id, never an email.
  paid_by uuid not null references auth.users (id),
  -- How it was paid, in a few words ("PayPal", "Zelle"). Never an account,
  -- card or phone number: a run of six or more digits, however spaced, is
  -- refused.
  method_note text not null
    constraint affiliate_payouts_method_note_check check (
      method_note = btrim(method_note)
      and char_length(method_note) between 1 and 80
      and regexp_replace(method_note, '[[:space:].-]', '', 'g') !~ '[0-9]{6,}'
    ),
  created_at timestamptz not null default now(),
  constraint affiliate_payouts_affiliate_month_key unique (affiliate_code, period_month)
);

comment on table wavread_private.affiliate_payouts is
  'One row per affiliate per month the owner has paid, by hand, recorded through '
  'owner_mark_month_paid. Append-only: corrections are a manual SQL step '
  '(AFFILIATE_PAYOUTS.md).';

create table wavread_private.affiliate_payout_items (
  -- A sale is paid at most once.
  purchase_id bigint primary key
    references public.purchases (id) on delete restrict,
  payout_id bigint not null
    references wavread_private.affiliate_payouts (id) on delete restrict,
  -- The commission paid on this sale, frozen when the month was marked paid.
  amount_cents_paid integer not null
    constraint affiliate_payout_items_amount_cents_paid_check check (amount_cents_paid >= 0)
);

create index affiliate_payout_items_payout_id_idx
  on wavread_private.affiliate_payout_items (payout_id);

comment on table wavread_private.affiliate_payout_items is
  'Each sale an affiliate payout covered, and the commission paid on it. The '
  'earnings views read this, never the current rate, for a paid sale.';

-- Deny by default, as wavread_private.affiliates is: no client role holds a
-- privilege, and the functions below are the only way in. The policies repeat
-- it, so that a grant added one day by mistake opens these tables to the owner
-- and no one else — and to reading and adding only.
alter table wavread_private.affiliate_payouts enable row level security;
alter table wavread_private.affiliate_payout_items enable row level security;
revoke all on wavread_private.affiliate_payouts, wavread_private.affiliate_payout_items
  from public, anon, authenticated;
revoke all on sequence wavread_private.affiliate_payouts_id_seq from public, anon, authenticated;

create policy "Only the owner reads payouts"
on wavread_private.affiliate_payouts for select to authenticated
using ((select wavread_private.owner_can_grant()));

create policy "Only the owner records payouts"
on wavread_private.affiliate_payouts for insert to authenticated
with check ((select wavread_private.owner_can_grant()));

create policy "Only the owner reads payout items"
on wavread_private.affiliate_payout_items for select to authenticated
using ((select wavread_private.owner_can_grant()));

create policy "Only the owner records payout items"
on wavread_private.affiliate_payout_items for insert to authenticated
with check ((select wavread_private.owner_can_grant()));

-- Append-only for everyone, the database owner included: a recorded payout is
-- a fact about money that has moved. The one way to change or remove a row is
-- the correction in AFFILIATE_PAYOUTS.md, which sets wavread.payout_correction
-- for its own transaction. No client can set it: they run no SQL, only the
-- functions below, and none of those sets it.
create function wavread_private.payout_ledger_is_append_only()
returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('wavread.payout_correction', true), '') <> 'on' then
    raise exception 'The payout ledger is append-only; % on % is refused. To correct a mistaken entry, see AFFILIATE_PAYOUTS.md.',
      tg_op, tg_table_name using errcode = '23001';
  end if;
  return case tg_op when 'DELETE' then old else new end;
end;
$$;
revoke all on function wavread_private.payout_ledger_is_append_only() from public, anon, authenticated;

create trigger affiliate_payouts_append_only
before update or delete on wavread_private.affiliate_payouts
for each row execute function wavread_private.payout_ledger_is_append_only();
create trigger affiliate_payouts_no_truncate
before truncate on wavread_private.affiliate_payouts
for each statement execute function wavread_private.payout_ledger_is_append_only();
create trigger affiliate_payout_items_append_only
before update or delete on wavread_private.affiliate_payout_items
for each row execute function wavread_private.payout_ledger_is_append_only();
create trigger affiliate_payout_items_no_truncate
before truncate on wavread_private.affiliate_payout_items
for each statement execute function wavread_private.payout_ledger_is_append_only();

-- === every credited sale, and where it stands ==============================

-- The same view as 20261021120000, replaced in place: its columns keep their
-- names, types and order, and new ones are appended. States:
--
--   paid          in a recorded payout, and never refunded since
--   clawback      in a recorded payout, and refunded (in any amount) since
--   excluded      nothing was charged ($0)
--   refunded      refunded in full, as recorded — not owed, as before
--   needs_review  not paid out, and either refunded partially or by an amount
--                 that was not recorded, or credited to a month that is already
--                 paid (a sale credited by hand after the payout)
--   pending       paid, and still inside the 30-day refund window
--   payable       paid, past it, and in a month not yet paid
--
-- commission_pct and commission_cents are the frozen payout figures for a paid
-- or clawback sale, and the affiliate's current rate for any other.
create or replace view wavread_private.affiliate_sales
with (security_invoker = true) as
select p.id as purchase_id,
       p.affiliate_code,
       p.purchased_at,
       p.amount_cents,
       p.refunded_at,
       coalesce(po.commission_pct_at_payout, a.commission_pct)::numeric(5, 2) as commission_pct,
       coalesce(i.amount_cents_paid, round(p.amount_cents * a.commission_pct / 100)::integer) as commission_cents,
       case
         when i.purchase_id is not null and r.has_refund then 'clawback'
         when i.purchase_id is not null then 'paid'
         when p.amount_cents <= 0 then 'excluded'
         when r.has_refund and p.amount_refunded_cents >= p.amount_cents then 'refunded'
         when r.has_refund then 'needs_review'
         when paid_month.id is not null then 'needs_review'
         when p.purchased_at > now() - interval '30 days' then 'pending'
         else 'payable'
       end as state,
       date_trunc('month', p.purchased_at at time zone 'UTC')::date as period_month,
       p.amount_refunded_cents,
       r.has_refund,
       i.payout_id,
       right(p.stripe_checkout_session_id, 8) as session_suffix
  from public.purchases p
  join wavread_private.affiliates a on a.code = p.affiliate_code
  cross join lateral (
    select p.status <> 'paid' or coalesce(p.amount_refunded_cents, 0) > 0 as has_refund
  ) r
  left join wavread_private.affiliate_payout_items i on i.purchase_id = p.id
  left join wavread_private.affiliate_payouts po on po.id = i.payout_id
  left join wavread_private.affiliate_payouts paid_month
    on paid_month.affiliate_code = p.affiliate_code
   and paid_month.period_month = date_trunc('month', p.purchased_at at time zone 'UTC')::date;

-- What each affiliate has earned, by the month the sales were made: payable
-- sales at the current rate, and paid sales at the commission frozen when they
-- were paid. Replaced in place like affiliate_sales; paid figures appended.
create or replace view wavread_private.affiliate_earnings
with (security_invoker = true) as
select affiliate_code,
       period_month as month,
       count(*)::integer as sales,
       sum(amount_cents)::bigint as gross_cents,
       sum(commission_cents)::bigint as commission_cents,
       (count(*) filter (where state = 'paid'))::integer as paid_sales,
       coalesce(sum(commission_cents) filter (where state = 'paid'), 0)::bigint as paid_commission_cents
  from wavread_private.affiliate_sales
 where state in ('payable', 'paid')
 group by affiliate_code, period_month;

comment on view wavread_private.affiliate_earnings is
  'Commission earned per affiliate per month: paid, not refunded, above $0, '
  'older than 30 days, on the gross amount. A paid month reads the commission '
  'frozen in affiliate_payout_items; a rate change moves only unpaid sales. '
  'Owner-only, through owner_affiliates and owner_affiliate_payable_by_month.';

revoke all on wavread_private.affiliate_sales, wavread_private.affiliate_earnings
  from public, anon, authenticated;

-- === the admin page's affiliate list =======================================

-- The same function as 20261021120000, with the payout states counted: sales
-- include paid ones, payable is only what has not been paid, refunds are every
-- sale with a refund of any kind, and paid-out, needs-review and clawback
-- totals are new. months keeps its shape, now read from the rebuilt earnings
-- view; the page's Payouts section reads affiliate_payable_by_month instead.
create or replace function wavread_private.affiliate_overview()
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
             'paid_commission_cents', coalesce(t.paid_commission_cents, 0),
             'refunds', coalesce(t.refunds, 0),
             'refunded_cents', coalesce(t.refunded_cents, 0),
             'needs_review', coalesce(t.needs_review, 0),
             'clawbacks', coalesce(t.clawbacks, 0),
             'clawback_cents', coalesce(t.clawback_cents, 0),
             'months', coalesce(m.months, '[]'::jsonb)
           ) order by a.active desc, a.created_at, a.code), '[]'::jsonb)
      from wavread_private.affiliates a
      left join lateral (
        select count(*) filter (where s.state in ('pending', 'payable', 'paid')) as sales,
               sum(s.amount_cents) filter (where s.state in ('pending', 'payable', 'paid')) as gross_cents,
               count(*) filter (where s.state = 'pending') as pending_sales,
               sum(s.commission_cents) filter (where s.state = 'pending') as pending_commission_cents,
               sum(s.commission_cents) filter (where s.state = 'payable') as payable_commission_cents,
               sum(s.commission_cents) filter (where s.state in ('paid', 'clawback')) as paid_commission_cents,
               count(*) filter (where s.has_refund) as refunds,
               sum(s.amount_cents) filter (where s.has_refund) as refunded_cents,
               count(*) filter (where s.state = 'needs_review') as needs_review,
               count(*) filter (where s.state = 'clawback') as clawbacks,
               sum(s.commission_cents) filter (where s.state = 'clawback') as clawback_cents
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

-- === the Payouts section's read ============================================

-- Every month any affiliate has a credited sale or a payout in, newest first
-- within each affiliate, with the sales behind it. status is the month's
-- standing:
--
--   paid             a payout is recorded: the frozen amount, rate and sales
--   on_hold          not yet past the 30-day hold; the amount is so far
--   payable          past the hold, unpaid, and something is owed
--   nothing_payable  past the hold, unpaid, and nothing is owed
--
-- needs_review_sales and clawback_sales / clawback_cents can accompany any of
-- them. A sale's commission_cents is what the month counts for it: zero for a
-- sale that is excluded, refunded or needs review.
create function wavread_private.affiliate_payable_by_month()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(wavread_private.owner_can_grant(), false) then
    raise exception 'Owner access required' using errcode = '42501';
  end if;
  return (
    with months as (
      select s.affiliate_code, s.period_month from wavread_private.affiliate_sales s
      union
      select po.affiliate_code, po.period_month from wavread_private.affiliate_payouts po
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'affiliate_code', a.code,
             'affiliate_name', a.name,
             'period_month', m.period_month,
             'hold_ends_at', h.hold_ends_at,
             'status', case
                         when po.id is not null then 'paid'
                         when now() < h.hold_ends_at then 'on_hold'
                         when coalesce(t.open_cents, 0) > 0 then 'payable'
                         else 'nothing_payable'
                       end,
             'sales_count', coalesce(po.sales_count, t.open_sales, 0),
             'amount_cents', coalesce(po.amount_cents, t.open_cents, 0),
             'commission_pct', coalesce(po.commission_pct_at_payout, a.commission_pct),
             'payout_id', po.id,
             'paid_at', po.paid_at,
             'method_note', po.method_note,
             'needs_review_sales', coalesce(t.needs_review_sales, 0),
             'clawback_sales', coalesce(t.clawback_sales, 0),
             'clawback_cents', coalesce(t.clawback_cents, 0),
             'sales', coalesce(t.sales, '[]'::jsonb)
           ) order by a.active desc, a.created_at, a.code, m.period_month desc), '[]'::jsonb)
      from months m
      join wavread_private.affiliates a on a.code = m.affiliate_code
      left join wavread_private.affiliate_payouts po
        on po.affiliate_code = m.affiliate_code and po.period_month = m.period_month
      cross join lateral (
        select (m.period_month + interval '1 month' + interval '30 days') at time zone 'UTC' as hold_ends_at
      ) h
      left join lateral (
        select count(*) filter (where s.state in ('pending', 'payable')) as open_sales,
               sum(s.commission_cents) filter (where s.state in ('pending', 'payable')) as open_cents,
               count(*) filter (where s.state = 'needs_review') as needs_review_sales,
               count(*) filter (where s.state = 'clawback') as clawback_sales,
               sum(s.commission_cents) filter (where s.state = 'clawback') as clawback_cents,
               jsonb_agg(jsonb_build_object(
                 'purchased_on', to_char(s.purchased_at at time zone 'UTC', 'YYYY-MM-DD'),
                 'session_suffix', s.session_suffix,
                 'gross_cents', s.amount_cents,
                 'commission_cents', case when s.state in ('pending', 'payable', 'paid', 'clawback')
                                          then s.commission_cents else 0 end,
                 'state', s.state,
                 'has_refund', s.has_refund,
                 'amount_refunded_cents', s.amount_refunded_cents
               ) order by s.purchased_at, s.purchase_id) as sales
          from wavread_private.affiliate_sales s
         where s.affiliate_code = m.affiliate_code and s.period_month = m.period_month
      ) t on true
  );
end;
$$;
revoke all on function wavread_private.affiliate_payable_by_month() from public, anon;
grant execute on function wavread_private.affiliate_payable_by_month() to authenticated;

create function public.owner_affiliate_payable_by_month()
returns jsonb
language sql stable security invoker set search_path = '' as $$
  select wavread_private.affiliate_payable_by_month();
$$;
revoke all on function public.owner_affiliate_payable_by_month() from public, anon;
grant execute on function public.owner_affiliate_payable_by_month() to authenticated;

-- === the Payouts section's write ===========================================

-- Records that the owner has paid an affiliate for a month, by hand, and
-- freezes the sales it covered at the affiliate's current rate. Refuses, and
-- records nothing, when:
--   42501  the caller is not the owner
--   22023  the month is not the first of a month, or the note is empty, too
--          long, or carries an account, card or phone number
--   P0002  no affiliate has that code, or nothing in that month is payable
--   55000  the month is not yet past the 30-day hold, or the payable amount is
--          no longer expected_cents (the page sends what it showed the owner)
--   23505  the month is already paid
create function wavread_private.mark_month_paid(
  target_code text,
  target_month date,
  target_note text,
  expected_cents integer default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  clean_code text := lower(btrim(target_code));
  clean_note text := btrim(target_note);
  hold_ends_at timestamptz;
  rate numeric(5, 2);
  sale_ids bigint[];
  sale_cents integer[];
  total integer;
  payout wavread_private.affiliate_payouts%rowtype;
begin
  if not coalesce(wavread_private.owner_can_grant(), false) then
    raise exception 'Owner access required' using errcode = '42501';
  end if;
  if target_month is null or target_month <> date_trunc('month', target_month)::date then
    raise exception 'The month must be given as its first day' using errcode = '22023';
  end if;
  if clean_note is null or char_length(clean_note) not between 1 and 80 then
    raise exception 'Say how you paid, in up to 80 characters — for example PayPal or Zelle' using errcode = '22023';
  end if;
  if regexp_replace(clean_note, '[[:space:].-]', '', 'g') ~ '[0-9]{6,}' then
    raise exception 'Leave account, card and phone numbers out of the note — the method is enough, for example PayPal or Zelle'
      using errcode = '22023';
  end if;

  -- Holding the affiliate's row keeps its rate fixed for this transaction and
  -- makes a second payout for the same affiliate wait for this one.
  select a.commission_pct into rate
    from wavread_private.affiliates a
   where a.code = clean_code
     for update;
  if not found then
    raise exception 'No affiliate has that code' using errcode = 'P0002';
  end if;

  hold_ends_at := (target_month + interval '1 month' + interval '30 days') at time zone 'UTC';
  if now() < hold_ends_at then
    raise exception '% is inside the 30-day refund hold until % (UTC)',
      to_char(target_month, 'FMMonth YYYY'), to_char(hold_ends_at at time zone 'UTC', 'YYYY-MM-DD')
      using errcode = '55000';
  end if;
  if exists (select 1 from wavread_private.affiliate_payouts po
              where po.affiliate_code = clean_code and po.period_month = target_month) then
    raise exception '% is already marked paid for %', to_char(target_month, 'FMMonth YYYY'), clean_code
      using errcode = '23505';
  end if;

  -- Lock the month's sales, so a refund arriving now waits for this payout and
  -- then shows as a clawback, rather than landing between the count and the
  -- record.
  perform 1
     from public.purchases p
    where p.affiliate_code = clean_code
      and p.purchased_at >= target_month::timestamp at time zone 'UTC'
      and p.purchased_at < (target_month + interval '1 month') at time zone 'UTC'
      for update;

  select array_agg(s.purchase_id order by s.purchase_id),
         array_agg(s.commission_cents order by s.purchase_id),
         coalesce(sum(s.commission_cents), 0)
    into sale_ids, sale_cents, total
    from wavread_private.affiliate_sales s
   where s.affiliate_code = clean_code
     and s.period_month = target_month
     and s.state = 'payable';

  if sale_ids is null or total <= 0 then
    raise exception 'Nothing in % is payable to %', to_char(target_month, 'FMMonth YYYY'), clean_code
      using errcode = 'P0002';
  end if;
  if expected_cents is not null and expected_cents <> total then
    raise exception 'The payable amount is now $%, not $%. Reload the page and check the month before marking it paid.',
      to_char(total / 100.0, 'FM999999990.00'), to_char(expected_cents / 100.0, 'FM999999990.00')
      using errcode = '55000';
  end if;

  insert into wavread_private.affiliate_payouts
    (affiliate_code, period_month, amount_cents, sales_count, commission_pct_at_payout, paid_by, method_note)
  values (clean_code, target_month, total, cardinality(sale_ids), rate, auth.uid(), clean_note)
  returning * into payout;

  insert into wavread_private.affiliate_payout_items (purchase_id, payout_id, amount_cents_paid)
  select sale.id, payout.id, sale.cents
    from unnest(sale_ids, sale_cents) as sale (id, cents);

  return to_jsonb(payout);
end;
$$;
revoke all on function wavread_private.mark_month_paid(text, date, text, integer) from public, anon;
grant execute on function wavread_private.mark_month_paid(text, date, text, integer) to authenticated;

create function public.owner_mark_month_paid(
  target_code text,
  target_month date,
  target_note text,
  expected_cents integer default null
)
returns jsonb
language sql security invoker set search_path = '' as $$
  select wavread_private.mark_month_paid(target_code, target_month, target_note, expected_cents);
$$;
revoke all on function public.owner_mark_month_paid(text, date, text, integer) from public, anon;
grant execute on function public.owner_mark_month_paid(text, date, text, integer) to authenticated;

commit;
