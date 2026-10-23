# -*- coding: utf-8 -*-
"""
SERVE — the kernel over HTTP, and the PWA beside it.

  GET  /            the PWA: secondbrain's UI (../secondbrain/dist) once it is
                    built, otherwise the plain one in ../pwa. --ui picks another.
  POST /rpc         JSON-RPC 2.0 into the kernel — the same door as stdio
  GET  /health      {"ok": true, ...}
  /v1/*, /api/*     the model gateway (gateway.py): OpenAI- and Ollama-style
                    endpoints that brief each model from the vault and
                    capture what was said

Loopback by default. It holds your notes, so it is careful about who asks:

  * the Host header must name this server — a web page elsewhere cannot
    rebind a hostname onto it (DNS rebinding);
  * /rpc takes only application/json, which a cross-site form cannot send,
    and answers no CORS preflight, so other origins cannot call it;
  * with a token set (--token or JESSTER_NOTES_TOKEN), /rpc also needs
    `Authorization: Bearer <token>`. Required when binding beyond loopback.
"""
import hmac
import json
import mimetypes
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import gateway
from kernel import VERSION
from stdio import rpc_one, _err

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PWA_DIR = os.path.join(_REPO, "pwa")
SECONDBRAIN_DIST = os.path.join(_REPO, "secondbrain", "dist")


def default_ui():
    built = os.path.join(SECONDBRAIN_DIST, "index.html")
    return SECONDBRAIN_DIST if os.path.isfile(built) else PWA_DIR
MAX_BODY = 8 * 1024 * 1024
LOOPBACK = ("127.0.0.1", "localhost", "::1")

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")


def _origin(url):
    """scheme://host:port of a URL, for the CSP — the UI may talk to Ollama."""
    from urllib.parse import urlsplit
    u = urlsplit(url or "")
    return "%s://%s" % (u.scheme, u.netloc) if u.scheme in ("http", "https") and u.netloc else ""


def make_handler(kernel, token, hosts, ui_dir=None):
    ui_dir = os.path.realpath(ui_dir or default_ui())
    ollama = _origin(kernel.config.get("ollama_url"))
    csp = ("default-src 'self'; style-src 'self' 'unsafe-inline'; "
           "img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self'; "
           # Ollama on any loopback port (the UI lets you change it), plus
           # the configured host if that is elsewhere
           "connect-src 'self' http://localhost:* http://127.0.0.1:*%s"
           % ((" " + ollama) if ollama else ""))

    class Handler(BaseHTTPRequestHandler):
        server_version = "jesster-notes/" + VERSION

        def _send(self, code, body, ctype="application/json; charset=utf-8", cache="no-store"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", csp)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _host_ok(self):
            h = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
            return h in hosts

        def _gateway(self):
            """Auth for the gateway: the kernel's token (when set) arrives as
            X-Jesster-Token, or as the bearer token — then it is not passed on."""
            strip = False
            if token:
                got = self.headers.get("X-Jesster-Token") or ""
                bearer = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
                if hmac.compare_digest(bearer.encode(), token.encode()):
                    strip = True
                elif not hmac.compare_digest(got.encode(), token.encode()):
                    return self._send(401, {"error": "token required (X-Jesster-Token)"})
            if self.command == "POST" and not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return self._send(415, {"error": "application/json only"})
            gateway.handle(self, kernel, strip)

        def do_GET(self):
            if not self._host_ok():
                return self._send(421, {"error": "unknown host"})
            path = self.path.split("?", 1)[0]
            if gateway.is_gateway_path(path):
                return self._gateway()
            if path == "/health":
                return self._send(200, {"ok": True, "version": VERSION,
                                        "auth": bool(token)})
            if path == "/":
                path = "/index.html"
            full = os.path.realpath(os.path.join(ui_dir, path.lstrip("/")))
            if not full.startswith(ui_dir + os.sep) or not os.path.isfile(full):
                return self._send(404, {"error": "not found"})
            with open(full, "rb") as f:
                data = f.read()
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            self._send(200, data, ctype, "no-cache")

        do_HEAD = do_GET

        def do_POST(self):
            if not self._host_ok():
                return self._send(421, {"error": "unknown host"})
            if gateway.is_gateway_path(self.path.split("?", 1)[0]):
                return self._gateway()
            if self.path != "/rpc":
                return self._send(404, {"error": "not found"})
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return self._send(415, {"error": "application/json only"})
            if token:
                got = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
                if not hmac.compare_digest(got.encode(), token.encode()):
                    return self._send(401, {"error": "token required"})
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                return self._send(413, {"error": "too large"})
            try:
                msg = json.loads(self.rfile.read(n).decode("utf-8"))
            except ValueError:
                return self._send(400, _err(None, -32700, "parse error"))
            if isinstance(msg, list):
                out = [r for r in (rpc_one(kernel, m) for m in msg) if r is not None]
            else:
                out = rpc_one(kernel, msg)
            if out is None or out == []:              # notifications only
                self._send(204, b"")
            else:
                self._send(200, out)
            if kernel.restart_requested:            # system.update landed new code
                threading.Thread(target=self.server.shutdown, daemon=True).start()

        def log_message(self, fmt, *args):
            sys.stderr.write("  %s %s\n" % (self.address_string(), fmt % args))

    return Handler


def serve(kernel, host="127.0.0.1", port=43111, token=None, ui_dir=None):
    if host not in LOOPBACK and not token:
        raise SystemExit("refusing to serve %s beyond loopback without a token "
                         "(--token or JESSTER_NOTES_TOKEN)." % host)
    hosts = set(LOOPBACK) | {host.lower()}
    ui_dir = ui_dir or default_ui()
    srv = ThreadingHTTPServer((host, port), make_handler(kernel, token, hosts, ui_dir))
    print("  jesster notes — http://%s:%d/  (vault %s, ui %s)"
          % ("localhost" if host in LOOPBACK else host, port, kernel.vault.root,
             ui_dir), file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    if kernel.restart_requested:
        print("  updated — restarting on the new code", file=sys.stderr)
        os.execv(sys.executable, [sys.executable] + sys.argv)
