// core/logger.ts — structured JSON-per-line logger.
//
// Authority: ARCHITECTURE.md §9.1 (observability). Every emit includes
// timestamp, level, component, niche, optional source_id/event_id, message.
// Output goes to stdout; operator pipes to file or journald.
//
// Child logger pattern: rootLogger.child({niche: 'tango'}) returns a logger
// that automatically merges that context into every emit downstream.

import type { LogContext, LogLevel, Logger } from "./types.ts";

interface LoggerOptions {
  component: string;
  baseContext?: LogContext;
  /** Min level to emit; default 'info'. Set to 'debug' via env. */
  minLevel?: LogLevel;
  /** Output sink; defaults to console (process.stdout). */
  sink?: (line: string) => void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function defaultSink(line: string): void {
  process.stdout.write(line + "\n");
}

class JsonLogger implements Logger {
  private readonly component: string;
  private readonly baseContext: LogContext;
  private readonly minRank: number;
  private readonly sink: (line: string) => void;

  constructor(opts: LoggerOptions) {
    this.component = opts.component;
    this.baseContext = opts.baseContext ?? {};
    this.minRank = LEVEL_RANK[opts.minLevel ?? "info"];
    this.sink = opts.sink ?? defaultSink;
  }

  debug(message: string, context: LogContext = {}): void {
    this.emit("debug", message, context);
  }
  info(message: string, context: LogContext = {}): void {
    this.emit("info", message, context);
  }
  warn(message: string, context: LogContext = {}): void {
    this.emit("warn", message, context);
  }
  error(message: string, context: LogContext = {}): void {
    this.emit("error", message, context);
  }

  child(context: LogContext): Logger {
    return new JsonLogger({
      component: this.component,
      baseContext: { ...this.baseContext, ...context },
      minLevel: rankToLevel(this.minRank),
      sink: this.sink,
    });
  }

  private emit(level: LogLevel, message: string, context: LogContext): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const merged = { ...this.baseContext, ...context };
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...merged,
    });
    this.sink(line);
  }
}

function rankToLevel(rank: number): LogLevel {
  if (rank <= 10) return "debug";
  if (rank <= 20) return "info";
  if (rank <= 30) return "warn";
  return "error";
}

/**
 * Create a root logger for a component.
 * Reads LOG_LEVEL env var (debug|info|warn|error); defaults to 'info'.
 */
export function createLogger(component: string, baseContext: LogContext = {}): Logger {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  const minLevel: LogLevel =
    envLevel === "debug" || envLevel === "info" ||
    envLevel === "warn" || envLevel === "error"
      ? envLevel
      : "info";
  return new JsonLogger({ component, baseContext, minLevel });
}
