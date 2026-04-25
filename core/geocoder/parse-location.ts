// core/geocoder/parse-location.ts — parse free-form location string into
// {venue_name?, address?, city?, state?, country?} parts for structured
// geocoder queries.
//
// AIDI 2026-04-25 review pinpointed the root cause of niche-harvest's 55%
// geocode rate: passing the raw location string (with venue name prepended,
// "United States" vs ISO code, etc.) confuses Nominatim's free-text parser.
// Harvey's gcal-harvest.ts gets 90%+ on the same feed by passing structured
// fields. This module ports that logic.
//
// Heuristics handled:
//   - "Venue Name, 123 Main St, City, ST 12345, Country" → all 5 parts
//   - "123 Main St, City, ST 12345" → no venue, no country
//   - "City, ST" → city + state only
//   - Trailing "USA" / "United States" / "США" normalized to ISO "US"
//   - First token is venue if it has letters and no leading digit

const COUNTRY_NORMALIZE: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  "usa": "US",
  "u.s.a.": "US",
  "u.s.": "US",
  "сша": "US",                    // Cyrillic for USA (seen in slc-wasatch)
  "estados unidos": "US",
  "canada": "CA",
  "argentina": "AR",
  "germany": "DE",
  "deutschland": "DE",
  "netherlands": "NL",
  "poland": "PL",
  "switzerland": "CH",
  "united kingdom": "GB",
  "uk": "GB",
  "italy": "IT",
  "italia": "IT",
  "france": "FR",
  "australia": "AU",
  "thailand": "TH",
};

// Two-letter US state codes (subset; expand as we encounter more)
const US_STATES: ReadonlySet<string> = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC",
]);

// Full-name → 2-letter map for full-name state references in source text.
// Catches "Utah" appearing where the parser otherwise treats it as city.
const US_STATE_NAMES: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
  "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
};

// City alias normalization — maps source-text variants to canonical city names
// so dedup actually merges them. Add aliases as new niches surface them.
const CITY_ALIASES: Record<string, string> = {
  "slc": "Salt Lake City",
  "salt lake": "Salt Lake City",  // shorthand seen in slc-wasatch
  "ny": "New York",
  "nyc": "New York",
  "la": "Los Angeles",
  "sf": "San Francisco",
};

export interface ParsedLocation {
  venue_name?: string;
  address?: string;
  city?: string;
  state?: string;
  country_iso?: string;
  /**
   * Best-effort structured geocode query — what we'd hand Nominatim for
   * a high-quality match. Built from address + city + state + country.
   * Falls back to the original text if parsing finds nothing structured.
   */
  geocode_query: string;
  /**
   * The original input, kept for cache-key stability and for raw fallback
   * if structured query yields no results.
   */
  raw_text: string;
}

/**
 * Per-source location defaults (Harvey's gcal-harvest pattern). When the
 * source feed is geographically scoped (e.g. slc-wasatch is a Salt Lake
 * Tango calendar), defaults fill in fields the parser can't extract.
 * Not a no-fallback violation — the source is genuinely scoped to that
 * geography; the defaults reflect source-level truth, not synthesis.
 */
export interface LocationDefaults {
  city?: string;
  state?: string;
  country?: string;
}

export function parseLocation(
  text: string,
  defaults: LocationDefaults = {},
): ParsedLocation {
  const raw = text.trim();
  // Split on commas; trim each part. ICS LOCATION strings ARE escaped
  // commas → "\\," and the iCal adapter unescapes them, so by the time
  // we see this string the commas are real separators.
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);

  if (parts.length === 0) {
    return { geocode_query: raw, raw_text: raw };
  }

  // Walk from the END: country, then state-and-zip, then city, then address.
  let venue_name: string | undefined;
  let address: string | undefined;
  let city: string | undefined;
  let state: string | undefined;
  let country_iso: string | undefined;

  let remaining = [...parts];

  // ─── Country (last token) ───
  const lastLower = remaining[remaining.length - 1]?.toLowerCase();
  if (lastLower && COUNTRY_NORMALIZE[lastLower]) {
    country_iso = COUNTRY_NORMALIZE[lastLower];
    remaining.pop();
  }

  // ─── State + zip (last token, looks like "UT 84106" or "NY 10001-1234") ───
  // Also accepts full state names ("Utah", "Salt Lake City, UT 84106, Utah")
  // — when source uses full name instead of 2-letter code, parser normalizes.
  if (remaining.length > 0) {
    const last = remaining[remaining.length - 1]!;
    const stateZipMatch = last.match(/^([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/i);
    if (stateZipMatch) {
      const stateCode = stateZipMatch[1]!.toUpperCase();
      if (US_STATES.has(stateCode)) {
        state = stateCode;
        if (!country_iso) country_iso = "US";
        remaining.pop();
      }
    } else {
      // Full state name? "Utah" → "UT", etc.
      const fullStateMatch = US_STATE_NAMES[last.toLowerCase()];
      if (fullStateMatch) {
        state = fullStateMatch;
        if (!country_iso) country_iso = "US";
        remaining.pop();
      }
    }
  }

  // ─── City (now last token, after country + state stripped) ───
  // City must look like a city name: starts with a letter, contains NO
  // digits (digits = street numbers = address fragment). When the last
  // token has digits it's an address-string with no comma before the
  // city; the actual city is then unrecoverable structurally and we
  // leave city undefined (caller can fall back to feed-default).
  // Without this guard, "1321 East 3300 South  Millcreek" gets eaten as
  // city, leaving venue_name unset → fragmentation. (slc-wasatch real case.)
  if (remaining.length > 0) {
    const lastToken = remaining[remaining.length - 1]!;
    const looksLikeCity =
      /^[A-Za-z]/.test(lastToken) && !/\d/.test(lastToken);
    if (looksLikeCity) {
      // Strip parenthetical content ("Midvale (old town)" → "Midvale").
      // Common in source text where operators tag area / building info.
      let cityCandidate = lastToken.replace(/\s*\([^)]*\)\s*$/, "").trim();
      // Apply alias map (SLC → Salt Lake City, etc.) BEFORE assignment
      // so dedup keys match feed defaults / canonical forms.
      const aliasMatch = CITY_ALIASES[cityCandidate.toLowerCase()];
      if (aliasMatch) cityCandidate = aliasMatch;
      city = cityCandidate;
      remaining.pop();
    }
    // If last token has digits, leave it in remaining as part of address.
  }

  // ─── Venue name + address (remaining 0/1/2+ tokens at the front) ───
  // Heuristic: first token is a venue name if it starts with a letter and
  // has no leading digit (digits = street number = address). Multiple
  // address tokens (e.g., "123 Main St", "Suite 6") get joined.
  // SINGLE-token case (changed 2026-04-25): when only ONE token remains
  // and it looks like a venue name (alpha-leading, no digit-leading),
  // treat as venue_name not address. Real venue strings often look like
  // "Studio Name, City, ST" with NO street address; without this rule,
  // the venue gets dropped into the address slot and lost from dedup.
  if (remaining.length > 0) {
    const first = remaining[0]!;
    const looksLikeVenue =
      /^[A-Za-z]/.test(first) && !/^\d/.test(first);
    if (looksLikeVenue && remaining.length > 1) {
      venue_name = first;
      address = remaining.slice(1).join(", ");
    } else if (looksLikeVenue) {
      // Single token, looks like a venue name — venue with no street address.
      venue_name = first;
    } else {
      address = remaining.join(", ");
    }
  }

  // ─── Apply defaults for fields not extracted from text ───
  // Critical for venue dedup: when the parser can't extract a city,
  // using the feed's default city collapses many "no-city" venues into
  // ONE per-feed bucket instead of fragmenting per address-text variant.
  // (Harvey's gcal-harvest pattern; see harvester/scripts/gcal-harvest.ts:513.)
  if (!city && defaults.city) city = defaults.city;
  if (!state && defaults.state) state = defaults.state;
  if (!country_iso && defaults.country) country_iso = defaults.country;

  // ─── Build the structured geocode query ───
  // Skip venue_name to avoid Nominatim trying to match it as a place.
  const queryParts = [address, city, state, country_iso].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const geocode_query = queryParts.length > 0 ? queryParts.join(", ") : raw;

  const result: ParsedLocation = { geocode_query, raw_text: raw };
  if (venue_name) result.venue_name = venue_name;
  if (address) result.address = address;
  if (city) result.city = city;
  if (state) result.state = state;
  if (country_iso) result.country_iso = country_iso;
  return result;
}
