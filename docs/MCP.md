# WavRead MCP integration

The first prerequisite is now present in 1.5.3.1: a discoverable local API with
route/method discovery, form inspection, partial settings updates, saved readings,
rename actions, stem selection, per-part data, job status and existing exports.

To ship an MCP, add a small server using the official Python or TypeScript MCP SDK.
Expose typed tools for capabilities, tracks, reading, settings, rename, stem
selection, analysis, jobs and export. Each should call the existing loopback app
routes so UI and agents use the same validation and persistence. Use stdio for a
local desktop client; keep diagnostics on stderr. The app must be running.

Use a separate Python 3.12 runtime or a supported Node runtime: the current DSP
virtualenv uses Python 3.9, so do not force a new SDK into its analysis dependencies.
Package the adapter and register its executable with the user's MCP client.
Test initialization, tools/list, successful tool calls, validation errors,
unavailable app/capture, job cancellation and rename/selection round trips.
A public remote connector additionally needs authenticated HTTPS hosting and
explicit consent for any audio/data crossing the machine boundary.

The Markdown skill does not itself provide MCP access. This update includes the
API foundation and rewritten skill; an MCP adapter is not installed or advertised
as already available.

Official guide: https://modelcontextprotocol.io/docs/develop/build-server
