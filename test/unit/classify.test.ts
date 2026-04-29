// test/unit/classify.test.ts — pure-function tests for classifier.
// Run: node --experimental-strip-types --test test/unit/classify.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { classify, identityCheck } from "../../core/classify.ts";
import type { NicheConfig, RawEvent } from "../../core/types.ts";

// ─── Minimal niche config sufficient for classifier tests ───
const tangoNiche: NicheConfig = {
  niche: { key: "tango", display_name: "Tango", appid: 1, language_default: "en" },
  persona: { runtime_name: "narvest-tango", runtime_port: 8814 },
  taxonomy: {
    identity_check: {
      require_min_signals: 1,
      positive_keywords: ["tango", "milonga", "practica", "bandoneon", "encuentro"],
      negative_keywords: ["yoga tango", "ballroom tango"],
    },
    categories: [
      { name: "Milonga", duration_group: "SHORT", loadable: true, travel_worthy_eligible: false, beginner_eligible: false },
      { name: "Practica", duration_group: "SHORT", loadable: true, travel_worthy_eligible: false, beginner_eligible: false },
      { name: "Class", duration_group: "SHORT", loadable: false, travel_worthy_eligible: false, beginner_eligible: true },
      { name: "Festival", duration_group: "LONG", loadable: true, travel_worthy_eligible: true, beginner_eligible: false },
      { name: "Marathon", duration_group: "LONG", loadable: true, travel_worthy_eligible: true, beginner_eligible: false },
      { name: "Encuentro", duration_group: "LONG", loadable: true, travel_worthy_eligible: true, beginner_eligible: false },
      { name: "Workshop", duration_group: "LONG", loadable: true, travel_worthy_eligible: true, beginner_eligible: true },
      { name: "Trip", duration_group: "NEUTRAL", loadable: false, travel_worthy_eligible: false, beginner_eligible: false },
      { name: "Performance", duration_group: "NEUTRAL", loadable: false, travel_worthy_eligible: false, beginner_eligible: false },
      { name: "Unknown", duration_group: "NEUTRAL", loadable: false, travel_worthy_eligible: false, beginner_eligible: false },
    ],
    rendered_attributes: [],
    internal_only_attributes: [],
  },
  geocode: { trusted_country_codes: ["US"], reject_country_codes: [], text_distance_bound_km: 50 },
  loader: { load_classes: false, discovery_source: "niche-harvest", trust_level: "ai_discovered", mongo_env: "test", batch_size: 10 },
  sources: { ical_feeds: [], web_pages: [], facebook_groups: [] },
};

const ev = (raw_title: string, extras: Partial<RawEvent> = {}): RawEvent => ({
  source_event_id: "test-1",
  raw_title,
  ...extras,
});

// ─────────────────────────────────────────────────────────────────────
// identityCheck
// ─────────────────────────────────────────────────────────────────────

test("identityCheck — passes with positive keyword", () => {
  const r = identityCheck(ev("Friday Night Milonga"), tangoNiche);
  assert.equal(r.passed, true);
  assert.ok(r.positive_signals >= 1);
});

test("identityCheck — fails with no positive keyword", () => {
  const r = identityCheck(ev("Salsa Night"), tangoNiche);
  assert.equal(r.passed, false);
  assert.match(r.reason ?? "", /insufficient_positive_signals/);
});

test("identityCheck — negative keyword overrides positives", () => {
  const r = identityCheck(ev("Yoga Tango Fitness Saturday"), tangoNiche);
  assert.equal(r.passed, false);
  assert.match(r.reason ?? "", /negative_keyword_match/);
  assert.deepEqual(r.negative_hits, ["yoga tango"]);
});

test("identityCheck — searches description + location too, not just title", () => {
  const r = identityCheck(
    ev("Open Practice", { raw_description: "tango practice for all" }),
    tangoNiche,
  );
  assert.equal(r.passed, true);
});

// ─────────────────────────────────────────────────────────────────────
// classify — category precedence + skip_reason
// ─────────────────────────────────────────────────────────────────────

test("classify — Milonga loadable", () => {
  const c = classify(ev("Friday Night Milonga at La Glorieta"), tangoNiche);
  assert.equal(c.category_first, "Milonga");
  assert.equal(c.skip_reason, null);
});

test("classify — LONG wins over SHORT in same text (precedence §7.4)", () => {
  // "Milonga" + "Festival" both in text → LONG wins
  const c = classify(ev("Spring Tango Festival with Milongas"), tangoNiche);
  assert.equal(c.category_first, "Festival");
});

test("classify — SHORT inner: Milonga > Practica > Class", () => {
  const c = classify(ev("Milonga and Practica Sunday"), tangoNiche);
  assert.equal(c.category_first, "Milonga");
});

test("classify — Class-only emits skip_class_only when load_classes=false", () => {
  const c = classify(ev("Beginner Tango Class"), tangoNiche);
  assert.equal(c.category_first, "Class");
  assert.equal(c.skip_reason, "skip_class_only");
});

test("classify — Performance emits skip_performance", () => {
  const c = classify(ev("Tango Performance Showcase"), tangoNiche);
  assert.equal(c.category_first, "Performance");
  assert.equal(c.skip_reason, "skip_performance");
});

test("classify — Trip emits skip_trip", () => {
  const c = classify(ev("Tango Trip to Buenos Aires"), tangoNiche);
  assert.equal(c.category_first, "Trip");
  assert.equal(c.skip_reason, "skip_trip");
});

test("classify — defaults to Unknown when no category keyword present", () => {
  const c = classify(ev("Random Event"), tangoNiche);
  assert.equal(c.category_first, "Unknown");
  assert.equal(c.skip_reason, "skip_unknown");
});

// ─────────────────────────────────────────────────────────────────────
// classify — duration flags (LOADER-CONTRACT §7.2 Harvey 2026-04-29)
// Soft flags replace hard drops. Re-assignment logic tested here.
// ─────────────────────────────────────────────────────────────────────

test("classify — SHORT+≥24h re-assigns to Workshop (no LONG keyword)", () => {
  const c = classify(
    ev("Milonga Weekend", {
      start_dt_iso: "2026-05-29T19:00:00",
      end_dt_iso: "2026-06-01T19:00:00", // 72h
    }),
    tangoNiche,
  );
  // Re-assigned from Milonga to Workshop; still loadable
  assert.equal(c.category_first, "Workshop");
  assert.equal(c.skip_reason, null);
  assert.notEqual(c.duration_flag, null);
  assert.equal(c.duration_flag?.kind, "duration_reassigned");
  assert.ok(c.duration_flag?.original_category === "Milonga");
  assert.equal(c.duration_hours, 72);
});

test("classify — LONG keyword in title + ≥24h → LONG wins normally (no re-assign needed)", () => {
  const c = classify(
    ev("Milonga Festival Weekend", {
      start_dt_iso: "2026-05-29T19:00:00",
      end_dt_iso: "2026-06-01T19:00:00", // 72h
    }),
    tangoNiche,
  );
  // Festival (LONG) keyword wins via LONG branch; 72h is within Festival ceiling
  // (240h); no flag needed — duration confirms LONG classification.
  assert.equal(c.category_first, "Festival");
  assert.equal(c.duration_flag, null);
});

test("classify — Case B: LONG+SHORT keywords + duration < 24h → SHORT wins (no flag)", () => {
  const c = classify(
    ev("Saturday Milonga Marathon", {
      start_dt_iso: "2026-05-29T19:00:00",
      end_dt_iso: "2026-05-30T00:00:00", // 5h
    }),
    tangoNiche,
  );
  // Marathon (LONG) + Milonga (SHORT) in title + 5h < 24h → Case B, SHORT wins
  // Duration-guided disambiguation is correct; no flag needed.
  assert.equal(c.category_first, "Milonga");
  assert.equal(c.duration_flag, null);
});

test("classify — LONG+<24h keeps LONG with flag when no SHORT keyword", () => {
  const c = classify(
    ev("Tango Workshop", {
      start_dt_iso: "2026-05-29T19:00:00",
      end_dt_iso: "2026-05-30T00:00:00", // 5h
    }),
    tangoNiche,
  );
  // Workshop (LONG) + 5h, no SHORT keyword → keep Workshop + flag
  assert.equal(c.category_first, "Workshop");
  assert.equal(c.skip_reason, null); // still loadable
  assert.equal(c.duration_flag?.kind, "duration_reassigned");
});

test("classify — Case B: LONG+SHORT keywords (singular) + duration < 24h → SHORT wins", () => {
  const c = classify(
    ev("Spring Tango Festival with Milonga", {
      start_dt_iso: "2026-05-29T19:00:00",
      end_dt_iso: "2026-05-30T01:00:00", // 6h — clearly SHORT duration
    }),
    tangoNiche,
  );
  // "Festival" (LONG) and "Milonga" (SHORT, singular — plural 'Milongas' doesn't
  // match \bMilonga\b word boundary) + 6h < 24h → Case B, SHORT wins; no flag.
  assert.equal(c.category_first, "Milonga");
  assert.equal(c.duration_flag, null);
});

test("classify — per-category ceiling: Festival > 240h → ceiling flag (still loads)", () => {
  const c = classify(
    ev("Huge Tango Festival", {
      start_dt_iso: "2026-05-01T00:00:00",
      end_dt_iso: "2026-05-12T00:00:00", // 264h
    }),
    tangoNiche,
  );
  assert.equal(c.category_first, "Festival");
  assert.equal(c.skip_reason, null); // still loadable
  assert.equal(c.duration_flag?.kind, "duration_ceiling_exceeded");
});

test("classify — per-category ceiling: Festival at 200h is within ceiling (no flag)", () => {
  const c = classify(
    ev("Long Tango Festival", {
      start_dt_iso: "2026-05-01T00:00:00",
      end_dt_iso: "2026-05-09T08:00:00", // 200h
    }),
    tangoNiche,
  );
  assert.equal(c.category_first, "Festival");
  assert.equal(c.duration_flag, null);
});

test("classify — per-category ceiling: Marathon > 120h → ceiling flag", () => {
  const c = classify(
    ev("8-Day Buenos Aires Tango Marathon", {
      start_dt_iso: "2026-05-01T00:00:00",
      end_dt_iso: "2026-05-07T00:00:00", // 144h
    }),
    tangoNiche,
  );
  assert.equal(c.category_first, "Marathon");
  assert.equal(c.skip_reason, null);
  assert.equal(c.duration_flag?.kind, "duration_ceiling_exceeded");
});

test("classify — SHORT at exactly 24h re-assigns (rule is >=)", () => {
  const c = classify(
    ev("All-Day Milonga", {
      start_dt_iso: "2026-05-29T19:00:00",
      end_dt_iso: "2026-05-30T19:00:00", // exactly 24h
    }),
    tangoNiche,
  );
  assert.equal(c.duration_flag?.kind, "duration_reassigned");
  assert.notEqual(c.category_first, "Milonga"); // re-assigned away from SHORT
});

test("classify — SHORT at 23h is clean (no flag)", () => {
  const c = classify(
    ev("Long Milonga", {
      start_dt_iso: "2026-05-29T19:00:00",
      end_dt_iso: "2026-05-30T18:00:00", // 23h
    }),
    tangoNiche,
  );
  assert.equal(c.duration_flag, null);
  assert.equal(c.category_first, "Milonga");
});

test("classify — no end_dt → no flag, no duration", () => {
  const c = classify(ev("Milonga"), tangoNiche);
  assert.equal(c.duration_hours, null);
  assert.equal(c.duration_flag, null);
});

// ─────────────────────────────────────────────────────────────────────
// classify — word-boundary matching (Milongueros ≠ Milonga)
// ─────────────────────────────────────────────────────────────────────

test("classify — word-boundary: 'Milongueros' should NOT match 'Milonga'", () => {
  const c = classify(ev("Tango Milongueros Reunion"), tangoNiche);
  // Should NOT match Milonga; should fall through to Unknown
  assert.notEqual(c.category_first, "Milonga");
});
