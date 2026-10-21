# Jesster Notes: microkernel, CLI and PWA

A local notes system built on Jesster's provenance chain. Notes are plain
Markdown files that you own. Every save is deposited on a Jesster chain inside
the vault. A local model (Ollama, `gpt-oss` by default) answers questions from
your notes, and nothing leaves the machine.

It is built to be embedded. One small kernel answers every caller through the
same door, so any other system can use it as its notes plugin.

```
                 ┌──────────── surfaces ────────────┐
   you ── CLI ──►│                                  │
   PWA ── HTTP ─►│  Kernel.call(method, params)     │◄── plugins (register(kernel))
   host ── RPC ─►│    registry · event bus · vault  │      provenance → chain/links.py
  agent ── MCP ─►│                                  │      ollama     → gpt-oss, loopback
                 └──────────────┬───────────────────┘      importer   → folders, JSON
                                │
                <vault>/*.md   <vault>/.jesster/notes.jsonl   (the vault's own chain)
```

| file | what it is |
|---|---|
| `kernel.py` | the vault, the method registry, the event bus and the core `notes.*` methods |
| `plugins/provenance.py` | deposits every save on the vault's chain (sealed by default) |
| `plugins/ollama.py` | `llm.ask`, `llm.summarize`, `llm.suggest_tags` against local Ollama |
| `plugins/importer.py` | `import.folder` and `import.json` to bring notes in from other tools |
| `cli.py` | the command line, plus `serve`, `rpc` and `mcp` |
| `serve.py` | HTTP: `/rpc` and the PWA in `../pwa` |
| `stdio.py` | JSON-RPC 2.0 and MCP on stdio |
| `prove_notes.py` | the proof suite (also run in CI) |

Standard library only. Python 3.9 or newer.

## Start

```bash
python notes/cli.py init --actor "<your name>"     # vault at ~/JessterNotes
python notes/cli.py new "First note" -t idea --body "links to [[Second]]"
python notes/cli.py find idea
python notes/cli.py serve                          # open http://localhost:8765
```

`--vault <dir>` or `JESSTER_VAULT` chooses the vault. For the model, run
`ollama pull gpt-oss:20b` and then `ollama serve`. To change model or host:
`init --model <name> --ollama http://127.0.0.1:11434`.

## Provenance

The vault's chain is `<vault>/.jesster/notes.jsonl`. It is built by
`chain/links.py` with the same five keys and the same walk as the estate chain,
but it is a separate file. The estate's `chain.jsonl` is never touched.

- **sealed** (default): the link holds the SHA-256 of the note file. It proves
  the note existed, byte for byte, on that date, without revealing it.
- **open**: the link holds the note itself.
- **off**: nothing is deposited.

Each version cites the version before it. `history <id>` walks those links,
and `verify` walks the whole chain. `call provenance.check '{"id":"..."}'`
says whether the file on disk still matches its last deposit. Edits made in
another editor are caught, and `provenance.witness` deposits them.

## Embedding it as a notes plugin

| host | how |
|---|---|
| any language | `python notes/cli.py rpc`: JSON-RPC 2.0, one message per line on stdio |
| web or remote | `python notes/cli.py serve`: `POST /rpc` with the same messages |
| agents (Claude Code, Codex, Cursor) | `python notes/cli.py mcp`: every method is an MCP tool (`notes_create`, `llm_ask`, …). Registered in `../.mcp.json`. |
| Python | `from kernel import open_kernel; k = open_kernel(path); k.call("notes.search", {"q": "x"})` |

`kernel.methods` lists every method with its JSON Schema. A host can pass its
own plugin list to `Kernel(root, config, plugins=[...])`. A plugin is a module
with `NAME` and `register(kernel)`, which uses `kernel.method(...)` to add
methods and `kernel.on("note.saved", fn)` to listen for events.

Serving beyond loopback needs a token (`--token` or `JESSTER_NOTES_TOKEN`).
The server refuses a foreign `Host` header and any body that isn't
`application/json`.

## The PWA

`../pwa` is served by `serve` at `/`. It is installable and opens offline. It
keeps a copy of your notes in IndexedDB, and saves made offline are sent when
the kernel is back. A queued edit is refused rather than merged if the note
changed elsewhere in the meantime. It has search, tags, `[[wikilinks]]` and
backlinks, a Markdown preview, chain status and per-note history, and **Ask**
for the local model.

## Running it on Windows

Double-click `start-secondbrain.cmd` in the repo root. The first run builds
the UI (`secondbrain/`) and makes a vault at `%USERPROFILE%\JessterNotes`.
Then it serves the app at http://localhost:8765 and opens it. You need git,
Node.js 22 and Python 3.12 on PATH.

## Updating

When the app's branch on GitHub has new commits, an **Update** button shows
in the header. It fast-forwards this copy, rebuilds the UI if that changed,
restarts the server, and reloads the page. The CLI does the same with
`python notes/cli.py update`. A copy with local commits or edited files is
never overwritten: the update is refused and says why.

## Live: other processes and the open window

The server notices notes written by other processes (the CLI, an MCP agent,
another editor) within about a second, and the open window reloads them.
Chain writes take a lock that works across processes, so two writers never
fork the chain.

- `live.focus`: what the window has open right now
- `live.send {"action":"open","id":...}` or `{"action":"message","text":...}`:
  point the window at a note, or show a message banner

## The bridge: working on a running vault from elsewhere

A collaborator who can't connect to your desktop directly (a cloud agent,
another machine) can still reach it through GitHub. Requests and replies
travel as files in a **private** repository; see `bridge.py`.

1. Create a private, empty repo (e.g. `secondbrain-bridge`) with a README so
   it has a branch, and clone it next to your vault.
2. `python notes/cli.py init --bridge <path-to-that-clone>`. From then on,
   `serve` also runs the bridge worker, using your normal git credentials.
3. The collaborator clones the same repo and runs
   `python notes/bridge.py send <clone> notes.search '{"q":"..."}'`.

Over the bridge, `system.update` and anything that imports from local paths
are refused unless you list them in the vault config's `bridge_allow`
(`<vault>/.jesster/config.json`). Replies carry your notes, which is why the
repo has to be private.

## Bringing in secondbrain-local (Ollama, gpt-oss)

See [`RECONCILE.md`](RECONCILE.md).
