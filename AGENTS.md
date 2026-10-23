# Working in this repo

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
