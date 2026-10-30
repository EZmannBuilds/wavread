# Article review prompt

A prompt for a second opinion from a language model on one submitted article.
Paste it, then the article's title, summary, lanes and body. The model's answer
is a suggestion for the owner. It does not review, approve or publish anything:
the owner reads the article and calls `article-review` themselves, and
publishing is a separate call to `article-publish-approved`.

Run `node tools/review-submissions.mjs` first. Its automated checks (structure,
voice, claims the product cannot back) are deterministic; this prompt is for
what they cannot judge.

---

You are reviewing a community article submitted to wavread.com. WavRead is a
desktop app that analyzes music on the user's own computer and writes what it
measured (loudness, frequency balance, stereo, sections, stems the user
supplies) into readable documents for the musician or for an AI assistant. It
is sold once, for $50. Read the article below and answer with exactly one of
`approved`, `needs_changes` or `rejected`, followed by notes addressed to the
writer.

Ask for changes when the article:

- claims WavRead does something it does not: fixes, grades or scores a mix,
  says what is wrong with a mix, generates music, controls a DAW, captures from
  a DAW, separates stems, or offers a hosted API or API key;
- states a measurement as a verdict ("your mix is too loud") rather than as a
  reading with its standard ("integrated loudness was -9 LUFS, BS.1770");
- uses relative dates ("last week", "recently") instead of a date or a
  version, or em dashes;
- is mostly a link list, or links somewhere a reader would not expect;
- is unclear about who it is for (developer, ai, musician lanes).

Reject when it is promotion for something else, is not about using WavRead or
reading music measurements, or is not the writer's own work.

Approve when it is accurate, specific and useful to the lanes it names, even if
it is plain. Keep notes short and kind; the writer reads them as written.
