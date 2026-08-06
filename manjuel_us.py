#!/usr/bin/env python3
# =============================================================================
#  MANJUEL.US — the hash-chained ledger
#
#  One file. One command. No files are hosted here — only the chain.
#
#  COMMANDS
#    python manjuel_us.py genesis     generate the paper cypher + block zero (ONCE)
#    python manjuel_us.py append      record an entry (estate only; asks for the cypher)
#    python manjuel_us.py verify      walk the chain; add --holder to verify seals
#    python manjuel_us.py serve       read-only web mirror for manjuel.us
#
#  WHAT IS STORED (in manjuel_ledger.db, beside this file)
#    - every entry: seq, timestamp, actor, action, payload
#    - the plain hash chain: each entry's BLAKE3 hash, linked to its parent
#    - each entry's SEAL: a keyed BLAKE3 digest only cypher-holders can recompute
#    - a keycheck digest, so a typed cypher can be validated without storing it
#
#  WHAT IS NEVER STORED, ANYWHERE
#    - the cypher itself. It is generated once, shown once, and lives on paper.
#    - the seal key. It is re-derived from the cypher at the moment of use.
#
#  THE TWO LAYERS OF VERIFICATION
#    PUBLIC   anyone can walk the chain and prove no entry was altered or
#             reordered after the fact (plain BLAKE3 linkage).
#    HOLDER   only someone holding the paper cypher can prove the chain is
#             authentically the operator's — the genesis hash and every seal
#             re-derive from the cypher, and from nothing else.
#
#  THE WEB SERVER HAS NO WRITE PATH. Appends are CLI-only, with the paper in
#  hand, on the estate. The public site is a read-only mirror of the chain.
#
#  SERVE FOR A CLOUDFLARE PAGES FRONTEND (v2 edit, 2026-08-05)
#    serve --cors-origin https://manjuel.us
#    allows the browser at that ONE origin to read the /api/* routes.
#    Off by default; nothing about the chain or its protocol changed.
#
#  DEPENDENCY: pip install blake3        (chosen by the operator, 2026-08-05)
# =============================================================================

import argparse
import base64
import getpass
import html
import json
import os
import re
import secrets
import sqlite3
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    from blake3 import blake3
except ImportError:
    sys.exit("manjuel: the BLAKE3 dependency is missing. Run: pip install blake3")

# ---------------------------------------------------------------------------
# Constants — these are protocol. Changing any of them orphans every existing
# ledger, forever. They are versioned so a future protocol can coexist.
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = "manjuel/1"
DOMAIN_GENESIS = b"manjuel.us/genesis/v1:"   # cypher -> genesis hash
DOMAIN_SEAL = b"manjuel.us/seal/v1:"         # cypher -> 32-byte seal key
DOMAIN_KEYCHECK = b"manjuel.us/keycheck/v1:" # cypher -> stored keycheck digest
ZERO_HASH = "0" * 64
CYPHER_CHARS = 40                            # base32 -> 200 bits of entropy
DEFAULT_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manjuel_ledger.db")
DB_PATH = os.environ.get("MANJUEL_DB", DEFAULT_DB)
PAGE_SIZE = 50
API_MAX_LIMIT = 500
CORS_ORIGIN = None  # set by `serve --cors-origin`; when set, /api/* answers that one origin

# ---------------------------------------------------------------------------
# Hashing primitives
# ---------------------------------------------------------------------------

def b3_hex(data: bytes) -> str:
    return blake3(data).hexdigest()

def keyed_hex(key32: bytes, data: bytes) -> str:
    return blake3(data, key=key32).hexdigest()

def canonical_body(ts, actor, action, payload) -> bytes:
    # Deterministic serialization. Same body -> same bytes -> same hash, always.
    body = {"action": action, "actor": actor, "payload": payload, "ts": ts}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

def compute_entry_hash(parent_hash, ts, actor, action, payload) -> str:
    return b3_hex(parent_hash.encode("ascii") + canonical_body(ts, actor, action, payload))

def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

# ---------------------------------------------------------------------------
# The cypher — generated once, shown once, held on paper
# ---------------------------------------------------------------------------

def generate_cypher() -> str:
    # 25 random bytes -> exactly 40 base32 characters, no padding. 200 bits.
    raw = secrets.token_bytes(25)
    return base64.b32encode(raw).decode("ascii")

def format_cypher(c: str) -> str:
    return "-".join(c[i:i + 5] for i in range(0, len(c), 5))

def normalize_cypher(text: str) -> bytes:
    # Accept it typed with or without hyphens/spaces, any case.
    s = re.sub(r"[\s\-]", "", text).upper()
    if not re.fullmatch(r"[A-Z2-7]{%d}" % CYPHER_CHARS, s):
        raise ValueError("that is not a well-formed cypher (expect %d base32 characters)" % CYPHER_CHARS)
    return s.encode("ascii")

def derive(cypher: bytes) -> dict:
    # Everything the system ever holds is DERIVED. The cypher itself is not kept.
    return {
        "genesis_hash": b3_hex(DOMAIN_GENESIS + cypher),
        "seal_key": blake3(DOMAIN_SEAL + cypher).digest(),
        "keycheck": b3_hex(DOMAIN_KEYCHECK + cypher),
    }

def read_secret(prompt: str) -> str:
    # Hidden input on a real terminal; plain stdin when scripted/piped.
    if sys.stdin.isatty():
        return getpass.getpass(prompt)
    print(prompt, end="", flush=True)
    line = sys.stdin.readline()
    if not line:
        raise SystemExit("manjuel: no input received")
    print(flush=True)
    return line.strip()

def require_cypher(conn) -> tuple:
    stored_keycheck = get_meta(conn, "keycheck")
    typed = read_secret("cypher (from the paper): ")
    try:
        cypher = normalize_cypher(typed)
    except ValueError as e:
        raise SystemExit("manjuel: %s" % e)
    d = derive(cypher)
    if not secrets.compare_digest(d["keycheck"], stored_keycheck):
        raise SystemExit("manjuel: cypher does not match this ledger. Nothing was written.")
    return cypher, d

# ---------------------------------------------------------------------------
# The ledger — SQLite, one file, default journal (no scattered sidecar files)
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_hash  TEXT NOT NULL UNIQUE,
    parent_hash TEXT NOT NULL,
    ts          TEXT NOT NULL,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    payload     TEXT NOT NULL,
    seal        TEXT NOT NULL
);
"""

def connect(readonly=False):
    if readonly:
        conn = sqlite3.connect("file:%s?mode=ro" % DB_PATH, uri=True)
    else:
        conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def get_meta(conn, key):
    row = conn.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
    return row["v"] if row else None

def ledger_exists() -> bool:
    if not os.path.exists(DB_PATH):
        return False
    try:
        conn = connect(readonly=True)
        ok = get_meta(conn, "keycheck") is not None
        conn.close()
        return ok
    except sqlite3.Error:
        return False

def open_ledger(readonly=False):
    if not ledger_exists():
        raise SystemExit("manjuel: no ledger at %s — run `genesis` first (once, ever)." % DB_PATH)
    return connect(readonly=readonly)

def head_of(conn):
    return conn.execute("SELECT * FROM ledger ORDER BY seq DESC LIMIT 1").fetchone()

# ---------------------------------------------------------------------------
# Command: genesis
# ---------------------------------------------------------------------------

def cmd_genesis(args):
    if ledger_exists():
        raise SystemExit("manjuel: a ledger already exists at %s.\n"
                         "Genesis happens once. It will not be repeated here." % DB_PATH)
    cypher_str = generate_cypher()
    shown = format_cypher(cypher_str)
    print()
    print("=" * 64, flush=True)
    print("  THE CYPHER — shown now, and never again", flush=True)
    print("=" * 64, flush=True)
    print(flush=True)
    print("    %s" % shown, flush=True)
    print(flush=True)
    print("  Write it on paper, by hand, now. It will not be stored on", flush=True)
    print("  this machine, and it cannot be recovered or regenerated.", flush=True)
    print("  Whoever holds this paper can verify the chain is yours.", flush=True)
    print("=" * 64, flush=True)
    print(flush=True)
    typed = read_secret("Re-enter the cypher from your paper to prove it is written down: ")
    try:
        typed_norm = normalize_cypher(typed)
    except ValueError:
        raise SystemExit("manjuel: that did not match the cypher's shape. Nothing was written.\n"
                         "Run `genesis` again for a fresh cypher.")
    if not secrets.compare_digest(typed_norm, cypher_str.encode("ascii")):
        raise SystemExit("manjuel: re-entry did not match. Nothing was written.\n"
                         "Destroy that paper and run `genesis` again for a fresh cypher.")

    d = derive(typed_norm)
    ts = now_utc()
    seal = keyed_hex(d["seal_key"], d["genesis_hash"].encode("ascii"))
    payload = json.dumps({"note": "block zero", "protocol": PROTOCOL_VERSION}, sort_keys=True)

    conn = connect()
    conn.executescript(SCHEMA)
    with conn:
        conn.execute("INSERT INTO meta (k, v) VALUES ('protocol', ?)", (PROTOCOL_VERSION,))
        conn.execute("INSERT INTO meta (k, v) VALUES ('keycheck', ?)", (d["keycheck"],))
        conn.execute("INSERT INTO meta (k, v) VALUES ('created', ?)", (ts,))
        conn.execute(
            "INSERT INTO ledger (entry_hash, parent_hash, ts, actor, action, payload, seal) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (d["genesis_hash"], ZERO_HASH, ts, "operator", "genesis", payload, seal))
    conn.close()

    print()
    print("Block zero is cut. Recorded at %s" % ts)
    print("genesis hash : %s" % d["genesis_hash"])
    print("ledger file  : %s" % DB_PATH)
    print()
    print("The genesis hash is public. The cypher is not, and was not stored.")

# ---------------------------------------------------------------------------
# Command: append
# ---------------------------------------------------------------------------

def cmd_append(args):
    conn = open_ledger()
    _, d = require_cypher(conn)

    action = args.action
    if action is None:
        if sys.stdin.isatty():
            action = input("action: ").strip()
        if not action:
            raise SystemExit("manjuel: an action is required (--action).")
    actor = args.actor or "operator"
    payload = args.payload if args.payload is not None else ""

    ts = now_utc()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        head = head_of(conn)
        parent = head["entry_hash"]
        entry_hash = compute_entry_hash(parent, ts, actor, action, payload)
        seal = keyed_hex(d["seal_key"], entry_hash.encode("ascii"))
        conn.execute(
            "INSERT INTO ledger (entry_hash, parent_hash, ts, actor, action, payload, seal) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (entry_hash, parent, ts, actor, action, payload, seal))
        seq = conn.execute("SELECT last_insert_rowid() AS s").fetchone()["s"]
    conn.close()
    print("Recorded. seq %d at %s" % (seq, ts))
    print("entry hash : %s" % entry_hash)
    print("parent     : %s" % parent)

# ---------------------------------------------------------------------------
# Verification — the two layers
# ---------------------------------------------------------------------------

def verify_public(conn) -> dict:
    """Layer one: anyone. Recompute the plain hash chain and its linkage."""
    rows = conn.execute("SELECT * FROM ledger ORDER BY seq ASC").fetchall()
    report = {"entries": len(rows), "intact": True, "breaks": []}
    prev_hash = ZERO_HASH
    for row in rows:
        if row["parent_hash"] != prev_hash:
            report["breaks"].append({"seq": row["seq"], "fault": "parent link broken"})
        if row["seq"] == 1:
            if row["action"] != "genesis" or row["parent_hash"] != ZERO_HASH:
                report["breaks"].append({"seq": 1, "fault": "malformed genesis"})
            # Genesis's hash derives from the cypher — only holders can recompute it.
        else:
            expect = compute_entry_hash(row["parent_hash"], row["ts"], row["actor"],
                                        row["action"], row["payload"])
            if expect != row["entry_hash"]:
                report["breaks"].append({"seq": row["seq"], "fault": "entry hash mismatch"})
        prev_hash = row["entry_hash"]
    report["intact"] = len(report["breaks"]) == 0
    report["head"] = rows[-1]["entry_hash"] if rows else None
    return report

def verify_holder(conn, d) -> dict:
    """Layer two: cypher-holders only. Genesis derivation plus every seal."""
    rows = conn.execute("SELECT * FROM ledger ORDER BY seq ASC").fetchall()
    report = {"entries": len(rows), "authentic": True, "breaks": []}
    for row in rows:
        if row["seq"] == 1 and row["entry_hash"] != d["genesis_hash"]:
            report["breaks"].append({"seq": 1, "fault": "genesis does not derive from this cypher"})
        expect_seal = keyed_hex(d["seal_key"], row["entry_hash"].encode("ascii"))
        if not secrets.compare_digest(expect_seal, row["seal"]):
            report["breaks"].append({"seq": row["seq"], "fault": "seal invalid"})
    report["authentic"] = len(report["breaks"]) == 0
    return report

def cmd_verify(args):
    conn = open_ledger(readonly=True)
    pub = verify_public(conn)
    print("chain    : %d entries" % pub["entries"])
    print("public   : %s" % ("INTACT — linkage and hashes verify" if pub["intact"] else "BROKEN"))
    for b in pub["breaks"]:
        print("           seq %d: %s" % (b["seq"], b["fault"]))
    if args.holder:
        _, d = require_cypher(conn)
        hold = verify_holder(conn, d)
        print("holder   : %s" % ("AUTHENTIC — genesis and every seal derive from the cypher"
                                 if hold["authentic"] else "NOT AUTHENTIC"))
        for b in hold["breaks"]:
            print("           seq %d: %s" % (b["seq"], b["fault"]))
        if not hold["authentic"]:
            sys.exit(2)
    if not pub["intact"]:
        sys.exit(2)

# ---------------------------------------------------------------------------
# The web mirror — read-only, GitHub-shaped, no write path whatsoever
# ---------------------------------------------------------------------------

CSS = """
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background:#0d1117; color:#e6edf3; font:15px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
a { color:#58a6ff; text-decoration:none; } a:hover { text-decoration:underline; }
.top { background:#010409; border-bottom:1px solid #30363d; padding:14px 24px; display:flex; align-items:baseline; gap:14px; }
.top .brand { font-weight:700; font-size:17px; color:#e6edf3; letter-spacing:.4px; }
.top .sub { color:#8b949e; font-size:13px; }
.top .nav { margin-left:auto; font-size:14px; }
.wrap { max-width: 980px; margin: 0 auto; padding: 24px; }
.stats { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
.stat { background:#161b22; border:1px solid #30363d; border-radius:6px; padding:10px 16px; }
.stat .k { color:#8b949e; font-size:12px; text-transform:uppercase; letter-spacing:.6px; }
.stat .v { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:14px; margin-top:2px; }
.box { background:#161b22; border:1px solid #30363d; border-radius:6px; overflow:hidden; }
.row { display:flex; gap:14px; align-items:baseline; padding:11px 16px; border-top:1px solid #21262d; }
.row:first-child { border-top:none; }
.row .action { font-weight:600; min-width:0; overflow-wrap:anywhere; }
.row .actor { color:#8b949e; font-size:13px; }
.row .ts { color:#8b949e; font-size:13px; margin-left:auto; white-space:nowrap; }
.row .hash { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; background:#0d1117; border:1px solid #30363d; border-radius:4px; padding:1px 8px; white-space:nowrap; }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap:anywhere; }
.kv { padding:10px 16px; border-top:1px solid #21262d; display:flex; gap:14px; }
.kv:first-child { border-top:none; }
.kv .k { color:#8b949e; width:110px; flex:none; font-size:13px; padding-top:1px; }
.kv .v { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13.5px; overflow-wrap:anywhere; }
pre.payload { background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:12px 14px; font-size:13px; overflow-x:auto; margin:4px 0 0; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
.ok { color:#3fb950; font-weight:600; } .bad { color:#f85149; font-weight:600; }
.note { color:#8b949e; font-size:13px; margin:16px 2px; }
.pager { margin-top:16px; display:flex; gap:10px; }
.pager a, .pager span.off { border:1px solid #30363d; border-radius:6px; padding:5px 14px; font-size:13px; }
.pager span.off { color:#484f58; }
h2 { font-size:16px; margin: 0 0 12px; font-weight:600; }
.genesis-tag { color:#d29922; font-size:12px; border:1px solid #d29922; border-radius:10px; padding:0 8px; white-space:nowrap; }
footer { color:#484f58; font-size:12.5px; text-align:center; padding:28px 0 20px; }
"""

def page(title, body):
    return ("<!doctype html><html lang='en'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<title>%s</title><style>%s</style></head><body>"
            "<div class='top'><span class='brand'>MANJUEL.US</span>"
            "<span class='sub'>the hash-chained ledger</span>"
            "<span class='nav'><a href='/'>chain</a> &nbsp;&nbsp; <a href='/verify'>verify</a></span></div>"
            "<div class='wrap'>%s</div>"
            "<footer>No files are hosted here. Only the chain.<br>"
            "Authenticity is verifiable only by the operator and those given the cypher.</footer>"
            "</body></html>" % (html.escape(title), CSS, body))

def short(h):
    return h[:12]

def row_html(row):
    tag = " <span class='genesis-tag'>block zero</span>" if row["seq"] == 1 else ""
    return ("<div class='row'>"
            "<span class='action'>%s%s</span>"
            "<span class='actor'>by %s · seq %d</span>"
            "<span class='ts'>%s</span>"
            "<a class='hash' href='/e/%s'>%s</a>"
            "</div>" % (html.escape(row["action"]), tag, html.escape(row["actor"]),
                        row["seq"], html.escape(row["ts"]), row["entry_hash"], short(row["entry_hash"])))

def home_html(conn, pagenum):
    total = conn.execute("SELECT COUNT(*) AS n FROM ledger").fetchone()["n"]
    created = get_meta(conn, "created") or "—"
    genesis = conn.execute("SELECT entry_hash FROM ledger WHERE seq = 1").fetchone()
    head = head_of(conn)
    offset = pagenum * PAGE_SIZE
    rows = conn.execute("SELECT * FROM ledger ORDER BY seq DESC LIMIT ? OFFSET ?",
                        (PAGE_SIZE + 1, offset)).fetchall()
    has_next = len(rows) > PAGE_SIZE
    rows = rows[:PAGE_SIZE]
    stats = ("<div class='stats'>"
             "<div class='stat'><div class='k'>entries</div><div class='v'>%d</div></div>"
             "<div class='stat'><div class='k'>genesis</div><div class='v'><a href='/e/%s'>%s…</a></div></div>"
             "<div class='stat'><div class='k'>head</div><div class='v'><a href='/e/%s'>%s…</a></div></div>"
             "<div class='stat'><div class='k'>cut</div><div class='v'>%s</div></div>"
             "</div>" % (total,
                         genesis["entry_hash"], short(genesis["entry_hash"]),
                         head["entry_hash"], short(head["entry_hash"]),
                         html.escape(created)))
    log = "<div class='box'>%s</div>" % "".join(row_html(r) for r in rows)
    prev_link = ("<a href='/?page=%d'>newer</a>" % (pagenum - 1)) if pagenum > 0 else "<span class='off'>newer</span>"
    next_link = ("<a href='/?page=%d'>older</a>" % (pagenum + 1)) if has_next else "<span class='off'>older</span>"
    pager = "<div class='pager'>%s%s</div>" % (prev_link, next_link)
    return page("manjuel.us — the chain", stats + "<h2>The chain</h2>" + log + pager)

def entry_html(conn, entry_hash):
    row = conn.execute("SELECT * FROM ledger WHERE entry_hash = ?", (entry_hash,)).fetchone()
    if row is None:
        return None
    parent = ("<a href='/e/%s'>%s</a>" % (row["parent_hash"], row["parent_hash"])
              if row["parent_hash"] != ZERO_HASH else row["parent_hash"] + " (nothing before block zero)")
    payload = row["payload"]
    try:
        payload = json.dumps(json.loads(payload), indent=2, sort_keys=True)
    except (ValueError, TypeError):
        pass
    body = ("<h2>Entry seq %d</h2><div class='box'>"
            "<div class='kv'><span class='k'>entry hash</span><span class='v'>%s</span></div>"
            "<div class='kv'><span class='k'>parent</span><span class='v'>%s</span></div>"
            "<div class='kv'><span class='k'>timestamp</span><span class='v'>%s</span></div>"
            "<div class='kv'><span class='k'>actor</span><span class='v'>%s</span></div>"
            "<div class='kv'><span class='k'>action</span><span class='v'>%s</span></div>"
            "<div class='kv'><span class='k'>seal</span><span class='v'>%s</span></div>"
            "</div>"
            "<p class='note'>The seal is a keyed BLAKE3 digest. It can be recomputed — and therefore "
            "verified — only with the cypher, which is held on paper and was never stored.</p>"
            "<h2>Payload</h2><pre class='payload'>%s</pre>"
            % (row["seq"], row["entry_hash"], parent, html.escape(row["ts"]),
               html.escape(row["actor"]), html.escape(row["action"]), row["seal"],
               html.escape(payload) if payload else "(empty)"))
    return page("manjuel.us — entry %s" % short(row["entry_hash"]), body)

def verify_page_html(conn):
    rep = verify_public(conn)
    status = ("<span class='ok'>INTACT</span> — every link and every entry hash verifies."
              if rep["intact"] else "<span class='bad'>BROKEN</span> — the chain does not verify.")
    breaks = "".join("<div class='kv'><span class='k'>seq %d</span><span class='v'>%s</span></div>"
                     % (b["seq"], html.escape(b["fault"])) for b in rep["breaks"])
    body = ("<h2>Public verification — run live, just now</h2>"
            "<div class='box'>"
            "<div class='kv'><span class='k'>entries</span><span class='v'>%d</span></div>"
            "<div class='kv'><span class='k'>chain</span><span class='v'>%s</span></div>"
            "<div class='kv'><span class='k'>head</span><span class='v'>%s</span></div>"
            "%s</div>"
            "<p class='note'>This proves integrity: nothing was altered or reordered after being "
            "recorded. It does not prove authenticity — the genesis hash and the per-entry seals "
            "derive from a cypher that exists only on paper. Verification of authorship belongs to "
            "the operator, and to whoever the operator hands the paper.</p>"
            % (rep["entries"], status, rep["head"] or "—", breaks))
    return page("manjuel.us — verify", body)

class Handler(BaseHTTPRequestHandler):
    server_version = "manjuel/1"
    protocol_version = "HTTP/1.1"

    def _cors_headers(self):
        # CORS applies to the /api/* routes only, and to exactly one origin.
        if CORS_ORIGIN and self.path.startswith("/api/"):
            return {"Access-Control-Allow-Origin": CORS_ORIGIN, "Vary": "Origin"}
        return {}

    def _send(self, code, body, ctype="text/html; charset=utf-8", extra=None):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, indent=1, sort_keys=True),
                   ctype="application/json; charset=utf-8", extra=self._cors_headers())

    def _not_found(self):
        self._send(404, page("manjuel.us — not found",
                             "<h2>Not on the chain</h2><p class='note'>Nothing here. "
                             "<a href='/'>Back to the chain.</a></p>"))

    def do_GET(self):
        try:
            conn = connect(readonly=True)
        except sqlite3.Error:
            self._send(503, page("manjuel.us", "<h2>The ledger is unreachable.</h2>"))
            return
        try:
            url = urlparse(self.path)
            path = url.path
            if path == "/":
                q = parse_qs(url.query)
                try:
                    pagenum = max(0, int(q.get("page", ["0"])[0]))
                except ValueError:
                    pagenum = 0
                self._send(200, home_html(conn, pagenum))
            elif path == "/verify":
                self._send(200, verify_page_html(conn))
            elif re.fullmatch(r"/e/[0-9a-f]{64}", path):
                out = entry_html(conn, path[3:])
                self._send(200, out) if out else self._not_found()
            elif path == "/api/verify":
                self._json(verify_public(conn))
            elif path == "/api/head":
                head = head_of(conn)
                self._json({"entries": conn.execute("SELECT COUNT(*) AS n FROM ledger").fetchone()["n"],
                            "head": dict(head) if head else None,
                            "protocol": get_meta(conn, "protocol")})
            elif path == "/api/chain":
                q = parse_qs(url.query)
                try:
                    after = int(q.get("after_seq", ["0"])[0])
                    limit = min(API_MAX_LIMIT, max(1, int(q.get("limit", ["100"])[0])))
                except ValueError:
                    self._json({"error": "after_seq and limit must be integers"}, code=400)
                    return
                rows = conn.execute("SELECT * FROM ledger WHERE seq > ? ORDER BY seq ASC LIMIT ?",
                                    (after, limit)).fetchall()
                self._json({"entries": [dict(r) for r in rows],
                            "next_after_seq": rows[-1]["seq"] if rows else after})
            elif re.fullmatch(r"/api/entry/[0-9a-f]{64}", path):
                row = conn.execute("SELECT * FROM ledger WHERE entry_hash = ?",
                                   (path[len("/api/entry/"):],)).fetchone()
                self._json(dict(row)) if row else self._json({"error": "not on the chain"}, code=404)
            else:
                self._not_found()
        finally:
            conn.close()

    def do_HEAD(self):
        self.do_GET()

    def do_OPTIONS(self):
        # Read-only preflight courtesy. Still no write path.
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, OPTIONS")
        cors = self._cors_headers()
        if cors:
            cors["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
            cors["Access-Control-Max-Age"] = "86400"
        for k, v in cors.items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # There is no write path. Every non-read method is refused outright.
    def _refuse(self):
        self._json({"error": "this mirror is read-only; the chain is written only on the estate"},
                   code=405)
    do_POST = do_PUT = do_DELETE = do_PATCH = _refuse

    def log_message(self, fmt, *fargs):
        sys.stderr.write("[%s] %s\n" % (now_utc(), fmt % fargs))

def cmd_serve(args):
    global CORS_ORIGIN
    open_ledger(readonly=True).close()  # fail fast, and prove read access works
    CORS_ORIGIN = args.cors_origin
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print("manjuel.us mirror — read-only — http://%s:%d" % (args.host, args.port), flush=True)
    print("ledger: %s" % DB_PATH, flush=True)
    if CORS_ORIGIN:
        print("cors: /api/* readable by %s" % CORS_ORIGIN, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nmirror down. The chain is unaffected.")

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        prog="manjuel_us.py",
        description="MANJUEL.US — the hash-chained ledger. No files hosted; only the chain.")
    sub = ap.add_subparsers(dest="command", required=True)

    sub.add_parser("genesis", help="generate the paper cypher and cut block zero (once, ever)")

    p_append = sub.add_parser("append", help="record an entry (asks for the cypher; estate only)")
    p_append.add_argument("--action", help="what happened (required)")
    p_append.add_argument("--actor", help="who did it (default: operator)")
    p_append.add_argument("--payload", help="details, plain text or JSON (default: empty)")

    p_verify = sub.add_parser("verify", help="walk the chain and verify it")
    p_verify.add_argument("--holder", action="store_true",
                          help="also verify genesis + seals with the paper cypher")

    p_serve = sub.add_parser("serve", help="run the read-only web mirror")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8000)
    p_serve.add_argument("--cors-origin", default=None, metavar="ORIGIN",
                         help="allow this ONE origin (e.g. https://manjuel.us) to read /api/*")

    args = ap.parse_args()
    {"genesis": cmd_genesis, "append": cmd_append,
     "verify": cmd_verify, "serve": cmd_serve}[args.command](args)

if __name__ == "__main__":
    main()
