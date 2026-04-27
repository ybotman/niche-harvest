---
date: 2026-04-24
persona: narvest
type: plan
state: active
permanence: medium-term
tags: [type/plan, app/tangotiempo, app/global]
appid: 1
mission: M1
---

# niche-harvest — Operational Plan (Restart-Capable)

> **This doc is the operational source-of-truth for where niche-harvest is right now.** A fresh Narvest session should be able to pick up cold from this doc alone (plus memories + latest SHOFF). Updated continuously as work happens — not a snapshot.

> **If you are a new Narvest session:** read §1 (current state) first. Then §3 (open questions — check hub for any answers since PLAN was last updated). Then §6 (phase map — pick up at the first unchecked item in the active phase).

---

## 1. Current state (where are we RIGHT NOW)

**Date of last update:** 2026-04-25

**Active mission:** M1 (see `MISSION.md`) — laptop + tango + full functional parity with current pipeline + design-for-90% load rate.

**Current phase:** **Phase 1 backbone GREEN** end-to-end on slc-wasatch. Stretch (classify + geocode chain) GREEN at 55% geocode rate. All Phase 0 contracts LOCKED.

**Current task:** Validate Phase 1 measurability gates with AIDI; improve geocoder above 90%; add classifier duration-validation gate before Phase 2 (loader). niche-harvest is now its own repo at github.com/ybotman/niche-harvest (Quinn split 2026-04-25).

**What's in-flight right now:**
- LOADER-CONTRACT.md — **LOCKED** 2026-04-24 (AIDI + Fulton + Sarah cleared)
- SAFEGUARD-SPEC.md v3 — AIDI v3 cleared 2026-04-25; mock-FB integrated 2026-04-24 (smoke 15/15); at lock condition
- ARCHITECTURE.md v3 — AIDI overseer cleared 2026-04-25 (3 fixes applied); Fulton loader spot-check pending (pinged 2026-04-25)
- `niches/tango/niche.yaml` — drafted 2026-04-24 (11 YES FB groups + 1 iCal + 2 web sources + full taxonomy; js-yaml parses clean)
- Harvey's reply on slc-wasatch specifics — awaiting (deferred to per-adapter doc when received; not blocking)
- Booker's candidate CSV (group inheritance ranking) — **DELIVERED** commit `03f61cf` at `Collab/handoffs/narvest/m1-group-inheritance-candidates.csv` (11 YES / 83 MAYBE / 282 NO / 3 aggregator-markers)
- Booker's mock-FB server — **DELIVERED + INTEGRATED** at `niche-harvest/test/mock-fb/`; smoke 15/15 in 495ms
- Fulton's Q3 answer (non-Class categoryId lookup) — **RESOLVED** in LOADER-CONTRACT §6.4 (cache-warm via `GET /api/categories?appId=1&limit=500`)

**Blockers:**
- None forcing a hard stop. Docs waiting on reviews; code not started pending lock.

**Not-started-yet (intentional hold until docs lock):**
- No TypeScript code
- No SQLite schema migration
- No adapter implementation
- No loader implementation

---

## 2. Standing directions (cumulative rules)

See memory index at `~/.claude/projects/-Users-tobybalsley-MyDocs-AppDev-MasterCalendar/memory/MEMORY.md` for full list with rationale. Critical ones for niche-harvest:

| Rule | Memory |
|------|--------|
| FTPNTD — fix process not data | `feedback_ftpntd.md` |
| No fallback location stitching | `feedback_no_location_fallback.md` |
| `isDiscovered: true` on all discovery venues + events | `project_isdiscovered_venue_rule.md` |
| Mastering collections are global (geographic) + extended per-niche | `project_mastering_collections_global.md` |
| Sandbox branch naming `sandbox/YYYY-MM-DD-narvest-<desc>` | `feedback_sandbox_branch_naming_convention.md` |
| DELETE vs DEFER distinction | `feedback_delete_vs_defer_distinction.md` |
| First-principles 5-step method (Question / Delete / Simplify / Accelerate / Automate, in order) | `feedback_first_principles_5step.md` |
| niche-harvest is subservient loader (schema owned by Fulton/Sarah) | `project_niche_harvest_is_subservient_loader.md` |
| Clean-room successor (no parallel Mongo writes during M1/M2) | `project_niche_harvest_clean_room.md` |
| M1 = full functional parity + 90%+ load rate (multi-release) | `project_m1_full_functional_parity.md` |
| M1 requires FB (Read 2) | `project_m1_fb_read2_locked.md` |
| FB safeguards non-negotiable (block-detector + rate-limiter + watchdog) | `project_fb_safeguard_requirements.md` |
| FB parsing = GraphQL, not DOM | `project_fb_graphql_parsing.md` |
| 1:1 niche-persona-device (no in-process multi-niche) | `project_one_to_one_niche_persona.md` |
| Niche separation + external device messaging ready from day one | `project_niche_separation_external_devices.md` |
| Deployment is a 101 deliverable | `feedback_deployment_discipline_101.md` |
| Cross-niche design is Narvest's responsibility | `feedback_cross_niche_design_is_narvest_responsibility.md` |
| SHOFFs are persistent archive, write scannably | `feedback_shoffs_are_persistent_archive.md` |
| AIDI's keep/burn list + CDP 2026-04-24 amendment | `feedback_aidi_keep_burn_list.md` |
| BE-AF bulk-enrich not callable — direct Mongo loader interface | `project_be_af_bulk_enrich_not_callable.md` |
| M1 scope locked by AIDI 2026-04-24 | `project_niche_harvest_m1_scope.md` |
| First Pi hardware (8GB Vilros kit, Oct 2023-spec Pi 5) | `project_first_pi_hardware_incoming.md` |
| Mission-to-vision upgrade framing | `project_niche_harvest_mission_framing.md` |
| Obsidian vault + agent SOP | `reference_appdev_obsidian_vault.md` |
| gcal-harvest.ts reference impl | `reference_gcal_harvest_impl.md` |

Any new rule from Toby or senior persona lands in memory first, then pointer is added to this list.

---

## 3. Open questions (by owner)

### 3.1 Awaiting reply

| # | Question | Owner | Asked | Doc / context |
|---|----------|-------|-------|---------------|
| Q-SW-01 | Harvey's slc-wasatch quirks (timezone, format, known bad records) + expansion reference patterns | Harvey | 2026-04-24 | Future `adapters/slc-wasatch.md` |
| ~~Q-BK-01~~ | ~~Candidate CSV~~ | Booker | 2026-04-24 | ✅ DELIVERED commit `03f61cf` on main: 11 YES / 83 MAYBE / 282 NO / 3 aggregator-markers at `Collab/handoffs/narvest/m1-group-inheritance-candidates.csv` |
| Q-BK-02 | Mock-FB server contribution (lands after Booker's SAFEGUARD-SPEC review) | Booker | 2026-04-24 | To go in `test/mock-fb/` |
| Q-BK-03 | Guided `facebook.ts` tour (format: open function + ping with questions, ~30min) | Booker | 2026-04-24 | Use when implementing FB adapter |

### 3.2 Not yet asked (queued)

| # | Question | Owner | Context | Latest-ask trigger |
|---|----------|-------|---------|-------------------|
| Q-AI-02 | calendar-campaigns integration — niche-harvest pushes to its queue directly, or via broker? | AIDI | LOADER-CONTRACT.md §13 | Phase 9 (handoff impl) |
| Q-AI-01-RECONFIRM | Organizer count reconciliation **measurement frame** before Phase 3 — confirm 90% loadable-rate denominator semantics so we measure against the right baseline (Quinn G3 2026-04-25; AIDI already resolved as `Q-AI-R02` what 1,277 vs 683 means, but the M1 gate denominator was not formally re-tied to that ruling) | AIDI | LOADER-CONTRACT.md §13 + Quinn review G3 | **Before Phase 3** (live TEST write) |
| Q-BK-03-PROMOTE | Promote queued Q-BK-03 (`facebook.ts` guided tour) to "asked" — Quinn G2: don't let it become a Phase 6 arrival blocker | Booker | Q-BK-03 in §3.1 | **End of Phase 5** (web scrapers complete) |

### 3.3 Resolved (kept for history)

| # | Question | Owner | Resolved | Answer |
|---|----------|-------|----------|--------|
| Q-AI-R01 | Pipeline health / disposition / BE-AF readiness / keep-burn / M1 scope | AIDI | 2026-04-24 | Clean-room successor; direct Mongo; M1 laptop + tango + 3 sources (now expanded to full parity per Toby); keep SQLite/Nominatim/iCal/sync_status; burn CDP-stealth |
| Q-AI-R02 | iCal feed pick for first adapter | AIDI | 2026-04-24 | slc-wasatch (`wasatchtango@gmail.com`, 338 events 90% quality) |
| Q-FL-R01 | Full BE schema / minimums / timezone / RRULE / AutoMaster / load mechanism | Fulton | 2026-04-24 | Code-cited in LOADER-CONTRACT.md §3–8 |
| Q-FL-R02 | shortName generation + charset + bulk-cache endpoint + 409 retry | Fulton | 2026-04-24 | LOADER-CONTRACT.md §4.2 |
| Q-FL-R03 | Override field names + direct-insert denorm bundle | Fulton | 2026-04-24 | LOADER-CONTRACT.md §6 + §9 |
| Q-SA-R01 | Tango FE minimums + category depth + recurring display + attributes + landmines + travelWorthy/forBeginners source | Sarah | 2026-04-24 | LOADER-CONTRACT.md §5 + §7 |
| Q-BK-R01 | Path D specifics + block-detector signals + rate-limiter values + watchdog cadence | Booker | 2026-04-24 | SAFEGUARD-SPEC.md §3–5 |
| Q-BK-R02 | DOM vs GraphQL parsing + schema versions + key extraction helpers | Booker | 2026-04-24 | LOADER-CONTRACT.md §14 + memory `project_fb_graphql_parsing.md` |
| Q-BK-R03 | CDP stack wrapping seam (direct import vs shared package) | Booker | 2026-04-24 | Option 1 direct import for M1; Option 2 shared package post-M1 |
| Q-BK-R04 | calendar-campaigns handoff schema + gaps | Booker | 2026-04-24 | LOADER-CONTRACT.md §13 |
| Q-AI-R03 | Class in LOAD_TARGETS (6 vs 7) | AIDI | 2026-04-24 | 7 targets; Class opt-in per niche via `niche.yaml: load_classes` |
| Q-TB-R01 | FB M1 interpretation (Read 1 vs Read 2) | Toby | 2026-04-24 | Read 2: M1 must cover meaningful FB Group events; Path D re-authorized with safeguards |
| Q-TB-R02 | SQLite per-niche vs niche-agnostic schema | Narvest (decided, flagged to Toby) | 2026-04-24 | Niche-agnostic schema; niche.yaml drives semantics. Toby silent-assent via "continue"; revisit if future niche breaks shape. |
| Q-SG-R01 | Safeguard gaps (signal-count ownership + baseline bootstrap + watchdog impl + escalation recipient + batch ramp) | AIDI | 2026-04-24 | SAFEGUARD-SPEC.md v2 closes all |
| Q-FL-R04 | Non-Class categoryId lookup — fetch from `categories` collection at startup? | Fulton | 2026-04-24 | LOADER-CONTRACT.md §6.4: cache-warm via `GET /api/categories?appId=1&limit=500` at batch start; Map<categoryName,_id> resolves at insert time |
| Q-LB-R01 | Add `Links/NH-docs` symlink into `AppDev-Obsidian` vault pointing at `niche-harvest/docs/` | Quinn (Librarian offline) | 2026-04-25 | Quinn handled directly: both `Links/NH-docs` and `_GHOST_NH_DOCS` symlinks live |

---

## 4. Cross-persona interaction log

Recent interactions (newest first). Older entries migrate to a per-month archive when this section exceeds ~30 rows.

| Date | Direction | Persona | Subject | Outcome |
|------|-----------|---------|---------|---------|
| 2026-04-24 | AIDI → Narvest | AIDI | SAFEGUARD-SPEC v2 cleared; LOADER-CONTRACT overseer pass next | Booker review unblocked |
| 2026-04-24 | Narvest → Booker | Booker | SAFEGUARD-SPEC v2 ready for implementation review | Pending |
| 2026-04-24 | Narvest → AIDI | AIDI | SAFEGUARD-SPEC v2 (2 gaps closed, 4 Qs answered) | AIDI cleared |
| 2026-04-24 | Booker → Narvest | Booker | Holding per sequence; `fb_dtsg` preview; mock-FB after spec review | Sequencing confirmed |
| 2026-04-24 | AIDI → Narvest | AIDI | SAFEGUARD-SPEC v1 Q1=C with 2 gaps | Informed v2 rewrite |
| 2026-04-24 | Narvest → AIDI + Booker | both | SAFEGUARD-SPEC v1 ready for review | Kicked off review flow |
| 2026-04-24 | Booker → Narvest | Booker | Candidate CSV ranking + 1,277/683 theories + CDP seam Option 1 + mock-FB after-review sequencing + `facebook.ts` tour offer | Applied to LOADER-CONTRACT §14 + memories |
| 2026-04-24 | AIDI → Narvest | AIDI | Class-in-LOAD_TARGETS: 7 targets, opt-in via `load_classes` | Applied to LOADER-CONTRACT §7.1.1 |
| 2026-04-24 | Narvest → AIDI | AIDI | Quick Q on Class | Answered same-session |
| 2026-04-24 | Fulton → Narvest | Fulton | Override field names + direct-insert denorm bundle + shortName endpoints verified + tango-niche-only scope on forBeginners | Applied to LOADER-CONTRACT §6 + §9 |
| 2026-04-24 | Fulton → Narvest | Fulton | shortName pipeline + hybrid-plan flag (denorm gap bigger than I thought) | Applied to LOADER-CONTRACT §6 |
| 2026-04-24 | Fulton → Narvest | Fulton | Full BE authority answer (minimums / timezone / RRULE / AutoMaster / load mechanism / isDiscovered / discoverySource) | Drove LOADER-CONTRACT.md v1 |
| 2026-04-24 | AIDI → Narvest | AIDI | Path D unblocked; safeguards non-negotiable; wrap Booker's CDP | Drove SAFEGUARD-SPEC.md |
| 2026-04-24 | AIDI → Narvest | AIDI | Live status (20% load readiness; 1,277 organizer queue; 3 doc reads) | M1 scope recalibrated to full parity |
| 2026-04-24 | Sarah → Narvest | Sarah | Live-code ground truth on FE minimums + categoryFirst-only + RRULE-master-no-expand + masteredCountryName-landmine + travelWorthy-set-at-load | Drove LOADER-CONTRACT.md §5 + §7 |
| 2026-04-24 | AIDI → Narvest | AIDI | iCal feed pick: slc-wasatch; don't reinvent, steal from gcal-harvest.ts | M1 iCal source locked |
| 2026-04-24 | AIDI → Narvest | AIDI | Ground-truth on pipeline health + clean-room disposition + M1 scope cut | Informed initial M1 scope (later revised) |
| 2026-04-24 | Narvest → AIDI/Fulton/Sarah/Harvey/Booker | all | First contact + Qs | Kicked off loader contract + FB acquisition tracks |

---

## 5. Active documents (niche-harvest/docs/)

| Doc | State | Reviewers | Notes |
|-----|-------|-----------|-------|
| VISION.md | active | — | Aspirational end-state. Rarely updated. |
| MISSION.md | active | — | Currently M1. Rewrite on milestone shift. |
| PLAN.md | active | — | This doc. Updated continuously. |
| LOADER-CONTRACT.md | **LOCKED 2026-04-24** | AIDI + Fulton + Sarah all cleared | Implementation-ready; drift must return to doc not silent divergence |
| SAFEGUARD-SPEC.md | **LOCKED 2026-04-25** | AIDI v3 cleared; mock-FB integrated 15/15 smoke | Readiness-artifact template authoring is Phase 6 deliverable, not lock-blocker |
| ARCHITECTURE.md | **LOCKED 2026-04-25** | AIDI overseer cleared v3; Fulton loader spot-check accepted v4 | Implementation begins. v4 fixes: mastered_division_name added; GeoJSON serialization note; §5.4.1 BE 409 shapes; RawEvent timezone+RRULE pass-through; deps pinned to BE majors |
| CLAUDE.md | active (root) | — | In-repo project doc |

---

## 6. Phase map (M1 ladder)

M1 is delivered in baby-step phases. Each phase ends with a measurable, reviewable artifact. Not all phases are one release; some span multiple.

### Phase 0 — Contract and spec stabilization (current)
- [x] INBOX (first session)
- [x] Read REQUIREMENTS + AS-IS + PROCESS + CATEGORY-MODEL + CLASS-LOADING-PLAN docs
- [x] First-principles cut of requirements (question + delete + defer distinction)
- [x] Reach out to AIDI / Fulton / Sarah / Booker / Harvey for authoritative answers
- [x] Save standing-rule memories
- [x] Write VISION.md
- [x] Write MISSION.md (M1)
- [x] Draft LOADER-CONTRACT.md
- [x] Draft SAFEGUARD-SPEC.md v3 (AIDI v2 cleared; Booker v3 additions applied)
- [x] Write CLAUDE.md
- [x] Write PLAN.md (this doc)
- [x] Draft ARCHITECTURE.md v2 (A1-A4 resolved; §5.4 crash-recovery; SAFEGUARD cross-refs satisfied)
- [x] **Lock LOADER-CONTRACT.md** (AIDI + Fulton + Sarah cleared 2026-04-24)
- [x] Receive Booker's candidate CSV (delivered commit `03f61cf`)
- [x] **Draft `niches/tango/niche.yaml`** (2026-04-24 session 2 — 11 YES FB groups + 1 iCal + 2 web sources + full taxonomy + identity-check; js-yaml parses clean; 83 MAYBE deferred to post-M1 manual triage)
- [x] Receive Booker mock-FB server delivery (`Collab/handoffs/narvest/mock-fb-server/` — server.ts + smoke-test.ts + README; 13-route matrix per SAFEGUARD-SPEC §6.2)
- [x] Move mock-FB server into `niche-harvest/test/mock-fb/` and verify smoke test green (2026-04-24 session 2 — 15/15 pass in 495ms)
- [x] Lock SAFEGUARD-SPEC.md (AIDI v3 cleared 2026-04-25; mock-FB integrated 2026-04-24 with 15/15 smoke)
- [x] Lock ARCHITECTURE.md (AIDI overseer cleared 2026-04-25; Fulton loader spot-check accepted v4 2026-04-25)
- [x] Flag Librarian for vault symlink `Links/NH-docs` (Quinn handled 2026-04-25 — Librarian offline; both `Links/NH-docs` and `_GHOST_NH_DOCS` live)

**Phase 0 gate:** LOADER-CONTRACT.md + SAFEGUARD-SPEC.md + ARCHITECTURE.md all locked; `niches/tango/niche.yaml` drafted with real source inventory.

### Phase 1 — Backbone: single-source iCal snapshot (current; backbone GREEN)
- [x] `core/types.ts` — shared types + path constants (RawEvent w/ timezone_hint + source_rrule pass-through)
- [x] `core/store.ts` — SQLite schema (full §3.1 — 10 tables), WAL, migrations
- [x] `core/config.ts` — niche.yaml loader (js-yaml; strict validation; NicheConfigError on any structural issue)
- [x] `core/adapters/ical.ts` — RFC 5545 parser ported from Harvey's gcal-harvest reference
- [x] `core/geocoder/nominatim.ts` — Nominatim + disk cache + 1.1s rate limit + trusted_country_codes gate
- [x] `core/classify.ts` — identityCheck + classify per LOADER §7 (LONG > SHORT > NEUTRAL precedence)
- [x] `run.sh --niche=tango snapshot` produces `data/tango/snapshots/YYYY-MM-DD.json` — 540 events from slc-wasatch (2,323 in feed → 540 in 7d/365d window → 522 unique by fingerprint)
- [x] `run.sh --niche=tango enrich` runs identity → classify → venue dedup → geocode chain
- [-] Snapshot measurability gates:
  - [x] events_found accounts for entire feed (2323 found, 540 in window, 1783 explicitly skipped — no silent drops)
  - [x] every event in loadable OR skipped (mutually exclusive by code shape)
  - [-] 100% loadable events have geocoded venue — **CURRENTLY 55%** (57/103 venues geocoded; 46 fail mostly on SLC grid-system addresses; needs Phase 1.5 geocoder improvement before live TEST)
  - [x] byte-stable re-run (Day-2: 0 new + 540 dupes)
  - [-] clean Day-2 diff (only relevant when feed actually changes)
- [ ] AIDI parity review of snapshot+enrich output vs Harvey's gcal-harvest

**Phase 1 gate:** slc-wasatch iCal produces a valid snapshot locally, no Mongo writes, no auth, fully dry-runnable. AIDI reviews snapshot for parity-vs-Harvey's output. **Backbone gate met; geocode-rate gate not yet met.**

### Phase 1.5 — Classifier hardening + total_state (DONE 2026-04-25)
- [x] Classifier duration-validation gate (Porter's CALBEAF-141 confirmed pattern; 9 violations now caught on slc-wasatch)
- [x] Structured Nominatim queries via parse-location.ts (Harvey's pattern)
- [x] enrich.json emits `total_state` always-populated section (AIDI Phase 1 blocker fix)
- [x] Schema v2: raw_events.venue_id FK + populate at enrich (AIDI Phase 3 gate item #1)
- [ ] Resolve `Q-AI-01-RECONFIRM` with AIDI before Phase 3 first live load (90% loadable-rate denominator semantics; Quinn G3)

### Phase 1.5b — Source-data coverage improvements (deferred; not a gate)
**Reframed per Toby 2026-04-25** (memory `feedback_no_geocode_no_load_100pct_gate`): the gate is 100% — events without geocoded venue cannot load, period, no fallback. Phase 1.5b is about INCREASING the source-coverage rate (more events become loadable), not "hitting a gate." Current slc-wasatch geocode rate ranges 33–55% across runs (Nominatim-variable without cache); remaining failures are real source-data quality issues that go to `quality_flags: geocode_failed` correctly.
- [ ] Per-niche feed defaults — niche.yaml.sources.X.location_default = {city, state, country} so events with sparse location text inherit the feed's city/state for geocoding
- [ ] Salt Lake City grid-address normalizer — "1321 E 3300 S" → "1321 East 3300 South Salt Lake City UT" before query
- [ ] Optional: alternative geocoder (photon.komoot.io free Nominatim mirror) for low-coverage source feeds

### Phase 2 — Dry-run loader (DONE 2026-04-25)
- [x] `core/loader/interface.ts` — Loader abstraction + OrganizerDoc + VenueDoc + EventDoc shapes per LOADER-CONTRACT §6
- [x] `core/loader/denorm.ts` — buildEventDoc with full §6 denorm; shortName generator §4.2; `authorOrganizerID ← ownerOrganizerID` copy explicit (§6.2 + AIDI 2026-04-25)
- [x] `core/loader/dry-run.ts` — DryRunLoader implements Loader; captures Organizer/Venue/Event docs without writing; dedups by fullName / venue+city
- [x] `core/cli/load.ts` + `bash run.sh load` — orchestrator: enriched raw_events JOIN geocoded venues → docs → DryRunLoader → JSON report
- [x] Report has `this_run`, `total_state`, `quality_flags_this_batch`, `sample_documents` (organizers/venues/events) per AIDI's 3 expectations 2026-04-25
- [x] All §6 fields present in event docs incl. `TODO:automaster` sentinels for mastered chain (verifiable contract honor)
- [ ] `core/loader/mongo-direct.ts` — Phase 3 deliverable; AIDI greenlight required before construction
- [ ] AIDI reviews dry-run report vs. equivalent Porter run

slc-wasatch dry-run report (`data/tango/snapshots/2026-04-25-load.json`):
- 290 enriched seen → 171 eligible_for_load → 171 events would_insert
- 18 skipped_no_venue + 101 skipped_venue_not_geocoded
- 0 organizers (all 10 organizer-bearing events have failed-geocode venues; explainable)
- 171 venue ops: 55 created + 116 existing-dedup
- quality_flags_this_batch: 9 duration_violation + 49 geocode_failed + 134 skip_class_only + 86 skip_unknown + 3 skip_performance

### Phase 3 — Live TEST write (AIDI greenlight gate; in progress 2026-04-25)
**Test isolation:** appId=99 used for all test writes (Toby 2026-04-25). Real tango (appId=1) data untouched. TT FE filters appId=1 so test docs invisible. Cleanup later: `db.events.deleteMany({appId: 99})`.

**Stage 1 — DONE 2026-04-25 (commit b998931):**
- [x] `core/loader/categories.ts` — anonymous BE cache-warm, name→ObjectId Map
- [x] `--be-url` + `--categories-appid` + `--appid-override` + `--no-warm-categories` flags wired
- [x] AIDI gate item #2: categoryFirstId resolves against TEST BE; sample event has real ObjectId (66c4d370a87a956db06c49ea for Practica); `category_id_unknown: 0` on slc-wasatch dry-run

**Stage 2 — BUILD COMPLETE; awaiting Toby per-run --live auth (commits through `d8fb6e1`):**
- [x] `core/loader/mongo-direct.ts` LOADER-CONTRACT §8.2 hybrid impl (organizer POST + 409 retry, venue POST + AutoMaster + 409 fetch, event direct insertOne with anti-recurrence guard) — PROD-STAY-OUT defense via `confirmTestOnly` constructor opt-in
- [x] `--mongo-verify` mode wired in load CLI: connects to TEST Mongo, count BEFORE → DryRunLoader pass → count AFTER → diff=0 assertion → `mongo_verify.status: verified_zero_writes`
- [x] **Toby auth on TEST Mongo URI use** (granted 2026-04-25; --mongo-verify ran clean: events 9603 / venues 2135 / organizers 116 unchanged across run)
- [x] Run `--mongo-verify` against TEST; sent report to AIDI; cleared
- [x] AIDI Phase 3 stage 2 greenlight (2026-04-25)
- [x] H11 nh_batch_id wired in denorm.ts; rollback_commands block in report
- [x] H1/H3 isDiscovered=true filter on Mongo dedup query (mongo-direct.ts)
- [x] Add `--live` flag to load CLI; 3-gate auth: MONGODB_URI_TEST + NICHE_HARVEST_LIVE=1 + confirmTestOnly. Swaps DryRunLoader → MongoDirectLoader. Verified all 3 fail-fast paths.
- [x] **Match-or-explain rule documented** (CLAUDE.md hard constraints + memory `feedback_check_existing_team_code_first`); slc-wasatch comparison 185 vs Harvey 303 fully explained (134 Class + 9 duration_violation gated per current spec)
- [ ] **Toby per-run --live auth** (each run requires explicit "yes go" per PROD-DEPLOY-PROTECTION posture — not standing greenlight)
- [ ] Run `--live --appid-override=99`; verify inserts at appId=99 + appId=1 untouched
- [ ] Post-write parity check vs Porter's TEST load
- [ ] Q-AI-01-RECONFIRM with AIDI before live load (90% loadable-rate denominator semantics)
- [ ] M1 100%-gate compliance measurement (per Toby 2026-04-25: rate is source-quality KPI; gate is binary)

**Live invocation command (when Toby per-run authorizes):**
```bash
cd /Users/tobybalsley/MyDocs/AppDev/MasterCalendar/niche-harvest
URI=$(grep '"MONGODB_URI_TEST"' ../calendar-be-af/local.settings.json | sed -E 's/.*"MONGODB_URI_TEST": "([^"]+)".*/\1/')
MONGODB_URI_TEST="$URI" NICHE_HARVEST_LIVE=1 ./run.sh \
  --niche=tango load --live --appid-override=99 --max-events=500 --samples=10
# → Expected: writes ~185 events / ~48 venues / 0 organizers at appId=99
# → Tagged with nh_batch_id; rollback via report's rollback_commands block

### Phase 4 — iCal portfolio
- [ ] All iCal feeds from `harvester/config/gcal-feeds.yaml` supported
- [ ] Each feed's loadable-rate measured and reported

### Phase 5 — Web scrapers
- [ ] TangoMango adapter (port pattern from `harvester/src/adapters/tangomango.ts`)
- [ ] NYTango adapter (port pattern from `web-page.ts` nytango parser)
- [ ] TEC sites + dc-capital-tangueros adapters

### Phase 6 — FB integration (Booker-wrap + safeguards)
- [ ] **Pre-flight: Chromium memory stress test** on actual hardware target — AIDI flag 2026-04-25; ARCHITECTURE §8 budgets ~800 MB peak Chromium but real-world CDP+FB can hit 1–1.5 GB; validate before committing the rest of Phase 6 to the budget envelope
- [ ] Import Booker's `facebook.ts` / `normalize.ts` / `geocode.ts` / `classify.ts` (Option 1 direct)
- [ ] Implement block-detector per SAFEGUARD-SPEC §3
- [ ] Implement rate-limiter per §4
- [ ] Implement file-based heartbeat watchdog per §5
- [x] Integrate Booker's mock-FB server; full test matrix green (DONE 2026-04-24 — landed at `test/mock-fb/`, smoke 15/15 in 495ms)
- [ ] Wire block-detector integration tests against `test/mock-fb/` per its README §6.3 assertion guide
- [ ] Produce `FB-SAFEGUARD-READINESS-tango.md`
- [ ] AIDI greenlight → smoke batch (2 groups / 5 events)
- [ ] Post-smoke review → full quota (5 groups / 50 events per day)

### Mission 2 design intent — sandbox SQLite for discovery (Toby 2026-04-27 captured-not-yet-built)

When M2 (Discovery engine) starts, niche-harvest must have a **playground / sandbox SQLite** for discovery operations BEFORE candidates promote to live niche.yaml entries. Already a GUARDRAILS S5 commitment ("New auto-discovery queue processes MUST use a sandbox SQLite first; team review before promotion to TEST").

**Pattern (not yet built):**
- New file: `data/<niche>/discovery-sandbox.sqlite` — separate from `harvest.sqlite`
- Tables: `candidate_sources` (URLs found by gap-analysis), `search_results` (raw web/FB queries), `hitl_queue` (awaiting operator approve/reject), `rejected_candidates` (for not-re-trying)
- Operator workflow: discovery process populates sandbox → operator reviews via dashboard or CLI → approved candidates get promoted to `niches/<niche>/niche.yaml` as new source entries → live pipeline picks them up on next snapshot
- Promotion is a HITL gate; no candidate goes live without explicit operator approval (GUARDRAILS G1 + S5)
- Cross-pipeline parallel: same pattern as production playground Mongo (separation is structural, not procedural)

**Why captured-not-built today:** M2 starts after M1 closes. Capturing here so the design assumption (sandbox SQLite + promotion-gate-via-HITL) is locked. No engineering, just architectural intent.

### Phase 8 design intent (Toby 2026-04-27 captured-not-yet-built)

The error/repair feedback loop is M1-required design intent (not built; design assumption captured here so future sessions don't re-derive):

**Pattern:** Harvey → Porter today emits CALBEAF-141 hub signals when ≥N events fail same gate. Operator/AIDI evaluates → asks for fix → Harvey implements → memory captures lesson for future sources. niche-harvest must mirror this:
- **Threshold-based signal emission**: when ≥N events fail same `quality_flag.reason` in a run, emit hub message to AIDI with reason + sample events + run/batch context (CALBEAF-141 shape)
- **Per-event retry queue**: failed Mongo writes go to a retry table; next cycle re-attempts (capped retry_count); after cap → quality_flag with reason `unclassified_failure` + alert
- **Cross-batch repair**: when venue's mastered chain re-resolves upstream, existing events should pick up new value (re-sync mechanism; bounded by `nh_batch_id` window)
- **Lesson-learned cross-niche/source**: when a failure pattern repeats (e.g., SLC grid-address fragmentation surfaces in slc-wasatch → applies to denver-9, denver-10 etc.) — auto-surface via memory + cross-niche.yaml learnings catalog
- **Re-attempt on previously-failed venues**: today's `--retry-failed-venues` flag is manual; should automate per-cycle when geocoder logic improves

**Process pattern (Toby 2026-04-27):** LLM-heavy at design + acceptance + signal evaluation; deterministic at runtime. niche-harvest's hot path is deterministic; signal-emission threshold + retry/repair logic is deterministic; only the EVALUATION-OF-SIGNAL is LLM (operator/AIDI asks for fix, applies, captures lesson).

**Why captured-not-built today:** M1 first --live needs to happen first to surface what Phase 8 must actually handle. Design by observation > design by speculation. But the assumption that Phase 8 will exist and follow this pattern is locked here so future Narvest sessions don't re-derive.

### Phase 7 — Scheduler / autonomous loop
- [ ] `core/engine/scheduler.ts` — self-scheduling driven by `next_check_at`
- [ ] 24h unattended laptop run producing expected deltas

### Phase 8 — Observability + DQ signals
- [ ] Structured logging (JSON)
- [ ] Hub DQ signals at configured thresholds (matches CALBEAF-141 pattern)
- [ ] No silent drops verified end-to-end

### Phase 9 — calendar-campaigns handoff
- [ ] Organizer JSON emission per LOADER-CONTRACT §13
- [ ] Integration with AIDI's calendar-campaigns queue (avoid building second organizer DB)
- [ ] Backfeed on outreach_status

### Phase 10 — M1 close + deploy doc
- [ ] Fresh-laptop reproduction in <30 min by someone else (PROCESS.md § Commands level)
- [ ] Retrospective: 90%+ loadable rate measured? All original Harvey/Booker/Porter functionality covered?
- [ ] M1 MISSION.md archived → M1.5 MISSION.md opens (Pi deployment)

---

## 7. Next session should

When a new Narvest session starts:

1. Run INBOX: check handoffs, call `check_messages`, read this PLAN.md §1.
2. Scan §3.1 (awaiting reply) — any replies arrived since last update?
3. Route any new hub replies into the resolved question log (§3.3) and update §6 phase map if they advance any task.
4. Pick up the FIRST UNCHECKED item in the current phase (§6) or process the next blocker.
5. Write a SHOFF at end of session with: what changed, what's next, any new blockers.

If context shows the current phase is done or blocked beyond current scope — go to Toby for next-phase direction.

---

## 8. Recovery protocol

If PLAN.md feels stale, suspect, or doesn't match observed reality:

1. `git log --since="1 week ago" niche-harvest/` — what was actually committed
2. `ls -t ~/MyDocs/local/handoffs/narvest/*.md | head -5` — last 5 SHOFFs
3. Re-read MEMORY.md top-to-bottom
4. Re-read MISSION.md (are we still on M1? has it been archived?)
5. Before trusting PLAN.md claims, verify against code / hub / git for anything load-bearing.

Memory says what was true at write time. PLAN.md says what I believed at last update. Neither is authoritative over observed current state.

---

*Last updated: 2026-04-24 — Narvest session 2 (ARCHITECTURE.md A1-A4 resolutions + state sync). Next update: on meaningful state change (task completed, question answered, phase advanced) or session end.*
