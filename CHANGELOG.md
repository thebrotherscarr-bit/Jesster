# Changelog

All notable changes to this repository are recorded here, one entry per change.
The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- The notes kernel's desktop install (`system.install_desktop`, `system.desktop_build`) reads its releases from the
  environment variable `JESSTER_UPDATE_REPO` (owner/name), else `thebrotherscarr-bit/Jesster`, today's, and holds
  downloads to that repository's release assets (`notes/plugins/system.py` `update_repo`, `releases_url`,
  `download_prefix`); a value that is not owner/name is not used (Steward ADR-0020, ExecPlan 0006 P1, audit B2).
  Wire: `prove_notes.py` ("update repository"), red with JESSTER_UPDATE_REPO unread.
- The notes folder is Settings' `vaultDir`, else the environment variable `JESSTER_VAULT` (the one the notes kernel and
  `start-secondbrain.ps1` already read), else `Documents\SecondBrain`, today's default (`settings.cjs` `vaultDirOf`,
  `main.cjs` `vaultDir`), so the app and the kernel can be pointed at one vault by one variable (Steward ADR-0020,
  ExecPlan 0006 P1, audit A11). This PC names its vault in Settings, so it is unchanged. Wire: `settings.test.cjs`
  ("the notes folder is Settings' vaultDir, else JESSTER_VAULT ..."), red with JESSTER_VAULT unread.
- The inbox's bridge repository is Settings' new `inbox.repo` (today's `secondbrain-bridge` URL the default; empty
  means the default): Connect clones the one Settings names (`inbox.cjs` `connect`, `main.cjs`). The inbox stays off
  until connected (Steward ADR-0020, ExecPlan 0006 P1, audit B3). Wire: `inbox.test.cjs` ("the inbox's bridge
  repository is Settings' inbox.repo ..."), red with Connect cloning the constant.
- The updater reads its releases from Settings' new `update.repo` (owner/name; `thebrotherscarr-bit/Jesster`, today's,
  the default), at every check, and holds downloads to that repository's release assets (`updater.cjs` `useRepo`,
  `repo`, `downloadPrefix`; `main.cjs` hands Settings' value over); a value that is not owner/name is not used (Steward
  ADR-0020, ExecPlan 0006 P1, audit B2). Wire: `settings.test.cjs` ("the updater's repository is Settings'
  update.repo ..."), red with `repo()` ignoring Settings.
- Claude's check of a Steward turn names the system's owner from Settings' new `owner` (`'Kyle'`, today's, the
  default), in its instructions and in the turn it reads (`agent/checker.cjs` `system(owner)`, `transcript(turn,
  owner)`), instead of a name written into the prompt (Steward ADR-0020, ExecPlan 0006 P1, audit B1). Wire:
  `checker.test.cjs` ("the check names the system's owner from Settings' owner ..."), red with the instructions built
  without it.
- The Estate's repositories are Settings' new `estate` entry (`atlas`, `jesster`, `steward`, each relative to the ground
  or absolute), today's layout (`atlas`, `worlds/jesster`, `worlds/steward`) the default, for both the door's worlds
  (`door/index.cjs` `worldsFor`) and the Estate's versions (`agent/workflows.cjs` `estateRepos`) (Steward ADR-0020,
  ExecPlan 0006 P1, audit A4). A name Settings leaves out keeps its default; the door reads it when it builds its
  worlds. Wire: `door/index.test.cjs` ("the Estate's folders are Settings' estate entry ..."), red with the door
  ignoring the layout.
- `ollama.exe` is found in Settings' `services.ollama.exe` (new, `''` by default), then `%LOCALAPPDATA%\Programs\Ollama`
  (today's, unchanged here), then the first `ollama` on PATH; when none has it, the Servers shelf says all three places
  (Steward ADR-0020, ExecPlan 0006 P1, audit A13). Wire: `services.test.cjs` ("ollama.exe is Settings'
  services.ollama.exe, else ..."), red with the Settings lookup taken out.
- Every Steward process SecondBrain starts (his service, his MCP door, his AG-UI host) is handed SecondBrain's MCP URL
  and share key in its environment, `SECONDBRAIN_SHARE_URL` and `SECONDBRAIN_SHARE_KEY`, only while sharing is on, so a
  new install needs no key pasted into Steward's `.env` by hand (Steward ADR-0020, ExecPlan 0006 P1, audit D9 and E2).
  Other names than his `.env`'s `SECONDBRAIN_MCP_URL` and `SECONDBRAIN_MCP_KEY`, so where his `.env` sets those they
  still win (python-dotenv never overrides the process environment): this PC is unchanged. Steward reads the new names
  once his side lands (Lane A). Wire: `agent.test.cjs` ("every Steward process SecondBrain starts is handed the share
  URL and key ..."), red with `childEnv()` left out of the child's environment.
- Steward's Python is his venv's `Scripts\python.exe` (today's, and first), else its `bin/python`, so a venv built
  off Windows starts too (Steward ADR-0020, ExecPlan 0006 P1, audit D3). Wire: `agent.test.cjs` ("Steward's Python is
  the venv's Scripts\python.exe, else its bin/python"), red when `venvPython` returns only the Windows path.
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
