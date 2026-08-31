# Reading each section, and the trap in it

Reference for the `wavread` skill. **Read this before quoting any section of a Track
Document in detail.** The rules that constrain what you may *say* live in `SKILL.md`;
this file is the per-section detail behind them.

---


### Overview

- **Tempo.** WavRead reports one figure from beat tracking. It has repeatedly
  reported the double-time reading on tracks felt at half — 191 BPM for a track felt
  at ~96. **If the reported tempo is above roughly 150 BPM, offer the half-time
  reading as an equally valid hearing** and let the user say which is right.
- **Key.** An estimate with a confidence figure. The most common documented error is
  **naming the relative major instead of the minor** (or the reverse) — the chord
  detector gets every chord right and only the key *label* is wrong. If the chord
  list clusters around a minor tonic while the key line says its relative major,
  say so and trust the chords.
- **Key confidence.** Low confidence often means genuine harmonic movement, not
  measurement failure. Confidence near 0.5 with both readings kept means the chroma
  is ambiguous. Read the chord table by time instead: if the early sections are
  diatonic to one key and a later stretch to another, **the track modulates**. That
  is information, and no rule in the app reports it.

### Loudness and the delivery contract

The delivery contract is WavRead's most reliable output. It carries integrated LUFS
(ITU-R BS.1770), LRA (EBU Tech 3342), sample peak, true peak (oversampled
**estimate** — labelled as such in the document), PLR, crest factor, per-channel
peaks, samples at full scale, DC offset, and the file's real sample rate, channel
count and encoding.

- **Integrated LUFS is not a score.** Streaming normalisation to roughly −14 LUFS is
  context the document prints; it is not a target the user is failing to hit.
- **Crest factor and PLR describe dynamics, not quality.** A high crest factor means
  peaks stand well above the average — that is "dynamic", not "good" or "unfinished".
- **True peak is an estimate.** Treat a marginal over as a flag to check, not a fact.
- **Read per-channel peaks.** A stereo file whose channels differ by several dB is
  worth mentioning; a mono fold-down can hide a channel peak entirely.

### Spectral balance

Seven bands as **percentage share of total energy** — sub (20–60 Hz), bass (60–150),
low-mid (150–500), mid (500–2 k), high-mid (2 k–6 k), high (6 k–12 k), air (12 k–20 k)
— plus a 1/3-octave series and an average spectral centroid. From 1.4.46 the seven
bands are also drawn over time.

- **These are energy shares, not perceived loudness**, and energy scales with
  amplitude squared. A large low end pushes every other band's share down. A track
  can hold the brightest centroid in a group while showing under 1% in the air band,
  because low frequencies carry most of the energy in almost all music. **Never say a
  track is dark because its air band reads 0.2%.** Cross the band shares against the
  centroid before making any brightness claim.
- **A mid share that falls between two takes usually means the low end grew**, not
  that the mids emptied. WavRead prints this caveat itself, and its own rule engine
  still ignores it.
- Shares always total 100%. A band cannot rise without another falling, so describe
  *balance between bands*, never an absolute amount.

### Stereo

Width, side/mid ratio, and L/R correlation, plus mono-risk and (in later versions)
width and mono-compatibility timelines.

- **Low or negative correlation is not automatically a defect.** It is a defect when
  mono playback matters. Say which you mean. Around zero means merely wide; clearly
  negative means something is actively cancelling. Different problems, different fixes.
- Cross a negative correlation against the **structure table and the arrangement**:
  a correlation dip that lines up with one wide pad entering is a different problem
  from one that runs the whole track.

### Structure

Sections detected by timbre and harmony change, each with time bounds, RMS level,
brightness, activity, and a plain-language character.

- **Boundaries are estimates.** They frequently do not correspond to the song's own
  verse/chorus map, and WavRead does not claim they do. Never call section 3 "the
  chorus" unless the user says it is.
- **"Level" means different things in different tables.** The section table's level is
  RMS averaged over the section. The stem table's level is the average while that part
  is playing. The vocal-parts table reports a separate figure computed by the lyrics
  stage — the same stem will show two values. **Compare within one table; never mix
  them in a sentence**, and say which one you are quoting, every time.

### Stems

WavRead measures each supplied stem individually: level, level relative to the
loudest stem, peak, true peak, clipping, crest factor, DC offset, waveform asymmetry,
percentage of the track it is active, first entry time, activity rate, dominant band,
and a level curve over the take.

- **Stems come from the user.** From version 1.4.45 WavRead no longer separates them
  itself and ships no separation model. Stems arrive either dropped in by the user or
  written by an external tool they configured in Settings. If a stem table exists, the
  user supplied those files, so **stem names are the user's filenames** and carry no
  guaranteed meaning. The Settings toggle for this stage is still labelled "Stem
  separation" — that is a stale label, not a returning feature.
- **The mix measured above a stem table is the summed stems** — see SKILL.md §4.
- **"absent" in a level column means the stem measured as never active**, and its
  peak column may still show a value. That combination usually means very quiet or
  effectively silent content — worth flagging as "check this file", not asserting as
  a mixing decision.
- **Do not build a lead-versus-double hierarchy out of filenames.** Two stems with
  similar names and similar dominant bands may be a lead and its doubler, or two
  unrelated parts. Ask.
- **A stem's name and its dominant band often disagree** — a part named for a bass
  instrument reading as mid, a part named as percussion reading as high-mid. Report
  the measurement and note the mismatch; do not silently believe the name.
- **The vocal-name heuristic reads job titles as voices.** Words like *lead*, *hook*
  and *stack* describe a job an instrument can also have, so a part named for one of
  them may be flagged "named like a vocal, no words recovered" while being an
  instrument. WavRead offers this as a claim rather than a fact — do not repeat it as
  a finding.
- **Filename hygiene: bounce to a new filename every time.** Filenames get reused —
  `Dog_V4.wav` twice, with different mixes inside — and a reused name makes the
  version history unreadable for both the user and you. (WavRead itself is safe here:
  it digests file *contents*, not names, so a re-analysis cannot return a stale stem
  table. Older versions could not make that promise.)

### Chords

Estimated progression with per-chord timings, beat counts, and a mean confidence.

- Chord detection has been notably reliable in practice, including where the key
  label was wrong. When chords and key disagree, weight the chords.
- A "main chords by time spent" summary is a different claim from the timeline. Quote
  whichever one supports your point, and name which.

### Melody

Transcribed notes for the lead part, with timings and amplitudes, and from 1.4.46
intonation in cents for held notes.

- **The transcriber's per-note figure is amplitude, not reliability.** In 1.4.46 the
  melody "confidence" column was renamed **amplitude**, because that is what it always
  was. In older exports, do not read that column as reliability.
- **Intonation figures are medians, and the medians are the reliable part.** The pitch
  contour is quantized to a third of a semitone and the document says so. A statement
  like "a median 14 cents flat" is usable; a single note's offset is not.
- **Octave jitter is common.** A melody line jumping an octave and back within a
  phrase is usually a transcription artefact, not a performance. Current versions drop
  notes more than about 16 semitones from the track's median pitch, so the wildest
  outliers are already gone — jitter *inside* that window is not. A lone outlier
  inside an otherwise stable run is an artefact; never build an argument on it.
- **A "vocal / lead" melody section may be reporting a lead instrument, not a voice.**
  Check the stem table: if the vocal stems read absent or barely active while a synth
  or string part is prominent, the transcribed notes are that instrument's.
- **Percussion is transcribed anyway.** The per-part notes state that percussion has
  no stable pitch and is summarised rather than transcribed, then print note events
  for drum parts. Ignore pitch on percussion.

### Lyrics — the part you must distrust

Machine lyric transcription is WavRead's **weakest subsystem by a wide margin**, and
its documented failures are severe and systematic:

- **Fabrication.** It has produced fluent, confident phrases that do not exist in the
  audio at all, including invented proper nouns.
- **Inversion.** Single words replaced by their opposite, producing grammatical
  English that states the reverse of the lyric.
- **Silent omission.** Whole sections — up to a minute of vocal — producing no output
  and no warning, on audio where the vocal stem shows clear activity.
- **The confidence figure does not predict accuracy.** The highest-confidence run on
  record still inverted a closing image; the lowest-confidence run fabricated rather
  than abstaining.
- **Background parts transcribe worse than leads.**
- **It has contradicted itself on a repeated line** within a single track — the same
  chorus transcribed two different ways. That is a free reliability signal: **scan
  for repeated sections transcribed differently and report the disagreement.**

**Rules that follow, and they are not negotiable:**

- Treat every machine transcription as **unverified**.
- **Never interpret a lyric — emotionally, biographically, or thematically — from a
  machine transcription.** Ask the user for their text first.
- If the user supplies their own lyrics, those are **user-entered** and authoritative;
  the transcription becomes a timing aid only.
- Do not report a lyric gap as silence. Cross it against the vocal stem's activity
  percentage before saying anything about it.
- Never repeat a transcribed phrase back to the user as if it were their writing.

### The document's own title, and song identity

**A document title is not a song title.** For a stem set, WavRead titles the document
with the set name — usually the first stem's filename — followed by every stem name.
The same string reappears in headings and cross-reference filenames.

Song title and credits (artist, album, version, producer, mix engineer, mastering
engineer, songwriter) are entered in the app and stored with the song, not with the
analysis. **Where they appear depends on the export format:**

| Export | Carries song identity? |
| --- | --- |
| Markdown (`.md`) | **No** — headed with the track's filename |
| PDF | **No** — cover carries the filename |
| JSON | **No** |
| CSV | **No** |
| **HTML** | **Yes** — title, artist, version and any filled-in credits |

So unless you were handed the HTML export and can see an identity block:

- Take the song's identity **from the requester**, or record it as missing.
- **Never invent a title, artist, engineer name, reference identity or credit**, and
  never present a filename as a title without saying that is what it is.

Missing metadata is missing, and a report that says so is correct.

