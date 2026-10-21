# -*- coding: utf-8 -*-
"""
SYSTEM — the running copy and its source.

  system.version   which commit this is, and how far behind its branch on
                   GitHub it is (one `git fetch`, nothing changed locally)
  system.update    fast-forward to the branch on GitHub, rebuild the UI if it
                   changed, and restart the server so the new code runs

Fast-forward only. A copy with local commits or edits is never rewritten; the
update is refused and says why. Nothing here touches the vault.
"""
import os
import shutil
import subprocess

NAME = "system"
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UI = os.path.join(REPO, "secondbrain")
GIT_TIMEOUT = 120
BUILD_TIMEOUT = 900


def _run(args, cwd=REPO, timeout=GIT_TIMEOUT):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout,
                       shell=False)
    return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()


def git(*args):
    return _run(["git"] + list(args))


def npm():
    """npm is npm.cmd on Windows; shutil.which finds whichever exists."""
    return shutil.which("npm") or shutil.which("npm.cmd")


def register(k):
    from kernel import KernelError

    def where():
        rc, branch, err = git("rev-parse", "--abbrev-ref", "HEAD")
        if rc != 0:
            raise KernelError("no_git", "this copy is not a git checkout (%s)" % err)
        rc, upstream, _ = git("rev-parse", "--abbrev-ref", "@{upstream}")
        return branch, (upstream if rc == 0 else "origin/" + branch)

    def status(fetch=True):
        branch, upstream = where()
        fetched = None
        if fetch:
            remote, _, ref = upstream.partition("/")
            rc, _, err = git("fetch", "--quiet", remote, ref)
            fetched = True if rc == 0 else (err or "fetch failed")
        _, head, _ = git("rev-parse", "HEAD")
        _, counts, _ = git("rev-list", "--left-right", "--count", "HEAD..." + upstream)
        ahead, behind = (int(x) for x in (counts.split() or ["0", "0"]))
        _, dirty, _ = git("status", "--porcelain", "--untracked-files=no")
        _, subject, _ = git("log", "-1", "--format=%s", upstream)
        return {"branch": branch, "upstream": upstream, "head": head[:12],
                "ahead": ahead, "behind": behind, "dirty": bool(dirty),
                "latest": subject, "fetched": fetched}

    @k.method("system.version", "This copy's commit and how far behind GitHub it is.",
              {"fetch": {"type": "boolean"}})
    def version(fetch=True):
        return status(fetch)

    @k.method("system.update", "Pull the newest build from GitHub (fast-forward "
              "only), rebuild the UI if it changed, and restart.")
    def update():
        s = status(True)
        if s["behind"] == 0:
            return dict(s, updated=False, detail="already up to date")
        if s["ahead"] or s["dirty"]:
            raise KernelError("diverged", "this copy has local changes (%d commits "
                              "ahead%s); not overwriting them. Commit or stash, "
                              "then update." % (s["ahead"], ", edited files" if s["dirty"] else ""))
        _, before, _ = git("rev-parse", "HEAD")
        rc, out, err = git("merge", "--ff-only", s["upstream"])
        if rc != 0:
            raise KernelError("update_failed", err or out)
        _, changed, _ = git("diff", "--name-only", before, "HEAD")
        changed = changed.splitlines()
        built = None
        if any(p.startswith("secondbrain/") for p in changed) and os.path.isdir(UI):
            built = rebuild_ui(any(p in ("secondbrain/package.json",
                                         "secondbrain/package-lock.json") for p in changed)
                               or not os.path.isdir(os.path.join(UI, "node_modules")))
        k.restart_requested = True          # the server re-executes after replying
        return {"updated": True, "from": before[:12], "to": status(False)["head"],
                "files": len(changed), "ui": built, "restarting": True}

    def rebuild_ui(install):
        exe = npm()
        if not exe:
            return "npm not found; the UI was not rebuilt"
        if install:
            rc, _, err = _run([exe, "ci", "--legacy-peer-deps", "--ignore-scripts"],
                              UI, BUILD_TIMEOUT)
            if rc != 0:
                return "npm ci failed: %s" % err[-400:]
        rc, _, err = _run([exe, "run", "build"], UI, BUILD_TIMEOUT)
        return "rebuilt" if rc == 0 else "build failed: %s" % err[-400:]
