# repo-updater

The perfect repo updater: plan, commit, and push with the operator's gate.

A repo update is a witnessed act, not a habit. The updater never:

- stages anything from the protected list — tokens, `shelf/`, `memory/`,
  `ledger/`, `weights/`, `strata/`, `*.npz`, caches — those are
  gitignored-unrecoverable
- runs `git add -A`; every staged path is explicit
- force-pushes, rewrites history, resets `--hard`, or cleans
- commits over a failing suite: if the repo carries `proofs/prove_all.py`
  (or a root `prove_all.py`), it must exit 0 or the commit is refused

Every commit is one link: its body carries a fingerprint (SHA-256 over branch,
message, and staged paths). Every landed update is witnessed to a board
(`state/board.jsonl`, hash-chained via `ledger.py`).

## Usage

```bash
python repo_update.py <repodir> plan                     # read-only, always first
python repo_update.py <repodir> commit --message "type(scope): summary" [--files a,b] [--board PATH]
python repo_update.py <repodir> push [--board PATH]      # push only on the operator's word
python repo_update.py <repodir> all --message "..." [--board PATH]
```

`plan` is the default verb. `plan` and `push` are read-only; `commit` stages
explicitly, runs the suite gate, and records the fingerprint in the commit
body. Push never uses force.

## The proof

```bash
python prove_repo_update.py   # exit 0 = the updater is safe to use
```

The prover builds a scratch repo with safe files and smuggled protected files
(tokens nested inside directories, `shelf/`, `weights/`, `ledger/`), then
asserts: the plan never proposes a protected path, the plan is read-only, the
commit never carries a protected file, the fingerprint and `via` marker ride
in the commit body, and the engine source is statically clean of
force/hard-clean/`add -A`.

Standard library only. Apache-2.0, same as this repository.
