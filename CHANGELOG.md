# Changelog

All notable changes to this repository are recorded here, one entry per change.
The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Steward's folder is found in the folder Settings names (`agent.steward.dir`), then the environment variable
  `STEWARD_DIR`, then `worlds\steward` beside the notes folder, today's layout and the default (Steward ADR-0020,
  ExecPlan 0006 P1, audit A2). It was Settings or the vault's sibling only, so a clone anywhere else was "not found".
  Wire: `agent.test.cjs` ("Steward's folder is Settings' first, then STEWARD_DIR ..."), red with STEWARD_DIR unread.

### Fixed

- The card wait is 30 minutes (the operator, 2026-11-08: "30 minutes"; it was 10): one value,
  `electron/agent/cardwait.cjs`, used by Telegram's and Discord's cards, an automation's, a card raised from outside
  (`approval_ask`) and the summary to the phone ("no answer in 30 minutes (counted as No)"); an answered-by-timeout
  card's edited text names the same wait. The Agent tab's own cards still wait for ever. `away.test.cjs` proves it on
  fake timers.
- Steward's ADR for the Flows-shelf tools is ADR-0017, not ADR-0016 (taken by "Steward is the brain of the PC",
  Steward #185, as #102 merged): the references in `estate.cjs`, its tests and this file now say so.
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

- The away loop's summary (Steward ADR-0016, ExecPlan 0005 M1, capabilities N1 to N4): when a turn from the phone or
  an automation ends, Jesster sends one short summary after Steward's answer: what was asked, what ran, what it changed
  (the path, file, flow or service a changing call named), and how it ended: done, stopped at a card answered No,
  stopped at a card nobody answered in the card wait, refused (WhatsApp), stopped by /stop, or failed with the error.
  Telegram turns get it on Telegram, WhatsApp turns in the WhatsApp chat (never Telegram), and a Steward automation's
  run always gets it on Telegram, whatever the flow delivers. A plain chat answer with no tool, card or error gets none.
  `electron/agent/summary.cjs`; the turn's run is recorded in `service.cjs` (`ask`). `away.test.cjs` runs the loop with
  no phone: a fake Telegram Bot API, the real bridge and service, and the real AG-UI client against a fake Steward
  host, for Yes (the same thread resumed from the card's checkpoint), No, no answer, and a failed run.
- `saved_flow_status` on SecondBrain's MCP (Steward ADR-0017: every Flows-shelf action has its tool on Jesster's MCP):
  one saved flow's run by the flow's id (its waiting run, else its newest in Steward's history) or Steward's run id:
  running, done or failed, each step's state and ms, and a failed run's reason, through the shelf's own reads
  (`recipe_status`, `recipe_runs`); a legacy prompt flow, or Steward's host down, answers from the flow's own last
  result. A read. `saved_flow_run` is now start-verified: after Run now's path it reads Steward's state back once, and
  says `started: false` with the reason when Steward did not take the run; a legacy prompt flow, run inline, says
  `started: true` and how it ended. The `saved_flow*` names stay apart from the door's `flow_*` (Manjuel's engine flows
  on the same MCP). Steward is offered all three (Steward's pull request with ADR-0017).
- End-to-end tests for the Flows shelf (`secondbrain/e2e/`, `@playwright/test` 1.65.0 pinned, Playwright's Electron
  support): the built app launched with a temp settings folder and vault holding an eval flow, a recipe flow and a
  legacy prompt flow, and Steward's MCP host replaced by a local fake (`e2e/fake-steward.mjs`). Run now on each one
  reaches Steward's `run_recipe` with the flow's id and trigger `now` (the legacy prompt runs on the local loop), shows
  running, then is filed ok or failed with its reason; + New flow builds, wires and saves a 3-block flow; Set up makes
  an automation of it. The `secondbrain` workflow runs them in an `e2e` job on Windows. Three test-only variables in
  `main.cjs`, none set in normal use: `SECONDBRAIN_USER_DATA`, `SECONDBRAIN_STEWARD_MCP_URL`, `SECONDBRAIN_SCHEDULER_MS`.
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
