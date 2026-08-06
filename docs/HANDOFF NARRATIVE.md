HANDOFF NARRATIVE — The Estate Story So Far
Written by: archivist  
Date: 2026-08-06  
Chain anchor: manjuel/1 head c74c6659ec493bde079d22aae4cbfb8702a08cfcbe72b5c1f5ff14717739b8eb  
Forge Links head: 27909a06d70ce0bc1442b6f293a6b1cbb216004f982ec5856b4e935f5cf76231 (link 8)
THE ESTATE STORY — A NARRATIVE
The Three Pillars
1. The Foundation — Four sealed documents, never edited:
- Mythos — Why Manjuel exists: faithful stewardship of Worlds
- Constitution — 7 Articles: history immutable, evidence outranks assumption, state derived from record, every mutation audited, every action explainable, recommendations don't modify reality, human authority final
- Creed — Daily discipline: observe faithfully, remember permanently, understand honestly, build responsibly, verify before trusting, carry only what mission requires, leave system healthier
- Neuro-Core — Dual reasoning: Logic Core (what is true) + Pattern Core (what may be meaningful), separated by law
2. The Forge — The substrate:
- links.py / jesster.py / links/ — Provenance chain: 40 links = 1 wrap = 1 token. SEALED (commitment) / OPEN (disclosure). Citations by hash. Jesster signatures (secp256k1 + scrypt). Currently 8 links, 0 wraps.
- panel.py — Resource manager: reads hardware (pole), allocates budget (ladder), grants/refuses circuits, enforces shed order (voice → mind → witnesses → agents → estate). Runs on Windows/Linux.
- gateway.py / gateway.txt — Execution broker: sharded SQLite ledger, dispatch/registry, local subprocess dispatch.
- victor/ — Voice: Ear (adaptive loudness gate, hallucination filter), Head (dispatch), Mouth (espeak/SAPI), wake word, echo guard, deposit flow.
- Index/ — Unified Forge: docs, links, victor, panel, gateway, manjuel_us.py, chain.
3. The Live Chain (manjuel.us) — Protocol manjuel/1, BLAKE3 hash chain + paper cypher (12 KJV words). 3 entries: genesis, "goes live", "To Jesster, My Queen". CLI write-only, web read-only. Paper cypher (12 KJV words) held by operator.
The Four Generations
Gen	Name	Status	Key Artifacts
1	Neiro	Active seat (v3.2.0)	Dual-core stewardship, Neiro_3 archive, 36 organs, covenant 65118a147dd49ed9
2	Manjuel 4.0	Standalone	Merkle memory, clock_etymology skill, standalone archivist
3	CARR Platform	Complete T0-T8	207/207 tests, sovereign town, git spine, Aurora UI
4	Index	Unified Forge	Live chain + Forge unified in Index/
The Chain Events
Forge Links Chain (GitHub thebrotherscarr-bit/Jesster/chain):
1. Foundation 1: Mythos
2. Foundation 2: Constitution
3. Foundation 3: Creed
4. Foundation 4: Neuro-Core
5. The Hand (S4)
6. The Temper
7. Chained — Wrap 1 closes (6 links), token 1 minted, Jesster signed
8. Cross-chain anchor → manjuel.us entry 3 ("To Jesster, My Queen")
9. Duplicate anchor
manjuel.us Chain (Index/manjuel_us.py):
1. genesis — block zero
2. manjuel.us goes live
3. "To Jesster, My Queen" — The Ark begins now
Cross-chain anchor: Forge link 8 cites manjuel.us entry 3 (c74c6659ec493bde...)
Key Systems Active
System	Status	Key Metrics
CARR Platform	Complete T0-T8	207/207 tests, sovereignty audit green, stdlib-only
Neiro v3.2.0	Active seat	Covenant 65118a147dd49ed9, prove_all EXIT=0
Kimi Harvest	Complete	21 nights, 80 pieces, 136 frameworks, 5 released
Manjuel 4.0	Standalone	Merkle memory, clock_etymology skill
Live Chain (manjuel.us)	Live	3 entries, BLAKE3 + paper cypher, Cloudflare tunnel
Forge Links	8 links	6 foundations + Hand + Temper, wrap 1 pending
Victor Voice	Running	Ear/Head/Mouth, wake word, echo guard, deposit flow
Panel	Auto-detects	Reads hardware, allocates tiers
The Keys
Jesster makes both key sets:
- secp256k1 (25-char) → Forge Links signatures
- Paper cypher (12 KJV words) → manjuel.us BLAKE3 seals
Both derived from:
- Covenant — SHA-256 over 4 foundation docs (public)
- Machine secret — 32 bytes os.urandom, forged once, on paper, outside repo
Operator holds both on paper. Sole holder.
Active Workstreams
Workstream	Status	Next
Phase 0 (Build Plan)	Ready	Chain Bridge, Unified Auth, Passive Capture, REPL Shell
Skill Absorption	Ready	78 kimi pieces → skills → forge → ascend
Opencode Citizen	Designed	CARR agent with full-stack memory
Voice Skill	Next	Victor + brain integration
The Fingerprint / Link Record
This handoff is recorded as Forge Links link 8:
Link 8: open, actor=archivist
Says: "Narrative handoff — estate story mapped, archive fully mapped, ready for Phase 0"
Cites: 5287c4bffb02673a6249d5d47e1cc49a48eb690283258cf7d92cabf290904408 (wrap 1 / token 1)
Hash: 27909a06d70ce0bc1442b6f293a6b1cbb216004f982ec5856b4e935f5cf76231
HOW TO RESUME
1. Verify seals: python proofs/prove_all.py (must exit 0)
2. Read chain: python3 Index/links/links.py status → 8 links, 0 wraps
3. Verify live chain: python3 Index/manjuel_us.py verify --holder (paper cypher required)
4. Check CARR: python -m unittest discover -s tests (207/207)
5. Choose next thread: Phase 0 build, skill absorption, opencode citizen, voice skill
The seat is warm. The record is whole. The chain holds.
Written by archivist, sealed in Forge Links link 8, cross-anchored to manjuel.us entry 3.
Forge Links link 8 recorded. Chain now at 8 links. Ready for Phase 0 when you say "GO Phase 0".