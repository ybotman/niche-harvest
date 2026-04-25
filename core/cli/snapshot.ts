#!/usr/bin/env node --experimental-strip-types
// core/cli/snapshot.ts — first runnable end-to-end command.
//
// Loads niches/<key>/niche.yaml, fetches every iCal feed (Phase 1 scope:
// iCal only), upserts raw events into SQLite with fingerprint dedup, emits
// a JSON snapshot to data/<key>/snapshots/<YYYY-MM-DD>.json.
//
// No geocoding, no classification, no Mongo — Phase 1 backbone gate per
// PLAN.md §6: "snapshot has 100% events_found accounted for, byte-stable
// re-run, clean Day-2 diff." Geocoder + classifier wire in next.
//
// Usage:
//   bash run.sh --niche=tango snapshot
//   bash run.sh --niche=tango snapshot --dry-run

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadNiche, NicheConfigError } from "../config.ts";
import { createLogger } from "../logger.ts";
import {
  openStore,
  upsertSource,
  insertRawEvent,
  countRawEventsForSource,
  runStartLog,
  runEndLog,
  updateSourceAfterFetch,
} from "../store.ts";
import { fingerprintRawEvent } from "../fingerprint.ts";
import { getAdapter } from "../adapters/registry.ts";
import { PATHS } from "../types.ts";
import type { RawEvent, RawEventBatch, SourceConfig } from "../types.ts";

interface CliOpts {
  niche: string;
  dryRun: boolean;
  /** When set, only fetch this single source name (filters niche.yaml inventory). */
  sourceFilter: string | null;
}

function parseCli(argv: string[]): CliOpts {
  const args = argv.slice(2);
  const niche = pickArg(args, "--niche");
  if (!niche) {
    fail("Missing --niche=<key>. Example: --niche=tango");
  }
  return {
    niche,
    dryRun: args.includes("--dry-run"),
    sourceFilter: pickArg(args, "--source"),
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
  process.stderr.write(`snapshot: ${msg}\n`);
  process.exit(2);
}

interface SourceSnapshot {
  source_name: string;
  adapter: string;
  fetched_at: string;
  found: number;
  new_in_db: number;
  duplicates_skipped: number;
  errors: string[];
  events: RawEvent[];
}

interface CycleSnapshot {
  niche: string;
  appid: number;
  generated_at: string;
  dry_run: boolean;
  totals: {
    sources_processed: number;
    events_found: number;
    events_new: number;
    events_duplicate: number;
    sources_with_errors: number;
  };
  sources: SourceSnapshot[];
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const log = createLogger("snapshot", { niche: opts.niche });

  // ─── Load + validate niche.yaml ───
  let niche;
  try {
    niche = loadNiche(opts.niche);
  } catch (err) {
    if (err instanceof NicheConfigError) fail(err.message);
    throw err;
  }
  log.info("niche loaded", {
    appid: niche.niche.appid,
    persona: niche.persona.runtime_name,
    runtime_port: niche.persona.runtime_port,
  });

  // ─── Open store + upsert sources ───
  const db = openStore(opts.niche);
  const allSources: SourceConfig[] = [
    ...niche.sources.ical_feeds,
    ...niche.sources.web_pages,
    ...niche.sources.facebook_groups,
  ];

  const phase1AdapterAllowlist = new Set(["ical"]);
  const inScope = allSources
    .filter((s) => phase1AdapterAllowlist.has(s.adapter))
    .filter((s) => (opts.sourceFilter ? s.name === opts.sourceFilter : true));

  log.info("phase 1 scope", {
    total_sources: allSources.length,
    phase1_in_scope: inScope.length,
    deferred_to_phase5_6: allSources.length - inScope.length,
    source_filter: opts.sourceFilter,
  });

  if (inScope.length === 0) {
    fail("No sources match phase-1 adapter allowlist (ical) for this niche.");
  }

  const cycleSnapshot: CycleSnapshot = {
    niche: opts.niche,
    appid: niche.niche.appid,
    generated_at: new Date().toISOString(),
    dry_run: opts.dryRun,
    totals: {
      sources_processed: 0,
      events_found: 0,
      events_new: 0,
      events_duplicate: 0,
      sources_with_errors: 0,
    },
    sources: [],
  };

  // ─── Fetch each in-scope source ───
  for (const source of inScope) {
    const sourceRowId = upsertSource(db, source);
    const adapter = getAdapter(source.adapter);
    const runId = runStartLog(db, "snapshot", sourceRowId);

    let batch: RawEventBatch;
    try {
      batch = await adapter.fetch(source, niche, {
        logger: log,
        dryRun: opts.dryRun,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("adapter threw", { source_id: source.name, error: message });
      runEndLog(db, runId, {
        items_processed: 0, items_new: 0, items_skipped: 0, items_errored: 1,
        notes: `adapter threw: ${message}`,
      });
      updateSourceAfterFetch(db, sourceRowId, { eventsFound: 0, error: message });
      cycleSnapshot.totals.sources_with_errors += 1;
      cycleSnapshot.sources.push({
        source_name: source.name,
        adapter: source.adapter,
        fetched_at: new Date().toISOString(),
        found: 0, new_in_db: 0, duplicates_skipped: 0,
        errors: [message],
        events: [],
      });
      continue;
    }

    // ─── Insert into SQLite (idempotent via fingerprint) ───
    let newInDb = 0;
    let dupes = 0;
    if (!opts.dryRun) {
      for (const ev of batch.events) {
        const fp = fingerprintRawEvent({
          sourceName: source.name,
          sourceEventId: ev.source_event_id,
        });
        const inserted = insertRawEvent(db, sourceRowId, {
          fingerprint: fp,
          raw_title: ev.raw_title,
          ...(ev.raw_date_text !== undefined ? { raw_date_text: ev.raw_date_text } : {}),
          ...(ev.raw_location_text !== undefined ? { raw_location_text: ev.raw_location_text } : {}),
          ...(ev.raw_description !== undefined ? { raw_description: ev.raw_description } : {}),
          ...(ev.raw_organizer_text !== undefined ? { raw_organizer_text: ev.raw_organizer_text } : {}),
          ...(ev.raw_url !== undefined ? { raw_url: ev.raw_url } : {}),
          ...(ev.raw_json !== undefined ? { raw_json: ev.raw_json } : {}),
        });
        if (inserted) newInDb += 1;
        else dupes += 1;
      }
    }

    runEndLog(db, runId, {
      items_processed: batch.events.length,
      items_new: newInDb,
      items_skipped: dupes,
      items_errored: batch.errors.length,
      ...(opts.dryRun ? { notes: "dry-run; no DB writes" } : {}),
    });
    updateSourceAfterFetch(db, sourceRowId, {
      eventsFound: batch.events.length,
    });

    cycleSnapshot.totals.sources_processed += 1;
    cycleSnapshot.totals.events_found += batch.events.length;
    cycleSnapshot.totals.events_new += newInDb;
    cycleSnapshot.totals.events_duplicate += dupes;
    if (batch.errors.length > 0) cycleSnapshot.totals.sources_with_errors += 1;

    const totalInDb = countRawEventsForSource(db, sourceRowId);
    log.info("source done", {
      source_id: source.name,
      found: batch.events.length,
      new_in_db: newInDb,
      dupes_skipped: dupes,
      total_in_db: totalInDb,
    });

    cycleSnapshot.sources.push({
      source_name: source.name,
      adapter: source.adapter,
      fetched_at: batch.fetchedAt,
      found: batch.events.length,
      new_in_db: newInDb,
      duplicates_skipped: dupes,
      errors: batch.errors.map((e) => e.message),
      events: batch.events,
    });
  }

  // ─── Emit JSON snapshot ───
  const today = new Date().toISOString().slice(0, 10);
  const snapDir = PATHS.snapshotsDir(opts.niche);
  mkdirSync(snapDir, { recursive: true });
  const snapPath = join(snapDir, `${today}.json`);
  writeFileSync(snapPath, JSON.stringify(cycleSnapshot, null, 2) + "\n");

  log.info("snapshot written", {
    path: snapPath,
    sources: cycleSnapshot.totals.sources_processed,
    events_found: cycleSnapshot.totals.events_found,
    events_new: cycleSnapshot.totals.events_new,
    events_duplicate: cycleSnapshot.totals.events_duplicate,
    errors: cycleSnapshot.totals.sources_with_errors,
  });

  db.close();
}

await main();
