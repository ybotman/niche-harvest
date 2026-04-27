---
date: 2026-04-24
persona: narvest
type: decision
state: locked
permanence: long-term
tags: [type/decision, app/tangotiempo, app/global, product/mongodb, product/geocoding]
appid: 1
reviewers: [aidi, fulton, sarah]
locked_at: 2026-04-24
locked_by: [aidi, fulton, sarah]
---

# LOADER-CONTRACT — niche-harvest → MasterCalendar

> **Status: LOCKED 2026-04-24.** AIDI overseer cleared v2 → Fulton BE acceptance v3 → Sarah FE consumption sanity-check v3. All three reviewers cleared. Implementation begins against this contract; drift must return to this doc for update, not silent divergence (Fulton 2026-04-24).

> **What this is:** The complete contract niche-harvest honors when writing discovered events, venues, and organizers into the MasterCalendar ecosystem. niche-harvest is subservient to this contract — it does not design the schema, it conforms.

> **What this is not:** Internal niche-harvest architecture (that lives in `ARCHITECTURE.md`). Adapter-specific details (those live per-adapter in `adapters/*.md`). FB session safeguards (those live in `SAFEGUARD-SPEC.md`).

> **⚠ Cross-niche scope note:** Every authoritative answer in this draft came from tango-scoped persona knowledge (Fulton / Sarah / Booker / AIDI). Rules split into two buckets:
> - **Universal** (applies to every niche): UTC Zulu, RRULE contract, `isDiscovered=true`, dependency ordering, no-fallback-location, no-silent-drops, dry-run discipline, `*Override` mechanism.
> - **Niche-specific** (currently tango, parameterized via `niche.yaml`): category strings, load targets, `travelWorthy`/`forBeginners` eligibility, domain attributes (DJ/orchestra/instructor/cost), `load_classes` flag.
>
> Each section below marks which bucket its rules fall into. When future niches land (swing, bluegrass, birding, …), niche-specific rules get replaced from their `niche.yaml`; universal rules do not change. The SQLite schema stays niche-agnostic — same columns everywhere, semantics driven by config.

---

## 1. At-a-glance

| Rule | Value |
|------|-------|
| Time format | UTC Zulu on `startDate` / `endDate`; loader writes UTC, never local |
| RRULE | Single record with RRULE string; FE expands via `rrule.between()`; never pre-expand |
| Anti-recurrence | Events with `endDate - startDate > 24h` cannot be recurring (BE force-nulls `isRepeating` / `recurrenceRule`) |
| Max event duration | 168h (7 days) |
| Dependency order | Organizer → Venue → Event (not BE-enforced but denorm breaks if skipped) |
| isDiscovered | `true` on both Venues and Events (mandatory) |
| discoverySource | `"niche-harvest"` (convention; not BE-enforced; no current reader) |
| Load mechanism | Hybrid: Venues via HTTP POST (anonymous, free AutoMaster); Events via direct Mongo `insertOne` with loader-pre-computed denorm |
| Geocode gate | 100% of loaded events have geocoded venue (lat/lng non-null). No fallback stitching. |
| Silent drops | Forbidden. Every non-loadable event emits a structured `quality_flag` with reason. |
| Classifier output | `{ categoryFirst, categorySecond, categoryThird, attributes, skipReason }` — `attributes` stays in SQLite, never to MongoDB |
| Override fields | Loader sets both base field AND `*Override` for `travelWorthy` / `beginnerFriendly` / `forBeginners` |
| nh_batch_id | Every venue / organizer / event tagged with per-cycle UUID (GUARDRAILS H11). Format: `nh-<niche>-<utc-yyyymmddThhmmss>-<8-char-uuid>`. Rollback = `db.<collection>.deleteMany({nh_batch_id: <id>})`. |

---

## 2. Authority

The loader contract is owned jointly by:

- **Fulton** (calendar-be-af) — BE schema, timezone/Zulu semantics, RRULE storage, Venues_AutoMaster, enrichment pipeline, load endpoints
- **Sarah** (TangoTiempo FE) — what renders, what filters, what breaks the user experience
- **AIDI** (discovery overseer) — cross-source consistency, DQ thresholds, calendar-campaigns coordination

niche-harvest does not unilaterally change this contract. Changes are negotiated upstream; this doc is updated when the upstream contract changes.

---

## 3. Venue contract

### 3.1 Hard minimums (BE rejects below this)

Source: Fulton 2026-04-24, `calendar-be-af/src/functions/Venues.js:356-381`.

- `name` — string, non-empty
- `latitude` — number, valid range
- `longitude` — number, valid range

If any missing → BE returns 400. Event loading halts.

### 3.2 Strongly recommended (Sarah's rendering minimums)

Missing these does not block load but degrades TT rendering:

- `address` — freeform address string
- `city` — string
- `state` — string (US/CA) or null
- `country` — string
- `appId` — integer; required by venue_appId semantics (tango = 1)

### 3.3 Set by BE (loader leaves null; BE honors if pre-supplied)

BE computes these at venue create when loader leaves them null. **FE-wins policy** (Fulton 2026-04-24): if loader pre-supplies `masteredCityId` (or any mastered Id), BE honors it and skips AutoMaster. niche-harvest will NOT pre-supply — we want AutoMaster to do the resolution work — so in practice these fields are BE-computed.

- `timezone` — resolved from `getTimezoneForVenue({city, state, country})`
- `geolocation` — GeoJSON Point from lat/lng
- `masteredCityId` / `masteredCityName` / `masteredDivisionId` / `masteredDivisionName` / `masteredRegionId` / `masteredRegionName` / `masteredCountryId` / `masteredCountryName` — resolved by `Venues_AutoMaster` at POST `/api/venues` (synchronous, within ≤50km AUTO_HIGH / 50-200km AUTO_MEDIUM / >200km MANUAL)
- `masteringStatus` — set by AutoMaster
- `_id` / `createdAt` / `updatedAt` — Mongo / BE

### 3.4 Loader-set

- `isDiscovered: true` (mandatory per Toby 2026-04-19 rule)
- `discoverySource: "niche-harvest"` (convention)
- `nh_batch_id: "<run-uuid>"` (GUARDRAILS H11; per-cycle UUID for rollback; format `nh-<niche>-<utc>-<8>`)

### 3.5 Load mechanism for venues

**POST `/api/venues` (anonymous auth).** Gets synchronous AutoMaster resolution for free. Returns the resolved venue document including mastered chain — **capture this response; loader uses its fields when pre-computing event denorm** (§6).

**Dedup is BE-owned.** BE returns 409 if a venue within ~91.44m already exists. Loader catches 409, fetches the existing venue, proceeds with that `_id` and its resolved mastered chain.

---

## 4. Organizer contract

### 4.1 Hard minimums (BE rejects below this)

Source: Fulton 2026-04-24, `calendar-be-af/src/functions/Organizers.js:315-339`.

- `fullName` — string, non-empty
- `shortName` — string, validated per `organizerShortNameRules.js` (appId=1 rules below)

### 4.2 `shortName` generation (appId=1 rules)

Source: Fulton 2026-04-24, `src/lib/organizerShortNameRules.js:17-25`.

**Charset:**
- Length 3–12
- First 3 characters MUST be A-Z letters
- Characters 4+ may be A-Z, 0-9, or hyphen
- Must END alphanumeric (no trailing hyphen)
- No consecutive hyphens, no spaces, no underscore, no unicode
- Case-insensitive (normalized UPPERCASE)
- Reserved: `['CHANGE']`

**Generation recipe:**

1. Cache-warm bulk list of existing shortNames (once per batch): `GET /api/organizers/shortnames?appId=1` (requires API key in `X-API-Key` header; 60s BE-side cache; p95 <500ms).
2. Generate candidate from `fullName`:
   - Strip non-alphanumerics
   - Uppercase
   - Take first 3 letters + initials of next words (acronym strategy fits tango org names well)
   - Length check 3–12
3. If candidate in cache-warm set → append suffix: `WTS` → `WTS-2` → `WTS-3`... (hyphen + digit is charset-legal)
4. Before POST, optional probe: `GET /api/organizers/shortname-check?appId=1&candidate=WTS-2` (anonymous auth, p95 ~100ms) — cleaner logs than 409-retry.
5. `POST /api/organizers` with `{fullName, shortName, ...}`.
6. On 409 `DuplicateError` → increment suffix → retry (cap 5 attempts).
7. On exhaustion → log + skip + queue for human resolution (never silently drop).

### 4.3 Lookup-before-create

If an organizer with matching `fullName` already exists with a null/legacy shortName, niche-harvest does **NOT** PATCH it. Loader:

- Looks up existing organizer by `fullName` (+ optional `fb_profile_url` for disambiguation)
- If found: use existing `_id`, skip create
- If not found: generate shortName per §4.2, POST create
- Never PATCH from loader — PATCH requires Firebase auth + org-or-admin permission; not a loader concern

### 4.4 Set by BE, do NOT set from loader

- `_id` / `createdAt` / `updatedAt`

### 4.5 Loader-set (beyond minimums)

- `fb_profile_url` if known
- `discovery_type` (e.g., `event_host` / `shared_to_group` / `created_in_group`)
- `event_count` if tracked
- `isDiscovered: true` (convention for niche-harvest organizers)
- `discoverySource: "niche-harvest"`
- `nh_batch_id: "<run-uuid>"` (GUARDRAILS H11)

### 4.6 Scope note: appId=1 only

shortName rules are only configured for appId=1 (tango). appId=2+ validator returns `{valid: true}` pass-through. Future niches must confirm their appId's rules before assuming.

---

## 5. Event contract

### 5.1 Hard minimums (BE rejects below this)

Source: Fulton 2026-04-24, `calendar-be-af/src/functions/Events.js:851-913`.

- `appId` — integer (tango = 1)
- `title` — string, non-empty
- `startDate` — valid Date (ISO 8601 preferred; stored as Mongo Date = UTC Zulu)
- `endDate` — valid Date

### 5.2 Hard minimums from PROCESS.md + Sarah (niche-harvest requires before load)

Stricter than BE-minimum. These are niche-harvest's own gate — events not meeting these go to `quality_flags`:

- `categoryFirst` — one of the 10 valid strings (§7)
- `venueID` — resolved venue ObjectId (Event with no venue cannot be loaded)
- Venue `latitude` + `longitude` — non-null (geocode gate; 100% requirement)
- `venueCityName` (denorm from venue) — non-null after venue insert
- `masteredCountryName` — non-null (Sarah's #1 landmine — null → silent "Other" row, events invisible)

### 5.3 Strongly recommended (Sarah's rendering quality)

- `masteredCityName` — shown in card subtitle + timeline popup; also used as primary label in Explore views
- `venueGeolocation` — needed for map pin + timeline drill-through map-center
- `ownerOrganizerID` — shown on calendar cards as short badge
- `description` — shown in detail modal

**`venueCityName` vs `masteredCityName` dual-render (Sarah 2026-04-24):** TT calendar card views render `venueCityName` from the denorm bundle; Explore views render `masteredCityName` directly. Both fields are in play across different TT surfaces. `venueCityName` is a hard gate (§5.2) because calendar cards break without it; `masteredCityName` is strongly recommended because Explore degrades without it. Both are populated from the same venue-POST response chain (§6.1), so the cost to include both is zero.

### 5.4 Tango-domain attributes (rendered today, set where signal exists) — **NICHE-SPECIFIC**

These are tango's rendered domain attributes. Other niches (swing, bluegrass, birding) will have their own — specified per-niche in `niche.yaml`. Framework supports arbitrary named attribute fields; niche declares which are rendered vs. ignored.


- `dj` — "DJ: Name" badge
- `orchestra` — "LIVE! Orch: Name" inverted green row
- `instructor` — "Inst: Name" badge
- `cost` — shown in detail modal
- `features[]` — typed array including `{type: 'dj', name: '...'}` pattern

NOT rendered today, safe to skip emitting: `level`, `style`, `musicType`.

### 5.5 Set by BE on HTTP POST path — loader pre-computes on direct Mongo path

This table describes which fields niche-harvest must pre-compute for the direct-Mongo event insert path (§8.2). If niche-harvest ever switched to HTTP POST `/api/events`, BE would fill these automatically — but the direct-Mongo path bypasses BE's enrichment, so loader pre-computes per §6.

- `_id` / `createdAt` / `updatedAt` — Mongo / BE (always BE; never pre-compute)
- `authorOrganizerID` — BE copies from `ownerOrganizerID` on HTTP POST path; via direct Mongo, loader must copy explicitly (§6.2)
- `enrichmentStatus` — pipeline writes `'complete'` on HTTP POST path; loader writes `'complete'` on direct Mongo path (§6.2)
- `venueTimezone` / `venueCityName` / `venueGeolocation` — enrichment writes from venue on HTTP POST path; loader pre-computes from venue-POST response on direct Mongo path (§6.1)
- Base `travelWorthy` / `beginnerFriendly` / `forBeginners` — recomputed on every write. Use `*Override` to force via loader (§9)

### 5.6 Loader-set (beyond minimums)

- `isDiscovered: true` (mandatory)
- `discoverySource: "niche-harvest"` (convention)
- `trustLevel: "ai_discovered"` (PROCESS.md trust levels)
- `shortTitle` — truncated title at delimiters (≤40 chars recommended)
- `nh_batch_id: "<run-uuid>"` (GUARDRAILS H11; per-cycle UUID for rollback)

---

## 6. Denormalization bundle (loader pre-computes for direct Mongo insert)

When loader uses direct Mongo `insertOne` on events (§8), the BE enrichment pipeline does not run. niche-harvest must pre-compute the full denorm bundle from the just-inserted venue document.

### 6.1 Bundle fields (copy from venue response after venue POST; lookup `masteredcities` for geolocation)

Source: AIDI verified against `porter/scripts/load-from-harvey.ts`; Fulton corrected `masteredCityGeolocation` source + `venueCityName` source + added `masteredDivisionName` 2026-04-24.

```
event.venueTimezone             ← venue.timezone
event.venueCityName             ← venue.masteredCityName (AutoMaster-canonicalized)
                                  fallback: venue.city (+ quality_flag: city_unresolved)
event.venueGeolocation          ← venue.geolocation (GeoJSON Point)
event.masteredCityId            ← venue.masteredCityId
event.masteredCityName          ← venue.masteredCityName
event.masteredCityGeolocation   ← masteredcities.findOne({_id: venue.masteredCityId}).location
                                  (NOT venue.masteredCityGeolocation — that field doesn't exist on venue docs)
event.masteredDivisionId        ← venue.masteredDivisionId
event.masteredDivisionName      ← venue.masteredDivisionName (populated by AutoMaster; FE filter wired)
event.masteredRegionId          ← venue.masteredRegionId
event.masteredRegionName        ← venue.masteredRegionName
event.masteredCountryId         ← venue.masteredCountryId
event.masteredCountryName       ← venue.masteredCountryName
```

**`masteredCityGeolocation` source note (Fulton 2026-04-24):** The field does NOT live on venue docs. It lives on events (where we write it) and conceptually on `masteredcities.location`. Loader reads `masteredcities` collection by `_id = venue.masteredCityId` and copies the `location` field (GeoJSON Point). The events collection has a 2dsphere index on this field — writes MUST be valid GeoJSON Point or `$geoWithin` queries fail silently.

**Batch optimization:** Loader caches `Map<masteredCityId, location>` for the batch lifetime. Same `masteredCityId` appears across many venues in a niche (one city has many venues), so the cache resolves to ~10-50 Mongo reads per batch instead of one-per-venue.

**`venueCityName` source note (Fulton 2026-04-24):** BE enrichment prefers `venue.masteredCityName` (AutoMaster-canonicalized) over `venue.city` (free-form input) — per `src/utils/enrichment.js:384-385`. Loader follows the same rule. If AutoMaster did not resolve a mastered city for the venue (MANUAL bucket, >200km from any mastered city), loader falls back to `venue.city` AND emits a `city_unresolved` quality_flag on the event so operators can review.

**`masteredDivisionName` note (Fulton 2026-04-24):** Porter does NOT write this field today, but the FE has a live filter on `masteredDivisionName` (query param wired in `Events.js:147, 180`). Omitting makes Porter-loaded events invisible under that filter. niche-harvest includes it to avoid inheriting Porter's invisibility gap. `venue.masteredDivisionName` IS populated by AutoMaster (`Venues.js:465`), so it's free — one more copy line.

### 6.2 Loader-derived event fields

```
event.authorOrganizerID      ← event.ownerOrganizerID (copy; BE does this on HTTP POST, loader does it on direct Mongo)
event.enrichmentStatus       ← 'complete'
event.trustLevel             ← 'ai_discovered'
event.isDiscovered           ← true
event.discoverySource        ← 'niche-harvest'
```

### 6.3 Classifier-derived fields with overrides (§9)

```
event.travelWorthy                     ← computed by classifier
event.travelWorthyOverride             ← same value (makes it stick)
event.beginnerFriendly                 ← computed (tango-only; null for non-tango niches)
event.beginnerFriendlyOverride         ← same value
event.forBeginners                     ← computed (tango-only; null for non-tango niches)
event.forBeginnersOverride             ← same value
```

### 6.4 Category IDs (string + ObjectId lookup)

**Mongo event documents store `categoryFirstId` / `categorySecondId` / `categoryThirdId` as ObjectIds — NOT strings.** The string fields (`categoryFirst` / `categorySecond` / `categoryThird`) are internal SQLite representation and optional-diagnostic passthrough on Mongo writes. BE reads the ObjectIds, not the strings.

**Resolution pattern (Fulton 2026-04-24):** loader cache-warms the categories collection once per batch via `GET /api/categories?appId=1&limit=500` (anonymous auth, `src/functions/Categories.js`). Returns `{categories: [{_id, categoryName, ...}], pagination: {...}}`. Tango categories fit well under the 500 limit.

```typescript
const res = await fetch(`${BE_URL}/api/categories?appId=1&limit=500`);
const { categories } = await res.json();
const categoryNameToId = new Map(
  categories.map(c => [c.categoryName, c._id])
);

// At event-insert time:
event.categoryFirstId = new ObjectId(categoryNameToId.get('Milonga'));
event.categorySecondId = event.categorySecond ? new ObjectId(categoryNameToId.get(event.categorySecond)) : null;
event.categoryThirdId = event.categoryThird ? new ObjectId(categoryNameToId.get(event.categoryThird)) : null;
```

**Cache TTL:** batch lifetime. Categories rarely change. If a classifier emits a category string absent from the Map → `quality_flag: category_id_unknown`, event excluded from load.

**Known:** Class ObjectId = `66c4d370a87a956db06c49eb` stable across TEST + PROD. Cache-warm pattern makes this fact academic — the Map resolves dynamically and works across envs without hardcoding.

**String passthrough (optional):** loader MAY also write `categoryFirst` / `categorySecond` / `categoryThird` string fields to events for diagnostic value. BE does not read them but pass-through is harmless per Fulton 2026-04-24.

---

## 7. Category model

**Scope: NICHE-SPECIFIC (currently tango / appId=1).** The category strings, load targets, duration rules, and override eligibility below are tango's. Swing, bluegrass, birding, and any other future niche will have their own category sets driven by their own `niche.yaml`. The framework mechanism (10 strings + 7 load targets + skipReason derivation + hard-rule enforcement) is universal; the VALUES are per-niche.

Source of truth (tango): TangoTiempo's `eventCategoryValidation.js` (Sarah's domain). Discovery-half application notes: `ai-discovered/docs/CATEGORY-MODEL.md`.

### 7.1 Valid `categoryFirst` strings (10)

| String | Duration | TT-canonical? | Load target? |
|--------|----------|---------------|--------------|
| `Festival` | LONG ≥24h | ✅ | ✅ LOAD |
| `Marathon` | LONG ≥24h | ✅ | ✅ LOAD |
| `Encuentro` | LONG ≥24h | ✅ | ✅ LOAD |
| `Workshop` | LONG ≥24h | ✅ | ✅ LOAD |
| `Milonga` | SHORT ≥15m <24h | ✅ | ✅ LOAD |
| `Practica` | SHORT ≥15m <24h | ✅ | ✅ LOAD |
| `Class` | SHORT ≥15m <24h | ✅ | ✅ LOAD (opt-in per niche; see §7.1.1) |
| `Trip` | NEUTRAL | ✅ | ❌ skip_trip |
| `Unknown` | NEUTRAL | ✅ | ❌ skip_unknown (routes to NEW triage) |
| `Performance` | NEUTRAL | ❌ Discovery-only | ❌ skip_performance |

### 7.1.1 Class loading is opt-in per niche

Ground truth from AIDI 2026-04-24 (verified from Porter's `quality.ts` + `load-from-harvey.ts` / `load-from-booker.ts`):

- LOAD_TARGETS in `quality.ts` includes 7 categories (Class added by CALBEAF-138).
- Load SQL filters default to 6 — Class only enters WHERE clause when `--include-classes` flag is passed.
- `skip_class_only` is NOT dropped; it is bypassed only when the flag is set.

**niche-harvest mirrors this with a per-niche `niche.yaml` option:**

```yaml
# niches/tango/niche.yaml
loader:
  load_classes: true   # default: false
```

Behavior:

- `load_classes: false` (default) → 6 load targets. Rows with `skipReason='skip_class_only'` stay in local SQLite, never written to Mongo.
- `load_classes: true` → 7 load targets. Rows with `categoryFirst='Class'` (including those carrying `skip_class_only`) become loadable, subject to all other gates (geocode, venue, etc.).

**Wire it as niche-level config, not a global toggle.** Dense urban tango scenes want classes; festival-only niches do not.

Combo events are unaffected: Class as `categorySecond` / `categoryThird` on a Milonga/Practica has always loaded (the class is metadata, not a reason to skip).

### 7.2 Hard rules (enforced by TT validation)

1. **SHORT + LONG cannot mix** across the three slots of one event.
2. **Max 7 days (168h)** for any event.
3. **`Unknown` is a legit bucket** for ambiguous events — do NOT force-map.

### 7.3 `skipReason` derivation (deterministic; loader writes it)

```
IF categoryFirst == 'Class' AND categorySecond == null AND categoryThird == null:
    skipReason = 'skip_class_only'
ELIF categoryFirst NOT IN {Milonga, Practica, Festival, Marathon, Encuentro, Workshop}:
    skipReason = 'skip_' + lowercase(categoryFirst)   // skip_performance, skip_trip, skip_unknown
ELSE:
    skipReason = null
```

Policy in one place — at prep/classifier time. Porter/niche-harvest NEVER re-derives. Class-as-Second or Third on a Milonga/Practica loads normally (the class is metadata about the milonga, not a reason to skip).

### 7.4 Category precedence (resolving multi-signal events)

If LONG signals present → LONG wins completely; SHORT signals in same text are DROPPED (not slotted, not echoed to attributes).

If no LONG → SHORT core: Milonga > Practica > Class.

If no SHORT → Performance > Trip > Unknown.

### 7.5 `travelWorthy` eligibility — **NICHE-SPECIFIC (tango)**

For tango (appId=1):

**Eligible:** Festival, Marathon, Encuentro, Workshop, DayWorkshop (LONG or day-workshop).

**Never travelWorthy:** Class, Milonga, Practica.

Loader sets `travelWorthy: false` explicitly for SHORT categories; loader sets `travelWorthy: true` for LONG categories ≥24h where niche signal supports it.

### 7.6 `forBeginners` / `beginnerFriendly` eligibility — **NICHE-SPECIFIC (tango)**

For tango (appId=1):

**Eligible categories:** Class, Workshop, DayWorkshop. For any other category, loader sets `forBeginners: false` and `beginnerFriendly: false` (unless explicit friendly-only signals for beginnerFriendly).

**Scope:** tango-only. For future niches, null-leave unless niche semantics are explicitly defined by the niche's frontend owner. Fulton confirmed the classifier hard-skips these fields for non-Tango appIds (`enrichment.js:340`).

Loader classifier stages (from Fulton's `enrichment.js`):

- Stage 0: explicit-negative in title (advanced, intermediate, level 2+) → false/false
- Stage 1: explicit-positive in title (absolute beginner, newcomer, intro, level 1, from scratch) → true/true
- Stage 2: friendly-only in title (all-levels, open-levels, mixed-levels) → false/true
- Stage 3: explicit-positive in description → true/true
- Stage 4: friendly-only in description → false/true
- Default: false/false

---

## 8. Load mechanism

### 8.1 Dependency ordering

Organizer → Venue → Event. Not BE-enforced; denorm breaks if skipped.

### 8.2 Per-object mechanism

| Object | Mechanism | Why |
|--------|-----------|-----|
| Organizer | POST `/api/organizers` (anonymous) | Gets shortName validation, uniqueness check, BE assigns `_id` |
| Venue | POST `/api/venues` (anonymous) | Gets synchronous AutoMaster resolution (mastered chain), BE assigns `_id` and timezone |
| Event | Direct Mongo `insertOne` | Avoids Firebase-auth requirement on POST `/api/events`; loader pre-computes full denorm bundle (§6) |

**Justification for hybrid:** HTTP for venues gives us AutoMaster free. Direct Mongo for events avoids the Firebase-auth complexity while loader accepts the responsibility of pre-computing denorm.

### 8.3 Response handling

- 201 → capture `_id`, proceed
- 409 DuplicateError:
  - Venue: look up existing venue by nearby geospatial query, use its `_id` + mastered chain
  - Organizer: look up by `fullName`, use existing `_id`; if shortName collision, append suffix and retry (cap 5)
  - Event: dedup by `(title normalized, local start date in venue timezone)` — skip as `skipped_exists`
- 4xx other → log, quality_flag with reason, skip event

### 8.4 Batch size

Per PROCESS.md lesson: 10–20 events at a time, not 500. Rate-limited. Observable.

### 8.5 PROD gate

M1 loads to TEST only. PROD requires explicit Toby re-authorization per `PROD-STAY-OUT` rule — no exceptions, `gh pr merge --admin` forbidden.

---

## 9. Override fields mechanism

`travelWorthy`, `beginnerFriendly`, `forBeginners` are recomputed by BE enrichment on every write. To make niche-harvest's classifier output stick:

- Set base field (e.g., `travelWorthy: true`)
- Also set `*Override` field (`travelWorthyOverride: true`) with same value

If anyone later PATCHes the event via API (triggering enrichment), the override field tells enrichment to respect the loader's value. Belt-and-braces per Fulton 2026-04-24.

Field names (verified): `travelWorthyOverride`, `beginnerFriendlyOverride`, `forBeginnersOverride`.

---

## 10. RRULE contract

Source: Fulton `docs/FRONTEND-RRULE-DATAFLOW.md` + Sarah's FE confirmation.

### 10.1 One record, FE expands

niche-harvest emits a single event document with RRULE. FE (`nextInstance.js`) calls `rrule.between()` to find next in-window instance. niche-harvest does NOT pre-expand instances.

### 10.2 Fields

```
event.isRepeating           ← true
event.recurrenceRule        ← standard RRULE string (e.g., 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T040000Z')
event.excludedDates[]       ← ISO date strings (optional)
event.instanceOverrides[]   ← per-instance overrides (optional)
```

DTSTART in the RRULE string is optional; FE prepends from `startDate` if absent.

### 10.3 Validation gate

**Malformed RRULE = silent FE drop** (Sarah confirmed). niche-harvest MUST validate RRULE before emitting. If validation fails → `quality_flag` with reason `rrule_invalid`, event excluded from loadable set.

Validation library: use `rrule` npm package (same as FE) for parity. Parse-and-re-serialize as the validation test.

### 10.4 Anti-recurrence guard

BE force-nulls `isRepeating` and `recurrenceRule` if `endDate - startDate > 24h` (Fulton confirmed: `Events.js:964-971`). niche-harvest enforces this upstream:

- LONG events (Festival, Marathon, Encuentro, Workshop) are NEVER recurring — emit `isRepeating: false`
- SHORT events with recurrence signals get RRULE emission
- Multi-day events expand into individual instances instead of one record with RRULE

---

## 11. Timezone contract

### 11.1 Storage

`startDate` and `endDate` stored as native Mongo `Date` = UTC Zulu (`Events.js:889-913`).

**Loader writes UTC. Never local.**

### 11.2 Venue timezone (authoritative on event)

`event.venueTimezone` is BE-authoritative (`Events.js:948-958`) — written from `venues.timezone` at event create/update. niche-harvest does not compute timezone; loader supplies lat/lng + city/state/country, BE resolves `venues.timezone` via `getTimezoneForVenue()` at venue insert.

### 11.3 DST

FE computes `venueStartDisplay` / `venueEndDisplay` / `venueAbbr` read-side from UTC + venueTimezone. Loader's job: write UTC. Never store local. Never compute DST transitions.

### 11.4 Fallback

If a source event has no timezone and the venue has no resolved timezone, niche-harvest uses the source feed's timezone (e.g., Google Calendar iCal feed TZID). If no source timezone either → quality_flag `timezone_unknown`, event excluded.

---

## 12. Quality flags (no silent drops)

Every event ingested is in exactly one bucket: `loadable_events` or `quality_flags`. Never both, never neither.

### 12.1 skip_reason values (policy-derived, per §7.3)

- `skip_class_only` — standalone Class (fires when `niche.yaml: load_classes: false`)
- `skip_performance` — Performance category
- `skip_trip` — Trip category
- `skip_unknown` — Unknown category (routes to NEW human triage)

### 12.2 quality_flag reasons (niche-harvest-derived)

- `no_venue` — source event has no venue
- `venue_invalid` — venue name rejected by validator (online/virtual/TBD/URL patterns)
- `geocode_failed` — Nominatim returned no result within country bounds
- `rrule_invalid` — RRULE string fails parse validation
- `timezone_unknown` — no venue timezone and no source timezone
- `date_invalid` — startDate/endDate fails Date() constructor
- `date_past` — startDate older than 6 days ago (per Porter convention)
- `short_long_mix` — classifier emitted SHORT+LONG in same event (violates hard rule)
- `duration_violation` — SHORT with duration ≥24h, LONG with duration <24h, or any >168h
- `fb_blocked` — FB safeguard triggered mid-fetch (SAFEGUARD-SPEC.md)
- `fb_session_expired` — authenticated FB session lost mid-fetch

Each quality_flag includes: `event_id` (niche-harvest internal), `reason`, `detail` (freeform), `source_id`, `captured_at`.

### 12.3 Silent drops are forbidden

If an event fails loading for any reason not covered above → quality_flag with reason `unclassified_failure` + full context. No exceptions.

---

## 13. Organizer handoff to calendar-campaigns

Source: Booker 2026-04-24 schema + Booker's gaps list.

### 13.1 Handoff format (JSON per organizer, pushed to calendar-campaigns queue)

```json
{
  "source": "niche-harvest",
  "source_organizer_id": "<niche-harvest internal ID>",
  "calendar_organizer_id": "<Mongo _id after load>",
  "name": "Wasatch Tango Society",
  "shortName": "WTS",
  "appId": 1,
  "discovery_event_count": 47,
  "primary_channel": "fb_page_url | instagram | email | website",
  "primary_channel_value": "https://www.facebook.com/wasatchtango",
  "secondary_channels": [
    {"type": "instagram", "value": "@wasatchtango"},
    {"type": "email", "value": "contact@wasatchtango.org"}
  ],
  "language_hint": "en",
  "role": "event_producer | venue | instructor | dj",
  "cadence_hint": "weekly | monthly | annual | one_shot",
  "first_seen_at": "2026-04-24T12:00:00Z",
  "last_seen_at": "2026-04-24T12:00:00Z",
  "niches": ["tango"]
}
```

### 13.2 Delivery path

**Direct push to calendar-campaigns SQLite queue, no broker layer.** Per AIDI 2026-04-24: the queue is a SQLite table in the calendar-campaigns project that AIDI owns. niche-harvest writes directly. Exact path confirmed with AIDI when implementing (expected: `calendar-campaigns/data/outreach-queue.sqlite`).

### 13.3 Backfeed

calendar-campaigns writes back to niche-harvest via structured API (not file-based) on:

- `outreach_status` change (contacted / declined / ghosted / opted-out)
- `last_contacted_at` timestamp

niche-harvest respects `outreach_status: declined` / `opted-out` and never re-contacts.

### 13.4 Canonical organizer count

**Resolved AIDI 2026-04-24:** the 1,277 number was Harvey's outreach QUEUE (pending items, not unique organizers — includes dupes across sites + per-event); Booker's 683 was a deduplicated organizer entity table from fb-conditioner. Neither is canonical going forward.

niche-harvest's rule is canonical: **ONE organizer per normalized contact identity (fullName + optional fb_profile_url for disambiguation).** Queue semantics live in calendar-campaigns; entity semantics live in niche-harvest. Don't reconcile the legacy numbers — the normalized-identity rule produces the clean count going forward.

---

## 14. FB integration

High-level contract only. Detailed safeguard spec in `SAFEGUARD-SPEC.md`.

### 14.1 Integration shape

niche-harvest wraps Booker's existing CDP stack (`booker/scripts/lib/facebook.ts`) with the mandated safeguards (block-detector + rate-limiter + watchdog) and pipeline integration. Does NOT rebuild CDP.

### 14.1.1 CDP seam (Booker 2026-04-24)

**M1: Option 1 — direct import from Booker's lib.**

Safe to import directly (pure functions, no hidden state):
- `booker/scripts/lib/facebook.ts` — `loadEnrichedEvents`, `extractOrganizers`, `extractCityState` (word-boundary regex per PR #13), `parseFbDateString`, WORLD_CITIES + COUNTRY_NAMES tables
- `booker/scripts/lib/normalize.ts` — `normalizeVenueKey`, `computeFingerprint`, `computeShortTitle`
- `booker/scripts/lib/geocode.ts` — `geocodeVenue`, `queryNominatim`, `mapCountryToISOCode`
- `booker/scripts/lib/classify.ts` — `classifyEvent`

Do NOT import (Booker-internal, not reusable):
- `booker/scripts/lib/store.ts` — Store class with specific SQLite path + migration state + CALBEAF-117 warn-assert
- `booker/scripts/lib/queues.ts` — Booker's queue bookkeeping
- `booker/scripts/lib/types.ts` wildcard — mixes shared types (`DbFbEvent`) with Booker-internal constants (`DB_PATH`); cherry-pick specific type exports

**Post-M1: Option 2 — extract to `ai-discovered/packages/fb-adapter/` as its own package.**

Trigger for refactor: when Booker + niche-harvest diverge on the same function with separate lifecycle needs (e.g., niche-harvest needs a new date-parser variant Booker doesn't). That's the signal; until then, shared-by-direct-import is fine.

Booker's commitment: no breaking changes to the "safe to import" function signatures until we explicitly coordinate a refactor.

### 14.2 Parsing approach

FB internal GraphQL interception via CDP Network events — NOT DOM parsing. Extraction helpers lifted from Booker's `loadEnrichedEvents()`, `extractOrganizers()`, `extractCityState()` (word-boundary regex per PR #13), `parseFbDateString()`.

### 14.3 FB-specific quality flags

- `fb_blocked` — block-detector triggered, session paused
- `fb_session_expired` — auth session invalid, manual re-login required
- `fb_private_venue` — event has `place.name` like "Private Venue" with no address/geo → goes to `needs_location` bucket (quality_flag, not loaded)

### 14.4 FB session = overseer gate

Before any live FB session, niche-harvest produces `FB-SAFEGUARD-READINESS-{niche}.md` with test evidence for each of the three safeguards. AIDI reviews and greenlights. No "move fast" on this interlock.

### 14.5 Pre-first-run mock-FB dry-run (Booker 2026-04-24)

Before the overseer gate review, niche-harvest runs a mock-FB test:

- Mock server returns known soft-block / 429 / interstitial / `/checkpoint/` patterns on demand
- Every block-detector signal must fire on its triggering pattern
- Zero false-positives on normal response patterns
- State-persistence + resume logic verified end-to-end

The 2026-04-17 soft-block incident would have been caught by this mock test. Booker has offered to contribute the mock-FB server to niche-harvest's test suite — accept.

---

## 15. Open questions / pending confirmations

| # | Question | Owner | Status |
|---|----------|-------|--------|
| 1 | ~~Class in LOAD_TARGETS~~ | AIDI | ✅ RESOLVED 2026-04-24: 7 targets; Class opt-in per niche via `load_classes: true`; `skip_class_only` bypassed when flag set |
| 2 | ~~Organizer count reconciliation~~ | AIDI | ✅ RESOLVED 2026-04-24: AIDI's 1,277 was Harvey's outreach QUEUE (not unique organizers); Booker's 683 was dedup'd fb-conditioner entities. Neither is canonical going forward; niche-harvest's normalized-identity rule produces the canonical count. |
| 3 | ~~Category ID resolution~~ | Fulton | ✅ RESOLVED 2026-04-24: cache-warm via `GET /api/categories?appId=1&limit=500` at batch start; `Map<categoryName, _id>` resolves strings → ObjectIds at event-insert time; batch-lifetime TTL; unknown strings → quality_flag `category_id_unknown` |
| 4 | Harvey slc-wasatch quirks (timezone, format, known bad records) | Harvey | Awaiting reply — not blocking loader lock; lands in per-adapter doc when received |
| 5 | ~~CDP stack wrapping seam~~ | Booker | ✅ RESOLVED 2026-04-24: Option 1 direct import for M1; Option 2 shared package post-M1 when divergence requires |

---

## 16. Change log

| Date | Change | Source |
|------|--------|--------|
| 2026-04-24 | Initial draft | Narvest synthesis of Sarah + Fulton + Booker + AIDI + three mandatory docs |
| 2026-04-24 | v2: AIDI overseer pass — §6.1 added `masteredCityGeolocation`, dropped `masteredDivisionName` (Porter doesn't write it); §12.1 removed stale "pending" tag; §13.2 delivery path clarified (direct SQLite queue push, no broker); §13.4 organizer-count reconciliation closed | AIDI 2026-04-24 |
| 2026-04-24 | v3: Fulton BE acceptance pass — corrected `masteredCityGeolocation` source to `masteredcities.location` via cityId lookup (Map batch cache); corrected `venueCityName` source to prefer `masteredCityName` over free-form `city` with `city_unresolved` quality_flag fallback; re-added `masteredDivisionName` (Porter gap; FE filter is live); §3.3 FE-wins wording; §5.5 renamed to clarify HTTP vs direct-Mongo paths; §6.4 category cache-warm pattern via `GET /api/categories?appId=1&limit=500`; Q3 closed | Fulton 2026-04-24 |
| 2026-04-24 | **LOCKED** — Sarah FE pass clean, confirmed `masteredDivisionName` filter is cold on TT today but include anyway (no change); §5.3 note on `venueCityName`/`masteredCityName` dual-render added. All three reviewers (AIDI/Fulton/Sarah) cleared. Implementation begins against this contract. | Sarah 2026-04-24 |
| 2026-04-27 | **v4 drift-back per Fulton standing directive** — added `nh_batch_id` field to all three doc shapes (Organizer §4.5, Venue §3.4, Event §5.6) per GUARDRAILS H11. Implementation already shipped (commit `5dc43dc`); drift-back applied here so contract matches code, NOT silent divergence. Format: `nh-<niche>-<utc-yyyymmddThhmmss>-<8-char-uuid>`. Rollback `deleteMany({nh_batch_id: <id>})` is a control surface; team should be aware. State remains `locked`; this is a contract-update-as-tracked-by-changelog, not a re-review trigger. | Narvest drift-back 2026-04-27 |

---

## 16.5 Cross-niche abstraction points

Summary of what each niche specifies via its own `niche.yaml` (i.e., what changes between tango and swing and bluegrass):

| Concern | Tango value | niche.yaml key |
|---------|-------------|---------------|
| Valid categoryFirst strings | 10 (7 loadable + 3 skip) | `taxonomy.categories[]` |
| Duration grouping | SHORT/LONG/NEUTRAL with specific memberships | `taxonomy.categories[].duration_group` |
| Load targets | 6 default (Class opt-in) | `taxonomy.categories[].loadable` + `loader.load_classes` |
| travelWorthy eligibility | Festival/Marathon/Encuentro/Workshop/DayWorkshop only | `taxonomy.categories[].travel_worthy_eligible` |
| forBeginners eligibility | Class/Workshop/DayWorkshop only | `taxonomy.categories[].beginner_eligible` |
| Identity keywords (tango-or-not gate) | tango, milonga, practica, bandoneon, etc. | `taxonomy.identity_check.*` |
| Rendered domain attributes | DJ, orchestra, instructor, cost | `taxonomy.rendered_attributes[]` |
| Geocode country trust list | US/CA/AR/EU | `geocode.trusted_country_codes` |
| FB group inventory | Booker's 27-50 tango groups | `sources.facebook_groups[]` |
| iCal + web source list | gcal-feeds + TangoMango/NYTango/etc. | `sources.ical_feeds[]` + `sources.web_pages[]` |

Universal across niches (NOT in niche.yaml):

- UTC Zulu timestamps
- RRULE contract (one record, FE expands, anti-recurrence >24h)
- Dependency ordering (organizer → venue → event)
- Denormalization bundle shape
- `isDiscovered=true` mandate
- `*Override` mechanism
- Quality-flag discipline (no silent drops)
- Dry-run gate
- PROD re-auth requirement
- SQLite schema (same columns per niche; semantics driven by config)

---

## 17. Review checklist (LOCKED 2026-04-24)

- [x] AIDI: overseer sanity-check — cross-source consistency, calendar-campaigns coordination, open questions resolved (cleared 2026-04-24)
- [x] Fulton: BE acceptance — field names, types, nullability, derived-field ownership, load mechanism (cleared v3 2026-04-24)
- [x] Sarah: FE consumption sanity-check — rendering minimums correct, anti-landmine rules captured, division-filter cold-but-include ruling (cleared v3 2026-04-24)
- [x] Booker: FB integration section — matches safeguard spec, parsing approach correct (implicit via SAFEGUARD-SPEC v3 cleared review)
- [x] All open questions (§15) resolved or explicitly deferred (Q4 Harvey slc-wasatch specifics explicitly deferred to per-adapter doc when received)
- [x] Harvey slc-wasatch specifics integrated or in per-adapter doc (explicitly deferred to adapter doc)

**State: `locked`.** Implementation begins against this contract. Drift found during implementation returns to this doc for update, not silent divergence (Fulton 2026-04-24 standing directive).
