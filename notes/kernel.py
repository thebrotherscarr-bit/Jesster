#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KERNEL — the notes microkernel. Small on purpose.

The kernel owns three things and nothing else:

    the vault     a folder of plain Markdown files. Yours, readable without
                  this program, portable to any other notes tool.
    the registry  named methods with input schemas. Every surface — the CLI,
                  the PWA over HTTP, JSON-RPC on stdio, MCP for agents — calls
                  the same methods through the same door: Kernel.call().
    the bus       events. "note.saved", "note.removed". Plugins listen.

Everything else is a plugin: provenance (Jesster's chain), the language model
(Ollama, gpt-oss by default), importers. A plugin is a module with a
register(kernel) function. The kernel never imports a plugin by name; it is
handed them, so a host system can load exactly the ones it wants.

PROVENANCE. Every save is deposited on the vault's own chain —
<vault>/.jesster/notes.jsonl — the same five-key recipe as the estate's chain,
walked by the same links.Chain. SEALED by default: the chain holds the hash of
the note, never its words, so a vault can be proven without being read. Each
version cites the one before it. The estate's chain.jsonl is never touched.

Standard library only.
"""
import hashlib
import json
import os
import re
import sys
import threading
import time

VERSION = "0.1.0"
NOTE_EXT = ".md"
META_DIR = ".jesster"
TRASH_DIR = "trash"
CONFIG_NAME = "config.json"

DEFAULT_CONFIG = {
    "actor": "",                       # the NAME on every deposit; required
    "provenance": "sealed",            # "sealed" | "open" | "off"
    "ollama_url": "http://127.0.0.1:11434",
    "model": "gpt-oss:20b",
}

# PARA — secondbrain's shelves. Any slug is allowed; these are the usual ones.
CATEGORIES = ("projects", "areas", "resources", "archives", "inbox")
DEFAULT_CATEGORY = "inbox"

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]")
_TOKEN = re.compile(r"[a-z0-9]{2,}")
# words that say nothing about what a note is about; never scored in a query
STOP = frozenset("""a an and are as at be by did do does for from had has have
how i in is it its me my of on or so that the this to was we were what when
where which who why will with you your""".split())


class KernelError(Exception):
    """A refusal with a code. Surfaces turn it into their own error shape."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------------
# NOTES ON DISK — Markdown with a small front matter block.
# --------------------------------------------------------------------------

def slugify(text):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s[:48].strip("-") or "note"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse(raw):
    """Split front matter from body. Tolerant: a file with no front matter is
    a note whose body is the whole file — that is how imports arrive."""
    meta = {}
    body = raw
    if raw.startswith("---\n"):
        end = raw.find("\n---", 4)
        if end != -1:
            head = raw[4:end]
            body = raw[end + 4:].lstrip("\n")
            for line in head.splitlines():
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                k, v = k.strip(), v.strip()
                if k == "tags":
                    v = [t.strip().strip("'\"")
                         for t in v.strip("[]").split(",") if t.strip()]
                elif len(v) >= 2 and v[0] == v[-1] == '"':
                    try:
                        v = json.loads(v)          # how render() writes titles
                    except ValueError:
                        v = v[1:-1]
                elif len(v) >= 2 and v[0] == v[-1] == "'":
                    v = v[1:-1]
                meta[k] = v
    return meta, body


def render(note):
    """The file form of a note. Keys in a fixed order, so the bytes — and so
    the hash on the chain — depend on the note and nothing else."""
    tags = ", ".join(note.get("tags") or [])
    title = (note.get("title") or "").replace("\n", " ")
    return ("---\nid: %s\ntitle: %s\ncategory: %s\npinned: %s\ntags: [%s]\n"
            "created: %s\nupdated: %s\n---\n\n%s"
            % (note["id"], json.dumps(title, ensure_ascii=False),
               note.get("category") or DEFAULT_CATEGORY,
               "true" if note.get("pinned") else "false",
               tags, note["created"], note["updated"], note.get("body") or ""))


def _clean_category(c):
    c = slugify(c) if c else DEFAULT_CATEGORY
    return DEFAULT_CATEGORY if c == "note" else c


def _stamp(v, field):
    """A caller-supplied time (imports keep their dates): ISO-8601 text, or
    epoch milliseconds the way secondbrain stores them."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(v / 1000.0))
    if isinstance(v, str) and re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d", v):
        return v.strip()
    raise KernelError("bad_params", "%s is ISO-8601 text or epoch ms, not %r"
                      % (field, v))


def _clean_tags(tags):
    if isinstance(tags, str):
        tags = tags.split(",")
    out = []
    for t in tags or []:
        t = re.sub(r"[^\w/-]+", "", str(t).strip().lstrip("#").lower())
        if t and t not in out:
            out.append(t)
    return out


def tokens(text):
    return _TOKEN.findall((text or "").lower())


# --------------------------------------------------------------------------
# THE VAULT
# --------------------------------------------------------------------------

class Vault:
    """A folder of notes. The disk is the truth; the index is a cache of it,
    rebuilt on open, so a file edited by another program is never lost."""

    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.meta = os.path.join(self.root, META_DIR)
        os.makedirs(self.meta, exist_ok=True)
        self.notes = {}
        self._stat = {}                      # id -> (mtime_ns, size) as last read or written
        self.reload()

    def path(self, nid):
        if not _ID_RE.match(nid or ""):
            raise KernelError("bad_id", "not a note id: %r" % (nid,))
        return os.path.join(self.root, nid + NOTE_EXT)

    def _ids_on_disk(self):
        out = {}
        for e in os.scandir(self.root):
            if e.name.endswith(NOTE_EXT) and e.is_file():
                nid = e.name[:-len(NOTE_EXT)]
                if _ID_RE.match(nid):
                    st = e.stat()
                    out[nid] = (st.st_mtime_ns, st.st_size)
        return out

    def reload(self):
        self.notes, self._stat = {}, {}
        for nid in sorted(self._ids_on_disk()):
            self.notes[nid] = self._read(nid)

    def rescan(self):
        """Pick up what other processes did — the CLI, an MCP agent, another
        editor. Returns the ids that appeared, changed or went away."""
        disk = self._ids_on_disk()
        changed = []
        for nid, st in disk.items():
            if self._stat.get(nid) != st:
                self.notes[nid] = self._read(nid)
                changed.append(nid)
        for nid in [n for n in self.notes if n not in disk]:
            del self.notes[nid]
            self._stat.pop(nid, None)
            changed.append(nid)
        return sorted(changed)

    def _read(self, nid):
        p = self.path(nid)
        with open(p, "r", encoding="utf-8") as f:
            raw = f.read()
        meta, body = parse(raw)
        st = os.stat(p)
        self._stat[nid] = (st.st_mtime_ns, st.st_size)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(st.st_mtime))
        return {
            "id": nid,
            "title": meta.get("title") or nid.replace("-", " "),
            "tags": _clean_tags(meta.get("tags")),
            "category": _clean_category(meta.get("category")),
            "pinned": str(meta.get("pinned", "")).lower() == "true",
            "created": meta.get("created") or stamp,
            "updated": meta.get("updated") or stamp,
            "body": body,
            "hash": digest(raw),
        }

    def fresh_id(self, title):
        base = slugify(title)
        nid, k = base, 2
        while nid in self.notes or os.path.exists(self.path(nid)):
            nid = "%s-%d" % (base[:44], k)
            k += 1
        return nid

    def write(self, note):
        raw = render(note)
        p = self.path(note["id"])
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(raw)
        os.replace(tmp, p)                   # never a half-written note
        st = os.stat(p)
        self._stat[note["id"]] = (st.st_mtime_ns, st.st_size)
        note = dict(note, hash=digest(raw))
        self.notes[note["id"]] = note
        return note, raw

    def remove(self, nid):
        """Removed notes are moved aside, never destroyed."""
        p = self.path(nid)
        trash = os.path.join(self.meta, TRASH_DIR)
        os.makedirs(trash, exist_ok=True)
        dest = os.path.join(trash, "%s.%d%s" % (nid, int(time.time()), NOTE_EXT))
        os.replace(p, dest)
        self._stat.pop(nid, None)
        return self.notes.pop(nid), dest


# --------------------------------------------------------------------------
# THE KERNEL
# --------------------------------------------------------------------------

class Kernel:
    def __init__(self, vault_root, config=None, plugins=()):
        self.vault = Vault(vault_root)
        self.config = dict(DEFAULT_CONFIG)
        self.config.update(self._load_config())
        self.config.update({k: v for k, v in (config or {}).items()
                            if v is not None})
        self.methods = {}
        self.listeners = {}
        self.plugins = []
        self.restart_requested = False     # set by system.update; the server re-executes
        self._scanned = 0.0
        self.searcher = None               # the index plugin puts a better search here
        self.index_search = None           # passage-level search, when indexed
        self._lock = threading.RLock()       # one caller in the vault at a time
        _core(self)
        for p in plugins:
            self.load(p)

    # -- config ------------------------------------------------------------

    def _config_path(self):
        return os.path.join(self.vault.meta, CONFIG_NAME)

    def _load_config(self):
        try:
            with open(self._config_path(), "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def save_config(self, **changes):
        cfg = self._load_config()
        cfg.update({k: v for k, v in changes.items() if v is not None})
        with open(self._config_path(), "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        self.config.update(cfg)
        return cfg

    # -- the registry --------------------------------------------------------

    def method(self, name, doc, params=None, required=()):
        """Decorator: put a method in the registry. `params` is a JSON Schema
        properties map — the same schema MCP advertises to agents."""
        def put(fn):
            self.methods[name] = {
                "fn": fn, "doc": doc,
                "schema": {"type": "object",
                           "properties": params or {},
                           "required": list(required)},
            }
            return fn
        return put

    def on(self, event, fn):
        self.listeners.setdefault(event, []).append(fn)

    def emit(self, event, **data):
        for fn in self.listeners.get(event, []):
            fn(**data)

    def load(self, plugin):
        """A plugin is anything with register(kernel) and a NAME."""
        plugin.register(self)
        self.plugins.append(getattr(plugin, "NAME", plugin.__name__))

    def call(self, name, params=None):
        m = self.methods.get(name)
        if not m:
            raise KernelError("no_method", "no method %r" % name)
        params = params or {}
        if not isinstance(params, dict):
            raise KernelError("bad_params", "params must be an object")
        missing = [k for k in m["schema"]["required"] if k not in params]
        if missing:
            raise KernelError("bad_params", "%s needs %s" % (name, ", ".join(missing)))
        known = m["schema"]["properties"]
        extra = [k for k in params if k not in known]
        if extra:
            raise KernelError("bad_params", "%s does not take %s"
                              % (name, ", ".join(extra)))
        with self._lock:
            self.sync_disk()
            return m["fn"](**params)

    def sync_disk(self, every=1.0):
        """At most once a second, notice notes other processes wrote."""
        t = time.monotonic()
        if t - self._scanned < every:
            return []
        self._scanned = t
        changed = self.vault.rescan()
        if changed:
            self.emit("notes.external", ids=changed)
        return changed

    def catalog(self):
        return [{"name": n, "doc": m["doc"], "schema": m["schema"]}
                for n, m in sorted(self.methods.items())]

    # -- what the core methods share ------------------------------------------

    def note(self, nid):
        n = self.vault.notes.get(nid)
        if not n:
            raise KernelError("not_found", "no note %r" % nid)
        return n

    def search(self, q, limit=20, tag=None, category=None, pinned=None):
        """Plain term scoring: title hits weigh triple, body hits are damped
        by length so a long note does not win on size alone."""
        terms = [t for t in tokens(q) if t not in STOP] or tokens(q)
        if terms and self.searcher:
            return [dict(summary(n), score=s) for s, n in
                    self.searcher(q, limit=limit, tag=tag, category=category, pinned=pinned)]
        out = []
        for n in self.vault.notes.values():
            if tag and tag not in n["tags"]:
                continue
            if category and n["category"] != category:
                continue
            if pinned is not None and n["pinned"] != bool(pinned):
                continue
            if not terms:
                out.append((0, n))
                continue
            title = tokens(n["title"]) + n["tags"]
            body = tokens(n["body"])
            score = 0.0
            for t in terms:
                score += 3 * title.count(t)
                score += body.count(t) / (1 + len(body) / 400.0)
            if score > 0:
                out.append((score, n))
        out.sort(key=lambda sn: sn[1]["updated"], reverse=True)
        out.sort(key=lambda sn: -sn[0])            # stable: ties stay newest-first
        return [dict(summary(n), score=round(s, 3)) for s, n in out[:limit]]


def summary(n):
    body = n["body"].strip()
    return {"id": n["id"], "title": n["title"], "tags": n["tags"],
            "category": n["category"], "pinned": n["pinned"],
            "updated": n["updated"], "excerpt": body[:160]}


def links_of(body):
    return sorted({slugify(m.group(1)) for m in _WIKILINK.finditer(body or "")})


# --------------------------------------------------------------------------
# THE CORE METHODS — notes in, notes out. Everything else is a plugin.
# --------------------------------------------------------------------------

def _core(k):
    S = {"type": "string"}
    B = {"type": "boolean"}
    TAGS = {"type": "array", "items": {"type": "string"}}
    CAT = dict(S, description="PARA shelf: %s (default %s)"
               % (", ".join(CATEGORIES), DEFAULT_CATEGORY))
    WHEN = {"type": ["string", "number"],
            "description": "ISO-8601, or epoch milliseconds"}

    @k.method("kernel.info", "Version, vault, loaded plugins and note count.")
    def info():
        return {"version": VERSION, "vault": k.vault.root,
                "notes": len(k.vault.notes), "plugins": list(k.plugins),
                "actor": k.config.get("actor"),
                "provenance": k.config.get("provenance")}

    @k.method("kernel.methods", "Every method this kernel answers, with schemas.")
    def methods():
        return k.catalog()

    @k.method("notes.list", "List notes, newest first, by tag, shelf or pin.",
              {"tag": S, "category": CAT, "pinned": B, "limit": {"type": "integer"}})
    def list_(tag=None, category=None, pinned=None, limit=200):
        return k.search("", limit=limit, tag=tag, category=category, pinned=pinned)

    @k.method("notes.dump", "Every note in full — what a UI loads at start.",
              {"exclude_tags": dict(TAGS, description="leave out notes with any of "
                                    "these tags (imported chats can number thousands)")})
    def dump(exclude_tags=None):
        skip = set(exclude_tags or ())
        return sorted((n for n in k.vault.notes.values() if not skip & set(n["tags"])),
                      key=lambda n: n["updated"], reverse=True)

    @k.method("notes.get", "One note in full, with the notes linking to it.",
              {"id": S}, ["id"])
    def get(id):
        n = dict(k.note(id))
        n["links"] = links_of(n["body"])
        n["backlinks"] = sorted(o["id"] for o in k.vault.notes.values()
                                if id in links_of(o["body"]) and o["id"] != id)
        return n

    @k.method("notes.create", "Write a new note.",
              {"title": S, "body": S, "tags": TAGS, "id": S, "category": CAT,
               "pinned": B, "created": WHEN, "updated": WHEN}, ["title"])
    def create(title, body="", tags=None, id=None, category=None, pinned=False,
               created=None, updated=None):
        if id and (id in k.vault.notes):
            raise KernelError("exists", "note %r already exists" % id)
        stamp = now()
        c = _stamp(created, "created") if created is not None else stamp
        n = {"id": id or k.vault.fresh_id(title), "title": title.strip() or "untitled",
             "tags": _clean_tags(tags), "body": body,
             "category": _clean_category(category), "pinned": bool(pinned),
             "created": c,
             "updated": _stamp(updated, "updated") if updated is not None else
             (c if created is not None else stamp)}
        n, raw = k.vault.write(n)
        k.emit("note.saved", note=n, raw=raw, created=True)
        return summary(n) | {"hash": n["hash"]}

    @k.method("notes.update", "Change a note's title, body or tags.",
              {"id": S, "title": S, "body": S, "tags": TAGS, "category": CAT,
               "pinned": B,
               "base": dict(S, description="hash you edited from; refused if "
                            "the note changed since")}, ["id"])
    def update(id, title=None, body=None, tags=None, category=None, pinned=None,
               base=None):
        old = k.note(id)
        if base and base != old["hash"]:
            raise KernelError("conflict", "note %r changed since %s"
                              % (id, base[:12]))
        n = dict(old)
        if title is not None:
            n["title"] = title.strip() or old["title"]
        if body is not None:
            n["body"] = body
        if tags is not None:
            n["tags"] = _clean_tags(tags)
        if category is not None:
            n["category"] = _clean_category(category)
        if pinned is not None:
            n["pinned"] = bool(pinned)
        fields = ("title", "body", "tags", "category", "pinned")
        if all(n[f] == old[f] for f in fields):
            return summary(old) | {"hash": old["hash"], "unchanged": True}
        n["updated"] = now()
        n, raw = k.vault.write(n)
        k.emit("note.saved", note=n, raw=raw, created=False)
        return summary(n) | {"hash": n["hash"]}

    @k.method("notes.remove", "Move a note to the vault's trash.",
              {"id": S}, ["id"])
    def remove(id):
        k.note(id)
        n, dest = k.vault.remove(id)
        k.emit("note.removed", note=n)
        return {"id": id, "trash": dest}

    @k.method("notes.search", "Search titles, tags and bodies.",
              {"q": S, "tag": S, "category": CAT, "pinned": B,
               "limit": {"type": "integer"}}, ["q"])
    def search(q, tag=None, category=None, pinned=None, limit=20):
        return k.search(q, limit=limit, tag=tag, category=category, pinned=pinned)

    @k.method("notes.stats", "Counts: notes, words, tags, and notes per shelf.")
    def stats():
        shelves = dict.fromkeys(CATEGORIES, 0)
        words, tags = 0, set()
        for n in k.vault.notes.values():
            shelves[n["category"]] = shelves.get(n["category"], 0) + 1
            words += len(n["body"].split())
            tags.update(n["tags"])
        return {"notes": len(k.vault.notes), "words": words, "tags": len(tags),
                "shelves": shelves}

    @k.method("notes.tags", "Every tag with its note count.")
    def tags():
        out = {}
        for n in k.vault.notes.values():
            for t in n["tags"]:
                out[t] = out.get(t, 0) + 1
        return dict(sorted(out.items()))

    @k.method("notes.reload", "Re-read the vault from disk.")
    def reload():
        k.vault.reload()
        return {"notes": len(k.vault.notes)}


# --------------------------------------------------------------------------

def default_plugins():
    """The plugins a stock vault runs with. A host can pass its own list."""
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    from plugins import (provenance, index, ollama, importer, ingest, context,
                         live, system, archive)
    return [provenance, index, ollama, importer, ingest, context, live, system,
            archive]


def open_kernel(vault_root, config=None, plugins=None):
    return Kernel(vault_root, config,
                  default_plugins() if plugins is None else plugins)
