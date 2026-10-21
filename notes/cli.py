#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NOTES — the command line for the Jesster notes microkernel.

    python notes/cli.py init --actor <name>     make a vault, name its depositor
    python notes/cli.py new "Title" [-t a,b] [--body TEXT | < file]
    python notes/cli.py edit <id>               open in $EDITOR, save on close
    python notes/cli.py ls [-t tag]             list, newest first
    python notes/cli.py show <id>
    python notes/cli.py find <words>            search
    python notes/cli.py rm <id>                 move to the vault's trash
    python notes/cli.py ask <question>          answered by gpt-oss from your notes
    python notes/cli.py import <folder|file.json> [-t tag]
    python notes/cli.py history <id>            the note's links on the chain
    python notes/cli.py verify                  walk the vault's chain
    python notes/cli.py call <method> ['{json params}']   any kernel method
    python notes/cli.py methods                 what the kernel answers

    python notes/cli.py serve [--host H] [--port P] [--token T]   PWA + HTTP
    python notes/cli.py rpc                     JSON-RPC 2.0 on stdio
    python notes/cli.py mcp                     MCP server on stdio

The vault is --vault, else $JESSTER_VAULT, else ~/JessterNotes.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from kernel import KernelError, open_kernel, render      # noqa: E402

USAGE = __doc__


def _opt(args, *names, flag=False):
    """Pull --name VALUE (or a bare --flag) out of args, in place."""
    for name in names:
        if name in args:
            i = args.index(name)
            if flag:
                args.pop(i)
                return True
            if i + 1 >= len(args):
                raise SystemExit("%s needs a value" % name)
            args.pop(i)
            return args.pop(i)
    return False if flag else None


def vault_path(args):
    return (_opt(args, "--vault") or os.environ.get("JESSTER_VAULT")
            or os.path.join(os.path.expanduser("~"), "JessterNotes"))


def show(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def table(rows):
    if not rows:
        print("  (no notes)")
    for r in rows:
        tags = " ".join("#" + t for t in r["tags"])
        print("  %-28s %s  %s" % (r["id"][:28], r["title"][:48], tags))


def edit_in_editor(text):
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR") or (
        "notepad" if os.name == "nt" else "vi")
    fd, p = tempfile.mkstemp(suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        subprocess.call(editor.split() + [p])
        with open(p, "r", encoding="utf-8") as f:
            return f.read()
    finally:
        os.unlink(p)


def main(argv):
    # rpc and mcp speak UTF-8 JSON lines whatever the platform's code page is
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", newline="\n" if stream is sys.stdout else None)
    args = list(argv)
    if not args or args[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    root = vault_path(args)
    cmd, rest = args[0], args[1:]
    k = open_kernel(root)

    if cmd == "init":
        cfg = k.save_config(actor=_opt(rest, "--actor"),
                            provenance=_opt(rest, "--provenance"),
                            model=_opt(rest, "--model"),
                            ollama_url=_opt(rest, "--ollama"))
        print("  vault %s" % k.vault.root)
        show(cfg)
        if not k.config.get("actor") and k.config.get("provenance") != "off":
            print("  no actor yet — saves will be refused until you set "
                  "`--actor <name>` (or `--provenance off`).")
        return 0

    if cmd == "new":
        tags = _opt(rest, "-t", "--tags")
        body = _opt(rest, "--body")
        if not rest:
            raise SystemExit("new needs a title")
        if body is None:
            body = sys.stdin.read() if not sys.stdin.isatty() else edit_in_editor("")
        show(k.call("notes.create", {"title": " ".join(rest), "body": body,
                                     "tags": (tags or "").split(",")}))
        return 0

    if cmd == "edit":
        n = k.call("notes.get", {"id": rest[0]})
        from kernel import parse
        meta, body = parse(edit_in_editor(render(n)))
        show(k.call("notes.update", {"id": n["id"], "base": n["hash"],
                                     "title": meta.get("title", n["title"]),
                                     "tags": meta.get("tags", n["tags"]),
                                     "body": body}))
        return 0

    if cmd == "ls":
        table(k.call("notes.list", {"tag": _opt(rest, "-t", "--tag")}))
        return 0
    if cmd == "find":
        tag = _opt(rest, "-t", "--tag")
        table(k.call("notes.search", {"q": " ".join(rest), "tag": tag}))
        return 0
    if cmd == "show":
        n = k.call("notes.get", {"id": rest[0]})
        print("# %s\n%s\n\n%s" % (n["title"], " ".join("#" + t for t in n["tags"]),
                                  n["body"]))
        if n["backlinks"]:
            print("\n  linked from: %s" % ", ".join(n["backlinks"]))
        return 0
    if cmd == "rm":
        show(k.call("notes.remove", {"id": rest[0]}))
        return 0
    if cmd == "ask":
        r = k.call("llm.ask", {"q": " ".join(rest)})
        print(r["answer"])
        print("\n  sources: %s" % ", ".join(r["sources"]))
        return 0
    if cmd == "import":
        tag = _opt(rest, "-t", "--tag")
        src = rest[0]
        m = "import.json" if src.lower().endswith(".json") else "import.folder"
        show(k.call(m, {"path": src, "tag": tag}))
        return 0
    if cmd == "history":
        show(k.call("provenance.history", {"id": rest[0]}))
        return 0
    if cmd == "verify":
        r = k.call("provenance.verify")
        show(r)
        return 0 if r["intact"] else 1
    if cmd == "methods":
        for m in k.catalog():
            print("  %-22s %s" % (m["name"], m["doc"]))
        return 0
    if cmd == "call":
        params = json.loads(rest[1]) if len(rest) > 1 else {}
        show(k.call(rest[0], params))
        return 0

    if cmd == "serve":
        from serve import serve
        serve(k, _opt(rest, "--host") or "127.0.0.1",
              int(_opt(rest, "--port") or 8765),
              _opt(rest, "--token") or os.environ.get("JESSTER_NOTES_TOKEN"))
        return 0
    if cmd == "rpc":
        from stdio import serve_rpc
        serve_rpc(k)
        return 0
    if cmd == "mcp":
        from stdio import serve_mcp
        serve_mcp(k)
        return 0

    raise SystemExit(USAGE)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KernelError as e:
        print("  refused (%s): %s" % (e.code, e), file=sys.stderr)
        sys.exit(2)
    except IndexError:
        raise SystemExit(USAGE)
