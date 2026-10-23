# -*- coding: utf-8 -*-
"""
SYSTEM — the running copy and its source.

  system.version   which commit this is, and how far behind its branch on
                   GitHub it is (one `git fetch`, nothing changed locally)
  system.update    fast-forward to the branch on GitHub, rebuild the UI if it
                   changed, and restart the server so the new code runs

  system.install_desktop   download the newest SecondBrain.exe build from the
                   repository's releases, install it for this Windows user,
                   add Desktop and Start menu shortcuts, and start it. From
                   then on the desktop app updates itself.

Fast-forward only. A copy with local commits or edits is never rewritten; the
update is refused and says why. Nothing here touches the vault.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

NAME = "system"
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UI = os.path.join(REPO, "secondbrain")
GIT_TIMEOUT = 120
RELEASES = "https://api.github.com/repos/thebrotherscarr-bit/Jesster/releases?per_page=30"
DOWNLOAD_PREFIX = "https://github.com/thebrotherscarr-bit/Jesster/releases/download/"
ASSET = "SecondBrain-win32-x64.zip"
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

    @k.method("system.install_desktop", "Install (or reinstall) the newest "
              "SecondBrain desktop app on this Windows PC, with shortcuts.")
    def m_install_desktop():
        return install_desktop()

    @k.method("system.desktop_build", "The newest desktop app build on GitHub.")
    def m_desktop_build():
        try:
            return {"latest": latest_desktop_build(),
                    "installed": os.path.isfile(os.path.join(desktop_dir(), "SecondBrain.exe"))}
        except OSError as e:
            raise KernelError("offline", "could not reach GitHub: %s" % e)

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


def _http(url, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "jesster-notes",
                                               "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(req, timeout=timeout)


def latest_desktop_build():
    """The newest secondbrain-b<N> release that carries the Windows zip."""
    with _http(RELEASES, 60) as r:
        releases = json.loads(r.read().decode("utf-8"))
    best = None
    for rel in releases:
        tag = rel.get("tag_name") or ""
        if rel.get("draft") or not tag.startswith("secondbrain-b") or not tag[13:].isdigit():
            continue
        asset = next((a for a in rel.get("assets") or [] if a.get("name") == ASSET), None)
        if asset and (best is None or int(tag[13:]) > best["build"]):
            best = {"build": int(tag[13:]), "tag": tag, "url": asset["browser_download_url"]}
    return best


def desktop_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "Programs", "SecondBrain")


def _running():
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq SecondBrain.exe"],
                       capture_output=True, text=True, errors="replace")
    return "SecondBrain.exe" in (r.stdout or "")


def _shortcuts(exe):
    """Desktop and Start menu shortcuts, through Windows' own shell object."""
    ps = ("$s = New-Object -ComObject WScript.Shell; "
          "foreach ($d in @([Environment]::GetFolderPath('Desktop'), "
          "[Environment]::GetFolderPath('Programs'))) { "
          "$l = $s.CreateShortcut((Join-Path $d 'SecondBrain.lnk')); "
          "$l.TargetPath = '%s'; $l.WorkingDirectory = '%s'; $l.Save() }"
          % (exe.replace("'", "''"), os.path.dirname(exe).replace("'", "''")))
    subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
                   capture_output=True, timeout=60)


def install_desktop():
    from kernel import KernelError
    if os.name != "nt":
        raise KernelError("not_windows", "the desktop app installs on Windows only")
    if _running():
        raise KernelError("app_running", "SecondBrain.exe is open; close it, then "
                          "install again (its files can't be replaced while it runs)")
    try:
        build = latest_desktop_build()
    except OSError as e:
        raise KernelError("offline", "could not reach GitHub: %s" % e)
    if not build:
        raise KernelError("no_build", "no desktop build has been published yet")
    if not build["url"].startswith(DOWNLOAD_PREFIX):
        raise KernelError("refused", "refusing a download from outside the app repository")
    work = tempfile.mkdtemp(prefix="secondbrain-install-")
    try:
        zpath = os.path.join(work, ASSET)
        with _http(build["url"]) as r, open(zpath, "wb") as out:
            shutil.copyfileobj(r, out)
        with zipfile.ZipFile(zpath) as z:
            z.extractall(os.path.join(work, "new"))
        src = None
        for d, _, files in os.walk(os.path.join(work, "new")):
            if "SecondBrain.exe" in files:
                src = d
                break
        if not src:
            raise KernelError("bad_build", "the downloaded build has no SecondBrain.exe")
        dest = desktop_dir()
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
        exe = os.path.join(dest, "SecondBrain.exe")
        _shortcuts(exe)
        subprocess.Popen([exe], cwd=dest, close_fds=True,
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
        return {"installed": build["build"], "path": dest,
                "detail": "SecondBrain build %d installed in %s, with Desktop and "
                          "Start menu shortcuts. It updates itself from now on."
                          % (build["build"], dest)}
    finally:
        shutil.rmtree(work, ignore_errors=True)
