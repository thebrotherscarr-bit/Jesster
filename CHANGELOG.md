# Changelog

All notable changes to this repository are recorded here, one entry per change.
The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- `eval_start` answered "started" and no run began (2026-11-05, b100, twice): Node's detached spawn gives
  PowerShell no console (DETACHED_PROCESS), and Windows PowerShell then exits 0 having run nothing. run-bar.ps1 is now
  opened by `Start-Process` in its own minimized window, everything it says goes to `storage/evals/runs/<tag>/launch.log`
  too, and `eval_start` waits up to 20 s for the run's progress file: a run that ends without one is an error with the
  log's tail, never "started".
- `eval_start` with no transport is AG-UI for asks sets only (small, heldout) and in-process for every other set; a host
  transport named for a set evals.py refuses on one (bfcl, aider-py, steps) is an error before anything starts. A
  workflow's `eval_start` step no longer adds `ag-ui` itself (2026-11-05: the bfcl flow exited 2 at once).

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
