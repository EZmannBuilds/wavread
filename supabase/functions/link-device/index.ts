// link-device — connects a desktop install to an account, revocably.
//
// The dashboard shows a short-lived single-use code; the user types it into
// WavRead's Settings. The app trades the code for an opaque random token and
// that token is all the app ever holds: no email, no password, no session.
// Only the token's SHA-256 is stored, so nothing readable from the database
// can impersonate a device, and revoking the device (from either side) ends
// the link without touching account history.
//
// An account on a trial links at most two devices (trial-cap.mjs); owning
// WavRead keeps the policy linking always had. The cap is checked before
// anything is written, so a refused code still works once a device is revoked.
//
// Deployed with verify_jwt disabled: the desktop app has no Supabase session.
// The one-time code is the proof of account access.
//
// action "standing" is the trial build's check-in: token in, owned / trial /
// trial_expires_at out (see the handler below).

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
import { trialDeviceRefusal } from "./trial-cap.mjs";

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

  if (body.action === "standing") {
    // The trial build of the desktop app asks this every few days, with the
    // token it was given at linking: whether the account owns WavRead now, and
    // when its trial ends. A paid copy never asks. The answer is three facts,
    // nothing about the account beyond them, and an unknown or revoked token
    // is told so in a form the app acts on: it asks to be linked again.
    const token = typeof body.token === "string" ? body.token : "";
    const unknown = { error: "This device is not linked to an account.", code: "unknown_device" };
    if (token.length < 20 || token.length > 128) return json(req, 401, unknown);
    const device = await db
      .from("devices")
      .select("id, tester_id, install_id")
      .eq("token_hash", await sha256Hex(token))
      .is("revoked_at", null)
      .maybeSingle();
    if (device.error) {
      console.error("device lookup failed", device.error);
      return json(req, 500, { error: "The link service had a problem. Try again." });
    }
    if (!device.data) return json(req, 401, unknown);
    const standing = await db.rpc("account_standing", {
      account: device.data.tester_id,
      install: device.data.install_id,
    });
    if (standing.error || !standing.data) {
      console.error("standing lookup failed", standing.error);
      return json(req, 500, { error: "The link service had a problem. Try again." });
    }
    // When the dashboard last heard from this device. Best effort: the answer
    // above is what the app is waiting for.
    const seen = await db
      .from("devices")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", device.data.id);
    if (seen.error) console.error("last seen update failed", seen.error);
    return json(req, 200, {
      owned: standing.data.owned === true,
      trial: standing.data.trial ?? null,
      trial_expires_at: standing.data.trial_expires_at ?? null,
    });
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
    .select("code, tester_id, expires_at, claimed_at, accounts ( email, status )")
    .eq("code", code)
    .maybeSingle();
  if (found.error) {
    console.error("link code lookup failed", found.error);
    return json(req, 500, { error: "The link service had a problem. Try again." });
  }
  const account = found.data?.accounts as unknown as {
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

  const standing = await db.rpc("account_standing", {
    account: found.data.tester_id,
    install: installId,
  });
  if (standing.error) {
    console.error("standing lookup failed", standing.error);
    return json(req, 500, { error: "The link service had a problem. Try again." });
  }
  const capped = trialDeviceRefusal(standing.data);
  if (capped) return json(req, 409, capped);

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
