# -*- coding: utf-8 -*-
"""
OLLAMA — a local language model over the vault. gpt-oss by default.

Nothing leaves the machine: the kernel talks to Ollama on loopback
(config `ollama_url`, default http://127.0.0.1:11434). Answers are grounded in
the notes the kernel's own search finds, and every answer names the notes it
was given, so a reader can check the model against the source.

The model writes nothing. Its answers come back to the caller; saving one as
a note is the caller's choice, through notes.create, like any other note.
"""
import json
import urllib.error
import urllib.request

NAME = "ollama"
CONTEXT_CHARS = 6000          # per note, so one long note cannot crowd the rest
TIMEOUT = 300

SYSTEM = ("You answer from the user's own notes. Use only the notes given. "
          "Cite a note by its id in square brackets, like [note-id]. If the "
          "notes do not hold the answer, say so plainly.")


def register(k):
    from kernel import KernelError

    def post(path, body=None):
        url = k.config["ollama_url"].rstrip("/") + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url, data=data, headers={"Content-Type": "application/json"},
            method="POST" if data else "GET")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise KernelError("llm_unreachable", "Ollama at %s did not answer "
                              "(%s). Is `ollama serve` running?"
                              % (k.config["ollama_url"], e))

    def chat(system, user, model=None):
        r = post("/api/chat", {
            "model": model or k.config["model"], "stream": False,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}]})
        return (r.get("message") or {}).get("content", "").strip()

    def context(ids):
        parts = []
        for nid in ids:
            n = k.note(nid)
            parts.append("### [%s] %s\n%s" % (n["id"], n["title"],
                                             n["body"][:CONTEXT_CHARS]))
        return "\n\n".join(parts)

    S = {"type": "string"}

    @k.method("llm.models", "Models the local Ollama has pulled.")
    def models():
        return [m.get("name") for m in post("/api/tags").get("models", [])]

    @k.method("llm.ask", "Ask a question; answered from the most relevant notes.",
              {"q": S, "k": {"type": "integer"}, "model": S}, ["q"])
    def ask(q, model=None, **kw):              # "k" would shadow the kernel
        n = kw.get("k") or 5
        hits = [h["id"] for h in k.search(q, limit=n)]
        if not hits:
            return {"answer": "No note matches that question.", "sources": []}
        answer = chat(SYSTEM, "Notes:\n\n%s\n\nQuestion: %s" % (context(hits), q),
                      model)
        return {"answer": answer, "sources": hits}

    @k.method("llm.summarize", "Summarize one note in a few lines.",
              {"id": S, "model": S}, ["id"])
    def summarize(id, model=None):
        return {"id": id, "summary": chat(
            "Summarize the note in at most five short lines.", context([id]),
            model)}

    @k.method("llm.suggest_tags", "Suggest tags for a note (nothing is saved).",
              {"id": S, "model": S}, ["id"])
    def suggest_tags(id, model=None):
        out = chat("Reply with 3 to 6 lowercase single-word tags for the note, "
                   "comma separated, nothing else.", context([id]), model)
        return {"id": id, "tags": [t.strip().strip("#").lower()
                                   for t in out.split(",") if t.strip()][:6]}
