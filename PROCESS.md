# PROCESS.md — niche-harvest end-to-end

End-to-end reproduction of the niche-harvest pipeline. Phase 10 deliverable.
Goal: a fresh operator can clone the repo and reproduce a playground load in
<30 minutes.

---

## Prerequisites

- **Node.js 22+** (`node --version` ≥ v22) — uses `--experimental-strip-types`
- **MongoDB Atlas access** — at minimum a playground cluster URI
- **Internet connection** — for iCal fetches + Nominatim geocoding
- **macOS / Linux / Pi** — Windows untested (use WSL2 if needed)

---

## 30-minute path: laptop → playground

### 1. Clone + install (2 min)

```bash
git clone https://github.com/ybotman/niche-harvest.git
cd niche-harvest
npm install
```

### 2. Set environment (1 min)

```bash
export MONGODB_URI_PLAYGROUND="mongodb+srv://playground:<password>@cluster0.<host>.mongodb.net/?appName=Cluster0"
export NICHE_HARVEST_PLAYGROUND=1
```

If you don't have a playground cluster, create one:
- MongoDB Atlas free tier (M0)
- Database name: `niche_harvest_playground`
- User: `playground` with read/write on the database

### 3. (Optional) Seed playground from TT_Test (5 min)

Skip this if you're starting fresh — niche-harvest will create everything.
Useful only if you want a realistic baseline (existing TT data) under the
new events.

```bash
export MONGODB_URI_TEST="<TT_Test URI>"
node --experimental-strip-types scripts/copy-tt-test-to-playground.ts
# Dry-run shows ~10K docs that would copy
node --experimental-strip-types scripts/copy-tt-test-to-playground.ts --apply
# Actual copy
```

### 4. Snapshot all sources (2 min)

```bash
./run.sh --niche=tango snapshot
```

Expected: ~3,500+ events found across 7 iCal feeds (slc-wasatch, seattle,
portland-milongas, austin-milongas, minneapolis, tucson, dc-capital-tangueros).
Output: `data/tango/snapshots/<YYYY-MM-DD>.json`

### 5. Enrich (10 min — geocode is the slow step)

```bash
./run.sh --niche=tango enrich
```

First pass: classifies events, queues unique venues, geocodes up to 50 with
Nominatim (1.1s rate limit per call). Capped at 50 venues per pass.

Run more passes to geocode remaining venues:

```bash
for i in 1 2 3 4 5 6 7 8 9 10; do
  ./run.sh --niche=tango enrich --retry-failed-venues
done
```

Each pass geocodes another 50 venues. Most niches converge in 8-12 passes.

Verify:
```bash
sqlite3 data/tango/harvest.sqlite \
  'SELECT geocode_status, COUNT(*) FROM venues GROUP BY geocode_status'
# Expected: ~85-90% geocoded
```

### 6. Load to playground (3 min)

```bash
./run.sh --niche=tango load --playground --max-events=2500 --samples=3
```

Expected:
- ~1,800-2,000 events written to playground
- 0 failures
- Report at `data/tango/snapshots/<date>-load.json`

Verify in MongoDB:
```bash
mongosh "$MONGODB_URI_PLAYGROUND" --quiet --eval \
  'db.getSiblingDB("niche_harvest_playground").events.countDocuments({isDiscovered: true})'
```

### 7. (Optional) Run scheduler unattended

```bash
./run.sh --niche=tango schedule --target=playground --tick=1800
```

Loops forever; runs full snapshot+enrich+load cycle every 30 minutes for any
sources whose `next_check_at` is past. Ctrl+C to stop.

For unattended Pi operation, use systemd — see `deploy/pi/README.md`.

---

## Pipeline architecture (one-liner per stage)

| Stage | Reads | Writes | Notable behavior |
|-------|-------|--------|-----------------|
| **snapshot** | iCal/web/FB sources per niche.yaml | `data/<niche>/snapshots/<date>.json` + SQLite `raw_events` (status='pending') | Idempotent: same event fingerprint → no duplicate row |
| **enrich** | SQLite pending raw_events | SQLite enriched raw_events + `venues` (geocoded/failed/pending) | Soft duration flags (Harvey 2026-04-29 §7.2); sets `venue_id` FK |
| **enrich --retry-failed-venues** | SQLite pending+failed venues | Updates venues to 'geocoded' or 'failed' | Pending-first ORDER BY; 50/pass cap |
| **load** | SQLite enriched raw_events with geocoded venues | MongoDB (3 modes) + JSON report | Modes: `--dry-run` (default), `--playground`, `--live` |
| **schedule** | All of above on a loop | Per-source `next_check_at` updates | systemd-friendly; writes heartbeat for watchdog |

---

## Common questions

**Q: Why are some events not loadable?**

The load gate requires:
1. Status = 'enriched' (passed identity_check + classify)
2. `skip_reason IS NULL` (not Class-only with `load_classes:false`, not Trip, not Performance, not Unknown)
3. `venue_id IS NOT NULL` (had non-empty `raw_location_text`)
4. Linked venue's `geocode_status = 'geocoded'` (Nominatim succeeded within trusted_country_codes)

Events failing #4 are the largest category — they have addresses Nominatim can't resolve.

**Q: Why does my geocode rate drop on the first run?**

Cap. `--max-geocodes=50` (default). With 200+ unique venues from 7 feeds,
you need 4+ retry passes. See PROCESS step 5.

**Q: How do I add a new niche?**

1. Create `niches/<name>/niche.yaml` (copy from `tango` and modify).
2. Run snapshot/enrich/load with `--niche=<name>`.
No core code changes required — niche.yaml is the contract.

**Q: How do I add a new source to an existing niche?**

Edit `niches/<niche>/niche.yaml`, add a new entry under `sources.ical_feeds`
(or web_pages, fb_groups). The next `snapshot` run picks it up.

**Q: How do I write to TT_Test instead of playground?**

```bash
export MONGODB_URI_TEST="<TT_Test URI>"
export NICHE_HARVEST_LIVE=1
./run.sh --niche=tango load --live --appid-override=99
```

The `--appid-override=99` makes events invisible to TT FE (which filters
appId=1). Cleanup later: `db.events.deleteMany({appId: 99})`.

PROD writes are NOT supported by niche-harvest currently — Toby reauth
required to enable.

**Q: How do I roll back a load?**

Every load run gets a `nh_batch_id` (format: `nh-<niche>-<utc>-<8char>`).
Report file (`data/<niche>/snapshots/<date>-load.json`) includes
paste-ready rollback commands:
```js
db.events.deleteMany({nh_batch_id: "<id>"})
db.venues.deleteMany({nh_batch_id: "<id>"})
db.organizers.deleteMany({nh_batch_id: "<id>"})
```

---

## Pipeline numbers (slc-wasatch + 6 cities, 2026-04-30)

After full pipeline run on the 7 iCal feeds:

| Metric | Count |
|--------|-------|
| Total raw events | 3,484 |
| Enriched (passed classify) | 2,320 |
| Skipped (skip_class_only / skip_unknown) | 1,164 |
| Unique venues found | 380 |
| Geocoded venues | 337 (89%) |
| Failed-geocode venues | 21 |
| Pending venues (cap-skipped) | 22 |
| **Loadable events** | **1,943** |
| Events written to playground | 1,943 |
| Organizers found | 9 |
| duration_reassigned soft flags | 81 |
| duration_ceiling_exceeded flags | 1 |

---

## Documentation index

| Doc | What |
|-----|------|
| `CLAUDE.md` | Project root doc — code boundaries, hard constraints |
| `docs/VISION.md` | Aspirational end-state |
| `docs/MISSION.md` | Active mission (M1) |
| `docs/PLAN.md` | Operational state — restart-capable |
| `docs/ARCHITECTURE.md` | Locked technical blueprint |
| `docs/LOADER-CONTRACT.md` | The contract niche-harvest honors when writing to MasterCalendar |
| `docs/SAFEGUARD-SPEC.md` | FB session safeguard spec |
| `deploy/pi/README.md` | Pi 5 hands-on deployment runbook |
| `niches/tango/niche.yaml` | Niche definition contract for tango |
