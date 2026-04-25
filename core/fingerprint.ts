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
 * Used for venue-level dedup before geocoding. Same normalization rules.
 */
export function fingerprintVenue(input: {
  name: string;
  city?: string;
}): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const composite = `${norm(input.name)}|${norm(input.city ?? "")}`;
  return createHash("sha256").update(composite, "utf8").digest("hex");
}
