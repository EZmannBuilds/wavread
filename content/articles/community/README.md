# Community articles

Articles written by WavRead users in the site's editor
(`/account/articles/new`), reviewed by a person, and published by the owner.
Staff posts live one level up, in `content/articles/`, and are written in the
repository directly.

|  | Staff posts | Community posts |
|---|---|---|
| Where the Markdown lives | `content/articles/<slug>.md` | `content/articles/community/<slug>.md` |
| Who writes it | WavRead, in the repository | A signed-in writer, in the site's editor |
| How it gets here | Committed by hand | Approved, published to `article_publish_queue`, exported by the owner |
| Author line | EZmannBuilds | The writer's profile (`author_slug`) |
| `source` | not set | `user` |

## How a file arrives here

1. A writer submits an article. It is `pending`.
2. The owner runs `node tools/review-submissions.mjs`, reads the article, and
   calls `article-review` with `approved`, `needs_changes` or `rejected`.
   **Approving does not publish.**
3. For an approved article only, the owner calls `article-publish-approved`.
   That writes this directory's file into `article_publish_queue` and marks the
   article `published`. It does not touch the repository.
4. The owner runs `node tools/export-publish-queue.mjs`, which writes
   `content/articles/community/<slug>.md`. It never overwrites a file and
   refuses a slug a staff post already uses.
5. Read the diff, commit it, `npm run build`, `npm test`.

Nothing in that chain publishes by itself, and no step can skip approval.

## The file

```
---
title: "Reading a master's loudness as a report"
date: 2026-10-27
lanes: [musician]
summary: "One sentence that says what the post is about."
author_slug: jane-doe
source: user
draft: false
---

## First section
...
```

The first five fields are the ones the articles build takes (see
`content/articles/ARTICLES.md` on PR #8). `author_slug` is the writer's public
profile, `/u/<author_slug>`, and `source: user` marks the post as a community
one. The body follows the same Markdown subset; the editor and the submit
function check it with the same rules (`supabase/functions/_shared/submissions.mjs`).

## What this directory depends on

Static pages for community posts need the articles build from **PR #8
(`feat/articles-cms-lite`) merged, plus a follow-on change** to it. This PR does
not touch #8. As #8 stands:

- `scripts/articles.mjs` reads `content/articles/*.md` only, so files here are
  ignored rather than built. Nothing breaks, and nothing renders.
- Its frontmatter check refuses unknown fields, so it must learn `author_slug`
  and `source` before it reads this directory.

The follow-on, after #8 lands:

1. Read `content/articles/community/*.md` too (skipping this README), into the
   same `/articles/<slug>` namespace, and stop the build when a slug appears in
   both directories.
2. Accept `author_slug` (a profile slug) and `source` (`user` only) in
   frontmatter, and require both for files in this directory.
3. Show the writer's display name and a link to `/u/<author_slug>` in place of
   "By EZmannBuilds" for community posts, with a line saying it is a community
   article reviewed by WavRead.
4. Apply the voice tests (no em dashes, no relative dates) to this directory
   too. The editor warns about both; the reviewer decides whether to ask for
   changes.

Until then, a published community article exists as a committed Markdown file
and on its writer's profile, and its `/articles/<slug>` link does not resolve.

No live user content is committed with this README.
