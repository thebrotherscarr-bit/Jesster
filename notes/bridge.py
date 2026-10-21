# -*- coding: utf-8 -*-
"""
BRIDGE — reach a running vault from somewhere that cannot dial into it.

A collaborator (a cloud agent, another machine) cannot open a connection to
the kernel on your desktop. Both of you can reach GitHub. So requests travel
as files in a PRIVATE git repository:

    requests/<id>.json   {"id", "method", "params", "from", "ts"}   — pushed by the caller
    replies/<id>.json    {"id", "result" | "error", "ts"}            — pushed by the worker

  worker  runs beside your kernel (`serve --bridge <clone>` or `bridge work`).
          It pulls, answers every request that has no reply yet through
          Kernel.call — the same door as every other surface — and pushes.
  send    the caller's side: write a request, push, wait for the reply.

The repository MUST be private: replies carry your notes. Anyone who can push
to it can call the kernel, so the worker refuses a set of methods unless the
vault's config allows them (bridge_allow): updating this copy's code, and
importing from paths on this machine.

Only git is used — your existing git credentials, no tokens to manage.
"""
import fnmatch
import json
import os
import subprocess
import sys
import threading
import time
import uuid

DENY = ("system.update", "import.*", "ingest.*")
INTERVAL = 5
KEEP_SECONDS = 24 * 3600


def _git(clone, *args, timeout=120):
    r = subprocess.run(["git", "-C", clone] + list(args), capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()


def _sync_push(clone, message, paths):
    """Commit `paths` and push, rebasing over the other side's pushes."""
    _git(clone, "add", "--", *paths)
    rc, _, _ = _git(clone, "diff", "--cached", "--quiet")
    if rc == 0:
        return True                                  # nothing to commit
    _git(clone, "commit", "-q", "-m", message)
    for _ in range(4):
        rc, _, err = _git(clone, "push", "-q")
        if rc == 0:
            return True
        _git(clone, "pull", "-q", "--rebase")
    return False


def _write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def allowed(method, config):
    allow = config.get("bridge_allow") or []
    if any(fnmatch.fnmatch(method, a) for a in allow):
        return True
    return not any(fnmatch.fnmatch(method, d) for d in DENY)


# --------------------------------------------------------------------------
# the worker — beside the kernel
# --------------------------------------------------------------------------

def work_once(kernel, clone):
    """One pass: pull, answer what is unanswered, push. Returns answers made."""
    from kernel import KernelError
    _git(clone, "pull", "-q", "--rebase")
    req_dir = os.path.join(clone, "requests")
    rep_dir = os.path.join(clone, "replies")
    if not os.path.isdir(req_dir):
        return 0
    done, stale = [], []
    now = time.time()
    for name in sorted(os.listdir(req_dir)):
        if not name.endswith(".json"):
            continue
        rp = os.path.join(rep_dir, name)
        if os.path.exists(rp):
            if now - os.path.getmtime(rp) > KEEP_SECONDS:
                stale += [os.path.join("requests", name), os.path.join("replies", name)]
            continue
        try:
            with open(os.path.join(req_dir, name), "r", encoding="utf-8") as f:
                req = json.load(f)
            method, params = req["method"], req.get("params") or {}
            if not allowed(method, kernel.config):
                raise KernelError("bridge_denied", "%s is not allowed over the bridge "
                                  "on this machine (bridge_allow in the vault config)"
                                  % method)
            reply = {"id": req.get("id"), "result": kernel.call(method, params)}
        except KernelError as e:
            reply = {"id": name[:-5], "error": {"reason": e.code, "message": str(e)}}
        except (ValueError, KeyError, OSError) as e:
            reply = {"id": name[:-5], "error": {"reason": "bad_request", "message": str(e)}}
        reply["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        _write(rp, reply)
        done.append(os.path.join("replies", name))
    for p in stale:
        _git(clone, "rm", "-q", "--ignore-unmatch", "--", p)
    if done or stale:
        _sync_push(clone, "bridge: %d replies" % len(done), done or ["replies"])
    return len(done)


def work(kernel, clone, interval=INTERVAL, stop=None):
    print("  bridge — answering requests in %s every %ds" % (clone, interval),
          file=sys.stderr)
    while not (stop and stop.is_set()):
        try:
            n = work_once(kernel, clone)
            if n:
                print("  bridge — answered %d" % n, file=sys.stderr)
        except Exception as e:                       # keep serving; say why
            print("  bridge — pass failed: %s" % e, file=sys.stderr)
        time.sleep(interval)


def start_thread(kernel, clone, interval=INTERVAL):
    t = threading.Thread(target=work, args=(kernel, clone, interval), daemon=True)
    t.start()
    return t


# --------------------------------------------------------------------------
# the caller
# --------------------------------------------------------------------------

def send(clone, method, params=None, wait=120, sender="bridge"):
    rid = "%d-%s" % (int(time.time()), uuid.uuid4().hex[:8])
    _git(clone, "pull", "-q", "--rebase")
    path = os.path.join("requests", rid + ".json")
    _write(os.path.join(clone, path), {"id": rid, "method": method,
                                       "params": params or {}, "from": sender,
                                       "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    if not _sync_push(clone, "bridge: %s" % method, [path]):
        raise SystemExit("could not push the request")
    reply = os.path.join(clone, "replies", rid + ".json")
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(3)
        _git(clone, "pull", "-q", "--rebase")
        if os.path.exists(reply):
            with open(reply, "r", encoding="utf-8") as f:
                return json.load(f)
    return {"id": rid, "error": {"reason": "timeout",
                                 "message": "no reply in %ds — is the worker running?" % wait}}


def main(argv):
    """python notes/bridge.py send <clone> <method> ['{json}'] [--wait S]"""
    if len(argv) >= 3 and argv[0] == "send":
        wait = 120
        if "--wait" in argv:
            i = argv.index("--wait")
            wait = int(argv[i + 1])
            argv = argv[:i] + argv[i + 2:]
        out = send(argv[1], argv[2], json.loads(argv[3]) if len(argv) > 3 else {}, wait)
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return 1 if "error" in out else 0
    print(main.__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
