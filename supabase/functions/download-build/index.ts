// download-build — turns an entitlement into a short-lived download link.
//
// The builds bucket is private; nothing in it has a public URL. A signed-in
// dashboard user asks for a build by id, this function checks that the build
// is published and that an early-channel build is covered by an active
// early_build entitlement, and answers with a signed URL that lasts a minute.
// The SHA-256 from the catalog rides along so the page can show the value to
// verify the download against.
//
// Deployed with verify_jwt enabled: only a signed-in account can even reach
// this function, and the user's own JWT — not anything the browser claims —
// identifies the account.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { json, preflight, readJson, serviceClient } from "../_shared/mod.ts";

const SIGNED_URL_SECONDS = 60;

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") {
    return json(req, 405, { error: "POST only" });
  }

  // Whose request this is comes from the verified JWT, resolved by Auth.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authed = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await authed.auth.getUser();
  if (userError || !userData?.user) {
    return json(req, 401, { error: "sign in to download builds" });
  }

  const body = await readJson(req, 4096);
  const buildId = Number(body?.build_id);
  if (!Number.isInteger(buildId) || buildId <= 0) {
    return json(req, 400, { error: "missing build id" });
  }

  const db = serviceClient();
  const account = await db
    .from("beta_testers")
    .select("tester_id, status")
    .eq("auth_user_id", userData.user.id)
    .maybeSingle();
  if (account.error || !account.data || account.data.status !== "active") {
    return json(req, 403, { error: "no active WavRead account for this sign-in" });
  }

  const build = await db
    .from("builds")
    .select("id, channel, file_name, storage_path, sha256, size_bytes, published")
    .eq("id", buildId)
    .maybeSingle();
  if (build.error || !build.data || !build.data.published) {
    return json(req, 404, { error: "that build is not available" });
  }

  if (build.data.channel === "early") {
    const entitled = await db
      .from("entitlements")
      .select("id")
      .eq("tester_id", account.data.tester_id)
      .eq("entitlement", "early_build")
      .is("revoked_at", null)
      .maybeSingle();
    if (entitled.error || !entitled.data) {
      return json(req, 403, { error: "this build needs the Early Build purchase" });
    }
  }

  const signed = await db.storage
    .from("builds")
    .createSignedUrl(build.data.storage_path, SIGNED_URL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    console.error("signed url failed", signed.error);
    return json(req, 500, { error: "the download could not be prepared" });
  }

  return json(req, 200, {
    url: signed.data.signedUrl,
    file_name: build.data.file_name,
    sha256: build.data.sha256,
    size_bytes: build.data.size_bytes,
    expires_in: SIGNED_URL_SECONDS,
  });
});
