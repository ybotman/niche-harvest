// core/classify.ts — niche.yaml-driven event classification.
//
// Authority: LOADER-CONTRACT.md §7 (categoryFirst, skip_reason derivation,
// precedence rules, hard rules); niche.yaml `taxonomy.identity_check` +
// `taxonomy.categories` for niche-specific values.
//
// Two responsibilities:
//   1. identityCheck(ev, niche) — "is this even an event for this niche?"
//      Trusted sources skip this gate. Untrusted sources must clear it.
//   2. classify(ev, niche) — derive categoryFirst + skip_reason per
//      LOADER-CONTRACT §7. Pure function; no side effects, no IO.
//
// What this does NOT do (yet):
//   - RRULE expansion (LOADER-CONTRACT §10: one record, FE expands)
//   - Anti-recurrence guard (>24h cannot be recurring) — Phase 2 loader
//   - travel_worthy / for_beginners derivation — Phase 2 loader
//   - Duration validation against duration_group — Phase 2 quality gate
//   - Override field setting — Phase 2 loader

import type {
  CategoryConfig,
  NicheConfig,
  RawEvent,
  SkipReason,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────
// Identity check — niche-membership gate
// ─────────────────────────────────────────────────────────────────────────

export interface IdentityResult {
  passed: boolean;
  positive_signals: number;
  negative_hits: string[];
  reason?: string;
}

/**
 * Apply niche.yaml taxonomy.identity_check rules to a RawEvent.
 * Returns passed=true iff:
 *   - At least one negative_keyword matches → automatic fail
 *   - Otherwise: positive_signal_count >= require_min_signals
 *
 * Trust gate: callers should skip identity_check for `trusted: true`
 * sources (per ARCHITECTURE §3.1 sources.trusted column). This function
 * does not consult trust — caller decides whether to call it.
 */
export function identityCheck(
  ev: RawEvent,
  niche: NicheConfig,
): IdentityResult {
  const ic = niche.taxonomy.identity_check;
  const haystack = combineText(ev).toLowerCase();

  const negativeHits = ic.negative_keywords.filter((kw) =>
    haystack.includes(kw.toLowerCase()),
  );
  if (negativeHits.length > 0) {
    return {
      passed: false,
      positive_signals: 0,
      negative_hits: negativeHits,
      reason: `negative_keyword_match: ${negativeHits.join(", ")}`,
    };
  }

  let positiveCount = 0;
  for (const kw of ic.positive_keywords) {
    if (haystack.includes(kw.toLowerCase())) positiveCount += 1;
  }

  if (positiveCount >= ic.require_min_signals) {
    return { passed: true, positive_signals: positiveCount, negative_hits: [] };
  }
  return {
    passed: false,
    positive_signals: positiveCount,
    negative_hits: [],
    reason: `insufficient_positive_signals: ${positiveCount}<${ic.require_min_signals}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Category classification per LOADER-CONTRACT §7
// ─────────────────────────────────────────────────────────────────────────

export interface ClassifyResult {
  category_first: string | null;
  category_second: string | null;
  category_third: string | null;
  skip_reason: SkipReason | null;
  /** Internal trace of which keywords fired which slot — for debugging */
  trace: { slot: string; matched: string[] }[];
}

/**
 * Derive categoryFirst from RawEvent text per LOADER-CONTRACT §7.
 * Precedence (§7.4):
 *   - Any LONG keyword present → LONG wins; SHORT signals dropped
 *   - No LONG, any SHORT → Milonga > Practica > Class
 *   - No SHORT → Performance > Trip > Unknown
 *
 * skip_reason derivation (§7.3): deterministic from category + niche.yaml
 * loadable flag.
 *
 * What this v1 does NOT do (deferred):
 *   - categorySecond / categoryThird detection (multi-category events).
 *     Returns null today; loader sees null and treats as single-category.
 *   - Combo-event Class-as-Second handling. Will land when we add
 *     multi-slot detection.
 */
export function classify(
  ev: RawEvent,
  niche: NicheConfig,
): ClassifyResult {
  const haystack = combineText(ev).toLowerCase();
  const trace: { slot: string; matched: string[] }[] = [];

  // Build keyword -> CategoryConfig map from niche.yaml
  const cats = niche.taxonomy.categories;
  const longCats = cats.filter((c) => c.duration_group === "LONG");
  const shortCats = cats.filter((c) => c.duration_group === "SHORT");
  const neutralCats = cats.filter((c) => c.duration_group === "NEUTRAL");

  // ─── LONG precedence ───
  const longMatched = matchCategoriesByName(haystack, longCats);
  if (longMatched.length > 0) {
    trace.push({ slot: "LONG", matched: longMatched.map((c) => c.name) });
    const winner = longMatched[0]!;
    return {
      category_first: winner.name,
      category_second: null,
      category_third: null,
      skip_reason: deriveSkipReason(winner, false),
      trace,
    };
  }

  // ─── SHORT precedence: Milonga > Practica > Class ───
  const shortMatched = matchCategoriesByName(haystack, shortCats);
  if (shortMatched.length > 0) {
    trace.push({ slot: "SHORT", matched: shortMatched.map((c) => c.name) });
    const ordered = orderShort(shortMatched);
    const winner = ordered[0]!;
    const isClassOnly =
      winner.name === "Class" && ordered.length === 1;
    return {
      category_first: winner.name,
      category_second: null,
      category_third: null,
      skip_reason: deriveSkipReason(winner, isClassOnly),
      trace,
    };
  }

  // ─── NEUTRAL precedence: Performance > Trip > Unknown ───
  const neutralMatched = matchCategoriesByName(haystack, neutralCats);
  if (neutralMatched.length > 0) {
    trace.push({ slot: "NEUTRAL", matched: neutralMatched.map((c) => c.name) });
    const ordered = orderNeutral(neutralMatched);
    const winner = ordered[0]!;
    return {
      category_first: winner.name,
      category_second: null,
      category_third: null,
      skip_reason: deriveSkipReason(winner, false),
      trace,
    };
  }

  // Default: Unknown if there's an Unknown in the taxonomy; null otherwise.
  const unknown = cats.find((c) => c.name === "Unknown");
  if (unknown) {
    trace.push({ slot: "DEFAULT", matched: [] });
    return {
      category_first: "Unknown",
      category_second: null,
      category_third: null,
      skip_reason: "skip_unknown",
      trace,
    };
  }
  return {
    category_first: null,
    category_second: null,
    category_third: null,
    skip_reason: null,
    trace,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function combineText(ev: RawEvent): string {
  return [
    ev.raw_title ?? "",
    ev.raw_description ?? "",
    ev.raw_location_text ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Match each category by its name as a case-insensitive whole-word substring.
 * Returns the matched CategoryConfig objects in the order they appear in
 * the category list (caller may re-order via precedence rules).
 */
function matchCategoriesByName(
  haystack: string,
  cats: CategoryConfig[],
): CategoryConfig[] {
  const matched: CategoryConfig[] = [];
  for (const c of cats) {
    const needle = c.name.toLowerCase();
    // Word-boundary match: regex with \b on both sides catches "Milonga"
    // but not "Milongueros" (which is a different word). Use simple
    // word-char boundary check instead of \b regex (faster + clearer
    // for single-word category names).
    const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i");
    if (pattern.test(haystack)) matched.push(c);
  }
  return matched;
}

function orderShort(cats: CategoryConfig[]): CategoryConfig[] {
  const order = ["Milonga", "Practica", "Class"];
  return [...cats].sort(
    (a, b) => order.indexOf(a.name) - order.indexOf(b.name),
  );
}

function orderNeutral(cats: CategoryConfig[]): CategoryConfig[] {
  const order = ["Performance", "Trip", "Unknown"];
  return [...cats].sort(
    (a, b) => order.indexOf(a.name) - order.indexOf(b.name),
  );
}

function deriveSkipReason(
  cat: CategoryConfig,
  isClassOnly: boolean,
): SkipReason | null {
  // Per LOADER-CONTRACT §7.3:
  //   IF category == 'Class' AND second/third null AND not loadable: skip_class_only
  //   ELIF category not in loadable set: skip_<lowercase>
  //   ELSE null
  if (cat.loadable) {
    return null;
  }
  if (cat.name === "Class" && isClassOnly) {
    return "skip_class_only";
  }
  const lower = cat.name.toLowerCase();
  if (lower === "performance") return "skip_performance";
  if (lower === "trip") return "skip_trip";
  if (lower === "unknown") return "skip_unknown";
  // Class non-loadable but caller didn't set isClassOnly — shouldn't happen
  // since loader.load_classes false + Class-only = skip_class_only above.
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
