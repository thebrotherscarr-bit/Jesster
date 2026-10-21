# -*- coding: utf-8 -*-
"""
SERVE — the kernel over HTTP, and the PWA beside it.

  GET  /            the PWA (../pwa), installable, works offline
  POST /rpc         JSON-RPC 2.0 into the kernel — the same door as stdio
  GET  /health      {"ok": true, ...}

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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from kernel import VERSION
from stdio import rpc_one, _err

PWA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pwa")
MAX_BODY = 8 * 1024 * 1024
LOOPBACK = ("127.0.0.1", "localhost", "::1")

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")


def make_handler(kernel, token, hosts):
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
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                             "img-src 'self' data:; connect-src 'self'")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _host_ok(self):
            h = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
            return h in hosts

        def do_GET(self):
            if not self._host_ok():
                return self._send(421, {"error": "unknown host"})
            path = self.path.split("?", 1)[0]
            if path == "/health":
                return self._send(200, {"ok": True, "version": VERSION,
                                        "auth": bool(token)})
            if path == "/":
                path = "/index.html"
            full = os.path.realpath(os.path.join(PWA_DIR, path.lstrip("/")))
            if not full.startswith(os.path.realpath(PWA_DIR) + os.sep) or not os.path.isfile(full):
                return self._send(404, {"error": "not found"})
            with open(full, "rb") as f:
                data = f.read()
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            self._send(200, data, ctype, "no-cache")

        do_HEAD = do_GET

        def do_POST(self):
            if not self._host_ok():
                return self._send(421, {"error": "unknown host"})
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
                return self._send(204, b"")
            self._send(200, out)

        def log_message(self, fmt, *args):
            sys.stderr.write("  %s %s\n" % (self.address_string(), fmt % args))

    return Handler


def serve(kernel, host="127.0.0.1", port=8765, token=None):
    if host not in LOOPBACK and not token:
        raise SystemExit("refusing to serve %s beyond loopback without a token "
                         "(--token or JESSTER_NOTES_TOKEN)." % host)
    hosts = set(LOOPBACK) | {host.lower()}
    srv = ThreadingHTTPServer((host, port), make_handler(kernel, token, hosts))
    print("  jesster notes — http://%s:%d/  (vault %s)"
          % ("localhost" if host in LOOPBACK else host, port, kernel.vault.root),
          file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
