// What a checkout tells Stripe about where the buyer came from. Plain
// JavaScript with no Deno globals, so tests/create-checkout.test.mjs runs it
// under node:test exactly as the function runs it.
//
// Answers the form fields to add to the Checkout Session, keyed by Stripe's
// parameter names — nothing at all when the browser sent no label, or one
// WavRead does not recognize.
//
//   reels-a      -> metadata[source]
//   aff-example  -> metadata[source], client_reference_id, metadata[affiliate]
//
// client_reference_id and metadata[affiliate] make an affiliate sale easy to
// find in Stripe's own dashboard. Neither credits anyone: the webhook decides
// that against the affiliates table, and reads the label from metadata[source].

import { affiliateCodeFromLabel, campaignSource } from "../_shared/labels.mjs";

export function checkoutAttribution(value) {
  const source = campaignSource(value);
  if (!source) return {};
  const affiliate = affiliateCodeFromLabel(source);
  return affiliate
    ? { "metadata[source]": source, "client_reference_id": source, "metadata[affiliate]": affiliate }
    : { "metadata[source]": source };
}
