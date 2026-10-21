# -*- coding: utf-8 -*-
"""
LIVE — what the open window is showing, and what changed under it.

Every save and removal moves a sequence number. A UI polls live.poll with the
last number it saw and gets back the notes that changed since, plus any
commands queued for it (open a note, show a message). Another caller — the
CLI, an agent over MCP, a collaborator over the bridge — can see what the
window has open (live.focus) and point it somewhere (live.send).

All in memory: a restart starts the sequence over, and a UI that sees the
number go backwards simply reloads.
"""
import time

NAME = "live"
KEEP = 500          # changes and commands remembered


def register(k):
    from kernel import KernelError

    st = {"seq": 0, "changes": [], "commands": [], "focus": {}, "boot": int(time.time())}

    def bump(nid, what):
        st["seq"] += 1
        st["changes"].append((st["seq"], nid, what))
        del st["changes"][:-KEEP]

    k.on("note.saved", lambda note, raw, created: bump(note["id"], "saved"))
    k.on("note.removed", lambda note: bump(note["id"], "removed"))

    S = {"type": "string"}

    @k.method("live.poll", "Notes changed and commands queued since `since`.",
              {"since": {"type": "integer"}, "boot": {"type": "integer"}})
    def poll(since=0, boot=None):
        reset = boot is not None and boot != st["boot"]
        # a caller that fell behind what is remembered must reload in full
        missed = bool(st["changes"]) and since < st["changes"][0][0] - 1
        return {
            "seq": st["seq"], "boot": st["boot"],
            "reload": reset or missed,
            "changed": sorted({nid for s, nid, _ in st["changes"] if s > since}),
            "commands": [c for c in st["commands"] if c["seq"] > since],
        }

    @k.method("live.report", "The UI says what it has open.",
              {"note": S, "view": S, "title": S})
    def report(note=None, view=None, title=None):
        st["focus"] = {"note": note, "view": view, "title": title,
                       "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        return {"ok": True}

    @k.method("live.focus", "What the open window is showing right now.")
    def focus():
        return st["focus"] or {"note": None, "detail": "no window has reported yet"}

    @k.method("live.send", "Point the open window: open a note, or show a message.",
              {"action": dict(S, enum=["open", "message"]), "id": S, "text": S},
              ["action"])
    def send(action, id=None, text=None):
        if action == "open":
            k.note(id)
        elif action == "message" and not (text or "").strip():
            raise KernelError("bad_params", "a message needs text")
        elif action not in ("open", "message"):
            raise KernelError("bad_params", "action is open or message")
        st["seq"] += 1
        st["commands"].append({"seq": st["seq"], "action": action, "id": id,
                               "text": text})
        del st["commands"][:-KEEP]
        return {"queued": st["seq"]}
