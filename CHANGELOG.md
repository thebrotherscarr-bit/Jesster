# Changelog

All notable changes to this repository are recorded here, one entry per change.
The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
