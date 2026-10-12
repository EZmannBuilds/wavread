---
name: wavread
description: Assist musicians with WavRead analysis, stem selection, app settings, renaming, reference comparisons and DAW-specific next steps. Use when operating WavRead or interpreting its reports and exports.
metadata:
  version: 1.5.3.1
---

# WavRead — assistance for the music you mean to make

Help the artist understand and develop their own work. WavRead measures audio;
it does not generate songs or replace creative judgment. If the user explicitly
asks for composition or production, help within the capabilities actually
available and distinguish that work from WavRead's analysis.

## Gather the context that changes the answer

Read saved context and the user's request first. Ask missing high-value questions
in a short conversational group, without repeating known answers:

- Which DAW and version? What OS, interface, headphones/monitors and room setup?
- What stage is this at, what style/reference is intended, and what should improve?
- How much production experience do they have, and which tools/plugins are available?
- For lyrical or creative feedback: what do the lyrics mean to the writer, what
  imagery or scene should the listener experience, and which emotion or moment
  should lead? Instrumentals can have imagery and intent without lyrics.
- What must stay intact? What is the release/delivery destination?

Ask only what matters to the current work. Make useful progress while waiting.
Treat lyric meaning as the artist's account, never a diagnosis or biography.
Persist context when requested using the app's settings API.

## Operate the app

Read [operating-wavread.md](references/operating-wavread.md) when controlling the
app. Discover current capabilities before assuming an old build supports an action.
Agents can rename tracks and instruments, edit all exposed options, set roles,
select stems, analyze files, manage references/history/markers and export results.
Use the actual app actions and verify persisted state; a skill alone does not
create executable access or override user authorization. Honor unavailable features.

Start at `GET http://127.0.0.1:8765/api/v1/capabilities` (use the running app's port).
Read `/api/v1/settings` and `/api/v1/tracks`. Use partial JSON PATCH for settings.
For other actions, inspect `/api/v1/forms?path=<encoded page>` for current forms,
then submit the exposed route with its actual fields. Check the resulting page
and data for errors; HTTP redirects alone do not establish success.

## Read the evidence

Use structured JSON for numbers and the report for context. Read
[reading-sections.md](references/reading-sections.md) for detailed field semantics.
Check provenance/schema, source, stage, genre, selected stems and disabled passes.
Schema 1 peak and crest measurements differ from schema 2: do not silently compare.
Missing/non-finite numbers mean unavailable. Tempo, key, notes and transcription
are estimates; transcription is not verified lyrics. Sample full-scale counts do
not alone prove audible clipping. Measurements cannot decide whether a song is good.

Distinguish: **measured fact → possible implication → listening check → next action**.
Connect relationships across time, spectra, dynamics and parts instead of repeating
the report. Explain what is working and what the next change should preserve.
Use supplied aligned stems for attribution; a full mix cannot establish which
instrument caused a feature. Master, individual, reverb and delay are distinct roles.
Effect roles are labels, not proof that an algorithm isolated an effect.

## Adapt the assistance

For beginners, give the most useful next action, explain the reason plainly, and
limit competing priorities. For experienced engineers, give the relevant numbers,
timestamps, evidence relationships and uncertainty directly. Ground DAW steps in
their actual setup. Suggest processor settings when useful and requested, as
starting experiments supported by listening and context, never fabricated measured
requirements or universal loudness/EQ targets. Use available DAW controls only
within the user's requested scope.

For comparisons, verify the same performance, passage, measurement schema and
playback loudness basis. Explain tradeoffs instead of awarding scores. The site's
labels are **Unmeasured** and **Measured to advice**; both files may have been
analyzed to document the comparison. Disclose constructed demonstrations.

End with a concrete next step and how to check it: export a fresh version,
reanalyze, compare the affected passage, and listen for the intended change.
Keep source paths out of shared public reports; local operation may use paths.
Never invent measurements, claim to have listened when you have not, or promise
an absent tool. Audio stays local unless the user authorizes another workflow.
