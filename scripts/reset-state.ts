#!/usr/bin/env node --experimental-strip-types
// scripts/reset-state.ts — dev tool: reset niche enrich+load state.
//
// Use after schema changes or when re-testing a fresh enrich pass without
// re-fetching from source. Resets raw_events to 'pending', drops venues
// + quality_flags, optionally purges geocode cache.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, unlinkSync } from "node:fs";
import { PATHS } from "../core/types.ts";

const niche = process.argv[2];
if (!niche) {
  console.error("Usage: node scripts/reset-state.ts <niche-key> [--purge-cache]");
  process.exit(2);
}
const purgeCache = process.argv.includes("--purge-cache");

const db = new DatabaseSync(PATHS.nicheSqlite(niche));
db.exec("UPDATE raw_events SET status = 'pending', enriched_at = NULL, venue_id = NULL");
db.exec("DELETE FROM quality_flags");
db.exec("DELETE FROM venues");
db.exec("DELETE FROM events");

const pending = db.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE status = 'pending'").get() as { n: number };
console.log(`reset OK; raw_events.pending = ${pending.n}`);
db.close();

if (purgeCache) {
  const dir = PATHS.geocodeCacheDir(niche);
  let n = 0;
  try {
    for (const f of readdirSync(dir)) {
      unlinkSync(`${dir}/${f}`);
      n += 1;
    }
  } catch {}
  console.log(`purged ${n} geocode cache entries`);
}
