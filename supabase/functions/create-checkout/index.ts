// create-checkout — starts a $5 Early Build purchase.
//
// The browser sends an email address; this function asks Stripe for a hosted
// Checkout session and returns its URL. No card data ever touches WavRead:
// Stripe hosts the payment page, and fulfillment happens only when Stripe's
// signed webhook confirms the session was paid (stripe-webhook/index.ts).
//
// Deployed with verify_jwt disabled: buying does not require an account —
// the account is created by fulfillment, keyed to the checkout email.

import { json, normalizeEmail, preflight, readJson } from "../_shared/mod.ts";

const PRODUCT_NAME = "WavRead Early Build";
const AMOUNT_CENTS = 500;
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

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("customer_email", email);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", CURRENCY);
  params.set("line_items[0][price_data][unit_amount]", String(AMOUNT_CENTS));
  params.set("line_items[0][price_data][product_data][name]", PRODUCT_NAME);
  params.set(
    "line_items[0][price_data][product_data][description]",
    "Early channel builds, the report dashboard, and a recorded early-supporter purchase.",
  );
  params.set("metadata[product]", "early_build");
  params.set(
    "success_url",
    `${siteUrl}/purchase-complete?session_id={CHECKOUT_SESSION_ID}`,
  );
  params.set("cancel_url", `${siteUrl}/early-build`);

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
