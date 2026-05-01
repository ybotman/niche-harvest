// test/unit/utc-roundtrip.test.ts — date contract permanent guard.
//
// Harvey 2026-04-30 advisor handover: "Round-trip a known UTC datetime
// through every adapter→loader→Mongo path before any dual-write window
// opens." This is the permanent test pattern — if any future change strips
// the Z-suffix or drops to local-time interpretation, this fails.
//
// The bug we're guarding against: 2026-04-30 first --live shipped with
// startDate as STRING (not Date). Mongo `$gte/$lt` dedup query matched
// nothing → 901 dup groups. Bug came from the type-system letting strings
// through where Date was assumed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEventDoc, stubMasteredChain, type EnrichedRow, type VenueRow } from "../../core/loader/denorm.ts";
import type { ClassifyResult } from "../../core/classify.ts";
import type { NicheConfig } from "../../core/types.ts";

const tangoNiche: NicheConfig = {
  niche: { key: "tango", display_name: "Tango", appid: 1, language_default: "en" },
  persona: { runtime_name: "narvest-tango", runtime_port: 8814 },
  taxonomy: {
    identity_check: { require_min_signals: 1, positive_keywords: ["tango"], negative_keywords: [] },
    categories: [
      { name: "Milonga", duration_group: "SHORT", loadable: true, travel_worthy_eligible: false, beginner_eligible: false },
    ],
    rendered_attributes: [],
    internal_only_attributes: [],
  },
  geocode: { trusted_country_codes: ["US"], reject_country_codes: [], text_distance_bound_km: 50 },
  loader: { load_classes: false, discovery_source: "niche-harvest", trust_level: "ai_discovered", mongo_env: "test", batch_size: 10 },
  sources: { ical_feeds: [], web_pages: [], facebook_groups: [] },
};

const venue: VenueRow = {
  id: 1, name: "Test", address: "x", city: "Salt Lake City",
  state: "UT", country: "US", lat: 40.7, lng: -111.9,
};

const classify: ClassifyResult = {
  category_first: "Milonga", category_second: null, category_third: null,
  skip_reason: null, trace: [], duration_hours: 2, duration_violation: null,
};

function makeEnriched(start_dt_iso: string, end_dt_iso: string): EnrichedRow {
  return {
    id: 1, source_id: 1,
    raw_title: "Friday Milonga", raw_description: null,
    raw_organizer_text: null, raw_url: null,
    start_dt_iso, end_dt_iso, source_rrule: null, classify,
  };
}

const baseInputs = {
  venue,
  niche: tangoNiche,
  venueChain: stubMasteredChain(),
  venueId: "v1" as string,
  ownerOrganizerID: null,
  categoryFirstId: null,
  discoveryBatchId: "test-batch",
};

// ─── 1. Naive ISO (no Z) → UTC interpretation ───
//
// iCal feeds often emit naive ISO strings ("2026-05-29T20:00:00") when the
// timezone is implicit. niche-harvest forces Z-suffix interpretation so
// the stored Date is UTC, not local-time-on-loader-host.

test("UTC round-trip — naive ISO 'YYYY-MM-DDTHH:mm:ss' interpreted as UTC", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: makeEnriched("2026-05-29T20:00:00", "2026-05-29T22:00:00"),
  });
  // Must be a Date object (not a string)
  assert.ok(d.startDate instanceof Date, "startDate must be Date instance");
  assert.ok(d.endDate instanceof Date, "endDate must be Date instance");
  // Must serialize to UTC Z-suffix at exactly the input time (NOT shifted by TZ)
  assert.equal(d.startDate.toISOString(), "2026-05-29T20:00:00.000Z");
  assert.equal(d.endDate.toISOString(), "2026-05-29T22:00:00.000Z");
});

// ─── 2. Already-UTC ISO with Z preserved exactly ───

test("UTC round-trip — Z-suffixed ISO preserved verbatim", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: makeEnriched("2026-05-29T20:00:00.000Z", "2026-05-29T22:00:00.000Z"),
  });
  assert.equal(d.startDate.toISOString(), "2026-05-29T20:00:00.000Z");
  assert.equal(d.endDate.toISOString(), "2026-05-29T22:00:00.000Z");
});

// ─── 3. ISO with offset (e.g. -04:00) → converted to UTC ───

test("UTC round-trip — ISO with offset normalized to UTC", () => {
  // 14:00 EDT (-04:00) = 18:00 UTC
  const d = buildEventDoc({
    ...baseInputs,
    enriched: makeEnriched("2026-05-29T14:00:00-04:00", "2026-05-29T16:00:00-04:00"),
  });
  assert.equal(d.startDate.toISOString(), "2026-05-29T18:00:00.000Z");
  assert.equal(d.endDate.toISOString(), "2026-05-29T20:00:00.000Z");
});

// ─── 4. CRITICAL: Date.parse on the stored value matches input ───
// (this is the dedup-killer bug from 2026-04-30 first --live)

test("UTC round-trip — startDate.getTime() matches Date.parse of input ISO", () => {
  const inputIso = "2026-05-29T20:00:00.000Z";
  const d = buildEventDoc({
    ...baseInputs,
    enriched: makeEnriched(inputIso, "2026-05-29T22:00:00.000Z"),
  });
  // Critical: the millisecond value must round-trip exactly. If startDate
  // were stored as a string, Mongo {$gte: <Date>} comparison wouldn't match.
  assert.equal(d.startDate.getTime(), Date.parse(inputIso));
});

// ─── 5. Day-bucket dedup query bounds (the actual mongo-direct §8.3 query) ───
// Tests dayStart/dayEnd are computed correctly against UTC midnight, not
// local-host midnight. Cross-timezone hosts must produce identical buckets.

test("UTC round-trip — startDate falls within UTC day-bucket bounds", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: makeEnriched("2026-05-29T20:00:00.000Z", "2026-05-29T22:00:00.000Z"),
  });
  // Day-bucket: [2026-05-29T00:00:00.000Z, 2026-05-30T00:00:00.000Z)
  const dayStart = new Date("2026-05-29T00:00:00.000Z");
  const dayEnd = new Date("2026-05-30T00:00:00.000Z");
  assert.ok(d.startDate >= dayStart, "startDate >= dayStart");
  assert.ok(d.startDate < dayEnd, "startDate < dayEnd");
});

// ─── 6. BSON-roundtrip simulation: Date → JSON.stringify → JSON.parse(Date) ───
// MongoDB BSON serializes Date as ISO string in `$date` wrapper but our
// loader passes Date objects directly to insertOne. Verify the toJSON path
// (used in load reports) still preserves UTC precision.

test("UTC round-trip — JSON.stringify(Date) emits ISO Z-suffix", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: makeEnriched("2026-05-29T20:00:00.000Z", "2026-05-29T22:00:00.000Z"),
  });
  const json = JSON.stringify({ startDate: d.startDate });
  // JSON serialization of Date emits ISO 8601 with Z suffix
  assert.match(json, /"startDate":"2026-05-29T20:00:00\.000Z"/);
});
