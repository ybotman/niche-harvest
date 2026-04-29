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
  /**
   * Soft duration flag per LOADER-CONTRACT §7.2 (Harvey 2026-04-29 revision).
   * null = no issue. Non-null = informational flag only — event still loads.
   * Two cases:
   *   "duration_reassigned" — keyword category conflicted with duration; category
   *     was re-assigned (e.g. SHORT+72h → Workshop). original_category records
   *     the pre-reassignment name.
   *   "duration_ceiling_exceeded" — duration exceeds per-category max ceiling
   *     (Festival 240h, Marathon 120h, Encuentro 96h, Workshop 72h).
   * Replaces the old hard-drop duration_violation.
   */
  duration_flag: DurationFlag | null;
  /** Computed duration in hours; null if dates not parseable. */
  duration_hours: number | null;
}

export interface DurationFlag {
  kind: "duration_reassigned" | "duration_ceiling_exceeded";
  detail: string;
  /** Category name before re-assignment (set for duration_reassigned). */
  original_category?: string;
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
  const durationHours = computeDurationHours(ev);

  const cats = niche.taxonomy.categories;
  const longCats = cats.filter((c) => c.duration_group === "LONG");
  const shortCats = cats.filter((c) => c.duration_group === "SHORT");
  const neutralCats = cats.filter((c) => c.duration_group === "NEUTRAL");

  const make = (
    categoryFirst: string | null,
    skipReason: SkipReason | null,
    durationFlag: DurationFlag | null = null,
  ): ClassifyResult => ({
    category_first: categoryFirst,
    category_second: null,
    category_third: null,
    skip_reason: skipReason,
    trace,
    duration_hours: durationHours,
    duration_flag: durationFlag,
  });

  const longMatched = matchCategoriesByName(haystack, longCats);
  const shortMatched = matchCategoriesByName(haystack, shortCats);

  // ─── LONG keyword match ───
  if (longMatched.length > 0) {
    trace.push({ slot: "LONG", matched: longMatched.map((c) => c.name) });
    const longWinner = longMatched[0]!;

    // Case B: both LONG and SHORT keywords present + duration clearly SHORT →
    // duration tips the scale to SHORT (Harvey 2026-04-29).
    if (shortMatched.length > 0 && durationHours !== null && durationHours < HOURS_24) {
      trace.push({ slot: "SHORT_BY_DURATION", matched: shortMatched.map((c) => c.name) });
      const shortWinner = orderShort(shortMatched)[0]!;
      return make(shortWinner.name, deriveSkipReason(shortWinner, false), null);
    }

    // Case A: LONG keyword but duration is SHORT → re-assign to best SHORT.
    // Keeps LONG with flag if no SHORT keywords exist (name says LONG; duration
    // may be a data quality issue rather than misclassification).
    if (durationHours !== null && durationHours < HOURS_24) {
      if (shortMatched.length > 0) {
        const shortWinner = orderShort(shortMatched)[0]!;
        trace.push({ slot: "REASSIGN_LONG_TO_SHORT", matched: [shortWinner.name] });
        return make(shortWinner.name, deriveSkipReason(shortWinner, false), {
          kind: "duration_reassigned",
          detail: `LONG '${longWinner.name}' (${durationHours.toFixed(1)}h) < 24h; re-assigned to ${shortWinner.name}`,
          original_category: longWinner.name,
        });
      }
      // No SHORT keyword backup — keep LONG, soft flag for review.
      return make(longWinner.name, deriveSkipReason(longWinner, false), {
        kind: "duration_reassigned",
        detail: `LONG '${longWinner.name}' (${durationHours.toFixed(1)}h) < 24h; no SHORT keyword to re-assign to — manual review`,
        original_category: longWinner.name,
      });
    }

    // Normal LONG — check per-category ceiling (soft).
    return make(longWinner.name, deriveSkipReason(longWinner, false), checkCeiling(longWinner.name, durationHours));
  }

  // ─── SHORT keyword match ───
  if (shortMatched.length > 0) {
    trace.push({ slot: "SHORT", matched: shortMatched.map((c) => c.name) });
    const ordered = orderShort(shortMatched);
    const shortWinner = ordered[0]!;
    const isClassOnly = shortWinner.name === "Class" && ordered.length === 1;

    // Case A: SHORT keyword but duration is LONG → re-assign to Workshop
    // (most generic LONG default). longMatched is empty here — if there were
    // LONG keywords we'd have entered the LONG branch above, not this one.
    if (durationHours !== null && durationHours >= HOURS_24) {
      const reassignTo = cats.find((c) => c.name === "Workshop") ?? null;
      if (reassignTo) {
        trace.push({ slot: "REASSIGN_SHORT_TO_LONG", matched: [reassignTo.name] });
        const flag: DurationFlag = {
          kind: "duration_reassigned",
          detail: `SHORT '${shortWinner.name}' (${durationHours.toFixed(1)}h) >= 24h; re-assigned to ${reassignTo.name}`,
          original_category: shortWinner.name,
        };
        // Also check ceiling on the re-assigned LONG category.
        const ceilingFlag = checkCeiling(reassignTo.name, durationHours);
        return make(reassignTo.name, deriveSkipReason(reassignTo, false), ceilingFlag ?? flag);
      }
    }

    return make(shortWinner.name, deriveSkipReason(shortWinner, isClassOnly), null);
  }

  // ─── NEUTRAL precedence: Performance > Trip > Unknown ───
  const neutralMatched = matchCategoriesByName(haystack, neutralCats);
  if (neutralMatched.length > 0) {
    trace.push({ slot: "NEUTRAL", matched: neutralMatched.map((c) => c.name) });
    const winner = orderNeutral(neutralMatched)[0]!;
    return make(winner.name, deriveSkipReason(winner, false), null);
  }

  // Default: Unknown if defined in the taxonomy; null otherwise.
  const unknown = cats.find((c) => c.name === "Unknown");
  if (unknown) {
    trace.push({ slot: "DEFAULT", matched: [] });
    return make("Unknown", "skip_unknown", null);
  }
  return make(null, null, null);
}

// ─────────────────────────────────────────────────────────────────────────
// Duration helpers — per LOADER-CONTRACT §7.2 (Harvey 2026-04-29 revision)
// ─────────────────────────────────────────────────────────────────────────

const HOURS_24 = 24;

// Per-category ceilings (Harvey 2026-04-29). Events exceeding these are
// soft-flagged but still load — they signal misclassification or unusual
// source data, not invalid events.
const CATEGORY_CEILINGS: Record<string, number> = {
  Festival: 240,   // 10 days — multi-day events are the definition
  Marathon: 120,   // 5 days — 8-day "Marathon" is almost certainly a Festival
  Encuentro: 96,   // 4 days
  Workshop: 72,    // 3 days — weekend workshops are the norm
};

function computeDurationHours(ev: RawEvent): number | null {
  if (!ev.start_dt_iso || !ev.end_dt_iso) return null;
  const start = Date.parse(ev.start_dt_iso);
  const end = Date.parse(ev.end_dt_iso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ms = end - start;
  if (ms <= 0) return null;
  return ms / 3_600_000;
}

function checkCeiling(categoryName: string, durationHours: number | null): DurationFlag | null {
  if (durationHours === null) return null;
  const ceiling = CATEGORY_CEILINGS[categoryName];
  if (ceiling === undefined) return null;
  if (durationHours > ceiling) {
    return {
      kind: "duration_ceiling_exceeded",
      detail: `duration ${durationHours.toFixed(1)}h > ${ceiling}h ceiling for ${categoryName}`,
    };
  }
  return null;
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
