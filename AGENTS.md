# Working in this repo

Instructions for AI coding agents (Steward himself, and any other hand) working in the Jesster repository
(SecondBrain, the Estate's center).

**Key Documentation:**
- [Steward docs/README.md](https://github.com/thebrotherscarr-bit/Steward/blob/main/docs/README.md) - The Estate's doc
  map and doc standard: which document is for what
- [Steward docs/ARCHITECTURE.md](https://github.com/thebrotherscarr-bit/Steward/blob/main/docs/ARCHITECTURE.md) - The
  Estate as it is now: parts, wires (ports, protocols), data, flows, rules, plan
- [Steward docs/decisions/](https://github.com/thebrotherscarr-bit/Steward/tree/main/docs/decisions) - The decision
  records (MAF's ADR format); 0004 makes Jesster the center
- [secondbrain/README.md](secondbrain/README.md) and [notes/README.md](notes/README.md) - The app and the kernel

## The doc standard (2026-11-05)

The design of the whole Estate lives in Steward's `docs/` (the operator, 2026-11-05: "make this the standard moving
forward, this way nothing gets misaligned"). For a change here:

- **A decision** (a part, a wire, a port, a protocol, a store of data, a rule) gets an ADR in Steward's
  `docs/decisions/` before it is built, and Steward's `docs/ARCHITECTURE.md` is updated when the shape moves.
- **A feature's design** gets a spec in Steward's `docs/specs/` (MAF's spec template) before it is built.
- **A multi-step build** gets an ExecPlan in Steward's `docs/plans/`, written to Steward's `.agent/PLANS.md`.
- What lands here is described in this repository's pull request and README; older docs are annotated with a dated
  pointer, never rewritten or deleted.

Jesster holds three things. Keep them separate:

- `chain/`, `docs/`, `repo-updater/`, `rules/`: the estate's provenance chain
  and doctrine. Don't edit `chain/chain.jsonl` or `docs/` unless asked.
- `notes/`: the notes microkernel (Python, standard library only), its
  plugins, CLI, HTTP server, MCP server, model gateway and git bridge.
  Overview in `notes/README.md`.
- `secondbrain/`: the UI (React + Vite PWA, optional Electron). When served by
  `python notes/cli.py serve` it stores notes through the kernel.

## Prove before you push

```bash
python notes/prove_notes.py              # the kernel: must end in PROVEN
python repo-updater/prove_repo_update.py
cd secondbrain && npm run lint && npm test && npm run build
```

`npm ci` in `secondbrain/` needs `--legacy-peer-deps --ignore-scripts`.

Every command carries a hard time limit (added 2026-11-05), for example:

```bash
timeout 600 python notes/prove_notes.py
cd secondbrain && timeout 300 npm run lint && timeout 900 npm test && timeout 600 npm run build
```

`npm run verify` is lint, test and build in one; the `secondbrain` workflow runs the same steps on every pull request.

## Rules

- `notes/` stays standard-library Python. A plugin is a module with `NAME`
  and `register(kernel)`; add its methods with `kernel.method(...)` and its
  proofs to `notes/prove_notes.py`.
- Every surface (CLI, HTTP `/rpc`, stdio, MCP, bridge) calls `Kernel.call`.
  Don't write vault files directly.
- Never commit a vault (`~/JessterNotes`), exports, `.env` files or keys.
- The `Update` button fast-forwards users' copies from this branch, so what
  you push is what runs on their desktop. Push only proven work.

## Talking to the user's live vault

With the `jesster-notes` MCP server (in `opencode.json` / `.mcp.json`), you
work on the same vault the user has open:

- `context_now` / `context_for`: what they're working on, and a briefing
  for a question
- `index_search`: find passages across notes and imported chats
- `notes_*`: read and write notes
- `live_focus`: which note their window shows; `live_send`: open a note
  there, or show a message
