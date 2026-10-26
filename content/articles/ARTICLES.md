# Articles

Posts live here as Markdown. `npm run build` turns them into static pages under
`docs/articles/`, which Vercel serves at `/articles` and `/articles/<slug>`.
There is no CMS and no service behind this: the repository is the CMS.

Sources live in `content/articles/` rather than next to the pages in `docs/`
because everything in `docs/` is published as-is. A draft placed there would be
reachable on the live site.

## Add a post

1. Create `content/articles/<slug>.md`. The file name is the URL, so use
   lowercase words joined by hyphens: `mix-measurements-as-a-report.md` becomes
   `/articles/mix-measurements-as-a-report`.
2. Start it with frontmatter:

   ```
   ---
   title: Loudness, balance and stereo
   date: 2026-10-26
   lanes: [musician]
   summary: One sentence that says what the post is about.
   draft: true
   ---
   ```

3. Write the body in Markdown below the second `---`.
4. Run `npm run build`, then `npm test`. Preview with
   `python3 -m http.server 8787 --directory docs` and open
   `http://localhost:8787/articles/`.
5. When it is ready, set `draft: false`, run `npm run build` again, and commit
   the Markdown together with what the build changed in `docs/articles/` and
   `docs/sitemap.xml`. The tests fail if the two are out of step.

## Frontmatter

| Field | Required | What it takes |
|---|---|---|
| `title` | yes | Plain text. Quote it if it contains a colon. |
| `date` | yes | An absolute date, `YYYY-MM-DD`. |
| `lanes` | yes | One or more of `developer`, `ai`, `musician`, as `[developer, ai]` or as a `- item` list. |
| `summary` | yes | Exactly one sentence. It is the lede, the index blurb and the meta description. |
| `draft` | no | `true` or `false`. Defaults to `false`. |

Any other field, a missing field, a relative date, an unknown lane or a
malformed line stops the build and names the file and the problem. Nothing is
published until every post is valid.

A draft produces no page at all: it is not in the index, not in the sitemap,
and not reachable by URL. To preview one, set `draft: false` locally and do not
commit the result.

## Markdown that works

- `##`, `###` and `####` headings. `#` is refused: the title is the page's
  only top-level heading.
- Paragraphs, `-` or `*` bullet lists, `1.` numbered lists, `>` quotes,
  fenced code blocks, and `---` rules.
- `**bold**`, `*italic*`, `` `code` ``, and `[links](https://example.com)`.
  Links start with `https://`, `mailto:`, `/` (another page on this site, such
  as `/agent.html`) or `#`.

Images and tables are refused for now rather than rendered badly. Raw HTML is
shown as text, never run.

## Voice

Plain and direct. Absolute dates or version numbers, never "today" or "last
week". No em dashes. Say what WavRead measures; never claim it finds what is
wrong with a mix. The tests check the dates and the dashes.

Every page shows the author as EZmannBuilds and ends with a link to `/buy`.
The page template, the author name and the call to action are in
`scripts/articles.mjs`.
