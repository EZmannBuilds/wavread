// crash-report — receives crash records from the desktop app.
//
// The app sends these only when the user has turned problem reports on, and
// it scrubs first: usernames, track names, and library paths never leave the
// machine. This function validates against the same bounds the database
// enforces, deduplicates repeats of one failure, and rate-limits per install
// so a crash loop cannot flood anything.
//
// A report token (from link-device) is optional. With one, the report is
// attributed to the account so it appears on the owner's dashboard; without
// one it is recorded against the anonymous install id only.
//
// Deployed with verify_jwt disabled: the desktop app has no Supabase session,
// and a crash report must be sendable before any account exists.

import {
  json,
  preflight,
  readJson,
  resolveDevice,
  serviceClient,
  validateCrash,
} from "../_shared/mod.ts";

const MAX_PER_INSTALL_PER_HOUR = 20;
const DEDUPE_WINDOW_HOURS = 24;

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") {
    return json(req, 405, { error: "POST only" });
  }

  const body = await readJson(req);
  if (!body) return json(req, 400, { error: "unreadable request" });
  const checked = validateCrash(body);
  if ("error" in checked) return json(req, 400, { error: checked.error });
  const crash = checked.crash;

  const db = serviceClient();
  const device = await resolveDevice(db, body.token);

  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await db
    .from("crash_reports")
    .select("id", { count: "exact", head: true })
    .eq("install_id", crash.install_id)
    .gt("created_at", hourAgo);
  if (recent.error) {
    console.error("rate limit lookup failed", recent.error);
    return json(req, 500, { error: "report service problem" });
  }
  if ((recent.count ?? 0) >= MAX_PER_INSTALL_PER_HOUR) {
    return json(req, 429, { error: "too many reports from this install right now" });
  }

  // The same failure on the same version from the same install inside a day
  // is one fact, not many rows. The app treats a dedupe as sent.
  const windowStart = new Date(
    Date.now() - DEDUPE_WINDOW_HOURS * 3600 * 1000,
  ).toISOString();
  const duplicate = await db
    .from("crash_reports")
    .select("id")
    .eq("install_id", crash.install_id)
    .eq("fingerprint", crash.fingerprint)
    .eq("app_version", crash.app_version)
    .gt("created_at", windowStart)
    .limit(1)
    .maybeSingle();
  if (!duplicate.error && duplicate.data) {
    return json(req, 200, { ok: true, id: duplicate.data.id, deduplicated: true });
  }

  const inserted = await db
    .from("crash_reports")
    .insert({
      ...crash,
      tester_id: device?.testerId ?? null,
      device_id: device?.deviceId ?? null,
    })
    .select("id")
    .single();
  if (inserted.error) {
    console.error("crash insert failed", inserted.error);
    return json(req, 500, { error: "report service problem" });
  }
  return json(req, 200, { ok: true, id: inserted.data.id });
});
