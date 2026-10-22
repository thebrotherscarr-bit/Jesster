# -*- coding: utf-8 -*-
"""
CONTEXT — what you are working on, ready to hand to any model.

  context.now      the notes and conversations touched lately, newest first
  context.for      a block for a prompt: what you are working on, plus the
                   passages in the vault most relevant to a question
  capture.append   log one exchange with a model into the vault — a note per
                   source per day, so a day's work with a tool reads as one page

The gateway (serve.py) uses context.for to brief every model you talk to
through it and capture.append to remember what was said. Agents on MCP can
call both directly.
"""
import re
import time

NAME = "context"
BUDGET = 6000            # characters handed to a model by default
NOW_DAYS = 7


def register(k):
    from kernel import KernelError, slugify

    def quiet(n):
        """Not current work: dug-up archive notes, the digger's write-ups, and
        whatever sits on the archives shelf, except chats (those are work)."""
        tags = set(n["tags"])
        if tags & {"archive", "distilled"}:
            return True
        return n["category"] == "archives" and "chat" not in tags

    def recent(days, limit):
        cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
        notes = [n for n in k.vault.notes.values()
                 if n["updated"][:10] >= cutoff and not quiet(n)]
        notes.sort(key=lambda n: n["updated"], reverse=True)
        return notes[:limit]

    def line(n):
        first = re.sub(r"\s+", " ", re.sub(r"^>.*$|^#+.*$", "", n["body"], flags=re.M)).strip()
        return "- %s (%s; %s)%s" % (n["title"], n["category"], n["updated"][:10],
                                    (": " + first[:140]) if first else "")

    def now_text(days, limit):
        items = recent(days, limit)
        if not items:
            return "", []
        tags = {}
        for n in items:
            for t in n["tags"]:
                if t not in ("chat", "capture"):
                    tags[t] = tags.get(t, 0) + 1
        top = ", ".join(t for t, _ in sorted(tags.items(), key=lambda x: -x[1])[:8])
        text = "Recently worked on (last %d days):\n%s" % (days, "\n".join(line(n) for n in items))
        if top:
            text += "\nRecurring topics: %s" % top
        return text, items

    S = {"type": "string"}
    I = {"type": "integer"}

    @k.method("context.now", "What the user has been working on lately.",
              {"days": I, "limit": I})
    def m_now(days=NOW_DAYS, limit=12):
        text, items = now_text(days, limit)
        return {"text": text or "Nothing touched in the last %d days." % days,
                "notes": [n["id"] for n in items]}

    def context_for(q, budget=BUDGET, days=NOW_DAYS):
        now, items = now_text(days, 8)
        parts, used, sources = [], 0, []
        if now:
            now = now[: budget // 3]
            parts.append(now)
            used += len(now)
        if q and k.index_search:
            hits = k.index_search(q, limit=12)["results"]
            rel = []
            for h in hits:
                piece = "[%s] %s\n%s" % (h["note"], h["title"], h["text"])
                if used + len(piece) > budget:
                    piece = piece[: max(0, budget - used)]
                if len(piece) < 200:
                    break
                rel.append(piece)
                used += len(piece)
                sources.append(h["note"])
            if rel:
                parts.append("Relevant notes and past conversations:\n\n" + "\n\n---\n\n".join(rel))
        text = "\n\n".join(parts)
        return {"text": text, "sources": list(dict.fromkeys(sources)),
                "recent": [n["id"] for n in items]}

    k.context_for = context_for

    @k.method("context.for", "A briefing for a model: what the user is working on, "
              "plus the passages most relevant to `q`.",
              {"q": S, "budget": I, "days": I})
    def m_for(q="", budget=BUDGET, days=NOW_DAYS):
        return context_for(q, budget, days)

    @k.method("capture.append", "Remember one exchange with a model: appended to "
              "today's capture note for that source.",
              {"source": S, "user": S, "assistant": S, "model": S}, ["source"])
    def capture(source, user="", assistant="", model=None):
        if not (user or assistant).strip():
            raise KernelError("bad_params", "nothing to capture")
        day = time.strftime("%Y-%m-%d")
        src = slugify(source)[:24]
        nid = "capture-%s-%s" % (day, src)
        stamp = time.strftime("%H:%M")
        entry = "### %s%s\n\n**You:** %s\n\n**%s:** %s\n" % (
            stamp, (" · " + model) if model else "", (user or "").strip(),
            model or source, (assistant or "").strip())
        n = k.vault.notes.get(nid)
        if n:
            k.call("notes.update", {"id": nid, "body": n["body"].rstrip() + "\n\n" + entry})
        else:
            k.call("notes.create", {"id": nid, "title": "%s — %s" % (source, day),
                                    "body": entry, "tags": ["capture", src],
                                    "category": "inbox"})
        return {"note": nid}
