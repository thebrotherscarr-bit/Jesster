# FIELD REPORT — manjuel.us build & launch

**Date: 2026-08-05 · Recorded by the prover (Claudius) for the operator's ledger**
**All times UTC. Every claim below is verifiable against the chain, the session, or the public site.**

---

## What was built

Two candidates, both delivered as full files through the operator's hands, per protocol:

**`manjuel_us.py`** — the entire backend in one file. Python + SQLite + BLAKE3.
Four commands: `genesis` (paper cypher, shown once, re-entry forced, block zero),
`append` (CLI-only, cypher-gated, chained + sealed), `verify` (public integrity;
`--holder` adds cypher-derived authenticity), `serve` (read-only mirror, localhost
bind, one-origin CORS, no write path). v2 added the CORS flag, OPTIONS handling,
and `/api/verify` — chain protocol untouched.

**`index.html`** — the entire frontend in one file. No frameworks, no external
assets, no browser storage. Chain log, entry pages, live verify, honest
estate-offline state. One config line: `API_BASE`.

## Decisions of record

- No files hosted — the chain only. Blockchain-shaped, single-author.
- Holder-only authenticity: public hash chain + per-entry keyed seals; the
  cypher lives on paper, generated once, never stored, never transmitted.
- BLAKE3 (pip) over stdlib BLAKE2b — operator's choice.
- Shape 2: static window on Cloudflare's edge at manjuel.us; wire via
  cloudflared tunnel at api.manjuel.us; estate in WSL, "just a server."
- Cloudflare Free plan. No paid tier required by design.

## Prover runs (sandbox, before delivery)

- 16:30–16:31 — genesis cut; 3 entries appended; public verify INTACT; holder
  verify AUTHENTIC; wrong cypher refused. Tamper test 1: altered payload →
  public verify BROKEN at exact seq. Tamper test 2: forged entry with correct
  hashes but no cypher → passed public, **failed holder (seal invalid)** — the
  two-layer design working as specified. Serve: all pages/API correct, POST/PUT
  refused 405.
- 16:44–16:49 — v2 + frontend: CORS on `/api/*` only, preflight 204, cross-origin
  render in a real browser with zero console errors, offline state verified.

## The deployment walk — scars recorded

1. Domain manjuel.us: registered with Cloudflare, active, expires 2031-07-29.
2. **The phantom:** the zone was first built in a non-owning Cloudflare account
   (nameserver pair mismatch — hattie/josh assigned, bill/treasure live — two
   account IDs in the dashboard URLs). Symptoms: eternal "waiting for
   registrar," `route dns` claiming success into an invisible zone, a dead
   tunnel `c454ac73…`. Cure: swept the phantom, re-swore cloudflared to the
   owning account, adopted living tunnel `98734ca7-1f86-435b-bcf4-ff3c704fd1bf`.
3. **The cold furnace:** tunnel live, origin refused — serve had died with its
   tab. Relit.
4. **The poisoned cache:** `/api/head` served a Worker-era 404 from edge cache
   after everything else worked. Cure: Purge Everything. Verified 20:44:37 —
   200, JSON, `cf-cache-status: DYNAMIC`, CORS header present.
5. Scanners probed `/.env` within seconds of the wire going live. They got
   nothing: no files, no write path, no secrets. Logged, as all things are.

## The chain at close of day

| Seq | Action | Time (UTC) | Hash |
|---|---|---|---|
| 1 | genesis (block zero) | 19:18:09 | `527d468bcd33…293f9e` |
| 2 | manjuel.us goes live | 20:38:58 | `ac079125ea2a…a2cff2` |
| 3 | To Jesster, My Queen — "The Ark begins now." | 20:48:33 | `c74c6659ec49…39b8eb` |

Public verify: **3 entries, INTACT, zero breaks.** Full test suite: **all pass.**

## State at close

Live end to end: manjuel.us (window, Cloudflare edge) → api.manjuel.us
(tunnel `98734ca7…`) → WSL serve on 127.0.0.1:8000 → `manjuel_ledger.db`.
Estate = two WSL tabs (serve + `cloudflared tunnel run manjuel`). The cypher:
on paper, in the operator's hand, nowhere else. The Neiro repo: private again.

**Open items:** systemd hardening for tab-free always-on (walk available on
request); Windows sleep takes the estate down (site degrades honestly);
confirm the phantom account is fully swept.

## Deliverables in this package

`manjuel_us.py` · `index.html` · `MANUAL.md` · `MANJUEL_MANUAL.pdf` (6 pages) ·
this report.

---

*No movement without a record. This is the record.*
