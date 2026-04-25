---
date: 2026-04-25
persona: narvest
type: guardrails
state: draft
permanence: long-term
tags: [type/guardrails, app/global, app/tangotiempo, product/mongodb]
appid: global
reviewers: [toby, quinn, aidi, fulton, sarah, harvey, booker, porter]
---

# DATA-ACCESS GUARDRAILS — niche-harvest + Discovery-Half Pipelines

> **Status: DRAFT 2026-04-25.** Drafted by Narvest from Toby's 2026-04-25 framing. Routed through Quinn for cross-project coordination; team review opens once Quinn promotes to `MasterCalendar/docs/`. Operative once team-agreed (signoff matrix in §11).

---

## 1. Why this doc exists

Mongo doesn't enforce row-level security. We can't gate access at the database layer. So **process discipline** is the only gate. This document defines that discipline as three layers:

1. **Hard controls** — code-enforced; no operator can bypass without code change
2. **Soft guidelines** — process-enforced; team-agreed; violation goes to retrospective
3. **HITL gates** — human-in-the-loop authorization required at named points

Toby's 2026-04-25 framing: *"broad autonomy, hard controls, soft-guideline controls, and HITL flushed out."* This doc operationalizes that.

**Scope:** All discovery-half writers — niche-harvest, Porter, Booker, Harvey-output. Calendar-be-af + frontends are downstream consumers and are not the subject of these controls (they have their own access patterns).

---

## 2. The three named data risks

Toby's 2026-04-25 ranking:

### Risk #1 (primary) — isDiscovered boundary violation
Discovery-half pipelines write events/venues/organizers. User-entered events (isDiscovered=false) live in the same collections. **A discovery-half script that ever touches an isDiscovered=false row is a critical incident.** Even a read-then-rewrite-the-same-row is a bug — it changes `updatedAt`, can flip flags, and breaks the operator's trust that user-entered data is sacred.

### Risk #2 — Shared reference / mastered data
`mastered_cities`, `mastered_divisions`, `mastered_regions`, `mastered_countries`, and venues-as-shared-references are global pools (per memory `project_mastering_collections_global`). Discovery-half scripts MUST NEVER write/update/delete any mastered* collection. AutoMaster (BE-side) is the ONLY writer. niche-harvest reads them indirectly via venue POST response.

### Risk #3 — isDiscovered=true errors + boundary cases
Discovery-side writes can still go wrong: bad geocode, wrong category, duplicated venue, malformed RRULE. These are operator errors but they corrupt the discovery half. Recovery means manual cleanup (`db.events.deleteMany({...})`) — fine when bounded by appId / discoverySource / time window; bad when not.

---

## 3. HARD CONTROLS (code-enforced)

These cannot be opted out of by an operator. Violation requires a code change, which goes through review.

**Status column** (per Toby v2 ask): `enforced` = wired in code today; `proposed` = doc says yes, code doesn't yet; `partial` = wired but with known gap.

| # | Rule | Where enforced | Status |
|---|------|----------------|--------|
| H1 | Discovery writers ONLY write `isDiscovered: true` on events/venues/organizers. Never `false`, never updating an `isDiscovered=false` row. | `core/loader/denorm.ts` sets field; UPDATE queries must filter `{isDiscovered: true}` (NOT YET in `mongo-direct.ts`) | **partial** — write field=true ✅; UPDATE filter not yet wired |
| H2 | Discovery writers NEVER write to `mastered_*` collections. AutoMaster (BE) is the sole writer. | `Loader` interface has no method to write mastered_*; nothing to call. Constructor-time collection allowlist check is a belt-and-braces add. | **enforced** by interface absence; allowlist add **proposed** |
| H3 | Fingerprint dedup queries filter `{isDiscovered: true}`. Discovery scripts never collide with user-entered events even by accident. | `core/store.ts` SQLite ✅; Mongo-side dedup query in `mongo-direct.ts insertEvent` | **proposed** — Mongo dedup query needs the filter added before --live |
| H4 | Connection strings come ONLY from env vars. Never hardcoded; never read from git-tracked files at runtime. | `core/loader/mongo-direct.ts` reads `process.env.MONGODB_URI_TEST/PROD`; refuses to construct without it | **enforced** ✅ |
| H5 | `MongoDirectLoader` constructor refuses without explicit `confirmTestOnly: true` opt-in. PROD construction requires a separate `confirmProdAuthorized: true` opt-in. | `core/loader/mongo-direct.ts` constructor | **partial** — TEST opt-in ✅; PROD opt-in **proposed** (gated by first PROD-cycle agreement) |
| H6 | `--dry-run` is the DEFAULT for `load`. `--live` MUST be opt-in via explicit flag + per-run auth. | `core/cli/load.ts` | **enforced** ✅ today (no `--live` flag exists yet); future CLIs MUST follow pattern |
| H7 | Country bounds: geocoder rejects results outside `niche.yaml.geocode.trusted_country_codes`. No fallback substitution. | `core/geocoder/nominatim.ts` evaluateResponse() | **enforced** ✅ |
| H8 | RRULE validation at classify time; malformed → `quality_flag: rrule_invalid`, event excluded. | `core/classify.ts` | **proposed** — needs npm `rrule` validation call wired (today the source RRULE is pass-through unvalidated) |
| H9 | Anti-recurrence guard: events with duration > 24h cannot be recurring. Both `isRepeating` + `recurrenceRule` force-nulled at write time. | `core/loader/mongo-direct.ts` insertEvent | **enforced** ✅ |
| H10 | All writes namespaced by `discoverySource: "niche-harvest"`. | `core/loader/denorm.ts` populates field on every doc | **enforced** ✅ |
| **H11** | **Every write tagged with `nh_batch_id` (UUID per cycle). Rollback = `db.{collection}.deleteMany({nh_batch_id: <id>})`. One-batch-microbatch granularity.** | `core/loader/denorm.ts` adds field; loader CLI generates UUID at run start; report records the batch_id at the top so rollback is trivial. **Updates** (rare; future): need before-state capture in `nh_batch_audit` collection — open question Q7 below. | **proposed** — Toby 2026-04-25 add; concrete write-rollback control |

---

## 4. SOFT GUIDELINES (process-enforced; team-agreed)

These rely on team discipline. The team is honest (Toby 2026-04-25); we keep mistakes for learning; sanity-checks for status updates are the right scope of soft control. Violation goes to retrospective; repeated violation triggers code-enforcement promotion.

| # | Guideline | Why |
|---|-----------|-----|
| S1 | Re-runs of an existing pipeline against an existing source must be **idempotent**: same input → zero new docs. Verified by fingerprint dedup. | Mistakes get exponential if re-runs duplicate |
| S2 | Two run-type classifications declared in `niche.yaml`: **(a) cross-region/travel-worthy** sources (multi-country FB groups, world-aggregator sites) vs **(b) local single-country** sources (local FB groups, city/region sites). | Different blast radius; different controls |
| S3 | Type (b) local sources MUST stay within one country — `geocode.trusted_country_codes` should contain ONE entry. Multi-country results are quality_flag'd, not loaded. | Misclassification of a "local" source as cross-country produces silent geographic drift |
| S4 | Type (a) cross-region sources require **team agreement** before activation: confirm the source fills a coverage gap, isn't duplicating an existing source, and the target geography is intentional. Document in PR description or hub message before merge. | Cross-region writes touch many users |
| S5 | New auto-discovery queue processes (M2 territory) MUST use a sandbox SQLite first; team review before promotion to TEST. | Auto-discovered sources are the most dangerous failure mode (bad source = bad data at scale) |
| S6 | Scripts that mutate data are submitted with: (a) intent statement, (b) expected outcome counts, (c) explicit "areas NOT touching" list. The script + this metadata IS the team agreement. | Forces operator to think through blast radius before run |
| S7 | First run of any new niche / source / adapter goes to TEST. Subsequent runs MAY go direct to PROD via dry-run gate, IF the pipeline has produced clean TEST loads for ≥2 cycles. | First runs surface 80% of bugs; subsequent runs benefit from existing trust |
| S8 | Dry-run output is always inspected before live; no live without a clean dry-run report. | LOADER-CONTRACT discipline |
| S9 | Any write to PROD requires explicit per-run Toby auth (or the named delegate per LOADER-CONTRACT). "Yes" / "OK" / "approved" not sufficient — explicit phrase per PROD-DEPLOY-PROTECTION.md. | Prevents accidental PROD via copy-paste |
| S10 | Cleanup of a discovery-half mistake uses `{appId, discoverySource, ...time-window-or-other-bounds}` queries — never naked deletes. Cleanup script reviewed by AIDI before run on PROD. | Deletes are forever |

---

## 5. HITL GATES (human-in-the-loop authorization)

Named points where a human must explicitly approve before automation proceeds.

| Gate | Who | When |
|------|-----|------|
| **G1** | AIDI | First TEST write of any new niche; any new source-type adapter; any new run-type classification |
| **G2** | Toby | Per-run PROD invocation (every time, no standing greenlight) |
| **G3** | Toby | Per-secret credential authorization (specific URI for specific use; Fulton 2026-04-25 discipline) |
| **G4** | Sarah | Any change that affects FE-rendered fields (categoryFirst values, beginnerFriendly logic, mastered chain shape) |
| **G5** | Quinn | Cross-project spec amendments (LOADER-CONTRACT, SAFEGUARD-SPEC, ARCHITECTURE) |
| **G6** | Booker | FB-adapter changes that touch session/safeguard logic |
| **G7** | Fulton | BE-contract drift (any change to the field shape contract) |
| **G8** | Operator (whoever runs it) | Inspect dry-run report before live invocation; not a passive nod — explicit "I read the X events count + Y skipped count + Z quality_flags and they're expected" |

---

## 6. Run-type classification (per Toby's 2026-04-25 split)

Every source in `niche.yaml.sources.*` carries a `run_type` field (TO BE ADDED — schema v3):

```yaml
run_type: cross_region  # or 'local_single_country'
```

### Type (a): cross_region / travel-worthy
- Multi-country / world-aggregator FB groups
- World-spanning festival/marathon aggregator sites
- Examples: "Tango Festivals Marathons Encuentros and events worldwide" FB group; tangoinfo.world

**Rules:**
- `niche.yaml.geocode.trusted_country_codes` may include multiple
- Activation requires team agreement (S4) — gap-filling rationale documented
- First TEST run reviewed by AIDI before any subsequent run
- Higher rate-limit / lower batch-size defaults to reduce blast on misclassification

### Type (b): local_single_country
- Local city/region FB groups
- Single-city aggregator sites (NewYorkTango, TangoMango if scoped to one country)
- Examples: "Tango Society of Minnesota" FB group; slc-wasatch iCal

**Rules:**
- `niche.yaml.geocode.trusted_country_codes` MUST contain exactly ONE country code
- Geocoded venue with country_code outside that one → `quality_flag: country_mismatch`, event excluded
- No team agreement required for activation (just normal first-run-TEST gate)

### Misclassification handling
If a source declared `local_single_country` produces multi-country results, the source's run_type is wrong. niche-harvest emits a `source_run_type_mismatch` quality_flag at threshold (e.g. ≥10% of events outside expected country) and notifies the operator. Operator either: re-classifies as cross_region (with team agreement) or fixes the source config.

---

## 7. Script-as-agreement pattern (Toby S6)

Every data-mutating script ships with a header block:

```typescript
// SCRIPT INTENT BLOCK (required for any data-mutating script)
//
// PURPOSE: Backfill missing categoryFirstId on events created before
//   2026-04-20 from cache-warmed BE categories.
// EXPECTED OUTCOME:
//   - ~135 events updated (current count of niche-harvest events
//     missing categoryFirstId)
//   - 0 venues touched
//   - 0 organizers touched
//   - 0 mastered_* touched
// AREAS NOT TOUCHING:
//   - isDiscovered=false rows (filter applied)
//   - any mastered_* collection
//   - PROD environment (TEST only; refuses without confirmTestOnly)
// REVIEW: AIDI 2026-04-25 (clear); Toby per-run auth required
// CLEANUP: db.events.updateMany({appId: 99, ...filter}, {$unset: {categoryFirstId: 1}})
```

**Submission:** the script + intent block goes to AIDI (or relevant overseer per G-table) for review. Approval = the block is accurate and the script matches it. Script run is the agreement.

**Automation path (M3+):** automated checker that statically analyzes the script: which collections does it write? What filters does it apply? Are isDiscovered/mastered_* protections in place? Returns pass/fail before human review.

---

## 8. Credential & secret management

Per Fulton 2026-04-25 + Toby 2026-04-25 directives:

| Concern | Rule |
|---------|------|
| Where secrets live | Env vars on the running device. NEVER in git. |
| Dev laptop | Shell env (`~/.zshrc`, per-project `.envrc` via direnv if needed) |
| Lima VM | Same as laptop; `~/.zshrc` in the VM |
| Pi appliance | systemd `EnvironmentFile=/etc/niche-harvest/secrets.env` (root:root, chmod 600); `systemctl restart` after rotation |
| TEST + PROD on same Pi | Discouraged. Cleaner: separate Pi per env. If shared: env vars distinct (`MONGODB_URI_TEST` vs `MONGODB_URI_PROD`); loader picks per niche.yaml `mongo_env` |
| Rotation | Update env source → restart service. No code change. |
| Per-secret authorization | Each secret + its destination requires explicit Toby auth. Not transitive: "Toby authorized writing to TEST" ≠ "Toby authorized you to USE the URI." Fulton's 2026-04-25 discipline. |
| Sharing channel | Toby picks: Collab handoff at agreed path, hub message, or paste-direct. Never auto-share. |
| In code | `process.env.X`. Never `import` from a settings file. Never log a secret. Never echo in messages. |

---

## 9. TEST → PROD promotion ladder (per code class)

| Class | Path |
|-------|------|
| New adapter (e.g., a new FB group) | local + dry-run → Lima dry-run → TEST first run (AIDI G1) → 2 clean TEST cycles → eligible for PROD per S7 |
| Adapter behavior change (e.g., RRULE handling) | unit tests (mandatory) + local dry-run → Lima dry-run → TEST → AIDI review → PROD per per-run Toby G2 |
| Schema migration (new column) | additive-only by default; tests; Lima → TEST → PROD with explicit Toby auth on each env |
| Loader interface change | Quinn G5 spec amendment first; then code; then test/local/Lima/TEST/PROD ladder |
| Cleanup script (mutates existing data) | Script-intent block (S6); AIDI review; TEST trial run with `--dry-run`; explicit Toby G2 auth per-run |
| New niche.yaml file | dry-run + enrich validation; AIDI G1 first TEST; subsequent runs per S7 |

**The "skip TEST" allowance (per Toby 2026-04-25):**
- Adapter for an EXISTING type that's run cleanly in TEST ≥2 cycles → may go direct to PROD with `--dry-run` gate + Toby G2 auth
- New adapter type / new niche / new field shape → ALWAYS goes to TEST first

---

## 10. Deferred / not-yet-locked items

These are explicitly DEFERRED until we're closer to needing them. No agreement asked today; flagged so we don't forget:

- **Specific cleanup-script catalog** (one per known mistake class) — defer until first cleanup needed
- **Automated script-checker** (S6 → automation) — M3+ territory; build when manual review is the bottleneck
- **PROD-on-Pi bootstrap procedure** — defer until Pi M1.5 phase
- **Cross-Pi state replication** (if we ever want fleet-wide deduplication) — defer until 2nd niche on 2nd Pi
- **Audit log of every write** — defer; today's `runs` + `quality_flags` tables provide it; promote to dedicated audit table when scale demands

---

## 11. Team agreement matrix

This doc is operative once each named reviewer signs. Signature = "I've read this; I agree the framework is right; specific implementations within this framework get my normal review per G-table."

| Reviewer | Domain ownership | Signed |
|----------|------------------|--------|
| Toby | Owner; final authority on PROD + secrets | _pending_ |
| Quinn | Cross-project coordination; doc location + spec amendments | _pending_ |
| AIDI | Discovery-half overseer; runs G1 + cleanup-script reviews | _pending_ |
| Fulton | BE-AF contract owner; G7; credential discipline | _pending_ |
| Sarah | TT FE consumer; G4 | _pending_ |
| Harvey | iCal pipeline; H8/H9 enforcement | _pending_ |
| Booker | FB-adapter; G6; safeguard implementation | _pending_ |
| Porter | MongoDB loader (existing); pattern parity | _pending_ |

When all signed → state: `agreed`; promote to `MasterCalendar/docs/DATA-ACCESS-GUARDRAILS.md` (Quinn's domain). Updates to the doc require a re-signoff round.

---

## 12. Open questions for the review round

1. **niche.yaml `run_type` field — schema v3?** Adding it requires a niche.yaml schema bump. Migration path for existing tango/niche.yaml: default to `local_single_country` since slc-wasatch is single-country.
2. **Cross-pipeline scope** — are these guardrails niche-harvest-only, or do Porter/Booker/Harvey need to retrofit? Quinn's call after AIDI weighs in.
3. **HARD CONTROL H5** — PROD `confirmProdAuthorized` opt-in shape. Boolean is too easy to flip; should it be a runtime check against an env var that the operator must set explicitly per session?
4. **GUIDELINE S5** — sandbox sqlsvr for new auto-discovery queue. Toby mentioned this; what's the actual sandbox? In-memory SQLite per-session? A separate Mongo DB? Defer until M2 design.
5. **GUIDELINE S6** — automated script-checker target language: TypeScript static analysis, or runtime sandbox-and-observe?
6. **HITL G8** — operator-inspect-before-live: how is this enforced when a `--live` invocation is automated (cron-scheduled scheduler in M1 Phase 7+)? Does scheduler always require dry-run+human-ack, or can a fully-trusted source bypass after N clean cycles?
7. **H11 update-rollback** — `nh_batch_id` makes INSERT rollback trivial (deleteMany by batch). Updates are rare but real (e.g., enriching an existing event with newly-resolved venue lat/lng). Options: (a) capture before-state into `nh_batch_audit` collection at update time (small overhead, full rollback); (b) treat updates as "new batch tagged + soft-delete-old" (pure-insert pattern, larger storage); (c) defer updates to a separate code path with explicit per-update auth (most conservative). Toby 2026-04-25 flagged as open. Lean toward (a); confirm with team.

---

## 13. Change log

| Date | Change | Source |
|------|--------|--------|
| 2026-04-25 | Initial draft | Narvest synthesis from Toby 2026-04-25 framing |

---

*This doc is the agreement on the SHAPE of the box we work inside. Specific implementations land as we hit each concern; this doc gets updated when the agreement evolves.*
