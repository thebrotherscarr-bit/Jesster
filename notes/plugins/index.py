# -*- coding: utf-8 -*-
"""
INDEX — find the right passage in a vault of thousands of chats.

Notes are cut into chunks of a few paragraphs and kept in SQLite at
<vault>/.jesster/index.sqlite: full-text search (FTS5, BM25 ranking) always,
and vectors from a local Ollama embedding model when you ask for them
(index.embed). With vectors present, search is hybrid: the keyword ranking
and the meaning ranking are fused, so "that thing about rate limits" finds
the passage that says "429s" without the words matching.

The index is a cache of the vault. It follows every save, removal and outside
edit, checks itself against the vault's hashes on open, and can always be
rebuilt from the Markdown (index.rebuild). Deleting the file loses nothing.

Standard library only; numpy is used for vector search if it happens to be
installed, and pure Python otherwise.
"""
import array
import json
import math
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request

NAME = "index"
DB_FILE = "index.sqlite"
CHUNK = 1200             # target characters per chunk
HARD = 1800              # never longer than this
EMBED_MODEL = "nomic-embed-text"
EMBED_BATCH = 32
CANDIDATES = 200         # keyword hits handed to the vector re-rank
PURE_PY_SCAN = 6000      # without numpy, scan every vector only up to this many
RRF_K = 60

try:                                        # optional; never required
    import numpy as _np
except ImportError:                         # pragma: no cover
    _np = None


def chunks_of(body):
    """Paragraph-aligned pieces of about CHUNK characters. A heading (and so
    each message of a chat transcript) starts a new piece when the current
    one is already substantial."""
    blocks = re.split(r"\n\s*\n", body or "")
    out, cur = [], ""
    for b in blocks:
        b = b.strip()
        if not b:
            continue
        while len(b) > HARD:                       # one enormous paragraph
            cut = b.rfind(" ", 0, CHUNK)
            cut = cut if cut > CHUNK // 2 else CHUNK
            if cur:
                out.append(cur)
                cur = ""
            out.append(b[:cut].strip())
            b = b[cut:].strip()
        heading = b.startswith("#")
        if cur and (len(cur) + len(b) > CHUNK or (heading and len(cur) > CHUNK // 3)):
            out.append(cur)
            cur = ""
        cur = (cur + "\n\n" + b) if cur else b
    if cur:
        out.append(cur)
    return out


def register(k):
    from kernel import KernelError, tokens, STOP

    path = os.path.join(k.vault.meta, DB_FILE)
    lock = threading.RLock()
    st = {"db": None, "fts": True, "checked": False}

    def db():
        if st["db"] is None:
            c = sqlite3.connect(path, check_same_thread=False, timeout=30)
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("CREATE TABLE IF NOT EXISTS docs (note TEXT PRIMARY KEY, hash TEXT, "
                      "title TEXT, tags TEXT, category TEXT, updated TEXT)")
            c.execute("CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, "
                      "note TEXT, ord INTEGER, text TEXT)")
            c.execute("CREATE INDEX IF NOT EXISTS chunks_note ON chunks(note)")
            c.execute("CREATE TABLE IF NOT EXISTS vectors (chunk INTEGER, model TEXT, "
                      "vec BLOB, PRIMARY KEY (chunk, model))")
            try:
                c.execute("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5("
                          "title, text, tokenize='porter unicode61')")
            except sqlite3.OperationalError:          # a Python built without FTS5
                st["fts"] = False
            st["db"] = c
        return st["db"]

    # -- keeping up with the vault -------------------------------------------

    def drop(c, nid):
        ids = [r[0] for r in c.execute("SELECT id FROM chunks WHERE note=?", (nid,))]
        if ids:
            q = ",".join("?" * len(ids))
            c.execute("DELETE FROM vectors WHERE chunk IN (%s)" % q, ids)
            if st["fts"]:
                c.execute("DELETE FROM fts WHERE rowid IN (%s)" % q, ids)
            c.execute("DELETE FROM chunks WHERE note=?", (nid,))
        c.execute("DELETE FROM docs WHERE note=?", (nid,))

    def put(c, n):
        drop(c, n["id"])
        c.execute("INSERT INTO docs VALUES (?,?,?,?,?,?)",
                  (n["id"], n["hash"], n["title"], " ".join(n["tags"]),
                   n["category"], n["updated"]))
        title = "%s %s" % (n["title"], " ".join(n["tags"]))
        for i, text in enumerate(chunks_of(n["body"]) or [n["title"]]):
            cur = c.execute("INSERT INTO chunks (note, ord, text) VALUES (?,?,?)",
                            (n["id"], i, text))
            if st["fts"]:
                c.execute("INSERT INTO fts (rowid, title, text) VALUES (?,?,?)",
                          (cur.lastrowid, title, text))

    def reconcile():
        """Bring the index level with the vault: new, changed, gone."""
        with lock:
            c = db()
            have = dict(c.execute("SELECT note, hash FROM docs"))
            notes = k.vault.notes
            stale = [n for nid, n in notes.items() if have.get(nid) != n["hash"]]
            gone = [nid for nid in have if nid not in notes]
            for n in stale:
                put(c, n)
            for nid in gone:
                drop(c, nid)
            c.commit()
            st["checked"] = True
            return {"indexed": len(stale), "dropped": len(gone)}

    def ready():
        if not st["checked"]:
            reconcile()
        return db()

    def on_saved(note, raw, created):
        with lock:
            if st["checked"]:
                put(db(), note)
                db().commit()

    def on_removed(note):
        with lock:
            if st["checked"]:
                drop(db(), note["id"])
                db().commit()

    def on_external(ids):
        with lock:
            if not st["checked"]:
                return
            c = db()
            for nid in ids:
                n = k.vault.notes.get(nid)
                put(c, n) if n else drop(c, nid)
            c.commit()

    k.on("note.saved", on_saved)
    k.on("note.removed", on_removed)
    k.on("notes.external", on_external)

    # -- vectors -------------------------------------------------------------

    def embed(texts, model):
        url = k.config["ollama_url"].rstrip("/") + "/api/embed"
        req = urllib.request.Request(
            url, data=json.dumps({"model": model, "input": texts}).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                out = json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise KernelError("llm_unreachable", "Ollama embeddings at %s failed (%s). "
                              "Pull the model: `ollama pull %s`" % (url, e, model))
        vecs = out.get("embeddings") or []
        if len(vecs) != len(texts):
            raise KernelError("llm_failed", "Ollama returned %d vectors for %d texts"
                              % (len(vecs), len(texts)))
        return vecs

    def unit(v):
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        return array.array("f", (x / norm for x in v))

    def model_name():
        return k.config.get("embed_model") or EMBED_MODEL

    def vector_rank(qv, c, model, candidates):
        """Chunk ids by cosine similarity to the query vector."""
        if candidates is None:
            rows = c.execute("SELECT chunk, vec FROM vectors WHERE model=?", (model,)).fetchall()
        else:
            if not candidates:
                return []
            q = ",".join("?" * len(candidates))
            rows = c.execute("SELECT chunk, vec FROM vectors WHERE model=? AND chunk IN (%s)"
                             % q, [model] + list(candidates)).fetchall()
        if not rows:
            return []
        if _np is not None:
            m = _np.frombuffer(b"".join(r[1] for r in rows), dtype=_np.float32)
            m = m.reshape(len(rows), -1)
            sims = m @ _np.asarray(qv, dtype=_np.float32)
            order = _np.argsort(-sims)
            return [(rows[i][0], float(sims[i])) for i in order]
        scored = []
        for cid, blob in rows:
            v = array.array("f")
            v.frombytes(blob)
            scored.append((cid, sum(a * b for a, b in zip(qv, v))))
        scored.sort(key=lambda x: -x[1])
        return scored

    # -- searching -----------------------------------------------------------

    def fts_query(q):
        terms = [t for t in tokens(q) if t not in STOP] or tokens(q)
        return " OR ".join('"%s"' % t for t in terms[:24])

    def keyword_rank(c, q, n):
        if not st["fts"]:
            terms = [t for t in tokens(q) if t not in STOP]
            if not terms:
                return []
            rows = c.execute("SELECT id, text FROM chunks").fetchall()
            scored = [(cid, sum(text.lower().count(t) for t in terms)) for cid, text in rows]
            return sorted([s for s in scored if s[1] > 0], key=lambda x: -x[1])[:n]
        fq = fts_query(q)
        if not fq:
            return []
        rows = c.execute("SELECT rowid, bm25(fts, 3.0, 1.0) FROM fts WHERE fts MATCH ? "
                         "ORDER BY bm25(fts, 3.0, 1.0) LIMIT ?", (fq, n)).fetchall()
        return [(cid, -score) for cid, score in rows]

    def search(q, limit=10, tag=None, category=None, since=None, mode="auto"):
        with lock:
            c = ready()
            kw = keyword_rank(c, q, CANDIDATES)
            model = model_name()
            n_vec = c.execute("SELECT COUNT(*) FROM vectors WHERE model=?", (model,)).fetchone()[0]
            vec = []
            if mode != "keyword" and n_vec:
                try:
                    qv = unit(embed([q], model)[0])
                    scan_all = _np is not None or n_vec <= PURE_PY_SCAN
                    vec = vector_rank(qv, c, model, None if scan_all else [i for i, _ in kw])
                    vec = vec[:CANDIDATES]
                except KernelError:
                    vec = []                        # Ollama down: keywords still work
            fused = {}
            for rank, (cid, _) in enumerate(kw):
                fused[cid] = fused.get(cid, 0) + 1.0 / (RRF_K + rank)
            for rank, (cid, _) in enumerate(vec):
                fused[cid] = fused.get(cid, 0) + 1.0 / (RRF_K + rank)
            order = sorted(fused, key=lambda i: -fused[i])
            out = []
            for cid in order:
                row = c.execute("SELECT c.note, c.ord, c.text, d.title, d.tags, d.category, "
                                "d.updated FROM chunks c JOIN docs d ON d.note=c.note "
                                "WHERE c.id=?", (cid,)).fetchone()
                if not row:
                    continue
                note, ord_, text, title, tags, cat, updated = row
                tags = tags.split()
                if tag and tag not in tags:
                    continue
                if category and cat != category:
                    continue
                if since and updated < since:
                    continue
                out.append({"note": note, "chunk": ord_, "title": title, "tags": tags,
                            "category": cat, "updated": updated, "text": text,
                            "score": round(fused[cid] * 1000, 3)})
                if len(out) >= limit:
                    break
            return {"results": out, "mode": "hybrid" if vec else "keyword"}

    k.index_search = search            # for other plugins: llm.ask, context, the gateway

    def note_level(q, limit=20, tag=None, category=None, pinned=None):
        """Kernel search through the index: best chunk per note."""
        hits = search(q, limit=limit * 4, tag=tag, category=category)["results"]
        seen, out = set(), []
        for h in hits:
            n = k.vault.notes.get(h["note"])
            if not n or h["note"] in seen:
                continue
            if pinned is not None and n["pinned"] != bool(pinned):
                continue
            seen.add(h["note"])
            out.append((h["score"], n))
            if len(out) >= limit:
                break
        return out

    k.searcher = note_level

    S = {"type": "string"}

    @k.method("index.search", "Find passages across every note and imported chat "
              "(keyword + meaning when vectors exist).",
              {"q": S, "limit": {"type": "integer"}, "tag": S, "category": S,
               "since": dict(S, description="only notes updated on or after this ISO date"),
               "mode": dict(S, enum=["auto", "keyword"])}, ["q"])
    def m_search(q, limit=10, tag=None, category=None, since=None, mode="auto"):
        return search(q, limit, tag, category, since, mode)

    @k.method("index.embed", "Compute vectors (local Ollama) for chunks that have none yet.",
              {"model": S, "limit": {"type": "integer"}})
    def m_embed(model=None, limit=None):
        model = model or model_name()
        done, t0 = 0, time.time()
        while True:
            with lock:
                c = ready()
                rows = c.execute("SELECT id, text FROM chunks WHERE id NOT IN "
                                 "(SELECT chunk FROM vectors WHERE model=?) LIMIT ?",
                                 (model, EMBED_BATCH)).fetchall()
            if not rows or (limit and done >= limit):
                break
            vecs = embed([t for _, t in rows], model)
            with lock:
                c = db()
                c.executemany("INSERT OR REPLACE INTO vectors VALUES (?,?,?)",
                              [(cid, model, unit(v).tobytes()) for (cid, _), v in zip(rows, vecs)])
                c.commit()
            done += len(rows)
        with lock:
            left = db().execute("SELECT COUNT(*) FROM chunks WHERE id NOT IN (SELECT chunk "
                                "FROM vectors WHERE model=?)", (model,)).fetchone()[0]
        return {"model": model, "embedded": done, "remaining": left,
                "seconds": round(time.time() - t0, 1)}

    @k.method("index.stats", "What the index holds.")
    def m_stats():
        with lock:
            c = ready()
            vecs = dict(c.execute("SELECT model, COUNT(*) FROM vectors GROUP BY model"))
            return {"notes": c.execute("SELECT COUNT(*) FROM docs").fetchone()[0],
                    "chunks": c.execute("SELECT COUNT(*) FROM chunks").fetchone()[0],
                    "vectors": vecs, "fts5": st["fts"], "numpy": _np is not None,
                    "embed_model": model_name()}

    @k.method("index.rebuild", "Throw the index away and rebuild it from the vault "
              "(vectors are recomputed by index.embed).")
    def m_rebuild():
        with lock:
            if st["db"] is not None:
                st["db"].close()
                st["db"] = None
            for suffix in ("", "-wal", "-shm"):
                try:
                    os.unlink(path + suffix)
                except OSError:
                    pass
            st["checked"] = False
            return reconcile()
