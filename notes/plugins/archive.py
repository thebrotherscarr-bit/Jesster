# -*- coding: utf-8 -*-
"""
ARCHIVE — dig the whole history of the work into notes, then distill it.

Two stages, both safe to stop and run again:

  dig       every source on the list (archive.sources) comes in as raw notes
            tagged `archive`:
              chat exports, Claude Code sessions, audio   through ingest.path
              Markdown and text notes                     through import.folder
              git history       one note per repository per month
              docs and code     one note per file, from folders and zips
            A ledger (<vault>/.jesster/archive-ledger.json) remembers what was
            read, so a second dig only reads what changed.

  distill   the raw notes, oldest first, a chunk per step, go to the local
            model (gpt-oss by default) with Ollama's JSON-schema `format`. It
            returns topics, decisions (with the why), ideas, open threads and
            dated events, each citing the note it came from. They are merged
            into <vault>/.jesster/distill.json, so a run resumes where it
            stopped. One call does `steps` chunks; to pause, stop calling.

  write     the distilled notes: one per topic (archive-topic-<slug>), and
            archive-timeline, archive-decisions, archive-ideas,
            archive-open-threads and archive-overview. Each links back to its
            sources as [[note-id]]. Writing again updates them in place.

Nothing leaves the machine: the model is Ollama on loopback. The sources are
read, never changed.
"""
import hashlib
import json
import os
import re
import subprocess
import time
import zipfile

NAME = "archive"
RAW_TAG = "archive"
DONE_TAG = "distilled"
DEFAULT_TAGS = ("archive", "chat", "transcript")
LEDGER = "archive-ledger.json"
STATE = "distill.json"
CHUNK = 6000                 # characters of raw notes per model call (config archive_chunk)
MAX_FILE = 256 * 1024        # a doc or code file bigger than this is cut
MAX_BODY = 40000             # characters kept in one raw note
MAX_FILES = 5000             # docs and code files read from one source
MAX_POINTS = 200             # summary points kept per topic
TIMEOUT = 600

DOC_EXT = {
    ".py": "python", ".js": "js", ".mjs": "js", ".cjs": "js", ".ts": "ts",
    ".tsx": "tsx", ".jsx": "jsx", ".ps1": "powershell", ".sh": "bash",
    ".bat": "bat", ".cmd": "bat", ".cs": "csharp", ".java": "java", ".go": "go",
    ".rs": "rust", ".c": "c", ".h": "c", ".cpp": "cpp", ".css": "css",
    ".sql": "sql", ".html": "html", ".htm": "html", ".yaml": "yaml",
    ".yml": "yaml", ".toml": "toml", ".ini": "ini", ".cfg": "ini",
    ".rst": "rst", ".csv": "csv", ".log": "text",
}
SKIP_DIRS = {".git", ".jesster", "node_modules", "__pycache__", ".venv", "venv",
             "dist", "build", ".next", ".cache"}

SYSTEM = (
    "You read Kyle's development archive one piece at a time, oldest first: "
    "chats with AI models, notes, documents, code and git history. From the "
    "piece you are given, pull out:\n"
    "- topics: the projects, components and ideas it is about. Reuse a known "
    "topic's exact name when the piece is about it; name a new one only when "
    "it is truly new. Give each a one-sentence summary of what this piece "
    "adds.\n"
    "- decisions: what was decided, and why.\n"
    "- ideas: things proposed or imagined, not yet built.\n"
    "- threads: open questions and todos left hanging; mark done=true when "
    "the piece shows an earlier one finished.\n"
    "- events: dated things that happened (YYYY-MM-DD).\n"
    "Cite the source note id exactly as given in square brackets. Use only "
    "what the piece says. Empty lists are fine.")

ITEM = {"type": "object"}
SCHEMA = {
    "type": "object",
    "properties": {
        "topics": {"type": "array", "items": dict(ITEM, properties={
            "name": {"type": "string"}, "summary": {"type": "string"},
            "source": {"type": "string"}}, required=["name", "summary"])},
        "decisions": {"type": "array", "items": dict(ITEM, properties={
            "text": {"type": "string"}, "why": {"type": "string"},
            "topic": {"type": "string"}, "date": {"type": "string"},
            "source": {"type": "string"}}, required=["text"])},
        "ideas": {"type": "array", "items": dict(ITEM, properties={
            "text": {"type": "string"}, "topic": {"type": "string"},
            "source": {"type": "string"}}, required=["text"])},
        "threads": {"type": "array", "items": dict(ITEM, properties={
            "text": {"type": "string"}, "topic": {"type": "string"},
            "done": {"type": "boolean"}, "source": {"type": "string"}},
            required=["text"])},
        "events": {"type": "array", "items": dict(ITEM, properties={
            "date": {"type": "string"}, "text": {"type": "string"},
            "topic": {"type": "string"}, "source": {"type": "string"}},
            required=["date", "text"])},
    },
    "required": ["topics", "decisions", "ideas", "threads", "events"],
}


def _sha(data):
    return hashlib.sha1(data).hexdigest()


def _norm(text):
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t))


def git_log(repo):
    """Every commit of a repository, oldest first."""
    sep, end = "\x1f", "\x1e"
    r = subprocess.run(
        ["git", "-C", repo, "log", "--reverse", "--date=iso-strict", "--name-only",
         "--format=" + end + "%H" + sep + "%ad" + sep + "%an" + sep + "%s" + sep + "%b" + sep],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=TIMEOUT)
    if r.returncode != 0:
        raise ValueError((r.stderr or "git log failed").strip()[-300:])
    out = []
    for rec in r.stdout.split(end)[1:]:
        parts = rec.split(sep)
        if len(parts) < 6:
            continue
        h, date, who, subject, body, files = parts[:6]
        out.append({"hash": h, "date": date.strip(), "author": who, "subject": subject,
                    "body": body.strip(), "files": [f for f in files.split("\n") if f.strip()]})
    return out


def git_month_body(repo_name, month, commits):
    lines = ["> git history of `%s`, %s: %d commits" % (repo_name, month, len(commits)), ""]
    for c in commits:
        lines.append("### %s · %s" % (c["date"][:16].replace("T", " "), c["subject"]))
        lines.append("`%s` by %s" % (c["hash"][:9], c["author"]))
        if c["body"]:
            lines.append("")
            lines.append(c["body"][:2000])
        if c["files"]:
            shown = c["files"][:30]
            more = len(c["files"]) - len(shown)
            lines.append("")
            lines.append("files: " + ", ".join(shown) + (" (+%d more)" % more if more > 0 else ""))
        lines.append("")
    return "\n".join(lines)[:MAX_BODY]


def file_body(rel, ext, text):
    text = text[:MAX_BODY]
    if ext in (".html", ".htm"):
        text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", text)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"[ \t]+", " ", text)
        return "> from `%s`\n\n%s\n" % (rel, text.strip())
    return "> from `%s`\n\n```%s\n%s\n```\n" % (rel, DOC_EXT[ext], text.rstrip())


def register(k):
    from kernel import KernelError, slugify

    def meta_path(name):
        return os.path.join(k.vault.meta, name)

    def load(name, default):
        try:
            with open(meta_path(name), "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return default

    def save(name, obj):
        p = meta_path(name)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        os.replace(tmp, p)

    def put(nid, title, body, tags, created, stats, category="archives"):
        have = k.vault.notes.get(nid)
        if have:
            if have["body"] == body:
                stats["skipped"] += 1
                return
            k.call("notes.update", {"id": nid, "body": body, "title": title})
            stats["updated"] += 1
            return
        params = {"id": nid, "title": title, "body": body, "tags": tags,
                  "category": category}
        if created:
            params["created"] = created
        try:
            k.call("notes.create", params)
        except KernelError as e:
            if e.code != "bad_params" or "created" not in params:
                raise
            params.pop("created")
            k.call("notes.create", params)
        stats["created"] += 1

    # -- dig ------------------------------------------------------------------

    def dig_git(repo, ledger, stats):
        name = os.path.basename(os.path.abspath(repo)) or "repo"
        r = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=60)
        head = (r.stdout or "").strip()
        key = "git:" + os.path.abspath(repo)
        if head and ledger.get(key) == head:
            stats["unchanged"] += 1
            return
        try:
            commits = git_log(repo)
        except (ValueError, OSError, subprocess.SubprocessError) as e:
            stats["failed"].append("%s: %s" % (repo, e))
            return
        months = {}
        for c in commits:
            months.setdefault(c["date"][:7], []).append(c)
        for month, cs in sorted(months.items()):
            nid = "archive-git-%s-%s" % (slugify(name)[:40], month)
            put(nid, "Git: %s, %s" % (name, month), git_month_body(name, month, cs),
                [RAW_TAG, "git", slugify(name)], cs[0]["date"], stats)
        stats["repos"] += 1
        if head:
            ledger[key] = head

    def dig_file(rel, data, mtime, label, ledger, stats):
        ext = os.path.splitext(rel)[1].lower()
        key = "file:%s:%s" % (label, rel)
        h = _sha(data)
        if ledger.get(key) == h:
            stats["unchanged"] += 1
            return
        text = data[:MAX_FILE].decode("utf-8", "replace")
        if "\x00" in text[:2000]:
            return                                         # binary after all
        nid = "archive-file-%s" % _sha((label + "/" + rel).encode("utf-8"))[:12]
        put(nid, "File: %s" % rel.replace("\\", "/"), file_body(rel, ext, text),
            [RAW_TAG, "file", DOC_EXT[ext].replace("text", "log")],
            _iso(mtime) if mtime else None, stats)
        stats["files"] += 1
        ledger[key] = h

    def dig_folder(root, ledger, stats):
        label = os.path.basename(root)
        count = 0
        for d, dirs, files in os.walk(root):
            if ".git" in dirs:
                dig_git(d, ledger, stats)
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
            for f in sorted(files):
                p = os.path.join(d, f)
                low = f.lower()
                if low.endswith(".zip"):
                    dig_zip(p, ledger, stats)
                    continue
                if os.path.splitext(low)[1] not in DOC_EXT:
                    continue
                if count >= MAX_FILES:
                    stats["failed"].append("%s: more than %d docs and code files; "
                                           "the rest were left" % (root, MAX_FILES))
                    return
                count += 1
                try:
                    with open(p, "rb") as fh:
                        data = fh.read(MAX_FILE + 1)
                    dig_file(os.path.relpath(p, root), data, os.path.getmtime(p),
                             label, ledger, stats)
                except OSError as e:
                    stats["failed"].append("%s: %s" % (p, e))

    def dig_zip(path, ledger, stats):
        label = os.path.basename(path)
        try:
            z = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, OSError) as e:
            stats["failed"].append("%s: %s" % (path, e))
            return
        with z:
            count = 0
            for info in z.infolist():
                name = info.filename
                parts = set(name.replace("\\", "/").split("/")[:-1])
                if info.is_dir() or parts & SKIP_DIRS:
                    continue
                if os.path.splitext(name.lower())[1] not in DOC_EXT:
                    continue
                if count >= MAX_FILES:
                    break
                count += 1
                y, mo, dd, hh, mi, ss = info.date_time
                mtime = time.mktime((y, mo, dd, hh, mi, ss, 0, 0, -1))
                with z.open(info) as fh:
                    dig_file(name, fh.read(MAX_FILE + 1), mtime, label, ledger, stats)

    def dig_one(path, ledger):
        p = os.path.abspath(os.path.expanduser(path))
        if not os.path.exists(p):
            raise KernelError("not_found", "nothing at %s" % p)
        stats = {"path": p, "created": 0, "updated": 0, "skipped": 0, "unchanged": 0,
                 "repos": 0, "files": 0, "chats": None, "failed": []}
        if "ingest.path" in k.methods:
            # chats, transcripts, and Markdown/text notes (through import.folder)
            try:
                stats["chats"] = k.call("ingest.path", {"path": p, "tag": RAW_TAG})
            except KernelError as e:
                stats["failed"].append("%s: %s" % (p, e))
        if os.path.isdir(p):
            dig_folder(p, ledger, stats)
        elif p.lower().endswith(".zip"):
            dig_zip(p, ledger, stats)
        elif os.path.splitext(p.lower())[1] in DOC_EXT:
            with open(p, "rb") as fh:
                dig_file(os.path.basename(p), fh.read(MAX_FILE + 1),
                         os.path.getmtime(p), os.path.dirname(p), ledger, stats)
        return stats

    # -- distill --------------------------------------------------------------

    def raw_ids(tags):
        want = set(tags)
        notes = [n for n in k.vault.notes.values()
                 if want & set(n["tags"]) and DONE_TAG not in n["tags"]]
        notes.sort(key=lambda n: (n["created"], n["id"]))
        return [n["id"] for n in notes]

    def new_state(tags, model):
        return {"version": 1, "tags": list(tags), "model": model,
                "queue": raw_ids(tags), "pos": 0, "offset": 0, "chunks": 0,
                "failed_chunks": 0, "errors": [], "topics": {}, "decisions": [],
                "ideas": [], "threads": [], "events": [],
                "started": _iso(time.time()), "updated": None, "written": None}

    def next_chunk(st):
        """Up to CHUNK characters: the rest of the current note, then whole
        notes after it while they fit. Moves the cursor past what it took."""
        pieces, used = [], 0
        size = int(k.config.get("archive_chunk") or CHUNK)
        while st["pos"] < len(st["queue"]) and used < size:
            nid = st["queue"][st["pos"]]
            n = k.vault.notes.get(nid)
            if not n:
                st["pos"] += 1
                st["offset"] = 0
                continue
            body = n["body"]
            room = size - used
            if st["offset"] == 0 and pieces and len(body) > room:
                break                          # a long note starts its own chunk
            part = body[st["offset"]:st["offset"] + room]
            pieces.append((n, part, st["offset"] > 0))
            used += len(part)
            if st["offset"] + len(part) >= len(body):
                st["pos"] += 1
                st["offset"] = 0
            else:
                st["offset"] += len(part)
        return pieces

    def prompt(st, pieces):
        known = sorted((t["name"] for t in st["topics"].values()),
                       key=lambda s: s.lower())
        head = "Known topics: %s\n\n" % (", ".join(known) if known else "(none yet)")
        return head + "\n\n".join(
            "### [%s] %s (%s)%s\n%s" % (n["id"], n["title"], n["created"][:10],
                                       " (continued)" if cont else "", text)
            for n, text, cont in pieces)

    def ask(st, user, model):
        url = k.config["ollama_url"].rstrip("/") + "/api/chat"
        body = {"model": model or st.get("model") or k.config["model"], "stream": False,
                "format": SCHEMA, "keep_alive": "10m", "options": {"temperature": 0.1},
                "messages": [{"role": "system", "content": SYSTEM},
                             {"role": "user", "content": user}]}
        import urllib.error
        import urllib.request
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                reply = json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise KernelError("llm_unreachable", "Ollama at %s did not answer (%s). "
                              "Is `ollama serve` running?" % (k.config["ollama_url"], e))
        return (reply.get("message") or {}).get("content", "")

    def merge(st, out, pieces):
        ids = [n["id"] for n, _, _ in pieces]
        dates = {n["id"]: n["created"][:10] for n, _, _ in pieces}

        def src(item):
            s = str(item.get("source") or "").strip().strip("[]")
            return s if s in ids else ids[0]

        def topic_key(name):
            return slugify(name)[:48] if name and str(name).strip() else ""

        for t in out.get("topics") or []:
            key = topic_key(t.get("name"))
            if not key or not str(t.get("summary") or "").strip():
                continue
            topic = st["topics"].setdefault(key, {"name": str(t["name"]).strip(),
                                                  "points": [], "sources": []})
            s = src(t)
            if len(topic["points"]) < MAX_POINTS:
                topic["points"].append({"text": str(t["summary"]).strip(),
                                        "source": s, "date": dates[s]})
            if s not in topic["sources"]:
                topic["sources"].append(s)

        def add(kind, item, **extra):
            text = str(item.get("text") or "").strip()
            if not text:
                return None
            have = {_norm(x["text"]) for x in st[kind]}
            if _norm(text) in have:
                return None
            s = src(item)
            rec = {"text": text, "source": s, "date": dates[s],
                   "topic": topic_key(item.get("topic"))}
            rec.update(extra)
            st[kind].append(rec)
            return rec

        for d in out.get("decisions") or []:
            add("decisions", d, why=str(d.get("why") or "").strip(),
                date_said=str(d.get("date") or "")[:10])
        for i in out.get("ideas") or []:
            add("ideas", i)
        for t in out.get("threads") or []:
            if t.get("done"):
                words = set(_norm(t.get("text")).split())
                for open_ in st["threads"]:
                    have = set(_norm(open_["text"]).split())
                    if not open_.get("done") and words and \
                            len(words & have) >= max(2, len(words) // 2):
                        open_["done"] = True
                        open_["closed_by"] = src(t)
                        break
                continue
            add("threads", t, done=False)
        for e in out.get("events") or []:
            date = str(e.get("date") or "")[:10]
            if not re.match(r"^\d{4}-\d\d(-\d\d)?$", date):
                s = src(e)
                date = dates[s]
            rec = add("events", e)
            if rec:
                rec["date"] = date

    def distill(steps=1, restart=False, model=None, tags=None):
        st = None if restart else load(STATE, None)
        if not st or st.get("version") != 1:
            st = new_state(tags or DEFAULT_TAGS, model)
        else:
            seen = set(st["queue"])
            st["queue"] += [i for i in raw_ids(st["tags"]) if i not in seen]
        done = 0
        while done < max(1, int(steps)) and st["pos"] < len(st["queue"]):
            before = (st["pos"], st["offset"])
            pieces = next_chunk(st)
            if not pieces:
                break
            try:
                raw = ask(st, prompt(st, pieces), model)
                out = json.loads(raw)
                if not isinstance(out, dict):
                    raise ValueError("not an object")
                merge(st, out, pieces)
            except KernelError:
                st["pos"], st["offset"] = before         # Ollama down: retry later
                save(STATE, st)
                raise
            except (ValueError, TypeError, KeyError, AttributeError) as e:
                st["failed_chunks"] += 1
                st["errors"] = (st["errors"] + ["%s: %s" % (pieces[0][0]["id"], e)])[-20:]
            st["chunks"] += 1
            done += 1
            st["updated"] = _iso(time.time())
            save(STATE, st)
        return progress(st) | {"steps": done}

    def progress(st):
        if not st:
            return {"started": False}
        total = len(st["queue"])
        return {"started": st["started"], "updated": st["updated"],
                "written": st.get("written"), "notes_done": st["pos"],
                "notes_total": total, "finished": st["pos"] >= total,
                "chunks": st["chunks"], "failed_chunks": st["failed_chunks"],
                "topics": len(st["topics"]), "decisions": len(st["decisions"]),
                "ideas": len(st["ideas"]),
                "threads_open": sum(1 for t in st["threads"] if not t.get("done")),
                "events": len(st["events"]), "errors": st["errors"][-5:]}

    # -- write ----------------------------------------------------------------

    FOOT = ("\n\n---\n*Written by the archive digger (`archive.write`) from %d raw "
            "notes. Writing again replaces this note; keep your own words in "
            "another note.*\n")

    def cite(s):
        return "[[%s]]" % s

    def write():
        st = load(STATE, None)
        if not st or not st.get("chunks"):
            raise KernelError("not_ready", "nothing distilled yet: run archive.distill")
        foot = FOOT % st["pos"]
        stats = {"created": 0, "updated": 0, "skipped": 0}
        tags = [DONE_TAG]
        names = {k_: t["name"] for k_, t in st["topics"].items()}

        def under(kind, key):
            return [x for x in st[kind] if x.get("topic") == key]

        topic_ids = {}
        for key, t in sorted(st["topics"].items(), key=lambda kv: kv[1]["name"].lower()):
            nid = "archive-topic-" + key[:48].strip("-")
            topic_ids[key] = nid
            lines = ["# %s" % t["name"], "", "## What the archive says", ""]
            lines += ["- %s: %s %s" % (p["date"], p["text"], cite(p["source"]))
                      for p in sorted(t["points"], key=lambda p: p["date"])]
            for kind, head in (("decisions", "Decisions"), ("ideas", "Ideas"),
                               ("threads", "Open threads")):
                items = under(kind, key)
                if kind == "threads":
                    items = [x for x in items if not x.get("done")]
                if items:
                    lines += ["", "## " + head, ""]
                    for x in items:
                        why = (" (why: %s)" % x["why"]) if x.get("why") else ""
                        lines.append("- %s%s %s" % (x["text"], why, cite(x["source"])))
            lines += ["", "## Sources", "", ", ".join(cite(s) for s in t["sources"])]
            put(nid, "Archive: " + t["name"], "\n".join(lines) + foot,
                tags + ["archive-topic"], None, stats, category="archives")

        def tlink(key):
            return (" (%s)" % "[[%s]]" % topic_ids[key]) if key in topic_ids else ""

        def listing(nid, title, kind, render_):
            items = sorted(st[kind], key=lambda x: (x["date"], x["text"]))
            body = "# %s\n\n" % title + ("\n".join(render_(x) for x in items)
                                         or "Nothing found yet.") + foot
            put(nid, title, body, tags, None, stats, category="archives")

        months = {}
        for e in sorted(st["events"], key=lambda e: e["date"]):
            months.setdefault(e["date"][:7], []).append(e)
        tl = ["# Timeline", ""]
        for m, es in months.items():
            tl += ["## " + m, ""] + ["- %s: %s%s %s" % (e["date"], e["text"],
                                                        tlink(e["topic"]), cite(e["source"]))
                                     for e in es] + [""]
        put("archive-timeline", "Archive: timeline",
            "\n".join(tl).rstrip() + foot if months else "# Timeline\n\nNothing dated yet." + foot,
            tags, None, stats, category="archives")
        listing("archive-decisions", "Archive: decisions", "decisions",
                lambda x: "- %s: **%s**%s%s %s" % (
                    x["date"], x["text"], (" Why: %s" % x["why"]) if x.get("why") else "",
                    tlink(x["topic"]), cite(x["source"])))
        listing("archive-ideas", "Archive: ideas", "ideas",
                lambda x: "- %s: %s%s %s" % (x["date"], x["text"], tlink(x["topic"]),
                                             cite(x["source"])))
        listing("archive-open-threads", "Archive: open threads", "threads",
                lambda x: "- [%s] %s%s %s%s" % (
                    "x" if x.get("done") else " ", x["text"], tlink(x["topic"]),
                    cite(x["source"]),
                    (" (closed in %s)" % cite(x["closed_by"])) if x.get("closed_by") else ""))
        p = progress(st)
        ov = ["# The archive, distilled", "",
              "%d of %d raw notes read, %d topics, %d decisions, %d ideas, %d open "
              "threads, %d dated events." % (p["notes_done"], p["notes_total"], p["topics"],
                                             p["decisions"], p["ideas"], p["threads_open"],
                                             p["events"]),
              "", "- [[archive-timeline]]", "- [[archive-decisions]]", "- [[archive-ideas]]",
              "- [[archive-open-threads]]", "", "## Topics", ""]
        ov += ["- [[%s]] %s (%d sources)" % (topic_ids[key], names[key],
                                             len(st["topics"][key]["sources"]))
               for key in sorted(topic_ids, key=lambda x: -len(st["topics"][x]["sources"]))]
        put("archive-overview", "Archive: overview", "\n".join(ov) + foot,
            tags, None, stats, category="archives")
        st["written"] = _iso(time.time())
        save(STATE, st)
        return stats | {"topics": len(topic_ids)}

    # -- methods --------------------------------------------------------------

    S = {"type": "string"}

    @k.method("archive.sources", "List, add or remove the folders, zips and files "
              "the archive digger reads.", {"add": S, "remove": S})
    def m_sources(add=None, remove=None):
        paths = list(k.config.get("archive_sources") or [])
        if add:
            a = os.path.abspath(os.path.expanduser(add))
            if not os.path.exists(a):
                raise KernelError("not_found", "nothing at %s" % a)
            if a not in paths:
                paths.append(a)
        if remove:
            r = os.path.abspath(os.path.expanduser(remove))
            paths = [x for x in paths if x != r]
        if add or remove:
            k.save_config(archive_sources=paths)
        return {"sources": paths}

    @k.method("archive.dig", "Read the archive's sources (or one `path`) into raw "
              "notes tagged archive: chats, notes, docs, code, git history, audio. "
              "Safe to repeat; only what changed is read again.", {"path": S})
    def m_dig(path=None):
        paths = [path] if path else list(k.config.get("archive_sources") or [])
        if not paths:
            raise KernelError("bad_params", "no sources: add one with archive.sources")
        ledger = load(LEDGER, {})
        out = []
        try:
            for p in paths:
                out.append(dig_one(p, ledger))
        finally:
            save(LEDGER, ledger)
        return {"sources": out}

    @k.method("archive.distill", "Distill the raw archive notes with the local model, "
              "`steps` chunks per call, oldest first; resumes where it stopped.",
              {"steps": {"type": "integer"}, "restart": {"type": "boolean"},
               "model": S, "tags": {"type": "array", "items": S}})
    def m_distill(steps=1, restart=False, model=None, tags=None):
        return distill(steps, restart, model, tags)

    @k.method("archive.write", "Write the distilled notes: one per topic, a timeline, "
              "decisions, ideas, open threads and an overview.")
    def m_write():
        return write()

    @k.method("archive.status", "The archive digger's sources and progress.")
    def m_status():
        raw = sum(1 for n in k.vault.notes.values() if RAW_TAG in n["tags"])
        return {"sources": list(k.config.get("archive_sources") or []),
                "raw_notes": raw, "distill": progress(load(STATE, None))}
