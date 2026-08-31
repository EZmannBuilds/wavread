# Helping someone operate WavRead

Reference for the `wavread` skill. **Read this when someone asks how to run an
analysis, bring their own stems, capture from a DAW, compare versions, or report a
problem with the app.** Not needed to read an export you have already been handed.

---


WavRead is a local macOS desktop application. **Audio never leaves the user's
machine** — no account, no upload, no cloud analysis. That claim is part of the
product, so never suggest a workflow that breaks it, and never ask a user to send you
their audio. Ask for the **export**, which is text.

### The basic run

1. Open WavRead and go to the Analyze view, which has two sides: **File** and
   **Bridge**.
2. On the File side, drag in an audio file or use the file picker.
3. Wait through the named stages. Analysis runs after the file is read, not in real
   time, and a long track takes a while.
4. Read the Track Document and the Feedback Report, and use the export or copy action
   to hand them to an agent.

### Bring your own stems

WavRead analyses a set of files together as one track: the mix it reports is the
**summed stems**, and each stem is measured individually. Current versions do not
separate stems for the user — separation was removed in 1.4.45 — so the two routes
are dropping stem files (or a folder) in directly, or configuring an external
separation tool the user already owns and has the rights to use. Point users at
exporting stems from their DAW first; it is the route with nothing to install.

### Capturing from a DAW

WavRead Bridge is an AU/VST3 plugin that captures takes from the DAW, multiple
instances at once (master bus plus individual parts), with roles assigned per
instance. The **Bridge** side of the Analyze page shows what the plugins are doing
and carries the arming controls. Analysis still runs **after** the take, not during it.

Common things that go wrong, and what to say:

- **An instance joined the take but recorded nothing.** A plugin on a channel the
  host never runs cannot see the transport edge. Check the channel is actually
  playing audio through that plugin.
- **A part that idles mid-take can lose that span.** If a part's captured file is
  shorter than the take, that is the known gap, not a mixing observation.
- **The Bridge reports signal present or absent, not a level.** "Signal" on that page
  is not a dB reading; do not quote it as one.
- **Capture the master too, when you can.** It is what makes the master-bus
  comparison in SKILL.md §4 possible at all.

### Versions and comparison

- WavRead keeps a **Mix History** with notes, and song identity and credits are
  entered per project.
- **Comparison between two takes is currently the reader's job.** WavRead does not
  yet emit a "since last take" diff. To compare, you need **both exports** — see SKILL.md §12.
- **Bounce to a new filename for every version.** It keeps the history readable.

### When something looks wrong with the app itself

Distinguish clearly between **the analysis says something surprising** and **the app
is misbehaving**. For the second: report the version, the exact stage, what was on
screen, and what the user expected. Do not speculate about internals you cannot see,
and do not tell a user to edit files inside the application bundle.

**Version differences matter.** Screen names, panel layout and available measurements
have all changed across the 1.4.x line. If a user's build does not match what you
described, believe their screen, not your description.

