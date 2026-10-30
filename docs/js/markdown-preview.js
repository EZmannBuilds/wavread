// The editor's live preview: the Markdown the articles build understands,
// drawn as DOM nodes.
//
// It reads the same subset scripts/articles.mjs renders on PR #8: ## to ####
// headings, paragraphs, - * and 1. lists, > quotes, fenced code, --- rules,
// **bold**, *italic*, `code` and [links](https://...). What the build would
// refuse (a # heading, a table, an image, a link that is not https://,
// mailto:, / or #, an unclosed code block) is drawn as a visible note in its
// place, so the writer sees it where it is.
//
// Nothing is ever parsed as HTML. Every node is made with createElement and
// every piece of text is a text node, so raw HTML in a draft shows as the
// characters typed and no script in it can run. Self-hosted, because the site's
// CSP allows scripts from this origin only (and the one Supabase CDN).

const SAFE_LINK = /^(https:\/\/|http:\/\/|mailto:|\/|#)/;

// ------------------------------------------------------------------ inline

// Inline text to a list of nodes: { text } | { code } | { strong: [...] } |
// { em: [...] } | { link, children: [...] } | { unsafe, children: [...] }.
// The order is the build's: code spans are set aside first, then links, then
// bold, then italic.
export function parseInline(source) {
  const held = [];
  const hold = (node) => `\u0000${held.push(node) - 1}\u0000`;
  // The two marker characters are this parser's own; typed ones are dropped.
  let text = String(source).replace(/[\u0000\u0001]/g, "").replace(/`([^`]+)`/g, (_, code) => hold({ code }));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    hold(SAFE_LINK.test(url) ? { link: url, label } : { unsafe: url, label }));
  text = text
    .replace(/\*\*(?=\S)(.+?)\*\*/g, "\u0001S$1\u0001s")
    .replace(/\*(?=\S)(.+?)\*/g, "\u0001E$1\u0001e");
  return markers(text, held);
}

function markers(text, held) {
  const root = [];
  const stack = [{ kind: "root", children: root }];
  const top = () => stack[stack.length - 1].children;
  let buffer = "";
  const flush = () => {
    if (buffer) top().push({ text: buffer });
    buffer = "";
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\u0000") {
      const end = text.indexOf("\u0000", i + 1);
      const node = end === -1 ? null : held[Number(text.slice(i + 1, end))];
      if (!node) continue;
      flush();
      if (node.code !== undefined) top().push({ code: node.code });
      else if (node.link !== undefined) top().push({ link: node.link, children: parseInline(node.label) });
      else top().push({ unsafe: node.unsafe, children: parseInline(node.label) });
      i = end;
      continue;
    }
    if (char === "\u0001") {
      const mark = text[i + 1];
      i += 1;
      flush();
      if (mark === "S" || mark === "E") {
        const node = { [mark === "S" ? "strong" : "em"]: [] };
        top().push(node);
        stack.push({ kind: mark, children: node[mark === "S" ? "strong" : "em"] });
      } else {
        const opener = mark === "s" ? "S" : "E";
        // A close that does not match the innermost open is dropped: the
        // markers crossed (**a *b** c*), and the build's output is no better.
        if (stack.length > 1 && stack[stack.length - 1].kind === opener) stack.pop();
      }
      continue;
    }
    buffer += char;
  }
  flush();
  return root;
}

// ------------------------------------------------------------------ blocks

// Markdown to blocks: { heading, level, inline } | { paragraph } | { list,
// ordered, items } | { quote: blocks } | { code } | { rule } | { problem }.
export function parseBlocks(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ paragraph: parseInline(paragraph.join(" ")), raw: paragraph.join(" ") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    if (/^```/.test(line)) {
      flush();
      const start = i;
      const code = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i]);
      blocks.push({ code: code.join("\n") });
      if (i >= lines.length) blocks.push({ problem: `The code block that opens on line ${start + 1} is never closed with \`\`\`.` });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      if (level === 1) blocks.push({ problem: `Line ${i + 1}: start headings at ##. The title is the page's only top heading.` });
      if (level > 4) blocks.push({ problem: `Line ${i + 1}: headings go no deeper than ####.` });
      blocks.push({ heading: Math.min(Math.max(level, 2), 4), inline: parseInline(heading[2]), raw: heading[2] });
      continue;
    }
    if (/^(?:-{3,}|\*{3,})\s*$/.test(line)) { flush(); blocks.push({ rule: true }); continue; }
    if (/^\s*\|/.test(line)) {
      flush();
      blocks.push({ problem: `Line ${i + 1}: tables are not supported yet.` });
      blocks.push({ paragraph: [{ text: line }], raw: line });
      continue;
    }
    if (/^>/.test(line)) {
      flush();
      const quoted = [];
      for (; i < lines.length && /^>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^>\s?/, ""));
      i--;
      blocks.push({ quote: parseBlocks(quoted.join("\n")) });
      continue;
    }
    const bullet = /^[-*]\s+/;
    const number = /^\d+\.\s+/;
    if (bullet.test(line) || number.test(line)) {
      flush();
      const marker = bullet.test(line) ? bullet : number;
      const items = [];
      for (; i < lines.length; i++) {
        if (marker.test(lines[i])) items.push(lines[i].replace(marker, ""));
        else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
      }
      i--;
      blocks.push({ list: items.map((item) => parseInline(item)), ordered: marker === number, raw: items.join(" ") });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

// ------------------------------------------------------------------ drawing

function drawInline(doc, parent, nodes) {
  for (const node of nodes) {
    if (node.text !== undefined) parent.append(doc.createTextNode(node.text));
    else if (node.code !== undefined) {
      const code = doc.createElement("code");
      code.textContent = node.code;
      parent.append(code);
    } else if (node.strong) {
      const strong = doc.createElement("strong");
      drawInline(doc, strong, node.strong);
      parent.append(strong);
    } else if (node.em) {
      const em = doc.createElement("em");
      drawInline(doc, em, node.em);
      parent.append(em);
    } else if (node.link !== undefined) {
      const link = doc.createElement("a");
      link.setAttribute("href", node.link);
      // A click in the preview must not leave the unsaved draft behind.
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer nofollow");
      drawInline(doc, link, node.children);
      parent.append(link);
    } else if (node.unsafe !== undefined) {
      const span = doc.createElement("span");
      span.className = "preview-problem-inline";
      drawInline(doc, span, node.children);
      span.append(doc.createTextNode(` (link not allowed: ${node.unsafe})`));
      parent.append(span);
    }
  }
}

function drawBlocks(doc, parent, blocks) {
  for (const block of blocks) {
    let element;
    if (block.heading) {
      element = doc.createElement(`h${block.heading}`);
      drawInline(doc, element, block.inline);
    } else if (block.paragraph) {
      element = doc.createElement("p");
      drawInline(doc, element, block.paragraph);
    } else if (block.list) {
      element = doc.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.list) {
        const li = doc.createElement("li");
        drawInline(doc, li, item);
        element.append(li);
      }
    } else if (block.quote) {
      element = doc.createElement("blockquote");
      drawBlocks(doc, element, block.quote);
    } else if (block.code !== undefined) {
      element = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = block.code;
      element.append(code);
    } else if (block.rule) {
      element = doc.createElement("hr");
    } else if (block.problem) {
      element = doc.createElement("p");
      element.className = "preview-problem";
      element.textContent = block.problem;
    }
    if (element) parent.append(element);
  }
}

// Draws `source` into `container`, replacing what was there. Answers the
// problems the build would refuse, in order.
export function renderPreview(container, source, doc = container.ownerDocument) {
  const blocks = parseBlocks(source);
  const fragment = doc.createDocumentFragment();
  drawBlocks(doc, fragment, blocks);
  container.replaceChildren(fragment);
  const problems = [];
  const collect = (list) => {
    for (const block of list) {
      if (block.problem) problems.push(block.problem);
      if (block.quote) collect(block.quote);
    }
  };
  collect(blocks);
  return { blocks, problems };
}
