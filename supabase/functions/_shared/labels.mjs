// The labels a purchase link can carry in ?from=. Plain JavaScript with no Deno
// globals, so tests/labels.test.mjs runs these rules under node:test exactly as
// the functions run them. mod.ts re-exports them for the Edge Functions.
//
// Two kinds of label, and anything else is dropped. Attribution must never be
// able to block a sale, so an unrecognized label returns null and the purchase
// goes ahead without one.

// The campaign label carried by an advertisement's link — "reels-a" and the
// like. It records which advertisement was paid for, never who clicked it:
// there is no cookie, no third-party script, and nothing to combine it with.
//
// The channel must be one WavRead actually buys, so a stranger cannot write
// prose into a payment record; the variant after it is a short free label so
// that testing a new creative needs no deploy.
export const CAMPAIGN_CHANNELS = ["reels", "tiktok", "shorts", "yt", "direct"];
export const CAMPAIGN_RE = new RegExp(
  `^(${CAMPAIGN_CHANNELS.join("|")})(-[a-z0-9]{1,12})?$`,
);

// An affiliate's link — "aff-example". The code after "aff-" names a row in
// wavread_private.affiliates, whose check constraint is the same character
// class and length, so every stored code has a label that passes here. Whether
// the code is real, active, and not the buyer's own is decided by the webhook
// against that table; this only keeps prose out of the payment record.
export const AFFILIATE_RE = /^aff-[a-z0-9-]{2,32}$/;

export function campaignSource(value) {
  if (typeof value !== "string") return null;
  const label = value.trim().toLowerCase();
  return CAMPAIGN_RE.test(label) || AFFILIATE_RE.test(label) ? label : null;
}

// "aff-example" -> "example". Null for an advertisement's label and for
// anything that is not a label at all.
export function affiliateCodeFromLabel(value) {
  const label = campaignSource(value);
  return label && AFFILIATE_RE.test(label) ? label.slice("aff-".length) : null;
}
