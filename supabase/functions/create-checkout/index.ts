// create-checkout — starts a purchase at the catalog price.
//
// The browser sends an email address; this function asks Stripe for a hosted
// Checkout session and returns its URL. No card data ever touches WavRead:
// Stripe hosts the payment page, and fulfillment happens only when Stripe's
// signed webhook confirms the session was paid (stripe-webhook/index.ts).
//
// Deployed with verify_jwt disabled: buying does not require an account —
// the account is created by fulfillment, keyed to the checkout email.

import {
  campaignSource,
  json,
  normalizeEmail,
  preflight,
  readJson,
  serviceClient,
} from "../_shared/mod.ts";

const CURRENCY = "usd";

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") {
    return json(req, 405, { error: "POST only" });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
  if (!stripeKey || !siteUrl) {
    return json(req, 503, {
      configured: false,
      error: "Purchases are not configured in this environment.",
    });
  }

  const body = await readJson(req, 4096);
  const email = normalizeEmail(body?.email);
  if (!email) {
    return json(req, 400, { error: "Enter a valid email address." });
  }

  // Each build is bought on its own, so the price and the name come from the
  // catalog rather than from anything the browser says. A checkout that names
  // no build buys the current one. A build priced at zero is not for sale and
  // is skipped by the guard below — that is how the pre-2026-08-29 builds,
  // which carry a separation backend that may not be sold, stay unsellable.
  const db = serviceClient();
  let build = null;
  const wanted = Number(body?.build_id);
  const query = db
    .from("builds")
    .select("id, version, price_cents")
    .eq("published", true);
  const found = Number.isInteger(wanted) && wanted > 0
    ? await query.eq("id", wanted).maybeSingle()
    : await query.order("released_at", { ascending: false }).limit(1).maybeSingle();
  if (!found.error && found.data) build = found.data;

  // No sellable build, no sale. This used to fall through to a default price,
  // which meant the store would take five dollars and grant an entitlement
  // while there was nothing published for it to unlock — money for a file that
  // does not exist. Refusing is the only honest answer.
  if (!build || !(build.price_cents > 0)) {
    return json(req, 409, {
      error: "There is no build on sale right now. Nothing has been charged.",
      available: false,
    });
  }

  const amountCents = build.price_cents;
  const productName = "WavRead";

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("customer_email", email);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", CURRENCY);
  params.set("line_items[0][price_data][unit_amount]", String(amountCents));
  params.set("line_items[0][price_data][product_data][name]", productName);
  params.set(
    "line_items[0][price_data][product_data][description]",
    "WavRead for macOS, and every build that follows it in 1.x, downloadable from your account.",
  );
  // The value is historical: it is on every purchase row already, and
  // changing it would make the rows before today disagree with the rows
  // after for no gain. It names the product, not the programme.
  params.set("metadata[product]", "early_build");
  // No build_version: one payment covers every build, so
  // the entitlement the webhook grants must stay unscoped. Naming a build here
  // would quietly sell access to that build alone.
  params.set("metadata[bought_at_version]", build.version);
  // Which advertisement this purchase came from, when the buyer arrived by
  // one. A label like "reels-a" and nothing else — no identifier, no profile,
  // and no consequence for the buyer. An unrecognized label is dropped rather
  // than refused: a mistyped link must still be able to sell.
  const source = campaignSource(body?.source);
  if (source) params.set("metadata[source]", source);
  params.set(
    "success_url",
    `${siteUrl}/purchase-complete?session_id={CHECKOUT_SESSION_ID}`,
  );
  params.set("cancel_url", `${siteUrl}/buy`);

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    // Stripe's message can name card details or internals; the buyer gets a
    // plain sentence and the operator reads the function log.
    console.error("stripe checkout create failed", response.status, await response.text());
    return json(req, 502, {
      error: "The payment page could not be started. Try again shortly.",
    });
  }

  const session = await response.json();
  if (!session?.url) {
    return json(req, 502, {
      error: "The payment page could not be started. Try again shortly.",
    });
  }
  return json(req, 200, { url: session.url });
});
