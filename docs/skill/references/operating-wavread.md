# Operating WavRead 1.5.3.1

The app is a loopback Flask service, normally port 8765. Start with
`GET /api/v1/capabilities`: it reports version, routes, methods, settings and capture
availability. `GET /api/v1/forms?path=/settings-page/analysis` returns the rendered
form controls and HTML. This is also the fallback for options outside JSON settings.
No cloud account is required to analyze local files.

## Settings and context

`GET /api/v1/settings` returns values, effective defaults and validation schema.
`PATCH /api/v1/settings` accepts a JSON object of only the fields to change.
Examples: `{"analysis_lyrics":false}`, `{"daw":"Logic Pro","imagery":"A railway station after midnight"}`.
Boolean values must be JSON booleans; enums must match the advertised choices.
Reading, performance, accessibility, update checks, analysis passes and creative
context are editable. External separation command, privacy consent, storage and
other specialist controls use their existing forms: inspect the relevant Settings
page rather than guessing fields or overwriting the settings file.

## Tracks and versions

`GET /api/v1/tracks` lists saved readings. `GET /json/<name>` provides data.
`POST /rename/<name>` with form field `new` renames the track and related records.
Read the redirect destination and re-list the library to confirm the new name.
Inspect `/track/<name>` for history, identity, markers, references, stage, material
and export controls. Quote/encode route segments. Never rename a running analysis.
`POST /analyze` accepts `path` (local file/folder) and `mode` (`batch` or `stems`).
`GET /jobs/status` reports queued/running/done/failed/cancelled; do not call queued work complete.

## Stems

Import aligned files through `/import` multipart form (`file` repeated, `mode=stems`,
`name`, `genre`, `stage`, `mix_type`). Optional `stem_manifest` is a JSON array in
file order: `[{"name":"Piano","role":"individual","enabled":true}, ...]`.
Roles: master, individual, reverb, delay. Names are instrument-first, unique and editable.
Keep a master separate from the summed instruments. No automatic separation or
reliable audio-based instrument identification is promised.

On `/track/<name>?view=stems`, edit include/name/type controls. Posting to
`/track/<name>/stems` creates a fresh analysis with selected audio and a matching
report. Excluded parts are omitted from summed playback and stem findings; their
manifest records remain to explain the selection. A supplied master is measured
separately and never added to its instruments. If any part is excluded, listening
uses a fresh sum rather than a master that still contains the excluded part.
Each enabled part has `/track/<name>/stem/<stem>` and a `/data` JSON endpoint.

## Availability

DAW capture is disabled in public builds and remains Coming soon. Export aligned stems from the
DAW and import them. Do not bypass this with environment variables. WavRead can
compare references/versions; use the available reference workspace and both readings.
A local MCP adapter can wrap these routes with the official MCP SDK. It requires
an installed adapter runtime and client registration; the Markdown skill is not
itself an MCP server. See `docs/MCP.md` in the source repository.
