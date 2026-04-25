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

export function parseLocation(text: string): ParsedLocation {
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
    }
  }

  // ─── City (now last token, after country + state stripped) ───
  if (remaining.length > 0) {
    city = remaining[remaining.length - 1];
    remaining.pop();
  }

  // ─── Venue name + address (the remaining 0/1/2+ tokens at the front) ───
  // Heuristic: first token is a venue name if it starts with a letter and
  // has no leading digit (digits = street number = address). Multiple
  // address tokens (e.g., "123 Main St", "Suite 6") get joined.
  if (remaining.length > 0) {
    const first = remaining[0]!;
    const looksLikeVenue =
      /^[A-Za-z]/.test(first) && !/^\d/.test(first);
    if (looksLikeVenue && remaining.length > 1) {
      venue_name = first;
      address = remaining.slice(1).join(", ");
    } else {
      address = remaining.join(", ");
    }
  }

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
