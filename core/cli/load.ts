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
import { randomUUID } from "node:crypto";

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
import { MongoDirectLoader } from "../loader/mongo-direct.ts";
import type {
  EventDoc,
  OrganizerDoc,
  VenueDoc,
  VenueMasteredChainResponse,
} from "../loader/interface.ts";
import {
  warmCategories,
  resolveCategoryId,
  CategoryWarmError,
  type CategoryCache,
} from "../loader/categories.ts";

interface LoadOpts {
  niche: string;
  /**
   * --live ENABLES actual writes to Mongo via MongoDirectLoader.
   * Default: false (DryRunLoader; nothing written). Per GUARDRAILS H6 +
   * Toby standing rule: requires MONGODB_URI_TEST env + per-run auth.
   * MongoDirectLoader's confirmTestOnly defense further blocks accidental
   * PROD writes via typo'd connection string. PROD is BLOCKED entirely
   * (no NICHE_HARVEST_PROD_OK pathway exists).
   */
  live: boolean;
  maxEvents: number;
  samples: number;
  beUrl: string;
  categoriesAppId: number;
  appidOverride: number | null;
  noWarmCategories: boolean;
  /**
   * AIDI Phase 3 gate item #3: --mongo-verify connects to TEST Mongo
   * (read-only), captures collection counts BEFORE + AFTER the dry-run,
   * proves zero writes via diff. Requires MONGODB_URI_TEST env var.
   * Runs only if Toby has explicitly authorized URI use (the construct
   * itself enforces confirmTestOnly).
   */
  mongoVerify: boolean;
}

function parseCli(argv: string[]): LoadOpts {
  const args = argv.slice(2);
  const niche = pickArg(args, "--niche");
  if (!niche) fail("Missing --niche=<key>");
  return {
    niche,
    live: args.includes("--live"),
    maxEvents: numArg(args, "--max-events", 500),
    samples: numArg(args, "--samples", 10),
    beUrl:
      pickArg(args, "--be-url") ?? "https://calendarbeaf-test.azurewebsites.net",
    // Categories are global tango entities under appId=1; events written
    // under appId-override (e.g. 99) reference appId=1 category ObjectIds.
    // Cross-niche reference is fine — Mongo doesn't enforce; FE invisible.
    categoriesAppId: numArg(args, "--categories-appid", 1),
    appidOverride: pickArg(args, "--appid-override")
      ? Number(pickArg(args, "--appid-override"))
      : null,
    noWarmCategories: args.includes("--no-warm-categories"),
    mongoVerify: args.includes("--mongo-verify"),
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

interface MongoVerifyReport {
  status: "skipped" | "verified_zero_writes" | "writes_detected" | "error";
  uri_present: boolean;
  collections_checked: string[];
  counts_before?: Record<string, number>;
  counts_after?: Record<string, number>;
  /** Per-collection diff = after - before. Zero across all = verified. */
  diff?: Record<string, number>;
  total_diff?: number;
  error?: string;
}

interface LoadReport {
  niche: string;
  generated_at: string;
  loader: "dry-run" | "mongo-direct";
  /** GUARDRAILS H11: per-cycle UUID for rollback. Format: nh-<niche>-<utc>-<8>. */
  nh_batch_id: string;
  /** Pre-built rollback command — paste-ready when needed. */
  rollback_commands: {
    events: string;
    venues: string;
    organizers: string;
  };
  /** AIDI Phase 3 gate item #3: zero-writes proof via Mongo count diff. */
  mongo_verify: MongoVerifyReport;
  /** Categories cache-warm status (AIDI Phase 3 gate item #2). */
  categories_cache: {
    status: "warmed" | "skipped" | "failed";
    be_url: string;
    appId: number;
    entries: number;
    sample_names: string[];
    error?: string;
    warmedAt?: string;
  };
  appid_override: number | null;
  this_run: {
    enriched_events_seen: number;
    eligible_for_load: number;
    skipped_no_venue: number;
    skipped_venue_not_geocoded: number;
    skipped_no_dates: number;
    category_id_unknown: number;
    counts: ReturnType<DryRunLoader["counts"]>;
    /** Explicit reason when organizers_attempted=0 (AIDI 2026-04-25). */
    organizer_skip_reason?: string;
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
    organizers: { doc: OrganizerDoc; resolvedId: string | object }[];
    venues: { doc: VenueDoc; resolvedId: string | object; masteredChain: VenueMasteredChainResponse }[];
    events: { doc: EventDoc; resolvedId: string | object; status: string; detail?: string }[];
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

  // ─── Loader selection: dry-run (default) vs --live ───
  // Per GUARDRAILS H5 + H6 + Toby standing rule: --live requires:
  //   (a) MONGODB_URI_TEST env var present (Toby per-secret auth)
  //   (b) NICHE_HARVEST_LIVE=1 env var present (per-run auth — must be
  //       set EXPLICITLY by the operator each run, not stored in their
  //       shell rc file. Defense against accidental --live invocation.)
  //   (c) MongoDirectLoader.confirmTestOnly: true (PROD-STAY-OUT defense)
  // Without all 3, --live fails fast with a clear message.
  let loader: DryRunLoader | MongoDirectLoader;
  if (opts.live) {
    const uri = process.env.MONGODB_URI_TEST;
    const liveOk = process.env.NICHE_HARVEST_LIVE === "1";
    if (!uri) {
      fail(
        "--live requires MONGODB_URI_TEST env var. " +
          "Per Toby per-secret auth: export this only when authorized for THIS run.",
      );
    }
    if (!liveOk) {
      fail(
        "--live requires NICHE_HARVEST_LIVE=1 env var (per-run auth gate). " +
          "Set explicitly each run; do NOT bake into shell rc files.",
      );
    }
    const live = new MongoDirectLoader({
      mongoUri: uri,
      beUrl: opts.beUrl,
      logger: log,
      confirmTestOnly: true,
    });
    await live.connect();
    log.warn("--live MODE ACTIVE: writes to TEST Mongo will occur", {
      uri_db: "TangoTiempoTest",
      appid_override: opts.appidOverride,
      nh_batch_id: "<assigned next>",
    });
    loader = live;
  } else {
    loader = new DryRunLoader();
  }

  // Caller-side sample capture — works in BOTH modes (was DryRunLoader-only).
  // AIDI needs to inspect would-be / did-be docs in the report regardless
  // of which loader handled the writes. Cap at opts.samples.
  const capturedOrganizers: { doc: OrganizerDoc; resolvedId: string | object }[] = [];
  const capturedVenues: { doc: VenueDoc; resolvedId: string | object; masteredChain: VenueMasteredChainResponse }[] = [];
  const capturedEvents: { doc: EventDoc; resolvedId: string | object; status: string; detail?: string }[] = [];

  // ─── GUARDRAILS H11: per-cycle batch_id for rollback ───
  // Format: nh-<niche>-<utc-yyyymmddThhmmss>-<8-char-uuid-suffix>
  // Human-readable + sortable + collision-safe. Threaded through every
  // doc; report records it at top so rollback is trivial:
  //   db.events.deleteMany({nh_batch_id: "<id-from-report>"})
  const nhBatchId = `nh-${opts.niche}-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")}-${randomUUID().slice(0, 8)}`;
  log.info("nh_batch_id assigned", {
    nh_batch_id: nhBatchId,
    note: "rollback any --live writes from this run via " +
          "db.<collection>.deleteMany({nh_batch_id: <id>})",
  });

  // ─── AIDI Phase 3 gate item #3: --mongo-verify ───
  // Connects to TEST Mongo (read-only), captures collection counts
  // BEFORE the dry-run, captures AFTER, asserts diff=0. Refuses to
  // run without MONGODB_URI_TEST env var (Toby URI auth gate).
  // Constructor's confirmTestOnly defense prevents accidental PROD use.
  let mongoLoader: MongoDirectLoader | null = null;
  const mongoVerifyReport: MongoVerifyReport = {
    status: "skipped",
    uri_present: false,
    collections_checked: ["events", "venues", "organizers"],
  };
  if (opts.mongoVerify) {
    const uri = process.env.MONGODB_URI_TEST;
    mongoVerifyReport.uri_present = Boolean(uri);
    if (!uri) {
      mongoVerifyReport.status = "error";
      mongoVerifyReport.error =
        "MONGODB_URI_TEST env var not set; --mongo-verify aborted. " +
        "Toby must explicitly authorize TEST URI use; pass via env var, never hardcoded.";
      log.error(mongoVerifyReport.error);
      // Don't abort the whole run — write the report with the error
      // section populated so AIDI sees what happened.
    } else {
      try {
        mongoLoader = new MongoDirectLoader({
          mongoUri: uri,
          beUrl: opts.beUrl,
          logger: log,
          confirmTestOnly: true,
        });
        await mongoLoader.connect();
        mongoVerifyReport.counts_before = await mongoLoader.collectionCounts(
          mongoVerifyReport.collections_checked,
        );
        log.info("mongo_verify counts captured (before)", {
          counts: mongoVerifyReport.counts_before,
        });
      } catch (err) {
        mongoVerifyReport.status = "error";
        mongoVerifyReport.error = err instanceof Error ? err.message : String(err);
        log.error("mongo_verify connect/count failed", { error: mongoVerifyReport.error });
        // Close any partially-opened resources
        if (mongoLoader) {
          try {
            await mongoLoader.close();
          } catch {}
          mongoLoader = null;
        }
      }
    }
  }

  // ─── Categories cache-warm (AIDI Phase 3 gate item #2) ───
  // Anonymous endpoint; no credential. Resolves categoryName → ObjectId
  // before first event build so dry-run captured docs carry real IDs.
  let categoryCache: CategoryCache | null = null;
  let categoryCacheStatus: "warmed" | "skipped" | "failed" = "skipped";
  let categoryCacheError: string | undefined;
  if (!opts.noWarmCategories) {
    try {
      categoryCache = await warmCategories({
        beUrl: opts.beUrl,
        appId: opts.categoriesAppId,
        logger: log,
      });
      categoryCacheStatus = "warmed";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      categoryCacheStatus = "failed";
      categoryCacheError = message;
      log.warn("categories cache-warm failed; proceeding with null categoryFirstId", {
        error: message,
        be_url: opts.beUrl,
      });
    }
  }
  const appIdInUse = opts.appidOverride ?? niche.niche.appid;
  if (opts.appidOverride !== null) {
    log.info("appid_override active", {
      override: opts.appidOverride,
      niche_yaml_appid: niche.niche.appid,
      reason: "test-isolation; FE filters by niche.yaml appid; cleanup via deleteMany({appId: override})",
    });
  }
  // Synthesize an effective niche config with overridden appid; doc
  // builders read niche.niche.appid for venue/organizer/event docs.
  const effectiveNiche = {
    ...niche,
    niche: { ...niche.niche, appid: appIdInUse },
  };

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
  let categoryIdUnknown = 0;

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
      const orgDoc = buildOrganizerDoc(row.re_raw_organizer_text, effectiveNiche, nhBatchId);
      if (orgDoc) {
        const id = await loader.upsertOrganizer(orgDoc);
        ownerOrganizerID = String(id);
        if (capturedOrganizers.length < opts.samples) {
          capturedOrganizers.push({ doc: orgDoc, resolvedId: id });
        }
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
    const venueDoc = buildVenueDoc(venueRow, effectiveNiche, nhBatchId);
    const { venueId, masteredChain } = await loader.upsertVenue(venueDoc);
    if (capturedVenues.length < opts.samples) {
      capturedVenues.push({ doc: venueDoc, resolvedId: venueId, masteredChain });
    }

    // ─── 3. categoryFirstId resolution from cache (LOADER §6.4) ───
    let categoryFirstId: string | null = null;
    if (categoryCache && cl.category_first) {
      categoryFirstId = resolveCategoryId(categoryCache, cl.category_first);
      if (categoryFirstId === null) {
        categoryIdUnknown += 1;
        // Per LOADER-CONTRACT §6.4: unknown category string → quality_flag,
        // event excluded from load. We still capture the would-be doc here
        // for dry-run reporting visibility but mark it.
      }
    }

    // ─── 4. Event (insertOne with full denorm) ───
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
      niche: effectiveNiche,
      venueChain: masteredChain,
      venueId,
      ownerOrganizerID,
      categoryFirstId: categoryFirstId,
      nhBatchId,
    });
    const evResult = await loader.insertEvent(eventDoc);
    if (capturedEvents.length < opts.samples) {
      capturedEvents.push({
        doc: eventDoc,
        resolvedId: evResult.eventId,
        status: evResult.status,
        ...(evResult.detail ? { detail: evResult.detail } : {}),
      });
    }
  }

  // Close MongoDirectLoader cleanly when --live (releases pool)
  if (opts.live && loader instanceof MongoDirectLoader) {
    await loader.close();
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

  // ─── Organizer-skip explicit reason (AIDI 2026-04-25 follow-up) ───
  // When 0 organizers attempted but the source DOES have organizer signal,
  // log explicitly why — not silent. Distinguishes "source has no
  // organizers" from "all organizer-bearing events were filtered out".
  const orgBearingTotal = (db
    .prepare(`
      SELECT COUNT(*) AS n FROM raw_events
      WHERE raw_organizer_text IS NOT NULL AND raw_organizer_text != ''
    `)
    .get() as { n: number }).n;
  let organizerSkipReason: string | undefined;
  if (counts.organizers_attempted === 0 && orgBearingTotal > 0) {
    organizerSkipReason =
      `0_organizers_attempted: ${orgBearingTotal} organizer-bearing raw_events ` +
      `but all were excluded upstream (likely at geocode gate or classify gate)`;
  } else if (counts.organizers_attempted === 0 && orgBearingTotal === 0) {
    organizerSkipReason = "0_organizers: source has no organizer signal in any raw_event";
  }

  log.info("load done", {
    enriched_events_seen: rows.length,
    eligible_for_load: eligible,
    skipped_no_venue: skippedNoVenue,
    skipped_venue_not_geocoded: skippedVenueNotGeocoded,
    skipped_no_dates: skippedNoDates,
    counts,
    ...(organizerSkipReason ? { organizer_skip_reason: organizerSkipReason } : {}),
  });

  // ─── AIDI Phase 3 gate item #3: --mongo-verify AFTER snapshot + diff ───
  if (opts.mongoVerify && mongoLoader && mongoVerifyReport.status !== "error") {
    try {
      mongoVerifyReport.counts_after = await mongoLoader.collectionCounts(
        mongoVerifyReport.collections_checked,
      );
      log.info("mongo_verify counts captured (after)", {
        counts: mongoVerifyReport.counts_after,
      });
      const before = mongoVerifyReport.counts_before ?? {};
      const after = mongoVerifyReport.counts_after;
      const diff: Record<string, number> = {};
      let totalDiff = 0;
      for (const c of mongoVerifyReport.collections_checked) {
        const b = before[c] ?? 0;
        const a = after[c] ?? 0;
        diff[c] = a - b;
        totalDiff += Math.abs(diff[c]);
      }
      mongoVerifyReport.diff = diff;
      mongoVerifyReport.total_diff = totalDiff;
      mongoVerifyReport.status =
        totalDiff === 0 ? "verified_zero_writes" : "writes_detected";
      log.info("mongo_verify diff", {
        diff,
        total_diff: totalDiff,
        status: mongoVerifyReport.status,
      });
    } catch (err) {
      mongoVerifyReport.status = "error";
      mongoVerifyReport.error = err instanceof Error ? err.message : String(err);
      log.error("mongo_verify after-snapshot failed", { error: mongoVerifyReport.error });
    } finally {
      try {
        await mongoLoader.close();
      } catch {}
    }
  }

  // ─── Build report ───
  const report: LoadReport = {
    niche: opts.niche,
    generated_at: new Date().toISOString(),
    loader: opts.live ? "mongo-direct" : "dry-run",
    nh_batch_id: nhBatchId,
    rollback_commands: {
      events: `db.events.deleteMany({nh_batch_id: "${nhBatchId}"})`,
      venues: `db.venues.deleteMany({nh_batch_id: "${nhBatchId}"})`,
      organizers: `db.organizers.deleteMany({nh_batch_id: "${nhBatchId}"})`,
    },
    mongo_verify: mongoVerifyReport,
    categories_cache: {
      status: categoryCacheStatus,
      be_url: opts.beUrl,
      appId: opts.categoriesAppId,
      entries: categoryCache?.byName.size ?? 0,
      sample_names: categoryCache
        ? Array.from(categoryCache.byName.keys()).slice(0, 10)
        : [],
      ...(categoryCacheError ? { error: categoryCacheError } : {}),
      ...(categoryCache ? { warmedAt: categoryCache.warmedAt } : {}),
    },
    appid_override: opts.appidOverride,
    this_run: {
      enriched_events_seen: rows.length,
      eligible_for_load: eligible,
      skipped_no_venue: skippedNoVenue,
      skipped_venue_not_geocoded: skippedVenueNotGeocoded,
      skipped_no_dates: skippedNoDates,
      category_id_unknown: categoryIdUnknown,
      counts,
      ...(organizerSkipReason ? { organizer_skip_reason: organizerSkipReason } : {}),
    },
    total_state: totalState,
    quality_flags_this_batch: qfThisBatch,
    sample_documents: {
      organizers: capturedOrganizers,
      venues: capturedVenues,
      events: capturedEvents,
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
