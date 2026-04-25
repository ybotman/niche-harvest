// core/store.ts — SQLite storage for niche-harvest.
//
// Authority: ARCHITECTURE.md §3 (SQLite schema). One harvest.sqlite per niche
// at data/<niche>/harvest.sqlite. WAL mode, foreign keys on. Schema is
// niche-agnostic — columns are universal; semantics flow from niche.yaml.
//
// Migrations: additive-only. Bump SCHEMA_VERSION on any change; add an
// idempotent ALTER block in `migrate()`. Drops happen only after all
// consumers migrate.
//
// API surface for Phase 1: open(), upsertSource(), insertRawEvent(),
// listSources(), runStartLog/runEndLog. The full §3.1 schema is created
// up-front so Phase 2+ tables are already there when geocoder/loader land.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import type { SourceConfig } from "./types.ts";
import { PATHS } from "./types.ts";

export const SCHEMA_VERSION = 1;

export interface SourceRow {
  id: number;
  source_type: string;
  source_id: string;
  source_name: string | null;
  adapter: string;
  config_json: string | null;
  priority: string;
  enabled: number;
  trusted: number;
  check_interval_days: number;
  last_checked_at: string | null;
  next_check_at: string | null;
  consecutive_empty: number;
  events_found_total: number;
  events_found_last: number;
  last_error: string | null;
  created_at: string;
}

export interface RawEventRow {
  id: number;
  source_id: number;
  fingerprint: string;
  raw_title: string | null;
  raw_date_text: string | null;
  raw_location_text: string | null;
  raw_description: string | null;
  raw_organizer_text: string | null;
  raw_url: string | null;
  raw_json: string | null;
  status: string;
  error_message: string | null;
  discovered_at: string;
  enriched_at: string | null;
}

export interface RunRow {
  id: number;
  run_type: string;
  source_id: number | null;
  started_at: string;
  completed_at: string | null;
  items_processed: number;
  items_new: number;
  items_skipped: number;
  items_errored: number;
  notes: string | null;
}

/**
 * Open (or create) the per-niche SQLite at data/<niche>/harvest.sqlite.
 * Sets WAL mode, foreign keys on, runs migrations to current SCHEMA_VERSION.
 */
export function openStore(nicheKey: string): DatabaseSync {
  const dbPath = PATHS.nicheSqlite(nicheKey);
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");

  migrate(db);
  return db;
}

// ─────────────────────────────────────────────────────────────────────────
// Schema (additive migrations)
// ─────────────────────────────────────────────────────────────────────────

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_version")
    .get() as { v: number | null } | undefined;
  const current = row?.v ?? 0;

  if (current < 1) {
    applyV1(db);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
  }

  // Future: if (current < 2) applyV2(db); ... bump SCHEMA_VERSION above.
}

function applyV1(db: DatabaseSync): void {
  db.exec(`
    -- ─── sources ─── one row per configured source from niche.yaml
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      source_type TEXT NOT NULL,            -- 'ical' | 'web_*' | 'fb_group'
      source_id TEXT NOT NULL,              -- niche.yaml source name
      source_name TEXT,                     -- niche.yaml display_name
      adapter TEXT NOT NULL,                -- adapter registry key
      config_json TEXT,                     -- per-source config (URL, group_id, etc.)
      priority TEXT DEFAULT 'normal',
      enabled INTEGER DEFAULT 1,
      trusted INTEGER DEFAULT 1,
      check_interval_days INTEGER DEFAULT 7,
      last_checked_at TEXT,
      next_check_at TEXT,
      consecutive_empty INTEGER DEFAULT 0,
      events_found_total INTEGER DEFAULT 0,
      events_found_last INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sources_next_check
      ON sources(next_check_at, enabled) WHERE enabled = 1;

    -- ─── raw_events ─── as discovered from a source, pre-enrichment
    CREATE TABLE IF NOT EXISTS raw_events (
      id INTEGER PRIMARY KEY,
      source_id INTEGER REFERENCES sources(id),
      fingerprint TEXT UNIQUE NOT NULL,     -- SHA256(title|date|venue_key)
      raw_title TEXT,
      raw_date_text TEXT,
      raw_location_text TEXT,
      raw_description TEXT,
      raw_organizer_text TEXT,
      raw_url TEXT,
      raw_json TEXT,                        -- full source payload (forensics)
      status TEXT DEFAULT 'pending',        -- 'pending'|'enriched'|'skipped'|'error'
      error_message TEXT,
      discovered_at TEXT DEFAULT (datetime('now')),
      enriched_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_raw_events_source ON raw_events(source_id, status);

    -- ─── venues ─── pre + post geocode state
    CREATE TABLE IF NOT EXISTS venues (
      id INTEGER PRIMARY KEY,
      fingerprint TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      lat REAL,
      lng REAL,
      timezone TEXT,
      geocode_source TEXT,
      geocode_confidence REAL,
      geocode_status TEXT DEFAULT 'pending',
      mastered_city_id TEXT,
      mastered_city_name TEXT,
      mastered_city_geolocation_json TEXT,
      mastered_division_id TEXT,
      mastered_division_name TEXT,
      mastered_region_id TEXT,
      mastered_region_name TEXT,
      mastered_country_id TEXT,
      mastered_country_name TEXT,
      mongo_venue_id_test TEXT,
      mongo_venue_id_prod TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_venues_geocode
      ON venues(geocode_status) WHERE geocode_status = 'pending';

    -- ─── organizers ─── normalized identity (fullName + optional fb_profile_url)
    CREATE TABLE IF NOT EXISTS organizers (
      id INTEGER PRIMARY KEY,
      normalized_key TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      short_name TEXT,
      fb_profile_url TEXT,
      primary_channel TEXT,
      primary_channel_value TEXT,
      secondary_channels_json TEXT,
      language_hint TEXT,
      role TEXT,
      cadence_hint TEXT,
      event_count INTEGER DEFAULT 0,
      first_seen_at TEXT,
      last_seen_at TEXT,
      outreach_status TEXT DEFAULT 'not_contacted',
      last_contacted_at TEXT,
      mongo_organizer_id_test TEXT,
      mongo_organizer_id_prod TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ─── events ─── enriched (post-classify, pre/post-load)
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      raw_event_id INTEGER REFERENCES raw_events(id),
      fingerprint TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      short_title TEXT,
      description TEXT,
      start_dt TEXT NOT NULL,
      end_dt TEXT,
      duration_hours REAL,
      category_first TEXT,
      category_second TEXT,
      category_third TEXT,
      attributes_json TEXT,
      skip_reason TEXT,
      venue_id INTEGER REFERENCES venues(id),
      organizer_id INTEGER REFERENCES organizers(id),
      is_recurring INTEGER DEFAULT 0,
      rrule TEXT,
      source_url TEXT,
      trust_level TEXT DEFAULT 'ai_discovered',
      sync_status_test TEXT,
      sync_status_prod TEXT,
      calendar_event_id_test TEXT,
      calendar_event_id_prod TEXT,
      travel_worthy INTEGER,
      travel_worthy_override INTEGER,
      beginner_friendly INTEGER,
      beginner_friendly_override INTEGER,
      for_beginners INTEGER,
      for_beginners_override INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_sync_test
      ON events(sync_status_test)
      WHERE sync_status_test IS NULL OR sync_status_test = 'pending';

    -- ─── work_queue ─── backs the scheduler (Phase 7+)
    CREATE TABLE IF NOT EXISTS work_queue (
      id INTEGER PRIMARY KEY,
      queue_name TEXT NOT NULL,
      priority INTEGER DEFAULT 5,
      status TEXT DEFAULT 'pending',
      payload_json TEXT,
      source_id INTEGER REFERENCES sources(id),
      spawned_by_id INTEGER,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      scheduled_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      next_retry_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_queue_pending
      ON work_queue(queue_name, status, priority, scheduled_at)
      WHERE status = 'pending';

    -- ─── quality_flags ─── M1 dashboard table; CHECK enforces traceability
    CREATE TABLE IF NOT EXISTS quality_flags (
      id INTEGER PRIMARY KEY,
      event_id INTEGER REFERENCES events(id),
      raw_event_id INTEGER REFERENCES raw_events(id),
      reason TEXT NOT NULL,
      detail TEXT,
      source_id INTEGER REFERENCES sources(id),
      captured_at TEXT DEFAULT (datetime('now')),
      CHECK (event_id IS NOT NULL OR raw_event_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_quality_flags_reason ON quality_flags(reason);

    -- ─── runs ─── observability per cycle
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      run_type TEXT,
      source_id INTEGER,
      started_at TEXT,
      completed_at TEXT,
      items_processed INTEGER DEFAULT 0,
      items_new INTEGER DEFAULT 0,
      items_skipped INTEGER DEFAULT 0,
      items_errored INTEGER DEFAULT 0,
      notes TEXT
    );

    -- ─── fb_signal_log ─── owned by block-detector; read by watchdog (SAFEGUARD §3.3)
    CREATE TABLE IF NOT EXISTS fb_signal_log (
      id INTEGER PRIMARY KEY,
      timestamp TEXT DEFAULT (datetime('now')),
      signal_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      group_id TEXT,
      session_id TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fb_signal_log_recent
      ON fb_signal_log(timestamp, severity);

    -- ─── fb_group_baseline ─── per-group expected nonzero / latency baseline
    CREATE TABLE IF NOT EXISTS fb_group_baseline (
      group_id TEXT PRIMARY KEY,
      expected_nonzero_event_count INTEGER,
      latency_p90_ms INTEGER,
      scrape_count INTEGER DEFAULT 0,
      measured_at TEXT
    );
  `);
}

// ─────────────────────────────────────────────────────────────────────────
// Sources — upsert from niche.yaml
// ─────────────────────────────────────────────────────────────────────────

/**
 * Upsert a source row from a niche.yaml SourceConfig. Returns the row id.
 * Idempotent on (source_type, source_id).
 */
export function upsertSource(
  db: DatabaseSync,
  source: SourceConfig,
): number {
  const sourceType = sourceTypeFor(source);
  const configJson = JSON.stringify(source);

  const stmt = db.prepare(`
    INSERT INTO sources (
      source_type, source_id, source_name, adapter,
      config_json, priority, enabled, trusted, check_interval_days
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(source_type, source_id) DO UPDATE SET
      source_name = excluded.source_name,
      adapter = excluded.adapter,
      config_json = excluded.config_json,
      priority = excluded.priority,
      trusted = excluded.trusted,
      check_interval_days = excluded.check_interval_days
  `);

  stmt.run(
    sourceType,
    source.name,
    source.display_name ?? source.name,
    source.adapter,
    configJson,
    source.priority,
    source.trusted ? 1 : 0,
    source.check_interval_days,
  );

  const row = db
    .prepare("SELECT id FROM sources WHERE source_type = ? AND source_id = ?")
    .get(sourceType, source.name) as { id: number } | undefined;
  if (!row) throw new Error(`upsertSource: row not found after insert (${source.name})`);
  return row.id;
}

function sourceTypeFor(source: SourceConfig): string {
  switch (source.adapter) {
    case "ical":
      return "ical";
    case "fb-group":
      return "fb_group";
    default:
      return source.adapter;
  }
}

export function listSources(db: DatabaseSync): SourceRow[] {
  return db
    .prepare("SELECT * FROM sources WHERE enabled = 1 ORDER BY priority, source_id")
    .all() as unknown as SourceRow[];
}

// ─────────────────────────────────────────────────────────────────────────
// Raw events — insert with fingerprint dedup
// ─────────────────────────────────────────────────────────────────────────

/**
 * Insert a raw event keyed by fingerprint. Idempotent — duplicates are
 * silently ignored (INSERT OR IGNORE). Returns true if newly inserted,
 * false if skipped as duplicate.
 */
export function insertRawEvent(
  db: DatabaseSync,
  sourceRowId: number,
  ev: {
    fingerprint: string;
    raw_title: string;
    raw_date_text?: string;
    raw_location_text?: string;
    raw_description?: string;
    raw_organizer_text?: string;
    raw_url?: string;
    raw_json?: unknown;
  },
): boolean {
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO raw_events (
        source_id, fingerprint,
        raw_title, raw_date_text, raw_location_text,
        raw_description, raw_organizer_text, raw_url, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      sourceRowId,
      ev.fingerprint,
      ev.raw_title,
      ev.raw_date_text ?? null,
      ev.raw_location_text ?? null,
      ev.raw_description ?? null,
      ev.raw_organizer_text ?? null,
      ev.raw_url ?? null,
      ev.raw_json !== undefined ? JSON.stringify(ev.raw_json) : null,
    );
  return result.changes > 0;
}

export function countRawEventsForSource(
  db: DatabaseSync,
  sourceRowId: number,
): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM raw_events WHERE source_id = ?")
    .get(sourceRowId) as { c: number };
  return row.c;
}

// ─────────────────────────────────────────────────────────────────────────
// Runs — observability log
// ─────────────────────────────────────────────────────────────────────────

export function runStartLog(
  db: DatabaseSync,
  runType: string,
  sourceRowId: number | null,
): number {
  const result = db
    .prepare(`
      INSERT INTO runs (run_type, source_id, started_at)
      VALUES (?, ?, ?)
    `)
    .run(runType, sourceRowId, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function runEndLog(
  db: DatabaseSync,
  runId: number,
  counts: {
    items_processed: number;
    items_new: number;
    items_skipped: number;
    items_errored: number;
    notes?: string;
  },
): void {
  db.prepare(`
    UPDATE runs SET
      completed_at = ?,
      items_processed = ?,
      items_new = ?,
      items_skipped = ?,
      items_errored = ?,
      notes = ?
    WHERE id = ?
  `).run(
    new Date().toISOString(),
    counts.items_processed,
    counts.items_new,
    counts.items_skipped,
    counts.items_errored,
    counts.notes ?? null,
    runId,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Source state update (after a fetch cycle)
// ─────────────────────────────────────────────────────────────────────────

export function updateSourceAfterFetch(
  db: DatabaseSync,
  sourceRowId: number,
  result: {
    eventsFound: number;
    error?: string;
    nextCheckAt?: string;
  },
): void {
  const now = new Date().toISOString();
  if (result.error) {
    db.prepare(`
      UPDATE sources SET
        last_checked_at = ?,
        next_check_at = ?,
        last_error = ?
      WHERE id = ?
    `).run(now, result.nextCheckAt ?? null, result.error, sourceRowId);
    return;
  }

  // Update event counters; reset consecutive_empty if we found anything
  db.prepare(`
    UPDATE sources SET
      last_checked_at = ?,
      next_check_at = ?,
      events_found_last = ?,
      events_found_total = events_found_total + ?,
      consecutive_empty = CASE WHEN ? > 0 THEN 0 ELSE consecutive_empty + 1 END,
      last_error = NULL
    WHERE id = ?
  `).run(
    now,
    result.nextCheckAt ?? null,
    result.eventsFound,
    result.eventsFound,
    result.eventsFound,
    sourceRowId,
  );
}
