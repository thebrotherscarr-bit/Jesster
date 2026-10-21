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

KEEP_ALIVE = "10m"            # keep gpt-oss:20b loaded between questions (secondbrain)
TEMPERATURE = 0.3

SYSTEM = ("You answer from the user's own notes. Use only the notes given. "
          "Cite a note by its id in square brackets, like [note-id]. If the "
          "notes do not hold the answer, say so plainly.")


# secondbrain's prompt modes, carried over word for word so its answers keep
# their shape whichever surface asks.
BRAIN_SYSTEM = (
    "You are the local intelligence layer for the user's private Second Brain "
    "knowledge base.\nYou run locally and privately on the user's desktop "
    "hardware via Ollama (GPT-OSS 20B).\nYour answers must be clear, concise, "
    "objective, and deeply grounded in the provided notes.\nDo not hallucinate "
    "facts outside the provided notes. Always cite which note or source title "
    "informed each point.")

MODES = {
    "summarize": (
        "Distill the following note into:\n"
        "1. Executive Summary (1-2 sentences capturing the core thesis)\n"
        "2. Key Insights (3-5 bullet points)\n"
        "3. One provocative takeaway or next question to explore\n\n"
        "NOTE CONTENT:\n{content}\n\nSummary:"),
    "action_items": (
        "Extract every action item, task, deadline, and commitment from the "
        "following note.\nFormat them as an interactive Markdown checklist using "
        "\"- [ ] Task description (context / priority)\".\nGroup them logically "
        "by priority or category if there are several. If no explicit tasks "
        "exist, suggest 2-3 logical next steps based on the note's ideas.\n\n"
        "NOTE CONTENT:\n{content}\n\nAction Checklist:"),
    "connect": (
        "Analyze the following note from the user's Second Brain.\nIdentify:\n"
        "1. Core Conceptual Pillars (3-4 themes)\n"
        "2. Recommended Tags (prefixed with #)\n"
        "3. Suggested cross-links to potential projects, areas, or mental models\n"
        "4. Potential gaps or counter-arguments worth researching\n\n"
        "NOTE CONTENT:\n{content}\n\nKnowledge Connections:"),
    "expand": (
        "Act as a thought partner. Take the ideas in the note below and expand "
        "on them:\n1. Deeper Nuance: 2 practical real-world implications or edge "
        "cases\n2. First-Principles Angle: How would someone challenge the "
        "fundamental assumptions?\n3. Actionable Experiment: One micro-experiment "
        "the user can run this week to test these concepts.\n\n"
        "NOTE CONTENT:\n{content}\n\nExpanded Perspective:"),
}


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
            "keep_alive": KEEP_ALIVE, "options": {"temperature": TEMPERATURE},
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

    @k.method("llm.brain", "secondbrain's note tools: summarize, action_items, "
              "connect or expand one note.",
              {"id": S, "mode": dict(S, enum=sorted(MODES)), "model": S},
              ["id", "mode"])
    def brain(id, mode, model=None):
        if mode not in MODES:
            raise KernelError("bad_params", "mode is one of %s" % ", ".join(sorted(MODES)))
        n = k.note(id)
        content = "# %s\n\n%s" % (n["title"], n["body"][:CONTEXT_CHARS])
        return {"id": id, "mode": mode,
                "text": chat(BRAIN_SYSTEM, MODES[mode].format(content=content), model)}

    @k.method("llm.suggest_tags", "Suggest tags for a note (nothing is saved).",
              {"id": S, "model": S}, ["id"])
    def suggest_tags(id, model=None):
        out = chat("Reply with 3 to 6 lowercase single-word tags for the note, "
                   "comma separated, nothing else.", context([id]), model)
        return {"id": id, "tags": [t.strip().strip("#").lower()
                                   for t in out.split(",") if t.strip()][:6]}
