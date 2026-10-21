# -*- coding: utf-8 -*-
"""
PROVENANCE — every save of every note, on a Jesster chain.

The vault keeps its own chain at <vault>/.jesster/notes.jsonl, built by the
estate's links.Chain — the same five keys, the same walk, the same Merkle
wraps of forty. It is a separate file: notes never land on the estate chain.

  sealed  (default) the link holds H(note file). The chain proves the note
          existed, in exactly those bytes, on that date — and reveals nothing.
  open    the link holds the note file itself. Prior art the moment it lands.
  off     nothing is deposited.

Each version cites the link of the version before it, so a note's history is
a walk backwards through its own citations.
"""
import contextlib
import os
import sys
import time

NAME = "provenance"
CHAIN_FILE = "notes.jsonl"
LOCK_FILE = "notes.jsonl.lock"
LOCK_STALE = 30          # seconds; a lock older than this was left by a crash

_CHAIN_DIR = os.path.join(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))), "chain")
if _CHAIN_DIR not in sys.path:
    sys.path.insert(0, _CHAIN_DIR)

import links                                          # noqa: E402


def register(k):
    from kernel import KernelError, digest

    state = {"chain": None, "last": None, "seen": None}
    path = os.path.join(k.vault.meta, CHAIN_FILE)

    def stamp():
        try:
            st = os.stat(path)
            return (st.st_size, st.st_mtime_ns)
        except OSError:
            return None

    def chain():
        """The chain, re-read if another process appended since we last
        looked — otherwise our next link would weld onto a stale head and
        fork the chain."""
        if state["chain"] is None or stamp() != state["seen"]:
            state["chain"] = links.Chain(path)
            state["last"] = None
            state["seen"] = stamp()
        return state["chain"]

    @contextlib.contextmanager
    def locked():
        """One writer at a time across processes: the server, the CLI and an
        MCP agent may all hold the same vault open."""
        lock = os.path.join(k.vault.meta, LOCK_FILE)
        deadline = time.time() + LOCK_STALE
        while True:
            try:
                fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                break
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(lock) > LOCK_STALE:
                        os.unlink(lock)
                        continue
                except OSError:
                    continue
                if time.time() > deadline:
                    raise KernelError("chain_busy", "another process has held the "
                                      "chain lock for %ds (%s)" % (LOCK_STALE, lock))
                time.sleep(0.05)
        try:
            yield
        finally:
            with contextlib.suppress(OSError):
                os.unlink(lock)

    def note_of(e):
        """The note id rides in `says` as 'note <id> ...', so a stranger can
        read it without this module."""
        says = e["payload"]["says"]
        return says.split(" ", 2)[1] if says.startswith("note ") else None

    def last():
        """note id -> (count, hash of its latest link). Built once by one walk
        and moved on every deposit, so a big import is not quadratic."""
        if state["last"] is None:
            idx = {}
            for e in chain().entries("link"):
                nid = note_of(e)
                if nid:
                    idx[nid] = (idx.get(nid, (0, None))[0] + 1, e["hash"])
            state["last"] = idx
        return state["last"]

    def history(nid):
        """Links about one note, oldest first."""
        return [e for e in chain().entries("link") if note_of(e) == nid]

    def deposit(note, raw, created=False, removed=False):
        mode = k.config.get("provenance") or links.SEALED
        if mode == "off":
            return None
        actor = (k.config.get("actor") or "").strip()
        if not actor:
            raise KernelError(
                "no_actor", "provenance needs a name on every deposit. Set "
                "one: `notes init --actor <name>`, or set provenance to off.")
        with locked():
            c = chain()
            count, prev = last().get(note["id"], (0, None))
            verb = "removed" if removed else ("created" if created else
                                              "v%d" % (count + 1))
            says = "note %s %s — %s" % (note["id"], verb, note["title"])
            e = c.deposit(raw, mode, says, actor, cites=[prev] if prev else None)
            state["seen"] = stamp()
            last()[note["id"]] = (count + 1, e["hash"])
            return e

    k.on("note.saved", lambda note, raw, created: deposit(note, raw, created))
    k.on("note.removed", lambda note: deposit(
        note, "removed:" + note["hash"], removed=True))

    S = {"type": "string"}

    @k.method("provenance.history", "Every chain link for one note, oldest first.",
              {"id": S}, ["id"])
    def hist(id):
        return [{"n": e["payload"]["n"], "ts": e["ts"], "says": e["payload"]["says"],
                 "mode": e["payload"]["mode"], "hash": e["hash"],
                 "actor": e["actor"]} for e in history(id)]

    @k.method("provenance.check", "Does the note on disk match its last deposit?",
              {"id": S}, ["id"])
    def check(id):
        n = k.note(id)
        with open(k.vault.path(id), "r", encoding="utf-8") as f:
            raw = f.read()
        h = history(id)
        if not h:
            return {"id": id, "witnessed": False,
                    "detail": "no deposit for this note yet"}
        last = h[-1]["payload"]
        held = last["doc"] if last["mode"] == links.SEALED else digest(last["doc"])
        ok = held == digest(raw)
        return {"id": id, "witnessed": ok, "link": last["n"], "hash": n["hash"],
                "detail": "matches link %d" % last["n"] if ok else
                "changed since link %d — edited outside the kernel" % last["n"]}

    @k.method("provenance.witness", "Deposit a note's current bytes now "
              "(for notes edited outside the kernel).", {"id": S}, ["id"])
    def witness(id):
        n = k.note(id)
        with open(k.vault.path(id), "r", encoding="utf-8") as f:
            raw = f.read()
        e = deposit(n, raw)
        return {"id": id, "link": e["payload"]["n"] if e else None,
                "hash": e["hash"] if e else None}

    @k.method("provenance.verify", "Walk the vault's whole chain.")
    def verify():
        ok, n, detail = chain().verify()
        return {"intact": ok, "links": n, "head": chain().head(),
                "wraps": chain().tokens(), "detail": detail}
