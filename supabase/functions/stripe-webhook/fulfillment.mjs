// Which completed checkouts grant a licence, and what kind of purchase each
// one records. Plain JavaScript with no Deno globals, so
// tests/review-codes.test.mjs runs it under node:test exactly as the function
// runs it.
//
//   sale    paid, more than $0. Counted as a sale; may credit an affiliate.
//   review  brought to $0 by a 100% promotion code (REVIEW_CODES.md), so
//           Stripe reports payment_status no_payment_required, or paid with
//           nothing charged. Grants the licence, records amount 0, and never
//           counts as a sale or earns commission (attribution.mjs, and the
//           purchases_review_is_free constraint).
//
// Anything else answers null and grants nothing: an unpaid session, an async
// payment still pending, and a session that says nothing was collected while
// its total is above $0 — no money arrived, so nothing was bought.

// A Stripe promotion code id, as a completed session's discounts carry it. The
// database check (20261021190000_review_promotion_codes.sql) is wider, so an id
// accepted here can never fail it and take the purchase down with it; anything
// else is recorded as null rather than refused.
export const PROMOTION_CODE_RE = /^promo_[A-Za-z0-9]{1,100}$/;

// The promotion code a session was redeemed with, or null. Stripe sends the id
// (promo_…) unexpanded in the webhook; an expanded object answers its id too.
// The code the reviewer typed is not in the event; the id finds it in the
// dashboard. Recorded for the owner's reference only — nothing reads it to
// decide anything.
export function promotionCode(session) {
  const discounts = [
    ...(Array.isArray(session?.discounts) ? session.discounts : []),
    ...(Array.isArray(session?.total_details?.breakdown?.discounts)
      ? session.total_details.breakdown.discounts.map((entry) => entry?.discount)
      : []),
  ];
  for (const discount of discounts) {
    const promo = discount?.promotion_code;
    const id = typeof promo === "string" ? promo : promo?.id;
    if (typeof id === "string" && PROMOTION_CODE_RE.test(id)) return id;
  }
  return null;
}

// Answers { kind, amount_cents, stripe_promotion_code } for a checkout that
// grants a licence, or null for one that does not.
export function checkoutPurchase(session) {
  const status = session?.payment_status;
  const amount = session?.amount_total ?? 0;
  const stripe_promotion_code = promotionCode(session);
  if (status === "paid" && Number.isInteger(amount) && amount > 0) {
    return { kind: "sale", amount_cents: amount, stripe_promotion_code };
  }
  if ((status === "paid" || status === "no_payment_required") && amount === 0) {
    return { kind: "review", amount_cents: 0, stripe_promotion_code };
  }
  return null;
}
