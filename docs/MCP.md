# WavRead and MCP assistants

WavRead 1.5.6 and later carry a small helper program, `wavread-mcp`, inside the
app. It lets an assistant that speaks MCP (Claude Desktop, Claude Code, Codex
and others) operate WavRead: analyze files, read the measurements, compare with
references, choose stems, rename tracks and change settings. WavRead itself
never mentions it, and nothing in WavRead needs an assistant.

## Where it is

| | Path |
|---|---|
| macOS | `/Applications/WavRead.app/Contents/Helpers/WavRead MCP.app/Contents/MacOS/wavread-mcp` |
| Windows | `%LOCALAPPDATA%\Programs\WavRead\mcp\wavread-mcp.exe` |

## Adding it to an assistant

Claude Code: `claude mcp add --scope user wavread -- "<path>"`

Codex: `codex mcp add wavread -- "<path>"`

Claude Desktop: in Settings › Developer › Edit Config, add to `mcpServers`:

```json
{"mcpServers": {"wavread": {"command": "<path>", "args": []}}}
```

Any other client takes it as a local stdio server with that command and no
arguments. If WavRead is closed, the helper opens it.

## What it can do

Twelve tools: `start_wavread`, `capabilities`, `settings`, `list_tracks`,
`read_track`, `analyze_files`, `jobs`, `select_stems`, `rename_track`,
`inspect_page`, `app_request` and `save_app_file`. Together they reach every
action the app offers, including deleting, with the same access you have in
the app. Ask the assistant for what you want done, and check the result in
WavRead.

## What leaves your computer

Nothing, from the helper itself: it talks only to WavRead, on this computer,
and audio is never sent anywhere. What a tool returns (measurements, track
names, document text and your notes) goes into the assistant's conversation,
under that assistant's privacy policy. The [privacy page](privacy.html) covers
the rest of the app.

## The skill

The [WavRead skill](agent.html) tells an assistant how to read the documents and
run the app well. It works with or without the helper.
