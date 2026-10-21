# -*- coding: utf-8 -*-
"""
STDIO — the two ways a host process embeds the kernel without HTTP.

  rpc   JSON-RPC 2.0, one message per line. The method names are the kernel's
        own (notes.create, llm.ask, ...). For hosts written in anything.
  mcp   the Model Context Protocol over stdio. Every kernel method is an MCP
        tool (dots become underscores: notes_create). For agents — Claude
        Code, Codex, Cursor — to use the vault as their notes.

Nothing but protocol goes to stdout. Diagnostics go to stderr.
"""
import json
import sys
import traceback

from kernel import KernelError, VERSION

MCP_PROTOCOL = "2025-06-18"


def _out(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _err(id_, code, message, data=None):
    e = {"code": code, "message": message}
    if data is not None:
        e["data"] = data
    return {"jsonrpc": "2.0", "id": id_, "error": e}


def _lines():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except ValueError:
            _out(_err(None, -32700, "parse error"))


def rpc_one(kernel, msg):
    """One JSON-RPC request in, one response (or None for a notification) out.
    Shared with the HTTP surface."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or "method" not in msg:
        return _err(msg.get("id") if isinstance(msg, dict) else None,
                    -32600, "invalid request")
    id_ = msg.get("id")
    try:
        result = kernel.call(msg["method"], msg.get("params"))
    except KernelError as e:
        code = -32601 if e.code == "no_method" else (
            -32602 if e.code == "bad_params" else -32000)
        return None if id_ is None else _err(id_, code, str(e), {"reason": e.code})
    except Exception as e:                                   # pragma: no cover
        traceback.print_exc(file=sys.stderr)
        return None if id_ is None else _err(id_, -32603, "internal error: %s" % e)
    return None if id_ is None else {"jsonrpc": "2.0", "id": id_, "result": result}


def serve_rpc(kernel):
    for msg in _lines():
        r = rpc_one(kernel, msg)
        if r is not None:
            _out(r)


# --------------------------------------------------------------------------
# MCP
# --------------------------------------------------------------------------

def tool_name(method):
    return method.replace(".", "_")


def serve_mcp(kernel):
    by_tool = {tool_name(m): m for m in kernel.methods}
    for msg in _lines():
        if not isinstance(msg, dict):
            continue
        id_, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if id_ is None:                     # notifications/initialized and kin
            continue
        if method == "initialize":
            res = {"protocolVersion": params.get("protocolVersion") or MCP_PROTOCOL,
                   "capabilities": {"tools": {}},
                   "serverInfo": {"name": "jesster-notes", "version": VERSION},
                   "instructions": "A local notes vault. Search before you "
                   "create; every save is deposited on a Jesster provenance chain."}
        elif method == "ping":
            res = {}
        elif method == "tools/list":
            res = {"tools": [{"name": tool_name(c["name"]), "description": c["doc"],
                              "inputSchema": c["schema"]} for c in kernel.catalog()]}
        elif method == "tools/call":
            name = params.get("name")
            if name not in by_tool:
                _out(_err(id_, -32602, "unknown tool %r" % name))
                continue
            try:
                out = kernel.call(by_tool[name], params.get("arguments") or {})
                res = {"content": [{"type": "text", "text": json.dumps(
                    out, ensure_ascii=False, indent=2)}],
                       "structuredContent": out if isinstance(out, dict) else {"result": out},
                       "isError": False}
            except KernelError as e:
                res = {"content": [{"type": "text", "text": str(e)}], "isError": True}
        else:
            _out(_err(id_, -32601, "method not found: %s" % method))
            continue
        _out({"jsonrpc": "2.0", "id": id_, "result": res})
