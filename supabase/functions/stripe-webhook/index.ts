// stripe-webhook — the only writer of ownership.
//
// Stripe calls this endpoint when a checkout finishes or a charge is
// refunded. Nothing here trusts the request body until the Stripe-Signature
// header verifies against STRIPE_WEBHOOK_SECRET, and fulfillment is
// idempotent on the checkout session id, so a retried webhook cannot grant
// twice or charge history twice.
//
// Fulfillment for a paid early_build session:
//   1. find or create the durable WavRead account for the checkout email
//   2. record the purchase (unique on the Stripe session id)
//   3. grant the early_build entitlement if none is active
//   4. make sure a Supabase Auth user exists for that email, and bind it to
//      the account if the account has no binding — the buyer can then sign in
//      with the same one-time email links testers use
//
// A refund revokes the entitlement and marks the purchase, keeping history.
//
// Deployed with verify_jwt disabled: Stripe authenticates with its signature,
// not a Supabase JWT.

import {
  json,
  normalizeEmail,
  serviceClient,
  timingSafeEqual,
} from "../_shared/mod.ts";

const SIGNATURE_TOLERANCE_SECONDS = 300;

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifySignature(
  header: string | null,
  body: string,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const parts = new Map<string, string[]>();
  for (const piece of header.split(",")) {
    const [k, v] = piece.split("=", 2);
    if (!k || !v) continue;
    parts.set(k.trim(), [...(parts.get(k.trim()) ?? []), v.trim()]);
  }
  const timestamp = Number(parts.get("t")?.[0] ?? "");
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return (parts.get("v1") ?? []).some((sig) => timingSafeEqual(sig, expected));
}

// deno-lint-ignore no-explicit-any
async function authUserIdFor(db: any, email: string): Promise<string | null> {
  const created = await db.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (created.data?.user?.id) return created.data.user.id;
  // Already registered — generateLink returns the existing user without
  // sending anything.
  const link = await db.auth.admin.generateLink({ type: "magiclink", email });
  return link.data?.user?.id ?? null;
}

// deno-lint-ignore no-explicit-any
async function fulfill(db: any, session: any): Promise<string> {
  if (session?.mode !== "payment") return "ignored: not a payment session";
  if (session?.payment_status !== "paid") return "ignored: not paid";
  if (session?.metadata?.product !== "early_build") {
    return "ignored: unknown product";
  }
  const email = normalizeEmail(
    session?.customer_details?.email ?? session?.customer_email,
  );
  if (!email) throw new Error("paid session carries no usable email");

  // 1. The durable account. Email is the recovery identity, so it is the key.
  let testerId: string;
  const existing = await db
    .from("beta_testers")
    .select("tester_id, auth_user_id, status")
    .eq("email", email)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    testerId = existing.data.tester_id;
  } else {
    const inserted = await db
      .from("beta_testers")
      .insert({ email, status: "active" })
      .select("tester_id")
      .single();
    if (inserted.error) throw inserted.error;
    testerId = inserted.data.tester_id;
  }

  // 2. The purchase, exactly once per checkout session.
  const purchase = await db
    .from("purchases")
    .upsert({
      tester_id: testerId,
      product: "early_build",
      amount_cents: session.amount_total ?? 0,
      currency: (session.currency ?? "usd").toLowerCase(),
      stripe_checkout_session_id: session.id,
      stripe_payment_intent: typeof session.payment_intent === "string"
        ? session.payment_intent
        : null,
      email,
      status: "paid",
    }, {
      onConflict: "stripe_checkout_session_id",
      ignoreDuplicates: true,
    });
  if (purchase.error) throw purchase.error;
  const purchaseRow = await db
    .from("purchases")
    .select("id")
    .eq("stripe_checkout_session_id", session.id)
    .single();
  if (purchaseRow.error) throw purchaseRow.error;

  // 3. The entitlement, if nothing active grants it already.
  const active = await db
    .from("entitlements")
    .select("id")
    .eq("tester_id", testerId)
    .eq("entitlement", "early_build")
    .is("revoked_at", null)
    .maybeSingle();
  if (active.error) throw active.error;
  if (!active.data) {
    const granted = await db.from("entitlements").insert({
      tester_id: testerId,
      entitlement: "early_build",
      source: "purchase",
      purchase_id: purchaseRow.data.id,
    });
    // A concurrent retry can lose this race; the partial unique index makes
    // the loser harmless.
    if (granted.error && granted.error.code !== "23505") throw granted.error;
  }

  // 4. Sign-in binding, without ever disturbing an existing one.
  const authUserId = await authUserIdFor(db, email);
  if (authUserId && !existing.data?.auth_user_id) {
    const bound = await db
      .from("beta_testers")
      .update({ auth_user_id: authUserId })
      .eq("tester_id", testerId)
      .is("auth_user_id", null);
    if (bound.error && bound.error.code !== "23505") throw bound.error;
  }
  return `fulfilled ${session.id} for account ${testerId}`;
}

// deno-lint-ignore no-explicit-any
async function refund(db: any, charge: any): Promise<string> {
  const intent = typeof charge?.payment_intent === "string"
    ? charge.payment_intent
    : null;
  if (!intent) return "ignored: refund without a payment intent";
  const found = await db
    .from("purchases")
    .select("id, tester_id, status")
    .eq("stripe_payment_intent", intent)
    .maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) return "ignored: refund for an unknown purchase";
  if (found.data.status !== "refunded") {
    const marked = await db
      .from("purchases")
      .update({ status: "refunded", refunded_at: new Date().toISOString() })
      .eq("id", found.data.id);
    if (marked.error) throw marked.error;
  }
  const revoked = await db
    .from("entitlements")
    .update({ revoked_at: new Date().toISOString() })
    .eq("tester_id", found.data.tester_id)
    .eq("entitlement", "early_build")
    .eq("source", "purchase")
    .eq("purchase_id", found.data.id)
    .is("revoked_at", null);
  if (revoked.error) throw revoked.error;
  return `refunded purchase ${found.data.id}`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json(req, 405, { error: "POST only" });
  }
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!secret) {
    return json(req, 503, { error: "webhook secret not configured" });
  }
  const body = await req.text();
  const valid = await verifySignature(
    req.headers.get("stripe-signature"),
    body,
    secret,
  );
  if (!valid) {
    return json(req, 400, { error: "invalid signature" });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body);
  } catch {
    return json(req, 400, { error: "unreadable event" });
  }

  const db = serviceClient();
  try {
    // deno-lint-ignore no-explicit-any
    const object = (event as any)?.data?.object;
    let outcome = `ignored: ${event.type}`;
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      outcome = await fulfill(db, object);
    } else if (event.type === "charge.refunded") {
      outcome = await refund(db, object);
    }
    console.log(outcome);
    return json(req, 200, { received: true });
  } catch (error) {
    // A 500 makes Stripe retry with backoff — the right behaviour for a
    // transient database problem, and a visible one for anything else.
    console.error("webhook processing failed", error);
    return json(req, 500, { error: "fulfillment failed; will be retried" });
  }
});
