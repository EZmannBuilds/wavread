// submit-report — the desktop app's Report a Problem page lands here.
//
// Unlike crash reports, a written report is deliberate, so it requires a
// linked device: the report token proves account access and the report joins
// the account's history on the dashboard. The app shows the user exactly
// what will be sent before sending; this function enforces the same bounds
// the database does and rate-limits per device.
//
// A report may carry the crash record it is about, and a scrubbed excerpt of
// the app's own log when the user chose to include one.
//
// Deployed with verify_jwt disabled: the desktop app has no Supabase session.
// The report token from link-device is the authentication.

import {
  boundedText,
  json,
  optionalText,
  preflight,
  readJson,
  resolveDevice,
  serviceClient,
  validateCrash,
} from "../_shared/mod.ts";

const MAX_PER_DEVICE_PER_HOUR = 10;
const FEEDBACK_TYPES = new Set(["bug", "feature", "general"]);

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") {
    return json(req, 405, { error: "POST only" });
  }

  const body = await readJson(req);
  if (!body) return json(req, 400, { error: "unreadable request" });

  const db = serviceClient();
  const device = await resolveDevice(db, body.token);
  if (!device) {
    return json(req, 401, {
      error:
        "This install is not linked to an account, or the link was revoked. " +
        "Link it again from Settings.",
    });
  }

  const feedbackType = String(body.feedback_type ?? "");
  const title = boundedText(body.title, 3, 120);
  const description = boundedText(body.description, 20, 4000);
  const appVersion = boundedText(body.app_version, 1, 40);
  if (!FEEDBACK_TYPES.has(feedbackType)) {
    return json(req, 400, { error: "unknown report type" });
  }
  if (!title) return json(req, 400, { error: "title must be 3–120 characters" });
  if (!description) {
    return json(req, 400, { error: "description must be 20–4000 characters" });
  }
  if (!appVersion) return json(req, 400, { error: "missing app version" });

  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await db
    .from("beta_feedback")
    .select("id", { count: "exact", head: true })
    .eq("source", "app")
    .eq("install_id", device.installId)
    .gt("created_at", hourAgo);
  if (recent.error) {
    console.error("rate limit lookup failed", recent.error);
    return json(req, 500, { error: "report service problem" });
  }
  if ((recent.count ?? 0) >= MAX_PER_DEVICE_PER_HOUR) {
    return json(req, 429, { error: "too many reports from this install right now" });
  }

  // The crash the report is about, when one is attached.
  let crashReportId: number | null = null;
  if (body.crash && typeof body.crash === "object" && !Array.isArray(body.crash)) {
    const checked = validateCrash(body.crash as Record<string, unknown>);
    if ("error" in checked) {
      return json(req, 400, { error: `attached crash: ${checked.error}` });
    }
    const inserted = await db
      .from("crash_reports")
      .insert({
        ...checked.crash,
        tester_id: device.testerId,
        device_id: device.deviceId,
      })
      .select("id")
      .single();
    if (inserted.error) {
      console.error("attached crash insert failed", inserted.error);
      return json(req, 500, { error: "report service problem" });
    }
    crashReportId = inserted.data.id;
  }

  const saved = await db
    .from("beta_feedback")
    .insert({
      tester_id: device.testerId,
      feedback_type: feedbackType,
      title,
      description,
      reproduction_steps: optionalText(body.reproduction_steps, 3000),
      app_version: appVersion,
      operating_system: optionalText(body.operating_system, 120),
      follow_up_allowed: body.follow_up_allowed === true,
      source: "app",
      install_id: device.installId,
      crash_report_id: crashReportId,
      log_excerpt: optionalText(body.log_excerpt, 10000),
    })
    .select("id")
    .single();
  if (saved.error) {
    console.error("report insert failed", saved.error);
    return json(req, 500, { error: "report service problem" });
  }
  return json(req, 200, { ok: true, id: saved.data.id });
});
