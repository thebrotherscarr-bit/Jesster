#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
THE LEDGER — append-only, SHA-256 hash-chained, tamper-naming.

Every entry links to the one before it. verify() walks the chain and names the
first broken entry. Nothing is erased; a mistake is corrected on the next line.
Standard library only.

Usage:  python ledger.py <path> [verify|tail|read]
"""
import hashlib
import json
import os
import time

GENESIS = "0" * 64


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _iter_lines(path):
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.strip():
                    yield line


def append(path, body):
    """Append a body dict to the chain at path; returns the full entry."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    prev = GENESIS
    for line in _iter_lines(path):
        prev = json.loads(line)["hash"]
    body = dict(body)
    body.setdefault("ts", now())
    payload = json.dumps(body, sort_keys=True, ensure_ascii=False)
    entry = {
        "prev": prev,
        "hash": hashlib.sha256((prev + payload).encode("utf-8")).hexdigest(),
        "body": body,
    }
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def read(path):
    """All entries, in order. Each entry: {prev, hash, body}."""
    return [json.loads(line) for line in _iter_lines(path)]


def tail(path, n=5):
    return read(path)[-n:]


def verify(path):
    """Returns (ok, count, message). A tamper is named with its entry number."""
    prev, count = GENESIS, 0
    for line in _iter_lines(path):
        e = json.loads(line)
        payload = json.dumps(e["body"], sort_keys=True, ensure_ascii=False)
        want = hashlib.sha256((prev + payload).encode("utf-8")).hexdigest()
        if e.get("prev") != prev or e.get("hash") != want:
            return False, count, "tamper at entry %d" % count
        prev = e["hash"]
        count += 1
    return True, count, None


def main(argv=None):
    import sys
    args = list(argv if argv is not None else sys.argv[1:])
    if not args:
        print("usage: python ledger.py <path> [verify|tail|read]")
        return 2
    path = args[0]
    verb = args[1] if len(args) > 1 else "verify"
    if verb == "verify":
        ok, n, msg = verify(path)
        print(("OK — %d entries, chain intact" % n) if ok else ("BROKEN — %s" % msg))
        return 0 if ok else 1
    if verb == "tail":
        for e in tail(path, 10):
            print(json.dumps(e["body"], ensure_ascii=False))
        return 0
    if verb == "read":
        for e in read(path):
            print(json.dumps(e, ensure_ascii=False))
        return 0
    print("unknown verb %r" % verb)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
