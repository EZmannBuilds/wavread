// The owner's tools for articles: the review helper, which proposes and never
// sends, and the queue export, which writes community files without ever
// overwriting one.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPending, proposals, report, reviewCommand } from "../tools/review-submissions.mjs";
import { exportQueue, fetchQueue } from "../tools/export-publish-queue.mjs";
import { buildMarkdown } from "../supabase/functions/_shared/submissions.mjs";
import { COMPLETE } from "./fixtures/article.mjs";

const pending = (over = {}) => ({ id: "00000000-0000-4000-8000-000000000001", status: "pending", submitted_at: "2026-10-27T10:00:00Z", ...COMPLETE, ...over });

test("the review helper proposes for pending articles only, and sends nothing", async () => {
  const list = proposals([pending(), pending({ id: "00000000-0000-4000-8000-000000000002", status: "draft" }), null]);
  assert.equal(list.length, 1);
  assert.equal(list[0].decision, "approved");
  const text = report(list);
  assert.match(text, /proposed: approved/);
  assert.match(text, /Read the whole article first/);
  assert.match(text, /Nothing was sent\. Approving does not publish/);
  assert.match(report([]), /No articles are waiting/);
  const command = reviewCommand({ id: "x", decision: "needs_changes", notes: "It's close." });
  assert.match(command, /article-review/);
  assert.doesNotMatch(command, /article-publish-approved/);
  assert.match(command, /\$SUPABASE_SERVICE_ROLE_KEY/, "the key is named, never printed");
  assert.match(command, /'\{"id":"x","decision":"needs_changes","reviewer_notes":"It'\\''s close\."\}'/, "the notes are shell-quoted");

  const seen = [];
  const rows = await fetchPending({ url: "https://p.supabase.co/", key: "k", fetchImpl: async (url, init) => {
    seen.push([url, init.headers]);
    return { ok: true, json: async () => [pending()] };
  } });
  assert.equal(rows.length, 1);
  assert.match(seen[0][0], /^https:\/\/p\.supabase\.co\/rest\/v1\/article_submissions\?status=eq\.pending&/);
  assert.deepEqual(seen[0][1], { apikey: "k", Authorization: "Bearer k" });
  const source = await readFile("tools/review-submissions.mjs", "utf8");
  assert.doesNotMatch(source, /method:\s*"(POST|PATCH)"/, "the helper only reads");
});

test("the export writes community files, and never overwrites or shadows a staff post", async () => {
  const root = await mkdtemp(join(tmpdir(), "wavread-export-"));
  try {
    await mkdir(join(root, "content/articles"), { recursive: true });
    await writeFile(join(root, "content/articles/staff-post.md"), "---\n---\n");
    const markdown = (body = COMPLETE.body_markdown) => buildMarkdown({ title: COMPLETE.title, date: "2026-10-27", lanes: ["musician"], summary: COMPLETE.summary, authorSlug: "jane-doe", body });
    const rows = [
      { id: 1, slug: "a-community-post", path: "content/articles/community/a-community-post.md", markdown: markdown(`${COMPLETE.body_markdown}\n\nDone — at last.`) },
      { id: 2, slug: "staff-post", path: "content/articles/community/staff-post.md", markdown: markdown() },
      { id: 3, slug: "elsewhere", path: "docs/elsewhere.md", markdown: markdown() },
      { id: 4, slug: "../escape", path: "content/articles/community/../escape.md", markdown: markdown() },
    ];
    const first = await exportQueue(rows, { root });
    assert.deepEqual(first.written.map((w) => w.slug), ["a-community-post"]);
    assert.equal(await readFile(join(root, "content/articles/community/a-community-post.md"), "utf8"), rows[0].markdown);
    assert.match(first.written[0].notes.join(), /em dash/, "the voice notes come with the file");
    assert.deepEqual(first.refused.map((r) => r.slug), ["staff-post", "elsewhere", "../escape"]);
    assert.match(first.refused[0].reason, /staff post with the same URL/);

    const again = await exportQueue([rows[0]], { root });
    assert.equal(again.written.length, 0);
    assert.match(again.refused[0].reason, /never overwritten/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const seen = [];
  await fetchQueue({ url: "https://p.supabase.co", key: "k", fetchImpl: async (url) => {
    seen.push(url);
    return { ok: true, json: async () => [] };
  } });
  assert.match(seen[0], /article_publish_queue\?exported_at=is\.null/);
});
