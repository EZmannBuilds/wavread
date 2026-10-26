import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { buildArticles } from "./articles.mjs";

const source = resolve("docs");
const output = resolve("dist-site");

// Articles are written into docs/ first, so the committed site and the
// published one are the same files. A bad post stops the build here, before
// dist-site is touched.
try {
  const { posts, drafts } = await buildArticles({ contentDir: resolve("content/articles"), docsDir: source });
  process.stdout.write(`Built ${posts.length} article${posts.length === 1 ? "" : "s"} into docs/articles` +
    (drafts.length ? ` (${drafts.length} draft${drafts.length === 1 ? "" : "s"} skipped)` : "") + "\n");
} catch (error) {
  process.stderr.write(`Build failed: ${error.message}\n`);
  process.exit(1);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
process.stdout.write(`Built static site at ${output}\n`);
