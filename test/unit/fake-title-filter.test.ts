// test/unit/fake-title-filter.test.ts — pre-classify "fakes filter" guards.
// Per Harvey blind-spot #1 (advisor handover 2026-04-30).

import { test } from "node:test";
import assert from "node:assert/strict";

import { isRealTitle } from "../../core/adapters/ical.ts";

// ─── Drop: clear placeholder/test markers ───

test("isRealTitle — empty / whitespace → drop", () => {
  assert.equal(isRealTitle(""), false);
  assert.equal(isRealTitle("   "), false);
  assert.equal(isRealTitle(undefined), false);
  assert.equal(isRealTitle(null), false);
});

test("isRealTitle — placeholder marker → drop", () => {
  assert.equal(isRealTitle("placeholder"), false);
  assert.equal(isRealTitle("Placeholder event"), false);
  assert.equal(isRealTitle("event PLACEHOLDER tango"), false);
});

test("isRealTitle — demo marker → drop", () => {
  assert.equal(isRealTitle("Demo event"), false);
  assert.equal(isRealTitle("DEMO milonga"), false);
});

test("isRealTitle — (test) parenthetical → drop", () => {
  assert.equal(isRealTitle("Friday Milonga (test)"), false);
  assert.equal(isRealTitle("(TEST) Tango Workshop"), false);
});

test("isRealTitle — intro test → drop", () => {
  assert.equal(isRealTitle("Intro Test event"), false);
  assert.equal(isRealTitle("INTRO TEST milonga"), false);
});

test("isRealTitle — TBD/TBA solo → drop", () => {
  assert.equal(isRealTitle("TBD"), false);
  assert.equal(isRealTitle("TBA"), false);
  assert.equal(isRealTitle("tbd"), false);
  assert.equal(isRealTitle(" tba "), false);
});

// ─── Keep: real event titles that share substrings ───

test("isRealTitle — real titles with 'test' substring kept", () => {
  // Conservative: 'test' alone removed from pattern; only specific markers caught
  assert.equal(isRealTitle("Latest Tango"), true);
  assert.equal(isRealTitle("Stress test technique workshop"), true);
});

test("isRealTitle — real titles with 'sample' kept (false-positive guard)", () => {
  assert.equal(isRealTitle("Tango Sampler Night"), true);
  assert.equal(isRealTitle("Music sample milonga"), true);
});

test("isRealTitle — TBD-containing titles kept (only solo TBD drops)", () => {
  assert.equal(isRealTitle("TBD location milonga"), true); // real event with unconfirmed location
});

test("isRealTitle — typical real titles kept", () => {
  assert.equal(isRealTitle("Friday Night Milonga"), true);
  assert.equal(isRealTitle("Spring Tango Festival 2026"), true);
  assert.equal(isRealTitle("Workshop with Carolina Couture"), true);
  assert.equal(isRealTitle("Saturday Practica @ DF Studio"), true);
});
