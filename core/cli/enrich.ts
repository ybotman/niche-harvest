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
import { openStore } from "../store.ts";
import { fingerprintVenue } from "../fingerprint.ts";
import { identityCheck, classify } from "../classify.ts";
import { NominatimGeocoder } from "../geocoder/nominatim.ts";
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
  totals: {
    raw_events_pending: number;
    identity_pass: number;
    identity_skip: number;
    classify_loadable: number;
    classify_skipped: number;
    by_category: Record<string, number>;
    by_skip_reason: Record<string, number>;
    unique_venues: number;
    venues_geocoded: number;
    venues_geocode_failed: number;
    venues_geocode_skipped_cap: number;
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
        s.trusted, s.source_id AS source_name
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
    totals: {
      raw_events_pending: rows.length,
      identity_pass: 0,
      identity_skip: 0,
      classify_loadable: 0,
      classify_skipped: 0,
      by_category: {},
      by_skip_reason: {},
      unique_venues: 0,
      venues_geocoded: 0,
      venues_geocode_failed: 0,
      venues_geocode_skipped_cap: 0,
    },
  };

  log.info("enrich start", {
    raw_events_pending: rows.length,
    dry_run: opts.dryRun,
    max_geocodes: opts.maxGeocodes,
  });

  // ─── Pass 1: Identity + classify ───
  // Collect unique venues for batched geocoding pass 2.
  const venueQueue = new Map<
    string,
    { fingerprint: string; venue_text: string; first_event_id: number }
  >();

  const updateRawStatus = db.prepare(
    `UPDATE raw_events SET status = ?, enriched_at = ? WHERE id = ?`,
  );
  const insertQualityFlag = db.prepare(`
    INSERT INTO quality_flags (raw_event_id, source_id, reason, detail)
    VALUES (?, ?, ?, ?)
  `);

  for (const row of rows) {
    const ev: RawEvent = {
      source_event_id: String(row.id),
      raw_title: row.raw_title,
      ...(row.raw_date_text !== null ? { raw_date_text: row.raw_date_text } : {}),
      ...(row.raw_location_text !== null ? { raw_location_text: row.raw_location_text } : {}),
      ...(row.raw_description !== null ? { raw_description: row.raw_description } : {}),
      ...(row.raw_organizer_text !== null ? { raw_organizer_text: row.raw_organizer_text } : {}),
      ...(row.raw_url !== null ? { raw_url: row.raw_url } : {}),
    };

    // ─── Identity check (trusted sources skip) ───
    if (row.trusted !== 1) {
      const id = identityCheck(ev, niche);
      if (!id.passed) {
        summary.totals.identity_skip += 1;
        if (!opts.dryRun) {
          insertQualityFlag.run(row.id, row.source_id, "venue_invalid", id.reason ?? null);
          updateRawStatus.run("skipped", new Date().toISOString(), row.id);
        }
        continue;
      }
    }
    summary.totals.identity_pass += 1;

    // ─── Classify ───
    const cl = classify(ev, niche);
    if (cl.category_first) {
      summary.totals.by_category[cl.category_first] =
        (summary.totals.by_category[cl.category_first] ?? 0) + 1;
    }
    if (cl.skip_reason) {
      // Class-only is gated by niche.loader.load_classes (LOADER-CONTRACT §7.1.1)
      const isClassOnlyOptedIn =
        cl.skip_reason === "skip_class_only" && niche.loader.load_classes;
      if (!isClassOnlyOptedIn) {
        summary.totals.classify_skipped += 1;
        summary.totals.by_skip_reason[cl.skip_reason] =
          (summary.totals.by_skip_reason[cl.skip_reason] ?? 0) + 1;
        if (!opts.dryRun) {
          insertQualityFlag.run(row.id, row.source_id, cl.skip_reason, null);
          updateRawStatus.run("skipped", new Date().toISOString(), row.id);
        }
        continue;
      }
    }
    summary.totals.classify_loadable += 1;

    // ─── Queue venue for geocoding pass ───
    if (row.raw_location_text) {
      const fp = fingerprintVenue({ name: row.raw_location_text });
      if (!venueQueue.has(fp)) {
        venueQueue.set(fp, {
          fingerprint: fp,
          venue_text: row.raw_location_text,
          first_event_id: row.id,
        });
      }
    }

    if (!opts.dryRun) {
      updateRawStatus.run("enriched", new Date().toISOString(), row.id);
    }
  }

  summary.totals.unique_venues = venueQueue.size;
  log.info("identity+classify done", {
    identity_pass: summary.totals.identity_pass,
    identity_skip: summary.totals.identity_skip,
    classify_loadable: summary.totals.classify_loadable,
    classify_skipped: summary.totals.classify_skipped,
    unique_venues: summary.totals.unique_venues,
    by_category: summary.totals.by_category,
    by_skip_reason: summary.totals.by_skip_reason,
  });

  // ─── Optional pass 1.5: re-queue venues with geocode_status='failed' ───
  // Use case: improved geocoder logic landed; want to retry previously-failed
  // venues without resetting raw_events. Independent of raw_events status.
  if (opts.retryFailedVenues) {
    const failedRows = db
      .prepare(`
        SELECT fingerprint, name FROM venues
        WHERE geocode_status = 'failed'
        ORDER BY id
      `)
      .all() as unknown as { fingerprint: string; name: string }[];
    let requeued = 0;
    for (const r of failedRows) {
      if (!venueQueue.has(r.fingerprint)) {
        venueQueue.set(r.fingerprint, {
          fingerprint: r.fingerprint,
          venue_text: r.name,
          first_event_id: 0, // not tied to a specific raw_event (retry context)
        });
        requeued += 1;
      }
    }
    log.info("retry-failed-venues queued", {
      previously_failed: failedRows.length,
      newly_requeued: requeued,
      queue_size_after: venueQueue.size,
    });
    summary.totals.unique_venues = venueQueue.size;
  }

  // ─── Pass 2: Geocode unique venues (rate-limited; cap by --max-geocodes) ───
  const upsertVenue = db.prepare(`
    INSERT INTO venues (fingerprint, name, lat, lng, country, geocode_source, geocode_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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
      summary.totals.venues_geocode_skipped_cap += 1;
      continue;
    }
    geocodeCalls += 1;
    let result = await geocoder.geocode({ text: v.venue_text });

    // ─── Fallback: strip leading "VenueName, " prefix and retry ───
    // Nominatim's free-text geocoder often fails on "Studio Name, 123 Main St,
    // City, ST" because it tries to match the leading venue name as a place.
    // The address portion alone usually resolves fine. We attempt the stripped
    // form ONLY if the original failed AND the comma is in a reasonable
    // position (avoids stripping useful tokens like "Suite 6, ..." mid-address).
    if (result.status !== "geocoded") {
      const commaIdx = v.venue_text.indexOf(",");
      // Heuristic: strip if the first token looks like a venue name (len 4-50,
      // contains a letter, no digits — "DF Dance Studio" yes, "1751 W Alexander" no).
      if (commaIdx > 3 && commaIdx < 50) {
        const prefix = v.venue_text.slice(0, commaIdx).trim();
        const looksLikeVenueName =
          /[A-Za-z]/.test(prefix) && !/^\d/.test(prefix);
        if (looksLikeVenueName) {
          const stripped = v.venue_text.slice(commaIdx + 1).trim();
          if (stripped.length > 0) {
            geocodeCalls += 1;
            const retry = await geocoder.geocode({ text: stripped });
            if (retry.status === "geocoded") {
              result = retry;
            }
          }
        }
      }
    }

    if (result.status === "geocoded") {
      summary.totals.venues_geocoded += 1;
      if (!opts.dryRun) {
        upsertVenue.run(
          v.fingerprint,
          v.venue_text,
          result.lat ?? null,
          result.lng ?? null,
          result.country_code ?? null,
          result.source ?? null,
          "geocoded",
        );
      }
    } else {
      summary.totals.venues_geocode_failed += 1;
      if (!opts.dryRun) {
        upsertVenue.run(
          v.fingerprint,
          v.venue_text,
          null, null, null,
          result.source ?? null,
          "failed",
        );
        // Pin the failure to the first raw_event that referenced this venue
        // — gives the operator a single trace path back to source for review.
        // Skip the quality_flag insert on retry-failed-venues path
        // (first_event_id=0 means "no tying event"; the original failure
        // already has its quality_flag from the first enrich pass).
        if (v.first_event_id > 0) {
          insertVenueQualityFlag.run(
            v.first_event_id,
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
    venues_geocoded: summary.totals.venues_geocoded,
    venues_geocode_failed: summary.totals.venues_geocode_failed,
    venues_geocode_skipped_cap: summary.totals.venues_geocode_skipped_cap,
  });

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
