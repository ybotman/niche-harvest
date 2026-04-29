// core/types.ts — shared types + path constants for niche-harvest core.
//
// Authority: ARCHITECTURE.md §4 (adapter interface), niches/<niche>/niche.yaml
// (config shape), LOADER-CONTRACT.md (downstream contracts referenced).
//
// Scope discipline:
//   - This file declares ONLY niche-agnostic types. No tango strings.
//   - FB-specific interfaces (RateLimiter / BlockDetector / HubClient) are
//     deferred to Phase 6; not yet declared here.
//   - Loader interfaces live in core/loader/interface.ts (not here).
//   - SQLite row types live alongside core/store.ts (not here).

import path from "node:path";

// ──────────────────────────────────────────────────────────────────────────
// Path constants — all runtime data is namespaced per niche under data/{key}/
// ──────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

export const PATHS = {
  repoRoot: REPO_ROOT,
  dataRoot: path.join(REPO_ROOT, "data"),
  nichesRoot: path.join(REPO_ROOT, "niches"),

  /** SQLite file for a niche: data/<niche>/harvest.sqlite */
  nicheSqlite: (nicheKey: string) =>
    path.join(REPO_ROOT, "data", nicheKey, "harvest.sqlite"),

  /** Geocode cache root for a niche: data/<niche>/geocode-cache/ */
  geocodeCacheDir: (nicheKey: string) =>
    path.join(REPO_ROOT, "data", nicheKey, "geocode-cache"),

  /** Scrape artifact root for a niche: data/<niche>/artifacts/ */
  artifactsDir: (nicheKey: string) =>
    path.join(REPO_ROOT, "data", nicheKey, "artifacts"),

  /** Snapshot root for a niche: data/<niche>/snapshots/ */
  snapshotsDir: (nicheKey: string) =>
    path.join(REPO_ROOT, "data", nicheKey, "snapshots"),

  /** Watchdog state shared across niches on the same host */
  watchdogDir: path.join(REPO_ROOT, "data", "watchdog"),

  /** niche.yaml path for a niche key */
  nicheYaml: (nicheKey: string) =>
    path.join(REPO_ROOT, "niches", nicheKey, "niche.yaml"),
} as const;

// ──────────────────────────────────────────────────────────────────────────
// niche.yaml shape (parsed) — mirrors the locked schema in niches/tango/niche.yaml.
// Universal across niches; semantic VALUES are per-niche.
// ──────────────────────────────────────────────────────────────────────────

export type DurationGroup = "SHORT" | "LONG" | "NEUTRAL";

export interface CategoryConfig {
  name: string;
  duration_group: DurationGroup;
  loadable: boolean;
  travel_worthy_eligible: boolean;
  beginner_eligible: boolean;
}

export interface RenderedAttributeConfig {
  name: string;
  label: string;
  kind: "string" | "number" | "boolean";
}

export interface IdentityCheckConfig {
  require_min_signals: number;
  positive_keywords: string[];
  negative_keywords: string[];
}

export interface TaxonomyConfig {
  identity_check: IdentityCheckConfig;
  categories: CategoryConfig[];
  rendered_attributes: RenderedAttributeConfig[];
  internal_only_attributes: string[];
}

export interface GeocodeConfig {
  trusted_country_codes: string[];
  reject_country_codes: string[];
  text_distance_bound_km: number;
}

export interface LoaderConfig {
  load_classes: boolean;
  discovery_source: string;
  trust_level: string;
  mongo_env: "test" | "prod" | "devl";
  batch_size: number;
}

export interface PersonaConfig {
  runtime_name: string;
  runtime_port: number;
}

/** Source-type discriminator — matches adapter registry keys (ARCHITECTURE §4.1). */
export type AdapterKey =
  | "ical"
  | "web-tangomango"
  | "web-nytango"
  | "web-tec"
  | "web-generic"
  | "fb-group";

export interface SourceConfigBase {
  name: string;
  display_name?: string;
  url: string;
  adapter: AdapterKey;
  trusted: boolean;
  priority: "high" | "normal" | "low" | "dormant";
  check_interval_days: number;
  notes?: string;
  /**
   * Per-source location defaults (Harvey's gcal-harvest pattern). When the
   * source's location text is sparse (no city/state extractable), parser
   * falls back to these. Use when the feed is geographically scoped — a
   * Salt Lake tango calendar legitimately defaults to Salt Lake City / UT
   * without being a "fallback" violation per LOADER no-fallback rule
   * (the source IS scoped to that geography).
   */
  location_default?: {
    city?: string;
    state?: string;
    country?: string;
  };
}

export interface IcalSourceConfig extends SourceConfigBase {
  adapter: "ical";
  timezone_hint?: string;
}

export interface WebSourceConfig extends SourceConfigBase {
  adapter: "web-tangomango" | "web-nytango" | "web-tec" | "web-generic";
}

export interface FbGroupSourceConfig extends SourceConfigBase {
  adapter: "fb-group";
  group_id: string;
  booker_score?: number;
  events_synced_historical?: number;
  events_produced_historical?: number;
}

export type SourceConfig =
  | IcalSourceConfig
  | WebSourceConfig
  | FbGroupSourceConfig;

export interface SourcesConfig {
  ical_feeds: IcalSourceConfig[];
  web_pages: WebSourceConfig[];
  facebook_groups: FbGroupSourceConfig[];
}

export interface NicheConfig {
  niche: {
    key: string;
    display_name: string;
    appid: number;
    language_default: string;
    description?: string;
  };
  persona: PersonaConfig;
  taxonomy: TaxonomyConfig;
  geocode: GeocodeConfig;
  loader: LoaderConfig;
  sources: SourcesConfig;
}

// ──────────────────────────────────────────────────────────────────────────
// Adapter contract (ARCHITECTURE §4)
// RawEvent shape includes timezone_hint + source_rrule pass-through per
// Fulton 2026-04-25 (LOADER-CONTRACT §10 + §11.4 fallback paths).
// ──────────────────────────────────────────────────────────────────────────

export interface RawEvent {
  /** Adapter-stable id within the source (used for fingerprint pre-input). */
  source_event_id: string;
  raw_title: string;

  /** Human-readable date text as scraped (e.g. "Sat Apr 26, 8pm"). */
  raw_date_text?: string;

  /** Computed start in UTC ISO 8601 if the adapter can resolve reliably. */
  start_dt_iso?: string;
  /** Computed end in UTC ISO 8601 if the adapter can resolve reliably. */
  end_dt_iso?: string;

  raw_location_text?: string;
  raw_description?: string;
  raw_organizer_text?: string;
  raw_url?: string;

  /**
   * Source-side timezone hint (iCal TZID, FB venue address). LOADER-CONTRACT
   * §11.4 fallback path: only the adapter sees this signal, so it MUST flow
   * through if present. Adapter does NOT compute timezone.
   */
  timezone_hint?: string;

  /**
   * Source-original RRULE string if the source provides one (iCal VEVENT).
   * Pass verbatim; classify.ts validates and canonicalizes per
   * LOADER-CONTRACT §10.3. Do NOT reformulate at adapter time.
   */
  source_rrule?: string;

  /** Full source payload for forensics / re-extraction. */
  raw_json?: unknown;
}

export interface AdapterError {
  /** Non-fatal issue worth logging. Errors that abort fetch should throw. */
  message: string;
  detail?: unknown;
}

export interface RawEventBatch {
  /** Matches sources.name in niche.yaml. */
  sourceId: string;
  /** ISO 8601 UTC timestamp of fetch start. */
  fetchedAt: string;
  events: RawEvent[];
  errors: AdapterError[];
  stats: { found: number; fetched: number; skipped: number };
}

export interface AdapterContext {
  /** Niche-agnostic logger (structured JSON-per-line). */
  logger: Logger;
  /** True = adapter must NOT make network writes (read-only fetches OK). */
  dryRun: boolean;
  /** Geocoder is wired in Phase 1+ enrichment; not all adapters use it directly. */
  geocoder?: Geocoder;
}

export interface SourceAdapter {
  /** Registry key; matches niche.yaml source.adapter. */
  readonly name: AdapterKey;
  fetch(
    source: SourceConfig,
    niche: NicheConfig,
    ctx: AdapterContext,
  ): Promise<RawEventBatch>;
}

// ──────────────────────────────────────────────────────────────────────────
// Geocoder (Phase 1+; cache-first Nominatim wrapper lives in core/geocoder/)
// ──────────────────────────────────────────────────────────────────────────

export interface GeocodeQuery {
  /** Freeform location text from the source. */
  text: string;
  /** City/state hints if known; used for text_distance_bound_km validation. */
  cityHint?: string;
  stateHint?: string;
  countryHint?: string;
}

export interface GeocodeResult {
  status: "geocoded" | "failed" | "invalid";
  lat?: number;
  lng?: number;
  display_name?: string;
  country_code?: string;
  /** Distance from cityHint+stateHint if computable; null when no hint. */
  hint_distance_km?: number | null;
  /** Source of the value: 'nominatim' for live API, 'cache' for disk hit. */
  source?: "nominatim" | "cache";
  /** Reason for failed/invalid status (geocode_failed, distance_bound, country_reject, etc.). */
  reject_reason?: string;
}

export interface Geocoder {
  geocode(q: GeocodeQuery): Promise<GeocodeResult>;
}

// ──────────────────────────────────────────────────────────────────────────
// Logger — structured JSON-per-line per ARCHITECTURE §9.1
// ──────────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  niche?: string;
  source_id?: string;
  event_id?: string | number;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a child logger that merges the given context into every emit. */
  child(context: LogContext): Logger;
}

// ──────────────────────────────────────────────────────────────────────────
// Quality flags (LOADER-CONTRACT §12.2 canonical reasons; subset M1 surfaces)
// ──────────────────────────────────────────────────────────────────────────

export type QualityFlagReason =
  | "no_venue"
  | "venue_invalid"
  | "geocode_failed"
  | "rrule_invalid"
  | "timezone_unknown"
  | "date_invalid"
  | "date_past"
  | "short_long_mix"
  | "duration_reassigned"
  | "duration_ceiling_exceeded"
  | "city_unresolved"
  | "category_id_unknown"
  | "fb_blocked"
  | "fb_session_expired"
  | "fb_private_venue"
  | "rate_limited"
  | "unclassified_failure";

export type SkipReason =
  | "skip_class_only"
  | "skip_performance"
  | "skip_trip"
  | "skip_unknown";
