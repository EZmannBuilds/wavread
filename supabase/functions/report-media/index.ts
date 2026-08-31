// report-media — hands the dashboard a signed URL to upload one attachment.
//
// The browser never writes storage directly. It asks here, this function
// decides whether the ask is allowed, and only then does it mint a one-shot
// upload URL for a path the caller does not get to choose. That is the same
// rule the rest of this backend follows: the browser reads its own rows and
// writes nothing that decides anything.
//
// Why a signed URL rather than the file itself: a 25 MB multipart body would
// be buffered whole in the function's memory and pay for the bytes twice, once
// inbound here and once outbound to storage. The bucket's allowed_mime_types
// is what actually refuses a disallowed type at write time, so routing the
// bytes through this process would buy checking we already have.
//
// Deployed with verify_jwt enabled: the caller is a signed-in dashboard
// session, and there is no app-side path into this function at all.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

import { isUuid, json, preflight, serviceClient } from "../_shared/mod.ts";

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

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authed = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await authed.auth.getUser();
  if (userError || !userData?.user) {
    return json(req, 401, { error: "sign in to attach a file" });
  }

  let body: {
    feedback_id?: unknown; mime_type?: unknown; size_bytes?: unknown;
    attachment_id?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return json(req, 400, { error: "unreadable request" });
  }

  // Second call: the upload finished, so the row stops claiming to be pending.
  // A row left pending is an upload that was started and abandoned, which is
  // exactly what a cleanup wants to be able to find.
  if (body.attachment_id !== undefined) {
    if (!isUuid(body.attachment_id)) {
      return json(req, 400, { error: "missing attachment id" });
    }
    const db = serviceClient();
    const owned = await db
      .from("feedback_attachments")
      .select("id, beta_feedback!inner(accounts!inner(auth_user_id))")
      .eq("id", body.attachment_id)
      .maybeSingle();
    const holder = (owned.data as {
      beta_feedback?: { accounts?: { auth_user_id?: string } };
    } | null)?.beta_feedback?.accounts;
    if (owned.error || !owned.data || holder?.auth_user_id !== userData.user.id) {
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

  const feedbackId = body.feedback_id;
  if (!isUuid(feedbackId)) {
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

  const db = serviceClient();

  // The report must exist, must belong to whoever is asking, and must have come
  // from the website. Attaching to the app's own reports is not offered: the
  // app sends no files, and a web session should not be able to add any.
  const report = await db
    .from("beta_feedback")
    .select("id, source, accounts!inner(auth_user_id)")
    .eq("id", feedbackId)
    .maybeSingle();
  if (report.error || !report.data) {
    return json(req, 404, { error: "no such report" });
  }
  const owner = (report.data as { accounts?: { auth_user_id?: string } }).accounts;
  if (!owner || owner.auth_user_id !== userData.user.id) {
    return json(req, 403, { error: "that report is not yours" });
  }
  if (report.data.source !== "web") {
    return json(req, 409, { error: "reports sent from the app cannot take attachments" });
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
