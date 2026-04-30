---
date: 2026-04-24
persona: narvest
type: mission
state: active
permanence: long-term
tags: [type/mission, app/global, product/mongodb, product/geocoding]
appid: global
niche: tango
---

# niche-harvest — Vision

> **Aspirational end-state. No deadlines. No tactics. The north star only.**

---

## The one-sentence vision

**A fleet of self-contained appliances — one per niche community — that autonomously discover, enrich, and publish a clean events calendar with zero manual intervention.**

---

## What the world looks like when it's realized

- A passionate community (tango, swing, bluegrass, birding, pipe organ, drum corps, …) has a single definitive calendar that is **always current**, **always correct**, and **always complete**.
- Someone who cares about that community runs one **small device** (Raspberry Pi or equivalent) on their home network. They don't touch it. It works.
- The device discovers new events from websites, iCal feeds, and APIs; de-duplicates; geocodes; classifies; and publishes to the calendar continuously.
- When a new relevant source appears on the internet, the device **finds it**, asks the operator's dashboard "should I add this?", and on approval **writes its own ingest code** and promotes itself to production.
- The operator's role is **curation, not operation** — they approve or reject new sources, review edge cases, and watch health dashboards. They do not scrape, geocode, dedupe, or write code.
- Cross-niche, the system maintains one shared mastering corpus (cities, geography, taxonomies). Each niche contributes coverage; each niche benefits from the whole.
- Failure is visible. Silent drops are impossible. Every skipped record carries its reason; every data-quality regression pages the operator.

---

## The structural bet

Calendar fragmentation in passionate, volunteer-maintained communities is **real, persistent, and unowned**. No central platform will fix it because the economics don't support centralization below a certain scale. A cheap appliance per niche turns that fragmentation from a curse into a wedge — because the operator's cost is measured in hardware dollars, not engineering hours.

---

## Architecture at a glance (aspirational)

```
                         ┌──────────────────────────────────────────┐
                         │   MasterCalendar Cloud (MongoDB Atlas)   │
                         │   shared mastering • cross-niche sink    │
                         └────────┬─────────────────────────────────┘
                                  ▲
          ┌───────────────────────┼────────────────────────┐
          │                       │                        │
   ┌──────┴──────┐         ┌──────┴──────┐          ┌──────┴──────┐
   │  Pi: Tango  │         │  Pi: Swing  │   …      │ Pi: Birding │
   │  narvest-   │         │  narvest-   │          │  narvest-   │
   │    tango    │         │    swing    │          │   birding   │
   └──────┬──────┘         └──────┬──────┘          └──────┬──────┘
          │                       │                        │
   external sources        external sources         external sources
   (iCal, web, API)        (iCal, web, API)         (iCal, web, API)

   each Pi: self-contained SQLite + adapter engine + discovery engine
   each Pi: autonomous, headless, messages team hub on exception/status
   each Pi: self-extends via LLM adapter generation (reviewed by HITL)
```

---

## The three pillars

The vision is delivered only when all three are at full quality. Missing any one is missing the vision.

| Pillar | What "great" means |
|--------|---------------------|
| **Code** | Niche-agnostic core, plugin adapters, zero laptop-only paths, testable in isolation, observable by design |
| **Documentation** | Obsidian-linked, metadata-compliant, living (updated as we work), restart-capable for agents and humans |
| **Deployment** | One-command laptop reproduction; systemd-hardened Pi fleet; idempotent; reboot-recoverable; over-the-air update path |

---

## Standing principles (aspirational and permanent)

These are the shape-of-the-system commitments. They do not change with milestones.

- **One niche = one process = one persona identity.** No monolith. Each niche is a citizen of the team hub with its own name.
- **Write minimally-opinionated discovery records.** Let mastering resolve downstream. Cross-niche growth must not force backfills.
- **Geocode failure = null, never fallback.** No substituted country, no nearest-city papering.
- **No silent drops.** Every skip carries a structured reason. Every DQ regression surfaces.
- **Fix the process, not the data** (FTPNTD). Bugs are fixed upstream, not patched at the sink.
- **Dry-run is first-class, not a flag.** Every load path has a rehearsal mode that proves itself before writing.
- **DEVL → TEST → PROD.** Never the other way. PROD requires explicit per-operation reauthorization.

---

## What niche-harvest is NOT (aspirational boundary)

- Not a scraper library. Scraping is a means; the product is the clean calendar.
- Not a centralized SaaS. The operator owns the hardware and the data.
- Not a replacement for community curation. It surfaces, it doesn't judge.
- Not a general-purpose event platform. It serves niches, deliberately.
- Not a Facebook-dependency. FB is one source, not the source.

---

## Related documents

- **MISSION.md** — the current active mission (what we're working on to move toward this vision)
- **PLAN.md** — concrete action steps within the active mission
- **AS-IS-PIPELINE-2026-04-24.md** (in `ai-discovered/docs/`) — what the team has built pre-niche-harvest; the learning base
- **REQUIREMENTS-AUTONOMOUS-PIPELINE-2026-04-24.md** (in `ai-discovered/docs/`) — the long-form requirements dump from which this vision is distilled

---

*The vision does not change with milestones. It is the thing we steer toward.*
