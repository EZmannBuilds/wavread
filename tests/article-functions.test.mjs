// The four article functions, run end to end under node:test with an
// in-memory stand-in for the database: save -> submit -> review -> publish.
//
// The stand-in applies the rules the real database applies, in the same
// places: writers see and change only their own rows, and only while they are
// drafts (RLS); every status move goes through canTransition (the trigger);
// publish_approved_submission refuses anything not approved. The real
// database is exercised by tests/articles-db.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { handleSave } from "../supabase/functions/article-submission-save/handler.mjs";
import { handleSubmit } from "../supabase/functions/article-submission-submit/handler.mjs";
import { handleReview } from "../supabase/functions/article-review/handler.mjs";
import { handlePublish } from "../supabase/functions/article-publish-approved/handler.mjs";
import { reviewerFrom } from "../supabase/functions/_shared/reviewers.mjs";
import { AUTHOR_EDITABLE, canTransition } from "../supabase/functions/_shared/submissions.mjs";
import { COMPLETE } from "./fixtures/article.mjs";

const WRITER = { uid: "00000000-0000-4000-8000-00000000000a", tester: "00000000-0000-4000-8000-0000000000aa" };
const OTHER = { uid: "00000000-0000-4000-8000-00000000000b", tester: "00000000-0000-4000-8000-0000000000bb" };

function store() {
  let next = 1;
  const uuid = () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
  return {
    uuid,
    accounts: [
      { tester_id: WRITER.tester, auth_user_id: WRITER.uid, status: "active", public_slug: "jane-doe" },
      { tester_id: OTHER.tester, auth_user_id: OTHER.uid, status: "active", public_slug: null },
    ],
    article_submissions: [],
    article_publish_queue: [],
  };
}

const refuse = (code, message = code) => ({ code, message });

class Query {
  constructor(db, table, who) {
    Object.assign(this, { db, table, who, filters: [], op: "select", payload: null });
  }
  select() { return this; }
  insert(row) { this.op = "insert"; this.payload = row; return this; }
  update(patch) { this.op = "update"; this.payload = patch; return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
  async maybeSingle() {
    const result = this.run();
    return result.error ? { data: null, error: result.error } : { data: result.data[0] ?? null, error: null };
  }
  async single() {
    const result = this.run();
    if (result.error) return { data: null, error: result.error };
    return result.data.length === 1 ? { data: result.data[0], error: null } : { data: null, error: refuse("PGRST116") };
  }
  visible(row) {
    if (this.who.service) return true;
    const own = this.db.accounts.find((a) => a.auth_user_id === this.who.uid);
    if (this.table === "accounts") return row.auth_user_id === this.who.uid;
    if (this.table === "article_submissions") return Boolean(own) && row.author_tester_id === own.tester_id;
    return false;
  }
  run() {
    const rows = this.db[this.table];
    if (this.op === "insert") {
      const own = this.db.accounts.find((a) => a.auth_user_id === this.who.uid && a.status === "active");
      if (!this.who.service && (!own || this.payload.author_tester_id !== own.tester_id)) return { error: refuse("42501") };
      const row = { id: this.db.uuid(), status: "draft", reviewer_notes: null, submitted_at: null, reviewed_at: null,
        published_slug: null, published_path: null, published_at: null, ...this.payload };
      rows.push(row);
      return { data: [{ ...row }] };
    }
    let matched = rows.filter((row) => this.visible(row) && this.filters.every((f) => f(row)));
    if (this.op === "select") return { data: matched.map((row) => ({ ...row })) };
    const who = this.who.service ? "reviewer" : "author";
    // RLS: a writer's update reaches only their drafts, and may leave them only
    // as a draft or pending.
    if (who === "author") matched = matched.filter((row) => AUTHOR_EDITABLE.has(row.status));
    const out = [];
    for (const row of matched) {
      const next = { ...row, ...this.payload };
      if (who === "author" && !["draft", "pending"].includes(next.status)) return { error: refuse("42501") };
      if (!canTransition(row.status, next.status, who)) return { error: refuse("55000", `An article that is ${row.status} cannot become ${next.status}`) };
      if (next.status === "pending" && row.status !== "pending") next.submitted_at = "2026-10-27T10:00:00Z";
      if (["needs_changes", "approved", "rejected"].includes(next.status) && next.status !== row.status) next.reviewed_at = "2026-10-27T11:00:00Z";
      Object.assign(row, next);
      out.push({ ...row });
    }
    return { data: out };
  }
}

function client(db, who) {
  return {
    auth: { getUser: async () => (who.uid ? { data: { user: { id: who.uid } }, error: null } : { data: { user: null }, error: { message: "no session" } }) },
    from: (table) => new Query(db, table, who),
    rpc: async (name, args) => {
      if (name !== "publish_approved_submission" || !who.service) return { data: null, error: refuse("42501") };
      const row = db.article_submissions.find((r) => r.id === args.target_id);
      if (!row) return { data: null, error: refuse("P0002") };
      if (row.status !== "approved") return { data: null, error: refuse("55000", `Only an approved article can be published; this one is ${row.status}`) };
      if (db.article_submissions.some((r) => r.published_slug === args.target_slug)) return { data: null, error: refuse("23505") };
      Object.assign(row, { status: "published", published_slug: args.target_slug,
        published_path: `content/articles/community/${args.target_slug}.md`, published_at: "2026-10-27T12:00:00Z" });
      db.article_publish_queue.push({ submission_id: row.id, slug: args.target_slug, markdown: args.target_markdown });
      return { data: { id: row.id }, error: null };
    },
  };
}

const json = (_req, status, body) => ({ status, body });
const readJson = async (req) => req.json().catch(() => null);
const post = (body) => new Request("https://functions.test", { method: "POST", body: JSON.stringify(body) });

function harness() {
  const db = store();
  const as = (person) => ({ authed: client(db, person), json, readJson });
  const reviewer = (kind) => async () => (kind ? { kind } : null);
  const admin = (kind = "service") => ({ admin: client(db, { service: true }), json, readJson, reviewer: reviewer(kind), today: () => "2026-10-27" });
  return {
    db,
    save: (person, body) => handleSave(post(body), as(person)),
    submit: (person, body) => handleSubmit(post(body), as(person)),
    review: (body, kind) => handleReview(post(body), admin(kind)),
    publish: (body, kind) => handlePublish(post(body), admin(kind)),
  };
}

test("save needs a signed-in writer with an account", async () => {
  const h = harness();
  assert.equal((await h.save({ uid: null }, COMPLETE)).status, 401);
  const stranger = await h.save({ uid: "00000000-0000-4000-8000-0000000000ff" }, COMPLETE);
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.code, "no_account", "a confirmed writer is sent to /account to finish setting up");
  assert.equal(h.db.article_submissions.length, 0);
  assert.equal((await handleSave(new Request("https://functions.test"), { authed: client(h.db, WRITER), json, readJson })).status, 405);
});

test("save creates a draft, saves over it, and cleans what it is given", async () => {
  const h = harness();
  const first = await h.save(WRITER, { title: "  Half  a title ", lanes: ["AI"] });
  assert.equal(first.status, 200);
  assert.equal(first.body.submission.status, "draft");
  assert.equal(first.body.submission.title, "Half a title");
  assert.deepEqual(first.body.submission.lanes, ["ai"]);
  const id = first.body.submission.id;
  const again = await h.save(WRITER, { id, ...COMPLETE, title: "Loudness — a report" });
  assert.equal(again.status, 200);
  assert.equal(h.db.article_submissions.length, 1, "saving again does not make a second article");
  assert.equal(again.body.warnings[0].rule, "em-dash", "the house style notes come back with the save");
  assert.equal((await h.save(WRITER, { lanes: ["producer"] })).status, 400);
  assert.equal((await h.save(WRITER, { id: "not-a-uuid" })).status, 400);
  assert.equal((await h.save(OTHER, { id, title: "Taken over" })).status, 404, "another writer cannot see it, let alone save over it");
  assert.equal(h.db.article_submissions[0].title, "Loudness — a report");
});

test("submit refuses an unfinished article, then sends a finished one to review", async () => {
  const h = harness();
  const { body: { submission } } = await h.save(WRITER, { title: "Only a title" });
  const early = await h.submit(WRITER, { id: submission.id });
  assert.equal(early.status, 422);
  assert.ok(early.body.problems.length >= 3, "it says what is missing");
  assert.equal(h.db.article_submissions[0].status, "draft");

  await h.save(WRITER, { id: submission.id, ...COMPLETE });
  const sent = await h.submit(WRITER, { id: submission.id });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.submission.status, "pending");
  assert.ok(sent.body.submission.submitted_at);

  const twice = await h.submit(WRITER, { id: submission.id });
  assert.equal(twice.status, 409, "a pending article is with the reviewer");
  const edit = await h.save(WRITER, { id: submission.id, ...COMPLETE, title: "Changed while pending" });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, "locked");
  assert.equal(h.db.article_submissions[0].title, COMPLETE.title);
  assert.equal((await h.submit(OTHER, { id: submission.id })).status, 404);
  assert.equal((await h.submit(WRITER, {})).status, 400);
});

test("review needs the owner or the service role, and never publishes", async () => {
  const h = harness();
  const { body: { submission } } = await h.save(WRITER, COMPLETE);
  await h.submit(WRITER, { id: submission.id });
  const id = submission.id;

  assert.equal((await h.review({ id, decision: "approved" }, null)).status, 401);
  assert.equal((await h.review({ id, decision: "approved" }, "denied")).status, 403);
  const publishByReview = await h.review({ id, decision: "published" });
  assert.equal(publishByReview.status, 400, "published is not a review decision");
  assert.match(publishByReview.body.error, /Publishing is a separate step/);
  assert.equal((await h.review({ id, decision: "needs_changes" })).status, 400, "asking for changes needs notes");
  assert.equal((await h.review({ id, decision: "rejected", reviewer_notes: "x".repeat(4001) })).status, 400);

  const approved = await h.review({ id, decision: "approved" }, "owner");
  assert.equal(approved.status, 200);
  assert.equal(approved.body.submission.status, "approved");
  assert.equal(approved.body.published, false);
  assert.equal(h.db.article_publish_queue.length, 0, "approving writes no file");
  assert.equal(h.db.article_submissions[0].published_path, null);
  assert.equal(h.db.article_submissions[0].status, "approved", "and leaves it approved, not published");
});

test("changes requested go back to the writer, who edits and resubmits", async () => {
  const h = harness();
  const { body: { submission } } = await h.save(WRITER, COMPLETE);
  await h.submit(WRITER, { id: submission.id });
  const sentBack = await h.review({ id: submission.id, decision: "needs_changes", reviewer_notes: "Name the standard for true peak." });
  assert.equal(sentBack.body.submission.status, "needs_changes");
  assert.equal(sentBack.body.submission.reviewer_notes, "Name the standard for true peak.");

  const edited = await h.save(WRITER, { id: submission.id, ...COMPLETE, body_markdown: `${COMPLETE.body_markdown}\n\nTrue peak follows BS.1770 too.` });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.submission.status, "draft", "editing makes it a draft again");
  assert.equal(edited.body.submission.reviewer_notes, "Name the standard for true peak.", "the notes stay with it");
  assert.equal((await h.submit(WRITER, { id: submission.id })).body.submission.status, "pending");
  assert.equal((await h.review({ id: submission.id, decision: "approved" })).status, 200);
});

test("publish takes an approved article only, and writes the community file", async () => {
  const h = harness();
  const { body: { submission } } = await h.save(WRITER, COMPLETE);
  const id = submission.id;

  assert.equal((await h.publish({ id })).status, 409, "a draft cannot be published");
  await h.submit(WRITER, { id });
  const pending = await h.publish({ id });
  assert.equal(pending.status, 409, "a pending article cannot be published");
  assert.match(pending.body.error, /Only an approved article can be published/);
  assert.equal(h.db.article_publish_queue.length, 0);

  await h.review({ id, decision: "approved" });
  assert.equal((await h.publish({ id }, null)).status, 401);
  assert.equal((await h.publish({ id }, "denied")).status, 403);
  assert.equal((await h.publish({ id, slug: "Not A Slug" })).status, 400);
  assert.equal((await h.publish({ id, date: "yesterday" })).status, 400);

  const done = await h.publish({ id });
  assert.equal(done.status, 200);
  assert.equal(done.body.slug, "reading-a-master-s-loudness-as-a-report");
  assert.equal(done.body.path, "content/articles/community/reading-a-master-s-loudness-as-a-report.md");
  assert.match(done.body.markdown, /^---\ntitle: "Reading a master's loudness as a report"\ndate: 2026-10-27\nlanes: \[musician\]\n/);
  assert.match(done.body.markdown, /\nauthor_slug: jane-doe\nsource: user\ndraft: false\n---\n\n## What I measure first/);
  assert.equal(h.db.article_submissions[0].status, "published");
  assert.equal(h.db.article_submissions[0].published_path, done.body.path);
  assert.equal(h.db.article_publish_queue.length, 1);
  assert.equal(h.db.article_publish_queue[0].markdown, done.body.markdown);

  const again = await h.publish({ id });
  assert.equal(again.status, 409, "published once");
  assert.match(again.body.error, /already published/);
  assert.equal((await h.review({ id, decision: "rejected", reviewer_notes: "Too late." })).status, 409, "published is final");
});

test("publish needs the writer's profile address, and a free slug", async () => {
  const h = harness();
  const write = async (person, title) => {
    const { body: { submission } } = await h.save(person, { ...COMPLETE, title });
    await h.submit(person, { id: submission.id });
    await h.review({ id: submission.id, decision: "approved" });
    return submission.id;
  };
  const anonymous = await write(OTHER, "A post by someone with no profile");
  const refused = await h.publish({ id: anonymous });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "author_slug_missing");
  assert.equal(h.db.article_submissions.find((r) => r.id === anonymous).status, "approved", "it stays approved, ready for when they set one");

  const first = await write(WRITER, "Same title twice");
  const second = await write(WRITER, "Same title twice");
  assert.equal((await h.publish({ id: first })).status, 200);
  const clash = await h.publish({ id: second });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, "taken");
  assert.equal((await h.publish({ id: second, slug: "same-title-twice-again" })).status, 200, "a different slug goes through");
});

test("a reviewer is the service role key or the signed-in owner, and nobody else", async () => {
  const request = (token) => new Request("https://functions.test", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const equal = (a, b) => a === b;
  const signedIn = (owner) => () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }) },
    rpc: async (name) => ({ data: name === "owner_licence_status" ? owner : null, error: null }),
  });
  const nobody = () => ({ auth: { getUser: async () => ({ data: { user: null }, error: { message: "bad jwt" } }) } });
  const deps = (authedFor) => ({ serviceKey: "service-key", timingSafeEqual: equal, authedFor });

  assert.deepEqual(await reviewerFrom(request("service-key"), deps(nobody)), { kind: "service" });
  assert.deepEqual(await reviewerFrom(request("owner-jwt"), deps(signedIn(true))), { kind: "owner", userId: "u" });
  assert.deepEqual(await reviewerFrom(request("writer-jwt"), deps(signedIn(false))), { kind: "denied" });
  assert.equal(await reviewerFrom(request("garbage"), deps(nobody)), null);
  assert.equal(await reviewerFrom(request(null), deps(signedIn(true))), null, "no header, no reviewer");
  assert.deepEqual(await reviewerFrom(request("service-key"), { ...deps(signedIn(false)), serviceKey: "" }), { kind: "denied" },
    "with no key configured, a token is never taken for it");
});
