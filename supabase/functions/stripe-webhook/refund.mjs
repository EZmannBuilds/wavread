// What a charge.refunded event changes on the purchase it refunds. Plain
// JavaScript with no Deno globals, so tests/stripe-webhook.test.mjs runs it
// under node:test exactly as the function runs it.
//
// Stripe sends charge.refunded for a partial refund as well as a full one, and
// the charge's amount_refunded is the running total refunded so far. The first
// event marks the purchase refunded, as it always has — that is what revokes
// the licence and takes the sale out of affiliate earnings — and now also
// records the amount, so the affiliate payout report can tell a partial refund
// from a full one (20261023120000_affiliate_payout_ledger.sql). A later event,
// such as a second partial refund, only raises the recorded amount; an event
// that arrives out of order can never lower it.

export function refundedCents(charge) {
  const value = charge?.amount_refunded;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// The update for this purchase ({ status, amount_refunded_cents } as the row
// reads now), or null when there is nothing new to record.
export function refundUpdate(purchase, charge, now) {
  const cents = refundedCents(charge);
  if (purchase?.status !== "refunded") {
    return { status: "refunded", refunded_at: now, amount_refunded_cents: cents };
  }
  if (cents !== null && cents > (purchase.amount_refunded_cents ?? -1)) {
    return { amount_refunded_cents: cents };
  }
  return null;
}
