// core/loader/denorm.ts — assemble the event document with full denorm
// bundle per LOADER-CONTRACT §6.
//
// In dry-run mode, mastered chain fields are filled with "TODO:automaster"
// sentinel because the live pipeline gets them from BE's AutoMaster
// response on the venue POST (§3.3). For dry-run review, AIDI explicitly
// asked the stub format be "TODO:automaster" rather than field omission
// so the contract is verifiable from the report alone (AIDI 2026-04-25).
//
// Override fields per §6.3 + §9: classifier-derived value AND its
// `*Override` are both set (belt-and-braces; if anyone later PATCHes via
// API and triggers BE enrichment, override tells enrichment to respect
// the loader's value).

import type { ObjectId } from "mongodb";
import type { ClassifyResult } from "../classify.ts";
import type {
  EventDoc,
  OrganizerDoc,
  VenueDoc,
  VenueMasteredChainResponse,
} from "./interface.ts";
import type { CategoryConfig, NicheConfig } from "../types.ts";

/**
 * Sentinel for fields that come from BE AutoMaster at live load time.
 * Dry-run report shows these literal strings so reviewer sees the
 * contract is honored — every §6 field is present.
 */
export const TODO_AUTOMASTER = "TODO:automaster" as const;

export interface EnrichedRow {
  id: number;
  source_id: number;
  raw_title: string;
  raw_description: string | null;
  raw_organizer_text: string | null;
  raw_url: string | null;
  start_dt_iso: string;
  end_dt_iso: string;
  source_rrule: string | null;
  classify: ClassifyResult;
}

export interface VenueRow {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  lat: number;
  lng: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Build the venue doc that would be POST'd
// ─────────────────────────────────────────────────────────────────────────

export function buildVenueDoc(
  v: VenueRow,
  niche: NicheConfig,
): VenueDoc {
  const doc: VenueDoc = {
    name: v.name,
    latitude: v.lat,
    longitude: v.lng,
    appId: niche.niche.appid,
    isDiscovered: true,
    discoverySource: niche.loader.discovery_source,
  };
  if (v.address) doc.address = v.address;
  if (v.city) doc.city = v.city;
  if (v.state) doc.state = v.state;
  if (v.country) doc.country = v.country;
  return doc;
}

// ─────────────────────────────────────────────────────────────────────────
// Build the organizer doc that would be POST'd / looked-up
// ─────────────────────────────────────────────────────────────────────────

/**
 * Generate a candidate shortName per LOADER-CONTRACT §4.2 charset rules
 * (length 3-12, first 3 must be A-Z, then A-Z|0-9|hyphen, end alphanum).
 * Strip non-alphanumerics, uppercase, take first 3 letters + initials of
 * next words. Returns null if no usable name can be generated.
 */
export function generateShortName(fullName: string): string | null {
  const cleaned = fullName.replace(/[^A-Za-z0-9 ]+/g, " ").trim();
  if (cleaned.length === 0) return null;
  const upper = cleaned.toUpperCase();
  const words = upper.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;

  let candidate: string;
  if (words.length === 1) {
    // Single word: take first 6 letters
    candidate = words[0]!.replace(/[^A-Z]/g, "").slice(0, 6);
  } else {
    // Multi-word: first 3 of first word + initials of subsequent words
    const head = words[0]!.replace(/[^A-Z]/g, "").slice(0, 3);
    const initials = words
      .slice(1)
      .map((w) => (w[0] ?? "").replace(/[^A-Z0-9]/g, ""))
      .join("");
    candidate = (head + initials).slice(0, 12);
  }

  // Must be at least 3 chars, first 3 must be A-Z, must end alphanumeric
  if (candidate.length < 3) return null;
  if (!/^[A-Z]{3}/.test(candidate)) return null;
  if (!/[A-Z0-9]$/.test(candidate)) return null;
  return candidate;
}

export function buildOrganizerDoc(
  fullName: string,
  niche: NicheConfig,
  opts: { fb_profile_url?: string; event_count?: number } = {},
): OrganizerDoc | null {
  const sn = generateShortName(fullName);
  if (!sn) return null;
  const doc: OrganizerDoc = {
    fullName,
    shortName: sn,
    appId: niche.niche.appid,
    isDiscovered: true,
    discoverySource: niche.loader.discovery_source,
  };
  if (opts.fb_profile_url) doc.fb_profile_url = opts.fb_profile_url;
  if (typeof opts.event_count === "number") doc.event_count = opts.event_count;
  return doc;
}

// ─────────────────────────────────────────────────────────────────────────
// Build the event doc with full denorm (the centerpiece of §6)
// ─────────────────────────────────────────────────────────────────────────

export interface EventDocInputs {
  enriched: EnrichedRow;
  venue: VenueRow;
  niche: NicheConfig;
  /** When dry-run: VenueMasteredChainResponse stub. When live: BE response. */
  venueChain: VenueMasteredChainResponse;
  /** Resolved venue ObjectId (real for live; sentinel string for dry-run). */
  venueId: ObjectId | string | null;
  /** Resolved organizer ObjectId (or null if no organizer signal). */
  ownerOrganizerID: ObjectId | string | null;
  /**
   * Resolved category ObjectId (from cache-warmed categories per §6.4).
   * Null in dry-run where cache isn't warmed.
   */
  categoryFirstId: ObjectId | string | null;
}

export function buildEventDoc(inputs: EventDocInputs): EventDoc {
  const { enriched, niche, venueChain, venueId, ownerOrganizerID } = inputs;
  const cl = enriched.classify;

  // Find the matching CategoryConfig for travel_worthy / for_beginners
  // eligibility per §7.5 + §7.6 (tango-specific; null for ineligible).
  const cat = cl.category_first
    ? niche.taxonomy.categories.find((c) => c.name === cl.category_first) ?? null
    : null;

  const travelWorthy = computeTravelWorthy(cat);
  const forBeginners = computeForBeginners(cat, enriched);
  const beginnerFriendly = computeBeginnerFriendly(cat, enriched);

  // §10.4 anti-recurrence: LONG events never recurring; SHORT may recur.
  // Per LOADER-CONTRACT BE force-nulls these if duration > 24h.
  const isLong = cat?.duration_group === "LONG";
  const isRepeating = !isLong && Boolean(enriched.source_rrule);
  const recurrenceRule = isRepeating ? enriched.source_rrule : null;

  // §6.2 explicit copy: authorOrganizerID ← ownerOrganizerID.
  // BE does this on HTTP POST path; direct-Mongo path requires loader
  // to copy explicitly (LOADER-CONTRACT §6.2 + AIDI 2026-04-25 reminder).
  const authorOrganizerID = ownerOrganizerID;

  // §5.6 shortTitle: truncate at delimiter, ≤40 chars
  const shortTitle = makeShortTitle(enriched.raw_title);

  return {
    appId: niche.niche.appid,
    title: enriched.raw_title,
    startDate: enriched.start_dt_iso,
    endDate: enriched.end_dt_iso,
    categoryFirst: cl.category_first ?? "Unknown",
    categoryFirstId: inputs.categoryFirstId as ObjectId | null,
    categorySecond: cl.category_second,
    categorySecondId: null,
    categoryThird: cl.category_third,
    categoryThirdId: null,
    venueID: venueId as ObjectId | null,
    venueTimezone: venueChain.timezone,
    venueCityName: venueChain.masteredCityName,
    venueGeolocation: venueChain.geolocation,
    masteredCityId: venueChain.masteredCityId,
    masteredCityName: venueChain.masteredCityName,
    masteredCityGeolocation: null,
    masteredDivisionId: venueChain.masteredDivisionId,
    masteredDivisionName: venueChain.masteredDivisionName,
    masteredRegionId: venueChain.masteredRegionId,
    masteredRegionName: venueChain.masteredRegionName,
    masteredCountryId: venueChain.masteredCountryId,
    masteredCountryName: venueChain.masteredCountryName,
    ownerOrganizerID: ownerOrganizerID as ObjectId | null,
    authorOrganizerID: authorOrganizerID as ObjectId | null,
    enrichmentStatus: "complete",
    trustLevel: niche.loader.trust_level,
    isDiscovered: true,
    discoverySource: niche.loader.discovery_source,
    shortTitle,
    ...(enriched.raw_description ? { description: enriched.raw_description } : {}),
    travelWorthy,
    travelWorthyOverride: travelWorthy,
    beginnerFriendly,
    beginnerFriendlyOverride: beginnerFriendly,
    forBeginners,
    forBeginnersOverride: forBeginners,
    isRepeating,
    recurrenceRule,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Classifier-derived flags per LOADER-CONTRACT §7.5 + §7.6
// (tango-specific today; framework reads from CategoryConfig flags)
// ─────────────────────────────────────────────────────────────────────────

function computeTravelWorthy(cat: CategoryConfig | null): boolean | null {
  if (!cat) return null;
  return cat.travel_worthy_eligible;
}

function computeForBeginners(
  cat: CategoryConfig | null,
  enriched: EnrichedRow,
): boolean | null {
  if (!cat || !cat.beginner_eligible) return false;
  // Stage 0/1 per LOADER-CONTRACT §7.6: explicit-positive in title
  const title = enriched.raw_title.toLowerCase();
  if (
    /\babsolute beginner\b|\bnewcomer\b|\bintro\b|\blevel 1\b|\bfrom scratch\b/.test(title)
  ) {
    return true;
  }
  return false;
}

function computeBeginnerFriendly(
  cat: CategoryConfig | null,
  enriched: EnrichedRow,
): boolean | null {
  if (!cat || !cat.beginner_eligible) return false;
  const title = enriched.raw_title.toLowerCase();
  if (
    /\ball[- ]levels\b|\bopen[- ]levels\b|\bmixed[- ]levels\b/.test(title)
  ) {
    return true;
  }
  // Falls through to forBeginners cases per §7.6 stage 1
  return computeForBeginners(cat, enriched);
}

function makeShortTitle(title: string): string {
  if (title.length <= 40) return title;
  // Truncate at most-natural delimiter near 40
  const end = Math.min(40, title.length);
  for (const delim of [" — ", " - ", " | ", ":", "—"]) {
    const idx = title.indexOf(delim);
    if (idx > 0 && idx < end) return title.slice(0, idx).trim();
  }
  return title.slice(0, 37).trimEnd() + "...";
}

// ─────────────────────────────────────────────────────────────────────────
// Stub mastered chain for dry-run mode
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a VenueMasteredChainResponse stub for dry-run mode where we
 * haven't actually called BE. All §6.1 fields are filled with the
 * TODO_AUTOMASTER sentinel string so AIDI can verify completeness in
 * the dry-run report (AIDI 2026-04-25 review expectation #1).
 */
export function stubMasteredChain(): VenueMasteredChainResponse {
  return {
    timezone: TODO_AUTOMASTER,
    geolocation: null,
    masteredCityId: TODO_AUTOMASTER,
    masteredCityName: TODO_AUTOMASTER,
    masteredDivisionId: TODO_AUTOMASTER,
    masteredDivisionName: TODO_AUTOMASTER,
    masteredRegionId: TODO_AUTOMASTER,
    masteredRegionName: TODO_AUTOMASTER,
    masteredCountryId: TODO_AUTOMASTER,
    masteredCountryName: TODO_AUTOMASTER,
  };
}
