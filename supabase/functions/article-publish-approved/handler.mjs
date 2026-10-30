// article-publish-approved — turns one approved article into its Markdown file.
//
// The only step that publishes, and only ever on purpose: it is called by the
// owner (or with the service role key), for one article, after it was
// approved. It refuses anything that is not approved. It writes the file the
// articles build reads, content/articles/community/<slug>.md, into
// article_publish_queue, and marks the article published with that path, in
// one database transaction (publish_approved_submission).
//
// It does not write to the repository. Doing that from here would put a GitHub
// credential in the function's environment; instead the owner exports the
// queue (tools/export-publish-queue.mjs), commits the file, and builds. Pages
// for community articles appear once the articles build reads community/
// (PR #8, feat/articles-cms-lite, and the follow-on that README describes).
//
// Plain JavaScript with no Deno globals, so tests/article-functions.test.mjs
// runs it under node:test exactly as index.ts runs it.

import {
  SUBMISSION_COLUMNS,
  buildMarkdown,
  communityPath,
  databaseRefusal,
  isIsoDate,
  isSlug,
  isSubmissionId,
  slugify,
  submissionProblems,
  voiceWarnings,
} from "../_shared/submissions.mjs";

export async function handlePublish(req, deps) {
  const respond = (status, body) => deps.json(req, status, body);
  if (req.method !== "POST") return respond(405, { error: "POST only" });

  const reviewer = await deps.reviewer(req);
  if (!reviewer) return respond(401, { error: "Sign in to continue." });
  if (reviewer.kind === "denied") return respond(403, { error: "Only the owner can publish articles." });

  const body = await deps.readJson(req, 4096);
  if (!isSubmissionId(body?.id)) return respond(400, { error: "Name the article by its id." });

  const current = await deps.admin.from("article_submissions")
    .select(`${SUBMISSION_COLUMNS}, author_tester_id`)
    .eq("id", body.id)
    .maybeSingle();
  if (current.error) {
    const refused = databaseRefusal(current.error);
    return respond(refused.status, refused.body);
  }
  if (!current.data) return respond(404, { error: "No article has that id." });
  const article = current.data;
  if (article.status === "published") {
    return respond(409, { error: `This article is already published at ${article.published_path}.`, status: article.status });
  }
  if (article.status !== "approved") {
    return respond(409, { error: `Only an approved article can be published. This one is ${article.status}.`, status: article.status });
  }

  const author = await deps.admin.from("accounts")
    .select("public_slug, status")
    .eq("tester_id", article.author_tester_id)
    .maybeSingle();
  if (author.error) {
    const refused = databaseRefusal(author.error);
    return respond(refused.status, refused.body);
  }
  if (!author.data?.public_slug) {
    return respond(409, {
      error: "The writer has no public profile address yet, and the file names its author by it. Ask them to set one on /account.",
      code: "author_slug_missing",
    });
  }

  // Approved articles were complete when submitted and cannot have changed
  // since; checking again costs nothing and keeps a broken file out of the build.
  const problems = submissionProblems(article);
  if (problems.length) return respond(422, { error: "This article would not build.", problems });

  const slug = body.slug === undefined || body.slug === null ? slugify(article.title) : String(body.slug);
  if (!isSlug(slug)) {
    return respond(400, { error: "The slug must be 3 to 80 lowercase letters, digits and single hyphens." });
  }
  const date = body.date === undefined || body.date === null ? deps.today() : String(body.date);
  if (!isIsoDate(date)) return respond(400, { error: "The date must be a real date written YYYY-MM-DD." });

  const markdown = buildMarkdown({
    title: article.title,
    date,
    lanes: article.lanes,
    summary: article.summary,
    authorSlug: author.data.public_slug,
    body: article.body_markdown,
  });

  const published = await deps.admin.rpc("publish_approved_submission", {
    target_id: article.id,
    target_slug: slug,
    target_markdown: markdown,
  });
  if (published.error) {
    const refused = databaseRefusal(published.error);
    return respond(refused.status, refused.body);
  }
  const path = communityPath(slug);
  return respond(200, {
    id: article.id,
    slug,
    path,
    markdown,
    warnings: voiceWarnings(article),
    next: `Run tools/export-publish-queue.mjs to write ${path}, commit it, and build. The page appears once the articles build reads content/articles/community/.`,
  });
}
