// core/adapters/ical.ts — iCalendar (RFC 5545) source adapter.
//
// Authority: ARCHITECTURE.md §4 (SourceAdapter interface). Returns RawEvent[]
// in a RawEventBatch. Pre-classification, pre-geocoding — adapter's only
// responsibility is to fetch the .ics, parse the VEVENT records, and emit
// RawEvent shape with `timezone_hint` + `source_rrule` pass-through fields
// (LOADER-CONTRACT §10 + §11.4 require these flow through from the source).
//
// Pattern source: ai-discovered/harvester/src/adapters/ical.ts (Harvey
// 2026-Q1; runs in production against gcal-feeds.yaml inventory).
// Adapted here for niche-harvest's adapter contract — shape and dependency
// isolation, not a copy.
//
// Zero npm deps; uses node:https + node:http built-ins.

import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";

import type {
  AdapterContext,
  IcalSourceConfig,
  NicheConfig,
  RawEvent,
  RawEventBatch,
  SourceAdapter,
  SourceConfig,
} from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────

interface IcalProperty {
  name: string;
  params: string;
  value: string;
}

interface IcalEvent {
  uid: string;
  summary: string;
  dtstart: string;        // computed ISO 8601 (UTC if Z-suffixed in source, else local-form)
  dtstart_tz?: string;    // TZID from source params, or 'UTC' for Z-suffixed
  dtend?: string;
  dtend_tz?: string;
  location?: string;
  description?: string;
  url?: string;
  organizer?: string;
  geo?: { lat: number; lng: number };
  rrule?: string;         // raw RRULE string from source — verbatim, no canonicalization
  categories?: string;
  status?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────────────────────

export class IcalAdapter implements SourceAdapter {
  readonly name = "ical" as const;

  async fetch(
    source: SourceConfig,
    _niche: NicheConfig,
    ctx: AdapterContext,
  ): Promise<RawEventBatch> {
    if (source.adapter !== "ical") {
      throw new Error(`IcalAdapter received non-ical source: ${source.adapter}`);
    }
    const ical = source as IcalSourceConfig;
    const fetchedAt = new Date().toISOString();
    const log = ctx.logger.child({ source_id: source.name, adapter: "ical" });

    let icsContent: string;
    try {
      log.debug("fetching iCal feed", { url: ical.url });
      icsContent = await fetchUrl(ical.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("iCal fetch failed", { url: ical.url, error: message });
      return {
        sourceId: source.name,
        fetchedAt,
        events: [],
        errors: [{ message: `Fetch failed: ${message}` }],
        stats: { found: 0, fetched: 0, skipped: 0 },
      };
    }

    if (!icsContent.includes("BEGIN:VCALENDAR")) {
      return {
        sourceId: source.name,
        fetchedAt,
        events: [],
        errors: [
          {
            message:
              "Response does not appear to be iCalendar format (no BEGIN:VCALENDAR found)",
          },
        ],
        stats: { found: 0, fetched: 0, skipped: 0 },
      };
    }

    let parsed: IcalEvent[];
    try {
      parsed = parseIcs(icsContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("iCal parse failed", { error: message });
      return {
        sourceId: source.name,
        fetchedAt,
        events: [],
        errors: [{ message: `Parse failed: ${message}` }],
        stats: { found: 0, fetched: 0, skipped: 0 },
      };
    }

    const found = parsed.length;
    const relevant = parsed.filter((e) => isRelevant(e));
    const skipped = found - relevant.length;
    const events: RawEvent[] = relevant.map((e) => toRawEvent(e, ical));

    log.info("iCal feed parsed", {
      found,
      kept: events.length,
      skipped,
    });

    return {
      sourceId: source.name,
      fetchedAt,
      events,
      errors: [],
      stats: { found, fetched: events.length, skipped },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP fetch (node built-ins, redirect-following, timeout)
// ─────────────────────────────────────────────────────────────────────────

function fetchUrl(
  url: string,
  timeoutMs = 30_000,
  redirectsLeft = 3,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith("https") ? httpsGet : httpGet;
    const req = getter(
      url,
      { headers: { "User-Agent": "niche-harvest/0.1" } },
      (res) => {
        // Follow redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          fetchUrl(res.headers.location, timeoutMs, redirectsLeft - 1).then(
            resolve,
            reject,
          );
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf-8")),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms fetching ${url}`));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ICS parser (RFC 5545 subset Google Calendar / community feeds use)
// ─────────────────────────────────────────────────────────────────────────

/** Public for tests only. */
export function parseIcs(icsContent: string): IcalEvent[] {
  const lines = unfoldLines(icsContent);
  const events: IcalEvent[] = [];

  let inEvent = false;
  let current: Partial<IcalEvent> = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      inEvent = false;
      if (current.summary && current.dtstart) {
        events.push({
          uid: current.uid ?? `auto-${events.length}`,
          summary: current.summary,
          dtstart: current.dtstart,
          ...(current.dtstart_tz !== undefined ? { dtstart_tz: current.dtstart_tz } : {}),
          ...(current.dtend !== undefined ? { dtend: current.dtend } : {}),
          ...(current.dtend_tz !== undefined ? { dtend_tz: current.dtend_tz } : {}),
          ...(current.location !== undefined ? { location: current.location } : {}),
          ...(current.description !== undefined ? { description: current.description } : {}),
          ...(current.url !== undefined ? { url: current.url } : {}),
          ...(current.organizer !== undefined ? { organizer: current.organizer } : {}),
          ...(current.geo !== undefined ? { geo: current.geo } : {}),
          ...(current.rrule !== undefined ? { rrule: current.rrule } : {}),
          ...(current.categories !== undefined ? { categories: current.categories } : {}),
          ...(current.status !== undefined ? { status: current.status } : {}),
        });
      }
      continue;
    }
    if (!inEvent) continue;

    const prop = parseProperty(line);
    switch (prop.name) {
      case "UID":
        current.uid = prop.value;
        break;
      case "SUMMARY":
        current.summary = unescapeIcs(prop.value);
        break;
      case "DTSTART": {
        const parsed = parseIcsDate(prop.value, prop.params);
        current.dtstart = parsed.iso;
        if (parsed.timezone) current.dtstart_tz = parsed.timezone;
        break;
      }
      case "DTEND": {
        const parsed = parseIcsDate(prop.value, prop.params);
        current.dtend = parsed.iso;
        if (parsed.timezone) current.dtend_tz = parsed.timezone;
        break;
      }
      case "LOCATION":
        current.location = unescapeIcs(prop.value);
        break;
      case "DESCRIPTION":
        current.description = unescapeIcs(prop.value);
        break;
      case "URL":
        current.url = prop.value;
        break;
      case "ORGANIZER": {
        // ORGANIZER can be: "CN=Name:mailto:email" or just "mailto:email"
        const cnMatch = prop.params.match(/CN=([^;:]+)/i);
        if (cnMatch && cnMatch[1]) {
          current.organizer = cnMatch[1].replace(/^"(.*)"$/, "$1");
        } else {
          current.organizer = prop.value;
        }
        break;
      }
      case "GEO": {
        // GEO:lat;lng
        const parts = prop.value.split(";");
        const lat = Number(parts[0]);
        const lng = Number(parts[1]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          current.geo = { lat, lng };
        }
        break;
      }
      case "RRULE":
        current.rrule = prop.value;
        break;
      case "CATEGORIES":
        current.categories = unescapeIcs(prop.value);
        break;
      case "STATUS":
        current.status = prop.value;
        break;
    }
  }

  return events;
}

// ─────────────────────────────────────────────────────────────────────────
// ICS line unfolding (RFC 5545)
// Long lines are folded with CRLF + whitespace. Unfold by joining.
// ─────────────────────────────────────────────────────────────────────────

function unfoldLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const unfolded = normalized.replace(/\n[ \t]/g, "");
  return unfolded.split("\n").filter((line) => line.trim().length > 0);
}

function parseProperty(line: string): IcalProperty {
  // NAME;PARAM=VAL;PARAM=VAL:VALUE  or  NAME:VALUE
  const colonIdx = line.indexOf(":");
  const semiIdx = line.indexOf(";");
  if (colonIdx === -1) {
    return { name: line, params: "", value: "" };
  }
  if (semiIdx !== -1 && semiIdx < colonIdx) {
    return {
      name: line.slice(0, semiIdx).toUpperCase(),
      params: line.slice(semiIdx + 1, colonIdx),
      value: line.slice(colonIdx + 1),
    };
  }
  return {
    name: line.slice(0, colonIdx).toUpperCase(),
    params: "",
    value: line.slice(colonIdx + 1),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Date parsing — 4 forms supported
//   YYYYMMDDTHHMMSSZ  (UTC)
//   YYYYMMDDTHHMMSS   (floating)
//   YYYYMMDD          (date-only)
//   TZID=America/New_York paramed value
// ─────────────────────────────────────────────────────────────────────────

function parseIcsDate(
  value: string,
  params: string,
): { iso: string; timezone?: string } {
  let tz: string | undefined;
  let raw = value;

  const tzMatch = params.match(/TZID=([^;:]+)/i);
  if (tzMatch && tzMatch[1]) tz = tzMatch[1];

  if (raw.endsWith("Z")) {
    tz = "UTC";
    raw = raw.slice(0, -1);
  }

  if (raw.length === 8) {
    const y = raw.slice(0, 4);
    const m = raw.slice(4, 6);
    const d = raw.slice(6, 8);
    return tz === undefined
      ? { iso: `${y}-${m}-${d}` }
      : { iso: `${y}-${m}-${d}`, timezone: tz };
  }

  if (raw.length >= 15) {
    const y = raw.slice(0, 4);
    const m = raw.slice(4, 6);
    const d = raw.slice(6, 8);
    const hh = raw.slice(9, 11);
    const mm = raw.slice(11, 13);
    const ss = raw.slice(13, 15);
    const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}` +
      (tz === "UTC" ? "Z" : "");
    return tz === undefined ? { iso } : { iso, timezone: tz };
  }

  return tz === undefined ? { iso: raw } : { iso: raw, timezone: tz };
}

function unescapeIcs(text: string): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// ─────────────────────────────────────────────────────────────────────────
// Relevance filter — pre-classify gate
// Skip CANCELLED; keep events in lookback (7d) → lookahead (365d) window;
// always keep RRULE-bearing events (they may recur within window).
// ─────────────────────────────────────────────────────────────────────────

function isRelevant(
  ev: IcalEvent,
  lookbackDays = 7,
  lookaheadDays = 365,
): boolean {
  if (ev.status === "CANCELLED") return false;
  if (ev.rrule) return true; // recurring — always relevant within FE expansion window
  const now = Date.now();
  const lookback = now - lookbackDays * 86_400_000;
  const lookahead = now + lookaheadDays * 86_400_000;
  const t = Date.parse(ev.dtstart);
  if (Number.isNaN(t)) return true; // can't parse date → keep, let enrich handle
  return t >= lookback && t <= lookahead;
}

// ─────────────────────────────────────────────────────────────────────────
// IcalEvent → RawEvent (per types.ts shape; pass-through tz + RRULE)
// ─────────────────────────────────────────────────────────────────────────

function toRawEvent(ev: IcalEvent, source: IcalSourceConfig): RawEvent {
  const dateText = ev.dtstart + (ev.dtend ? ` to ${ev.dtend}` : "");
  // Prefer source-side TZID over the niche.yaml configured fallback.
  const tzHint = ev.dtstart_tz ?? source.timezone_hint;

  return {
    source_event_id: ev.uid,
    raw_title: ev.summary,
    ...(dateText !== "" ? { raw_date_text: dateText } : {}),
    ...(ev.dtstart !== undefined ? { start_dt_iso: ev.dtstart } : {}),
    ...(ev.dtend !== undefined ? { end_dt_iso: ev.dtend } : {}),
    ...(ev.location !== undefined ? { raw_location_text: ev.location } : {}),
    ...(ev.description !== undefined ? { raw_description: ev.description } : {}),
    ...(ev.organizer !== undefined ? { raw_organizer_text: ev.organizer } : {}),
    ...(ev.url !== undefined ? { raw_url: ev.url } : {}),
    ...(tzHint !== undefined ? { timezone_hint: tzHint } : {}),
    ...(ev.rrule !== undefined ? { source_rrule: ev.rrule } : {}),
    raw_json: ev,
  };
}
