// core/loader/categories.ts — cache-warm BE's categories collection.
//
// Authority: LOADER-CONTRACT.md §6.4 (categoryFirstId resolution at insert
// time via cache-warmed Map). AIDI Phase 3 gate item #2: categoryFirstId
// must resolve against live BE before first event insert.
//
// Endpoint: GET <BE_URL>/api/categories?appId=<N>&limit=500 (anonymous).
// Response shape verified by Fulton 2026-04-25:
//   { categories: [{_id, categoryName, appId, ...}], pagination: {...} }
//
// Cross-niche note: categories are appId-scoped. For appId=99 isolation
// testing, we cache-warm against ?appId=1 (the real tango categories);
// events written under appId=99 reference the appId=1 category ObjectIds.
// FE filters on appId=1 so test events stay invisible; cleanup unaffected.

import type { Logger } from "../types.ts";

const DEFAULT_BE_TEST_URL = "https://calendarbeaf-test.azurewebsites.net";

interface CategoryDoc {
  _id: string;
  categoryName: string;
  appId: number;
}

interface CategoriesResponse {
  categories: CategoryDoc[];
  pagination?: { total: number; page: number; limit: number; pages: number };
}

export interface CategoryCache {
  /** Map from categoryName ("Milonga", "Festival", ...) to BE-side ObjectId string. */
  byName: Map<string, string>;
  /** Source-of-truth: the appId scope we warmed against. */
  appId: number;
  /** BE URL that served the response. */
  beUrl: string;
  /** When the cache was populated (warm at batch start; cache lives for batch). */
  warmedAt: string;
}

export interface WarmOpts {
  beUrl?: string;       // default: DEFAULT_BE_TEST_URL
  appId?: number;       // default: 1 (tango)
  limit?: number;       // default: 500
  logger?: Logger;
}

export class CategoryWarmError extends Error {
  readonly status: number | null;
  readonly url: string;
  constructor(message: string, status: number | null, url: string) {
    super(message);
    this.name = "CategoryWarmError";
    this.status = status;
    this.url = url;
  }
}

/**
 * Fetch categories from BE and return a name → ObjectId Map.
 * Anonymous endpoint; no credential needed.
 *
 * Failure modes:
 *  - Network/HTTP error → throws CategoryWarmError; caller decides whether
 *    to abort the load (for live mode: yes — categoryFirstId is required;
 *    for dry-run: report it but continue with null ObjectIds)
 *  - Empty response → returns empty Map (caller emits per-event
 *    `category_id_unknown` quality_flag and excludes from load)
 */
export async function warmCategories(opts: WarmOpts = {}): Promise<CategoryCache> {
  const beUrl = (opts.beUrl ?? DEFAULT_BE_TEST_URL).replace(/\/+$/, "");
  const appId = opts.appId ?? 1;
  const limit = opts.limit ?? 500;
  const url = `${beUrl}/api/categories?appId=${appId}&limit=${limit}`;
  const log = opts.logger;

  log?.debug("warming categories cache", { url });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CategoryWarmError(`fetch failed: ${message}`, null, url);
  }

  if (!response.ok) {
    throw new CategoryWarmError(
      `HTTP ${response.status} ${response.statusText}`,
      response.status,
      url,
    );
  }

  let body: CategoriesResponse;
  try {
    body = (await response.json()) as CategoriesResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CategoryWarmError(`response not JSON: ${message}`, response.status, url);
  }

  if (!Array.isArray(body.categories)) {
    throw new CategoryWarmError(
      `response missing 'categories' array (keys: ${Object.keys(body).join(",")})`,
      response.status,
      url,
    );
  }

  const byName = new Map<string, string>();
  for (const c of body.categories) {
    if (typeof c.categoryName === "string" && typeof c._id === "string") {
      byName.set(c.categoryName, c._id);
    }
  }

  log?.info("categories cache warmed", {
    url,
    appId,
    entries: byName.size,
    sample_names: Array.from(byName.keys()).slice(0, 5),
  });

  return {
    byName,
    appId,
    beUrl,
    warmedAt: new Date().toISOString(),
  };
}

/**
 * Resolve a category name to its ObjectId via the cache.
 * Returns null when the name is unknown — caller emits
 * `category_id_unknown` quality_flag per LOADER-CONTRACT §6.4.
 */
export function resolveCategoryId(
  cache: CategoryCache,
  categoryName: string | null | undefined,
): string | null {
  if (!categoryName) return null;
  return cache.byName.get(categoryName) ?? null;
}
