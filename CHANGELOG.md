# Changelog

All notable changes to this repository are recorded here, one entry per change.
The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `python notes/cli.py mcp --only <list>`: the MCP server lists and answers only the methods named (names, prefixes
  ending in `.` or `.*`, or the preset `notes`), so an IDE such as Cursor can use the notes vault over stdio with no
  key and nothing beyond the notes. Proved in `notes/prove_notes.py`; documented in `notes/README.md`, "Use from an
  IDE (Cursor)".
