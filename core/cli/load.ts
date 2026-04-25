#!/usr/bin/env node --experimental-strip-types
// core/cli/load.ts — Phase 2 dry-run loader.
//
// Reads enriched raw_events + their geocoded venues from SQLite. For each
// loadable event:
//   1. Resolve organizer (from raw_organizer_text if present)
//   2. Resolve venue (use the geocoded venue from venues table)
//   3. Compute the full event denorm bundle per LOADER-CONTRACT §6
//   4. Hand to Loader (dry-run today; mongo-direct at Phase 3)
//
// Emits a JSON report at data/<niche>/snapshots/<YYYY-MM-DD>-load.json
// with:
//   - this_run: counts (organizers/venues/events attempted/created/etc.)
//   - total_state: SQLite cumulative state (echoes enrich-summary shape)
//   - quality_flags_this_batch: every non-loadable reason in this run
//     (AIDI 2026-04-25 review expectation #3)
//   - sample_documents: first N captured Organizer/Venue/Event docs
//     with full LOADER-CONTRACT §6 fields including TODO:automaster
//     sentinels (AIDI expectation #1; verifiable contract honor)
//
// Usage:
//   bash run.sh --niche=tango load [--dry-run] [--max-events=N] [--samples=N]
//
// Phase 2 is dry-run-only by design; --dry-run flag is accepted and
// ignored. Phase 3 will introduce a real --live mode (gated by AIDI
// greenlight) that swaps the Loader implementation.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadNiche, NicheConfigError } from "../config.ts";
import { createLogger } from "../logger.ts";
import { openStore } from "../store.ts";
import { classify } from "../classify.ts";
import { PATHS } from "../types.ts";
import type { RawEvent } from "../types.ts";

import {
  buildEventDoc,
  buildOrganizerDoc,
  buildVenueDoc,
  type EnrichedRow,
  type VenueRow,
} from "../loader/denorm.ts";
import { DryRunLoader } from "../loader/dry-run.ts";

interface LoadOpts {
  niche: string;
  dryRun: boolean; // accepted for forward-compat; Phase 2 is always dry-run
  maxEvents: number;
  samples: number;
}

function parseCli(argv: string[]): LoadOpts {
  const args = argv.slice(2);
  const niche = pickArg(args, "--niche");
  if (!niche) fail("Missing --niche=<key>");
  return {
    niche,
    dryRun: true, // Phase 2 hardwired
    maxEvents: numArg(args, "--max-events", 500),
    samples: numArg(args, "--samples", 10),
  };
}

function numArg(args: string[], key: string, def: number): number {
  const v = pickArg(args, key);
  return v ? Number(v) : def;
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
  process.stderr.write(`load: ${msg}\n`);
  process.exit(2);
}

interface LoadReport {
  niche: string;
  generated_at: string;
  loader: "dry-run";
  this_run: {
    enriched_events_seen: number;
    eligible_for_load: number;
    skipped_no_venue: number;
    skipped_venue_not_geocoded: number;
    skipped_no_dates: number;
    counts: ReturnType<DryRunLoader["counts"]>;
  };
  total_state: {
    raw_events_total: number;
    raw_events_by_status: Record<string, number>;
    venues_total: number;
    venues_by_geocode_status: Record<string, number>;
    quality_flags_total: number;
    quality_flags_by_reason: Record<string, number>;
  };
  /** AIDI 2026-04-25 expectation #3: every non-loadable reason in this run */
  quality_flags_this_batch: Record<string, number>;
  /** AIDI expectation #1: full §6 doc shape verifiable from samples alone */
  sample_documents: {
    organizers: ReturnType<DryRunLoader["capturedOrganizers"]["slice"]>;
    venues: ReturnType<DryRunLoader["capturedVenues"]["slice"]>;
    events: ReturnType<DryRunLoader["capturedEvents"]["slice"]>;
  };
}

interface JoinedRow {
  // raw_event columns
  re_id: number;
  re_source_id: number;
  re_raw_title: string;
  re_raw_date_text: string | null;
  re_raw_location_text: string | null;
  re_raw_description: string | null;
  re_raw_organizer_text: string | null;
  re_raw_url: string | null;
  re_raw_json: string | null;
  // venue columns (left join — null if no venue match)
  v_id: number | null;
  v_name: string | null;
  v_address: string | null;
  v_city: string | null;
  v_state: string | null;
  v_country: string | null;
  v_lat: number | null;
  v_lng: number | null;
  v_geocode_status: string | null;
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const log = createLogger("load", { niche: opts.niche });

  let niche;
  try {
    niche = loadNiche(opts.niche);
  } catch (err) {
    if (err instanceof NicheConfigError) fail(err.message);
    throw err;
  }

  const db = openStore(opts.niche);
  const loader = new DryRunLoader();

  // ─── Read enriched raw_events JOIN their venue via FK (AIDI 2026-04-25
  // Phase 3 gate #1: schema v2 added raw_events.venue_id; enrich populates
  // at venue upsert time; load joins by FK not text-match) ───
  const rows = db
    .prepare(`
      SELECT
        re.id              AS re_id,
        re.source_id       AS re_source_id,
        re.raw_title       AS re_raw_title,
        re.raw_date_text   AS re_raw_date_text,
        re.raw_location_text AS re_raw_location_text,
        re.raw_description AS re_raw_description,
        re.raw_organizer_text AS re_raw_organizer_text,
        re.raw_url         AS re_raw_url,
        re.raw_json        AS re_raw_json,
        v.id               AS v_id,
        v.name             AS v_name,
        v.address          AS v_address,
        v.city             AS v_city,
        v.state            AS v_state,
        v.country          AS v_country,
        v.lat              AS v_lat,
        v.lng              AS v_lng,
        v.geocode_status   AS v_geocode_status
      FROM raw_events re
      LEFT JOIN venues v ON v.id = re.venue_id
      WHERE re.status = 'enriched'
      ORDER BY re.id
      LIMIT ?
    `)
    .all(opts.maxEvents) as unknown as JoinedRow[];

  log.info("load start", {
    enriched_events_seen: rows.length,
    max_events: opts.maxEvents,
    loader: loader.name,
  });

  let skippedNoVenue = 0;
  let skippedVenueNotGeocoded = 0;
  let skippedNoDates = 0;
  let eligible = 0;

  for (const row of rows) {
    // ─── Re-derive RawEvent + classify (same path as enrich) ───
    let parsedJson: { dtstart?: string; dtend?: string; start_dt_iso?: string; end_dt_iso?: string } = {};
    if (row.re_raw_json) {
      try {
        parsedJson = JSON.parse(row.re_raw_json) as typeof parsedJson;
      } catch {}
    }
    const startIso = parsedJson.start_dt_iso ?? parsedJson.dtstart;
    const endIso = parsedJson.end_dt_iso ?? parsedJson.dtend;

    if (!startIso || !endIso) {
      skippedNoDates += 1;
      continue;
    }

    const ev: RawEvent = {
      source_event_id: String(row.re_id),
      raw_title: row.re_raw_title,
      ...(row.re_raw_date_text !== null ? { raw_date_text: row.re_raw_date_text } : {}),
      start_dt_iso: startIso,
      end_dt_iso: endIso,
      ...(row.re_raw_location_text !== null ? { raw_location_text: row.re_raw_location_text } : {}),
      ...(row.re_raw_description !== null ? { raw_description: row.re_raw_description } : {}),
      ...(row.re_raw_organizer_text !== null ? { raw_organizer_text: row.re_raw_organizer_text } : {}),
      ...(row.re_raw_url !== null ? { raw_url: row.re_raw_url } : {}),
    };
    const cl = classify(ev, niche);

    // Reject if classifier indicates skip OR duration_violation present
    if (cl.skip_reason || cl.duration_violation) {
      // These should already be in quality_flags from enrich; not eligible.
      continue;
    }

    if (!row.v_id || !row.v_name) {
      skippedNoVenue += 1;
      continue;
    }
    if (row.v_geocode_status !== "geocoded" || row.v_lat === null || row.v_lng === null) {
      skippedVenueNotGeocoded += 1;
      continue;
    }

    eligible += 1;

    // ─── 1. Organizer (lookup-or-create) ───
    let ownerOrganizerID: string | null = null;
    if (row.re_raw_organizer_text) {
      const orgDoc = buildOrganizerDoc(row.re_raw_organizer_text, niche);
      if (orgDoc) {
        const id = await loader.upsertOrganizer(orgDoc);
        ownerOrganizerID = String(id);
      }
    }

    // ─── 2. Venue (POST or 409→existing) ───
    const venueRow: VenueRow = {
      id: row.v_id,
      name: row.v_name,
      address: row.v_address,
      city: row.v_city,
      state: row.v_state,
      country: row.v_country,
      lat: row.v_lat,
      lng: row.v_lng,
    };
    const venueDoc = buildVenueDoc(venueRow, niche);
    const { venueId, masteredChain } = await loader.upsertVenue(venueDoc);

    // ─── 3. Event (insertOne with full denorm) ───
    const enriched: EnrichedRow = {
      id: row.re_id,
      source_id: row.re_source_id,
      raw_title: row.re_raw_title,
      raw_description: row.re_raw_description,
      raw_organizer_text: row.re_raw_organizer_text,
      raw_url: row.re_raw_url,
      start_dt_iso: startIso,
      end_dt_iso: endIso,
      source_rrule: parsedJson.dtstart && row.re_raw_json
        ? extractRrule(row.re_raw_json)
        : null,
      classify: cl,
    };
    const eventDoc = buildEventDoc({
      enriched,
      venue: venueRow,
      niche,
      venueChain: masteredChain,
      venueId,
      ownerOrganizerID,
      categoryFirstId: null, // dry-run; live populates from cache-warmed categories per §6.4
    });
    await loader.insertEvent(eventDoc);
  }

  // ─── Cumulative state queries ───
  const totalState = {
    raw_events_total: 0,
    raw_events_by_status: {} as Record<string, number>,
    venues_total: 0,
    venues_by_geocode_status: {} as Record<string, number>,
    quality_flags_total: 0,
    quality_flags_by_reason: {} as Record<string, number>,
  };
  for (const r of db
    .prepare(`SELECT status, COUNT(*) AS n FROM raw_events GROUP BY status`)
    .all() as unknown as { status: string; n: number }[]) {
    totalState.raw_events_total += r.n;
    totalState.raw_events_by_status[r.status] = r.n;
  }
  for (const r of db
    .prepare(`SELECT geocode_status, COUNT(*) AS n FROM venues GROUP BY geocode_status`)
    .all() as unknown as { geocode_status: string; n: number }[]) {
    totalState.venues_total += r.n;
    totalState.venues_by_geocode_status[r.geocode_status] = r.n;
  }
  for (const r of db
    .prepare(`SELECT reason, COUNT(*) AS n FROM quality_flags GROUP BY reason`)
    .all() as unknown as { reason: string; n: number }[]) {
    totalState.quality_flags_total += r.n;
    totalState.quality_flags_by_reason[r.reason] = r.n;
  }

  // quality_flags_this_batch: same as totals, since dry-run reads ALL
  // pending state (no filter on captured_at). Future load runs will
  // filter by captured_at >= run_start.
  const qfThisBatch: Record<string, number> = { ...totalState.quality_flags_by_reason };

  const counts = loader.counts();
  log.info("load done", {
    enriched_events_seen: rows.length,
    eligible_for_load: eligible,
    skipped_no_venue: skippedNoVenue,
    skipped_venue_not_geocoded: skippedVenueNotGeocoded,
    skipped_no_dates: skippedNoDates,
    counts,
  });

  // ─── Build report ───
  const report: LoadReport = {
    niche: opts.niche,
    generated_at: new Date().toISOString(),
    loader: "dry-run",
    this_run: {
      enriched_events_seen: rows.length,
      eligible_for_load: eligible,
      skipped_no_venue: skippedNoVenue,
      skipped_venue_not_geocoded: skippedVenueNotGeocoded,
      skipped_no_dates: skippedNoDates,
      counts,
    },
    total_state: totalState,
    quality_flags_this_batch: qfThisBatch,
    sample_documents: {
      organizers: loader.capturedOrganizers.slice(0, opts.samples),
      venues: loader.capturedVenues.slice(0, opts.samples),
      events: loader.capturedEvents.slice(0, opts.samples),
    },
  };

  const today = new Date().toISOString().slice(0, 10);
  const dir = PATHS.snapshotsDir(opts.niche);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${today}-load.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  log.info("load report written", { path });

  db.close();
}

function extractRrule(rawJson: string): string | null {
  try {
    const j = JSON.parse(rawJson) as { rrule?: string; source_rrule?: string };
    return j.rrule ?? j.source_rrule ?? null;
  } catch {
    return null;
  }
}

await main();
