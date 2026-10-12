# Local WavRead MCP

Implemented in `integrations/wavread_mcp/server.py` using the official Python MCP
SDK, pinned to 2.2.0 with a committed uv lockfile. It runs as a local stdio process
and talks only to WavRead's loopback HTTP API. No public MCP port or hosted service
is needed. Audio uploads are local transfers to the local app. Measurements,
context and page text returned by tools enter the assistant conversation; a cloud
assistant can therefore receive those results. Existing app actions such as update
checks can still use the internet.

## In the app (1.5.6 and later)

Every build ships the server frozen into its own program, `wavread-mcp`, beside
the app:

| Platform | Installed helper |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\WavRead\mcp\wavread-mcp.exe` |
| macOS | `WavRead.app/Contents/Helpers/WavRead MCP.app/Contents/MacOS/wavread-mcp` |

**Settings › AI assistants** shows the exact path on that machine, with the
lines to paste into Claude Desktop (`claude_desktop_config.json`), Claude Code
(`claude mcp add --scope user wavread -- "<path>"`) and Codex
(`codex mcp add wavread -- "<path>"`). Any other client takes it as a local
stdio server with that command and no arguments. Access is on by default and
covers every WavRead action, deletes included.

Its `start_wavread` tool opens the WavRead it was installed with (`WavRead.exe`
beside its `mcp` folder, or the `WavRead.app` that contains it) and waits up to
30 seconds for the app to answer.

How it is built: `tools/build.py` syncs `integrations/wavread_mcp` from its
`uv.lock` (with the `build` group, which adds PyInstaller), freezes it with
`integrations/wavread_mcp/wavread_mcp.spec`, and copies it into the app. A
separate program rather than a mode of `WavRead.exe`: the app is a windowed
build with no stdio on Windows, and the MCP SDK's dependencies would otherwise
have to be resolved into `requirements.lock.txt` beside numba and scipy.
`tools/gen_licenses.py` lists the helper's components too. On macOS,
`tools/sign_and_notarize.sh` seals the nested helper bundle before the app.

## From source

From the repository root:

```sh
uv sync --project integrations/wavread_mcp --python 3.12 --frozen
```

Then register the server with your client, using the adapter's interpreter:

| | Interpreter |
|---|---|
| macOS / Linux | `integrations/wavread_mcp/.venv/bin/python` |
| Windows | `integrations\wavread_mcp\.venv\Scripts\python.exe` |

```sh
codex mcp add wavread -- "$PWD/integrations/wavread_mcp/.venv/bin/python" "$PWD/integrations/wavread_mcp/server.py"
claude mcp add --scope user wavread -- "$PWD/integrations/wavread_mcp/.venv/bin/python" "$PWD/integrations/wavread_mcp/server.py"
```

Running the app from source, Settings › AI assistants prints these lines with
the checkout's paths filled in.

The adapter has its own Python 3.12 environment. The audio engine keeps its existing
Python environment and DSP dependencies. Keep the checkout and both environments
in place. Open a fresh task or reload the client if its current tool list does not
refresh.

Start the source app through the MCP `start_wavread` tool or:

```sh
integrations/wavread_mcp/.venv/bin/python integrations/wavread_mcp/start_app.py
```

Close an older running WavRead first. The launcher never kills an existing app. It
opens the source app with `WAVREAD_USE_APP_DATA=1`, using the desktop's configured
library rather than the checkout's development library. It does not copy or
migrate audio. Logs: `~/Library/Logs/WavRead/local-app.log` on macOS,
`%LOCALAPPDATA%\WavRead\Logs\local-app.log` on Windows. The launcher needs the
source app's `.venv` with its existing native dependencies.

## Tools and control

- `start_wavread`: start the local app, or report an existing compatible instance.
- `capabilities`: app/version, route methods, settings schema and capture availability.
- `inspect_page`: current form controls, choices and rendered HTML.
- `app_request`: all implemented HTTP actions, including specialist settings,
  history, references, markers, comparisons, reanalysis, storage, exports and deletes.
  Accepts query, repeated form fields, or JSON. Discover routes before using them.
- `list_tracks` / `read_track`: saved library and actual JSON readings, including
  per-instrument data. `/api/v1/tracks/<name>` is the raw reading endpoint.
- `settings`: validated partial updates that preserve other preferences.
- `rename_track`: rename related files/records and return the resulting library.
- `analyze_files`: stream local audio uploads and queue track or aligned stem analysis.
- `select_stems`: rename instruments, assign individual/master/reverb/delay roles,
  and include/exclude stems in a new selection reading. Disabled parts are excluded
  from summed playback and findings. Masters are measured separately.
- `jobs`: progress, failures, completion and cancellation by exact job name.
- `save_app_file`: stream a response to a new local file without returning binary
  audio to the assistant. Existing destinations are not overwritten.

This is full access to implemented WavRead actions, including destructive ones;
there is no read-only tier. The assistant must still follow the user's requested
scope. It cannot make an unimplemented feature available. Browser-only transient
controls and DAW/VST automation are not provided by this HTTP adapter. Serum,
Analog Lab and native DAW project editing need an integration with the chosen DAW.
Public-build capture restrictions remain in place.

HTTP redirects are reported as redirects, not automatically as successful changes.
Tools must read the returned messages and verify saved state. Analysis is queued:
read `jobs` before claiming a finished result. A missing or older app gives an
explicit error. API destinations are restricted to loopback; environment proxy
settings and automatic redirects are disabled. Alternate local instances can use
`WAVREAD_URL=http://127.0.0.1:<port>`; the launcher handles only default port 8765.

## Verification

```sh
.venv/bin/python tests/test_mcp.py
.venv/bin/python tests/test_agent_stems.py
.venv/bin/python tests/test_assistants.py
```

`WAVREAD_MCP_BINARY=<path to wavread-mcp>` makes `test_mcp.py` run the same checks
against a frozen helper instead of `server.py`; CI does this for the Windows build.
`test_assistants.py` checks that the packaged app finds its helper, that the
helper finds its app, and what Settings › AI assistants prints.

The MCP test launches the real stdio server and client against a temporary Flask
library with real DSP fixtures. It checks discovery, form inspection, invalid
settings/routes, settings persistence, renaming, local exports and overwrite
refusal, audio upload/analysis, and stem selection with separate master data.
The API/stem suite additionally checks selected playback audio against its source.
No test modifies the user's library.
