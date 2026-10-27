// article-review — a person's decision on a submitted article.
//
// needs_changes, approved or rejected, with notes for the writer. Callable by
// the owner signed in, or with the service role key (tools/review-submissions
// prints the call for the owner to make). It NEVER publishes: "published" is
// not a decision this accepts, and approving leaves the article waiting for
// article-publish-approved, which is a separate, explicit call.
//
// Plain JavaScript with no Deno globals, so tests/article-functions.test.mjs
// runs it under node:test exactly as index.ts runs it.

import {
  LIMITS,
  REVIEWABLE,
  REVIEW_DECISIONS,
  SUBMISSION_COLUMNS,
  canTransition,
  databaseRefusal,
  isSubmissionId,
} from "../_shared/submissions.mjs";

export async function handleReview(req, deps) {
  const respond = (status, body) => deps.json(req, status, body);
  if (req.method !== "POST") return respond(405, { error: "POST only" });

  const reviewer = await deps.reviewer(req);
  if (!reviewer) return respond(401, { error: "Sign in to continue." });
  if (reviewer.kind === "denied") return respond(403, { error: "Only the owner can review articles." });

  const body = await deps.readJson(req, 16 * 1024);
  if (!isSubmissionId(body?.id)) return respond(400, { error: "Name the article by its id." });
  const decision = String(body?.decision ?? "");
  if (!REVIEW_DECISIONS.has(decision)) {
    return respond(400, {
      error: "A review decides needs_changes, approved or rejected. Publishing is a separate step (article-publish-approved).",
    });
  }
  const notes = typeof body?.reviewer_notes === "string" ? body.reviewer_notes.replace(/\r\n?/g, "\n").trim() : "";
  if (notes.length > LIMITS.notes.max) return respond(400, { error: `Keep the notes under ${LIMITS.notes.max} characters.` });
  if (decision !== "approved" && !notes) {
    return respond(400, { error: "Say what needs to change, or why it was not accepted. The writer reads these notes." });
  }

  const current = await deps.admin.from("article_submissions").select("id, status").eq("id", body.id).maybeSingle();
  if (current.error) {
    const refused = databaseRefusal(current.error);
    return respond(refused.status, refused.body);
  }
  if (!current.data) return respond(404, { error: "No article has that id." });
  const from = current.data.status;
  if (!REVIEWABLE.has(from) || !canTransition(from, decision, "reviewer")) {
    return respond(409, { error: `An article that is ${from} cannot be marked ${decision}.`, status: from });
  }

  const reviewed = await deps.admin.from("article_submissions")
    .update({ status: decision, reviewer_notes: notes || null })
    .eq("id", body.id)
    .eq("status", from)
    .select(SUBMISSION_COLUMNS)
    .maybeSingle();
  if (reviewed.error) {
    const refused = databaseRefusal(reviewed.error);
    return respond(refused.status, refused.body);
  }
  if (!reviewed.data) return respond(409, { error: "The article changed while you were reviewing it. Reload and try again." });
  return respond(200, { submission: reviewed.data, published: false, reviewer: reviewer.kind });
}
