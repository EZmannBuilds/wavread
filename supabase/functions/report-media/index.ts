// report-media — hands a caller a signed URL to upload one attachment.
//
// Nobody writes storage directly. The caller asks here, this function decides
// whether the ask is allowed, and only then mints a one-shot upload URL for a
// path the caller does not get to choose. That is the rule the rest of this
// backend follows: a client reads its own rows and writes nothing that decides
// anything.
//
// Why a signed URL rather than the file itself: a 25 MB multipart body would be
// buffered whole in this function's memory and pay for the bytes twice, once
// inbound here and once outbound to storage. The bucket's allowed_mime_types is
// what actually refuses a disallowed type at write time, so routing the bytes
// through this process would buy checking we already have.
//
// Two callers, one contract. The dashboard sends a Supabase session in the
// Authorization header; the desktop app sends the device token it got from
// link-device, in the body, because it has no session and never will. Both are
// resolved to the same thing — the tester_id whose report this must be — and
// every check below is written against that, so neither caller has a path the
// other does not.
//
// Deployed with verify_jwt DISABLED, which is a deliberate change: the platform
// gate would reject the app before this code ran. Nothing here is reachable
// without authenticating, and refusing to authenticate is the first thing it
// does. It is the same shape as submit-report and crash-report.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

import {
  isUuid,
  json,
  preflight,
  readJson,
  resolveDevice,
  serviceClient,
} from "../_shared/mod.ts";

// Two files, because a report is a description with evidence attached, not an
// album. Both numbers are also enforced by the bucket and the column check —
// this is the one that can explain itself.
const MAX_PER_REPORT = 2;
const MAX_BYTES = 25 * 1024 * 1024;

// Kept in step with the bucket's allowed_mime_types. Images and video only:
// audio is the one thing this product promises never to move.
const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

// beta_feedback.id is a bigint. It was read here with isUuid, which is true of
// no bigint ever, so every attachment attempt was refused with "missing report
// id" and the count of attachments ever stored stayed at zero. Report ids
// arrive as JSON numbers from the app and as numbers or numeric strings from
// the browser; all three are the same row.
function reportId(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && /^[0-9]{1,15}$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/** The tester this request is acting as, however it proved it. */
async function caller(
  req: Request,
  db: ReturnType<typeof serviceClient>,
  token: unknown,
): Promise<{ testerId: string; via: "app" | "web" } | null> {
  // The app's device token. resolveDevice already refuses a revoked device and
  // an account that is not active, and touches last_seen_at.
  if (token !== undefined) {
    const device = await resolveDevice(db, token);
    return device ? { testerId: device.testerId, via: "app" } : null;
  }

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization) return null;
  const authed = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { data, error } = await authed.auth.getUser();
  if (error || !data?.user) return null;

  // A session proves who the user is; the account row is what owns reports.
  const account = await db
    .from("accounts")
    .select("tester_id, status")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();
  if (account.error || !account.data || account.data.status !== "active") {
    return null;
  }
  return { testerId: account.data.tester_id as string, via: "web" };
}

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  const body = await readJson(req, 8192);
  if (!body) return json(req, 400, { error: "unreadable request" });

  const db = serviceClient();
  const who = await caller(req, db, body.token);
  if (!who) {
    return json(req, 401, {
      error: "sign in to attach a file, or link this install to your account.",
    });
  }

  // Second call: the upload finished, so the row stops claiming to be pending.
  // A row left pending is an upload that was started and abandoned, which is
  // exactly what a cleanup wants to be able to find.
  if (body.attachment_id !== undefined) {
    if (!isUuid(body.attachment_id)) {
      return json(req, 400, { error: "missing attachment id" });
    }
    const owned = await db
      .from("feedback_attachments")
      .select("id, beta_feedback!inner(tester_id)")
      .eq("id", body.attachment_id)
      .maybeSingle();
    const holder = (owned.data as {
      beta_feedback?: { tester_id?: string };
    } | null)?.beta_feedback;
    if (owned.error || !owned.data || holder?.tester_id !== who.testerId) {
      // Not "that is not yours": a caller who cannot have it does not learn
      // whether it exists.
      return json(req, 404, { error: "no such attachment" });
    }
    const done = await db
      .from("feedback_attachments")
      .update({ status: "stored" })
      .eq("id", body.attachment_id);
    if (done.error) {
      console.error("attachment confirm failed", done.error);
      return json(req, 500, { error: "the attachment could not be confirmed" });
    }
    return json(req, 200, { status: "stored" });
  }

  const feedbackId = reportId(body.feedback_id);
  if (feedbackId === null) {
    return json(req, 400, { error: "missing report id" });
  }
  const mime = String(body.mime_type ?? "");
  const extension = TYPES[mime];
  if (!extension) {
    return json(req, 415, {
      error: "that file type cannot be attached. Screenshots (PNG, JPEG, WebP, "
           + "GIF) and short clips (MP4, MOV, WebM) can.",
    });
  }
  const size = Number(body.size_bytes);
  if (!Number.isFinite(size) || size <= 0) {
    return json(req, 400, { error: "missing file size" });
  }
  if (size > MAX_BYTES) {
    return json(req, 413, {
      error: `that file is ${(size / 1048576).toFixed(1)} MB. The limit is 25 MB `
           + "— a screen recording of the moment it goes wrong is usually enough.",
    });
  }

  // The report must exist and must belong to whoever is asking. Source is no
  // longer part of the test: the app can attach now, so "web reports only"
  // would refuse the very case this function was changed to allow. Ownership
  // is the rule, and it is the same rule for both callers.
  const report = await db
    .from("beta_feedback")
    .select("id, tester_id")
    .eq("id", feedbackId)
    .maybeSingle();
  if (report.error || !report.data || report.data.tester_id !== who.testerId) {
    return json(req, 404, { error: "no such report" });
  }

  const existing = await db
    .from("feedback_attachments")
    .select("id", { count: "exact", head: true })
    .eq("feedback_id", feedbackId);
  if (existing.error) {
    console.error("attachment count failed", existing.error);
    return json(req, 500, { error: "the attachment could not be prepared" });
  }
  if ((existing.count ?? 0) >= MAX_PER_REPORT) {
    return json(req, 409, {
      error: `a report can carry ${MAX_PER_REPORT} files. Send another report if `
           + "there is more to show.",
    });
  }

  // The path is ours, not the caller's: a filename from a form is an untrusted
  // string, and one that decides where bytes land is a traversal waiting to be
  // tried.
  const objectPath = `${feedbackId}/${crypto.randomUUID()}.${extension}`;

  const row = await db
    .from("feedback_attachments")
    .insert({
      feedback_id: feedbackId,
      object_path: objectPath,
      mime_type: mime,
      size_bytes: Math.round(size),
      status: "pending",
    })
    .select("id")
    .single();
  if (row.error) {
    console.error("attachment row failed", row.error);
    return json(req, 500, { error: "the attachment could not be prepared" });
  }

  const signed = await db.storage
    .from("report-media")
    .createSignedUploadUrl(objectPath);
  if (signed.error || !signed.data) {
    console.error("signed upload url failed", signed.error);
    // Leave no row claiming an upload that can never happen.
    await db.from("feedback_attachments").delete().eq("id", row.data.id);
    return json(req, 500, { error: "the attachment could not be prepared" });
  }

  return json(req, 200, {
    attachment_id: row.data.id,
    path: objectPath,
    token: signed.data.token,
  });
});
