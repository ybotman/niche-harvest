---
date: 2026-04-24
persona: narvest
type: mission
state: active
permanence: medium-term
tags: [type/mission, app/tangotiempo, app/global, product/mongodb, product/geocoding]
appid: 1
mission: M1
---

# niche-harvest — Active Mission

> **This is what we are actively working on. When this mission is achieved, we archive this doc and start the next one. Updated as scope shifts; never rewritten retroactively.**

---

## Currently on: **M1 — Process Engine, Tango, Laptop, TEST Load**

**Locked:** 2026-04-24 (AIDI greenlit after clarifying scope cut)

### The one-sentence goal

**Prove that a single niche-harvest process can run the full discovery-to-load cycle end-to-end on a laptop, with zero human intervention, from three hand-picked sources into the TEST MongoDB.**

### Why this mission, now

The existing Harvey/Booker/Porter pipeline works but requires manual invocation and has been quality-bottlenecked. Before investing in Pi deployment, LLM-driven adapter generation, or multi-niche scaling, we need proof that the niche-agnostic engine can replicate one proven flow autonomously. **M1 is the credibility gate for everything that follows.**

### Concrete in-scope deliverables

| Area | Deliverable |
|------|-------------|
| **Config** | `niches/tango/niche.yaml` — full niche definition (taxonomy, sources, quality, geocode, loader) |
| **Engine** | `core/engine/scheduler.ts` — self-scheduling loop driven by source `next_check_at` |
| **Store** | `core/store.ts` — SQLite with WAL, all M1 tables (sources, raw_events, events, venues, organizers, work_queue, runs) |
| **Adapters** | 3 adapters: iCal (slc-wasatch Google Calendar), web-tangomango, web-nytango |
| **Geocoder** | `core/geocoder/nominatim.ts` — cache-first, rate-limited, bounds-checked |
| **Classifier** | Niche-agnostic category detector driven by `niche.yaml` taxonomy |
| **Loader** | `core/loader/mongo.ts` — direct MongoDB write (interface-based for bulk-enrich swap later) |
| **Observability** | Structured logs, DQ signals, no silent drops |
| **Dry-run** | First-class `--dry-run` mode, rehearses full pipeline without writing Mongo |
| **Deploy** | `deploy/laptop/run.sh` — one-command reproducible run; README with under-30-min onboarding |
| **Docs** | VISION, MISSION, PLAN, ARCHITECTURE, CLAUDE.md all in Obsidian-compliant metadata |

### The M1 gate (success criteria)

M1 is complete when **all** of the following are true:

1. `./deploy/laptop/run.sh --niche=tango` runs cleanly on a fresh laptop checkout after clone.
2. A full cycle from the three configured sources produces:
   - Raw events → enriched events → geocoded venues → loadable records in local SQLite
   - `--dry-run` mode completes with a report showing what *would* be loaded, no Mongo writes
3. With AIDI's greenlight, running without `--dry-run` writes clean records to TEST MongoDB (TangoTiempoTest) with:
   - `isDiscovered=true` at write time on both events AND venues
   - `discoverySource="niche-harvest"` (per LOADER-CONTRACT §1 + niche.yaml `loader.discovery_source`; NOT `porter`)
   - No fallback location stitching (null geocode → null mastered fields)
4. Every skip/drop emits a structured signal — no silent drops.
5. The classifier is driven from `niche.yaml` (not hard-coded LOAD_TARGETS).
6. The loader is interface-based; swapping direct-Mongo impl for the BE-AF bulk-enrich impl is a single file change.
7. All M1 docs exist, metadata-compliant, vault-linkable.

### Explicit non-goals for M1

Anything not on this list is deferred:

- ❌ Pi hardware deployment or systemd units
- ❌ Watchdog / auto-restart / OTA update
- ❌ Multi-niche "operator mode"
- ❌ FB group adapter (CDP is burned; API path deferred)
- ❌ Discovery engine (Mission 2) — no gap analysis, no web search
- ❌ Build engine (Mission 3) — no LLM adapter generation
- ❌ Dashboard (Mission 2+3 concern)
- ❌ PROD load (TEST only; PROD requires explicit Toby reauth)
- ❌ Replacing Harvey/Booker/Porter (they keep running untouched)

### Scope boundaries (cannot cross without re-scoping)

- Niche: tango only (appId=1)
- Sources: 3 only (slc-wasatch iCal + tangomango web + nytango web)
- Target: TangoTiempoTest (never PROD)
- Runtime: laptop only

### Dependencies on other personas

| Persona | What we depend on | Blocker? |
|---------|-------------------|----------|
| **AIDI** | Greenlight before first TEST write | Yes, at load-time only |
| **Harvey** | Guidance on TangoMango / NYTango adapter patterns; recommended iCal feeds | Advisory |
| **Porter** | Direct-Mongo write pattern reference (venue dedup $near, mastered $near 200km) | Advisory |
| **Fulton** | BE-AF bulk-enrich endpoint (not callable yet — parked; direct write suffices for M1) | Not a blocker for M1 |
| **Sarah** | What TangoTiempo frontend actually consumes (so output is useful, not just loadable) | Advisory |

### Standing commitments carried into M1

These come from team-wide rules (see PLAN.md § Standing directions for the full list):

- FTPNTD — fix the process, not the data
- No fallback location stitching — geocode fail = null
- Dry-run gate before any live write
- DEVL → TEST only in M1; PROD is explicitly excluded
- Every skip/drop is structured (no silent drops)
- Docs written to `niche-harvest/docs/` (Obsidian source-of-truth path)
- Deployment is a 101 deliverable, not a side artifact
- Niche separation readiness from day one — no laptop-only code paths

### M1 archive plan

When M1 is complete:
- Rename this file to `archive/M1-MISSION.md`, change `state: archived`
- Write new `MISSION.md` for M1.5 (Pi deploy) with its own goals/gate
- Log completion in PLAN.md phase map
- Memory entry: "M1 achieved YYYY-MM-DD"

### What comes after M1 (not committed, for context only)

- **M1.5** — Pi deployment: same code on a Pi 5, systemd hardened, dashboard accessible on LAN, runs unattended.
- **M2** — Discovery engine: gap analysis, web/FB group finding, opportunity queue, HITL approve/reject.
- **M3** — Build engine: LLM agent team that writes new adapters from approved opportunities.
- **Scale** — second niche (TBD: swing? bluegrass? birding?), prove niche-agnostic claim.

Each becomes its own MISSION.md when activated.

---

## Related documents

- **VISION.md** — the aspirational north star this mission serves
- **PLAN.md** — concrete action steps within this mission (current phase, current task, open questions)
- **ARCHITECTURE.md** — the end-state design M1 must not foreclose
- **CLAUDE.md** — in-repo agent context (code boundaries, session startup)

---

*Missions are rewritten when scope shifts. The current mission is always the source of truth for "what are we doing right now."*
