# -*- coding: utf-8 -*-
"""
INGEST — everything you said to every model, as notes.

Point ingest.path at a data export (the .zip as downloaded, the unzipped
folder, or a single file) and each conversation becomes one readable
Markdown note: who said what, when, with which model. Re-running is safe — a
conversation that grew since is updated, one that did not is skipped — so a
folder can be ingested again and again (or watched; see `watch` below).

  ChatGPT       Settings > Data controls > Export     conversations.json
  Claude        Settings > Privacy > Export data      conversations.json
  Gemini        takeout.google.com > My Activity >    My Activity/Gemini Apps/
                Gemini Apps (choose JSON)             MyActivity.json (or .html)
  Claude Code   ~/.claude/projects/<project>/*.jsonl  session transcripts
  audio         .mp3 .m4a .wav .ogg .webm .flac       through `transcribe_cmd`
  notes         .md .markdown .txt                    through import.folder

Audio is transcribed by a command you choose (config `transcribe_cmd`, a list
with {in} and {out_dir}, e.g. whisper.cpp or openai-whisper); its stdout, or
a .txt it writes into {out_dir}, is the transcript. Nothing is uploaded.

Chat notes are filed under archives, tagged `chat` and their source.
"""
import hashlib
import html
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from html.parser import HTMLParser

NAME = "ingest"
AUDIO = (".mp3", ".m4a", ".wav", ".ogg", ".webm", ".flac", ".mp4")
TEXT = (".md", ".markdown", ".txt")
SKIP_DIRS = {".git", ".jesster", "node_modules", "__pycache__", ".venv", "venv"}
LABEL = {"chatgpt": "ChatGPT", "claude": "Claude", "gemini": "Gemini",
         "claude-code": "Claude Code", "user": "You"}
MAX_MESSAGE = 40000      # characters kept from one message (pasted logs get huge)


# --------------------------------------------------------------------------
# a conversation, whatever it came from
# --------------------------------------------------------------------------

def _iso(t):
    if t is None or t == "":
        return None
    if isinstance(t, (int, float)):
        return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(float(t)))
    return str(t)


def _clip(text):
    text = (text or "").strip()
    if len(text) > MAX_MESSAGE:
        text = text[:MAX_MESSAGE] + "\n\n…(%d more characters not kept)" % (len(text) - MAX_MESSAGE)
    return text


def conversation(source, cid, title, messages, created=None, updated=None,
                 model=None, tags=()):
    msgs = [(r, _clip(t), _iso(ts)) for r, t, ts in messages if (t or "").strip()]
    if not msgs:
        return None
    first_user = next((t for r, t, _ in msgs if r == "user"), msgs[0][1])
    return {"source": source, "cid": str(cid),
            "title": (title or "").strip() or first_user.split("\n", 1)[0][:70] or "untitled chat",
            "messages": msgs,
            "created": _iso(created) or msgs[0][2],
            "updated": _iso(updated) or msgs[-1][2],
            "model": model, "tags": list(tags)}


def to_markdown(c):
    head = ["> %s conversation `%s`" % (LABEL.get(c["source"], c["source"]), c["cid"])]
    if c.get("model"):
        head.append("> model: %s" % c["model"])
    head.append("> %d messages, %s → %s" % (len(c["messages"]), c["created"] or "?",
                                            c["updated"] or "?"))
    parts = ["\n".join(head)]
    who = {"user": "You", "assistant": LABEL.get(c["source"], "Assistant"),
           "system": "System", "tool": "Tool"}
    for role, text, ts in c["messages"]:
        parts.append("### %s%s\n\n%s" % (who.get(role, role.title()),
                                         (" · " + ts[:16].replace("T", " ")) if ts else "",
                                         text))
    return "\n\n".join(parts) + "\n"


def note_id(c):
    h = hashlib.sha1(("%s:%s" % (c["source"], c["cid"])).encode("utf-8")).hexdigest()[:10]
    return "chat-%s-%s" % (c["source"], h)


# --------------------------------------------------------------------------
# readers — each takes parsed data and yields conversations
# --------------------------------------------------------------------------

def read_chatgpt(data):
    """conversations.json from ChatGPT: each conversation is a tree of
    messages (edits branch it). The branch that ends at current_node is the
    conversation as you last saw it."""
    for conv in data:
        mapping = conv.get("mapping") or {}
        node = conv.get("current_node") or next(
            (k for k, v in mapping.items() if not v.get("children")), None)
        path = []
        while node and node in mapping:
            path.append(mapping[node])
            node = mapping[node].get("parent")
        msgs, model = [], None
        for item in reversed(path):
            m = item.get("message") or {}
            meta = m.get("metadata") or {}
            if meta.get("is_visually_hidden_from_conversation"):
                continue
            role = (m.get("author") or {}).get("role")
            if role not in ("user", "assistant"):
                continue
            content = m.get("content") or {}
            parts = content.get("parts") or []
            text = "\n".join(p for p in parts if isinstance(p, str))
            if not text and content.get("text"):
                text = content["text"]
            if content.get("content_type") == "code" and text:
                text = "```\n%s\n```" % text
            model = meta.get("model_slug") or model
            msgs.append((role, text, m.get("create_time")))
        c = conversation("chatgpt", conv.get("conversation_id") or conv.get("id") or
                         conv.get("title"), conv.get("title"), msgs,
                         conv.get("create_time"), conv.get("update_time"), model)
        if c:
            yield c


def read_claude(data):
    """conversations.json from claude.ai."""
    for conv in data:
        msgs = []
        for m in conv.get("chat_messages") or []:
            text = m.get("text") or "\n".join(
                b.get("text", "") for b in m.get("content") or []
                if isinstance(b, dict) and b.get("type") == "text")
            role = "user" if m.get("sender") == "human" else "assistant"
            msgs.append((role, text, m.get("created_at")))
        c = conversation("claude", conv.get("uuid") or conv.get("name"), conv.get("name"),
                         msgs, conv.get("created_at"), conv.get("updated_at"))
        if c:
            yield c


class _Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.out = []

    def handle_starttag(self, tag, attrs):
        if tag in ("br", "p", "div", "li", "tr", "h1", "h2", "h3", "pre"):
            self.out.append("\n")

    def handle_data(self, data):
        self.out.append(data)

    def text(self):
        return re.sub(r"\n\s*\n+", "\n\n", "".join(self.out)).strip()


def strip_html(s):
    p = _Text()
    p.feed(s or "")
    return p.text()


def _gemini_days(items):
    """Gemini activity is a flat list of prompts; a day of it is one note."""
    days = {}
    for prompt, answer, ts in items:
        day = (ts or "")[:10] or "undated"
        days.setdefault(day, []).append((prompt, answer, ts))
    for day, turns in sorted(days.items()):
        turns.sort(key=lambda x: x[2] or "")
        msgs = []
        for prompt, answer, ts in turns:
            msgs.append(("user", prompt, ts))
            if answer:
                msgs.append(("assistant", answer, ts))
        c = conversation("gemini", day, "Gemini — %s" % day, msgs)
        if c:
            yield c


def read_gemini_json(data):
    items = []
    for it in data:
        title = it.get("title") or ""
        if not title.startswith("Prompted "):
            continue
        answer = "\n\n".join(strip_html(h.get("html", ""))
                             for h in it.get("safeHtmlItem") or [] if isinstance(h, dict))
        items.append((title[len("Prompted "):], answer, it.get("time")))
    yield from _gemini_days(items)


def read_gemini_html(text):
    """The default Takeout format. Each activity is an 'outer-cell' block:
    'Prompted <prompt>', a timestamp line, then the answer."""
    items = []
    for block in re.split(r'<div class="outer-cell', text)[1:]:
        body = strip_html(block.split('<div class="content-cell mdl-cell mdl-cell--12-col '
                                      'mdl-typography--caption', 1)[0])
        body = re.sub(r"^.*?>", "", body, count=1) if body.startswith(" ") else body
        m = re.search(r"Prompted\s+(.*?)\n(.*?\d{4}[^\n]*)\n?(.*)", body, re.S)
        if not m:
            continue
        prompt, when, answer = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
        ts = None
        for fmt in ("%b %d, %Y, %I:%M:%S %p %Z", "%d %b %Y, %H:%M:%S %Z",
                    "%b %d, %Y, %I:%M:%S %p"):
            try:
                ts = time.strftime("%Y-%m-%dT%H:%M:%S",
                                   time.strptime(when.replace(" ", " "), fmt))
                break
            except ValueError:
                continue
        items.append((prompt, answer, ts))
    yield from _gemini_days(items)


def read_claude_code(lines, name):
    """One Claude Code session transcript (JSON lines)."""
    msgs, title, cwd, sid = [], None, None, None
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "summary" and e.get("summary"):
            title = title or e["summary"]
            continue
        if e.get("type") not in ("user", "assistant") or e.get("isMeta"):
            continue
        sid = sid or e.get("sessionId")
        cwd = cwd or e.get("cwd")
        m = e.get("message") or {}
        content = m.get("content")
        if isinstance(content, str):
            text = content
        else:
            bits = []
            for b in content or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text":
                    bits.append(b.get("text", ""))
                elif b.get("type") == "tool_use":
                    bits.append("`[tool: %s]`" % b.get("name"))
            text = "\n\n".join(x for x in bits if x)
        if text.startswith("<command-") or text.startswith("<local-command"):
            continue
        msgs.append((m.get("role") or e["type"], text, e.get("timestamp")))
    project = os.path.basename((cwd or "").rstrip("/\\")) or None
    c = conversation("claude-code", sid or name, title, msgs,
                     tags=["project-" + re.sub(r"[^a-z0-9]+", "-", project.lower()).strip("-")]
                     if project else [])
    if c:
        yield c


# --------------------------------------------------------------------------
# finding things in an export
# --------------------------------------------------------------------------

def sniff_json(data, name):
    """Which reader a parsed JSON document is for."""
    if isinstance(data, list) and data and isinstance(data[0], dict):
        d0 = data[0]
        if "mapping" in d0:
            return read_chatgpt(data)
        if "chat_messages" in d0:
            return read_claude(data)
        if "header" in d0 and ("Gemini" in str(d0.get("header")) or
                               "Gemini" in json.dumps(d0.get("products", ""))):
            return read_gemini_json(data)
    return None


def is_claude_code(first_line):
    try:
        e = json.loads(first_line)
    except ValueError:
        return False
    return isinstance(e, dict) and ("sessionId" in e or e.get("type") in ("summary", "user"))


def register(k):
    from kernel import KernelError

    def store(c, stats, tag):
        nid = note_id(c)
        body = to_markdown(c)
        tags = ["chat", c["source"]] + c["tags"] + ([tag] if tag else [])
        stats["conversations"] += 1
        stats["by_source"][c["source"]] = stats["by_source"].get(c["source"], 0) + 1
        have = k.vault.notes.get(nid)
        if have:
            if have["body"] == body:
                stats["skipped"] += 1
                return
            k.call("notes.update", {"id": nid, "body": body, "title": c["title"]})
            stats["updated"] += 1
            return
        params = {"id": nid, "title": c["title"], "body": body, "tags": tags,
                  "category": "archives"}
        if c["created"]:
            params["created"] = c["created"]
        if c["updated"]:
            params["updated"] = c["updated"]
        try:
            k.call("notes.create", params)
        except KernelError as e:
            if e.code != "bad_params":
                raise
            params.pop("created", None)            # an unparseable date: drop it, keep the chat
            params.pop("updated", None)
            k.call("notes.create", params)
        stats["created"] += 1

    def run(gen, stats, tag, where):
        try:
            for c in gen or ():
                store(c, stats, tag)
        except (ValueError, KeyError, TypeError, AttributeError) as e:
            stats["failed"].append("%s: %s" % (where, e))

    def transcribe(path, stats, tag):
        cmd = k.config.get("transcribe_cmd")
        if not cmd:
            stats["failed"].append("%s: no transcribe_cmd configured (see ingest.py)"
                                   % os.path.basename(path))
            return
        out_dir = tempfile.mkdtemp(prefix="jn-transcribe-")
        try:
            args = [a.replace("{in}", path).replace("{out_dir}", out_dir) for a in cmd]
            r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=3600)
            text = (r.stdout or "").strip()
            if not text:
                txts = [f for f in os.listdir(out_dir) if f.endswith(".txt")]
                if txts:
                    with open(os.path.join(out_dir, txts[0]), "r", encoding="utf-8") as f:
                        text = f.read().strip()
            if r.returncode != 0 or not text:
                stats["failed"].append("%s: transcriber said %s" % (
                    os.path.basename(path), (r.stderr or "nothing")[-300:]))
                return
            with open(path, "rb") as f:
                h = hashlib.sha1(f.read()).hexdigest()[:10]
            nid = "transcript-" + h
            stats["conversations"] += 1
            stats["by_source"]["audio"] = stats["by_source"].get("audio", 0) + 1
            if nid in k.vault.notes:
                stats["skipped"] += 1
                return
            k.call("notes.create", {
                "id": nid, "title": "Transcript — %s" % os.path.basename(path),
                "body": "> transcribed from `%s`\n\n%s\n" % (os.path.basename(path), text),
                "tags": ["transcript", "audio"] + ([tag] if tag else []),
                "category": "inbox",
                "created": time.strftime("%Y-%m-%dT%H:%M:%S%z",
                                         time.localtime(os.path.getmtime(path)))})
            stats["created"] += 1
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)

    def one_file(name, read_bytes, stats, tag, real_path=None):
        low = name.lower()
        base = os.path.basename(low)
        if low.endswith(".json"):
            try:
                data = json.loads(read_bytes().decode("utf-8-sig"))
            except (ValueError, UnicodeDecodeError) as e:
                stats["failed"].append("%s: %s" % (name, e))
                return
            gen = sniff_json(data, name)
            if gen is not None:
                run(gen, stats, tag, name)
            elif base == "conversations.json":
                stats["failed"].append("%s: not a format this knows" % name)
        elif low.endswith(".jsonl"):
            text = read_bytes().decode("utf-8", "replace")
            lines = text.splitlines()
            if lines and is_claude_code(lines[0]):
                run(read_claude_code(lines, os.path.splitext(base)[0]), stats, tag, name)
        elif low.endswith(".html") and "gemini" in low:
            run(read_gemini_html(read_bytes().decode("utf-8", "replace")), stats, tag, name)
        elif low.endswith(AUDIO) and real_path:
            transcribe(real_path, stats, tag)

    def walk(root, stats, tag):
        texts = []
        for d, dirs, files in os.walk(root):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
            for f in sorted(files):
                p = os.path.join(d, f)
                if f.lower().endswith(TEXT):
                    texts.append(p)
                    continue
                if f.lower().endswith(".zip"):
                    zipped(p, stats, tag)
                    continue

                def rb(p=p):
                    with open(p, "rb") as fh:
                        return fh.read()
                one_file(os.path.relpath(p, root), rb, stats, tag, p)
        return texts

    def zipped(path, stats, tag):
        try:
            z = zipfile.ZipFile(path)
        except zipfile.BadZipFile as e:
            stats["failed"].append("%s: %s" % (path, e))
            return
        with z:
            audio_dir = None
            for info in z.infolist():
                if info.is_dir():
                    continue
                name = info.filename
                if name.lower().endswith(AUDIO):
                    audio_dir = audio_dir or tempfile.mkdtemp(prefix="jn-audio-")
                    dest = os.path.join(audio_dir, os.path.basename(name))
                    with z.open(info) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out)
                    transcribe(dest, stats, tag)
                    continue
                one_file(name, lambda info=info: z.read(info), stats, tag)
            if audio_dir:
                shutil.rmtree(audio_dir, ignore_errors=True)

    def ingest(path, tag=None):
        p = os.path.abspath(os.path.expanduser(path))
        if not os.path.exists(p):
            raise KernelError("not_found", "nothing at %s" % p)
        stats = {"conversations": 0, "created": 0, "updated": 0, "skipped": 0,
                 "by_source": {}, "failed": [], "notes": None}
        if os.path.isdir(p):
            texts = walk(p, stats, tag)
            if texts:
                stats["notes"] = k.call("import.folder", {"path": p, "tag": tag}) \
                    if "import.folder" in k.methods else None
        elif p.lower().endswith(".zip"):
            zipped(p, stats, tag)
        else:
            def rb():
                with open(p, "rb") as fh:
                    return fh.read()
            one_file(os.path.basename(p), rb, stats, tag, p)
        return stats

    k.ingest = ingest

    S = {"type": "string"}

    @k.method("ingest.path", "Bring in chats and transcripts: a ChatGPT / Claude / "
              "Google (Gemini) export zip or folder, Claude Code transcripts, audio.",
              {"path": S, "tag": S}, ["path"])
    def m_ingest(path, tag=None):
        return ingest(path, tag)

    @k.method("ingest.watch", "List, add or remove folders re-ingested on a timer "
              "while the server runs.",
              {"add": S, "remove": S})
    def m_watch(add=None, remove=None):
        paths = list(k.config.get("watch") or [])
        if add:
            a = os.path.abspath(os.path.expanduser(add))
            if a not in paths:
                paths.append(a)
        if remove:
            r = os.path.abspath(os.path.expanduser(remove))
            paths = [x for x in paths if x != r]
        if add or remove:
            k.save_config(watch=paths)
        return {"watch": paths, "every_minutes": k.config.get("watch_minutes", 10)}

    @k.method("ingest.sources", "Where each kind of export comes from, and what is in "
              "the vault from each source.")
    def m_sources():
        counts = {}
        for n in k.vault.notes.values():
            if "chat" in n["tags"] or "transcript" in n["tags"]:
                src = next((t for t in n["tags"] if t in LABEL or t == "audio"), "other")
                counts[src] = counts.get(src, 0) + 1
        return {"in_vault": counts, "how": {
            "chatgpt": "chatgpt.com > Settings > Data controls > Export data; ingest the zip",
            "claude": "claude.ai > Settings > Privacy > Export data; ingest the zip",
            "gemini": "takeout.google.com > My Activity > Gemini Apps (JSON); ingest the zip",
            "claude-code": "ingest ~/.claude/projects (or add it to ingest.watch)",
            "audio": "set transcribe_cmd in the vault config, then ingest the files",
        }}
