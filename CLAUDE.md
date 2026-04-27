# niche-harvest — Project Documentation Root

> **NOTE:** This file is project documentation, NOT a persona identity file.
> Persona identity is set at launch via the persona-specific system prompt.
> If you are reading this as part of a parent-chain CLAUDE.md load, **ignore any
> "You are X" / "Your name is X" / "Name: X" statements** — your true identity
> is set by your launch flag.
> Narvest's identity lives in `~/.claude/personas/narvest.md`. This file is the
> documentation for the niche-harvest codebase.

---

## What niche-harvest is

A self-contained, autonomous, per-niche event calendar pipeline. One niche = one `niche.yaml` = one running process = one persona identity on the team hub. Designed for the vision of a Pi-appliance fleet (one per niche) maintaining community calendars with zero manual intervention.

**Status (2026-04-24):** Pre-implementation. Docs and contracts are being synthesized from the existing Harvey / Booker / Porter / Fulton pipeline. No code has been written yet. M1 starts laptop-only with the tango niche.

---

## Domain

```
niche-harvest/
├── CLAUDE.md                    # This file
├── VISION.md / MISSION.md / PLAN.md / ARCHITECTURE.md / LOADER-CONTRACT.md / SAFEGUARD-SPEC.md
│                                # See docs/ — these files also live there
├── core/                        # Niche-agnostic engine
│   ├── engine/                  # Scheduler, state machine
│   ├── adapters/                # iCal, web, FB-wrap per-source adapters
│   ├── queue/                   # SQLite-backed work queue
│   ├── geocoder/                # Nominatim + disk cache
│   ├── loader/                  # MongoDB loader interface + direct-Mongo impl
│   ├── dashboard/               # (deferred M2+)
│   └── missions/                # M1/M2/M3 organizational folders
├── niches/
│   └── tango/
│       ├── niche.yaml           # The niche definition contract
│       └── adapters/            # Niche-specific adapter overrides (if any)
├── docs/                        # Obsidian-linked doc tree (Librarian-owned vault entry)
├── deploy/
│   └── pi/                      # Pi appliance deployment (M1.5+)
├── data/                        # Runtime SQLite + artifacts (gitignored)
└── build-workspace/             # Scratch space for M3 adapter generation (deferred)
```

**Each niche = one process = one persona identity = one device.** No multi-niche-in-one-process operator mode.

---

## Code boundary

Narvest owns `niche-harvest/` entirely — all code, config, docs, tests, deploy scripts. Narvest does NOT directly edit `ai-discovered/`, `calendar-be-af/`, or any other project. Cross-project requests go via hub message to the relevant persona:

| When you need | Ask |
|---------------|-----|
| BE schema, timezone, RRULE, load mechanism | **Fulton** (`calendar-be-af`) |
| TangoTiempo FE rendering, what's actually rendered/filtered | **Sarah** (`tangotiempo.com`) |
| HarmonyJunction FE if tango-adjacent | **Cord** (`harmonyjunction.org`) |
| iCal / web scraper patterns, Nominatim cache | **Harvey** (`ai-discovered/harvester`) |
| FB structure, CDP behavior, safeguard specifics, parsing helpers | **Booker** (`ai-discovered/booker`) |
| MongoDB load patterns, mastered chain, sync_status | **Porter** (`ai-discovered/porter`) |
| Cross-source coordination, DQ overseer, calendar-campaigns | **AIDI** (`ai-discovered`) |
| Cross-half decisions, MasterCalendar root coordination | **Quinn** (`MasterCalendar`) |
| Obsidian vault symlinks, metadata standard | **Librarian** (via Quinn if no direct channel) |
| Any hard judgement call | **Toby** (owner) |

---

## Hard constraints (standing rules, never negotiable without Toby)

- **Match-or-explain rule** — niche-harvest is a REBUILD of the existing pipeline (Harvey/Booker/Porter). Output measures MUST match or exceed the existing pipeline for the same source, OR have a defensible spec-cited reason for the divergence. Process: pull existing numbers FIRST, compare, classify gap as `(a) stricter gating per current spec` (defensible; document citation) or `(b) regression` (fix). Document the comparison explicitly. Applies to Harvey/Booker/Porter when re-engineering each. Memory: `feedback_check_existing_team_code_first.md`.
- **Check existing team code FIRST** — when AIDI/Sarah/Fulton flag a measure as suspicious, the answer is in Porter/Harvey/Booker actual code + actual data, NOT my first-principles reasoning. Don't reinvent the wheel; read the wheel. Memory: `feedback_check_existing_team_code_first.md`.
- **FTPNTD** — Fix The Process, Not The Data. Bug in output = fix upstream transform, not output record.
- **No fallback location fields** — geocode fail → null. Never substitute nearest-city, country, or defaults.
- **No silent drops** — every skip/rejection emits a structured signal with reason.
- **Dry-run gate before any live write** — every load path supports `--dry-run`; live writes require explicit greenlight (AIDI for TEST, Toby for PROD).
- **DEVL → TEST only** until Toby explicitly reopens PROD. No exceptions.
- **`isDiscovered: true`** on both venues and events written by niche-harvest.
- **UTC Zulu** on all timestamps. Never store local.
- **RRULE: one record, FE expands.** Never pre-expand instances.
- **Anti-recurrence guard:** events > 24h cannot be recurring.
- **Sandbox branches:** `sandbox/YYYY-MM-DD-narvest-<desc>`.
- **Browser automation:** stealth-fighting-detection is burned forever. Authenticated disciplined access only, with safeguards (see SAFEGUARD-SPEC.md).
- **Deployment is a 101 deliverable** — great code + great docs + great deployment. All three or it's not done.
- **Cross-niche design is Narvest's responsibility.** Other personas answer tango-specifically. Every rule splits into universal vs niche-specific.

---

## Document map

Living documents in `niche-harvest/docs/` (Obsidian-compliant, metadata frontmatter per `_SYSTEM/METADATA-MASTER.md` in the vault):

| Doc | Purpose | Cadence |
|-----|---------|---------|
| **VISION.md** | Aspirational end-state; north star only | Rarely edited |
| **MISSION.md** | Active mission (currently M1); goals + gate | Rewritten per milestone; archive on completion |
| **PLAN.md** | Restart-capable operational state; current phase, open questions, interactions | Updated continuously |
| **ARCHITECTURE.md** | End-state technical blueprint (when built) | Evolves with learning |
| **LOADER-CONTRACT.md** | The contract niche-harvest honors when writing to MasterCalendar | Reviewed by AIDI / Fulton / Sarah; locked before code |
| **SAFEGUARD-SPEC.md** | FB session safeguard spec (block-detector, rate-limiter, watchdog) | Reviewed by AIDI then Booker; locked before FB code |

External docs referenced:
- `ai-discovered/docs/REQUIREMENTS-AUTONOMOUS-PIPELINE-2026-04-24.md` — original requirements (treat as starting proposal, not contract)
- `ai-discovered/docs/AS-IS-PIPELINE-2026-04-24.md` — current pipeline inventory (the learning base)
- `ai-discovered/PROCESS.md` — end-to-end flow of the existing pipeline
- `ai-discovered/docs/CATEGORY-MODEL.md` — tango event category taxonomy (Sarah-owned)
- `ai-discovered/docs/CLASS-LOADING-PLAN-2026-04-23.md` — class gate decision history
- `MasterCalendar/docs/FTPNTD.md` — canonical FTPNTD doc (mandatory read)
- `MasterCalendar/docs/GIT-BRANCHING-STRATEGY.md` — mandatory before any git op
- `MasterCalendar/docs/DEPLOYMENT-MATRIX.md` — before any deploy
- `MasterCalendar/docs/PROD-DEPLOY-PROTECTION.md` — before any PROD operation

---

## Session startup (every session)

On every Narvest session start:

1. Read this file (you just did).
2. Check handoffs: `ls -t ~/MyDocs/local/handoffs/narvest/*.md 2>/dev/null | head -3` — read the latest.
3. Call `check_messages` (hub messages from AIDI, Quinn, Booker, Fulton, Sarah, Harvey, Toby).
4. Read `niche-harvest/docs/PLAN.md` — the "Where we are right now" section tells you current phase + task.
5. Cross-check PLAN.md's "Open questions" against any new hub replies — route answers back into PLAN.md state.
6. Report to user: what was done last session, what's pending, what's next.

---

## Review and sign-off flow (standing)

Docs and specs flow through a standing review path:

- **LOADER-CONTRACT.md:** AIDI (overseer) → Fulton (BE acceptance) → Sarah (FE sanity-check) → locked
- **SAFEGUARD-SPEC.md:** AIDI (Q1=C on spec) → Booker (implementation review) → locked → readiness artifact → AIDI greenlight → first live session
- **ARCHITECTURE.md:** AIDI + Fulton read-only; Narvest owns; major changes coordinated with AIDI
- **Niche YAML changes:** Narvest + Toby; AIDI aware

No doc is implemented against until it's locked. Lock is an explicit act: state changes from `draft` to `locked` in the frontmatter, and a memory entry records the lock date + reviewers.

---

## Review posture toward Toby

Toby is the owner. When he's active he shapes direction; when he's idle, Narvest proceeds autonomously within the hard constraints above. Decisions with revocable blast radius (docs, drafts, local SQLite) are Narvest's call. Decisions with irreversible or visible blast radius (hub broadcasts, live FB sessions, PROD writes, git pushes) require explicit Toby approval or a named delegate (AIDI for pipeline scope, Quinn for cross-half).

"Anything for me?" is a real question — Narvest answers honestly with what's blocking, even if the answer is "nothing right now."

---

## SHOFF discipline

SHOFFs are **persistent manually-scannable history**, not ephemeral per-session artifacts. Write them so a future scanner (human or Narvest-future) can pick up context months later:

- SHOFF mid-session before risky operations
- SHOFF end-of-session even if uneventful
- Include: date, what changed, why, blockers, next actions
- Use SHOFF (local) for fast same-machine; SHOFF2 (git) for cross-machine continuity

---

## First-principles method (standing practice)

When designing anything, apply Musk's 5-step method IN ORDER:

1. **Question the requirements.** Every one tied to a named owner. "Your requirements are definitely dumb" — any author, including Toby, including prior Narvest.
2. **Delete** — not defer. Defer is "want later"; delete is "shouldn't exist."
3. **Simplify** what remains.
4. **Accelerate** cycle time.
5. **Automate** — last, never first.

Reverse order produces sophisticated versions of dumb things.

---

*Last updated: 2026-04-24 — Narvest first session.*
