// article-submission-save — the editor's "Save draft".
//
// Creates the caller's draft, or saves over one of theirs that is still a draft
// or was sent back with changes requested (saving one of those makes it a
// draft again; the reviewer's notes stay on it). Every write runs under RLS as
// the caller: the function only cleans the fields and words the answers.
//
// Plain JavaScript with no Deno globals, so tests/article-functions.test.mjs
// runs it under node:test exactly as index.ts runs it.

import {
  AUTHOR_EDITABLE,
  SUBMISSION_COLUMNS,
  databaseRefusal,
  isSubmissionId,
  lockedMessage,
  normalizeDraft,
  voiceWarnings,
} from "../_shared/submissions.mjs";
import { authorFrom } from "../_shared/reviewers.mjs";

// A 40,000-character article, JSON-escaped, with room to spare.
const MAX_BODY_BYTES = 192 * 1024;

export async function handleSave(req, deps) {
  const respond = (status, body) => deps.json(req, status, body);
  if (req.method !== "POST") return respond(405, { error: "POST only" });

  const author = await authorFrom(deps.authed);
  if (author.error) return respond(author.status, { error: author.error, code: author.code });

  const body = await deps.readJson(req, MAX_BODY_BYTES);
  if (!body) return respond(400, { error: "The draft could not be read. It may be too long." });
  const { fields, problems } = normalizeDraft(body);
  if (problems.length) return respond(400, { error: problems[0], problems });

  const table = deps.authed.from("article_submissions");
  let saved;
  if (body.id !== undefined && body.id !== null) {
    if (!isSubmissionId(body.id)) return respond(400, { error: "That is not an article id." });
    const current = await table.select("id, status").eq("id", body.id).maybeSingle();
    if (current.error) {
      const refused = databaseRefusal(current.error);
      return respond(refused.status, refused.body);
    }
    if (!current.data) return respond(404, { error: "No article of yours has that id.", code: "not_found" });
    if (!AUTHOR_EDITABLE.has(current.data.status)) {
      return respond(409, { error: lockedMessage(current.data.status), code: "locked", status: current.data.status });
    }
    saved = await deps.authed.from("article_submissions")
      .update({ ...fields, status: "draft" })
      .eq("id", body.id)
      .in("status", [...AUTHOR_EDITABLE])
      .select(SUBMISSION_COLUMNS)
      .maybeSingle();
    // Submitted from another tab between the read and the write.
    if (!saved.error && !saved.data) return respond(409, { error: lockedMessage("pending"), code: "locked" });
  } else {
    saved = await table
      .insert({ ...fields, author_tester_id: author.testerId })
      .select(SUBMISSION_COLUMNS)
      .single();
  }
  if (saved.error) {
    const refused = databaseRefusal(saved.error);
    return respond(refused.status, refused.body);
  }
  return respond(200, { submission: saved.data, warnings: voiceWarnings(fields) });
}
