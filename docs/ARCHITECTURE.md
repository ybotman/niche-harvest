---
date: 2026-04-24
persona: narvest
type: decision
state: locked
permanence: long-term
tags: [type/decision, app/global, app/tangotiempo, product/mongodb]
appid: global
reviewers: [aidi, fulton]
locked_at: 2026-04-25
locked_by: [aidi, fulton]
---

# niche-harvest — ARCHITECTURE

> **Status: LOCKED 2026-04-25.** AIDI overseer cleared v3 → Fulton loader spot-check accepted v4. Implementation begins against this blueprint; drift returns to this doc, not silent divergence. Owned by Narvest; major changes coordinated with AIDI.

> **What this is:** The shape of the code — module boundaries, data model, process model, adapter contract, scheduler, observability, memory budgets. The blueprint M1 implements against.

> **What this is not:** The load contract (`LOADER-CONTRACT.md`), safeguard spec (`SAFEGUARD-SPEC.md`), mission-level goals (`MISSION.md`), or deployment specifics (future `DEPLOY-SPEC.md` when Pi arrives). Per-adapter specifics live in `docs/adapters/{adapter}.md`.

---

## 1. Scope

**In:** niche-harvest's own runtime architecture — what files exist, how they interact, what state lives where, how work flows from source to SQLite to MongoDB.

**Out:** Upstream contracts (LOADER-CONTRACT owns those) and downstream deployment (DEPLOY-SPEC will own). External services (Mongo, Nominatim, FB) are black-boxed here with their contracts documented elsewhere.

**Cross-niche note:** Every design below is niche-agnostic unless explicitly marked. The SQLite schema, adapter interface, scheduler, hub client, and process model are all universal. Niche-specific concerns flow through `niche.yaml`, never through code branches.

---

## 2. Module map

```
niche-harvest/
├── CLAUDE.md                    # Project identity doc for agents
├── package.json                 # Node 22, --experimental-strip-types, zero production deps beyond mongodb
├── tsconfig.json                # type-check only; no build step
├── .gitignore                   # data/ is gitignored per-niche
├── run.sh                       # entrypoint: run.sh --niche=<key> [--phase=<name>] [--dry-run]
│
├── core/                        # Niche-agnostic engine (THE FRAMEWORK)
│   ├── types.ts                 # Shared types + path constants
│   ├── store.ts                 # SQLite CRUD (node:sqlite, WAL), all table operations
│   ├── config.ts                # niche.yaml loader (zero-dep YAML parser)
│   ├── fingerprint.ts           # SHA256 normalization for dedup keys
│   ├── classify.ts              # niche.yaml-driven classifier
│   ├── identity-check.ts        # niche.yaml-driven "is this the right niche?" gate
│   ├── quality.ts               # Quality-flag derivation (deterministic from classifier output + duration)
│   │
│   ├── engine/
│   │   ├── scheduler.ts         # Self-scheduling loop driven by next_check_at
│   │   ├── runner.ts            # Single-cycle orchestrator (scrape → enrich → geocode → load)
│   │   └── phase.ts             # Phase abstraction for --phase=<name> CLI control
│   │
│   ├── adapters/
│   │   ├── interface.ts         # SourceAdapter + RawEventBatch + canonical types
│   │   ├── registry.ts          # Adapter name → factory lookup (string-keyed via niche.yaml)
│   │   ├── ical.ts              # iCal adapter (handles Google Calendar + standard .ics)
│   │   ├── web-generic.ts       # Configurable HTML scraper (selector-driven)
│   │   ├── web-tangomango.ts    # TangoMango-specific (AJAX + HTML pattern)
│   │   ├── web-nytango.ts       # NYTango-specific (TABLE layout parser)
│   │   ├── web-tec.ts           # The Events Calendar WP REST API
│   │   └── fb/                  # FB adapter (Booker CDP wrapper + safeguards)
│   │       ├── adapter.ts       # Implements SourceAdapter; delegates to Booker helpers + safeguards
│   │       ├── block-detector.ts
│   │       ├── rate-limiter.ts
│   │       ├── watchdog.ts      # In-process heartbeat writer (external watchdog is core/watchdog/)
│   │       └── session.ts       # fb_dtsg lifecycle, canary checks
│   │
│   ├── geocoder/
│   │   ├── nominatim.ts         # Rate-limited Nominatim client with disk cache
│   │   └── validate.ts          # Venue-name rejection rules (online/virtual/TBD/URL/etc.)
│   │
│   ├── loader/
│   │   ├── interface.ts         # EventLoader + VenueLoader + OrganizerLoader abstractions
│   │   ├── mongo-direct.ts      # Direct Mongo impl (M1 default, Porter pattern)
│   │   ├── mongo-bulk-enrich.ts # BE-AF bulk-enrich impl (deferred, wires in when CALBEAF-110 unparks)
│   │   └── denorm.ts            # Denormalization bundle computation (LOADER-CONTRACT §6)
│   │
│   ├── hub/
│   │   ├── client.ts            # Hub client (network-abstract: HUB_URL / PERSONA_NAME / AUTH_TOKEN via env)
│   │   ├── signals.ts           # DQ signal emission (CALBEAF-141 pattern)
│   │   └── handoff-cc.ts        # calendar-campaigns organizer handoff (per LOADER-CONTRACT §13)
│   │
│   ├── watchdog/                # External watchdog (separate process)
│   │   └── main.ts              # Reads data/watchdog/fb-heartbeat.json + data/fb_signal_log; SIGKILLs worker on trigger
│   │
│   └── dashboard/               # (deferred M2+)
│
├── niches/
│   └── tango/
│       ├── niche.yaml           # THE CONTRACT — all tango-specific config lives here
│       └── adapters/            # Optional per-niche adapter overrides (prefer parameterizing core adapters via niche.yaml)
│
├── docs/                        # Obsidian-linked doc tree
│   ├── VISION.md MISSION.md PLAN.md ARCHITECTURE.md
│   ├── LOADER-CONTRACT.md SAFEGUARD-SPEC.md
│   ├── adapters/{name}.md       # Per-adapter docs (slc-wasatch, tangomango, etc.)
│   └── readiness/               # FB-SAFEGUARD-READINESS-{niche}.md per niche
│
├── deploy/
│   ├── laptop/                  # run.sh, .env.example, README for <30min reproduction
│   └── pi/                      # systemd units, setup scripts (M1.5+)
│
├── data/                        # Runtime (gitignored)
│   ├── {niche}/harvest.sqlite   # One SQLite per niche
│   ├── {niche}/geocode-cache/   # Nominatim response cache (per-query JSON)
│   ├── {niche}/artifacts/       # FB scrape artifacts, iCal raw dumps, etc.
│   └── watchdog/                # fb-heartbeat.json, lockfiles
│
├── test/
│   ├── unit/                    # store.ts, classify.ts, fingerprint.ts, quality.ts isolated tests
│   ├── mock-fb/                 # Booker-contributed mock FB server + test matrix
│   └── integration/             # Full pipeline dry-run against mock Mongo
│
└── build-workspace/             # (deferred M3 scratch space)
```

### 2.1 Design principles

- **`core/` is niche-agnostic.** No tango strings, no hardcoded categories, no per-niche keywords. All niche-specific behavior flows from `niche.yaml` through `core/config.ts`.
- **`niches/{niche}/` is the ONLY place niche-specific values live.** New niche = new folder + `niche.yaml`. Zero code changes.
- **Adapters are plugins.** `SourceAdapter` interface + registry lookup. Core never hardcodes adapter names.
- **Loader is an interface.** Direct Mongo today, bulk-enrich tomorrow, other sinks in the future — swap = new impl class.
- **External services are sandboxed.** Geocoder, hub, loader all behind interfaces for test substitutability.
- **One process per niche.** No in-process multi-niche. Hub identity and SQLite file are per-process.

---

## 3. SQLite schema (niche-agnostic)

One `harvest.sqlite` per niche at `data/{niche}/harvest.sqlite`. WAL mode. Foreign keys enabled. Schema identical across niches — semantics flow from `niche.yaml`.

### 3.1 Core tables

```sql
-- Sources configured in niche.yaml + runtime state
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL,            -- 'ical' | 'web_generic' | 'web_tangomango' | 'fb_group' | ...
  source_id TEXT NOT NULL,              -- niche.yaml-declared slug/URL identifier
  source_name TEXT,
  adapter TEXT NOT NULL,                -- adapter registry key
  config_json TEXT,                     -- source-specific config (from niche.yaml + runtime)
  priority TEXT DEFAULT 'normal',       -- 'high' | 'normal' | 'low' | 'dormant'
  enabled INTEGER DEFAULT 1,
  trusted INTEGER DEFAULT 1,            -- drives identity-check gate (untrusted → tango-identity check)
  check_interval_days INTEGER DEFAULT 7,
  last_checked_at TEXT,
  next_check_at TEXT,
  consecutive_empty INTEGER DEFAULT 0,
  events_found_total INTEGER DEFAULT 0,
  events_found_last INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id)
);
CREATE INDEX idx_sources_next_check ON sources(next_check_at, enabled) WHERE enabled=1;

-- Raw events as discovered (pre-enrichment)
CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id),
  fingerprint TEXT UNIQUE NOT NULL,     -- SHA256(title|date|venue_key) per core/fingerprint.ts
  raw_title TEXT, raw_date_text TEXT, raw_location_text TEXT,
  raw_description TEXT, raw_organizer_text TEXT, raw_url TEXT,
  raw_json TEXT,                        -- full scraped payload
  status TEXT DEFAULT 'pending',        -- 'pending' | 'enriched' | 'skipped' | 'error'
  error_message TEXT,
  discovered_at TEXT DEFAULT (datetime('now')),
  enriched_at TEXT
);

-- Enriched events
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  raw_event_id INTEGER REFERENCES raw_events(id),
  fingerprint TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  short_title TEXT,
  description TEXT,
  start_dt TEXT NOT NULL,               -- ISO 8601 UTC (Z suffix always)
  end_dt TEXT,
  duration_hours REAL,
  category_first TEXT,
  category_second TEXT,
  category_third TEXT,
  attributes_json TEXT,                 -- JSON array of discovery-internal markers (NEVER to Mongo)
  skip_reason TEXT,                     -- deterministic from category + niche.yaml load-targets
  venue_id INTEGER REFERENCES venues(id),
  organizer_id INTEGER REFERENCES organizers(id),
  is_recurring INTEGER DEFAULT 0,
  rrule TEXT,                           -- validated RRULE string (malformed → rejected at classify time)
  source_url TEXT,
  trust_level TEXT DEFAULT 'ai_discovered',
  -- Sync state (per-env tracking)
  sync_status_test TEXT,
  sync_status_prod TEXT,
  calendar_event_id_test TEXT,
  calendar_event_id_prod TEXT,
  -- Tango-specific flag copies (niche-specific fields; nullable for future niches)
  travel_worthy INTEGER,
  travel_worthy_override INTEGER,
  beginner_friendly INTEGER,
  beginner_friendly_override INTEGER,
  for_beginners INTEGER,
  for_beginners_override INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_sync_test ON events(sync_status_test) WHERE sync_status_test IS NULL OR sync_status_test='pending';

-- Venues (pre-geocode + post-geocode state)
CREATE TABLE venues (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT UNIQUE NOT NULL,     -- SHA256(normalized_name|city)
  name TEXT NOT NULL,
  address TEXT, city TEXT, state TEXT, country TEXT,
  lat REAL, lng REAL,
  timezone TEXT,                        -- resolved from BE's getTimezoneForVenue after POST /api/venues
  geocode_source TEXT,                  -- 'nominatim' | 'source' | 'manual'
  geocode_confidence REAL,
  geocode_status TEXT DEFAULT 'pending',-- 'pending' | 'geocoded' | 'failed' | 'invalid'
  -- Mastered chain (populated from venue POST response)
  mastered_city_id TEXT, mastered_city_name TEXT, mastered_city_geolocation_json TEXT,
  mastered_division_id TEXT, mastered_division_name TEXT,
  mastered_region_id TEXT, mastered_region_name TEXT,
  mastered_country_id TEXT, mastered_country_name TEXT,
  mongo_venue_id_test TEXT,
  mongo_venue_id_prod TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_venues_geocode ON venues(geocode_status) WHERE geocode_status='pending';

-- Organizers (normalized-identity, one per fullName + optional fb_profile_url disambiguation)
CREATE TABLE organizers (
  id INTEGER PRIMARY KEY,
  normalized_key TEXT UNIQUE NOT NULL,  -- lowercase(fullName) + optional '|' + fb_profile_id
  full_name TEXT NOT NULL,
  short_name TEXT,                      -- generated + unique per appId (CALBEAF-107 validator)
  fb_profile_url TEXT,
  primary_channel TEXT,                 -- 'fb_page_url' | 'instagram' | 'email' | 'website'
  primary_channel_value TEXT,
  secondary_channels_json TEXT,
  language_hint TEXT,
  role TEXT,                            -- 'event_producer' | 'venue' | 'instructor' | 'dj'
  cadence_hint TEXT,                    -- 'weekly' | 'monthly' | 'annual' | 'one_shot'
  event_count INTEGER DEFAULT 0,
  first_seen_at TEXT,
  last_seen_at TEXT,
  outreach_status TEXT DEFAULT 'not_contacted',  -- mirrored from calendar-campaigns backfeed
  last_contacted_at TEXT,
  mongo_organizer_id_test TEXT,
  mongo_organizer_id_prod TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Work queue (backs scheduler)
CREATE TABLE work_queue (
  id INTEGER PRIMARY KEY,
  queue_name TEXT NOT NULL,             -- 'scrape' | 'enrich' | 'geocode' | 'load' | 'cc_handoff'
  priority INTEGER DEFAULT 5,
  status TEXT DEFAULT 'pending',        -- 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  payload_json TEXT,
  source_id INTEGER REFERENCES sources(id),
  spawned_by_id INTEGER,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  next_retry_at TEXT
);
CREATE INDEX idx_work_queue_pending ON work_queue(queue_name, status, priority, scheduled_at) WHERE status='pending';

-- Quality flags (every non-loadable event lands here with a reason)
CREATE TABLE quality_flags (
  id INTEGER PRIMARY KEY,
  event_id INTEGER REFERENCES events(id),
  raw_event_id INTEGER REFERENCES raw_events(id),
  reason TEXT NOT NULL,                 -- see LOADER-CONTRACT §12.2 for canonical values
  detail TEXT,
  source_id INTEGER REFERENCES sources(id),
  captured_at TEXT DEFAULT (datetime('now')),
  -- A quality_flag with both FKs null is a useless ghost (no traceability back to source).
  -- This table IS the M1 dashboard — its integrity matters.
  CHECK (event_id IS NOT NULL OR raw_event_id IS NOT NULL)
);
CREATE INDEX idx_quality_flags_reason ON quality_flags(reason);

-- Run history (observability)
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  run_type TEXT,                        -- 'scrape' | 'enrich' | 'geocode' | 'load' | 'handoff'
  source_id INTEGER,
  started_at TEXT,
  completed_at TEXT,
  items_processed INTEGER DEFAULT 0,
  items_new INTEGER DEFAULT 0,
  items_skipped INTEGER DEFAULT 0,
  items_errored INTEGER DEFAULT 0,
  notes TEXT
);

-- FB-specific safeguard tables (see SAFEGUARD-SPEC.md)
CREATE TABLE fb_signal_log (
  id INTEGER PRIMARY KEY,
  timestamp TEXT DEFAULT (datetime('now')),
  signal_type TEXT NOT NULL,            -- e.g. 'hard_429', 'soft_latency', 'soft_redirect', 'canary_fail'
  severity TEXT NOT NULL,               -- 'hard' | 'soft' | 'canary'
  group_id TEXT,
  session_id TEXT,
  detail TEXT
);
CREATE INDEX idx_fb_signal_log_recent ON fb_signal_log(timestamp, severity);

CREATE TABLE fb_group_baseline (
  group_id TEXT PRIMARY KEY,
  expected_nonzero_event_count INTEGER,
  latency_p90_ms INTEGER,
  scrape_count INTEGER DEFAULT 0,       -- baseline activates after 3+ successful scrapes
  measured_at TEXT
);
```

### 3.2 Schema conventions

- **Timestamps:** ISO 8601 UTC (Z-suffixed) for all `*_at` fields. No local times anywhere.
- **JSON payloads:** stored as TEXT. Parsing happens at read time.
- **GeoJSON serialization at load time:** `mastered_city_geolocation_json` is stored as TEXT in SQLite; loader MUST `JSON.parse()` and emit a Mongo GeoJSON Point (`{type: 'Point', coordinates: [lng, lat]}`) when writing to events. The 2dsphere index on `events.masteredCityGeolocation` (calendar-be-af `scripts/syncProdToTest.js:358`) silently rejects malformed geometries — `$geoWithin` queries miss those events with no error surface. Validate shape before insert.
- **Nullable mastered fields:** null is expected when venue is un-mastered (AUTO_MEDIUM / MANUAL bucket); Sarah's #1 landmine is `mastered_country_name` null so loader gates on it.
- **Migrations:** additive-only. New columns get defaults; drops happen only after all consumers migrate (Booker pattern per CATEGORY-MODEL.md).

---

## 4. Adapter interface

```typescript
// core/adapters/interface.ts

export interface SourceAdapter {
  readonly name: string;                // registry key; matches niche.yaml source.adapter
  fetch(source: SourceConfig, niche: NicheConfig, ctx: AdapterContext): Promise<RawEventBatch>;
}

export interface RawEventBatch {
  sourceId: string;
  fetchedAt: string;                    // ISO 8601 UTC
  events: RawEvent[];
  errors: AdapterError[];               // non-fatal issues worth logging
  stats: { found: number; fetched: number; skipped: number };
}

// Lives in core/types.ts; consumed by adapters and core/engine alike.
// Adapter is the ONLY place source-side signals exist for these fields,
// so they MUST flow through if present (Fulton 2026-04-25):
export interface RawEvent {
  source_event_id: string;              // adapter-stable id within the source
  raw_title: string;
  raw_date_text?: string;               // human text as scraped (e.g. "Sat Apr 26, 8pm")
  start_dt_iso?: string;                // when adapter can compute reliably
  end_dt_iso?: string;
  raw_location_text?: string;
  raw_description?: string;
  raw_organizer_text?: string;
  raw_url?: string;
  // Per LOADER-CONTRACT §11.4 timezone-fallback path. Only the adapter sees
  // source-side TZ signals (iCal TZID, FB venue address). Pass-through; do
  // NOT compute or normalize at adapter time.
  timezone_hint?: string;
  // Per LOADER-CONTRACT §10. iCal feeds carry RRULE natively in VEVENT
  // bodies. Pass the source string verbatim; classify.ts validates and
  // canonicalizes per §10.3.
  source_rrule?: string;
  raw_json?: unknown;                   // full source payload for forensics
}

export interface AdapterContext {
  geocoder: Geocoder;                   // cache-first Nominatim wrapper
  hub: HubClient;                       // for safeguard alerts (FB adapter only)
  rateLimiter?: RateLimiter;            // FB adapter only
  blockDetector?: BlockDetector;        // FB adapter only
  logger: Logger;
  dryRun: boolean;
}
```

### 4.1 Adapter registry

`core/adapters/registry.ts` is a string-keyed factory map:

```typescript
const ADAPTERS: Record<string, () => SourceAdapter> = {
  'ical': () => new IcalAdapter(),
  'web-tangomango': () => new TangoMangoAdapter(),
  'web-nytango': () => new NyTangoAdapter(),
  'web-tec': () => new TecAdapter(),
  'web-generic': () => new GenericWebAdapter(),
  'fb-group': () => new FbGroupAdapter(),
};
```

`niche.yaml` declares which adapter handles each source:

```yaml
sources:
  ical_feeds:
    - name: slc-wasatch
      url: https://calendar.google.com/.../wasatchtango%40gmail.com/public/basic.ics
      adapter: ical
      trusted: true
      check_interval_days: 3
  web_pages:
    - name: tangomango
      url: https://tangomango.org
      adapter: web-tangomango
      trusted: true
      check_interval_days: 3
  facebook_groups:
    - name: argentinetangonyc
      url: https://www.facebook.com/groups/argentinetangonyc
      adapter: fb-group
      trusted: true
      priority: high
      check_interval_days: 14
```

### 4.2 Adapter responsibility boundary

- Adapter returns raw events. No classification, no geocoding, no dedup (beyond fingerprint-level pre-dedup if the adapter can cheaply).
- Classification, geocoding, dedup, load are all `core/engine/` jobs, running post-adapter.
- Adapters NEVER write to Mongo. Only the `loader/` module writes to Mongo.
- FB adapter consumes `rateLimiter` and `blockDetector` from context; other adapters ignore them.

---

## 5. Scheduler + runner

### 5.1 Single-cycle runner (M1 Phase 1+)

`core/engine/runner.ts` implements one full cycle for one source:

```
for source in due_sources:
  rate_check(source)                    # FB: rate-limiter gate; non-FB: no-op
  batch = adapter.fetch(source, niche, ctx)
  store.insertRawEvents(batch.events)   # fingerprint-dedup at insert
  enriched = enrichBatch(store, niche)  # classify + skip_reason + venue/organizer normalize
  geocoded = geocodeBatch(store, niche) # Nominatim + cache
  validated = qualityCheck(store, niche) # quality_flags population
  if not dry_run:
    loadBatch(store, niche, loader)     # mongo-direct: organizer → venue → event
    cc_handoff(store, niche, hub)       # calendar-campaigns push
  update_source_next_check(source)
  emit_run_record(store)
```

### 5.2 Self-scheduling loop (M1 Phase 7+)

`core/engine/scheduler.ts` wraps runner in a continuous loop:

```
on startup:
  load niche.yaml → upsert sources
  seed work_queue with due items where next_check_at <= now OR next_check_at IS NULL
  // Sources due while process was down (week-long outage, laptop sleep, etc.) must
  // still get picked up on restart. NULL covers brand-new sources that have never
  // been checked. The orphan-cleanup pass (§5.4) runs BEFORE this seed.
while true:
  next = store.dequeueNextPending()
  if next is null:
    sleep 60s; continue
  runner.run(next)
  reenqueue(next, computed_next_check_at)
```

Priority order within Mission 1:
1. `load` (events → Mongo ASAP)
2. `geocode` (unblocks load)
3. `enrich` (unblocks geocode)
4. `scrape` (generates new raw events)

### 5.3 Phase-gated CLI

`run.sh --niche=tango --phase=scrape` runs only the scrape phase. Phases: `scrape`, `enrich`, `geocode`, `load`, `handoff`, `all`. Used for manual debugging and for the baby-step ladder in `PLAN.md §6`.

### 5.4 Crash recovery (resolves §12 A3)

**Primary strategy: phase-level idempotency, not mid-run resume state.** On unexpected termination (crash, SIGKILL, laptop sleep) the scheduler re-enters the same cycle cleanly because each phase is idempotent:

| Phase | Idempotency mechanism |
|-------|----------------------|
| `scrape` | `raw_events.fingerprint` UNIQUE — re-scraping a source re-computes fingerprints and ignores existing rows via `INSERT OR IGNORE` |
| `enrich` | Reads `raw_events WHERE status='pending'` — already-enriched rows are not re-processed |
| `geocode` | Reads `venues WHERE geocode_status='pending'` — already-geocoded venues are skipped |
| `load` | Checks `events.sync_status_test IS NULL OR 'pending'` — Mongo writes gated by per-env sync status; 409 paths handled per §5.4.1 (specific response shapes per BE contract) |
| `handoff` | Reads `organizers WHERE outreach_status='not_contacted'` and last-handoff-at watermark |

Cost of crash: redundant scrape of an in-flight source (seconds), no data corruption, no duplicate Mongo writes. This is acceptable; alternative (mid-cycle resume state with heartbeats per row) adds complexity for negligible time savings.

**Orphan cleanup on startup:** `work_queue` rows with `status='running'` AND `started_at < now - 10 minutes` are marked `failed` with `error_message='orphaned_from_crash'` and the underlying work is re-queued as a fresh `pending` row per that queue's idempotent re-entry rule. Runs once at scheduler boot before the main loop.

**Watchdog-triggered SIGKILL is indistinguishable from crash** at recovery time — same orphan-cleanup path handles both. No special casing.

#### 5.4.1 BE 409 response shapes (load phase)

Source: Fulton 2026-04-25 from `calendar-be-af/src/functions/Venues.js:408-421` + `Organizers.js:364-365` + `shortNameHelpers.js:31-46`.

**Venue 409** — body returns `existingVenueId` + `existingVenueName` but does NOT include the mastered chain. Loader path:
1. Read `existingVenueId` from 409 body
2. Check local SQLite cache: do we already have this venue's mastered chain? If yes (and not stale), use cached chain
3. If no/stale: `GET /api/venues/{existingVenueId}` to recover full venue doc with mastered chain
4. Use that `_id` + chain for event denorm

Cache staleness risk: AutoMaster could have re-run between our two visits (rare but possible). Conservative default: re-fetch when the cached entry is older than the daily AutoMaster cycle.

**Organizer 409** — body returns `code: "DUPLICATE_SHORTNAME"`, `field: "shortName"`, `value: <shortName>`, `suggestions: []` (always empty stub). Does NOT return `existingOrganizerId`. Two distinct paths per LOADER-CONTRACT §4.2 + §4.3:
- **shortName collision on create:** retry with suffix (`WTS` → `WTS-2` → `WTS-3`...) per LOADER-CONTRACT §4.2 step 6, capped at 5 attempts
- **fullName-existence suspected:** separate `GET /api/organizers?fullName=...&appId=1` lookup per LOADER-CONTRACT §4.3 BEFORE create — gives existing `_id` to use directly

These are distinct paths because the 409 body never identifies the existing organizer; the lookup-before-create step is the only way to recover the existing `_id`.

---

## 6. Watchdog process model (FB only)

Two processes:

1. **Worker** (`run.sh --niche=tango`): the main niche-harvest runner. During FB sessions, writes `data/watchdog/fb-heartbeat.json` every 30s with `{timestamp, state, last_group_id, session_id, signals_in_window}`.
2. **Watchdog** (`node core/watchdog/main.ts --niche=tango`): separate Node process. Every 60s:
   - Reads heartbeat file; if `now - heartbeat.timestamp > 90s` → `process.kill(worker_pid, 'SIGKILL')`
   - Reads `fb_signal_log` via a read-only SQLite connection; evaluates rolling threshold (2+ soft in 10min → rate-limiter cooldown; 5+ soft in 10min OR any hard signal → SIGKILL + hub escalation)
   - On kill: emits hub message per SAFEGUARD-SPEC.md §5.4

**Startup race handling:** per SAFEGUARD-SPEC.md §5.3 (C1), worker writes initial heartbeat before entering main loop. Watchdog has 30s grace period from start before applying 90s threshold.

**Laptop M1:** both processes launched via `run.sh`, which tees log output.

**Pi M1.5:** both processes become systemd services (`narvest-tango.service` + `narvest-tango-watchdog.service`); systemd dependencies ensure watchdog starts before worker.

**Inter-process state:**
- Heartbeat: file-based at `data/watchdog/fb-heartbeat.json`
- Signals: read from shared SQLite (watchdog opens read-only connection; worker owns writes)
- Worker PID: written to `data/watchdog/worker.pid` at worker startup

---

## 7. Hub client

`core/hub/client.ts` is network-abstract from day one. Configuration via environment:

```
PERSONA_NAME=narvest-tango            # one niche = one runtime persona identity on the hub
PERSONA_PORT=8814                     # per-niche runtime port (design-time narvest is 8813)
HUB_URL=http://localhost:8800         # laptop M1; Pi M1.5: Tailscale or LAN IP
HUB_AUTH_TOKEN=<optional bearer>      # no-op locally; required for remote
```

Methods mirror the MCP persona-channel API: `send`, `reply`, `check_messages`, `hub_status`. Implementation is a thin HTTP client that adds the auth header and handles the same JSON-RPC shape the MCP server speaks.

**Why network-abstract from day one:** per `project_niche_separation_external_devices.md` — no laptop-only code paths. Hub client that assumes localhost becomes tech debt the moment it's written.

### 7.0.1 Runtime persona identities vs design-time identity

Two distinct identity classes on the hub:

- **Design-time persona:** `narvest` on port 8813. Single registration. This is the agent that designs, documents, and coordinates — the persona these docs are written BY.
- **Runtime persona instances:** `narvest-{niche}` on ports 8814+. One per deployed niche appliance. These are the pipeline processes that RUN on laptops/Pis and emit operational alerts.

**Port assignment rule:** `niche.yaml` declares the runtime port per niche. Assignment is manual (not dynamic) because each port maps to a specific physical device over time:

```yaml
# niches/tango/niche.yaml
persona:
  runtime_name: narvest-tango
  runtime_port: 8814
```

**Current reservations (update as niches go live):**
- `8813` — `narvest` (design-time, always)
- `8814` — `narvest-tango` (tango runtime, M1)
- `8815`+ — reserved for future niches on assignment

Both identities may be on the hub simultaneously (during M1 laptop dev, `narvest` and `narvest-tango` both register). When deployed to a Pi, that Pi runs only the runtime; the design-time `narvest` continues to register on the developer laptop.

Manual-lift and operational commands from AIDI target the runtime identity (`narvest-{niche}`) per SAFEGUARD-SPEC.md §7.3. Design/review commands target `narvest`.

### 7.1 Signal emission

`core/hub/signals.ts` produces DQ signals at thresholds. Matches Porter's CALBEAF-141 pattern:

- `classifier_rejects ≥ 5` per run → medium priority hub message to AIDI
- `duration_violation > 0` → medium priority
- `silent_drop_rate ≥ 10%` AND `processed_count ≥ 10` → low priority

Signal body shape: `{thresholds_fired, silent_drop_breakdown, rejected_samples_first_10, source_id, run_id}`. Goes to AIDI by default; niche.yaml can override routing.

### 7.2 calendar-campaigns handoff

`core/hub/handoff-cc.ts` produces organizer records per LOADER-CONTRACT §13. Direct SQLite push to calendar-campaigns queue (AIDI-confirmed 2026-04-24). Exact path confirmed at implementation.

---

## 8. Memory budget (8GB Pi reference)

| Component | RAM peak | Notes |
|-----------|----------|-------|
| Worker (Node + SQLite WAL + in-mem queue) | ~250 MB | Stable; SQLite WAL buffers configured modestly |
| Chromium (FB sessions, ONE instance ever) | ~800 MB peak | Only active during FB batches |
| Watchdog process | ~50 MB | Minimal; file + DB reads only |
| Nominatim cache (on disk) | ~0 MB RAM | Disk-backed; LRU memory cache capped at 32 MB |
| OS + systemd + ssh | ~400 MB | Raspberry Pi OS Lite baseline |
| **Total peak (FB session active)** | **~1.5 GB** | On 8 GB Pi: ~5 GB+ headroom for growth |
| **Total idle (between scrapes)** | **~700 MB** | Most of the time |

**Design constraint:** peak memory must never exceed 4 GB even on 8GB Pi. The 4+ GB headroom is reserved for failure margin (OOM resilience, unexpected scrape-size spikes, future co-resident services).

**Not designed for co-resident multi-niche.** One niche-harvest process per Pi per `project_one_to_one_niche_persona.md`.

---

## 9. Observability

### 9.1 Structured logs

All log output is JSON-per-line. Required fields: `timestamp`, `level`, `component`, `niche`, `source_id?`, `event_id?`, `message`. Logs go to stdout; operator pipes to file or journald.

### 9.2 Run records

Every cycle writes a row to `runs` table with counts. Operator queries: "show me the last N runs," "which sources failed today," "which sources had zero events for 3+ consecutive runs." All answerable from one table.

### 9.3 Quality flags as observability primary

Every non-loadable event is in `quality_flags` with a reason. A dashboard (M2+) reads this table; for M1 the `quality_flags` table IS the dashboard.

### 9.4 Hub broadcasts

Threshold-based hub messages (§7.1). Operator reads hub on their laptop; niche-harvest on Pi speaks to them.

---

## 10. Dependency shape

Runtime dependencies (production):

- `mongodb` — pinned `^6.20.0` to match calendar-be-af major (Fulton 2026-04-25). ObjectId serialization is stable across 6.x; pre-6 had subtle differences. Used by `loader/mongo-direct.ts`.
- `rrule` — pinned `^2.8.1` to match BE/FE major for parse parity (Fulton 2026-04-25). RRULE validation runs at classify time per LOADER-CONTRACT §10.3 — runtime operation, not build-time. If FE upgrades and we don't, validation passes here might fail there silently.
- `js-yaml` — pinned `^4.1.0` to match calendar-be-af. Used by `core/config.ts` to parse `niche.yaml`. Earlier draft committed to "zero-dep YAML parser" but rolling a custom YAML parser is fragile (empty values, multi-line strings, escaped chars all bite). `js-yaml` is pure-JS, no native binaries, ARM64-clean, ~0.5 MB, the same parser BE uses — additive risk is negligible. Drift adopted 2026-04-25 (v5).
- Node 22 built-ins: `node:sqlite` (WAL, foreign keys), `node:https` (HTTP), `node:crypto` (SHA256), `node:fs`, `node:path`, `node:events`.
- Booker's `booker/scripts/lib/*` imported directly (Option 1 CDP seam per LOADER-CONTRACT §14.1.1). Not an npm package; resolved via relative import.

Dev dependencies (only at dev time):

- TypeScript type-check (no build step via `--experimental-strip-types`)
- Mock-FB server (Booker-contributed, lives in `test/mock-fb/`)

**Two npm production dependencies (`mongodb`, `rrule`).** No additional npm dependencies unless specifically justified. Smaller surface area = smaller ARM64 risk + fewer security concerns.

---

## 11. Deferred architectural concerns

Not designed here; land in separate docs when needed.

- **Dashboard** (M2+): Hono web server + SSE + minimal HTML. Today: `quality_flags` table is the dashboard.
- **M2 Discovery engine:** gap analysis, web search, opportunity queue. Separate spec.
- **M3 Build engine:** LLM adapter code generation. Separate spec after ~5 niches are built by hand.
- **Multi-niche coordination:** not a niche-harvest concern. Hub messaging is how niches (as separate processes) communicate.
- **Pi deploy mechanics:** DEPLOY-SPEC.md when Pi arrives.
- **CI/CD pipeline:** laptop M1 is manual; M1.5+ will spec OTA pull-and-restart.

---

## 12. Open questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| A1 | ~~Watchdog → worker signal via SQLite rows or a UNIX signal file?~~ | Narvest | ✅ RESOLVED 2026-04-24: **No watchdog-to-worker IPC except SIGKILL.** Worker's own rate-limiter reads `fb_signal_log` at each request-gate check to decide cooldowns; watchdog only writes to the same log (via block-detector-owned rows) and only issues SIGKILL. One primitive (SIGKILL) + one shared table (`fb_signal_log`) = no split-brain IPC to design. |
| A2 | ~~`fb_signal_log` pruning cadence?~~ | Narvest | ✅ RESOLVED 2026-04-24: **90-day retention, pruned at scheduler startup.** Scheduler boot runs `DELETE FROM fb_signal_log WHERE timestamp < datetime('now', '-90 days')` before main loop. Zero-cost when empty. No cron needed. Reconsider if the log grows faster than expected (initial M1 estimate: <10 rows/day/niche). |
| A3 | ~~Scheduler crash-recovery state — on restart, how do we resume a mid-cycle run?~~ | Narvest | ✅ RESOLVED 2026-04-24: **No mid-run resume state; rely on phase-level idempotency** (§5.4). Each phase is re-entrant via UNIQUE fingerprints or `status='pending'` filters. Orphan work-queue rows (`running` + `started_at < now-10min`) get reset to `failed` on boot with re-enqueue per idempotent rule. Cost of crash: redundant scrape of in-flight source; no duplicate Mongo writes. |
| A4 | ~~Adapter registry: static map vs. dynamic require?~~ | Narvest | ✅ RESOLVED 2026-04-24: **Static map** (`core/adapters/registry.ts`). Reasons: bundler-friendly (no dynamic `import()`), dead-code elimination works, explicit enumeration easier to review, no runtime string-injection risk, tree-shake compatible. New adapter = one line added to the map — not a hot path. |

---

## 13. Change log

| Date | Change | Source |
|------|--------|--------|
| 2026-04-24 | Initial draft | Narvest synthesis after LOADER-CONTRACT + SAFEGUARD-SPEC lock trajectories |
| 2026-04-24 | v2: Resolved A1–A4 open questions; added §5.4 crash-recovery codifying phase-level idempotency + orphan cleanup; ready for AIDI overseer pass | Narvest first-principles resolution |
| 2026-04-25 | v3: AIDI overseer Q1=C — moved `rrule` dev → prod dep (runtime validation per LOADER-CONTRACT §10.3); added `CHECK (event_id IS NOT NULL OR raw_event_id IS NOT NULL)` to `quality_flags`; M1-phase label cleanup in §5.1/§5.2; explicit restart-seed semantics in §5.2 (`next_check_at <= now OR IS NULL`). Issue 3 (Chromium 4GB headroom) is informational — flagged for M1 test plan; §8 8GB-Pi reference remains correct (Toby same-day upgraded to 8GB Vilros kit per memory `project_first_pi_hardware_incoming.md`). | AIDI overseer 2026-04-25 |
| 2026-04-25 | **v4 + LOCKED**: Fulton loader spot-check — added `mastered_division_name TEXT` to `venues` table (asymmetry fix; otherwise denorm regresses LOADER-CONTRACT §6.1); §3.2 explicit GeoJSON Point serialization at load time (2dsphere silent-reject landmine); §5.4.1 BE 409 response shape spec for venue (existingVenueId + GET round-trip for chain) and organizer (suffix-retry vs lookup-before-create paths distinct); §4 RawEvent shape with `timezone_hint` + `source_rrule` pass-through requirements; §10 dep pins `mongodb ^6.20.0` + `rrule ^2.8.1` to BE majors. Implementation begins. | Fulton spot-check 2026-04-25 |

---

## 14. Review checklist (before locking)

- [x] AIDI: overseer pass — Q1=C 2026-04-25; three issues addressed in v3 (rrule prod dep, quality_flags CHECK, label/seed cleanups); A1–A4 cleared as sound
- [x] Fulton: loader spot-check accepted v4 2026-04-25; one schema gap (`mastered_division_name`) fixed; 4 green clarifications (GeoJSON serialization, 409 shapes §5.4.1, RawEvent timezone+RRULE pass-through, dep pins) all adopted
- [x] `fb_signal_log` + `fb_group_baseline` tables match SAFEGUARD-SPEC.md field references (verified 2026-04-24 against SAFEGUARD-SPEC §3.3 + §5.3)
- [x] All four A# open questions resolved or explicitly deferred with rationale (resolved 2026-04-24; see §12)
- [x] Watchdog process model (laptop M1 file-based heartbeat + Pi M1.5 systemd) captured (§6) — satisfies SAFEGUARD-SPEC §10 cross-ref
- [x] `fb_signal_log` SQLite table schema specified (§3.1) — satisfies SAFEGUARD-SPEC §10 cross-ref
- [x] Chromium memory budget validation flagged for M1 test plan (AIDI 2026-04-25 informational; 8GB Pi confirmed per memory; budget validation gates the FB Phase 6 work)

When checked → `state: locked`, implementation starts against this blueprint.
