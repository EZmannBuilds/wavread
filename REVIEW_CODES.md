# Review codes: free WavRead licences for reviewers

**Status: nothing on this page has been done.** No coupon or promotion code
exists in Stripe. Every command below is marked **DO NOT RUN WITHOUT
APPROVAL**. Run them only after the deploy order below is finished, and in
test mode before live mode.

## How it works

A reviewer gets a one-use promotion code: a random one, such as
`REVIEW-7Q4M2K`. They buy WavRead the usual way. On Stripe's checkout page
they choose **Add promotion code**, type the code, and the total drops to $0.
Stripe completes a payment-mode checkout that comes to $0 without asking for a
card ([no-cost orders](https://docs.stripe.com/payments/checkout/no-cost-orders),
API version 2023-08-16 or later); create-checkout only has to send
`allow_promotion_codes=true`. It sends no API version, so the account's
default applies: check that it is 2023-08-16 or later in **Developers →
Workbench** before the first code is made. The session arrives with
`payment_status: no_payment_required`.

`stripe-webhook` then grants the same licence a sale grants: every build, and
sign-in with the email typed at checkout. It records the purchase as a review:

| column | a sale | a review |
| --- | --- | --- |
| `kind` | `sale` | `review` |
| `amount_cents` | what Stripe charged | `0` |
| `affiliate_code` | the affiliate credited, if any | always `null`, even when the reviewer came through `?from=aff-…` |
| `source` | the `?from=` label | the `?from=` label (kept for reference, credits no one) |
| `stripe_promotion_code` | the `promo_…` id, if a partial code was used | the `promo_…` id, when Stripe names it in the session |
| `status` | `paid` | `paid` (meaning "not refunded"; nothing was charged) |

A review is never counted as a sale and never earns commission. Three things
enforce that:

- the webhook (`fulfillment.mjs`, `attribution.mjs`) never asks the affiliates
  table about a review;
- the database refuses a review row that carries an amount or an affiliate (the
  `purchases_review_is_free` constraint);
- `wavread_private.affiliate_sales` marks any review `excluded` by its kind.
  The earnings view and the admin page both read it.

Only a checkout that comes to exactly $0 is a review. A partial-discount code
would be a **sale** at the discounted price, and an affiliate would earn
commission on that price. This page creates only 100% codes.

## Before any of this: the deploy order

Do these in order, after both PRs have merged:

1. Apply #4's migration, `20261021120000_affiliate_tracking.sql`.
2. Apply this change's migration, `20261021190000_review_promotion_codes.sql`.
   Use apply_migration or the SQL editor, never `db push`.
3. Deploy `create-checkout`. This adds the promotion code field to Stripe's
   page.
4. Deploy `stripe-webhook`. From here, a $0 checkout grants a licence.
5. Deploy the site (`./deploy.sh`).
6. **Only then** create the coupon and the codes below: test mode first, then
   live.

Why the order matters:

- **Webhook before migration:** the webhook writes `kind` and
  `stripe_promotion_code`. If those columns don't exist yet, **every**
  purchase fails and Stripe keeps retrying it.
- **Code before webhook:** the old webhook ignores `no_payment_required`. The
  reviewer would see Stripe's success page and get no licence.

## The coupon (one, shared by every code)

| field | value |
| --- | --- |
| `name` | `WavRead review` |
| `percent_off` | `100` |
| `duration` | `once` |
| `max_redemptions` | `5`, the total across every code made from it |
| `redeem_by` | `1796104799` = 2026-11-30 11:59:59 PM Central (CST, UTC−6) = 2026-12-01 05:59:59 UTC |

Leave **Apply to specific products** off. create-checkout makes the product
inline with each session (`price_data`), so no fixed product ID exists to
restrict the coupon to.

### Dashboard steps

Stripe renames dashboard labels from time to time. These were current when
this was written.

1. Pick the mode with the **Test mode** toggle: test first, then live.
2. Go to **Product catalog → Coupons → + Create coupon**.
3. Fill in the form:
   - Name: `WavRead review`
   - ID: leave blank, and Stripe generates one
   - Type: **Percentage discount**, Percentage off: `100`
   - Duration: **Once**
   - Turn on **Limit the date range when customers can redeem this coupon**
     and set **Nov 30, 2026, 11:59 PM**. The picker uses the dashboard's
     time zone. Once the coupon is created, check its `redeem_by` in
     **Developers → Workbench** (or the API) and confirm it reads exactly
     `1796104799`. If it doesn't, delete the coupon and use the CLI.
   - Turn on **Limit the total number of times this coupon can be redeemed**
     and set `5`.
4. Choose **Create coupon** and copy its ID. The CLI steps below call it
   `<COUPON_ID>`.

### CLI equivalent

> **DO NOT RUN WITHOUT APPROVAL.** These commands use the Stripe CLI's
> logged-in **test** key. Add `--live` only for the approved live run.

```sh
# DO NOT RUN WITHOUT APPROVAL
stripe post /v1/coupons \
  -d name="WavRead review" \
  -d percent_off=100 \
  -d duration=once \
  -d max_redemptions=5 \
  -d redeem_by=1796104799
```

## One promotion code per reviewer

| field | value |
| --- | --- |
| `code` | one per reviewer, random, e.g. `REVIEW-7Q4M2K`. Letters, digits and dashes; customers can type it in any case |
| coupon | `<COUPON_ID>` above |
| `max_redemptions` | `1` |

Make every code random, and never put a reviewer's name in one. A code built
from a name can be guessed by anyone who knows the pattern, and this
repository is public, so no real code or name belongs here. Keep the list of
which code went to whom somewhere private.

### Dashboard steps

1. Open the coupon: **Product catalog → Coupons → WavRead review**.
2. Under **Promotion codes**, choose **+ New** (or **Create promotion code**).
3. Code: a new random code, such as `REVIEW-7Q4M2K`.
4. Under **Restrictions**:
   - turn on **Limit the number of times this code can be redeemed** and set `1`
   - leave **Eligible for first-time order only** off: Stripe refuses such a
     code on WavRead's checkout (see the limits below)
   - leave the expiry blank: the coupon's `redeem_by` already ends every code
     on 2026-11-30
5. Choose **Create**. Send the code to the reviewer privately, by whatever
   channel you already use with them. Don't put codes or reviewer emails in
   this repository.

### CLI equivalent

> **DO NOT RUN WITHOUT APPROVAL.** These use test mode unless `--live` is
> added. Make one call per reviewer.

The request shape depends on the API version. In version `2025-09-30.clover`
and later, a promotion code names its coupon under `promotion`. Pinning the
version on the request makes the command independent of the account's
default. Check `stripe post --help` for the version flag on your CLI.

```sh
# DO NOT RUN WITHOUT APPROVAL
stripe post /v1/promotion_codes \
  --stripe-version=2025-09-30.clover \
  -d "promotion[type]=coupon" \
  -d "promotion[coupon]=<COUPON_ID>" \
  -d code=<CODE> \
  -d max_redemptions=1
```

On an API version older than `2025-09-30.clover`, the coupon is a top-level
field:

```sh
# DO NOT RUN WITHOUT APPROVAL
stripe post /v1/promotion_codes \
  -d coupon=<COUPON_ID> \
  -d code=<CODE> \
  -d max_redemptions=1
```

## What the limits do and don't do

- **`max_redemptions: 1` on each code:** a leaked or shared code gives away
  one licence at most, and the intended reviewer then can't use it.
- **`max_redemptions: 5` on the coupon:** no more than five review licences,
  however many codes exist.
- **`redeem_by`:** nothing can be redeemed after 2026-11-30, 11:59:59 PM CT.
- **No first-time-order restriction.** Stripe documents that a promotion
  code limited to first-time customers returns invalid on a checkout that
  creates no Customer (`customer_creation` in the
  [Checkout Sessions API](https://docs.stripe.com/api/checkout/sessions/create)).
  create-checkout sends only `customer_email` and creates no Customer, so that
  restriction would refuse the reviewer the code was made for. One use per
  code is the limit; nothing stops someone who already bought from using one.
- **Every buyer sees the Add promotion code link.** That is how Stripe's
  field works.

## Checking, and undoing

These read-only queries are safe in the SQL editor.

Review licences granted so far:

```sql
select purchased_at, email, stripe_promotion_code, source, stripe_checkout_session_id
  from public.purchases
 where kind = 'review'
 order by purchased_at desc;
```

The sales count. This is paid, not refunded, more than $0, and never a
review:

```sql
select count(*), sum(amount_cents)
  from public.purchases
 where kind = 'sale' and status = 'paid' and amount_cents > 0;
```

To stop a code that leaked, deactivate it: **Promotion codes → the code →
Archive / Deactivate**. The CLI equivalent:

```sh
# DO NOT RUN WITHOUT APPROVAL
stripe post /v1/promotion_codes/<PROMO_ID> -d active=false
```

A review has no payment, so Stripe has nothing to refund, and the
`charge.refunded` path never touches it. To take back a review licence that
was already granted, revoke its entitlement by hand:

```sql
-- DO NOT RUN WITHOUT APPROVAL
update public.entitlements e
   set revoked_at = now()
  from public.purchases p
 where e.purchase_id = p.id
   and p.kind = 'review'
   and p.stripe_checkout_session_id = '<cs_… of that checkout>'
   and e.revoked_at is null;
```
