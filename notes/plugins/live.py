# -*- coding: utf-8 -*-
"""
LIVE — what the open window is showing, and what changed under it.

Every save and removal moves a sequence number. A UI polls live.poll with the
last number it saw and gets back the notes that changed since, plus any
commands queued for it (open a note, show a message). Another caller — the
CLI, an agent over MCP, a collaborator over the bridge — can see what the
window has open (live.focus) and point it somewhere (live.send).

Commands and focus are small files in <vault>/.jesster, because the caller
is often a different process from the server the window talks to. Changes
are in memory: a restart starts the sequence over, and a UI that sees the
boot number change simply reloads.
"""
import json
import os
import time

NAME = "live"
KEEP = 500          # changes remembered in memory
COMMANDS = "live-commands.jsonl"
FOCUS = "live-focus.json"
COMMAND_TTL = 120   # seconds; a command nobody picked up by then is dropped


def register(k):
    from kernel import KernelError

    st = {"seq": 0, "changes": [], "boot": int(time.time() * 1000) % 2_000_000_000}
    cmd_path = os.path.join(k.vault.meta, COMMANDS)
    focus_path = os.path.join(k.vault.meta, FOCUS)

    def bump(nid, what):
        st["seq"] += 1
        st["changes"].append((st["seq"], nid, what))
        del st["changes"][:-KEEP]

    k.on("note.saved", lambda note, raw, created: bump(note["id"], "saved"))
    k.on("note.removed", lambda note: bump(note["id"], "removed"))
    k.on("notes.external", lambda ids: [bump(i, "external") for i in ids])

    def take_commands():
        """Hand queued commands to the window once, then clear the file."""
        try:
            with open(cmd_path, "r", encoding="utf-8") as f:
                cmds = [json.loads(l) for l in f if l.strip()]
            os.unlink(cmd_path)
        except (OSError, ValueError):
            return []
        now = time.time()
        return [c for c in cmds if now - c.get("t", now) < COMMAND_TTL]

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
            "commands": take_commands(),
        }

    @k.method("live.report", "The UI says what it has open.",
              {"note": S, "view": S, "title": S})
    def report(note=None, view=None, title=None):
        focus = {"note": note, "view": view, "title": title,
                 "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        tmp = focus_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(focus, f, ensure_ascii=False)
        os.replace(tmp, focus_path)
        return {"ok": True}

    @k.method("live.focus", "What the open window is showing right now.")
    def focus():
        try:
            with open(focus_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {"note": None, "detail": "no window has reported yet"}

    @k.method("live.send", "Point the open window: open a note, or show a message.",
              {"action": dict(S, enum=["open", "message"]), "id": S, "text": S},
              ["action"])
    def send(action, id=None, text=None):
        if action == "open":
            k.note(id)
        elif action == "message":
            if not (text or "").strip():
                raise KernelError("bad_params", "a message needs text")
        else:
            raise KernelError("bad_params", "action is open or message")
        cmd = {"action": action, "id": id, "text": text, "t": time.time()}
        with open(cmd_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(cmd, ensure_ascii=False) + "\n")
        return {"queued": True}
