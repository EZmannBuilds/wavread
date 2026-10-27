// The editor's live preview (docs/js/markdown-preview.js): it reads the
// articles build's Markdown subset, flags what the build would refuse in the
// same places the submit rules do, and draws nothing but DOM nodes, so no
// markup a writer types can run.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseBlocks, parseInline, renderPreview } from "../docs/js/markdown-preview.js";
import { bodyProblems } from "../supabase/functions/_shared/submissions.mjs";

// Just enough of a document for renderPreview, and a way to read back what it
// drew.
class Node {
  constructor(tag) {
    Object.assign(this, { tag, children: [], attributes: {}, className: "" });
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tag === "#fragment") this.children.push(...node.children);
      else this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  set textContent(text) { this.children = [{ tag: "#text", text: String(text) }]; }
  get textContent() { return this.children.map((child) => (child.tag === "#text" ? child.text : child.textContent)).join(""); }
}
const doc = {
  createElement: (tag) => new Node(tag),
  createTextNode: (text) => ({ tag: "#text", text, get textContent() { return text; } }),
  createDocumentFragment: () => new Node("#fragment"),
};
const tags = (node) => (node.tag === "#text" ? [] : [node.tag, ...node.children.flatMap(tags)]);
const draw = (source) => {
  const container = new Node("div");
  const result = renderPreview(container, source, doc);
  return { container, ...result };
};

test("the build's blocks: headings from ##, lists, quotes, code, rules and paragraphs", () => {
  const blocks = parseBlocks([
    "## Section", "### Sub", "#### Detail", "", "A paragraph", "over two lines.", "",
    "- one", "- two", "  continued", "", "1. first", "2. second", "", "> quoted", "> still", "",
    "```", "<b>code</b>", "```", "---",
  ].join("\n"));
  assert.deepEqual(blocks.map((b) => Object.keys(b).find((k) => k !== "raw" && k !== "inline" && k !== "ordered")), [
    "heading", "heading", "heading", "paragraph", "list", "list", "quote", "code", "rule",
  ]);
  assert.deepEqual(blocks.slice(0, 3).map((b) => b.heading), [2, 3, 4]);
  assert.equal(blocks[3].raw, "A paragraph over two lines.");
  assert.equal(blocks[4].list.length, 2);
  assert.equal(blocks[4].raw, "one two continued", "an indented line continues its item");
  assert.equal(blocks[5].ordered, true);
  assert.equal(blocks[7].code, "<b>code</b>");
});

test("inline: code first, then links, then bold and italic", () => {
  assert.deepEqual(parseInline("**bold *and italic***"), [{ strong: [{ text: "bold " }, { em: [{ text: "and italic" }] }] }]);
  assert.deepEqual(parseInline("`**not bold**`"), [{ code: "**not bold**" }]);
  assert.deepEqual(parseInline("[the *FAQ*](/faq.html)"), [{ link: "/faq.html", children: [{ text: "the " }, { em: [{ text: "FAQ" }] }] }]);
  assert.deepEqual(parseInline("[x](javascript:alert)"), [{ unsafe: "javascript:alert", children: [{ text: "x" }] }]);
  assert.deepEqual(parseInline("**a *b** c*").length > 0, true, "crossed markers do not throw");
  assert.deepEqual(parseInline("typed \u0000 and \u0001S markers"), [{ text: "typed  and S markers" }], "the parser's own markers cannot be typed");
});

test("nothing typed is ever drawn as markup", () => {
  const { container } = draw([
    "<script>alert(1)</script>",
    "",
    '<img src=x onerror="alert(1)"> and <a href="javascript:alert(1)">a link</a>',
    "",
    "[click](javascript:alert(1)) [data](data:text/html,hi)",
    "",
    "## <em>heading</em>",
  ].join("\n"));
  const drawn = tags(container);
  assert.deepEqual([...new Set(drawn)].sort(), ["div", "h2", "p", "span"], `only these elements: ${drawn}`);
  assert.match(container.textContent, /<script>alert\(1\)<\/script>/, "raw HTML shows as the characters typed");
  assert.match(container.textContent, /link not allowed: javascript:alert\(1/);
});

test("links that are drawn open apart from the draft and carry no referrer", () => {
  const { container } = draw("[WavRead](https://wavread.com) and [mail](mailto:support@wavread.com)");
  const links = container.children[0].children.filter((node) => node.tag === "a");
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.equal(link.attributes.target, "_blank");
    assert.equal(link.attributes.rel, "noopener noreferrer nofollow");
  }
  assert.equal(links[0].attributes.href, "https://wavread.com");
});

test("the preview flags what the build refuses, as the submit rules do", () => {
  for (const source of [
    "# Title in the body",
    "##### Too deep",
    "| a | b |",
    "```\nnever closed",
    "## Fine\n\nAll good here.",
  ]) {
    const { problems } = draw(source);
    assert.equal(problems.length, bodyProblems(source).length, JSON.stringify(source));
  }
  const { container, problems } = draw("# Title\n\nText");
  assert.equal(problems.length, 1);
  assert.equal(container.children[0].className, "preview-problem", "the note is drawn where the problem is");
  assert.equal(draw("> # quoted top heading").problems.length, 1, "inside a quote too");
});

test("the preview is self-hosted and builds nodes, never HTML strings", async () => {
  const files = ["markdown-preview.js", "article-editor.js", "account.js", "account-client.js", "auth-pages.js", "public-profile.js"];
  for (const file of files) {
    const source = await readFile(`docs/js/${file}`, "utf8");
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|\beval\(|new Function/, `${file} parses no HTML`);
    for (const [, from] of source.matchAll(/^import [^;]+ from "([^"]+)";/gm)) {
      assert.match(from, /^\.\/[a-z-]+\.js$/, `${file} imports only files next to it, served from this origin: ${from}`);
    }
  }
  const vercel = await readFile("vercel.json", "utf8");
  assert.match(vercel, /script-src 'self' https:\/\/cdn\.jsdelivr\.net;/, "the CSP is unchanged");
});
