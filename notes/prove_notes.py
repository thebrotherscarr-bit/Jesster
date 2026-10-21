#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""prove_notes — the notes microkernel's own proof.

Asserts, in scratch vaults:
  1. notes round-trip through Markdown on disk, links and backlinks resolve
  2. every save is deposited on the vault's chain; the chain walks intact
  3. SEALED deposits never carry a note's words; OPEN ones do
  4. an edit made outside the kernel is caught by provenance.check
  5. a stale edit (wrong base hash) is refused, never merged silently
  6. remove moves to trash, and the removal is itself deposited
  7. folder and JSON imports keep titles and tags, and re-running skips
  8. the language model is called on loopback with the right notes (fake Ollama)
  9. JSON-RPC and MCP on stdio answer, and refuse what they should
 10. HTTP: wrong Host, wrong Content-Type, missing token, path escapes refused
 11. ChatGPT, Claude, Gemini and Claude Code exports become notes; again is a no-op
 12. the index finds passages by keyword, and by meaning once vectors exist
 13. the gateway briefs the model from the vault, streams, and captures the exchange
Run:  python notes/prove_notes.py   (exit 0 = the kernel is safe to use)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from kernel import KernelError, open_kernel     # noqa: E402

FAILS = []


def ck(name, ok, detail=""):
    print("    [%s]  %s%s" % ("PASS" if ok else "FAIL", name,
                              ("   " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def refused(fn, code):
    try:
        fn()
    except KernelError as e:
        return e.code == code
    return False


def fresh(root, name, **cfg):
    cfg.setdefault("actor", "prover")
    return open_kernel(os.path.join(root, name), cfg)


def prove_core(root):
    print("== notes and the chain ==")
    k = fresh(root, "core")
    a = k.call("notes.create", {"title": "Alpha: \"quoted\"", "body": "see [[Beta]]",
                                "tags": ["#One", "two", "two"]})
    k.call("notes.create", {"title": "Beta", "body": "secret words here"})
    k.vault.reload()                               # read back from disk only
    n = k.call("notes.get", {"id": a["id"]})
    ck("title survives the disk", n["title"] == 'Alpha: "quoted"', n["title"])
    ck("tags are cleaned", n["tags"] == ["one", "two"], n["tags"])
    ck("wikilinks resolve", n["links"] == ["beta"], n["links"])
    ck("backlinks resolve", k.call("notes.get", {"id": "beta"})["backlinks"] == [a["id"]])
    ck("search finds bodies", [h["id"] for h in k.call("notes.search", {"q": "secret"})] == ["beta"])

    v = k.call("provenance.verify")
    ck("every save deposited", v["intact"] and v["links"] == 2, v)
    chain = open(os.path.join(k.vault.meta, "notes.jsonl"), encoding="utf-8").read()
    ck("sealed deposits carry no words", "secret words" not in chain)

    b = k.call("notes.get", {"id": "beta"})
    ck("stale edit refused", refused(lambda: k.call(
        "notes.update", {"id": "beta", "body": "x", "base": "0" * 64}), "conflict"))
    k.call("notes.update", {"id": "beta", "body": "new words", "base": b["hash"]})
    h = k.call("provenance.history", {"id": "beta"})
    ck("versions cite the one before", len(h) == 2 and h[1]["says"].startswith("note beta v2"), h)
    ck("unchanged save deposits nothing",
       k.call("notes.update", {"id": "beta", "body": "new words"}).get("unchanged") is True
       and k.call("provenance.verify")["links"] == 3)
    ck("on-disk note matches its last link", k.call("provenance.check", {"id": "beta"})["witnessed"])

    with open(k.vault.path("beta"), "a", encoding="utf-8", newline="\n") as f:
        f.write("\ntampered")
    k.vault.reload()
    ck("an outside edit is caught", not k.call("provenance.check", {"id": "beta"})["witnessed"])
    k.call("provenance.witness", {"id": "beta"})
    ck("and can be witnessed after", k.call("provenance.check", {"id": "beta"})["witnessed"])

    r = k.call("notes.remove", {"id": "beta"})
    ck("remove goes to trash", os.path.exists(r["trash"]) and "beta" not in k.vault.notes)
    ck("removal is deposited", k.call("provenance.history", {"id": "beta"})[-1]["says"]
       .startswith("note beta removed"))
    ck("chain still walks", k.call("provenance.verify")["intact"])

    lines = open(os.path.join(k.vault.meta, "notes.jsonl"), encoding="utf-8").read().splitlines()
    e = json.loads(lines[0])
    e["actor"] = "someone else"
    lines[0] = json.dumps(e, ensure_ascii=False)
    with open(os.path.join(k.vault.meta, "notes.jsonl"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    ck("a rewritten actor breaks the chain", not fresh(root, "core").call("provenance.verify")["intact"])

    o = fresh(root, "open", provenance="open")
    o.call("notes.create", {"title": "Open", "body": "prior art words"})
    ck("open deposits carry the note", "prior art words" in open(
        os.path.join(o.vault.meta, "notes.jsonl"), encoding="utf-8").read())

    anon = open_kernel(os.path.join(root, "anon"))
    ck("no actor, no deposit", refused(lambda: anon.call(
        "notes.create", {"title": "x"}), "no_actor"))
    ck("ids cannot escape the vault", refused(lambda: k.call(
        "notes.get", {"id": "../core"}), "bad_id") or refused(lambda: k.call(
        "notes.get", {"id": "../core"}), "not_found"))
    ck("unknown params refused", refused(lambda: k.call(
        "notes.list", {"bogus": 1}), "bad_params"))


def prove_two_processes(root):
    print("== two processes, one vault ==")
    a = fresh(root, "shared")
    b = fresh(root, "shared")                      # the CLI / an MCP agent beside the server
    a.call("notes.create", {"title": "From A", "body": "a"})
    b.call("notes.create", {"title": "From B", "body": "b"})
    a.call("notes.create", {"title": "From A again", "body": "a2"})
    b.call("notes.update", {"id": "from-a", "body": "b edited a's note"})
    v = a.call("provenance.verify")
    ck("interleaved writers keep one chain", v["intact"] and v["links"] == 4, v)
    a._scanned = 0
    body = a.call("notes.get", {"id": "from-a"})["body"]    # the call rescans
    ck("the server sees the other process's notes",
       "from-b" in a.vault.notes and body == "b edited a's note")
    ck("and their history cites across processes",
       len(a.call("provenance.history", {"id": "from-a"})) == 2)
    p0 = a.call("live.poll", {"since": 0})
    os.unlink(b.vault.path("from-b"))
    a._scanned = 0
    p1 = a.call("live.poll", {"since": p0["seq"]})
    ck("files removed outside the kernel are noticed", p1["changed"] == ["from-b"], p1)


def prove_import(root):
    print("== imports ==")
    src = os.path.join(root, "src")
    os.makedirs(os.path.join(src, "Work", "Q3"))
    with open(os.path.join(src, "a.md"), "w", encoding="utf-8") as f:
        f.write("---\ntitle: From Front Matter\ntags: [x, y]\n---\nbody a")
    with open(os.path.join(src, "Work", "Q3", "b.md"), "w", encoding="utf-8") as f:
        f.write("# Heading Title\r\nbody b")
    with open(os.path.join(src, "Work", "skip.png"), "wb") as f:
        f.write(b"\x89PNG")
    k = fresh(root, "imp")
    r = k.call("import.folder", {"path": src, "tag": "secondbrain"})
    ck("folder import counts", r["imported"] == 2 and not r["failed"], r)
    titles = {n["title"]: n["tags"] for n in k.vault.notes.values()}
    ck("front matter kept", titles.get("From Front Matter") == ["x", "y", "secondbrain"], titles)
    ck("heading becomes title, folders become tags",
       titles.get("Heading Title") == ["work", "q3", "secondbrain"], titles)
    ck("re-import skips", k.call("import.folder", {"path": src})["skipped"] == 2)
    ck("vault cannot import itself", refused(lambda: k.call(
        "import.folder", {"path": k.vault.root}), "bad_params"))

    j = os.path.join(root, "export.json")
    with open(j, "w", encoding="utf-8") as f:
        json.dump({"notes": [{"title": "J1", "content": "json body", "tags": "p,q"},
                             {"text": "untitled text"}, 5]}, f)
    r = k.call("import.json", {"path": j})
    ck("json import", r["imported"] == 2 and len(r["failed"]) == 1, r)


def prove_llm(root):
    print("== the local model ==")
    seen = {}

    class Fake(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.update(body)
            out = json.dumps({"message": {"role": "assistant",
                                          "content": "It is blue [sky]."}}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        k = fresh(root, "llm", ollama_url="http://127.0.0.1:%d" % srv.server_port)
        k.call("notes.create", {"title": "Sky", "body": "the sky is blue"})
        k.call("notes.create", {"title": "Grass", "body": "grass is green"})
        r = k.call("llm.ask", {"q": "what colour is the sky"})
        ck("answer comes back with sources", r["sources"] == ["sky"] and "blue" in r["answer"], r)
        ck("the default model is gpt-oss", seen.get("model", "").startswith("gpt-oss"), seen.get("model"))
        ck("only matching notes are sent", "grass" not in json.dumps(seen["messages"]))
    finally:
        srv.shutdown()
    dead = fresh(root, "llm2", ollama_url="http://127.0.0.1:9")
    dead.call("notes.create", {"title": "hello", "body": "hello world"})
    ck("a missing Ollama is said plainly",
       refused(lambda: dead.call("llm.ask", {"q": "hello"}), "llm_unreachable"))


def run_stdio(vault, mode, msgs):
    p = subprocess.run([sys.executable, os.path.join(HERE, "cli.py"), "--vault", vault, mode],
                       input="\n".join(json.dumps(m) for m in msgs) + "\n",
                       capture_output=True, text=True, encoding="utf-8", timeout=60)
    return [json.loads(l) for l in p.stdout.splitlines() if l.strip()]


def prove_stdio(root):
    print("== stdio: json-rpc and mcp ==")
    v = os.path.join(root, "io")
    io = fresh(root, "io")
    io.save_config(actor="prover")                 # the subprocess reads it from disk
    io.call("notes.create", {"title": "Hello", "body": "world"})
    out = run_stdio(v, "rpc", [
        {"jsonrpc": "2.0", "id": 1, "method": "notes.search", "params": {"q": "world"}},
        {"jsonrpc": "2.0", "id": 2, "method": "no.such"},
        {"jsonrpc": "2.0", "method": "kernel.info"}])
    ck("rpc answers", out[0]["result"][0]["id"] == "hello", out)
    ck("rpc refuses unknown methods", out[1]["error"]["code"] == -32601)
    ck("rpc notifications get no reply", len(out) == 2)

    out = run_stdio(v, "mcp", [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
         "params": {"name": "notes_create", "arguments": {"title": "From agent"}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
         "params": {"name": "notes_get", "arguments": {"id": "missing"}}}])
    names = [t["name"] for t in out[1]["result"]["tools"]]
    ck("mcp initializes", out[0]["result"]["serverInfo"]["name"] == "jesster-notes")
    ck("mcp lists every method as a tool", {"notes_create", "llm_ask", "provenance_verify",
                                            "import_folder"} <= set(names), names)
    ck("mcp tools write", out[2]["result"]["structuredContent"]["id"] == "from-agent")
    ck("mcp errors are tool errors", out[3]["result"]["isError"] is True)


def prove_http(root):
    print("== http ==")
    import serve as srvmod
    from http.server import ThreadingHTTPServer
    k = fresh(root, "web")
    k.call("notes.create", {"title": "Web", "body": "page"})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), srvmod.make_handler(
        k, "s3cret", set(srvmod.LOOPBACK), srvmod.PWA_DIR))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % httpd.server_port

    def req(path, data=None, headers=None):
        r = urllib.request.Request(base + path, data=data, headers=headers or {})
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "notes.list"}).encode()
    try:
        ck("the PWA is served", req("/")[0] == 200 and b"Jesster Notes" in req("/")[1])
        ck("no token, no notes", req("/rpc", body, {"Content-Type": "application/json"})[0] == 401)
        s, out = req("/rpc", body, {"Content-Type": "application/json",
                                    "Authorization": "Bearer s3cret"})
        ck("token opens /rpc", s == 200 and json.loads(out)["result"][0]["id"] == "web")
        ck("text/plain refused", req("/rpc", body, {"Content-Type": "text/plain",
                                                    "Authorization": "Bearer s3cret"})[0] == 415)
        ck("foreign Host refused", req("/", headers={"Host": "evil.example"})[0] == 421)
        ck("no path escape", req("/../notes/kernel.py")[0] == 404
           and req("/%2e%2e/notes/kernel.py")[0] == 404)
    finally:
        httpd.shutdown()
    try:
        srvmod.serve(k, host="0.0.0.0", port=0, token=None)
        ck("no wide bind without a token", False)
    except SystemExit:
        ck("no wide bind without a token", True)


class FakeOllama(BaseHTTPRequestHandler):
    """Embeddings: a bag of words hashed into 64 dims, with 'rate limit' and
    '429' deliberately sharing a dimension so meaning can beat keywords.
    Chat: answers, streaming or not, in Ollama's or OpenAI's shape."""
    seen = []

    def vec(self, text):
        import hashlib as hl
        v = [0.0] * 64
        for w in tokens_of(text):
            w = {"429": "ratelimit", "429s": "ratelimit", "throttled": "ratelimit"}.get(w, w)
            v[int(hl.md5(w.encode()).hexdigest(), 16) % 64] += 1.0
        return v

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeOllama.seen.append((self.path, body, dict(self.headers)))
        if self.path == "/api/embed":
            return self.out({"embeddings": [self.vec(t) for t in body["input"]]})
        sys_msg = next((m["content"] for m in body.get("messages", []) if m["role"] == "system"), "")
        answer = "briefed" if "second brain" in sys_msg else "unbriefed"
        if self.path == "/v1/chat/completions":
            if body.get("stream"):
                lines = ["data: " + json.dumps({"choices": [{"delta": {"content": w}}]})
                         for w in (answer[:4], answer[4:])] + ["data: [DONE]"]
                return self.stream("text/event-stream", [l + "\n\n" for l in lines])
            return self.out({"choices": [{"message": {"role": "assistant", "content": answer}}]})
        if body.get("stream", True):
            return self.stream("application/x-ndjson",
                               [json.dumps({"message": {"content": w}, "done": False}) + "\n"
                                for w in (answer[:4], answer[4:])] +
                               [json.dumps({"done": True}) + "\n"])
        return self.out({"message": {"role": "assistant", "content": answer}})

    def do_GET(self):
        return self.out({"models": [{"name": "gpt-oss:20b"}]})

    def out(self, obj):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def stream(self, ctype, chunks):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        for c in chunks:
            self.wfile.write(c.encode())
            self.wfile.flush()

    def log_message(self, *a):
        pass


def tokens_of(text):
    import re as _re
    return _re.findall(r"[a-z0-9]+", text.lower())


def write_exports(d):
    os.makedirs(os.path.join(d, "Takeout", "My Activity", "Gemini Apps"))
    os.makedirs(os.path.join(d, "claude"))
    os.makedirs(os.path.join(d, "cc"))
    chatgpt = [{"title": "Retries", "conversation_id": "c1", "create_time": 1760000000.0,
                "current_node": "n2", "mapping": {
                    "n1": {"parent": None, "children": ["n2", "x"], "message": {
                        "author": {"role": "user"}, "content": {"content_type": "text",
                        "parts": ["the API keeps returning 429s"]}, "metadata": {}}},
                    "x": {"parent": "n1", "children": [], "message": {
                        "author": {"role": "assistant"}, "content": {"content_type": "text",
                        "parts": ["abandoned branch"]}, "metadata": {}}},
                    "n2": {"parent": "n1", "children": [], "message": {
                        "author": {"role": "assistant"}, "content": {"content_type": "text",
                        "parts": ["back off exponentially and honour Retry-After"]},
                        "metadata": {"model_slug": "gpt-4o"}}}}}]
    claude = [{"uuid": "u1", "name": "Wraps", "created_at": "2026-08-01T10:00:00Z",
               "chat_messages": [{"sender": "human", "text": "why forty links per wrap",
                                  "created_at": "2026-08-01T10:00:00Z"},
                                 {"sender": "assistant", "text": "", "content": [
                                     {"type": "text", "text": "so nobody chooses issuance"}]}]}]
    gemini = [{"header": "Gemini Apps", "title": "Prompted what is a merkle root",
               "time": "2026-09-02T08:00:00Z", "products": ["Gemini Apps"],
               "safeHtmlItem": [{"html": "<p>the <b>top</b> hash</p>"}]}]
    cc = [{"type": "summary", "summary": "Gate fix"},
          {"type": "user", "sessionId": "s1", "cwd": "/w/Jesster", "message": {
              "role": "user", "content": "the merge gate deadlocks"}},
          {"type": "assistant", "sessionId": "s1", "message": {"role": "assistant", "content": [
              {"type": "text", "text": "use the nocheck ruleset"}, {"type": "tool_use", "name": "Edit"}]}}]
    import zipfile
    with zipfile.ZipFile(os.path.join(d, "chatgpt-export.zip"), "w") as z:
        z.writestr("conversations.json", json.dumps(chatgpt))
    json.dump(claude, open(os.path.join(d, "claude", "conversations.json"), "w"))
    json.dump(gemini, open(os.path.join(d, "Takeout", "My Activity", "Gemini Apps",
                                        "MyActivity.json"), "w"))
    open(os.path.join(d, "cc", "s1.jsonl"), "w").write("\n".join(json.dumps(x) for x in cc))


def prove_ingest_index_gateway(root):
    print("== ingest, index, gateway ==")
    srv = HTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d" % srv.server_port
    exports = os.path.join(root, "exports")
    write_exports(exports)
    k = fresh(root, "brain", ollama_url=url)
    try:
        r = k.call("ingest.path", {"path": exports})
        ck("every source becomes notes", r["by_source"] == {"chatgpt": 1, "claude": 1,
           "gemini": 1, "claude-code": 1} and not r["failed"], r)
        gpt = next(n for n in k.vault.notes.values() if "chatgpt" in n["tags"])
        ck("the branch you kept, not the one you abandoned",
           "Retry-After" in gpt["body"] and "abandoned" not in gpt["body"])
        cc = next(n for n in k.vault.notes.values() if "claude-code" in n["tags"])
        ck("Claude Code sessions keep their project", "project-jesster" in cc["tags"]
           and cc["title"] == "Gate fix", cc["tags"])
        ck("ingesting again changes nothing",
           k.call("ingest.path", {"path": exports})["skipped"] == 4)
        ck("and deposits nothing", k.call("provenance.verify")["links"] == 4)

        hits = k.call("index.search", {"q": "merkle root"})
        ck("keyword search finds the passage", hits["results"][0]["note"].startswith("chat-gemini"))
        ck("before vectors, meaning is not searched",
           not any(h["note"] == gpt["id"] for h in
                   k.call("index.search", {"q": "throttled"})["results"]))
        e = k.call("index.embed")
        ck("vectors for every chunk", e["remaining"] == 0 and e["embedded"] >= 4, e)
        hy = k.call("index.search", {"q": "throttled"})
        ck("with vectors, meaning finds it", hy["mode"] == "hybrid" and
           hy["results"] and hy["results"][0]["note"] == gpt["id"], hy)
        k.call("notes.update", {"id": gpt["id"], "body": gpt["body"] + "\n\nnew words"})
        ck("the index follows edits", k.call("index.search", {"q": "new words",
           "mode": "keyword"})["results"][0]["note"] == gpt["id"])

        ctx = k.call("context.for", {"q": "429 retries"})
        ck("a briefing holds recent work and the relevant passage",
           "Recently worked on" in ctx["text"] and gpt["id"] in ctx["sources"], ctx["sources"])

        import serve as srvmod
        from http.server import ThreadingHTTPServer
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), srvmod.make_handler(
            k, None, set(srvmod.LOOPBACK), srvmod.PWA_DIR))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        gw = "http://127.0.0.1:%d" % httpd.server_port

        def post(path, obj, **headers):
            req = urllib.request.Request(gw + path, data=json.dumps(obj).encode(),
                                         headers=dict({"Content-Type": "application/json"}, **headers))
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.read().decode()

        FakeOllama.seen.clear()
        out = post("/api/chat", {"model": "gpt-oss:20b", "messages": [
            {"role": "user", "content": "how do I handle 429s"}]},
            **{"X-SecondBrain-Source": "cursor", "Authorization": "Bearer sk-test"})
        ck("ollama-style: streamed through, briefed", "brie" in out and "fed" in out)
        sent = FakeOllama.seen[-1]
        ck("the model got the vault's context", "Retry-After" in json.dumps(sent[1]))
        ck("the client's key goes to the model", sent[2].get("Authorization") == "Bearer sk-test")
        out = post("/v1/chat/completions", {"model": "gpt-oss:20b", "stream": True,
                   "messages": [{"role": "user", "content": "what is a merkle root"}]},
                   **{"X-SecondBrain-Source": "cursor"})
        ck("openai-style SSE passes through", "data: [DONE]" in out)
        out = json.loads(post("/v1/chat/completions", {"model": "gpt-oss:20b",
                         "messages": [{"role": "user", "content": "hello"}]},
                         **{"X-SecondBrain": "off"}))
        ck("X-SecondBrain: off is a plain proxy",
           out["choices"][0]["message"]["content"] == "unbriefed")
        k.save_config(gateway_upstreams={"fake": url})
        out = json.loads(post("/u/fake/v1/chat/completions", {"model": "m", "messages": [
            {"role": "user", "content": "hi"}]}, **{"X-SecondBrain-Capture": "off"}))
        ck("/u/<name>/v1 picks a named service", out["choices"][0]["message"]["content"] == "briefed")
        try:
            post("/u/nope/v1/chat/completions", {"messages": []})
            ck("an unknown service is refused", False)
        except urllib.error.HTTPError as e:
            ck("an unknown service is refused", e.code == 400)
        k._scanned = 0
        cap = [n for n in k.vault.notes.values() if "capture" in n["tags"]]
        ck("exchanges are captured, one note per tool per day",
           len(cap) == 1 and cap[0]["body"].count("**You:**") == 2
           and "briefed" in cap[0]["body"], [c["id"] for c in cap])
        ck("captures are searchable next time",
           k.call("index.search", {"q": "merkle", "tag": "capture"})["results"])
        httpd.shutdown()
    finally:
        srv.shutdown()


def main():
    root = tempfile.mkdtemp(prefix="prove-notes-")
    try:
        prove_core(root)
        prove_two_processes(root)
        prove_import(root)
        prove_llm(root)
        prove_stdio(root)
        prove_http(root)
        prove_ingest_index_gateway(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print()
    if FAILS:
        print("  %d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
        return 1
    print("  PROVEN. Notes are plain files, every save is on the chain, and "
          "every surface goes through the same door.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
