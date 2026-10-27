// The article rules every caller shares (supabase/functions/_shared/submissions.mjs):
// the status machine, what a submittable article is, the Markdown the articles
// build accepts, the house style notes, the file a published article becomes,
// and the review helper's proposals.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LANES,
  REVIEW_DECISIONS,
  STATUSES,
  TRANSITIONS,
  bodyProblems,
  buildMarkdown,
  canTransition,
  communityPath,
  isOneSentence,
  isSlug,
  normalizeDraft,
  proposeReview,
  slugify,
  submissionProblems,
  voiceWarnings,
} from "../supabase/functions/_shared/submissions.mjs";
import { COMPLETE } from "./fixtures/article.mjs";

const read = (path) => readFile(path, "utf8");


test("the editor is served the same rules the functions run", async () => {
  assert.equal(await read("docs/js/article-rules.js"), await read("supabase/functions/_shared/submissions.mjs"),
    "copy supabase/functions/_shared/submissions.mjs to docs/js/article-rules.js");
});

test("approval never publishes, and nothing reaches published but an approved article", () => {
  for (const from of STATUSES) {
    for (const who of ["author", "reviewer"]) {
      if (from !== "approved") assert.equal(canTransition(from, "published", who), false, `${who}: ${from} -> published`);
    }
  }
  assert.equal(canTransition("approved", "published", "reviewer"), true);
  assert.equal(canTransition("approved", "published", "author"), false, "a writer cannot publish");
  assert.ok(!REVIEW_DECISIONS.has("published"), "published is not a review decision");
  assert.deepEqual([...REVIEW_DECISIONS].sort(), ["approved", "needs_changes", "rejected"]);
});

test("writers draft and submit; only reviewers decide; rejected and published are final", () => {
  assert.equal(canTransition("draft", "pending", "author"), true);
  assert.equal(canTransition("needs_changes", "draft", "author"), true);
  assert.equal(canTransition("needs_changes", "pending", "author"), true);
  for (const decision of REVIEW_DECISIONS) {
    assert.equal(canTransition("pending", decision, "author"), false, `a writer cannot mark their own article ${decision}`);
    assert.equal(canTransition("pending", decision, "reviewer"), true);
    assert.equal(canTransition("draft", decision, "reviewer"), false, `a draft is not reviewed before it is submitted (${decision})`);
  }
  assert.equal(canTransition("pending", "draft", "author"), false, "a submitted article is not pulled back silently");
  for (const final of ["rejected", "published"]) {
    for (const to of STATUSES) {
      assert.equal(canTransition(final, to, "reviewer"), false, `${final} -> ${to}`);
      assert.equal(canTransition(final, to, "author"), false, `${final} -> ${to}`);
    }
  }
  assert.equal(canTransition("draft", "nonsense", "reviewer"), false);
  assert.equal(canTransition("draft", "pending", "stranger"), false);
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...STATUSES].sort());
});

test("drafts are cleaned and bounded, but may be unfinished", () => {
  const { fields, problems } = normalizeDraft({
    title: "  A   title\nwith a break ",
    summary: "\tOne line.\r\n",
    lanes: ["AI", "musician", "ai"],
    body_markdown: "## Heading\r\nText\u0000",
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(fields, { title: "A title with a break", summary: "One line.", lanes: ["ai", "musician"], body_markdown: "## Heading\nText" });
  assert.deepEqual(normalizeDraft({}).fields, { title: "", summary: "", lanes: [], body_markdown: "" }, "an empty draft is a draft");
  assert.match(normalizeDraft({ lanes: ["producer"] }).problems[0], /Unknown lane "producer"/);
  assert.match(normalizeDraft({ title: "x".repeat(141) }).problems[0], /longer than 140/);
  assert.match(normalizeDraft({ body_markdown: "x".repeat(40001) }).problems[0], /longer than 40000/);
  assert.deepEqual(normalizeDraft(null).problems, []);
});

test("a complete article can be submitted; an incomplete one says what is missing", () => {
  assert.deepEqual(submissionProblems(COMPLETE), []);
  const empty = submissionProblems({ title: "", summary: "", lanes: [], body_markdown: "" });
  assert.equal(empty.length, 4);
  assert.match(submissionProblems({ ...COMPLETE, summary: "Two sentences here, and long enough. Here is the second." }).join(), /exactly one sentence/);
  assert.match(submissionProblems({ ...COMPLETE, summary: "No closing punctuation but long enough" }).join(), /exactly one sentence/);
  assert.match(submissionProblems({ ...COMPLETE, lanes: [] }).join(), /at least one lane/);
  assert.match(submissionProblems({ ...COMPLETE, body_markdown: "Too short." }).join(), /at least 200 characters/);
  assert.equal(isOneSentence("WavRead reports what it measured in 1.5.6, with timestamps."), true, "a version number is not a sentence break");
});

test("the body takes exactly the Markdown the articles build renders", () => {
  const cases = [
    ["# Title in the body", /start headings at ##/],
    ["##### Too deep", /no deeper than ####/],
    ["| a | b |", /tables are not supported/],
    ["![chart](https://example.com/c.png)", /images are not supported/],
    ["[x](agent.html)", /must start with https:\/\/, mailto:, \/ or #/],
    ["[x](javascript:alert(1))", /must start with/],
    ["```\nnever closed", /never closed/],
  ];
  for (const [body, pattern] of cases) {
    const problems = bodyProblems(body);
    assert.equal(problems.length, 1, `${JSON.stringify(body)}: ${problems.join(" | ")}`);
    assert.match(problems[0], pattern);
  }
  assert.deepEqual(bodyProblems([
    "## Fine", "### Fine", "#### Fine", "", "- list", "1. list", "> quote", "---",
    "**bold** *italic* `code` [site](/faq.html) [web](https://wavread.com) [mail](mailto:support@wavread.com) [here](#fine)",
    "```", "# not a heading inside code", "| nor a table |", "![nor an image](x)", "```",
    "<script>alert(1)</script> is shown as text by the build, not refused",
    "`![held in code](x)` is code, not an image",
  ].join("\n")), []);
  assert.match(bodyProblems("line one\n# Late title")[0], /^Line 2:/, "problems name their line");
});

test("house style notes cover em dashes and relative dates, and skip code", () => {
  const warnings = voiceWarnings({
    title: "Loudness — explained",
    summary: "What I learned last week about loudness, measured.",
    body_markdown: "Fine line.\nI changed this yesterday.\n```\ntoday inside code\n```\nTwo days ago — again.",
  });
  assert.deepEqual(warnings.map((w) => `${w.rule}@${w.where}`), [
    "em-dash@Title", "relative-date@Summary", "relative-date@Line 2", "em-dash@Line 6", "relative-date@Line 6",
  ]);
  assert.deepEqual(voiceWarnings(COMPLETE), [], "a version and an absolute date are fine");
  assert.ok(warnings.every((w) => typeof w.message === "string" && w.message.length > 10));
});

test("a published article becomes a file the articles build reads", () => {
  const markdown = buildMarkdown({
    title: 'Reading "loudness": a report',
    date: "2026-10-27",
    lanes: ["musician", "ai"],
    summary: COMPLETE.summary,
    authorSlug: "jane-doe",
    body: `\n\n${COMPLETE.body_markdown}\n\n`,
  });
  const lines = markdown.split("\n");
  const close = lines.indexOf("---", 1);
  assert.equal(lines[0], "---");
  assert.deepEqual(lines.slice(1, close), [
    'title: "Reading "loudness": a report"',
    "date: 2026-10-27",
    "lanes: [musician, ai]",
    `summary: "${COMPLETE.summary}"`,
    "author_slug: jane-doe",
    "source: user",
    "draft: false",
  ]);
  // The build's fields (title, date, lanes, summary, draft), plus the two that
  // say where a community post came from. Keys only: the build refuses others.
  const keys = lines.slice(1, close).map((line) => line.split(":")[0]);
  assert.deepEqual(keys, ["title", "date", "lanes", "summary", "author_slug", "source", "draft"]);
  assert.equal(lines[close + 1], "", "a blank line after the frontmatter");
  assert.equal(lines.slice(close + 2).join("\n"), `${COMPLETE.body_markdown}\n`);
  assert.throws(() => buildMarkdown({ title: "x", date: "today", lanes: [], summary: "x.", authorSlug: "a-b", body: "" }), /YYYY-MM-DD/);
  assert.throws(() => buildMarkdown({ title: "x", date: "2026-02-30", lanes: [], summary: "x.", authorSlug: "a-b", body: "" }), /YYYY-MM-DD/);
  assert.throws(() => buildMarkdown({ title: "x", date: "2026-10-27", lanes: [], summary: "x.", authorSlug: "Not A Slug", body: "" }), /author_slug/);
  assert.equal(communityPath("a-post"), "content/articles/community/a-post.md");
});

test("slugs are URL-safe words, cut at a word boundary", () => {
  assert.equal(slugify("Loudness, balance & stereo: your mix as a report"), "loudness-balance-stereo-your-mix-as-a-report");
  assert.equal(slugify("Café über Ableton Live 12"), "cafe-uber-ableton-live-12");
  assert.ok(slugify("word ".repeat(40)).length <= 60);
  assert.ok(!slugify("word ".repeat(40)).endsWith("-"));
  assert.equal(slugify("!!!"), "");
  assert.equal(isSlug("index"), false);
  assert.equal(isSlug("ok"), false, "too short");
  assert.equal(isSlug("a-good-slug"), true);
  assert.equal(isSlug("Bad--slug"), false);
});

test("the review helper proposes, with notes, and never proposes publishing", () => {
  const clean = proposeReview(COMPLETE);
  assert.equal(clean.decision, "approved");
  assert.match(clean.notes, /A person still reads the whole article/);

  const unfinished = proposeReview({ ...COMPLETE, summary: "" });
  assert.equal(unfinished.decision, "needs_changes");
  assert.match(unfinished.notes, /one-sentence summary/);

  const claims = proposeReview({ ...COMPLETE, body_markdown: `${COMPLETE.body_markdown}\n\nWavRead fixes your mix and generates music for you.` });
  assert.equal(claims.decision, "needs_changes");
  assert.match(claims.notes, /fixes a mix/);
  assert.match(claims.notes, /generates music/);

  const voice = proposeReview({ ...COMPLETE, title: "Loudness — a report" });
  assert.equal(voice.decision, "needs_changes");
  assert.match(voice.notes, /em dash/);

  const spam = proposeReview({ ...COMPLETE, body_markdown: `${COMPLETE.body_markdown}\n\nBuy now at the best casino in town, click here.` });
  assert.equal(spam.decision, "rejected");

  for (const proposal of [clean, unfinished, claims, voice, spam]) {
    assert.ok(REVIEW_DECISIONS.has(proposal.decision), "a proposal is always a review decision");
    assert.notEqual(proposal.decision, "published");
  }
  assert.ok(LANES.includes("developer") && LANES.includes("ai") && LANES.includes("musician"));
});
