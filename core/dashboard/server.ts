#!/usr/bin/env node --experimental-strip-types
// core/dashboard/server.ts — niche-harvest live status dashboard.
//
// Serves a 4-quadrant TV-friendly status page plus JSON/SSE state stream.
// Designed to render in chromium-browser --kiosk on a Pi-attached TV with
// no keyboard/mouse interaction needed. Auto-refreshes via Server-Sent Events
// every 5 seconds.
//
// Endpoints:
//   GET /              — static HTML page
//   GET /api/state     — current state JSON snapshot (one-shot poll)
//   GET /api/stream    — SSE stream pushing /api/state every N seconds
//
// Usage:
//   bash run.sh --niche=tango dashboard [--port=9000] [--niches=tango,horror]
//
// Designed to be unattended; written to be tolerant of missing files,
// stale heartbeats, and partial state. No auth (LAN-only port).

import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { MongoClient } from "mongodb";

import { loadNiche, NicheConfigError } from "../config.ts";
import { createLogger } from "../logger.ts";
import { PATHS } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DashboardOpts {
  niches: string[];
  port: number;
  refreshSeconds: number;
}

function parseCli(argv: string[]): DashboardOpts {
  const args = argv.slice(2);
  const niches = (pickArg(args, "--niche") ?? pickArg(args, "--niches") ?? "tango")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    niches,
    port: numArg(args, "--port", 9000),
    refreshSeconds: numArg(args, "--refresh", 5),
  };
}

function pickArg(args: string[], key: string): string | null {
  const prefix = `${key}=`;
  const m = args.find((a) => a.startsWith(prefix));
  if (m) return m.slice(prefix.length);
  return null;
}

function numArg(args: string[], key: string, def: number): number {
  const v = pickArg(args, key);
  return v ? Number(v) : def;
}

interface SourceRow {
  source_id: string;
  enabled: number;
  last_checked_at: string | null;
  next_check_at: string | null;
  last_error: string | null;
  events_found_total: number;
  events_found_last: number;
  consecutive_empty: number;
}

interface NicheState {
  niche: string;
  display_name: string;
  scheduler: {
    status: string;
    last_heartbeat: string | null;
    pid: number | null;
    age_seconds: number | null;
  };
  sources: SourceRow[];
  totals: {
    raw_events_total: number;
    raw_events_enriched: number;
    raw_events_skipped: number;
    venues_total: number;
    venues_geocoded: number;
    venues_pending: number;
    venues_failed: number;
    loadable_for_phase_2: number;
    quality_flags_total: number;
  };
  recent_loads: Array<{
    date: string;
    nh_batch_id: string | null;
    events_inserted: number;
    venues_created: number;
    organizers_created: number;
    duration_flags: number;
  }>;
}

interface BackendState {
  /** "test" | "prod" | "off" — which backend the dashboard is pointed at */
  env: "test" | "prod" | "off";
  /** ISO timestamp of last successful poll; null if never connected */
  last_poll_at: string | null;
  /** non-null only on connection error */
  error: string | null;
  /** Counts queryable per appId. niche-harvest writes carry isDiscovered=true. */
  counts: {
    events_total: number;
    events_discovered: number;
    events_appid_1: number;
    events_appid_99: number;
    venues_total: number;
    venues_discovered: number;
    organizers_total: number;
  };
}

interface DashboardState {
  generated_at: string;
  niches: NicheState[];
  backend: BackendState;
}

function readHeartbeat(niche: string): NicheState["scheduler"] {
  const path = join(PATHS.nicheDataDir(niche), "scheduler.heartbeat");
  if (!existsSync(path)) {
    return { status: "no_heartbeat", last_heartbeat: null, pid: null, age_seconds: null };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const beat = JSON.parse(raw) as { timestamp: string; pid: number; status: string };
    const ageMs = Date.now() - Date.parse(beat.timestamp);
    return {
      status: beat.status,
      last_heartbeat: beat.timestamp,
      pid: beat.pid,
      age_seconds: Math.floor(ageMs / 1000),
    };
  } catch {
    return { status: "unparseable", last_heartbeat: null, pid: null, age_seconds: null };
  }
}

function readNicheState(nicheKey: string): NicheState {
  let displayName = nicheKey;
  try {
    const cfg = loadNiche(nicheKey);
    displayName = cfg.niche.display_name;
  } catch (err) {
    if (!(err instanceof NicheConfigError)) throw err;
  }

  const scheduler = readHeartbeat(nicheKey);

  // Default empty state when SQLite missing
  const empty: NicheState = {
    niche: nicheKey,
    display_name: displayName,
    scheduler,
    sources: [],
    totals: {
      raw_events_total: 0,
      raw_events_enriched: 0,
      raw_events_skipped: 0,
      venues_total: 0,
      venues_geocoded: 0,
      venues_pending: 0,
      venues_failed: 0,
      loadable_for_phase_2: 0,
      quality_flags_total: 0,
    },
    recent_loads: [],
  };

  const dbPath = PATHS.nicheSqlite(nicheKey);
  if (!existsSync(dbPath)) return empty;

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return empty;
  }

  try {
    const sources = db
      .prepare(`
        SELECT source_id, enabled, last_checked_at, next_check_at, last_error,
               events_found_total, events_found_last, consecutive_empty
        FROM sources
        ORDER BY source_id
      `)
      .all() as unknown as SourceRow[];

    const reByStatus = db
      .prepare(`SELECT status, COUNT(*) AS n FROM raw_events GROUP BY status`)
      .all() as unknown as { status: string; n: number }[];

    const totals = { ...empty.totals };
    for (const r of reByStatus) {
      totals.raw_events_total += r.n;
      if (r.status === "enriched") totals.raw_events_enriched += r.n;
      if (r.status === "skipped") totals.raw_events_skipped += r.n;
    }

    const venByStatus = db
      .prepare(`SELECT geocode_status, COUNT(*) AS n FROM venues GROUP BY geocode_status`)
      .all() as unknown as { geocode_status: string; n: number }[];
    for (const r of venByStatus) {
      totals.venues_total += r.n;
      if (r.geocode_status === "geocoded") totals.venues_geocoded += r.n;
      if (r.geocode_status === "pending") totals.venues_pending += r.n;
      if (r.geocode_status === "failed") totals.venues_failed += r.n;
    }

    const phase2 = db
      .prepare(`
        SELECT COUNT(*) AS n
        FROM raw_events re
        JOIN venues v ON v.id = re.venue_id
        WHERE re.status = 'enriched' AND v.geocode_status = 'geocoded'
      `)
      .get() as unknown as { n: number };
    totals.loadable_for_phase_2 = phase2.n;

    const qfTotal = db
      .prepare(`SELECT COUNT(*) AS n FROM quality_flags`)
      .get() as unknown as { n: number };
    totals.quality_flags_total = qfTotal.n;

    db.close();

    const recentLoads = readRecentLoads(nicheKey);

    return {
      niche: nicheKey,
      display_name: displayName,
      scheduler,
      sources,
      totals,
      recent_loads: recentLoads,
    };
  } catch (err) {
    try { db.close(); } catch {}
    return empty;
  }
}

function readRecentLoads(nicheKey: string): NicheState["recent_loads"] {
  const dir = PATHS.snapshotsDir(nicheKey);
  if (!existsSync(dir)) return [];
  const files: { name: string; mtime: number }[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith("-load.json")) continue;
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        files.push({ name, mtime: stat.mtimeMs });
      } catch {}
    }
  } catch { return []; }
  files.sort((a, b) => b.mtime - a.mtime);

  const out: NicheState["recent_loads"] = [];
  for (const f of files.slice(0, 10)) {
    try {
      const path = join(dir, f.name);
      const raw = readFileSync(path, "utf8");
      const report = JSON.parse(raw) as {
        nh_batch_id?: string;
        this_run?: {
          counts?: { events_inserted?: number; venues_created?: number; organizers_created?: number };
        };
        quality_flags_this_batch?: Record<string, number>;
      };
      const date = f.name.slice(0, 10);
      const counts = report.this_run?.counts ?? {};
      const qf = report.quality_flags_this_batch ?? {};
      out.push({
        date,
        nh_batch_id: report.nh_batch_id ?? null,
        events_inserted: counts.events_inserted ?? 0,
        venues_created: counts.venues_created ?? 0,
        organizers_created: counts.organizers_created ?? 0,
        duration_flags: (qf.duration_reassigned ?? 0) + (qf.duration_ceiling_exceeded ?? 0),
      });
    } catch {
      // tolerate corrupt reports
    }
  }
  return out;
}

// ─── Backend state cache (TT_Test or TT_Prod) ───
// Avoid reconnecting every request. The MongoClient is reused; counts are
// re-queried on every dashboard tick (cheap — small collections, indexed).
let mongoClient: MongoClient | null = null;
let mongoUriCached: string | null = null;
let lastBackendState: BackendState = {
  env: "off",
  last_poll_at: null,
  error: null,
  counts: {
    events_total: 0,
    events_discovered: 0,
    events_appid_1: 0,
    events_appid_99: 0,
    venues_total: 0,
    venues_discovered: 0,
    organizers_total: 0,
  },
};
let backendPollInFlight = false;

async function pollBackend(): Promise<void> {
  if (backendPollInFlight) return;
  backendPollInFlight = true;
  try {
    const uri = process.env.MONGODB_URI_TEST ?? process.env.MONGODB_URI_PROD ?? null;
    const env: BackendState["env"] = process.env.MONGODB_URI_PROD
      ? "prod"
      : process.env.MONGODB_URI_TEST
        ? "test"
        : "off";
    if (!uri) {
      lastBackendState = { ...lastBackendState, env: "off", error: "no MONGODB_URI_TEST or MONGODB_URI_PROD set" };
      return;
    }
    if (mongoClient && mongoUriCached !== uri) {
      try { await mongoClient.close(); } catch {}
      mongoClient = null;
    }
    if (!mongoClient) {
      mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
      await mongoClient.connect();
      mongoUriCached = uri;
    }
    const db = mongoClient.db();
    const events = db.collection("events");
    const venues = db.collection("venues");
    const organizers = db.collection("organizers");

    const [eventsTotal, eventsDiscovered, eventsAppid1, eventsAppid99, venuesTotal, venuesDiscovered, organizersTotal] = await Promise.all([
      events.estimatedDocumentCount(),
      events.countDocuments({ isDiscovered: true }),
      events.countDocuments({ appId: 1 }),
      events.countDocuments({ appId: 99 }),
      venues.estimatedDocumentCount(),
      venues.countDocuments({ isDiscovered: true }),
      organizers.estimatedDocumentCount(),
    ]);

    lastBackendState = {
      env,
      last_poll_at: new Date().toISOString(),
      error: null,
      counts: {
        events_total: eventsTotal,
        events_discovered: eventsDiscovered,
        events_appid_1: eventsAppid1,
        events_appid_99: eventsAppid99,
        venues_total: venuesTotal,
        venues_discovered: venuesDiscovered,
        organizers_total: organizersTotal,
      },
    };
  } catch (err) {
    lastBackendState = {
      ...lastBackendState,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    backendPollInFlight = false;
  }
}

function buildState(opts: DashboardOpts): DashboardState {
  // Kick off a backend poll if last one was > refreshSeconds ago. Don't
  // block the response — return last cached state. Fresh data lands on
  // the next tick (~5s later).
  const lastAgeMs = lastBackendState.last_poll_at
    ? Date.now() - Date.parse(lastBackendState.last_poll_at)
    : Infinity;
  if (lastAgeMs > opts.refreshSeconds * 1000) {
    pollBackend().catch(() => {});
  }
  return {
    generated_at: new Date().toISOString(),
    niches: opts.niches.map(readNicheState),
    backend: lastBackendState,
  };
}

// ─── Serve static index.html (co-located with server.ts) ───
const INDEX_PATH = join(__dirname, "index.html");

function handleStatic(_req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(INDEX_PATH)) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("dashboard index.html missing");
    return;
  }
  const html = readFileSync(INDEX_PATH, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function handleStateJson(opts: DashboardOpts, _req: IncomingMessage, res: ServerResponse): void {
  const state = buildState(opts);
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(state));
}

function handleSse(opts: DashboardOpts, _req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (): void => {
    try {
      const state = buildState(opts);
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    } catch (err) {
      // best-effort; if write fails, the closed-handler below cleans up
    }
  };
  send(); // initial
  const interval = setInterval(send, opts.refreshSeconds * 1000);
  _req.on("close", () => clearInterval(interval));
  res.on("close", () => clearInterval(interval));
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const log = createLogger("dashboard", { niches: opts.niches.join(","), port: opts.port });

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") return handleStatic(req, res);
    if (url === "/api/state") return handleStateJson(opts, req, res);
    if (url === "/api/stream") return handleSse(opts, req, res);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  server.listen(opts.port, () => {
    log.info("dashboard listening", {
      port: opts.port,
      niches: opts.niches,
      refresh_seconds: opts.refreshSeconds,
      url: `http://localhost:${opts.port}/`,
    });
  });

  const shutdown = (signal: string): void => {
    log.info("dashboard shutdown", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

await main();
