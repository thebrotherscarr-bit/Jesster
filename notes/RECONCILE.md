# Reconciling secondbrain-local with Jesster Notes

> **Historical (2026-10-23).** SecondBrain is now in this repo at
> `secondbrain/` and uses the kernel over `/rpc`; `serve` serves its build.
> Embeddings are `index.embed` and `index.search`. The steps below are kept
> as the record of how it was brought over.

The `secondbrain-local---ollama-gpt-oss` project lives on a Windows desktop
and was not reachable from the session that built this kernel. The kernel
already covers what its name says: local notes and Ollama with `gpt-oss`.
What is left is to map secondbrain's own data and features onto it. These
steps do that, on the machine that has the folder.

## 1. Bring the notes over

If secondbrain keeps notes as Markdown or text files:

```powershell
python notes\cli.py init --actor "<your name>"
python notes\cli.py import "C:\Users\novad\Desktop\secondbrain-local---ollama-gpt-oss\<notes folder>" -t secondbrain
```

If it keeps them as JSON (a list of `{title, body|content|text, tags}`):

```powershell
python notes\cli.py import "<path>\notes.json" -t secondbrain
```

Imports are idempotent: a note whose body already exists is skipped. Every
imported note is deposited on the vault's chain.

If it keeps them in SQLite or another store, export them to one of those two
shapes, or add a method to `plugins/importer.py` that reads it.

## 2. Map the features with REA

[REA](https://github.com/morluto/rea) is registered in `../.mcp.json` as an
MCP server, so an agent opened in this repo can use it. Install REA and
register it with your agents:

```powershell
npx rea-agents setup
```

On Windows, if `npx` won't start as an MCP command, register it through `cmd`:

```powershell
claude mcp add --scope local rea -- cmd.exe /d /c npx -y rea-agents@6.7.0 mcp
```

Then open Claude Code in this repo and ask:

> Use REA to analyze `C:\Users\novad\Desktop\secondbrain-local---ollama-gpt-oss`.
> List its features, data model, storage and Ollama prompts, with evidence.
> Then map each one onto `notes/kernel.py` methods and plugins. Implement
> anything missing as a plugin, add a proof to `notes/prove_notes.py`, and
> keep the plugin standard-library only.

For a JavaScript or Electron build, the terminal works too:

```powershell
npx -y rea-agents@latest analyze-javascript-application "C:\Users\novad\Desktop\secondbrain-local---ollama-gpt-oss" --json
```

If you have the source rather than a build, an agent can read it directly.
REA is for when there are only binaries or bundles.

## 3. Where secondbrain features land

| secondbrain does | it lands as |
|---|---|
| chat or ask over notes with gpt-oss | `llm.ask`: already here |
| summaries or auto-tags | `llm.summarize`, `llm.suggest_tags`: already here |
| embeddings / vector search | `index.embed`, `index.search` (`plugins/index.py`, `nomic-embed-text`): already here |
| its own UI | secondbrain's UI (`../secondbrain`), served by `serve` and talking to `POST /rpc`: already here |
| its own API | `serve` (HTTP JSON-RPC), `rpc` (stdio) or `mcp` |
| its prompts | the `SYSTEM` strings in `plugins/ollama.py` |
