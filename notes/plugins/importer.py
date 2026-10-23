# -*- coding: utf-8 -*-
"""
IMPORTER — bring notes in from another tool.

  import.folder  a folder of .md / .markdown / .txt files, walked recursively.
                 Front matter title and tags are kept; otherwise the first
                 '# heading' or the file name is the title. The sub-folder
                 path becomes a tag, so a folder tree survives as tags.
  import.json    a JSON export: a list of objects (or {"notes": [...]}) with
                 title / body|content|text / tags. secondbrain's own backup
                 (Export in its sidebar) is read in full: its ids, PARA
                 category, pin and createdAt/updatedAt are all kept.

A note whose exact body is already in the vault is skipped, so running an
import twice is safe. Every imported note goes through notes.create, so it is
deposited on the vault's chain like any other.
"""
import json
import os

NAME = "importer"
EXTS = (".md", ".markdown", ".txt")
SKIP_DIRS = {".git", ".jesster", "node_modules", ".obsidian", ".trash", "__pycache__"}


def register(k):
    from kernel import KernelError, parse, slugify

    def seen():
        return {n["body"].strip() for n in k.vault.notes.values()}

    def put(title, body, tags, have, stats, **extra):
        if body.strip() in have:
            stats["skipped"] += 1
            return
        nid = extra.pop("id", None)
        if isinstance(nid, str) and nid.lower() == nid and nid not in k.vault.notes:
            try:
                k.vault.path(nid)                  # a valid id is kept as is
                extra["id"] = nid
            except KernelError:
                pass
        params = {"title": title, "body": body, "tags": tags}
        params.update({key: v for key, v in extra.items() if v is not None})
        k.call("notes.create", params)
        have.add(body.strip())
        stats["imported"] += 1

    S = {"type": "string"}

    @k.method("import.folder", "Import a folder of Markdown/text notes.",
              {"path": S, "tag": S}, ["path"])
    def folder(path, tag=None):
        root = os.path.abspath(os.path.expanduser(path))
        if not os.path.isdir(root):
            raise KernelError("not_found", "no folder at %s" % root)
        try:
            nested = os.path.commonpath([root, k.vault.root]) in (root, k.vault.root)
        except ValueError:                     # different drives on Windows
            nested = False
        if nested:
            raise KernelError("bad_params", "import from outside the vault, "
                              "not into or from inside it")
        have, stats = seen(), {"imported": 0, "skipped": 0, "failed": []}
        for d, dirs, files in os.walk(root):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
            rel = os.path.relpath(d, root)
            folder_tags = [] if rel == "." else [
                slugify(p) for p in rel.replace("\\", "/").split("/")]
            for name in sorted(files):
                if not name.lower().endswith(EXTS):
                    continue
                p = os.path.join(d, name)
                try:
                    with open(p, "r", encoding="utf-8-sig") as f:
                        meta, body = parse(f.read().replace("\r\n", "\n"))
                except (OSError, UnicodeDecodeError) as e:
                    stats["failed"].append("%s: %s" % (p, e))
                    continue
                title = meta.get("title")
                if not title:
                    first = body.lstrip().split("\n", 1)[0]
                    title = (first[2:].strip() if first.startswith("# ")
                             else os.path.splitext(name)[0])
                tags = list(meta.get("tags") or []) + folder_tags
                if tag:
                    tags.append(tag)
                put(title, body, tags, have, stats)
        return stats

    @k.method("import.json", "Import a JSON export of notes.",
              {"path": S, "tag": S}, ["path"])
    def from_json(path, tag=None):
        p = os.path.abspath(os.path.expanduser(path))
        try:
            with open(p, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
        except (OSError, ValueError) as e:
            raise KernelError("bad_params", "cannot read %s: %s" % (p, e))
        items = data.get("notes", []) if isinstance(data, dict) else data
        have, stats = seen(), {"imported": 0, "skipped": 0, "failed": []}
        for i, it in enumerate(items if isinstance(items, list) else []):
            if not isinstance(it, dict):
                stats["failed"].append("item %d is not an object" % i)
                continue
            body = it.get("body") or it.get("content") or it.get("text") or ""
            title = it.get("title") or it.get("name") or body.strip()[:60] or "untitled"
            tags = it.get("tags") or []
            if isinstance(tags, str):
                tags = tags.split(",")
            when = {f: it.get(f) for f in ("createdAt", "updatedAt")
                    if isinstance(it.get(f), (int, float)) and not isinstance(it.get(f), bool)}
            try:
                put(str(title), str(body), list(tags) + ([tag] if tag else []),
                    have, stats, id=it.get("id"), category=it.get("category"),
                    pinned=it.get("isPinned", it.get("pinned")) is True,
                    created=when.get("createdAt"),
                    updated=when.get("updatedAt", when.get("createdAt")))
            except KernelError as e:
                stats["failed"].append("item %d: %s" % (i, e))
        return stats
