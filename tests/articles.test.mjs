import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildArticles, loadArticles, planArticles } from "../scripts/articles.mjs";

const read = (path) => readFile(resolve(path), "utf8");
const SAMPLES = [
  ["local-analysis-agent-readable-readings", "developer", "Developer"],
  ["agents-and-editable-daw-tracks", "ai", "AI"],
  ["mix-measurements-as-a-report", "musician", "Musician"],
];

// A throwaway site: the two files the articles build reads from docs/, and
// whatever posts the test supplies.
async function scratchSite(posts) {
  const root = await mkdtemp(join(tmpdir(), "wavread-articles-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "content/articles"), { recursive: true });
  for (const file of ["faq.html", "sitemap.xml"]) await cp(resolve("docs", file), join(root, "docs", file));
  for (const [name, text] of Object.entries(posts)) await writeFile(join(root, "content/articles", name), text);
  return { root, contentDir: join(root, "content/articles"), docsDir: join(root, "docs") };
}

const post = ({ title = "A post", date = "2026-10-26", lanes = "[musician]",
  summary = "One sentence about the post.", draft, body = "## Section\n\nSome text." } = {}) =>
  `---\ntitle: ${title}\ndate: ${date}\nlanes: ${lanes}\nsummary: ${summary}\n${draft === undefined ? "" : `draft: ${draft}\n`}---\n\n${body}\n`;

test("the committed article pages and sitemap are exactly what the build writes", async () => {
  const { files } = await planArticles({ contentDir: resolve("content/articles"), docsDir: resolve("docs") });
  for (const [path, html] of files) {
    assert.equal(await read(join("docs", path)), html, `docs/${path} is stale: run npm run build and commit the result`);
  }
  const onDisk = (await readdir("docs/articles")).filter((name) => name.endsWith(".html")).map((name) => `articles/${name}`).sort();
  const planned = [...files.keys()].filter((path) => path.startsWith("articles/")).sort();
  assert.deepEqual(onDisk, planned, "docs/articles holds a page no post produces, or misses one");
});

test("the three sample posts build into pages with the site's chrome and a /buy call to action", async () => {
  const site = await scratchSite({});
  await cp(resolve("content/articles"), site.contentDir, { recursive: true });
  const { posts } = await buildArticles(site);
  assert.deepEqual(posts.map((p) => p.slug).sort(), SAMPLES.map(([slug]) => slug).sort());

  const index = await readFile(join(site.docsDir, "articles/index.html"), "utf8");
  const sitemap = await readFile(join(site.docsDir, "sitemap.xml"), "utf8");
  assert.match(index, /<h1>Articles<\/h1>/);
  assert.match(index, /<link rel="canonical" href="https:\/\/wavread\.com\/articles">/);
  assert.match(index, /<a class="btn primary" href="\/buy\.html">/, "the index links to /buy");
  for (const label of ["Developer", "AI", "Musician"]) assert.ok(index.includes(`<li>${label}</li>`), `the index shows the ${label} lane`);
  assert.ok(sitemap.includes("<loc>https://wavread.com/articles</loc>"), "the index is sitemapped");

  for (const [slug, lane, label] of SAMPLES) {
    const article = posts.find((p) => p.slug === slug);
    assert.deepEqual(article.lanes, [lane], `${slug} is the ${lane} sample`);
    const html = await readFile(join(site.docsDir, `articles/${slug}.html`), "utf8");
    assert.ok(index.includes(`href="/articles/${slug}.html"`), `the index links ${slug}`);
    assert.ok(sitemap.includes(`<loc>https://wavread.com/articles/${slug}</loc>`), `${slug} is sitemapped`);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${slug} has one h1`);
    assert.ok(html.includes(`<h1>${article.title}</h1>`.replace(/&/g, "&amp;")), `${slug} is titled from its frontmatter`);
    assert.ok(html.includes(`<link rel="canonical" href="https://wavread.com/articles/${slug}">`));
    assert.match(html, /<time datetime="2026-10-26">October 26, 2026<\/time> · By EZmannBuilds/, "absolute date and the brand as author");
    assert.ok(html.includes(`<li>${label}</li>`), `${slug} shows its lane`);
    assert.match(html, /<a class="btn primary" href="\/buy\.html">/, `${slug} links to /buy`);
    assert.match(html, /<details class="site-menu">[\s\S]*href="\/articles\/index\.html">Articles<\/a>[\s\S]*<\/details>/, "the shared menu, Articles included");
    assert.match(html, /aria-label="Footer"/);
    assert.match(html, /"@type": "BlogPosting"/);
    assert.doesNotMatch(html, /\/try\b|trial/i, "no trial funnel in this scaffold");
    assert.doesNotMatch(html, /—/, `${slug} has no em dash`);
    assert.doesNotMatch(html, /@gmail\.com/, "no personal address");
  }
  // Same date, so the order falls back to the slug, and stays stable.
  const listed = index.match(/<ol class="article-list">[\s\S]*?<\/ol>/)[0];
  assert.deepEqual([...listed.matchAll(/href="\/articles\/([a-z0-9-]+)\.html"/g)].map((m) => m[1]),
    SAMPLES.map(([slug]) => slug).sort());
});

test("drafts get no page, no index entry and no sitemap line; posts are newest first", async () => {
  const site = await scratchSite({
    "older-post.md": post({ title: "Older post", date: "2026-10-01" }),
    "newer-post.md": post({ title: "Newer post", date: "2026-10-20", lanes: "\n  - developer\n  - ai", draft: false }),
    "secret-plan.md": post({ title: "Secret plan", date: "2026-10-25", draft: true }),
  });
  const { posts, drafts } = await buildArticles(site);
  assert.deepEqual(posts.map((p) => p.slug), ["newer-post", "older-post"], "newest first");
  assert.deepEqual(posts[0].lanes, ["developer", "ai"], "a block list of lanes works too");
  assert.deepEqual(drafts.map((p) => p.slug), ["secret-plan"]);
  assert.ok(!existsSync(join(site.docsDir, "articles/secret-plan.html")), "a draft produces no page at all");
  const index = await readFile(join(site.docsDir, "articles/index.html"), "utf8");
  const sitemap = await readFile(join(site.docsDir, "sitemap.xml"), "utf8");
  for (const text of [index, sitemap]) {
    assert.doesNotMatch(text, /secret-plan|Secret plan/, "the draft is not listed");
  }
  assert.ok(index.indexOf("Newer post") < index.indexOf("Older post"));

  // Turning a published post into a draft removes the page it had.
  await writeFile(join(site.contentDir, "older-post.md"), post({ title: "Older post", date: "2026-10-01", draft: true }));
  await buildArticles(site);
  assert.ok(!existsSync(join(site.docsDir, "articles/older-post.html")), "the old page is gone");
  assert.doesNotMatch(await readFile(join(site.docsDir, "sitemap.xml"), "utf8"), /older-post/);
});

test("broken frontmatter and unsupported Markdown fail with the file and the reason", async () => {
  const cases = [
    ["no-frontmatter.md", "Just a body.\n", /no-frontmatter\.md: must start with frontmatter/],
    ["unclosed.md", "---\ntitle: x\n", /unclosed\.md: must start with frontmatter/],
    ["no-title.md", post().replace(/^title: .*\n/m, ""), /no-title\.md: frontmatter: missing required field "title"/],
    ["relative-date.md", post({ date: "last week" }), /"date" must be an absolute date written YYYY-MM-DD, got "last week"/],
    ["impossible-date.md", post({ date: "2026-02-30" }), /"date" must be an absolute date/],
    ["unknown-lane.md", post({ lanes: "[producer]" }), /unknown lane "producer"/],
    ["no-lanes.md", post({ lanes: "[]" }), /"lanes" must be a list of one or more/],
    ["lane-string.md", post({ lanes: "musician" }), /"lanes" must be a list/],
    ["unknown-field.md", post().replace("---\n\n", "author: Someone\n---\n\n"), /unknown field "author"/],
    ["twice.md", post().replace("---\n\n", "title: Again\n---\n\n"), /"title" is set twice/],
    ["draft-yes.md", post({ draft: "yes" }), /"draft" must be true or false, got "yes"/],
    ["two-sentences.md", post({ summary: "First sentence. Second sentence." }), /"summary" must be exactly one sentence/],
    ["no-stop.md", post({ summary: "No full stop" }), /"summary" must be exactly one sentence/],
    ["garbled.md", post().replace("---\n\n", "this is not a field\n---\n\n"), /expected "key: value"/],
    ["Bad_Name.md", post(), /Bad_Name\.md: the file name is the URL/],
    ["index.md", post(), /index\.md: the file name is the URL/],
    ["empty-body.md", post({ body: "" }), /has no body/],
    ["h1.md", post({ body: "# Another title" }), /the title is the page's only h1/],
    ["script-link.md", post({ body: "[x](javascript:alert(1))" }), /link "javascript:alert\(1" must start with/],
    ["relative-link.md", post({ body: "[x](agent.html)" }), /link "agent\.html" must start with/],
    ["fence.md", post({ body: "```\ncode" }), /never closed/],
    ["table.md", post({ body: "| a | b |" }), /tables are not supported/],
    ["image.md", post({ body: "![alt](/img/og-card.png)" }), /images are not supported/],
  ];
  for (const [name, text, message] of cases) {
    const site = await scratchSite({ [name]: text });
    await assert.rejects(loadArticles(site.contentDir), message, `${name} should be refused`);
  }

  // Every problem in every file is reported at once, not one per run.
  const site = await scratchSite({
    "a.md": post({ date: "yesterday" }),
    "b.md": post({ lanes: "[drums]" }),
    "fine.md": post(),
  });
  await assert.rejects(loadArticles(site.contentDir), (error) =>
    /2 problems/.test(error.message) && /a\.md/.test(error.message) && /b\.md/.test(error.message));
});

test("npm run build exits non-zero on a broken post, before it touches dist-site", async () => {
  const site = await scratchSite({ "broken.md": post({ lanes: "[everyone]" }) });
  await cp(resolve("scripts"), join(site.root, "scripts"), { recursive: true });
  const run = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: site.root, encoding: "utf8" });
  assert.equal(run.status, 1, "the build fails");
  assert.match(run.stderr, /Build failed: 1 problem in content\/articles:\n\s+content\/articles\/broken\.md: frontmatter: unknown lane "everyone"/);
  assert.ok(!existsSync(join(site.root, "dist-site")), "nothing was published");
  assert.ok(!existsSync(join(site.docsDir, "articles")), "and no article pages were written");
});

test("a hand-made page in docs/articles is refused, not silently deleted", async () => {
  const site = await scratchSite({ "fine.md": post() });
  await mkdir(join(site.docsDir, "articles"));
  await writeFile(join(site.docsDir, "articles/handmade.html"), "<!doctype html><title>Mine</title>");
  await assert.rejects(buildArticles(site), /docs\/articles\/handmade\.html was not written by the build/);
  assert.ok(existsSync(join(site.docsDir, "articles/handmade.html")));
});

test("post bodies render the documented Markdown and nothing else runs", async () => {
  const site = await scratchSite({
    "markdown.md": post({ body: [
      "## A heading", "", "Text with **bold**, *italic*, `code <b>` and a [link](/agent.html).", "",
      "- one", "- two", "", "1. first", "2. second", "", "> quoted", "", "```", "<script>alert(1)</script>", "```", "",
      "<script>alert(2)</script>", "", "## A heading",
    ].join("\n") }),
  });
  const [article] = await loadArticles(site.contentDir);
  assert.match(article.html, /<h2 id="a-heading">A heading<\/h2>/);
  assert.match(article.html, /<h2 id="a-heading-2">A heading<\/h2>/, "repeated headings get distinct anchors");
  assert.match(article.html, /<strong>bold<\/strong>, <em>italic<\/em>, <code>code &lt;b&gt;<\/code> and a <a href="\/agent\.html">link<\/a>/);
  assert.match(article.html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(article.html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(article.html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(article.html, /<pre><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
  assert.doesNotMatch(article.html, /<script/, "raw HTML is text, never markup");
});

test("posts keep the house voice: absolute dates and no em dashes", async () => {
  const names = (await readdir("content/articles")).filter((name) => name.endsWith(".md") && name !== "ARTICLES.md");
  assert.ok(names.length >= 3);
  for (const name of names) {
    const text = await read(join("content/articles", name));
    assert.doesNotMatch(text, /—/, `${name} uses an em dash`);
    assert.doesNotMatch(text,
      /\b(yesterday|today|tonight|tomorrow|recently|(last|next|this) (week|month|year)|\w+ (days|weeks|months|years) ago)\b/i,
      `${name} uses a relative date; write the date or the version instead`);
  }
});
