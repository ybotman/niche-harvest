// core/config.ts — niche.yaml loader.
//
// Authority: niches/<niche>/niche.yaml (the niche definition contract).
// ARCHITECTURE.md §2 module map; LOADER-CONTRACT.md §16.5 (cross-niche
// abstraction points the loader exposes).
//
// Validation philosophy: fail loudly at load time. Every required field
// gets validated; defaults applied where the niche.yaml schema sanctions
// them; unknown source adapters rejected.

import { readFileSync } from "node:fs";
import yaml from "js-yaml";

import type {
  AdapterKey,
  CategoryConfig,
  DurationGroup,
  FbGroupSourceConfig,
  IcalSourceConfig,
  NicheConfig,
  WebSourceConfig,
} from "./types.ts";
import { PATHS } from "./types.ts";

const VALID_DURATION_GROUPS: ReadonlySet<DurationGroup> = new Set([
  "SHORT",
  "LONG",
  "NEUTRAL",
]);

const VALID_ADAPTERS: ReadonlySet<AdapterKey> = new Set([
  "ical",
  "web-tangomango",
  "web-nytango",
  "web-tec",
  "web-generic",
  "fb-group",
]);

const VALID_PRIORITY: ReadonlySet<string> = new Set([
  "high",
  "normal",
  "low",
  "dormant",
]);

const VALID_MONGO_ENV: ReadonlySet<string> = new Set(["test", "prod", "devl"]);

export class NicheConfigError extends Error {
  readonly nichePath: string;
  constructor(message: string, nichePath: string) {
    super(`niche.yaml validation failed (${nichePath}): ${message}`);
    this.name = "NicheConfigError";
    this.nichePath = nichePath;
  }
}

/**
 * Load and validate niches/<key>/niche.yaml.
 * Throws NicheConfigError on any validation failure.
 */
export function loadNiche(nicheKey: string): NicheConfig {
  const yamlPath = PATHS.nicheYaml(nicheKey);
  const raw = readFileSync(yamlPath, "utf8");
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new NicheConfigError("top-level document is not an object", yamlPath);
  }
  return validate(parsed as Record<string, unknown>, yamlPath);
}

/**
 * Validate an already-parsed object as a NicheConfig. Exposed for tests
 * and for cases where the YAML text is sourced from somewhere other than
 * the canonical filesystem path.
 */
export function validate(
  obj: Record<string, unknown>,
  contextPath: string,
): NicheConfig {
  const fail = (msg: string): never => {
    throw new NicheConfigError(msg, contextPath);
  };

  // ─── niche ───
  const niche = obj.niche as Record<string, unknown> | undefined;
  if (!niche) fail("missing top-level `niche`");
  const nicheKey = requireString(niche!, "niche.key", fail);
  const displayName = requireString(niche!, "niche.display_name", fail);
  const appid = requireNumber(niche!, "niche.appid", fail);
  const langDefault = requireString(niche!, "niche.language_default", fail);
  const description = optionalString(niche!, "niche.description");

  // ─── persona ───
  const persona = obj.persona as Record<string, unknown> | undefined;
  if (!persona) fail("missing top-level `persona`");
  const runtimeName = requireString(persona!, "persona.runtime_name", fail);
  const runtimePort = requireNumber(persona!, "persona.runtime_port", fail);

  // ─── taxonomy ───
  const taxonomy = obj.taxonomy as Record<string, unknown> | undefined;
  if (!taxonomy) fail("missing top-level `taxonomy`");

  // identity_check
  const ic = taxonomy!.identity_check as Record<string, unknown> | undefined;
  if (!ic) fail("missing taxonomy.identity_check");
  const identityCheck = {
    require_min_signals: requireNumber(
      ic!,
      "taxonomy.identity_check.require_min_signals",
      fail,
    ),
    positive_keywords: requireStringArray(
      ic!,
      "taxonomy.identity_check.positive_keywords",
      fail,
    ),
    negative_keywords: requireStringArray(
      ic!,
      "taxonomy.identity_check.negative_keywords",
      fail,
    ),
  };

  // categories
  const rawCats = taxonomy!.categories;
  if (!Array.isArray(rawCats) || rawCats.length === 0) {
    fail("taxonomy.categories must be a non-empty array");
  }
  const categories: CategoryConfig[] = (rawCats as unknown[]).map((c, i) => {
    if (!c || typeof c !== "object") {
      fail(`taxonomy.categories[${i}] is not an object`);
    }
    const cat = c as Record<string, unknown>;
    const dg = requireString(cat, `taxonomy.categories[${i}].duration_group`, fail);
    if (!VALID_DURATION_GROUPS.has(dg as DurationGroup)) {
      fail(
        `taxonomy.categories[${i}].duration_group invalid: ${dg} ` +
          `(expected SHORT|LONG|NEUTRAL)`,
      );
    }
    return {
      name: requireString(cat, `taxonomy.categories[${i}].name`, fail),
      duration_group: dg as DurationGroup,
      loadable: requireBoolean(cat, `taxonomy.categories[${i}].loadable`, fail),
      travel_worthy_eligible: requireBoolean(
        cat,
        `taxonomy.categories[${i}].travel_worthy_eligible`,
        fail,
      ),
      beginner_eligible: requireBoolean(
        cat,
        `taxonomy.categories[${i}].beginner_eligible`,
        fail,
      ),
    };
  });

  // rendered_attributes
  const rawAttrs = taxonomy!.rendered_attributes ?? [];
  if (!Array.isArray(rawAttrs)) {
    fail("taxonomy.rendered_attributes must be an array (or omitted)");
  }
  const renderedAttrs = (rawAttrs as unknown[]).map((a, i) => {
    if (!a || typeof a !== "object") {
      fail(`taxonomy.rendered_attributes[${i}] is not an object`);
    }
    const attr = a as Record<string, unknown>;
    const kind = requireString(
      attr,
      `taxonomy.rendered_attributes[${i}].kind`,
      fail,
    );
    if (kind !== "string" && kind !== "number" && kind !== "boolean") {
      fail(
        `taxonomy.rendered_attributes[${i}].kind invalid: ${kind} ` +
          `(expected string|number|boolean)`,
      );
    }
    return {
      name: requireString(attr, `taxonomy.rendered_attributes[${i}].name`, fail),
      label: requireString(attr, `taxonomy.rendered_attributes[${i}].label`, fail),
      kind: kind as "string" | "number" | "boolean",
    };
  });

  const internalOnly = (taxonomy!.internal_only_attributes ?? []) as unknown;
  if (!Array.isArray(internalOnly)) {
    fail("taxonomy.internal_only_attributes must be an array (or omitted)");
  }

  // ─── geocode ───
  const geocode = obj.geocode as Record<string, unknown> | undefined;
  if (!geocode) fail("missing top-level `geocode`");
  const geocodeConfig = {
    trusted_country_codes: requireStringArray(
      geocode!,
      "geocode.trusted_country_codes",
      fail,
    ),
    reject_country_codes: optionalStringArray(
      geocode!,
      "geocode.reject_country_codes",
    ),
    text_distance_bound_km: requireNumber(
      geocode!,
      "geocode.text_distance_bound_km",
      fail,
    ),
  };

  // ─── loader ───
  const loader = obj.loader as Record<string, unknown> | undefined;
  if (!loader) fail("missing top-level `loader`");
  const mongoEnv = requireString(loader!, "loader.mongo_env", fail);
  if (!VALID_MONGO_ENV.has(mongoEnv)) {
    fail(`loader.mongo_env invalid: ${mongoEnv} (expected test|prod|devl)`);
  }
  const loaderConfig = {
    load_classes: requireBoolean(loader!, "loader.load_classes", fail),
    discovery_source: requireString(loader!, "loader.discovery_source", fail),
    trust_level: requireString(loader!, "loader.trust_level", fail),
    mongo_env: mongoEnv as "test" | "prod" | "devl",
    batch_size: requireNumber(loader!, "loader.batch_size", fail),
  };

  // ─── sources ───
  const sources = obj.sources as Record<string, unknown> | undefined;
  if (!sources) fail("missing top-level `sources`");
  const icalFeeds = ((sources!.ical_feeds ?? []) as unknown[]).map((s, i) =>
    validateSource(s, `sources.ical_feeds[${i}]`, "ical", fail),
  ) as IcalSourceConfig[];
  const webPages = ((sources!.web_pages ?? []) as unknown[]).map((s, i) =>
    validateWebSource(s, `sources.web_pages[${i}]`, fail),
  );
  const fbGroups = ((sources!.facebook_groups ?? []) as unknown[]).map((s, i) =>
    validateFbSource(s, `sources.facebook_groups[${i}]`, fail),
  );

  return {
    niche: {
      key: nicheKey,
      display_name: displayName,
      appid,
      language_default: langDefault,
      ...(description !== undefined ? { description } : {}),
    },
    persona: { runtime_name: runtimeName, runtime_port: runtimePort },
    taxonomy: {
      identity_check: identityCheck,
      categories,
      rendered_attributes: renderedAttrs,
      internal_only_attributes: internalOnly as string[],
    },
    geocode: geocodeConfig,
    loader: loaderConfig,
    sources: {
      ical_feeds: icalFeeds,
      web_pages: webPages,
      facebook_groups: fbGroups,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Source validators (per-adapter discriminator)
// ─────────────────────────────────────────────────────────────────────────

function validateSource(
  s: unknown,
  ctx: string,
  expectedAdapter: AdapterKey | null,
  fail: (msg: string) => never,
): IcalSourceConfig | WebSourceConfig | FbGroupSourceConfig {
  if (!s || typeof s !== "object") fail(`${ctx} is not an object`);
  const src = s as Record<string, unknown>;
  const adapter = requireString(src, `${ctx}.adapter`, fail);
  if (!VALID_ADAPTERS.has(adapter as AdapterKey)) {
    fail(`${ctx}.adapter unknown: ${adapter}`);
  }
  if (expectedAdapter && adapter !== expectedAdapter) {
    fail(`${ctx}.adapter must be "${expectedAdapter}" (got "${adapter}")`);
  }
  const priority = requireString(src, `${ctx}.priority`, fail);
  if (!VALID_PRIORITY.has(priority)) {
    fail(`${ctx}.priority invalid: ${priority} (expected high|normal|low|dormant)`);
  }
  const base = {
    name: requireString(src, `${ctx}.name`, fail),
    url: requireString(src, `${ctx}.url`, fail),
    adapter: adapter as AdapterKey,
    trusted: requireBoolean(src, `${ctx}.trusted`, fail),
    priority: priority as "high" | "normal" | "low" | "dormant",
    check_interval_days: requireNumber(src, `${ctx}.check_interval_days`, fail),
    ...(typeof src.display_name === "string"
      ? { display_name: src.display_name }
      : {}),
    ...(typeof src.notes === "string" ? { notes: src.notes } : {}),
  };
  if (adapter === "ical") {
    return {
      ...base,
      adapter: "ical",
      ...(typeof src.timezone_hint === "string"
        ? { timezone_hint: src.timezone_hint }
        : {}),
    } as IcalSourceConfig;
  }
  return base as WebSourceConfig | FbGroupSourceConfig;
}

function validateWebSource(
  s: unknown,
  ctx: string,
  fail: (msg: string) => never,
): WebSourceConfig {
  const v = validateSource(s, ctx, null, fail);
  if (v.adapter === "ical" || v.adapter === "fb-group") {
    fail(`${ctx}.adapter must be web-* (got "${v.adapter}")`);
  }
  return v as WebSourceConfig;
}

function validateFbSource(
  s: unknown,
  ctx: string,
  fail: (msg: string) => never,
): FbGroupSourceConfig {
  if (!s || typeof s !== "object") fail(`${ctx} is not an object`);
  const v = validateSource(s, ctx, "fb-group", fail) as FbGroupSourceConfig;
  const src = s as Record<string, unknown>;
  return {
    ...v,
    group_id: requireString(src, `${ctx}.group_id`, fail),
    ...(typeof src.booker_score === "number"
      ? { booker_score: src.booker_score }
      : {}),
    ...(typeof src.events_synced_historical === "number"
      ? { events_synced_historical: src.events_synced_historical }
      : {}),
    ...(typeof src.events_produced_historical === "number"
      ? { events_produced_historical: src.events_produced_historical }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Type guards / extractors
// ─────────────────────────────────────────────────────────────────────────

function requireString(
  obj: Record<string, unknown>,
  path: string,
  fail: (msg: string) => never,
): string {
  const key = path.split(".").pop()!;
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    fail(`${path} must be a non-empty string (got ${typeof v})`);
  }
  return v as string;
}

function optionalString(
  obj: Record<string, unknown>,
  path: string,
): string | undefined {
  const key = path.split(".").pop()!;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function requireNumber(
  obj: Record<string, unknown>,
  path: string,
  fail: (msg: string) => never,
): number {
  const key = path.split(".").pop()!;
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${path} must be a finite number (got ${typeof v})`);
  }
  return v as number;
}

function requireBoolean(
  obj: Record<string, unknown>,
  path: string,
  fail: (msg: string) => never,
): boolean {
  const key = path.split(".").pop()!;
  const v = obj[key];
  if (typeof v !== "boolean") {
    fail(`${path} must be a boolean (got ${typeof v})`);
  }
  return v as boolean;
}

function requireStringArray(
  obj: Record<string, unknown>,
  path: string,
  fail: (msg: string) => never,
): string[] {
  const key = path.split(".").pop()!;
  const v = obj[key];
  if (!Array.isArray(v)) fail(`${path} must be an array of strings`);
  v.forEach((item, i) => {
    if (typeof item !== "string") {
      fail(`${path}[${i}] must be a string (got ${typeof item})`);
    }
  });
  return v as string[];
}

function optionalStringArray(
  obj: Record<string, unknown>,
  path: string,
): string[] {
  const key = path.split(".").pop()!;
  const v = obj[key];
  if (v == null) return [];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
