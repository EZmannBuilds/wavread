// Article submissions: the rules every caller shares.
//
// A writer drafts an article in the site's editor, submits it, a person
// reviews it (with the bot's notes to hand), and only an approved article can
// be published, as a Markdown file for the articles build. The Edge Functions,
// the review helper in tools/, and the tests all read the rules from here, so
// "what a submittable article is" has one definition. Plain JavaScript with no
// Deno globals, so node:test runs these exactly as the functions do.
//
// The site's editor imports the same file as docs/js/article-rules.js, a
// byte-for-byte copy (the site serves only docs/). tests/article-rules.test.mjs
// fails if the two differ: edit this one, then copy it over.
//
// The database enforces the same status moves itself (the
// article_submissions_guard trigger in
// 20261027090000_profiles_and_article_submissions.sql); tests/articles-db
// walks every pair of statuses and checks the two agree.
//
// The body rules mirror the Markdown subset the articles build understands
// (scripts/articles.mjs on feat/articles-cms-lite, PR #8): an article that
// passes here renders there without the build stopping. If that subset
// changes, change bodyProblems with it.

export const LANES = ["developer", "ai", "musician"];
export const STATUSES = ["draft", "pending", "needs_changes", "approved", "rejected", "published"];

// What the author may still change, and what a reviewer may decide.
export const AUTHOR_EDITABLE = new Set(["draft", "needs_changes"]);
export const REVIEW_DECISIONS = new Set(["needs_changes", "approved", "rejected"]);
// Review acts on a pending article, or reconsiders an approved one before it is
// published. Nothing a review decides is "published".
export const REVIEWABLE = new Set(["pending", "approved"]);

// Every move a submission can make. "author" moves are made by the signed-in
// writer through RLS; "reviewer" moves only by the service role (the review
// and publish functions). Published and rejected are final.
export const TRANSITIONS = {
  draft: { author: ["draft", "pending"], reviewer: [] },
  needs_changes: { author: ["draft", "pending"], reviewer: [] },
  pending: { author: [], reviewer: ["needs_changes", "approved", "rejected"] },
  approved: { author: [], reviewer: ["needs_changes", "rejected", "published"] },
  rejected: { author: [], reviewer: [] },
  published: { author: [], reviewer: [] },
};

// Whether `who` ("author" or "reviewer") may move a submission from one status
// to another. A reviewer is trusted with the author's moves too; the one thing
// nobody can do is reach "published" from anywhere but "approved".
export function canTransition(from, to, who) {
  const moves = TRANSITIONS[from];
  if (!moves || !STATUSES.includes(to)) return false;
  if (who === "author") return moves.author.includes(to);
  if (who === "reviewer") return moves.author.includes(to) || moves.reviewer.includes(to);
  return false;
}

export const LIMITS = {
  title: { min: 3, max: 140 },
  summary: { min: 20, max: 300 },
  body: { min: 200, max: 40000 },
  notes: { max: 4000 },
  open: 25,
  pending: 5,
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_LINK = /^(https:\/\/|http:\/\/|mailto:|\/|#)/;

export const isSubmissionId = (value) => typeof value === "string" && UUID.test(value);
export const isSlug = (value) => typeof value === "string" && SLUG.test(value) && value !== "index"
  && value.length >= 3 && value.length <= 80;

// One line of text: whitespace and line breaks collapse to single spaces.
const oneLine = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
const length = (text) => [...text].length;

// A draft as the editor sends it, cleaned and bounded. A draft may be
// unfinished, so only the limits a database column would refuse are problems
// here; whether it is ready to submit is submissionProblems' question.
export function normalizeDraft(input) {
  const problems = [];
  const body = input && typeof input === "object" ? input : {};
  const title = oneLine(body.title);
  const summary = oneLine(body.summary);
  const markdown = String(body.body_markdown ?? "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  const rawLanes = Array.isArray(body.lanes) ? body.lanes : [];
  const lanes = [];
  for (const lane of rawLanes) {
    const value = String(lane ?? "").trim().toLowerCase();
    if (!LANES.includes(value)) problems.push(`Unknown lane "${oneLine(lane).slice(0, 40)}". Choose from developer, ai and musician.`);
    else if (!lanes.includes(value)) lanes.push(value);
  }
  if (length(title) > LIMITS.title.max) problems.push(`The title is longer than ${LIMITS.title.max} characters.`);
  if (length(summary) > LIMITS.summary.max) problems.push(`The summary is longer than ${LIMITS.summary.max} characters.`);
  if (length(markdown) > LIMITS.body.max) problems.push(`The article is longer than ${LIMITS.body.max} characters.`);
  return { fields: { title, summary, lanes, body_markdown: markdown }, problems };
}

// The summary is the lede, the index blurb and the meta description, so the
// articles build takes exactly one sentence. The same test it applies.
export const isOneSentence = (text) => /[.!?]$/.test(text) && !/[.!?]\s+\S/.test(text);

// Why an article cannot be submitted yet, in sentences for the writer. Empty
// means it can go to review.
export function submissionProblems(fields) {
  const problems = [];
  const title = oneLine(fields?.title);
  const summary = oneLine(fields?.summary);
  const lanes = Array.isArray(fields?.lanes) ? fields.lanes : [];
  const body = String(fields?.body_markdown ?? "");
  if (length(title) < LIMITS.title.min) problems.push("Add a title.");
  else if (length(title) > LIMITS.title.max) problems.push(`Shorten the title to ${LIMITS.title.max} characters or fewer.`);
  if (length(summary) < LIMITS.summary.min) problems.push(`Add a one-sentence summary of at least ${LIMITS.summary.min} characters.`);
  else if (length(summary) > LIMITS.summary.max) problems.push(`Shorten the summary to ${LIMITS.summary.max} characters or fewer.`);
  else if (!isOneSentence(summary)) problems.push("Make the summary exactly one sentence, ending in a full stop, question mark or exclamation mark.");
  if (lanes.length === 0) problems.push("Choose at least one lane: developer, ai or musician.");
  if (lanes.some((lane) => !LANES.includes(lane))) problems.push("Lanes are developer, ai and musician.");
  if (length(body.trim()) < LIMITS.body.min) problems.push(`Write at least ${LIMITS.body.min} characters of article.`);
  else if (length(body) > LIMITS.body.max) problems.push(`Shorten the article to ${LIMITS.body.max} characters or fewer.`);
  problems.push(...bodyProblems(body));
  return problems;
}

// What the articles build would refuse in a body, line by line. Fenced code is
// taken as it is; everything else is checked the way the build reads it.
export function bodyProblems(markdown) {
  const problems = [];
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = `Line ${i + 1}`;
    if (/^```/.test(line)) {
      const start = i;
      while (++i < lines.length && !/^```\s*$/.test(lines[i]));
      if (i >= lines.length) problems.push(`Line ${start + 1}: the code block that opens here is never closed with \`\`\`.`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (heading[1].length === 1) problems.push(`${at}: start headings at ##. The title is the page's only top heading.`);
      else if (heading[1].length > 4) problems.push(`${at}: headings go no deeper than ####.`);
    }
    if (/^\s*\|/.test(line)) problems.push(`${at}: tables are not supported yet.`);
    problems.push(...inlineProblems(line, at));
  }
  return problems;
}

function inlineProblems(line, at) {
  const problems = [];
  const text = line.replace(/`[^`]+`/g, "");
  if (/!\[/.test(text)) problems.push(`${at}: images are not supported yet.`);
  for (const [, , url] of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    if (!SAFE_LINK.test(url)) problems.push(`${at}: the link "${url.slice(0, 60)}" must start with https://, mailto:, / or #.`);
  }
  return problems;
}

// The house voice, as the articles build's tests hold it: no em dashes, and
// absolute dates or version numbers rather than relative ones. These are
// warnings, never refusals: the writer is told before submitting, and the
// reviewer decides.
export const RELATIVE_DATE = /\b(yesterday|today|tonight|tomorrow|recently|(last|next|this) (week|month|year)|\w+ (days|weeks|months|years) ago)\b/i;

export function voiceWarnings(fields) {
  const warnings = [];
  const parts = [["Title", fields?.title], ["Summary", fields?.summary]];
  const body = String(fields?.body_markdown ?? "").split("\n");
  for (const [name, text] of parts) {
    const value = String(text ?? "");
    if (value.includes("—")) warnings.push({ rule: "em-dash", where: name, message: `${name}: replace the em dash with a comma, a colon or a full stop.` });
    const relative = value.match(RELATIVE_DATE);
    if (relative) warnings.push({ rule: "relative-date", where: name, message: `${name}: "${relative[0]}" will read wrong later. Write the date or the version instead.` });
  }
  let fenced = false;
  body.forEach((line, index) => {
    if (/^```/.test(line)) fenced = !fenced;
    if (fenced) return;
    const where = `Line ${index + 1}`;
    if (line.includes("—")) warnings.push({ rule: "em-dash", where, message: `${where}: replace the em dash with a comma, a colon or a full stop.` });
    const relative = line.match(RELATIVE_DATE);
    if (relative) warnings.push({ rule: "relative-date", where, message: `${where}: "${relative[0]}" will read wrong later. Write the date or the version instead.` });
  });
  return warnings;
}

// A URL slug from a title: lowercase ASCII words joined by hyphens, cut at a
// word boundary. The publish step checks it is free.
export function slugify(text, max = 60) {
  const words = String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > max) break;
    slug = next;
  }
  return slug || words[0]?.slice(0, max) || "";
}

export const isIsoDate = (value) => {
  const match = typeof value === "string" && value.match(DATE);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3];
};

export const isoDay = (now = new Date()) => now.toISOString().slice(0, 10);

export const communityPath = (slug) => `content/articles/community/${slug}.md`;

// The file the articles build reads. The frontmatter is the build's own five
// fields plus two that name where the post came from: author_slug (the
// writer's public profile) and source: user. The build on PR #8 refuses
// unknown fields, so the follow-on that teaches it to read community/ must add
// those two (content/articles/community/README.md says so).
export function buildMarkdown({ title, date, lanes, summary, authorSlug, body }) {
  if (!isIsoDate(date)) throw new Error("date must be YYYY-MM-DD");
  if (!isSlug(authorSlug)) throw new Error("author_slug must be a profile slug");
  const quoted = (text) => `"${oneLine(text)}"`;
  const lines = [
    "---",
    `title: ${quoted(title)}`,
    `date: ${date}`,
    `lanes: [${lanes.filter((lane) => LANES.includes(lane)).join(", ")}]`,
    `summary: ${quoted(summary)}`,
    `author_slug: ${authorSlug}`,
    "source: user",
    "draft: false",
    "---",
  ];
  return `${lines.join("\n")}\n\n${String(body ?? "").replace(/\r\n?/g, "\n").trim()}\n`;
}

// --------------------------------------------------------------- bot review

// Things an article about WavRead must not claim, because the product does not
// do them. A hit is a note for the reviewer, not a verdict.
export const CLAIM_CHECKS = [
  [/\b(fix(es)?|repair(s)?) your mix\b/i, "says WavRead fixes a mix; it reports measurements and leaves the judgment with the musician"],
  [/\b(grades?|scores?) (your|the) mix\b/i, "says WavRead grades a mix; it does not"],
  [/\bwhat(?:'s| is) wrong with (your|the) mix\b/i, "says WavRead finds what is wrong with a mix; it does not"],
  [/\bgenerates? (music|songs?|tracks?)\b/i, "says WavRead generates music; it does not"],
  [/\bcontrols? (your |the )?DAW\b/i, "says WavRead controls a DAW; it does not"],
  [/\b(DAW capture|captures? (directly )?from (your |the |a )?DAW)\b/i, "mentions DAW capture, which the app does not offer"],
  [/\b(stem separation|separates? (the )?stems)\b/i, "mentions stem separation, which was removed"],
  [/\b(hosted|cloud) API\b|\bAPI key\b/i, "mentions a hosted API or API key; WavRead has neither"],
  [/\bfree (trial|download|version)\b/i, "promises something free; pricing claims belong to the buy page"],
];

const SPAM_CHECKS = [
  /\b(casino|betting|crypto|forex|viagra|loan|escort)\b/i,
  /\b(buy now|click here|limited offer|act now|100% guaranteed)\b/i,
  /(.)\1{9,}/,
];

const links = (text) => [...String(text ?? "").matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map((m) => m[1]);

// A proposal for the person reviewing: approve, ask for changes, or reject,
// with notes they can send as they are or edit. It decides nothing. The owner
// still calls article-review, and nothing here or there publishes.
export function proposeReview(submission) {
  const fields = {
    title: submission?.title, summary: submission?.summary,
    lanes: submission?.lanes ?? [], body_markdown: submission?.body_markdown,
  };
  const problems = submissionProblems(fields);
  const voice = voiceWarnings(fields).map((w) => w.message);
  const text = [fields.title, fields.summary, fields.body_markdown].join("\n");
  const claims = CLAIM_CHECKS.filter(([pattern]) => pattern.test(text)).map(([, why]) => `The article ${why}.`);
  const spam = SPAM_CHECKS.filter((pattern) => pattern.test(text)).length;
  const urls = links(fields.body_markdown);
  const external = urls.filter((url) => /^https?:\/\//.test(url));
  const notes = [];
  if (external.length > 10) notes.push(`It has ${external.length} external links. Keep the ones a reader needs.`);
  const insecure = external.filter((url) => url.startsWith("http://"));
  if (insecure.length) notes.push(`Use https:// for ${insecure.length === 1 ? "this link" : "these links"}: ${insecure.slice(0, 3).join(", ")}.`);
  const capsTitle = String(fields.title ?? "").replace(/[^A-Za-z]/g, "");
  if (capsTitle.length >= 8 && capsTitle === capsTitle.toUpperCase()) notes.push("Write the title in sentence case rather than capitals.");

  const checks = { problems, voice, claims, spam, links: external.length };
  if (spam >= 2 || (spam >= 1 && external.length > 10)) {
    return { decision: "rejected", notes: "This reads as promotion rather than an article about using WavRead, so it will not be published.", checks };
  }
  const changes = [...problems, ...voice, ...claims, ...notes];
  if (changes.length) {
    return { decision: "needs_changes", notes: ["Thank you for writing this. Before it can be published:", ...changes.map((line) => `- ${line}`)].join("\n"), checks };
  }
  return { decision: "approved", notes: "No automated problems found. A person still reads the whole article before approving it.", checks };
}

// ------------------------------------------------------ for the functions

export const SUBMISSION_COLUMNS = "id, title, summary, lanes, body_markdown, status, reviewer_notes, "
  + "published_slug, published_path, created_at, updated_at, submitted_at, reviewed_at, published_at";

// What a writer is told about an article they can no longer change.
export function lockedMessage(status) {
  if (status === "pending") return "This article is waiting for review, so it cannot be changed until the reviewer replies.";
  if (status === "approved") return "This article is approved and waiting to be published, so it can no longer be changed.";
  if (status === "published") return "This article is published, so it can no longer be changed here.";
  if (status === "rejected") return "This article was not accepted, so it can no longer be changed.";
  return "This article cannot be changed right now.";
}

// A database refusal, as a response. The guard trigger and the caps raise
// sentences written for the writer; anything else stays in the function log.
export function databaseRefusal(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  if (code === "54000" || code === "55000") return { status: 409, body: { error: message, code: code === "54000" ? "limit" : "status" } };
  if (code === "23505") return { status: 409, body: { error: "That slug is already taken. Choose another.", code: "taken" } };
  if (code === "42501") return { status: 403, body: { error: "This account cannot do that.", code: "forbidden" } };
  if (code === "P0002") return { status: 404, body: { error: "No article has that id.", code: "not_found" } };
  return { status: 503, body: { error: "The article service is unavailable. Try again shortly.", code: "unavailable" } };
}
