#!/usr/bin/env node
// scripts/copy-tt-test-to-playground.ts — one-off seed of playground DB.
//
// Authority: Fulton 2026-04-27 wrote the original; adapted to use
// niche-harvest's existing env-var names (MONGODB_URI_TEST +
// MONGODB_URI_PLAYGROUND) instead of SOURCE_URI/DEST_URI so it fits
// the existing permission rules.
//
// Scope (per Toby + Fulton):
// - events filtered to startDate in [2026-01-01, 2027-01-01) UTC
// - venues + organizers reachable from those events (referenced _ids only)
// - categories + 4x mastered_* collections in FULL (small dimensional;
//   drives FE rendering checks)
// - deleteMany before insertMany per collection → idempotent re-runs
//
// Usage:
//   MONGODB_URI_TEST="<TT_Test URI>" \
//   MONGODB_URI_PLAYGROUND="<playground URI>" \
//   node --experimental-strip-types scripts/copy-tt-test-to-playground.ts
//   # → DRY-RUN (counts only)
//
//   <env vars> ... --apply
//   # → actually writes to playground
//
// Safety: DRY-RUN by default. --apply explicit. Operator must set BOTH
// env vars (which require per-secret auth from Toby). Both URIs read
// from env; never hardcoded; never committed.

import { MongoClient, ObjectId } from "mongodb";

const APPLY = process.argv.includes("--apply");
const DEST_DB_NAME = process.env.DEST_DB || "niche_harvest_playground";

const sourceUri = process.env.MONGODB_URI_TEST;
const destUri = process.env.MONGODB_URI_PLAYGROUND;
if (!sourceUri || !destUri) {
  console.error(
    "Set MONGODB_URI_TEST and MONGODB_URI_PLAYGROUND env vars. " +
      "Per Toby per-secret auth: export only when authorized.",
  );
  process.exit(2);
}

interface DocWithId { _id: ObjectId | string; [k: string]: unknown }

const src = new MongoClient(sourceUri);
const dest = new MongoClient(destUri);

await src.connect();
await dest.connect();
const sdb = src.db();
const ddb = dest.db(DEST_DB_NAME);

const yearStart = new Date("2026-01-01T00:00:00Z");
const yearEnd = new Date("2027-01-01T00:00:00Z");

const events = (await sdb
  .collection("events")
  .find({ startDate: { $gte: yearStart, $lt: yearEnd } })
  .toArray()) as DocWithId[];

const venueIds = [
  ...new Set(
    events
      .map((e) => e.venueID)
      .filter(Boolean)
      .map((id) => String(id)),
  ),
];
const organizerIds = [
  ...new Set(
    events
      .flatMap((e) => [e.ownerOrganizerID, e.authorOrganizerID])
      .filter(Boolean)
      .map((id) => String(id)),
  ),
];

const venues = venueIds.length
  ? ((await sdb
      .collection("venues")
      .find({ _id: { $in: venueIds.map((id) => new ObjectId(id)) } })
      .toArray()) as DocWithId[])
  : [];
const organizers = organizerIds.length
  ? ((await sdb
      .collection("organizers")
      .find({ _id: { $in: organizerIds.map((id) => new ObjectId(id)) } })
      .toArray()) as DocWithId[])
  : [];
const categories = (await sdb.collection("categories").find({}).toArray()) as DocWithId[];
const masteredcountries = (await sdb.collection("masteredcountries").find({}).toArray()) as DocWithId[];
const mastereddivisions = (await sdb.collection("mastereddivisions").find({}).toArray()) as DocWithId[];
const masteredregions = (await sdb.collection("masteredregions").find({}).toArray()) as DocWithId[];
const masteredcities = (await sdb.collection("masteredcities").find({}).toArray()) as DocWithId[];

console.log("=== SOURCE COUNTS (TT_Test, 2026 scope) ===");
console.log("events:                                  ", events.length);
console.log("venues (referenced by events):           ", venues.length);
console.log("organizers (referenced by events):       ", organizers.length);
console.log("categories (full):                       ", categories.length);
console.log("masteredcountries (full):                ", masteredcountries.length);
console.log("mastereddivisions (full):                ", mastereddivisions.length);
console.log("masteredregions (full):                  ", masteredregions.length);
console.log("masteredcities (full):                   ", masteredcities.length);
console.log(
  "TOTAL docs to copy:                      ",
  events.length +
    venues.length +
    organizers.length +
    categories.length +
    masteredcountries.length +
    mastereddivisions.length +
    masteredregions.length +
    masteredcities.length,
);

if (!APPLY) {
  console.log("\nDRY-RUN. Re-run with --apply to write to " + DEST_DB_NAME);
  await src.close();
  await dest.close();
  process.exit(0);
}

for (const [name, docs] of [
  ["categories", categories],
  ["masteredcountries", masteredcountries],
  ["mastereddivisions", mastereddivisions],
  ["masteredregions", masteredregions],
  ["masteredcities", masteredcities],
  ["venues", venues],
  ["organizers", organizers],
  ["events", events],
] as [string, DocWithId[]][]) {
  if (!docs.length) {
    console.log(`${name}: 0 docs, skipping`);
    continue;
  }
  await ddb.collection(name).deleteMany({});
  const result = await ddb.collection(name).insertMany(docs, { ordered: false });
  console.log(`${name}: inserted ${result.insertedCount}`);
}

await src.close();
await dest.close();
console.log("Done — playground DB '" + DEST_DB_NAME + "' seeded from TT_Test 2026 subset.");
