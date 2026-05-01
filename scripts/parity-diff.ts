#!/usr/bin/env node --experimental-strip-types
// scripts/parity-diff.ts — Harvey-vs-niche-harvest parity diff.
//
// Compares the Harvey-side parity surface (Harvey's unloaded queue +
// Porter's historical loaded baseline) against niche-harvest's TT_Test
// writes. Used as the gate for declaring "Harvey OFF" — when intersection
// covers the Harvey baseline minus carve-outs, we have parity.
//
// Inputs:
//   - Harvey JSON: ~/MyDocs/Collab/handoffs/harvey/dry-run-2026-05-01.json
//     (flat array of {site, title, start_dt, venue_name, lat, lng, ...})
//   - Porter JSON: ~/MyDocs/Collab/handoffs/porter/porter-baseline-mongo-2026-05-01.json
//     (envs.test.rows + envs.prod.rows; rows have title, startDate, venueName, lat, lng)
//   - niche-harvest live: queries MONGODB_URI_TEST events with
//     discoverySource='niche-harvest' and startDate >= now
//
// Natural-key matching (per Harvey 2026-04-19): (title-normalized,
// utc-day, lat-rounded, lng-rounded). 4-decimal lat/lng = ~10m precision,
// tolerant of geocoder noise.
//
// Output: JSON report to stdout (or --out=<path>) with intersection /
// harvey-only / narvest-only / carve-out counts + sample rows.
//
// Usage:
//   MONGODB_URI_TEST=<uri> ./scripts/parity-diff.ts \
//     [--harvey=<path>] [--porter=<path>] [--out=<path>]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { MongoClient } from "mongodb";

interface NaturalKey {
  title: string;       // normalized
  utcDay: string;      // YYYY-MM-DD
  latRounded: number;  // 4-decimal
  lngRounded: number;
}

interface ParityRow {
  source: "harvey" | "porter-test" | "porter-prod" | "narvest";
  title: string;
  startDate: string;   // ISO
  venueName: string;
  lat: number | null;
  lng: number | null;
  country?: string | null;
  // Provenance for debugging
  origin?: string;
}

function parseCli(argv: string[]): {
  harveyPath: string;
  porterPath: string;
  outPath: string | null;
} {
  const args = argv.slice(2);
  const collabRoot = join(homedir(), "MyDocs", "Collab");
  return {
    harveyPath: pickArg(args, "--harvey")
      ?? join(collabRoot, "handoffs", "harvey", "dry-run-2026-05-01.json"),
    porterPath: pickArg(args, "--porter")
      ?? join(collabRoot, "handoffs", "porter", "porter-baseline-mongo-2026-05-01.json"),
    outPath: pickArg(args, "--out"),
  };
}

function pickArg(args: string[], key: string): string | null {
  const prefix = `${key}=`;
  const m = args.find((a) => a.startsWith(prefix));
  return m ? m.slice(prefix.length) : null;
}

// ─── Natural-key normalization ───

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function utcDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toISOString().slice(0, 10);
}

function roundCoord(v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return NaN;
  return Math.round(v * 10000) / 10000;
}

function naturalKey(row: ParityRow): string {
  return [
    normalizeTitle(row.title),
    utcDay(row.startDate),
    roundCoord(row.lat),
    roundCoord(row.lng),
  ].join("|");
}

// ─── Loaders ───

function loadHarvey(path: string): ParityRow[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as Array<{
    site: string;
    title: string;
    start_dt: string;
    venue_name: string;
    lat: number | null;
    lng: number | null;
    country?: string;
  }>;
  return data.map((d) => ({
    source: "harvey" as const,
    title: d.title,
    startDate: d.start_dt,
    venueName: d.venue_name,
    lat: d.lat ?? null,
    lng: d.lng ?? null,
    country: d.country ?? null,
    origin: d.site,
  }));
}

function loadPorter(path: string): ParityRow[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    envs: {
      test?: { rows: Array<{ title: string; startDate: string; venueName: string; lat?: number | null; lng?: number | null; masteredCountryName?: string | null; discoverySource?: string }> };
      prod?: { rows: Array<{ title: string; startDate: string; venueName: string; lat?: number | null; lng?: number | null; masteredCountryName?: string | null; discoverySource?: string }> };
    };
  };
  const out: ParityRow[] = [];
  for (const [envKey, source] of [["test", "porter-test"], ["prod", "porter-prod"]] as const) {
    const env = data.envs?.[envKey];
    if (!env) continue;
    for (const r of env.rows) {
      out.push({
        source,
        title: r.title,
        startDate: r.startDate,
        venueName: r.venueName,
        lat: r.lat ?? null,
        lng: r.lng ?? null,
        country: r.masteredCountryName ?? null,
        origin: r.discoverySource,
      });
    }
  }
  return out;
}

async function loadNarvestFromMongo(uri: string): Promise<ParityRow[]> {
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const cursor = client.db().collection("events").find(
      {
        discoverySource: "niche-harvest",
        startDate: { $gte: new Date() },
      },
      {
        projection: {
          title: 1,
          startDate: 1,
          venueGeolocation: 1,
          masteredCountryName: 1,
          appId: 1,
        },
      },
    );
    const out: ParityRow[] = [];
    for await (const doc of cursor) {
      const coords = doc.venueGeolocation?.coordinates ?? [null, null];
      out.push({
        source: "narvest",
        title: doc.title ?? "",
        startDate: doc.startDate instanceof Date ? doc.startDate.toISOString() : String(doc.startDate ?? ""),
        venueName: "",
        lat: coords[1] ?? null,
        lng: coords[0] ?? null,
        country: doc.masteredCountryName ?? null,
        origin: `appId=${doc.appId}`,
      });
    }
    return out;
  } finally {
    await client.close();
  }
}

// ─── Diff computation ───

function diff(harvey: ParityRow[], porter: ParityRow[], narvest: ParityRow[]): {
  baseline_total: number;
  baseline_unique: number;
  narvest_total: number;
  intersection: number;
  baseline_only: number;
  narvest_only: number;
  carve_out_czechia: number;
  carve_out_null_country: number;
  intersection_pct: number;
  samples: {
    baseline_only: ParityRow[];
    narvest_only: ParityRow[];
  };
} {
  // Build baseline set (Harvey ∪ Porter), dedup'd by natural key
  const baselineMap = new Map<string, ParityRow>();
  for (const r of [...harvey, ...porter]) {
    if (r.lat === null || r.lng === null) continue; // can't natural-key without coords
    const k = naturalKey(r);
    if (!baselineMap.has(k)) baselineMap.set(k, r);
  }
  const narvestMap = new Map<string, ParityRow>();
  for (const r of narvest) {
    if (r.lat === null || r.lng === null) continue;
    const k = naturalKey(r);
    if (!narvestMap.has(k)) narvestMap.set(k, r);
  }

  let intersection = 0;
  const baselineOnly: ParityRow[] = [];
  const narvestOnly: ParityRow[] = [];
  for (const [k, r] of baselineMap) {
    if (narvestMap.has(k)) intersection += 1;
    else baselineOnly.push(r);
  }
  for (const [k, r] of narvestMap) {
    if (!baselineMap.has(k)) narvestOnly.push(r);
  }

  // Carve-outs (per Porter 2026-05-01 baseline notes)
  const czechia = baselineOnly.filter((r) => r.country === "Czechia").length;
  const nullCountry = baselineOnly.filter((r) => r.country === null).length;

  const baselineUnique = baselineMap.size;
  const intersectionPct = baselineUnique > 0
    ? Math.round((intersection / baselineUnique) * 100)
    : 0;

  return {
    baseline_total: harvey.length + porter.length,
    baseline_unique: baselineUnique,
    narvest_total: narvestMap.size,
    intersection,
    baseline_only: baselineOnly.length,
    narvest_only: narvestOnly.length,
    carve_out_czechia: czechia,
    carve_out_null_country: nullCountry,
    intersection_pct: intersectionPct,
    samples: {
      baseline_only: baselineOnly.slice(0, 5),
      narvest_only: narvestOnly.slice(0, 5),
    },
  };
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const uri = process.env.MONGODB_URI_TEST;
  if (!uri) {
    process.stderr.write("parity-diff: MONGODB_URI_TEST env var required\n");
    process.exit(2);
  }

  process.stderr.write(`Loading Harvey JSON: ${opts.harveyPath}\n`);
  const harvey = loadHarvey(opts.harveyPath);
  process.stderr.write(`  ${harvey.length} rows\n`);

  process.stderr.write(`Loading Porter JSON: ${opts.porterPath}\n`);
  const porter = loadPorter(opts.porterPath);
  process.stderr.write(`  ${porter.length} rows (test+prod combined)\n`);

  process.stderr.write(`Loading niche-harvest from MongoDB...\n`);
  const narvest = await loadNarvestFromMongo(uri);
  process.stderr.write(`  ${narvest.length} rows\n`);

  process.stderr.write(`Computing diff...\n`);
  const report = {
    generated_at: new Date().toISOString(),
    diff: diff(harvey, porter, narvest),
    notes: [
      "natural-key = (title-normalized, utc-day, lat@4dec, lng@4dec)",
      "Czechia events expected to be re-loaded after Harvey's prague country fix sandbox merges (Option A re-scrape)",
      "null masteredCountryName events are correct per Toby 2026-04-19 no-fallback rule (legitimate skips, not gaps)",
      "narvest_only > 0 expected during Phase 4 expansion (new feeds Harvey didn't cover)",
    ],
  };

  const json = JSON.stringify(report, null, 2);
  if (opts.outPath) {
    writeFileSync(opts.outPath, json + "\n");
    process.stderr.write(`Report written: ${opts.outPath}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
  process.stderr.write("Summary:\n");
  process.stderr.write(`  baseline_unique: ${report.diff.baseline_unique}\n`);
  process.stderr.write(`  intersection: ${report.diff.intersection} (${report.diff.intersection_pct}%)\n`);
  process.stderr.write(`  baseline_only: ${report.diff.baseline_only} (czechia=${report.diff.carve_out_czechia}, null_country=${report.diff.carve_out_null_country})\n`);
  process.stderr.write(`  narvest_only: ${report.diff.narvest_only} (Phase 4 expansion)\n`);
}

await main();
