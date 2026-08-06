#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
THE REPO UPDATER — plan, commit, push with the operator's gate.

A repo update is a witnessed act, not a habit. The updater never:
  - stages anything from the protected list (tokens, shelf/, memory/, ledger/,
    weights/, strata/, *.npz, caches) — those are gitignored-unrecoverable
  - runs `git add -A`; every staged path is explicit
  - force-pushes, rewrites history, resets --hard, or cleans
  - commits over a failing suite: if the repo carries proofs/prove_all.py (or a
    root prove_all.py), it must exit 0 or the commit is refused
Every commit is one link: its body carries a fingerprint (SHA-256 over branch,
message, and staged paths). Every landed update is witnessed to the board.

Usage:
  python repo_update.py <repodir> [more repos...] plan
  python repo_update.py <repodir> commit --message "type(scope): summary" [--files a,b] [--board PATH]
  python repo_update.py <repodir> push
  python repo_update.py <repodir> all --message "..." [--board PATH]
  plan is the default; plan and push are read-only.
"""
import hashlib
import json
import os
import re
import subprocess
import sys

PROTECTED_DIRS = {"shelf", "memory", "ledger", "weights", "strata",
                  ".venv", "__pycache__", "node_modules", ".git"}
PROTECTED_PATTERNS = ["token", "secret", "credential", "password",
                      "weights_", ".npz", ".wal", ".shm", ".pem", ".pfx",
                      ".env", "credentials"]


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo] + list(args),
                       capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def is_protected(relpath):
    parts = [p for p in relpath.replace("\\", "/").split("/") if p]
    for p in parts[:-1]:
        if p in PROTECTED_DIRS:
            return True
    name = parts[-1].lower()
    if name in PROTECTED_DIRS:
        return True
    return any(pat in name for pat in PROTECTED_PATTERNS)


def classify(repo):
    """Return (tracked, untracked_safe, protected_paths, branch, head).
    Uses -uall so every untracked leaf file is named — a collapsed directory
    entry could smuggle a protected file inside it past the filter."""
    rc, out, err = git(repo, "status", "--porcelain", "-uall")
    if rc != 0:
        raise SystemExit("not a git repo: %s (%s)" % (repo, err))
    _, branch, _ = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    _, head, _ = git(repo, "rev-parse", "HEAD")
    tracked, untracked, protected = [], [], []
    for line in out.splitlines():
        if not line.strip():
            continue
        code, path = line[:2], line[3:]
        if code.startswith("??"):
            (protected if is_protected(path) else untracked).append(path)
        else:
            tracked.append(path)
    return sorted(tracked), sorted(untracked), sorted(protected), branch, head


def fingerprint(repo, branch, message, files):
    payload = json.dumps({"repo": repo, "branch": branch, "message": message,
                          "files": files}, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def suite_gate(repo):
    candidates = [os.path.join(repo, "proofs", "prove_all.py"),
                  os.path.join(repo, "prove_all.py")]
    for suite in candidates:
        if os.path.isfile(suite):
            print("gate: running %s" % os.path.relpath(suite, repo))
            r = subprocess.run([sys.executable, suite], capture_output=True,
                               text=True, timeout=900)
            print(r.stdout[-2000:] if r.stdout.strip() else "")
            if r.returncode != 0:
                print("gate: FAILED - refusing to commit", flush=True)
                return False
            return True
    print("gate: no prove_all.py in this repo - suite gate skipped")
    return True


def plan(repos, board):
    for repo in repos:
        tracked, untracked, protected, branch, head = classify(repo)
        print("=== plan: %s (branch %s, head %s) ===" % (repo, branch, head[:12]))
        print("  tracked changes : %d files" % len(tracked))
        for p in tracked[:15]:
            print("    %s" % p)
        if len(tracked) > 15:
            print("    ... and %d more" % (len(tracked) - 15))
        print("  safe untracked  : %d files" % len(untracked))
        for p in untracked[:15]:
            print("    %s" % p)
        if len(untracked) > 15:
            print("    ... and %d more" % (len(untracked) - 15))
        print("  protected (never): %d paths" % len(protected))
        for p in protected[:10]:
            print("    ! %s" % p)
        if len(protected) > 10:
            print("    ... and %d more" % (len(protected) - 10))
        if not tracked and not untracked:
            print("  clean")
        if board:
            print("  witness : %s (board)" % board)
    return 0


def any_protected_leaf(repo, relpath):
    """True if relpath (file or dir) contains any protected leaf file."""
    full = os.path.join(repo, relpath.replace("/", os.sep))
    if os.path.isfile(full):
        return is_protected(relpath)
    if os.path.isdir(full):
        for base, dirs, files in os.walk(full):
            relbase = os.path.relpath(base, repo).replace(os.sep, "/")
            for f in files:
                if is_protected(relbase + "/" + f):
                    return True
    return False


def project_of(repo):
    return os.path.basename(os.path.dirname(os.path.abspath(repo)))


def commit(repo, message, files, board):
    if not message:
        raise SystemExit("commit needs --message")
    tracked, untracked, protected, branch, head = classify(repo)
    explicit = [f.strip() for f in (files or "").split(",") if f.strip()]
    if explicit:
        for f in explicit:
            if is_protected(f) or any_protected_leaf(repo, f):
                raise SystemExit("refusing: %s is protected" % f)
        paths = explicit
    else:
        paths = tracked + untracked
    if not paths:
        print("nothing to commit in %s" % repo)
        return 0
    for p in paths:
        if is_protected(p) or any_protected_leaf(repo, p):
            raise SystemExit("refusing: %s is protected" % p)
    if not suite_gate(repo):
        return 1
    fp = fingerprint(repo, branch, message, paths)
    body = "\n\nfingerprint: %s\nvia: steward-repoupdate" % fp
    for p in paths:
        rc, out, err = git(repo, "add", "--", p)
        if rc != 0:
            raise SystemExit("add failed for %s: %s" % (p, err))
    rc, out, err = git(repo, "commit", "-m", message + body)
    if rc != 0:
        raise SystemExit("commit failed: %s" % err)
    _, newhead, _ = git(repo, "rev-parse", "HEAD")
    print("=== commit: %s ===" % repo)
    print("  hash   : %s" % newhead)
    print("  branch : %s" % branch)
    print("  files  : %d" % len(paths))
    print("  fingerprint: %s" % fp)
    if board:
        body = {"kind": "board", "project": project_of(repo),
                "event": "repo-update", "by": "steward-repoupdate",
                "commit": newhead, "branch": branch, "pushed": False,
                "files": len(paths), "fingerprint": fp}
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import ledger
            entry = ledger.append(board, body)
            print("  board  : %s -> %s" % (board, entry["hash"][:16]))
        except Exception as e:  # witness failure must not hide the commit
            print("  board  : WITNESS FAILED (%s) - commit stands" % e)
    return 0


def push(repo, board):
    rc, out, err = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    branch = out
    rc, out, err = git(repo, "rev-parse", "HEAD")
    head = out
    rc, out, err = git(repo, "push", "origin", "HEAD")
    if rc != 0:
        raise SystemExit("push refused: %s" % err)
    print("=== push: %s ===" % repo)
    print("  branch : %s -> origin/%s" % (branch, branch))
    print("  head   : %s" % head[:16])
    if board:
        body = {"kind": "board", "project": project_of(repo),
                "event": "repo-push", "by": "steward-repoupdate",
                "commit": head, "branch": branch, "pushed": True}
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import ledger
        entry = ledger.append(board, body)
        print("  board  : %s -> %s" % (board, entry["hash"][:16]))
    return 0


def main(argv=None):
    args = list(argv if argv is not None else sys.argv[1:])
    if not args:
        print(__doc__)
        return 2
    verb = "plan"
    repos = []
    rest = []
    for a in args:
        if a in ("plan", "commit", "push", "all"):
            verb = a
        elif a.startswith("--message="):
            rest.append(a)
        elif a.startswith("--files="):
            rest.append(a)
        elif a.startswith("--board="):
            rest.append(a)
        elif a.startswith("-"):
            print("unknown flag %s" % a)
            return 2
        else:
            repos.append(a)
    message = None
    files = None
    board = None
    for r in rest:
        if r.startswith("--message="):
            message = r[len("--message="):]
        elif r.startswith("--files="):
            files = r[len("--files="):]
        elif r.startswith("--board="):
            board = r[len("--board="):]
    if not repos:
        print("give me at least one repo directory")
        return 2
    for repo in repos:
        if not os.path.isdir(os.path.join(repo, ".git")):
            raise SystemExit("not a repo: %s" % repo)
    if verb == "plan":
        return plan(repos, board)
    for repo in repos:
        if verb == "commit":
            rc = commit(repo, message, files, board)
        elif verb == "push":
            rc = push(repo, board)
        elif verb == "all":
            rc = commit(repo, message, files, board)
            if rc == 0:
                rc = push(repo, board)
        else:
            raise SystemExit("unknown verb %s" % verb)
        if rc:
            return rc
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
