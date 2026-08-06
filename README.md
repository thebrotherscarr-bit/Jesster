# Jesster — Manjuel-builder

Jesster is the provenance chain of the Manjuel estate — the public, verifiable
record of what was deposited, by whom, and when. She signs; the estate's
sealed ledger shares her exact recipe, without sharing her process.

## The chain

`chain/chain.jsonl` is an append-only, hash-chained record of links. Every
link carries exactly five things:

| field     | meaning                                                              |
|-----------|----------------------------------------------------------------------|
| `ts`      | when it happened                                                     |
| `kind`    | `link` or `wrap`                                                     |
| `payload` | the thing itself — words, a document, or its digest plus the hashes it cites |
| `prev`    | the hash of the entry before it — the weld                           |
| `actor`   | the name of the one who deposited it — inside the hash, so it can never be changed without breaking the chain at a named position |

The hash and the signature ride outside those five: a signature is taken over
the hash, so it can never be inside what produced it.

Two ways to deposit, one flag apart:

- **SEALED** — the link carries only the hash of the document. It proves the
  document existed on that date and reveals nothing until it is published.
  (Hooke's anagram, 1660 — the claim staked without being given away.)
- **OPEN** — the link carries the document itself: prior art the moment it
  lands.

**Cites.** A link may name the earlier work it stands on, by hash — links on
this chain, or things already public elsewhere (a block on manjuel.us, a git
commit). The terrain a link claims to stand on is welded to it forever.

**Wraps and tokens.** Every 40 links close a wrap: a Merkle root over exactly
those 40. Token N is wrap N. There are no granted tokens — every token that
exists has forty links of work behind it and can prove that from the head.
The serial is the rank: nine one-digit tokens, ninety two-digit ones.

**Verification is everyone's.** A stranger holding only the head can prove any
single link out of a million in about twenty hashes, and the whole chain
rewalks with nothing but the standard library. `chain/links.py` is the engine;
`chain/jesster.py` signs.

## The six documents of the soul

`docs/` holds the doctrine — the Mythos, the Constitution, the Creed, the
Neuro-Core, the Hand (S4), and the Temper. They were deposited OPEN as links
1–6; link 7 chained the head of the six ("one signature"). Links 8–9 cite the
manjuel.us ledger.

## repo-updater

`repo-updater/` is the repository updater: plan, commit, and push with the
operator's gate. Protected paths are never staged; the suite gate runs before
every commit; every commit body carries its fingerprint; every landed update
is witnessed to the board. Prove it yourself:

```bash
python repo-updater/prove_repo_update.py
```

## License

Apache-2.0.
