// Where a paid checkout came from, as the purchase row records it. Plain
// JavaScript with no Deno globals, so tests/stripe-webhook.test.mjs runs it
// under node:test exactly as the function runs it.
//
//   source          the ?from= label checkout recorded ("reels-a",
//                   "aff-example"), or null
//   affiliate_code  the affiliate this sale credits, or null
//
// Whether an affiliate is credited is decided by the attributable_affiliate
// RPC, against wavread_private.affiliates: the code must exist, be active, and
// not belong to the buyer — nobody earns commission on their own purchase.
// The affiliate's email never leaves the database; the buyer's goes in and a
// code or null comes out.
//
// Nothing here may block a sale. An unknown label, an unknown or inactive
// code, and a lookup that fails all record the purchase with no affiliate. The
// label itself is still kept in source, so a sale missed by a failed lookup can
// be found and credited by hand.
//
// A review copy — a checkout a 100% promotion code brought to $0 — credits
// nobody, whatever link the reviewer arrived by: nothing was sold, so there is
// nothing to earn on. It is told apart by the same rule fulfill() uses to tag
// the purchase (fulfillment.mjs), so the two cannot disagree, and the
// affiliates table is not even asked. The label is still kept in source.

import { affiliateCodeFromLabel, campaignSource } from "../_shared/labels.mjs";
import { checkoutPurchase } from "./fulfillment.mjs";

export async function purchaseAttribution(db, session, buyerEmail) {
  const source = campaignSource(session?.metadata?.source)
    ?? campaignSource(session?.client_reference_id);
  if (checkoutPurchase(session)?.kind === "review") return { source, affiliate_code: null };
  const code = affiliateCodeFromLabel(source);
  if (!code) return { source, affiliate_code: null };
  // The query builder is a thenable, not a Promise, so a thrown error is caught
  // around the await rather than with .catch().
  let found;
  try {
    found = await db.rpc("attributable_affiliate", { target_code: code, buyer_email: buyerEmail });
  } catch (error) {
    found = { error };
  }
  if (found.error) {
    console.error("affiliate lookup failed; recording the sale without one", found.error.code ?? "");
    return { source, affiliate_code: null };
  }
  return { source, affiliate_code: found.data === code ? code : null };
}
