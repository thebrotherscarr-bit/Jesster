# -*- coding: utf-8 -*-
"""
GATEWAY — every model you talk to, briefed by your notes and remembered.

Point a tool's model endpoint at the kernel instead of the model:

    OpenAI-style clients   base URL  http://localhost:8765/v1
    Ollama-style clients   host      http://localhost:8765

The gateway forwards each request to the real model (your local Ollama by
default; any OpenAI-compatible service by name) and, on the way:

  brief     prepends a system message: what you are working on lately, and
            the passages in the vault most relevant to your last message
  capture   appends the exchange (your message, the model's answer) to today's
            capture note for that tool — which is indexed like everything
            else, so the next model knows about it too

Streaming is passed through as it arrives. Per request, the header
`X-SecondBrain: off` turns both off, `X-SecondBrain-Capture: off` only the
capture, and `X-SecondBrain-Source: <name>` names the tool in the notes.
`X-SecondBrain-Upstream: <name>`, or a base URL of
http://localhost:8765/u/<name>/v1 for tools that cannot set headers, picks a
service from the vault config's `gateway_upstreams`
({"openai": "https://api.openai.com", "openrouter": "https://openrouter.ai/api"});
the client's own Authorization header is passed through to it and never stored.
"""
import json
import sys
import urllib.error
import urllib.request

PREFIX = ("The following is context from the user's own second brain (their notes and "
          "past conversations with AI tools). Use it when it is relevant; do not "
          "mention it otherwise.\n\n")
HOP = {"host", "content-length", "connection", "accept-encoding", "keep-alive",
       "transfer-encoding", "upgrade", "x-jesster-token"}
CHAT_PATHS = ("/v1/chat/completions", "/api/chat", "/api/generate")
TIMEOUT = 600


def is_gateway_path(path):
    return path.startswith(("/v1/", "/api/", "/u/"))


def split_upstream(path):
    """/u/<name>/v1/... -> ("<name>", "/v1/...")."""
    if path.startswith("/u/"):
        name, _, rest = path[3:].partition("/")
        return name, "/" + rest
    return None, path


def _text(content):
    """Message content as text: a string, or OpenAI-style parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content
                         if isinstance(p, dict) and p.get("type") in ("text", "input_text"))
    return ""


def last_user(body, path):
    if path == "/api/generate":
        return body.get("prompt") or ""
    for m in reversed(body.get("messages") or []):
        if m.get("role") == "user":
            return _text(m.get("content"))
    return ""


def brief(body, path, ctx):
    if not ctx:
        return body
    body = dict(body)
    if path == "/api/generate":
        body["system"] = PREFIX + ctx + ("\n\n" + body["system"] if body.get("system") else "")
    else:
        body["messages"] = [{"role": "system", "content": PREFIX + ctx}] + list(body.get("messages") or [])
    return body


def piece(line):
    """The answer text carried by one line of a streamed (or whole) reply."""
    line = line.strip()
    if line.startswith("data:"):
        line = line[5:].strip()
        if line == "[DONE]":
            return ""
    if not line.startswith("{"):
        return ""
    try:
        o = json.loads(line)
    except ValueError:
        return ""
    if "choices" in o:
        ch = (o.get("choices") or [{}])[0]
        return (ch.get("delta") or {}).get("content") or (ch.get("message") or {}).get("content") or ""
    if "message" in o:
        return (o.get("message") or {}).get("content") or ""
    return o.get("response") or ""


def upstream_base(kernel, name):
    ups = kernel.config.get("gateway_upstreams") or {}
    if name:
        if name not in ups:
            return None
        return ups[name].rstrip("/")
    return (kernel.config.get("gateway_upstream") or kernel.config["ollama_url"]).rstrip("/")


def handle(h, kernel, strip_auth=False):
    """Serve one gateway request on BaseHTTPRequestHandler `h`. With
    `strip_auth`, the Authorization header carried the kernel's own token and
    is not passed on to the model."""
    path = h.path.split("?", 1)[0]
    query = h.path[len(path):]
    hdr = {k.lower(): v for k, v in h.headers.items()}
    named, path = split_upstream(path)
    named = named or hdr.get("x-secondbrain-upstream")
    base = upstream_base(kernel, named)
    if not base:
        return h._send(400, {"error": "unknown upstream %r (gateway_upstreams in the vault "
                                      "config)" % named})
    raw = b""
    if h.command == "POST":
        n = int(h.headers.get("Content-Length") or 0)
        raw = h.rfile.read(n) if n else b""
    on = hdr.get("x-secondbrain", "on").lower() != "off"
    capture = on and hdr.get("x-secondbrain-capture", "on").lower() != "off"
    body, question, model = None, "", None
    if h.command == "POST" and path in CHAT_PATHS:
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return h._send(400, {"error": "body is not JSON"})
        model = body.get("model")
        question = last_user(body, path)
        if on and question:
            try:
                ctx = kernel.call("context.for", {"q": question})["text"]
                raw = json.dumps(brief(body, path, ctx)).encode("utf-8")
            except Exception as e:                       # never block the model on notes
                print("  gateway — no briefing: %s" % e, file=sys.stderr)
    fwd = {k: v for k, v in h.headers.items()
           if k.lower() not in HOP and not k.lower().startswith("x-secondbrain")}
    if strip_auth:
        fwd = {k: v for k, v in fwd.items() if k.lower() != "authorization"}
    req = urllib.request.Request(base + path + query, data=raw if h.command == "POST" else None,
                                 headers=fwd, method=h.command)
    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as e:
        data = e.read()
        h.send_response(e.code)
        h.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
        h.send_header("Content-Length", str(len(data)))
        h.end_headers()
        h.wfile.write(data)
        return
    except (urllib.error.URLError, OSError) as e:
        return h._send(502, {"error": "upstream %s did not answer: %s" % (base, e)})
    answer = []
    with resp:
        h.send_response(resp.status)
        for k, v in resp.headers.items():
            if k.lower() not in HOP and k.lower() not in ("content-length", "date", "server"):
                h.send_header(k, v)
        h.send_header("Connection", "close")
        h.end_headers()
        h.close_connection = True
        streaming = body is not None and body.get("stream", path != "/v1/chat/completions")
        if streaming:
            for line in resp:                        # SSE or NDJSON, line by line
                h.wfile.write(line)
                h.wfile.flush()
                if capture:
                    answer.append(piece(line.decode("utf-8", "replace")))
        else:
            data = resp.read()
            h.wfile.write(data)
            if capture and body is not None:
                answer.append(piece(data.decode("utf-8", "replace").replace("\n", " ")))
    # agents (OpenCode, Continue) send many tool-call steps with no text:
    # only exchanges that said something are worth remembering
    if capture and body is not None and question and "".join(answer).strip():
        source = hdr.get("x-secondbrain-source") or (hdr.get("user-agent") or "gateway").split("/")[0].split(" ")[0]
        try:
            kernel.call("capture.append", {"source": source or "gateway", "user": question,
                                           "assistant": "".join(answer), "model": model})
        except Exception as e:
            print("  gateway — not captured: %s" % e, file=sys.stderr)

