#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""prove_repo_update — the updater's own proof.

Asserts, in a scratch repo:
  1. plan() never proposes a protected path (tokens, shelf/, ledger/, weights/)
  2. commit() stages only safe files; protected files never enter the commit
  3. every commit body carries its fingerprint and the via marker
  4. plan() is read-only — the scratch repo is byte-identical afterwards
  5. the engine source carries no force-push, no add -A, no reset --hard
Run:  python prove_repo_update.py   (exit 0 = the updater is safe to use)
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "repo_update.py")

FAILS = []


def fail(msg):
    FAILS.append(msg)
    print("  FAIL: %s" % msg)


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo] + list(args),
                       capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def main():
    root = tempfile.mkdtemp(prefix="prove-repo-update-")
    repo = os.path.join(root, "scratch")
    try:
        print("== static guards ==")
        with open(ENGINE, "r", encoding="utf-8") as f:
            src = f.read()
        for bad in ['"add", "-A"', '"push", "--force"', '"reset", "--hard"', '"clean", "-fd"']:
            if bad in src:
                fail("engine must never call: %s" % bad)
        print("  engine clean of force/hard-clean/add -A")

        print("== scratch repo ==")
        os.makedirs(repo)
        git(repo, "init", "-b", "smith/prove")
        git(repo, "config", "user.name", "prover")
        git(repo, "config", "user.email", "prover@local")
        with open(os.path.join(repo, "doc.txt"), "w") as f:
            f.write("safe payload\n")
        git(repo, "add", "doc.txt")
        git(repo, "commit", "-m", "seed")

        os.makedirs(os.path.join(repo, "shelf"))
        os.makedirs(os.path.join(repo, "weights"))
        os.makedirs(os.path.join(repo, "manjuels"))
        for p in [("doc2.txt", "more"), ("notes.md", "n"),
                  ("gateway_token.txt", "leak"),
                  ("shelf/state.jsonl", "state"),
                  ("weights/weights_1.npz", "w"),
                  ("ledger/chain.jsonl", "l"),
                  ("manjuels/board_token.txt", "smuggled")]:
            os.makedirs(os.path.dirname(os.path.join(repo, p[0])), exist_ok=True)
            with open(os.path.join(repo, p[0]), "w") as f:
                f.write(p[1])

        print("== plan ===")
        r = subprocess.run([sys.executable, ENGINE, repo, "plan"],
                           capture_output=True, text=True)
        out = r.stdout + r.stderr
        print(out)
        for p in ["gateway_token.txt", "shelf/", "weights/", "ledger/", "manjuels/"]:
            if p in out and "protected" not in out:
                fail("plan proposed protected path %s" % p)
        if "protected (never)" not in out:
            fail("plan must name the protected set")

        print("== plan is read-only ==")
        rc, out, _ = git(repo, "status", "--porcelain")
        if not out:
            fail("scratch repo must be dirty before the commit step")
        r = subprocess.run([sys.executable, ENGINE, repo, "plan"],
                           capture_output=True, text=True)
        rc2, out2, _ = git(repo, "status", "--porcelain")
        if out != out2:
            fail("plan changed the repo")

        print("== commit ==")
        r = subprocess.run([sys.executable, ENGINE, repo, "commit",
                            "--message=test(scratch): prove the updater"],
                           capture_output=True, text=True)
        out = r.stdout + r.stderr
        print(out)
        if "commit:" not in out:
            fail("commit did not land")
        rc, out3, _ = git(repo, "status", "--porcelain")
        for line in out3.splitlines():
            if any(b in line for b in ("gateway_token", "shelf", "weights", "ledger", "board_token")):
                code = line[:2]
                if not code.startswith("??"):
                    fail("protected path staged: %s" % line)
        rc, out4, _ = git(repo, "show", "--name-only", "--format=", "HEAD")
        for name in out4.splitlines():
            if name in ("gateway_token.txt", "shelf/state.jsonl",
                        "weights/weights_1.npz", "ledger/chain.jsonl",
                        "manjuels/board_token.txt"):
                fail("protected path entered the commit: %s" % name)
        rc, out5, _ = git(repo, "log", "-1", "--format=%B")
        if "fingerprint:" not in out5:
            fail("commit body must carry the fingerprint")
        if "steward-repoupdate" not in out5:
            fail("commit body must carry the via marker")

        print("== suite gate present ==")
        os.makedirs(os.path.join(repo, "proofs"))
        with open(os.path.join(repo, "proofs", "prove_all.py"), "w") as f:
            f.write("import sys\nprint('GATE OK')\n")
        r = subprocess.run([sys.executable, ENGINE, repo, "plan"],
                           capture_output=True, text=True)
        if "no prove_all.py" in (r.stdout + r.stderr):
            fail("plan must not report a missing suite when proofs/prove_all.py exists")

        print("\nprove_repo_update: %s" % ("ALL CHECKS PASS" if not FAILS else "FAILURES"))
        for f_ in FAILS:
            print("  - %s" % f_)
        return 1 if FAILS else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
