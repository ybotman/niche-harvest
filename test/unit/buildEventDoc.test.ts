// test/unit/buildEventDoc.test.ts — denorm bundle assembly per LOADER-CONTRACT §6.
// Run: node --experimental-strip-types --test test/unit/buildEventDoc.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEventDoc, stubMasteredChain, type EnrichedRow, type VenueRow } from "../../core/loader/denorm.ts";
import type { ClassifyResult } from "../../core/classify.ts";
import type { NicheConfig } from "../../core/types.ts";

// ─── Test fixture niche ───
const tangoNiche: NicheConfig = {
  niche: { key: "tango", display_name: "Tango", appid: 1, language_default: "en" },
  persona: { runtime_name: "narvest-tango", runtime_port: 8814 },
  taxonomy: {
    identity_check: { require_min_signals: 1, positive_keywords: ["tango"], negative_keywords: [] },
    categories: [
      { name: "Milonga", duration_group: "SHORT", loadable: true, travel_worthy_eligible: false, beginner_eligible: false },
      { name: "Practica", duration_group: "SHORT", loadable: true, travel_worthy_eligible: false, beginner_eligible: false },
      { name: "Class", duration_group: "SHORT", loadable: false, travel_worthy_eligible: false, beginner_eligible: true },
      { name: "Workshop", duration_group: "LONG", loadable: true, travel_worthy_eligible: true, beginner_eligible: true },
      { name: "Festival", duration_group: "LONG", loadable: true, travel_worthy_eligible: true, beginner_eligible: false },
    ],
    rendered_attributes: [],
    internal_only_attributes: [],
  },
  geocode: { trusted_country_codes: ["US"], reject_country_codes: [], text_distance_bound_km: 50 },
  loader: { load_classes: false, discovery_source: "niche-harvest", trust_level: "ai_discovered", mongo_env: "test", batch_size: 10 },
  sources: { ical_feeds: [], web_pages: [], facebook_groups: [] },
};

const venue: VenueRow = {
  id: 1, name: "Test Studio", address: "123 Main", city: "Salt Lake City",
  state: "UT", country: "US", lat: 40.7, lng: -111.9,
};

const baseClassify = (categoryFirst: string): ClassifyResult => ({
  category_first: categoryFirst,
  category_second: null,
  category_third: null,
  skip_reason: null,
  trace: [],
  duration_hours: 2,
  duration_violation: null,
});

const enrichedRow = (overrides: Partial<EnrichedRow> = {}): EnrichedRow => ({
  id: 1,
  source_id: 1,
  raw_title: "Friday Milonga",
  raw_description: null,
  raw_organizer_text: null,
  raw_url: null,
  start_dt_iso: "2026-05-29T20:00:00",
  end_dt_iso: "2026-05-29T22:00:00",
  source_rrule: null,
  classify: baseClassify("Milonga"),
  ...overrides,
});

const baseInputs = {
  enriched: enrichedRow(),
  venue,
  niche: tangoNiche,
  venueChain: stubMasteredChain(),
  venueId: "dryrun-venue-1" as string,
  ownerOrganizerID: null,
  categoryFirstId: null,
  discoveryBatchId: "nh-tango-test-batch-id",
};

// ─────────────────────────────────────────────────────────────────────
// Hard minimums per §5.1
// ─────────────────────────────────────────────────────────────────────

test("buildEventDoc — appId/title/start/end always populated as UTC Dates", () => {
  const d = buildEventDoc(baseInputs);
  assert.equal(d.appId, "1");
  assert.equal(d.title, "Friday Milonga");
  // start_dt_iso "2026-05-29T20:00:00" lacks Z → toUtcDate forces UTC interpretation
  assert.ok(d.startDate instanceof Date);
  assert.equal(d.startDate.toISOString(), "2026-05-29T20:00:00.000Z");
  assert.equal(d.endDate.toISOString(), "2026-05-29T22:00:00.000Z");
});

test("buildEventDoc — niche appid override propagates", () => {
  const niche99: NicheConfig = { ...tangoNiche, niche: { ...tangoNiche.niche, appid: 99 } };
  const d = buildEventDoc({ ...baseInputs, niche: niche99 });
  assert.equal(d.appId, "99");
});

// ─────────────────────────────────────────────────────────────────────
// Loader-set fields per §5.6
// ─────────────────────────────────────────────────────────────────────

test("buildEventDoc — isDiscovered + discoverySource + trustLevel + enrichmentStatus", () => {
  const d = buildEventDoc(baseInputs);
  assert.equal(d.isDiscovered, true);
  assert.equal(d.discoverySource, "niche-harvest");
  assert.equal(d.trustLevel, "ai_discovered");
  assert.equal(d.enrichmentStatus, "complete");
});

test("buildEventDoc — GUARDRAILS H11: discoveryBatchId propagates through to event doc", () => {
  // Critical for rollback; without this the doc isn't roll-back-able.
  const d = buildEventDoc({ ...baseInputs, discoveryBatchId: "nh-tango-rollback-test" });
  assert.equal(d.discoveryBatchId, "nh-tango-rollback-test");
});

// ─────────────────────────────────────────────────────────────────────
// authorOrganizerID = ownerOrganizerID (LOADER-CONTRACT §6.2)
// ─────────────────────────────────────────────────────────────────────

test("buildEventDoc — authorOrganizerID equals ownerOrganizerID (explicit copy per §6.2)", () => {
  const d = buildEventDoc({ ...baseInputs, ownerOrganizerID: "org-abc" });
  assert.equal(d.ownerOrganizerID, "org-abc");
  assert.equal(d.authorOrganizerID, "org-abc");
});

test("buildEventDoc — both null when no organizer", () => {
  const d = buildEventDoc(baseInputs);
  assert.equal(d.ownerOrganizerID, null);
  assert.equal(d.authorOrganizerID, null);
});

// ─────────────────────────────────────────────────────────────────────
// Override fields (LOADER-CONTRACT §6.3 + §9): base + Override match
// ─────────────────────────────────────────────────────────────────────

test("buildEventDoc — Festival is travel_worthy + override matches", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: enrichedRow({ classify: baseClassify("Festival") }),
  });
  assert.equal(d.travelWorthy, true);
  assert.equal(d.travelWorthyOverride, true);
});

test("buildEventDoc — Milonga is NOT travel_worthy + override matches", () => {
  const d = buildEventDoc(baseInputs);
  assert.equal(d.travelWorthy, false);
  assert.equal(d.travelWorthyOverride, false);
});

test("buildEventDoc — beginner_friendly + for_beginners pair-set; default false", () => {
  const d = buildEventDoc(baseInputs);
  assert.equal(d.beginnerFriendly, false);
  assert.equal(d.beginnerFriendlyOverride, false);
  assert.equal(d.forBeginners, false);
  assert.equal(d.forBeginnersOverride, false);
});

test("buildEventDoc — Workshop with 'absolute beginner' (singular per LOADER §7.6) → forBeginners true", () => {
  // Note: LOADER-CONTRACT §7.6 stage 1 explicit list is SINGULAR forms
  // (absolute beginner, newcomer, intro, level 1, from scratch). Plural
  // "beginners" doesn't match — that's a spec gap to coordinate with
  // Sarah, NOT a quiet classifier extension.
  const d = buildEventDoc({
    ...baseInputs,
    enriched: enrichedRow({
      raw_title: "Workshop for absolute beginner level",
      classify: baseClassify("Workshop"),
    }),
  });
  assert.equal(d.forBeginners, true);
  assert.equal(d.forBeginnersOverride, true);
  assert.equal(d.beginnerFriendly, true);
  assert.equal(d.beginnerFriendlyOverride, true);
});

test("buildEventDoc — Workshop with 'all-levels' → beginnerFriendly true (stage 2 §7.6)", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: enrichedRow({
      raw_title: "All-levels Tango Workshop",
      classify: baseClassify("Workshop"),
    }),
  });
  assert.equal(d.beginnerFriendly, true);
  // Stage 2 friendly-only doesn't necessarily set forBeginners (per §7.6)
});

// ─────────────────────────────────────────────────────────────────────
// Anti-recurrence guard (LOADER-CONTRACT §10.4)
// ─────────────────────────────────────────────────────────────────────

test("buildEventDoc — LONG event with RRULE → isRepeating false", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: enrichedRow({
      classify: baseClassify("Festival"),
      source_rrule: "FREQ=YEARLY",
    }),
  });
  assert.equal(d.isRepeating, false);
  assert.equal(d.recurrenceRule, null);
});

test("buildEventDoc — SHORT event with RRULE → isRepeating true; rrule preserved", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: enrichedRow({ source_rrule: "FREQ=WEEKLY;BYDAY=FR" }),
  });
  assert.equal(d.isRepeating, true);
  assert.equal(d.recurrenceRule, "FREQ=WEEKLY;BYDAY=FR");
});

test("buildEventDoc — no source_rrule → isRepeating false", () => {
  const d = buildEventDoc(baseInputs);
  assert.equal(d.isRepeating, false);
  assert.equal(d.recurrenceRule, null);
});

// ─────────────────────────────────────────────────────────────────────
// Mastered chain pass-through from venueChain
// ─────────────────────────────────────────────────────────────────────

test("buildEventDoc — TODO:automaster sentinels pass through from stub chain", () => {
  const d = buildEventDoc(baseInputs);
  assert.equal(d.venueTimezone, "TODO:automaster");
  assert.equal(d.masteredCityId, "TODO:automaster");
  assert.equal(d.masteredCountryName, "TODO:automaster");
});

test("buildEventDoc — real chain values pass through (live mode)", () => {
  const d = buildEventDoc({
    ...baseInputs,
    venueChain: {
      timezone: "America/Denver",
      geolocation: { type: "Point", coordinates: [-111.9, 40.7] },
      masteredCityId: "city-1", masteredCityName: "Salt Lake City",
      masteredDivisionId: null, masteredDivisionName: null,
      masteredRegionId: "region-1", masteredRegionName: "Mountain",
      masteredCountryId: "country-1", masteredCountryName: "United States",
    },
  });
  assert.equal(d.venueTimezone, "America/Denver");
  assert.equal(d.venueCityName, "Salt Lake City");
  assert.deepEqual(d.venueGeolocation, { type: "Point", coordinates: [-111.9, 40.7] });
  assert.equal(d.masteredRegionName, "Mountain");
});

// ─────────────────────────────────────────────────────────────────────
// shortTitle (LOADER-CONTRACT §5.6 ≤40 chars)
// ─────────────────────────────────────────────────────────────────────

test("buildEventDoc — short title preserved when ≤40 chars", () => {
  const d = buildEventDoc(baseInputs);
  assert.equal(d.shortTitle, "Friday Milonga");
});

test("buildEventDoc — long title truncated at delimiter (em-dash)", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: enrichedRow({
      raw_title: "Spring Festival 2026 — featuring three orchestras and twelve DJs from around the world",
    }),
  });
  // Splits at " — "
  assert.equal(d.shortTitle, "Spring Festival 2026");
});

test("buildEventDoc — long title with no delimiter truncated at 37 + '...'", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: enrichedRow({
      raw_title: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 49 As
    }),
  });
  assert.ok(d.shortTitle!.endsWith("..."));
  assert.ok(d.shortTitle!.length <= 40);
});

// ─────────────────────────────────────────────────────────────────────
// Description pass-through
// ─────────────────────────────────────────────────────────────────────

test("buildEventDoc — description passes through when present", () => {
  const d = buildEventDoc({
    ...baseInputs,
    enriched: enrichedRow({ raw_description: "Join us for a great milonga" }),
  });
  assert.equal(d.description, "Join us for a great milonga");
});

test("buildEventDoc — description omitted when null (not 'undefined' string)", () => {
  const d = buildEventDoc(baseInputs);
  assert.equal("description" in d, false);
});
