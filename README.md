# SecondBrain Local — Ollama GPT-OSS

A private, local-first "second brain" note-taking and knowledge-synthesis app.
Vite + React + Tailwind front end, packaged as a standalone Windows desktop
executable. **All inference runs on your own machine through Ollama — nothing
is sent to a cloud API.** There is no API key, no account, and no telemetry.
Fonts are bundled locally, so the packaged app is fully offline.

The app talks to your local Ollama daemon at `http://localhost:11434` and
defaults to the `gpt-oss:20b` model.

---

## Run the packaged app

Double-click the desktop shortcut **SecondBrain**, or launch the binary directly:

```
dist-desktop\SecondBrain-win32-x64\SecondBrain.exe
```

This is a real Electron build. It serves its own files from
`http://127.0.0.1:43110` and needs no dev server running. The port is fixed on
purpose: Chromium keys `localStorage` by origin, so a random port would make the
app lose all notes on every launch. Notes persist in
`%APPDATA%\SecondBrain`. Each Electron launch clears only the cached app shell,
so a rebuilt `.exe` shows the new UI immediately while the notes in
`localStorage` are left untouched.

**Requirements:** the Ollama daemon must be running, with the model pulled:

```powershell
ollama serve                 # if Ollama desktop is not already running
ollama pull gpt-oss:20b
```

If the browser/app cannot reach Ollama (a CORS-style "connection refused"
error in the UI), start the daemon with origins allowed:

```powershell
$env:OLLAMA_ORIGINS = "*"
ollama serve
```

> The packaged Electron app uses a loopback origin, which Ollama allows by
> default. `OLLAMA_ORIGINS="*"` is mainly needed when opening the PWA from a
> non-local address.

## Run in development

```powershell
npm install --legacy-peer-deps   # vite@8 vs tsx's esbuild peer pin needs this
npm run dev                      # http://localhost:3000
```

## Verify the code

```powershell
npm run lint                     # TypeScript, no emit
npm test                         # note model + Ollama prompt/stream helpers
npm run verify                   # lint + tests + production build
```

The tests cover note filtering/sorting, RAG context selection, JSON import
normalization, all five prompt modes, and the offline demo responses. A live
Ollama check is separate because it needs the daemon and the model:

```powershell
ollama list                      # confirm gpt-oss:20b is present
```

## Rebuild the executable

```powershell
npm run build                    # vite build -> dist\
npm run package:win              # build + electron-packager -> dist-desktop\
```

**One-time step after a fresh `npm install`:** npm's script policy blocks
Electron's postinstall, so the Electron runtime is not downloaded and
`node_modules\electron\dist\` stays empty. Fix it with:

```powershell
node node_modules\electron\install.js
```

Without it, the packaged `electron.exe` is zero length.

---

## How it is put together

| piece | what it does |
|---|---|
| `src\App.tsx` | app shell, tab routing, state, auto-reconnecting Ollama probe |
| `src\components\` | sidebar, note list, editor, graph, Ask Brain, modals |
| `src\utils\ollama.ts` | connection check, streaming queries, prompt templates, simulation fallback |
| `src\utils\notes.ts` | note model, tag/link/graph helpers, import normalization |
| `src\utils\markdown.ts` | Markdown rendering with DOMPurify sanitization |
| `electron\main.cjs` | Electron entry point — serves the build over a stable loopback origin |
| `vite.config.ts` | Vite + React + Tailwind + PWA service worker |

**Why the Electron main process serves over HTTP instead of `file://`:** a
`file://` page has an opaque `null` origin, and the app's `fetch()` calls to
`http://localhost:11434` are refused by CORS. Serving the build from
`http://127.0.0.1:<port>` gives the page a real origin, so Ollama answers it
and localStorage and the service worker behave normally.

**Why the port is fixed:** localStorage is scoped to the full origin,
including the port. Serving each launch on a random port gave the app a fresh,
empty storage bucket every time. `SECONDBRAIN_PORT` can override the port, but
changing it also changes the storage origin.

## Behavior notes

- When Ollama is offline, **Ask Brain** and the editor's AI actions use clearly
  labeled canned demo text rather than pretending a local model answered.
  Configure Ollama to get answers grounded in your notes.
- `gpt-oss:20b` is a reasoning model. The app streams its final answer; the
  model may spend several seconds — or longer on slower hardware — thinking
  first. Requests keep the model resident for 10 minutes so repeated questions
  do not pay a reload penalty.
- The Windows button in the header now points to the real packaged Electron
  build and the PWA install path. It does not generate a fake browser-launcher
  `.exe`.
- Imported JSON is normalized: unknown fields are dropped and missing fields
  get safe defaults, so a hand-edited backup cannot crash the note list.
- Note content and model output are sanitized before being rendered as HTML.
- The packaged `app.asar` includes `node_modules` whose code is already bundled
  into `dist\assets`. It can be slimmed, but it works as-is.
- The app can also be installed as a PWA from Edge/Chrome ("Install
  SecondBrain" in the desktop modal) for a taskbar-pinned, standalone-window
  version.
