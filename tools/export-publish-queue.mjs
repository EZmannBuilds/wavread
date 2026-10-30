#!/usr/bin/env node
// Writes published community articles into the repository.
//
// article-publish-approved puts each published article's Markdown file into
// article_publish_queue rather than writing to the repository itself. This
// copies the files that have not been exported yet into
// content/articles/community/<slug>.md, so the owner can read the diff, commit
// it, and build. It refuses to overwrite a file, and refuses a slug that a
// staff post in content/articles/ already uses, because both would be one URL.
//
// Usage:
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node tools/export-publish-queue.mjs
//   node tools/export-publish-queue.mjs --file queue.json     # rows copied from the SQL editor
//   ... --mark-exported   # after writing, stamp exported_at on the rows written (live only)
//
// Without --mark-exported nothing in the database changes. The key is read from
// the environment and never printed.

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bodyProblems, communityPath, isSlug, voiceWarnings } from "../supabase/functions/_shared/submissions.mjs";

const exists = (path) => access(path).then(() => true, () => false);

export async function fetchQueue({ url, key, fetchImpl = fetch }) {
  const endpoint = `${url.replace(/\/$/, "")}/rest/v1/article_publish_queue?exported_at=is.null&select=id,slug,path,markdown,queued_at&order=queued_at.asc`;
  const response = await fetchImpl(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`Reading the publish queue failed with HTTP ${response.status}.`);
  return response.json();
}

// Plans and writes the files. Answers what was written and what was refused,
// with the voice notes for each written file (the articles build's tests hold
// posts to them).
export async function exportQueue(rows, { root = ".", write = writeFile } = {}) {
  const written = [];
  const refused = [];
  for (const row of rows) {
    const slug = String(row?.slug ?? "");
    if (!isSlug(slug) || row.path !== communityPath(slug) || typeof row.markdown !== "string") {
      refused.push({ id: row?.id, slug, reason: "the row's slug, path or file is malformed" });
      continue;
    }
    const target = resolve(root, row.path);
    if (await exists(target)) {
      refused.push({ id: row.id, slug, reason: `${row.path} already exists; it is never overwritten` });
      continue;
    }
    if (await exists(resolve(root, "content/articles", `${slug}.md`))) {
      refused.push({ id: row.id, slug, reason: `content/articles/${slug}.md is a staff post with the same URL` });
      continue;
    }
    const body = row.markdown.split(/\n---\n/).slice(1).join("\n---\n");
    const notes = [...bodyProblems(body), ...voiceWarnings({ body_markdown: body }).map((w) => w.message)];
    await mkdir(resolve(root, "content/articles/community"), { recursive: true });
    await write(target, row.markdown);
    written.push({ id: row.id, slug, path: row.path, notes });
  }
  return { written, refused };
}

async function markExported({ url, key, ids, fetchImpl = fetch }) {
  if (!ids.length) return;
  const endpoint = `${url.replace(/\/$/, "")}/rest/v1/article_publish_queue?id=in.(${ids.join(",")})`;
  const response = await fetchImpl(endpoint, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ exported_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`The files were written, but marking them exported failed with HTTP ${response.status}.`);
}

async function main(argv) {
  const fileAt = argv.indexOf("--file");
  const url = process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  let rows;
  if (fileAt !== -1) {
    rows = JSON.parse(await readFile(argv[fileAt + 1], "utf8"));
  } else {
    if (!url || !key) {
      process.stderr.write("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --file queue.json.\n");
      process.exit(2);
    }
    rows = await fetchQueue({ url, key });
  }
  const { written, refused } = await exportQueue(Array.isArray(rows) ? rows : []);
  for (const item of written) {
    process.stdout.write(`wrote ${item.path}\n`);
    for (const note of item.notes) process.stdout.write(`  note: ${note}\n`);
  }
  for (const item of refused) process.stdout.write(`refused ${item.slug || item.id}: ${item.reason}\n`);
  if (!written.length && !refused.length) process.stdout.write("Nothing is waiting in the publish queue.\n");
  if (argv.includes("--mark-exported") && fileAt === -1) {
    await markExported({ url, key, ids: written.map((item) => item.id) });
    process.stdout.write(`marked ${written.length} exported\n`);
  }
  if (written.length) {
    process.stdout.write(`Next: review the files, commit them, then npm run build and npm test. See ${join("content", "articles", "community", "README.md")}.\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
