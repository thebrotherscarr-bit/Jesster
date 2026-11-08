# Changelog

All notable changes to this repository are recorded here, one entry per change.
The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- No flow started from the Flows shelf (2026-11-06; the operator: "NONE of the flows started"). Three eval examples
  reached Steward and were refused for the `transport: ag-ui` they were saved with; every other Run now never reached
  `schedules:run`: the shelf held Run now on every flow while any Steward conversation was mid-turn or a card waited
  (a grey word at the bar's end the only sign). Now Run now is held only while that flow runs or waits on its run; it
  is never skipped for a busy Steward (a scheduled eval still is); a failed run's reason, the first line of its error,
  is shown on the flow in red; a `running` left by a quit is cleared at start; and once per vault the stale transport
  is taken off eval steps whose sets are not all asks sets (`flowExamples.dropStaleTransports`, nothing else touched).
  Steward ADR-0009 and ADR-0003 carry dated notes (Steward #179).
- `eval_start` answered "started" and no run began (2026-11-05, b100, twice): Node's detached spawn gives
  PowerShell no console (DETACHED_PROCESS), and Windows PowerShell then exits 0 having run nothing. run-bar.ps1 is now
  opened by `Start-Process` in its own minimized window, everything it says goes to `storage/evals/runs/<tag>/launch.log`
  too, and `eval_start` waits up to 20 s for the run's progress file: a run that ends without one is an error with the
  log's tail, never "started".
- `eval_start` with no transport is AG-UI for asks sets only (small, heldout) and in-process for every other set; a host
  transport named for a set evals.py refuses on one (bfcl, aider-py, steps) is an error before anything starts. A
  workflow's `eval_start` step no longer adds `ag-ui` itself (2026-11-05: the bfcl flow exited 2 at once).

### Added

- `saved_flows` and `saved_flow_run` on SecondBrain's MCP: the Flows shelf's saved flows with their run state, and Run
  now on one by id through the shelf's own path (`schedules.cjs runNow`, which `schedules:run` calls too). Bounded and
  served with the reads, like `eval_start`. Steward is not offered them (his MCP `allowed_tools` name each tool he gets).

### Removed

- The archive digger, retired by Steward's ADR-0010 ("Notes are central in Jesster", 2026-11-05; the operator: "archive
  has been reconciled and sorted, no longer needs digging"): Settings → Archive digger (`ArchiveSection.tsx`), its IPC
  and `electron/archive.cjs` with its test, the Servers shelf's "notes kernel" row, and Integrations' "Their apps,
  using your notes" (writing the whole notes kernel into Claude Desktop's and Gemini CLI's configs, and the Claude Code
  command). The kernel's `archive` plugin stays in `notes/`; nothing in the app starts it. A test goes red if any of it
  is wired back.

### Changed

- `.mcp.json` and `opencode.json`: `jesster-notes` runs `notes/cli.py mcp --vault ../notes --only notes`, the one vault
  and the notes only (ADR-0010); it had opened `~/JessterNotes` with every kernel method.

### Added

- `python notes/cli.py mcp --only <list>`: the MCP server lists and answers only the methods named (names, prefixes
  ending in `.` or `.*`, or the preset `notes`), so an IDE such as Cursor can use the notes vault over stdio with no
  key and nothing beyond the notes. Proved in `notes/prove_notes.py`; documented in `notes/README.md`, "Use from an
  IDE (Cursor)".
