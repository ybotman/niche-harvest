#!/usr/bin/env node --experimental-strip-types
// core/cli/enrich.ts — Phase 1 enrichment over already-snapshot'd raw_events.
//
// Reads raw_events with status='pending' from SQLite, runs:
//   1. Identity check (skipped for sources with trusted=true)
//   2. Category classification (LOADER-CONTRACT §7)
//   3. Venue dedup + Nominatim geocoding (rate-limited, cache-first)
//
// Updates SQLite:
//   - raw_events.status -> 'enriched' or 'skipped' (per identity result)
//   - venues table populated for unique venue strings (lat/lng/cc)
//   - quality_flags written for skipped events with structured reason
//
// Phase 1 stops here: no Mongo writes, no events table population yet.
// Phase 2 (loader) will compute denorm bundle + write to Mongo.
//
// Usage:
//   bash run.sh --niche=tango enrich [--dry-run] [--max-geocodes=N]
//
// --max-geocodes caps Nominatim calls per run (default 50). Lets you do
// a cheap dry pass before committing to ~10 minutes of geocoding.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadNiche, NicheConfigError } from "../config.ts";
import { createLogger } from "../logger.ts";
import { openStore, getVenueIdByFingerprint, linkRawEventVenue } from "../store.ts";
import { fingerprintVenue } from "../fingerprint.ts";
import { identityCheck, classify } from "../classify.ts";
import { NominatimGeocoder } from "../geocoder/nominatim.ts";
import { parseLocation } from "../geocoder/parse-location.ts";
import { PATHS } from "../types.ts";
import type { RawEvent } from "../types.ts";

interface EnrichOpts {
  niche: string;
  dryRun: boolean;
  maxGeocodes: number;
  retryFailedVenues: boolean;
}

function parseCli(argv: string[]): EnrichOpts {
  const args = argv.slice(2);
  const niche = pickArg(args, "--niche");
  if (!niche) fail("Missing --niche=<key>");
  const maxGeocodesStr = pickArg(args, "--max-geocodes");
  return {
    niche,
    dryRun: args.includes("--dry-run"),
    maxGeocodes: maxGeocodesStr ? Number(maxGeocodesStr) : 50,
    retryFailedVenues: args.includes("--retry-failed-venues"),
  };
}

function pickArg(args: string[], key: string): string | null {
  const prefix = `${key}=`;
  const m = args.find((a) => a.startsWith(prefix));
  if (m) return m.slice(prefix.length);
  const i = args.indexOf(key);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--")) {
    return args[i + 1] ?? null;
  }
  return null;
}

function fail(msg: string): never {
  process.stderr.write(`enrich: ${msg}\n`);
  process.exit(2);
}

interface EnrichSummary {
  niche: string;
  generated_at: string;
  dry_run: boolean;
  max_geocodes: number;
  /** What happened in THIS invocation (delta). Zeros when nothing pending. */
  this_run: {
    raw_events_pending: number;
    identity_pass: number;
    identity_skip: number;
    classify_loadable: number;
    classify_skipped: number;
    duration_violations: number;
    by_category: Record<string, number>;
    by_skip_reason: Record<string, number>;
    by_duration_violation_kind: Record<string, number>;
    unique_venues: number;
    venues_geocoded: number;
    venues_geocode_failed: number;
    venues_geocode_skipped_cap: number;
  };
  /** Cumulative state queried from SQLite at end of run. ALWAYS populated
   * regardless of whether this run processed anything (AIDI 2026-04-25
   * Phase 1 review fix — prevents zero-totals confusion on re-runs). */
  total_state: {
    raw_events_total: number;
    raw_events_by_status: Record<string, number>;
    venues_total: number;
    venues_by_geocode_status: Record<string, number>;
    quality_flags_total: number;
    quality_flags_by_reason: Record<string, number>;
    /**
     * niche-harvest's strictest "ready to go to BE / would be loadable"
     * count: raw_events status='enriched' AND tied venue is geocoded.
     * Mastered chain (city/country names from BE AutoMaster) is Phase 2
     * loader's concern; this count is the Phase 1 ceiling.
     */
    loadable_for_phase_2: number;
  };
}

interface RawEventRow {
  id: number;
  source_id: number;
  raw_title: string;
  raw_date_text: string | null;
  raw_location_text: string | null;
  raw_description: string | null;
  raw_organizer_text: string | null;
  raw_url: string | null;
  raw_json: string | null;
  status: string;
}

interface SourceMeta {
  trusted: number;
  source_name: string;
  /** Per-source config_json from sources table — carries niche.yaml's
   *  source entry verbatim (incl. location_default if set). */
  config_json: string | null;
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const log = createLogger("enrich", { niche: opts.niche });

  let niche;
  try {
    niche = loadNiche(opts.niche);
  } catch (err) {
    if (err instanceof NicheConfigError) fail(err.message);
    throw err;
  }

  const db = openStore(opts.niche);
  const geocoder = new NominatimGeocoder(opts.niche, niche, log);

  // ─── Read pending raw_events with their source trust info ───
  const rows = db
    .prepare(`
      SELECT
        re.id, re.source_id, re.raw_title, re.raw_date_text,
        re.raw_location_text, re.raw_description, re.raw_organizer_text,
        re.raw_url, re.raw_json, re.status,
        s.trusted, s.source_id AS source_name, s.config_json
      FROM raw_events re
      JOIN sources s ON s.id = re.source_id
      WHERE re.status = 'pending'
      ORDER BY re.id
    `)
    .all() as unknown as (RawEventRow & SourceMeta)[];

  const summary: EnrichSummary = {
    niche: opts.niche,
    generated_at: new Date().toISOString(),
    dry_run: opts.dryRun,
    max_geocodes: opts.maxGeocodes,
    this_run: {
      raw_events_pending: rows.length,
      identity_pass: 0,
      identity_skip: 0,
      classify_loadable: 0,
      classify_skipped: 0,
      duration_violations: 0,
      by_category: {},
      by_skip_reason: {},
      by_duration_violation_kind: {},
      unique_venues: 0,
      venues_geocoded: 0,
      venues_geocode_failed: 0,
      venues_geocode_skipped_cap: 0,
    },
    total_state: {
      raw_events_total: 0,
      raw_events_by_status: {},
      venues_total: 0,
      venues_by_geocode_status: {},
      quality_flags_total: 0,
      quality_flags_by_reason: {},
      loadable_for_phase_2: 0,
    },
  };
  // alias to keep the existing per-event accumulation lines compact
  const totals = summary.this_run;

  log.info("enrich start", {
    raw_events_pending: rows.length,
    dry_run: opts.dryRun,
    max_geocodes: opts.maxGeocodes,
  });

  // ─── Pass 1: Identity + classify ───
  // Collect unique venues for batched geocoding pass 2. Track ALL raw_event
  // ids sharing each venue so we can FK-link them to the venue row after
  // upsert (AIDI 2026-04-25 Phase 3 gate item #1).
  // Also carry parsed parts so the venue row stores the canonical
  // venue_name + city (not the fragmenting raw text).
  const venueQueue = new Map<
    string,
    {
      fingerprint: string;
      /** Canonical venue display name from parser; falls back to first comma chunk. */
      canonical_name: string;
      /** Canonical city from parser; empty when not extractable. */
      canonical_city: string;
      /** Original raw text — passed to geocoder for full address detail. */
      venue_text: string;
      raw_event_ids: number[];
    }
  >();

  const updateRawStatus = db.prepare(
    `UPDATE raw_events SET status = ?, enriched_at = ? WHERE id = ?`,
  );
  const insertQualityFlag = db.prepare(`
    INSERT INTO quality_flags (raw_event_id, source_id, reason, detail)
    VALUES (?, ?, ?, ?)
  `);

  for (const row of rows) {
    // raw_json is the adapter's source-shaped payload. Different adapters
    // serialize different schemas: iCal stores IcalEvent (dtstart/dtend
    // keys); future FB adapter will store FB GraphQL shape; etc. We
    // extract dates by checking BOTH the RawEvent shape (start_dt_iso)
    // AND known adapter shapes (iCal dtstart). When this list grows,
    // promote start_dt/end_dt to dedicated raw_events columns.
    let parsedJson: {
      start_dt_iso?: string;
      end_dt_iso?: string;
      dtstart?: string;
      dtend?: string;
    } = {};
    if (row.raw_json) {
      try {
        parsedJson = JSON.parse(row.raw_json) as typeof parsedJson;
      } catch {
        // tolerated; classifier proceeds without dates
      }
    }
    const startIso = parsedJson.start_dt_iso ?? parsedJson.dtstart;
    const endIso = parsedJson.end_dt_iso ?? parsedJson.dtend;
    const ev: RawEvent = {
      source_event_id: String(row.id),
      raw_title: row.raw_title,
      ...(row.raw_date_text !== null ? { raw_date_text: row.raw_date_text } : {}),
      ...(startIso ? { start_dt_iso: startIso } : {}),
      ...(endIso ? { end_dt_iso: endIso } : {}),
      ...(row.raw_location_text !== null ? { raw_location_text: row.raw_location_text } : {}),
      ...(row.raw_description !== null ? { raw_description: row.raw_description } : {}),
      ...(row.raw_organizer_text !== null ? { raw_organizer_text: row.raw_organizer_text } : {}),
      ...(row.raw_url !== null ? { raw_url: row.raw_url } : {}),
    };

    // ─── Identity check (trusted sources skip) ───
    if (row.trusted !== 1) {
      const id = identityCheck(ev, niche);
      if (!id.passed) {
        totals.identity_skip += 1;
        if (!opts.dryRun) {
          insertQualityFlag.run(row.id, row.source_id, "venue_invalid", id.reason ?? null);
          updateRawStatus.run("skipped", new Date().toISOString(), row.id);
        }
        continue;
      }
    }
    totals.identity_pass += 1;

    // ─── Classify (category + duration validation) ───
    const cl = classify(ev, niche);
    if (cl.category_first) {
      totals.by_category[cl.category_first] =
        (totals.by_category[cl.category_first] ?? 0) + 1;
    }
    if (cl.skip_reason) {
      // Class-only is gated by niche.loader.load_classes (LOADER-CONTRACT §7.1.1)
      const isClassOnlyOptedIn =
        cl.skip_reason === "skip_class_only" && niche.loader.load_classes;
      if (!isClassOnlyOptedIn) {
        totals.classify_skipped += 1;
        totals.by_skip_reason[cl.skip_reason] =
          (totals.by_skip_reason[cl.skip_reason] ?? 0) + 1;
        if (!opts.dryRun) {
          insertQualityFlag.run(row.id, row.source_id, cl.skip_reason, null);
          updateRawStatus.run("skipped", new Date().toISOString(), row.id);
        }
        continue;
      }
    }

    // ─── Duration-violation gate (LOADER-CONTRACT §7.2 hard rules) ───
    // SHORT category with >=24h duration, LONG with <24h, or any >168h
    // gets a duration_violation quality_flag and exits the loadable set.
    // Caught Porter's CALBEAF-141 cases (Carolina+Ricardo, Lya Elcagu in SLC).
    if (cl.duration_violation) {
      totals.duration_violations += 1;
      totals.by_duration_violation_kind[cl.duration_violation.kind] =
        (totals.by_duration_violation_kind[cl.duration_violation.kind] ?? 0) + 1;
      if (!opts.dryRun) {
        insertQualityFlag.run(
          row.id,
          row.source_id,
          "duration_violation",
          cl.duration_violation.detail,
        );
        updateRawStatus.run("skipped", new Date().toISOString(), row.id);
      }
      continue;
    }

    totals.classify_loadable += 1;

    // ─── Queue venue for geocoding pass ───
    // AIDI 2026-04-25 root-cause fix: parse-location FIRST, then fingerprint
    // by parsed venue_name + city (Harvey's pattern from harvester/scripts/
    // gcal-harvest.ts:723). Keying on raw text was fragmenting venues 5-10x;
    // 10 real venues became 101 in slc-wasatch. With this fix, expect
    // venues_total to drop to Harvey's ~10-30 range and geocode rate to climb.
    if (row.raw_location_text) {
      // Per-source location defaults (Harvey gcal-harvest pattern).
      // niche.yaml's location_default flows through sources.config_json
      // — when set, parse-location uses these for fields it can't extract
      // from the location text. Collapses many "no-city" venues into ONE
      // per-feed bucket instead of fragmenting per address-text variant.
      let sourceDefaults: { city?: string; state?: string; country?: string } = {};
      if (row.config_json) {
        try {
          const cfg = JSON.parse(row.config_json) as { location_default?: typeof sourceDefaults };
          if (cfg.location_default) sourceDefaults = cfg.location_default;
        } catch {
          // tolerated; parser proceeds without defaults
        }
      }
      const parsed = parseLocation(row.raw_location_text, sourceDefaults);
      // venue_name is null when the text starts with a digit (no venue
      // prefix, just an address); city is null when no commas. Best-effort
      // fallbacks: use first comma-chunk as name when parser returned none;
      // empty string for city is acceptable (dedups within unknown bucket).
      const canonicalName = parsed.venue_name
        ?? row.raw_location_text.split(",")[0]?.trim()
        ?? row.raw_location_text;
      const canonicalCity = parsed.city ?? "";
      const fp = fingerprintVenue({ name: canonicalName, city: canonicalCity });
      const existing = venueQueue.get(fp);
      if (existing) {
        existing.raw_event_ids.push(row.id);
      } else {
        venueQueue.set(fp, {
          fingerprint: fp,
          canonical_name: canonicalName,
          canonical_city: canonicalCity,
          // Pass raw text downstream so geocoder still has full address
          // detail for query construction; only the FINGERPRINT is parsed.
          venue_text: row.raw_location_text,
          raw_event_ids: [row.id],
        });
      }
    }

    if (!opts.dryRun) {
      updateRawStatus.run("enriched", new Date().toISOString(), row.id);
    }
  }

  // ─── Pass 1.5: title-fallback (Harvey gcal-harvest:findVenueInTitle) ───
  // For events whose location text was address-only (parser couldn't extract
  // a venue_name → canonical_name fell back to first comma chunk = the
  // address itself), scan the EVENT TITLE for any known real venue name
  // from other entries in venueQueue. If found, MOVE the event into that
  // venue's queue entry. Result: addresses-without-venues that share a
  // title pattern with known venues get deduped instead of fragmenting.
  //
  // "Real" venue name = starts with letter, length > 3, no digit-leading.
  // Sort longest-first so "DF Dance Studio" matches before partial "DF".
  const realVenueNames: { name: string; fingerprint: string }[] = [];
  for (const v of venueQueue.values()) {
    const isReal =
      /^[A-Za-z]/.test(v.canonical_name) &&
      !/^\d/.test(v.canonical_name) &&
      v.canonical_name.length > 3;
    if (isReal) {
      realVenueNames.push({ name: v.canonical_name, fingerprint: v.fingerprint });
    }
  }
  realVenueNames.sort((a, b) => b.name.length - a.name.length);

  // Index raw_title by raw_event id for O(1) lookup during the fallback pass
  const titleByEventId = new Map<number, string>();
  for (const r of rows) titleByEventId.set(r.id, r.raw_title);

  let titleMatchedEvents = 0;
  let venuesConsolidated = 0;
  // Iterate a copy of entries so we can mutate venueQueue mid-loop.
  for (const [addressFp, addressV] of [...venueQueue.entries()]) {
    // Skip real venues (only address-only entries get title-fallback)
    if (realVenueNames.some((r) => r.fingerprint === addressFp)) continue;
    const remainingEventIds: number[] = [];
    for (const eventId of addressV.raw_event_ids) {
      const title = (titleByEventId.get(eventId) ?? "").toLowerCase();
      const match = realVenueNames.find((r) => title.includes(r.name.toLowerCase()));
      if (match) {
        // Move this event to the matched real venue
        const target = venueQueue.get(match.fingerprint);
        if (target) {
          target.raw_event_ids.push(eventId);
          titleMatchedEvents += 1;
        }
      } else {
        remainingEventIds.push(eventId);
      }
    }
    if (remainingEventIds.length === 0) {
      // All events moved → delete the address-only entry
      venueQueue.delete(addressFp);
      venuesConsolidated += 1;
    } else {
      addressV.raw_event_ids = remainingEventIds;
    }
  }
  log.info("title-fallback done", {
    real_venue_candidates: realVenueNames.length,
    events_remapped_to_real_venue: titleMatchedEvents,
    address_only_venues_consolidated: venuesConsolidated,
    venues_after: venueQueue.size,
  });

  totals.unique_venues = venueQueue.size;
  log.info("identity+classify done", {
    identity_pass: totals.identity_pass,
    identity_skip: totals.identity_skip,
    classify_loadable: totals.classify_loadable,
    classify_skipped: totals.classify_skipped,
    unique_venues: totals.unique_venues,
    by_category: totals.by_category,
    by_skip_reason: totals.by_skip_reason,
  });

  // ─── Optional pass 1.5: re-queue venues with geocode_status='failed' ───
  // Use case: improved geocoder logic landed; want to retry previously-failed
  // venues without resetting raw_events. Independent of raw_events status.
  if (opts.retryFailedVenues) {
    const failedRows = db
      .prepare(`
        SELECT fingerprint, name, city FROM venues
        WHERE geocode_status = 'failed'
        ORDER BY id
      `)
      .all() as unknown as { fingerprint: string; name: string; city: string | null }[];
    let requeued = 0;
    for (const r of failedRows) {
      if (!venueQueue.has(r.fingerprint)) {
        venueQueue.set(r.fingerprint, {
          fingerprint: r.fingerprint,
          canonical_name: r.name,
          canonical_city: r.city ?? "",
          // For retry, we don't have the original raw_text; use the parsed
          // name as the geocoder query (still works via parse-location's
          // raw_text fallback).
          venue_text: r.name,
          raw_event_ids: [], // retry context — not tied to specific events
        });
        requeued += 1;
      }
    }
    log.info("retry-failed-venues queued", {
      previously_failed: failedRows.length,
      newly_requeued: requeued,
      queue_size_after: venueQueue.size,
    });
    totals.unique_venues = venueQueue.size;
  }

  // ─── Pass 2: Geocode unique venues (rate-limited; cap by --max-geocodes) ───
  // venues.name now stores the CANONICAL parsed venue_name (was raw_text).
  // venues.city stores the parsed city. This makes dedup state visible from
  // the table directly — debugging shows real venue counts not text variants.
  const upsertVenue = db.prepare(`
    INSERT INTO venues (fingerprint, name, city, lat, lng, country, geocode_source, geocode_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      lat = excluded.lat,
      lng = excluded.lng,
      country = excluded.country,
      geocode_source = excluded.geocode_source,
      geocode_status = excluded.geocode_status,
      updated_at = datetime('now')
  `);
  const insertVenueQualityFlag = db.prepare(`
    INSERT INTO quality_flags (raw_event_id, source_id, reason, detail)
    VALUES (?, ?, ?, ?)
  `);

  let geocodeCalls = 0;
  for (const v of venueQueue.values()) {
    if (geocodeCalls >= opts.maxGeocodes) {
      totals.venues_geocode_skipped_cap += 1;
      continue;
    }
    // ─── Structured-query geocoding (AIDI 2026-04-25 root-cause fix) ───
    // Parse the location string into {venue?, address, city, state, country}
    // and hand Nominatim a structured query (address+city+state+country),
    // skipping the venue prefix that confuses Nominatim's free-text parser.
    // Replaces the earlier venue-strip retry heuristic — this is what
    // Harvey's gcal-harvest does to get 90%+ rates on the same feeds.
    const parsed = parseLocation(v.venue_text);
    geocodeCalls += 1;
    let result = await geocoder.geocode({
      text: parsed.geocode_query,
      ...(parsed.country_iso ? { countryHint: parsed.country_iso } : {}),
      ...(parsed.city ? { cityHint: parsed.city } : {}),
      ...(parsed.state ? { stateHint: parsed.state } : {}),
    });

    // Fallback 1: venue_name + city + state — POI/landmark resolution.
    // Harvey's gcal-harvest pattern: SLC grid-style addresses ("1321 E
    // 3300 S") resolve poorly as addresses but well as POIs ("DF Dance
    // Studio, Salt Lake City, UT"). Try this BEFORE raw_text because
    // it's structurally cleaner.
    if (result.status !== "geocoded" && parsed.venue_name && parsed.city) {
      const poiQuery = [parsed.venue_name, parsed.city, parsed.state]
        .filter((p): p is string => Boolean(p))
        .join(", ");
      geocodeCalls += 1;
      const poiRetry = await geocoder.geocode({
        text: poiQuery,
        ...(parsed.country_iso ? { countryHint: parsed.country_iso } : {}),
      });
      if (poiRetry.status === "geocoded") {
        result = poiRetry;
      }
    }

    // Fallback 2: original raw_text. Catches cases where parser stripped
    // a token Nominatim actually needed (e.g., descriptive keyword that
    // disambiguates the location).
    if (result.status !== "geocoded" && parsed.geocode_query !== parsed.raw_text) {
      geocodeCalls += 1;
      const rawRetry = await geocoder.geocode({ text: parsed.raw_text });
      if (rawRetry.status === "geocoded") {
        result = rawRetry;
      }
    }

    if (result.status === "geocoded") {
      totals.venues_geocoded += 1;
      if (!opts.dryRun) {
        upsertVenue.run(
          v.fingerprint,
          v.canonical_name,
          v.canonical_city,
          result.lat ?? null,
          result.lng ?? null,
          result.country_code ?? null,
          result.source ?? null,
          "geocoded",
        );
        // FK link: every raw_event that referenced this venue gets its
        // venue_id set to the upserted venue row id (AIDI 2026-04-25
        // Phase 3 gate item #1; replaces fragile text-match join).
        const venueId = getVenueIdByFingerprint(db, v.fingerprint);
        if (venueId !== null) {
          for (const reId of v.raw_event_ids) linkRawEventVenue(db, reId, venueId);
        }
      }
    } else {
      totals.venues_geocode_failed += 1;
      if (!opts.dryRun) {
        upsertVenue.run(
          v.fingerprint,
          v.canonical_name,
          v.canonical_city,
          null, null, null,
          result.source ?? null,
          "failed",
        );
        // Even on failure: link raw_events to the venue row (status=failed)
        // so the load pipeline can see WHY they're not loadable. Loader
        // checks venue.geocode_status before treating as loadable.
        const venueId = getVenueIdByFingerprint(db, v.fingerprint);
        if (venueId !== null) {
          for (const reId of v.raw_event_ids) linkRawEventVenue(db, reId, venueId);
        }
        // Pin the failure to the first raw_event that referenced this venue
        // — gives the operator a single trace path back to source for review.
        // Skip the quality_flag insert on retry-failed-venues path
        // (raw_event_ids empty means "no tying event"; the original failure
        // already has its quality_flag from the first enrich pass).
        if (v.raw_event_ids.length > 0) {
          insertVenueQualityFlag.run(
            v.raw_event_ids[0]!,
            null,
            "geocode_failed",
            result.reject_reason ?? null,
          );
        }
      }
    }
  }

  log.info("geocode done", {
    geocode_calls: geocodeCalls,
    venues_geocoded: totals.venues_geocoded,
    venues_geocode_failed: totals.venues_geocode_failed,
    venues_geocode_skipped_cap: totals.venues_geocode_skipped_cap,
  });

  // ─── Cumulative state query (always populated; AIDI 2026-04-25 fix) ───
  // Lets the artifact reader know the niche's current standing regardless
  // of whether THIS run processed anything.
  const reByStatus = db
    .prepare(`SELECT status, COUNT(*) AS n FROM raw_events GROUP BY status`)
    .all() as unknown as { status: string; n: number }[];
  for (const r of reByStatus) {
    summary.total_state.raw_events_total += r.n;
    summary.total_state.raw_events_by_status[r.status] = r.n;
  }
  const venByStatus = db
    .prepare(`SELECT geocode_status, COUNT(*) AS n FROM venues GROUP BY geocode_status`)
    .all() as unknown as { geocode_status: string; n: number }[];
  for (const r of venByStatus) {
    summary.total_state.venues_total += r.n;
    summary.total_state.venues_by_geocode_status[r.geocode_status] = r.n;
  }
  const qfByReason = db
    .prepare(`SELECT reason, COUNT(*) AS n FROM quality_flags GROUP BY reason`)
    .all() as unknown as { reason: string; n: number }[];
  for (const r of qfByReason) {
    summary.total_state.quality_flags_total += r.n;
    summary.total_state.quality_flags_by_reason[r.reason] = r.n;
  }
  // loadable_for_phase_2: enriched raw_events whose linked venue is geocoded.
  // Schema v2 added raw_events.venue_id FK populated at venue upsert
  // (AIDI 2026-04-25 Phase 3 gate #1).
  const phase2 = db
    .prepare(`
      SELECT COUNT(*) AS n
      FROM raw_events re
      JOIN venues v ON v.id = re.venue_id
      WHERE re.status = 'enriched'
        AND v.geocode_status = 'geocoded'
    `)
    .get() as unknown as { n: number };
  summary.total_state.loadable_for_phase_2 = phase2.n;

  log.info("total_state computed", summary.total_state);

  // ─── Emit JSON enrich-summary ───
  const today = new Date().toISOString().slice(0, 10);
  const dir = PATHS.snapshotsDir(opts.niche);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${today}-enrich.json`);
  writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
  log.info("enrich summary written", { path });

  db.close();
}

await main();
