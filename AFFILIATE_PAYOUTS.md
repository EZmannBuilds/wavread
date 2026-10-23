# Affiliate payouts: the monthly routine

Internal ops note for the owner. It is not site copy and nothing in it should be
pasted into a public page or into anything an affiliate reads. The site is built
from `docs/` only, so this file is never published.

The schema is `supabase/migrations/20261023120000_affiliate_payout_ledger.sql`;
the page is `/admin/affiliates` (Payouts section), reached from the dashboard's
owner controls. Only the owner sees anything there.

## The rules

- Commission is the affiliate's rate, 30% by default, of the **gross** amount the
  buyer paid, rounded to the cent per sale: **$15 on a $50 sale**. A $0 sale
  earns nothing.
- Sales are paid **monthly**, by the UTC month they were made in, once every sale
  in that month is past the **30-day refund window**. A month can be marked paid
  from 30 days after it ends: August is payable from October 1, September from
  October 31. Until then the page shows it as *on hold*, with the total so far.
- A sale counts only if it is paid, above $0, and has **no refund of any kind**.
- **Needs review**: a sale that is not paid out and has a refund that is not
  recorded as full (a partial refund, or a refund whose amount was not
  recorded), or a sale credited to a month that has already been paid. It is
  never included in a payout. See [Needs review](#needs-review).
- **Clawback needed**: a sale that was paid out and has been refunded since, in
  any amount. The amount shown is the commission that was paid on it. Nothing is
  adjusted automatically. See [Clawback needed](#clawback-needed).
- **A paid month is frozen.** Marking a month paid records each sale and the
  commission paid on it. Changing an affiliate's rate afterwards changes only
  sales that have not been paid yet.
- The ledger is **append-only**. The page cannot unmark or edit a payout; a
  mistake is fixed with the SQL in [Correcting a mistaken entry](#correcting-a-mistaken-entry).

## Every month

Early in the month, sign in on the dashboard and open **Affiliates → Payouts**.

1. **Download CSV.** Keep it with your records; it lists every affiliate and
   month with its sales count, amount, status, paid date and method note.
   **Download per-sale CSV** too if you want each sale behind the numbers
   (purchase date, the last 8 characters of the Stripe checkout session id,
   gross, commission, status).
2. For each month that says **Payable**, look at any *needs review* sales first
   (below). They are not in the amount shown and will not be included.
3. **Pay the affiliate by hand** the amount shown (PayPal, Zelle, whatever you
   agreed). Use the email on their affiliate row.
4. Back on the page, click **Mark paid** for that month, type how you paid it
   in a few words (`PayPal`, `Zelle`), check the summary — affiliate, month,
   number of sales, amount — and click **Confirm**. The note must not contain
   account, card or phone numbers; the database refuses a run of six or more
   digits.
5. The month now shows **Paid on (date) via (note)**. Download the CSV again if
   you want a copy that includes this payment.

If **Confirm** is refused, the page says why, and nothing was recorded:

- *inside the 30-day refund hold*: the month is not payable yet.
- *nothing … is payable*: every sale in it was refunded or was $0.
- *already marked paid*: it was recorded before (perhaps in another tab).
- *the payable amount is now $X, not $Y*: a refund arrived after the page
  loaded. Reload, check the month, and pay the new amount. If you already paid
  the old amount, see [Clawback needed](#clawback-needed) for how to note the
  difference.

## Needs review

A refund always takes a sale out of the payable amount. Look each one up before
deciding anything. To find the purchase from the session id suffix in the
per-sale CSV, in the Supabase SQL editor:

```sql
select stripe_checkout_session_id, stripe_payment_intent, purchased_at,
       amount_cents, status, amount_refunded_cents
  from public.purchases
 where stripe_checkout_session_id like '%<suffix>';
```

Then open that payment in the Stripe dashboard (read only; nothing here needs a
change in Stripe).

- **It was a full refund** whose amount was not recorded (see below): you can
  record it so it stops asking for review. It then shows as refunded:

  ```sql
  update public.purchases
     set amount_refunded_cents = amount_cents
   where stripe_checkout_session_id = '<full session id from the query above>'
     and status = 'refunded';
  ```

- **It was a partial refund**: this workflow never pays commission on it. If you
  decide the affiliate should get something for the part that was kept, pay it
  by hand and keep a note in your own records; the ledger does not record it.
- **It was credited to a month already paid** (a sale credited by hand later):
  it is not in that month's payout and cannot be added to it. Pay it by hand if
  it is owed and keep a note in your own records.

### Partial refunds and the webhook

Telling a partial refund from a full one needs the amount Stripe refunded, which
`stripe-webhook` records only from the version in this change onwards
(`supabase/functions/stripe-webhook/refund.mjs`). Until that function is
redeployed, every refund is recorded without an amount, so every refunded
affiliate sale shows as **needs review** rather than **refunded**. That is the
safe direction: none of them is ever payable. Refunds recorded before the
redeploy stay in needs review until you look them up once and, if they were
full, record them as above.

## Clawback needed

A sale that was in a paid month and has been refunded since. The page and the
CSV show the commission that was paid on it. Nothing is changed automatically:
the payout keeps the amount you actually paid, and the flag stays on the month as
a record that the sale was refunded later.

Decide by hand whether to ask the affiliate for it back. If you instead take it
off a later payment, the later month's payout still records that month's full
amount, so say so in its method note, for example `PayPal, less 15.00 clawback`.

## Correcting a mistaken entry

The ledger refuses every update and delete, even from the SQL editor, unless the
transaction sets `wavread.payout_correction`. Use only these two corrections,
in the Supabase SQL editor, with the payout's `id` (from
`select * from wavread_private.affiliate_payouts order by id desc;`).

Wrong method note (the payment itself is right):

```sql
-- Correct the method note of one payout
begin;
set local wavread.payout_correction = 'on';
update wavread_private.affiliate_payouts
   set method_note = '<new note>'
 where id = <payout id>;
commit;
```

A month marked paid by mistake (no money was sent, or the wrong month or
affiliate was clicked):

```sql
-- Remove one mistaken payout
begin;
set local wavread.payout_correction = 'on';
delete from wavread_private.affiliate_payout_items where payout_id = <payout id>;
delete from wavread_private.affiliate_payouts where id = <payout id>;
commit;
```

The month goes back to payable, on hold or nothing payable, as its sales now
stand, and can be marked paid again from the page. Keep the CSV you downloaded
before the correction as the record of what was there.

## Open question (internal)

**For the owner:** the tax threshold question for affiliate payments is still open.
Until it is settled, it must not appear in any public copy, on the site, or in
any text an affiliate sees (emails, link instructions, payout notes). This repo
deliberately contains no tax advice; take the question to whoever advises the
business.
