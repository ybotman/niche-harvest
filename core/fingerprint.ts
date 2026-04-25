// core/fingerprint.ts — SHA256 normalization for dedup keys.
//
// Authority: ARCHITECTURE.md §3.1 (raw_events.fingerprint UNIQUE).
// One fingerprint per logical event from a source. Stable across re-fetches
// of the same feed, drives idempotent inserts (§5.4 crash recovery).

import { createHash } from "node:crypto";

/**
 * Compute the canonical fingerprint for a raw event.
 * Inputs are normalized (trimmed, lowercased) before hashing so that
 * cosmetic source-side changes (whitespace, casing) don't produce a new
 * fingerprint and re-insert the same event.
 *
 * Components:
 *   - source name (the niche.yaml `name` for the source)
 *   - source-side stable id (UID for iCal, FB event id, etc.)
 *
 * Title + date are NOT in the fingerprint by design — sources sometimes
 * edit titles or shift dates by minutes; the source-side ID is what
 * uniquely identifies the event-as-the-source-knows-it.
 */
export function fingerprintRawEvent(input: {
  sourceName: string;
  sourceEventId: string;
}): string {
  const norm = (s: string) => s.trim().toLowerCase();
  const composite = `${norm(input.sourceName)}|${norm(input.sourceEventId)}`;
  return createHash("sha256").update(composite, "utf8").digest("hex");
}

/**
 * Compute a venue fingerprint for the venues table (ARCHITECTURE §3.1).
 * Used for venue-level dedup before geocoding.
 *
 * Pattern source: Harvey's `harvester/scripts/gcal-harvest.ts:723` — keys
 * dedup by `${venue_name}|${city}` after parseLocation extracts structured
 * parts. niche-harvest mirrors. Caller MUST pass parsed venue_name (NOT
 * raw_location_text) — passing raw text fragments venues 5-10x.
 *
 * AIDI 2026-04-25 root-cause: keying on raw text turned 10 real venues
 * into 101 fragmented venues on slc-wasatch (54% vs Harvey's 100% rate).
 * Fixed by switching to parsed venue_name + city.
 */
export function fingerprintVenue(input: {
  /** Parsed venue name from parse-location.ts (e.g. "DF Dance Studio").
   *  If parser couldn't extract a name, caller should pass the raw text
   *  truncated to first comma chunk + the extracted city as a best-effort. */
  name: string;
  /** Parsed city from parse-location.ts. Empty string acceptable when
   *  the city couldn't be extracted; means the venue is dedup'd within
   *  the unknown-city bucket (still better than full-text fragmenting). */
  city?: string;
}): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const composite = `${norm(input.name)}|${norm(input.city ?? "")}`;
  return createHash("sha256").update(composite, "utf8").digest("hex");
}
