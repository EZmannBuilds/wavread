// link-device — connects a desktop install to an account, revocably.
//
// The dashboard shows a short-lived single-use code; the user types it into
// WavRead's Settings. The app trades the code for an opaque random token and
// that token is all the app ever holds: no email, no password, no session.
// Only the token's SHA-256 is stored, so nothing readable from the database
// can impersonate a device, and revoking the device (from either side) ends
// the link without touching account history.
//
// Deployed with verify_jwt disabled: the desktop app has no Supabase session.
// The one-time code is the proof of account access.

import {
  isUuid,
  json,
  maskEmail,
  newDeviceToken,
  optionalText,
  preflight,
  readJson,
  serviceClient,
  sha256Hex,
} from "../_shared/mod.ts";

const CODE_RE = /^[A-Z0-9]{8}$/;

function normalizeCode(value: unknown): string | null {
  const code = String(value ?? "").toUpperCase().replace(/[\s-]/g, "");
  return CODE_RE.test(code) ? code : null;
}

async function slowFailure(req: Request, message: string): Promise<Response> {
  // A wrong code costs a moment. Codes are random, single-use, and expire in
  // fifteen minutes; the delay just keeps guessing boring.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return json(req, 400, { error: message });
}

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") {
    return json(req, 405, { error: "POST only" });
  }

  const body = await readJson(req, 8192);
  if (!body) return json(req, 400, { error: "unreadable request" });
  const db = serviceClient();

  if (body.action === "release") {
    const token = typeof body.token === "string" ? body.token : "";
    if (token.length >= 20 && token.length <= 128) {
      await db
        .from("devices")
        .update({ revoked_at: new Date().toISOString() })
        .eq("token_hash", await sha256Hex(token))
        .is("revoked_at", null);
    }
    // Releasing an already-released or unknown token is not an error the
    // caller can act on — the outcome the user wanted is true either way.
    return json(req, 200, { ok: true });
  }

  if (body.action !== "claim") {
    return json(req, 400, { error: "unknown action" });
  }

  const code = normalizeCode(body.code);
  const installId = body.install_id;
  if (!code) {
    return await slowFailure(req, "That code is not valid. Codes are 8 letters and numbers.");
  }
  if (!isUuid(installId)) {
    return json(req, 400, { error: "missing install id" });
  }

  const found = await db
    .from("link_codes")
    .select("code, tester_id, expires_at, claimed_at, beta_testers ( email, status )")
    .eq("code", code)
    .maybeSingle();
  if (found.error) {
    console.error("link code lookup failed", found.error);
    return json(req, 500, { error: "The link service had a problem. Try again." });
  }
  const account = found.data?.beta_testers as unknown as {
    email?: string;
    status?: string;
  } | null;
  if (
    !found.data || found.data.claimed_at ||
    new Date(found.data.expires_at).getTime() < Date.now() ||
    !account || account.status !== "active"
  ) {
    return await slowFailure(
      req,
      "That code is expired, already used, or not valid. Generate a fresh one on the dashboard.",
    );
  }

  const token = newDeviceToken();
  const linked = await db.from("devices").insert({
    tester_id: found.data.tester_id,
    install_id: installId,
    token_hash: await sha256Hex(token),
    label: optionalText(body.label, 120),
  });
  if (linked.error) {
    console.error("device insert failed", linked.error);
    return json(req, 500, { error: "The link service had a problem. Try again." });
  }
  const claimed = await db
    .from("link_codes")
    .update({ claimed_at: new Date().toISOString() })
    .eq("code", code)
    .is("claimed_at", null);
  if (claimed.error) {
    console.error("link code claim failed", claimed.error);
  }

  return json(req, 200, {
    ok: true,
    token,
    account: { email: maskEmail(account.email ?? "") },
  });
});
