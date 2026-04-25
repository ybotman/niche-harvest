// core/geocoder/nominatim.ts — cache-first Nominatim geocoder.
//
// Authority: ARCHITECTURE.md §2 (core/geocoder/), LOADER-CONTRACT.md §3
// (venues need lat/lng), niche.yaml geocode block (trusted_country_codes,
// reject_country_codes, text_distance_bound_km).
//
// Hard rules per LOADER-CONTRACT + memory `feedback_no_location_fallback`:
//   - Geocode failure = null lat/lng + reject_reason. NEVER substitute a
//     fallback country/city just to satisfy "must have something."
//   - Result OUTSIDE trusted_country_codes → reject (unless trusted_only=false
//     for a specific call).
//   - Result IN reject_country_codes → reject hard.
//
// Nominatim ToS:
//   - Max 1 request/sec — we enforce 1100ms between requests.
//   - User-Agent must identify the application — set "niche-harvest/0.1
//     (https://github.com/ybotman/niche-harvest)".
//   - Cache responses aggressively to reduce load on the public service.
//
// Cache shape: data/<niche>/geocode-cache/<sha256>.json
// One file per query (text-normalized SHA256 hash of the query). Cached
// responses live forever — locations don't change. Add a `?force` knob if
// we ever need to re-geocode.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { join } from "node:path";

import type {
  GeocodeQuery,
  GeocodeResult,
  Geocoder,
  Logger,
  NicheConfig,
} from "../types.ts";
import { PATHS } from "../types.ts";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_RATE_MS = 1100; // 1.1s — generous over the 1 req/sec policy
const USER_AGENT =
  "niche-harvest/0.1 (https://github.com/ybotman/niche-harvest)";

interface NominatimResponse {
  lat: string;
  lon: string;
  display_name: string;
  address?: {
    country_code?: string;
    city?: string;
    state?: string;
    country?: string;
  };
  class?: string;
  type?: string;
  importance?: number;
}

interface CacheEntry {
  query: GeocodeQuery;
  cached_at: string;
  raw: NominatimResponse[] | { error: string };
}

export class NominatimGeocoder implements Geocoder {
  private readonly nicheKey: string;
  private readonly niche: NicheConfig;
  private readonly logger: Logger;
  private lastRequestAt = 0;

  constructor(nicheKey: string, niche: NicheConfig, logger: Logger) {
    this.nicheKey = nicheKey;
    this.niche = niche;
    this.logger = logger;
    const cacheDir = PATHS.geocodeCacheDir(nicheKey);
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  }

  async geocode(q: GeocodeQuery): Promise<GeocodeResult> {
    if (!q.text || q.text.trim().length === 0) {
      return { status: "invalid", reject_reason: "empty_query" };
    }

    // ─── Cache check ───
    const cached = this.readCache(q);
    if (cached) {
      this.logger.debug("geocode cache hit", { text: q.text.slice(0, 80) });
      return this.evaluateResponse(cached.raw, "cache");
    }

    // ─── Rate-limit gate ───
    await this.rateLimit();

    // ─── HTTP fetch ───
    let response: NominatimResponse[] | { error: string };
    try {
      response = await this.fetchNominatim(q);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("nominatim fetch failed", {
        text: q.text.slice(0, 80),
        error: message,
      });
      // Cache the error so we don't hammer the API on repeat failures.
      this.writeCache(q, { error: message });
      return {
        status: "failed",
        reject_reason: `nominatim_error: ${message}`,
        source: "nominatim",
      };
    }

    // ─── Cache + evaluate ───
    this.writeCache(q, response);
    return this.evaluateResponse(response, "nominatim");
  }

  // ─────────────────────────────────────────────────────────────────────
  // Evaluation: filter by trusted/reject countries, return canonical result
  // ─────────────────────────────────────────────────────────────────────

  private evaluateResponse(
    raw: NominatimResponse[] | { error: string },
    source: "nominatim" | "cache",
  ): GeocodeResult {
    if (!Array.isArray(raw)) {
      return {
        status: "failed",
        reject_reason: `cached_error: ${raw.error}`,
        source,
      };
    }

    if (raw.length === 0) {
      return {
        status: "failed",
        reject_reason: "no_results",
        source,
      };
    }

    // Pick the highest-importance result.
    const best = raw.slice().sort(
      (a, b) => (b.importance ?? 0) - (a.importance ?? 0),
    )[0]!;
    const cc = (best.address?.country_code ?? "").toUpperCase();

    // Hard reject countries always fail.
    if (cc && this.niche.geocode.reject_country_codes.includes(cc)) {
      return {
        status: "invalid",
        reject_reason: `country_rejected:${cc}`,
        source,
      };
    }

    // Trusted-country gate — accept ONLY in-list (per LOADER-CONTRACT
    // no-fallback rule + niche.yaml trusted_country_codes).
    if (cc && !this.niche.geocode.trusted_country_codes.includes(cc)) {
      return {
        status: "invalid",
        reject_reason: `country_untrusted:${cc}`,
        source,
        display_name: best.display_name,
      };
    }

    const lat = Number(best.lat);
    const lng = Number(best.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return {
        status: "invalid",
        reject_reason: "lat_lng_unparseable",
        source,
      };
    }

    return {
      status: "geocoded",
      lat,
      lng,
      display_name: best.display_name,
      country_code: cc,
      source,
      hint_distance_km: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Cache file IO
  // ─────────────────────────────────────────────────────────────────────

  private cachePath(q: GeocodeQuery): string {
    const norm = `${q.text.trim().toLowerCase()}|${q.cityHint ?? ""}|${q.stateHint ?? ""}|${q.countryHint ?? ""}`;
    const hash = createHash("sha256").update(norm, "utf8").digest("hex");
    return join(PATHS.geocodeCacheDir(this.nicheKey), `${hash}.json`);
  }

  private readCache(q: GeocodeQuery): CacheEntry | null {
    const path = this.cachePath(q);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
    } catch {
      return null;
    }
  }

  private writeCache(
    q: GeocodeQuery,
    raw: NominatimResponse[] | { error: string },
  ): void {
    const entry: CacheEntry = {
      query: q,
      cached_at: new Date().toISOString(),
      raw,
    };
    writeFileSync(this.cachePath(q), JSON.stringify(entry, null, 2));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Rate limit (1.1s min between requests)
  // ─────────────────────────────────────────────────────────────────────

  private async rateLimit(): Promise<void> {
    const since = Date.now() - this.lastRequestAt;
    if (since < NOMINATIM_RATE_MS) {
      await new Promise((res) => setTimeout(res, NOMINATIM_RATE_MS - since));
    }
    this.lastRequestAt = Date.now();
  }

  // ─────────────────────────────────────────────────────────────────────
  // HTTP fetch
  // ─────────────────────────────────────────────────────────────────────

  private fetchNominatim(q: GeocodeQuery): Promise<NominatimResponse[]> {
    const params = new URLSearchParams({
      q: q.text,
      format: "json",
      addressdetails: "1",
      limit: "5",
    });
    if (q.countryHint) {
      params.set("countrycodes", q.countryHint.toLowerCase());
    }
    const url = `${NOMINATIM_BASE}?${params.toString()}`;

    return new Promise((resolve, reject) => {
      const req = httpsGet(
        url,
        {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} from nominatim`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              const body = Buffer.concat(chunks).toString("utf-8");
              const json = JSON.parse(body);
              if (!Array.isArray(json)) {
                reject(new Error("nominatim returned non-array"));
                return;
              }
              resolve(json as NominatimResponse[]);
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.setTimeout(20_000, () => {
        req.destroy();
        reject(new Error("timeout fetching nominatim"));
      });
    });
  }
}
