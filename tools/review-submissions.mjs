#!/usr/bin/env node
// The review helper: reads the articles waiting for review and proposes a
// decision for each, with notes the owner can send as they are or edit.
//
// It decides nothing and publishes nothing. It never calls article-review; it
// prints the call for the owner to make, after reading the article. Publishing
// is a third, separate step (article-publish-approved) that this script does
// not mention a way to skip.
//
// Usage, read-only:
//
//   SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
//     node tools/review-submissions.mjs            # pending articles, live
//   node tools/review-submissions.mjs --file rows.json   # rows exported from the SQL editor
//   ... --json                                      # machine-readable proposals
//
// The key is read from the environment and never printed. For a second
// opinion from a language model, tools/article-review-prompt.md is the prompt
// to give it together with the article.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { proposeReview } from "../supabase/functions/_shared/submissions.mjs";

const COLUMNS = "id,title,summary,lanes,body_markdown,status,submitted_at,reviewer_notes";

export async function fetchPending({ url, key, fetchImpl = fetch }) {
  const endpoint = `${url.replace(/\/$/, "")}/rest/v1/article_submissions?status=eq.pending&select=${COLUMNS}&order=submitted_at.asc`;
  const response = await fetchImpl(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`Reading pending articles failed with HTTP ${response.status}.`);
  return response.json();
}

// One proposal per article, in the order they were submitted.
export function proposals(rows) {
  return rows
    .filter((row) => row && row.status === "pending")
    .map((row) => ({ id: row.id, title: row.title, submitted_at: row.submitted_at, ...proposeReview(row) }));
}

export function reviewCommand(proposal, functionsUrl = "$SUPABASE_URL/functions/v1") {
  const body = JSON.stringify({ id: proposal.id, decision: proposal.decision, reviewer_notes: proposal.notes });
  return [
    `curl -sS -X POST "${functionsUrl}/article-review" \\`,
    '  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" \\',
    `  --data ${shellQuote(body)}`,
  ].join("\n");
}

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

export function report(list) {
  if (!list.length) return "No articles are waiting for review.\n";
  const out = [];
  for (const item of list) {
    out.push(`== ${item.title || "(untitled)"}  [${item.id}]`);
    out.push(`   submitted ${item.submitted_at ?? "unknown"}`);
    out.push(`   proposed: ${item.decision}`);
    out.push(...item.notes.split("\n").map((line) => `   | ${line}`));
    out.push("   Read the whole article first. To send this decision as it stands:");
    out.push(...reviewCommand(item).split("\n").map((line) => `   ${line}`));
    out.push("");
  }
  out.push("Nothing was sent. Approving does not publish; article-publish-approved is a separate call.");
  return `${out.join("\n")}\n`;
}

async function main(argv) {
  const json = argv.includes("--json");
  const fileAt = argv.indexOf("--file");
  let rows;
  if (fileAt !== -1) {
    rows = JSON.parse(await readFile(argv[fileAt + 1], "utf8"));
  } else {
    const url = process.env.SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!url || !key) {
      process.stderr.write("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --file rows.json.\n");
      process.exit(2);
    }
    rows = await fetchPending({ url, key });
  }
  const list = proposals(Array.isArray(rows) ? rows : []);
  process.stdout.write(json ? `${JSON.stringify(list, null, 2)}\n` : report(list));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
