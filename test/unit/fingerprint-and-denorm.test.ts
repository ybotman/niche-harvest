// test/unit/fingerprint-and-denorm.test.ts
// Run: node --experimental-strip-types --test test/unit/fingerprint-and-denorm.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { fingerprintRawEvent, fingerprintVenue } from "../../core/fingerprint.ts";
import { generateShortName } from "../../core/loader/denorm.ts";

// ─────────────────────────────────────────────────────────────────────
// fingerprintRawEvent — stability + normalization
// ─────────────────────────────────────────────────────────────────────

test("fingerprintRawEvent — stable across calls with same input", () => {
  const a = fingerprintRawEvent({ sourceName: "slc-wasatch", sourceEventId: "abc-123" });
  const b = fingerprintRawEvent({ sourceName: "slc-wasatch", sourceEventId: "abc-123" });
  assert.equal(a, b);
});

test("fingerprintRawEvent — case-insensitive", () => {
  const a = fingerprintRawEvent({ sourceName: "slc-wasatch", sourceEventId: "ABC-123" });
  const b = fingerprintRawEvent({ sourceName: "SLC-WASATCH", sourceEventId: "abc-123" });
  assert.equal(a, b);
});

test("fingerprintRawEvent — whitespace-trimmed", () => {
  const a = fingerprintRawEvent({ sourceName: "  slc-wasatch  ", sourceEventId: "abc-123" });
  const b = fingerprintRawEvent({ sourceName: "slc-wasatch", sourceEventId: "abc-123" });
  assert.equal(a, b);
});

test("fingerprintRawEvent — different IDs produce different fingerprints", () => {
  const a = fingerprintRawEvent({ sourceName: "slc-wasatch", sourceEventId: "abc-123" });
  const b = fingerprintRawEvent({ sourceName: "slc-wasatch", sourceEventId: "abc-124" });
  assert.notEqual(a, b);
});

test("fingerprintRawEvent — different sources with same ID produce different fingerprints", () => {
  // Critical: prevents two sources from clobbering each other if they happen
  // to use the same source-side ID format.
  const a = fingerprintRawEvent({ sourceName: "slc-wasatch", sourceEventId: "abc-123" });
  const b = fingerprintRawEvent({ sourceName: "tangomango", sourceEventId: "abc-123" });
  assert.notEqual(a, b);
});

test("fingerprintRawEvent — SHA256 hex format", () => {
  const fp = fingerprintRawEvent({ sourceName: "slc-wasatch", sourceEventId: "abc-123" });
  assert.match(fp, /^[a-f0-9]{64}$/);
});

// ─────────────────────────────────────────────────────────────────────
// fingerprintVenue — stable + normalized
// ─────────────────────────────────────────────────────────────────────

test("fingerprintVenue — case + space normalized", () => {
  const a = fingerprintVenue({ name: "DF Dance Studio", city: "Salt Lake City" });
  const b = fingerprintVenue({ name: "df dance studio", city: "salt lake city" });
  const c = fingerprintVenue({ name: "DF  Dance   Studio", city: "Salt Lake City" });
  assert.equal(a, b);
  assert.equal(a, c);
});

test("fingerprintVenue — different cities differentiate same-named venues", () => {
  const a = fingerprintVenue({ name: "Studio A", city: "Salt Lake City" });
  const b = fingerprintVenue({ name: "Studio A", city: "Boston" });
  assert.notEqual(a, b);
});

test("fingerprintVenue — city defaults to empty when omitted", () => {
  const a = fingerprintVenue({ name: "Studio A" });
  const b = fingerprintVenue({ name: "Studio A", city: "" });
  assert.equal(a, b);
});

// ─────────────────────────────────────────────────────────────────────
// generateShortName — LOADER-CONTRACT §4.2 charset rules
// ─────────────────────────────────────────────────────────────────────

test("generateShortName — multi-word: head(3) + initials(rest)", () => {
  const sn = generateShortName("Wasatch Tango Society");
  assert.equal(sn, "WASTS");
  // First 3 letters of "WASATCH" + initials W,T,S → wait that's WAST + S = WASTS? Let me trace:
  // head = first 3 letters of "WASATCH" = "WAS"
  // initials = "T" (Tango) + "S" (Society) = "TS"
  // candidate = "WAS" + "TS" = "WASTS"
});

test("generateShortName — single word: first 6 letters", () => {
  const sn = generateShortName("Tangueros");
  assert.equal(sn, "TANGUE");
});

test("generateShortName — strips non-alphanumerics before processing", () => {
  const sn = generateShortName("Tango & Friends Co.");
  // Non-alpha stripped → "Tango Friends Co"
  // head = "TAN", initials = "F" + "C" → "TANFC"
  assert.equal(sn, "TANFC");
});

test("generateShortName — null on insufficient letters", () => {
  assert.equal(generateShortName("AB"), null);    // too short
  assert.equal(generateShortName(""), null);
  assert.equal(generateShortName("123"), null);   // no letters
  assert.equal(generateShortName("12"), null);
});

test("generateShortName — '3rd Street Studio' → 'RDSS' (digits in word filtered, head padded by initials)", () => {
  // Trace: cleaned = "3rd Street Studio" (digits ARE alphanumeric, kept).
  // upper = "3RD STREET STUDIO"; words = ["3RD", "STREET", "STUDIO"].
  // head = words[0].replace(/[^A-Z]/g, '').slice(0,3) = "RD" (digit filtered out → 2 chars).
  // initials = "S" + "S" = "SS".
  // candidate = "RD" + "SS" = "RDSS" (4 chars; first 3 = "RDS" all A-Z; ends alphanum).
  // Result: valid shortName per LOADER-CONTRACT §4.2 charset.
  // Note: this is technically valid but semantically loses the "3"; if the
  // venue is "3rd Street Studio" the result loses ordinal info. Acceptable
  // per the contract; flagged for future ordinal-handling enhancement.
  const sn = generateShortName("3rd Street Studio");
  assert.equal(sn, "RDSS");
});

test("generateShortName — output ends alphanumeric, length 3-12", () => {
  const sn = generateShortName("Argentine Tango Northern California Group");
  // head = "ARG"; initials = "TNCG"; total = "ARGTNCG" (7 chars)
  assert.equal(sn, "ARGTNCG");
  assert.ok(sn!.length >= 3 && sn!.length <= 12);
  assert.match(sn!, /[A-Z0-9]$/);
});
