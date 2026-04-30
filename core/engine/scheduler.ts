#!/usr/bin/env node --experimental-strip-types
// core/engine/scheduler.ts — Phase 7 unattended runner.
//
// Long-running daemon that drives the snapshot → enrich → load chain on a
// schedule. Each source has check_interval_days in niche.yaml; scheduler
// fires when sources.next_check_at <= now. Designed for systemd on Pi.
//
// Usage:
//   bash run.sh --niche=tango schedule [--target=playground|live] [--tick=300]
//
// Flags:
//   --target=playground (default) — load to playground cluster (requires
//     MONGODB_URI_PLAYGROUND + NICHE_HARVEST_PLAYGROUND=1 env)
//   --target=live — load to TT_Test (requires MONGODB_URI_TEST +
//     NICHE_HARVEST_LIVE=1 env)
//   --target=dry-run — no live writes; reports only
//   --tick=300 — check interval in seconds (default 300 = 5 min)
//   --once — run one cycle then exit (for testing)
//
// The scheduler:
//   1. Polls SQLite sources table for those where next_check_at is past
//   2. If any are due, runs snapshot (covers all sources in one pass)
//   3. Runs enrich (full pass + 5 retry passes for geocode)
//   4. Runs load with the configured target
//   5. Updates next_check_at = now + check_interval_days for processed sources
//   6. Sleeps until soonest next_check_at, capped at tick interval
//
// Crash-safe: each step is idempotent; restart resumes from current state.
// systemd watchdog: writes heartbeat file every tick to PATHS.heartbeatPath().

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadNiche, NicheConfigError } from "../config.ts";
import { createLogger } from "../logger.ts";
import { PATHS } from "../types.ts";

interface SchedulerOpts {
  niche: string;
  target: "playground" | "live" | "dry-run";
  tickSeconds: number;
  once: boolean;
}

function parseCli(argv: string[]): SchedulerOpts {
  const args = argv.slice(2);
  const niche = pickArg(args, "--niche");
  if (!niche) {
    process.stderr.write("scheduler: missing --niche=<key>\n");
    process.exit(2);
  }
  const target = (pickArg(args, "--target") ?? "playground") as
    | "playground"
    | "live"
    | "dry-run";
  if (!["playground", "live", "dry-run"].includes(target)) {
    process.stderr.write(`scheduler: invalid --target=${target}\n`);
    process.exit(2);
  }
  return {
    niche,
    target,
    tickSeconds: numArg(args, "--tick", 300),
    once: args.includes("--once"),
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

async function runChild(
  command: string,
  args: string[],
  log: ReturnType<typeof createLogger>,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "inherit", "inherit"],
      cwd: process.cwd(),
    });
    child.on("exit", (code) => {
      log.info("child exit", { command, args, code });
      resolve(code ?? -1);
    });
    child.on("error", (err) => {
      log.error("child error", { command, args, error: err.message });
      resolve(-1);
    });
  });
}

function dueSources(db: DatabaseSync): { source_id: string; check_interval_days: number }[] {
  const nowIso = new Date().toISOString();
  return db
    .prepare(`
      SELECT source_id, check_interval_days
      FROM sources
      WHERE enabled = 1
        AND (next_check_at IS NULL OR next_check_at <= ?)
    `)
    .all(nowIso) as unknown as { source_id: string; check_interval_days: number }[];
}

function markChecked(db: DatabaseSync, sourceIds: string[], days: number): void {
  const next = new Date(Date.now() + days * 86400_000).toISOString();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE sources SET last_checked_at = ?, next_check_at = ? WHERE source_id = ?
  `);
  for (const id of sourceIds) stmt.run(now, next, id);
}

function soonestNextCheck(db: DatabaseSync): Date | null {
  const r = db
    .prepare(`
      SELECT MIN(next_check_at) as next FROM sources
      WHERE enabled = 1 AND next_check_at IS NOT NULL
    `)
    .get() as unknown as { next: string | null };
  return r.next ? new Date(r.next) : null;
}

function writeHeartbeat(niche: string, status: string): void {
  const path = join(PATHS.nicheDataDir(niche), "scheduler.heartbeat");
  const beat = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    status,
  };
  try {
    writeFileSync(path, JSON.stringify(beat) + "\n");
  } catch {
    // best-effort
  }
}

async function tick(opts: SchedulerOpts, log: ReturnType<typeof createLogger>): Promise<void> {
  const db = new DatabaseSync(PATHS.nicheSqlite(opts.niche));

  // ─── 1. Identify due sources ───
  const due = dueSources(db);
  if (due.length === 0) {
    const next = soonestNextCheck(db);
    log.info("no sources due", {
      next_check_at: next?.toISOString() ?? "none",
    });
    // Heartbeat on idle ticks too — watchdog needs proof of life every cycle,
    // not just when there's work. Otherwise idle scheduler looks dead.
    writeHeartbeat(opts.niche, "idle");
    db.close();
    return;
  }

  log.info("sources due for check", { count: due.length, sources: due.map((d) => d.source_id) });
  writeHeartbeat(opts.niche, "snapshotting");

  // ─── 2. Run snapshot (covers all sources; per-source filter is in adapter layer) ───
  const snapshotCode = await runChild(
    "bash",
    ["run.sh", `--niche=${opts.niche}`, "snapshot"],
    log,
  );
  if (snapshotCode !== 0) {
    log.error("snapshot failed; skipping rest of tick", { code: snapshotCode });
    db.close();
    return;
  }

  // ─── 3. Run enrich (full pass) ───
  writeHeartbeat(opts.niche, "enriching");
  const enrichCode = await runChild(
    "bash",
    ["run.sh", `--niche=${opts.niche}`, "enrich"],
    log,
  );
  if (enrichCode !== 0) {
    log.error("enrich failed", { code: enrichCode });
    db.close();
    return;
  }

  // ─── 4. Run retry passes for stuck pending venues ───
  for (let i = 0; i < 5; i += 1) {
    writeHeartbeat(opts.niche, `retrying-${i + 1}`);
    await runChild(
      "bash",
      ["run.sh", `--niche=${opts.niche}`, "enrich", "--retry-failed-venues"],
      log,
    );
  }

  // ─── 5. Run load ───
  writeHeartbeat(opts.niche, "loading");
  const loadArgs = ["run.sh", `--niche=${opts.niche}`, "load"];
  if (opts.target === "playground") loadArgs.push("--playground");
  else if (opts.target === "live") loadArgs.push("--live");
  // dry-run is the default when no flag passed

  const loadCode = await runChild("bash", loadArgs, log);
  if (loadCode !== 0) {
    log.error("load failed", { code: loadCode });
    // don't fail the tick — load failures are recoverable next cycle
  }

  // ─── 6. Mark due sources as checked ───
  // Group by check_interval_days so we update in one pass per interval.
  const byInterval = new Map<number, string[]>();
  for (const d of due) {
    const arr = byInterval.get(d.check_interval_days) ?? [];
    arr.push(d.source_id);
    byInterval.set(d.check_interval_days, arr);
  }
  for (const [days, ids] of byInterval) {
    markChecked(db, ids, days);
  }
  log.info("tick complete; sources marked checked", { count: due.length });
  writeHeartbeat(opts.niche, "idle");
  db.close();
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const log = createLogger("scheduler", { niche: opts.niche, target: opts.target });

  try {
    loadNiche(opts.niche); // validate config exists
  } catch (err) {
    if (err instanceof NicheConfigError) {
      process.stderr.write(`scheduler: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  log.info("scheduler starting", {
    niche: opts.niche,
    target: opts.target,
    tick_seconds: opts.tickSeconds,
    once: opts.once,
    pid: process.pid,
  });

  // Graceful shutdown handlers
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown signal received", { signal });
    writeHeartbeat(opts.niche, "shutdown");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Main loop
  while (!shuttingDown) {
    try {
      await tick(opts, log);
    } catch (err) {
      log.error("tick error", { error: err instanceof Error ? err.message : String(err) });
      writeHeartbeat(opts.niche, "error");
    }
    if (opts.once) {
      log.info("--once: exiting after first tick");
      return;
    }
    log.info("sleeping until next tick", { tick_seconds: opts.tickSeconds });
    await new Promise((resolve) => setTimeout(resolve, opts.tickSeconds * 1000));
  }
}

await main();
