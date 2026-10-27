// article-submission-submit — the editor's "Submit for review".
//
// Moves one of the caller's drafts (or an article sent back with changes
// requested) to pending, once it is complete enough to review. The database
// stamps submitted_at and caps how many can wait at once. Runs under RLS as the
// caller; nothing here can approve or publish.
//
// Plain JavaScript with no Deno globals, so tests/article-functions.test.mjs
// runs it under node:test exactly as index.ts runs it.

import {
  AUTHOR_EDITABLE,
  SUBMISSION_COLUMNS,
  databaseRefusal,
  isSubmissionId,
  lockedMessage,
  submissionProblems,
  voiceWarnings,
} from "../_shared/submissions.mjs";
import { authorFrom } from "../_shared/reviewers.mjs";

export async function handleSubmit(req, deps) {
  const respond = (status, body) => deps.json(req, status, body);
  if (req.method !== "POST") return respond(405, { error: "POST only" });

  const author = await authorFrom(deps.authed);
  if (author.error) return respond(author.status, { error: author.error, code: author.code });

  const body = await deps.readJson(req, 4096);
  if (!isSubmissionId(body?.id)) return respond(400, { error: "Save the draft first, then submit it." });

  const current = await deps.authed.from("article_submissions")
    .select(SUBMISSION_COLUMNS)
    .eq("id", body.id)
    .maybeSingle();
  if (current.error) {
    const refused = databaseRefusal(current.error);
    return respond(refused.status, refused.body);
  }
  if (!current.data) return respond(404, { error: "No article of yours has that id.", code: "not_found" });
  if (!AUTHOR_EDITABLE.has(current.data.status)) {
    return respond(409, { error: lockedMessage(current.data.status), code: "locked", status: current.data.status });
  }

  const problems = submissionProblems(current.data);
  if (problems.length) {
    return respond(422, { error: "A few things need fixing before this can be reviewed.", problems, code: "incomplete" });
  }

  const submitted = await deps.authed.from("article_submissions")
    .update({ status: "pending" })
    .eq("id", body.id)
    .in("status", [...AUTHOR_EDITABLE])
    .select(SUBMISSION_COLUMNS)
    .maybeSingle();
  if (submitted.error) {
    const refused = databaseRefusal(submitted.error);
    return respond(refused.status, refused.body);
  }
  if (!submitted.data) return respond(409, { error: lockedMessage("pending"), code: "locked" });
  // The voice notes are advice. They were shown in the editor before this, and
  // the reviewer sees the same ones; they never stop a submission.
  return respond(200, { submission: submitted.data, warnings: voiceWarnings(current.data) });
}
