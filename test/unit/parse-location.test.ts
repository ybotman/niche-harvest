// test/unit/parse-location.test.ts
// Run: node --experimental-strip-types --test test/unit/parse-location.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseLocation } from "../../core/geocoder/parse-location.ts";

test("parseLocation — full 5-token format", () => {
  const p = parseLocation("DF Dance Studio, 2978 South State Street, South Salt Lake, UT 84115, United States");
  assert.equal(p.venue_name, "DF Dance Studio");
  assert.equal(p.address, "2978 South State Street");
  assert.equal(p.city, "South Salt Lake");
  assert.equal(p.state, "UT");
  assert.equal(p.country_iso, "US");
  // Structured query skips venue prefix
  assert.equal(p.geocode_query, "2978 South State Street, South Salt Lake, UT, US");
});

test("parseLocation — 'United States' / 'USA' / 'U.S.A.' all normalize to US", () => {
  for (const country of ["United States", "USA", "U.S.A.", "u.s.a."]) {
    const p = parseLocation(`Some Place, 123 Main St, City, NY 10001, ${country}`);
    assert.equal(p.country_iso, "US", `expected US for "${country}"`);
  }
});

test("parseLocation — Cyrillic 'СШΑ' blocks downstream parsing (TODO: skip-unknown-country heuristic)", () => {
  // Note: source has cyrillic "СШΑ" (with mixed Greek alpha at end) — exact
  // byte sequence from slc-wasatch's real feed. Not in COUNTRY_NORMALIZE,
  // so country-pop SKIPS but the token stays at end of remaining[]. State
  // detection then sees "СШΑ" as last-token, can't parse, also leaves
  // remaining[] alone. Same for city. Result: address-slot eats EVERYTHING
  // from "2580 Jefferson Ave" through "СШΑ".
  //
  // This is acceptable for v1 — the venue still fingerprints by venue_name
  // alone (city defaults to feed-default at enrich time). But documents a
  // known limitation: an unknown trailing country breaks downstream parsing
  // for that one event. Future fix: heuristic "if country-candidate looks
  // country-like (non-ASCII, short, capitalized) but isn't in dict, skip
  // it anyway and continue parsing."
  const p = parseLocation("Eccles Community Art Center, 2580 Jefferson Ave, Ogden, UT 84401, СШΑ");
  assert.equal(p.venue_name, "Eccles Community Art Center");
  assert.equal(p.country_iso, undefined);
  assert.equal(p.state, undefined);
  assert.equal(p.city, undefined);
  // Address slot ate everything that wasn't venue (because none of state/
  // city/country could pop it):
  assert.match(p.address ?? "", /Ogden/);
  assert.match(p.address ?? "", /СШΑ/);
});

test("parseLocation — no venue prefix (address starts with digit)", () => {
  const p = parseLocation("2465 N Main St, Sunset, UT 84015, USA");
  assert.equal(p.venue_name, undefined);
  assert.equal(p.address, "2465 N Main St");
  assert.equal(p.city, "Sunset");
  assert.equal(p.state, "UT");
  assert.equal(p.country_iso, "US");
});

test("parseLocation — Buenos Aires (non-US)", () => {
  const p = parseLocation("Plaza Dorrego, San Telmo, Buenos Aires, Argentina");
  assert.equal(p.venue_name, "Plaza Dorrego");
  assert.equal(p.country_iso, "AR");
  // No state token (BA not US/CA), so city rolls back
  assert.equal(p.city, "Buenos Aires");
});

test("parseLocation — single-token (just venue name) is stored as 'city' fallback", () => {
  const p = parseLocation("Some Random Place");
  // No comma → single token; my parser treats it as the city fallback
  assert.equal(p.city, "Some Random Place");
  assert.equal(p.geocode_query, "Some Random Place");
});

test("parseLocation — empty input safe", () => {
  const p = parseLocation("");
  assert.equal(p.geocode_query, "");
  assert.equal(p.raw_text, "");
});

test("parseLocation — preserves raw_text verbatim", () => {
  const original = "  DF Dance Studio,2978 South State Street,Salt Lake City,UT 84115,USA  ";
  const p = parseLocation(original);
  assert.equal(p.raw_text, original.trim());
});

test("parseLocation — zip with hyphen extension", () => {
  const p = parseLocation("Venue, 123 Main, City, NY 10001-1234, USA");
  assert.equal(p.state, "NY");
  assert.equal(p.country_iso, "US");
});

test("parseLocation — address with Suite continues address tokens", () => {
  const p = parseLocation("Salt City Studio, 3300 South 1321 East, Suite 6, Millcreek, UT, United States");
  assert.equal(p.venue_name, "Salt City Studio");
  // Address is everything between venue and city
  assert.equal(p.address, "3300 South 1321 East, Suite 6");
  assert.equal(p.city, "Millcreek");
  assert.equal(p.state, "UT");
});
