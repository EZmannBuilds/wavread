-- Review copies: a licence through a 100% promotion code, never a sale.
--
-- A reviewer gets a one-use Stripe promotion code (REVIEW_CODES.md) that
-- brings the checkout to $0. Stripe completes that session with
-- payment_status no_payment_required, and stripe-webhook grants the licence as
-- it would for any purchase, but records the purchase as a review: kind
-- 'review', amount 0, and no affiliate, whatever ?from= link the reviewer
-- arrived by (fulfillment.mjs, attribution.mjs). A review is never counted as
-- a sale and never earns commission.
--
-- Shape of the change:
--   purchases.kind                   'sale' or 'review'; every existing row is a sale
--   purchases.stripe_promotion_code  the promo_… id the checkout was redeemed with, or null
--   purchases_review_is_free         a review is $0 and credits no one, enforced here too
--   wavread_private.affiliate_sales  excludes a review by its kind, not only by its $0
--
-- Builds on 20261021120000_affiliate_tracking.sql and must be applied after it;
-- that file is not edited. Apply with apply_migration or the SQL editor, never
-- with db push: production's migration history does not match this
-- directory's file names.

begin;

-- === purchases: a sale or a review ==========================================

-- Both columns are written once, by stripe-webhook, on the purchase's first
-- delivery. The promotion code check is wider than the PROMOTION_CODE_RE the
-- webhook applies (fulfillment.mjs), so an id the function accepts can never
-- fail this constraint and take the purchase down with it.
alter table public.purchases
  add column kind text not null default 'sale'
    constraint purchases_kind_check check (kind in ('sale', 'review')),
  add column stripe_promotion_code text
    constraint purchases_stripe_promotion_code_check check (
      stripe_promotion_code is null or stripe_promotion_code ~ '^promo_[A-Za-z0-9]{1,250}$'
    ),
  -- The webhook already writes a review this way. Saying it again here means a
  -- review that somehow carried an affiliate or an amount is refused outright
  -- — Stripe retries, and the operator sees it — rather than paid out.
  add constraint purchases_review_is_free check (
    kind <> 'review' or (amount_cents = 0 and affiliate_code is null)
  );

comment on column public.purchases.kind is
  '''sale'' for a paid checkout above $0. ''review'' for a checkout a 100% '
  'promotion code brought to $0 (REVIEW_CODES.md): it grants the licence like '
  'a sale, and its status reads ''paid'' like one, but amount_cents is 0, no '
  'affiliate is credited, and it is never counted as a sale.';
comment on column public.purchases.stripe_promotion_code is
  'The Stripe promotion code id (promo_…) the checkout was redeemed with, when '
  'the completed session named one; the human code is in the Stripe dashboard. '
  'For the owner''s reference only: nothing decides anything from it.';

-- === affiliate earnings: a review is excluded by name ======================

-- The same definition as 20261021120000, with one change: the excluded state
-- names a review explicitly, rather than relying on its $0 alone and on the
-- constraint above keeping its affiliate_code null. The earnings view and
-- affiliate_overview (the admin page) both read this view, so a review is out
-- of the sales counts, pending, payable and refunds everywhere at once.
--
-- create or replace keeps the view's grants and its dependants, and the
-- columns are unchanged; security_invoker is stated again because a replace
-- takes the options it is given.
create or replace view wavread_private.affiliate_sales
with (security_invoker = true) as
select p.id as purchase_id,
       p.affiliate_code,
       p.purchased_at,
       p.amount_cents,
       p.refunded_at,
       a.commission_pct,
       round(p.amount_cents * a.commission_pct / 100)::integer as commission_cents,
       case
         when p.kind <> 'sale' or p.amount_cents <= 0 then 'excluded'
         when p.status <> 'paid' then 'refunded'
         when p.purchased_at > now() - interval '30 days' then 'pending'
         else 'payable'
       end as state
  from public.purchases p
  join wavread_private.affiliates a on a.code = p.affiliate_code;

revoke all on wavread_private.affiliate_sales from public, anon, authenticated;

commit;
