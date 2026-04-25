#!/usr/bin/env node --experimental-strip-types
// ============================================================
// niche-harvest mock-FB server — SAFEGUARD-SPEC.md §6 test harness
// ============================================================
// Booker contribution per spec §6.4. Drop-in HTTP server that responds
// with the 13 documented bad-pattern shapes so niche-harvest's block-
// detector + rate-limiter + watchdog chain can be exercised without
// burning a real FB session.
//
// Each route is tagged with its originating spec section (§3.2 hard /
// §3.3 soft / §3.4 canary) so test failures trace back to the rule the
// route was built to validate.
//
// Usage:
//   node --experimental-strip-types mock-fb-server.ts              # port 9995
//   node --experimental-strip-types mock-fb-server.ts --port 9990
//
// Zero external dependencies — Node 22 http built-in only.
// ============================================================

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

const argPort = (() => {
  const i = process.argv.indexOf("--port");
  if (i >= 0 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10);
  return 9995;
})();

// ── Response fixtures ──

const OK_EVENTS_JSON = {
  data: {
    group: {
      events: {
        edges: [
          { node: { id: "test-event-1", name: "Mock Milonga", startTimestamp: 1714000000, place: { name: "Test Venue" } } },
          { node: { id: "test-event-2", name: "Mock Practica", startTimestamp: 1714100000, place: { name: "Test Studio" } } },
        ],
      },
    },
  },
};

const EMPTY_EVENTS_JSON = {
  data: { group: { events: { edges: [] } } },
};

// The exact interstitial HTML FB serves during a soft-block — the string below
// was captured from the 2026-04-17 incident. Do not paraphrase; detectors
// match on literal substring.
const SOFT_BLOCK_INTERSTITIAL_HTML = `<!DOCTYPE html>
<html><head><title>Facebook</title></head><body>
<div class="_warning">
<h2>You're Temporarily Blocked</h2>
<p>We limit how often you can post, comment, or do other things in a given amount of time in order to help protect the community from spam. You can try again later.</p>
</div>
</body></html>`;

// "Help us understand" identity-challenge page — captured behavior
const IDENTITY_CHALLENGE_HTML = `<!DOCTYPE html>
<html><head><title>Help Us Understand</title></head><body>
<div class="_challenge">
<h2>Help us understand what's happening</h2>
<p>To continue, please verify your identity or confirm your account. This helps us keep Facebook safe.</p>
</div>
</body></html>`;

// GraphQL ACCESS_DENIED error payload (exact shape FB returns)
const GRAPHQL_ACCESS_DENIED = {
  errors: [{
    code: 1357033,
    description: "You do not have permission to perform this action.",
    summary: "Access Denied",
    severity: "CRITICAL",
    category: "ACCESS_DENIED",
  }],
};

// fb_dtsg expired — numeric error code 1357004 is FB's "session expired" marker
const DTSG_EXPIRED_JSON = {
  errors: [{
    code: 1357004,
    description: "The user must log in again.",
    summary: "Session has expired",
    severity: "CRITICAL",
  }],
};

// ── Route handlers ──

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;

type Route = {
  path: string | RegExp;
  spec: string;               // "§3.2 hard" | "§3.3 soft" | "§3.4 canary" | "§4 rate"
  gap?: "G1" | "G2" | "G3" | "C3";  // Origin for v3-added routes
  summary: string;
  handler: Handler;
};

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "text/html", ...extraHeaders });
  res.end(body);
}

function redirect(res: ServerResponse, status: number, to: string) {
  res.writeHead(status, { location: to });
  res.end();
}

const ROUTES: Route[] = [
  {
    path: "/mock/ok",
    spec: "§3.4 canary baseline",
    summary: "Normal event list JSON — baseline / canary should pass; NO detectors fire",
    handler: (_, res) => sendJson(res, 200, OK_EVENTS_JSON),
  },

  // ── §3.2 Hard signals (any single occurrence = immediate session kill) ──

  {
    path: "/mock/429",
    spec: "§3.2 hard",
    summary: "HTTP 429 with rate-limit headers — triggers hard signal, IMMEDIATE kill",
    handler: (_, res) =>
      sendJson(res, 429, { error: "rate_limited" }, {
        "retry-after": "3600",
        "x-fb-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      }),
  },
  {
    path: "/mock/checkpoint",
    spec: "§3.2 hard",
    summary: "302 redirect to /checkpoint/ — CAPTCHA served, IMMEDIATE kill",
    handler: (_, res) => redirect(res, 302, "/checkpoint/?next=%2F"),
  },
  {
    path: "/mock/interstitial",
    spec: "§3.2 hard",
    summary: `200 with "We limit how often you can post, comment, or do other things" — soft-block in flight, IMMEDIATE kill`,
    handler: (_, res) => sendHtml(res, 200, SOFT_BLOCK_INTERSTITIAL_HTML),
  },
  {
    path: "/mock/logout",
    spec: "§3.2 hard",
    summary: "302 redirect to /privacy/confirmation/ — session invalidated, IMMEDIATE kill",
    handler: (_, res) => redirect(res, 302, "/privacy/confirmation/?ref=logout"),
  },
  {
    path: "/mock/challenge",
    spec: "§3.2 hard",
    gap: "G1",
    summary: `200 with "help us understand" / "verify your identity" — identity challenge, IMMEDIATE kill`,
    handler: (_, res) => sendHtml(res, 200, IDENTITY_CHALLENGE_HTML, { "x-request-path": "/help/contact/" }),
  },

  // ── §3.3 Soft signals (2+ in 10min = slow-down; 5+ = kill) ──

  {
    path: "/mock/empty",
    spec: "§3.3 soft",
    summary: "Empty events array — soft signal IF target group has baseline; SKIP if baseline_establishing",
    handler: (_, res) => sendJson(res, 200, EMPTY_EVENTS_JSON),
  },
  {
    path: /^\/mock\/latency\/(\d+)$/,
    spec: "§3.3 soft",
    summary: "Normal response delayed by :ms milliseconds — soft signal when latency > 2× baseline",
    handler: async (_, res, params) => {
      const ms = parseInt(params.ms, 10);
      if (Number.isFinite(ms) && ms > 0 && ms < 60_000) {
        await new Promise((r) => setTimeout(r, ms));
      }
      sendJson(res, 200, OK_EVENTS_JSON);
    },
  },
  {
    path: "/mock/access-denied",
    spec: "§3.3 soft",
    summary: "GraphQL ACCESS_DENIED error — detector parses response body for error.category",
    handler: (_, res) => sendJson(res, 200, GRAPHQL_ACCESS_DENIED),
  },
  {
    path: "/mock/redirect-home",
    spec: "§3.3 soft",
    gap: "G3",
    summary: "302 to /home.php (unexpected target) — detector verifies response URL matches expected group path",
    handler: (_, res) => redirect(res, 302, "/home.php"),
  },

  // ── §3.4 Canary signals (pre-flight; affects batch admission) ──

  {
    path: "/mock/group-deleted",
    spec: "§3.4 canary",
    gap: "G2",
    summary: "404 on group URL — canary's first-target HEAD check fails; drop this group, proceed rest",
    handler: (_, res) => sendHtml(res, 404, "<h1>Page not found</h1>"),
  },
  {
    path: "/mock/private-group",
    spec: "§3.4 canary",
    gap: "G2",
    summary: `302 redirect to /groups/:id/request_to_join/ — canary treats as "not accessible," drop this group`,
    handler: (_, res) => redirect(res, 302, "/groups/12345/request_to_join/?target_id=12345"),
  },
  {
    path: "/mock/dtsg-expired",
    spec: "§3.4 canary",
    gap: "C3",
    summary: `GraphQL response with error code 1357004 "session expired" — triggers dtsg regen (4xx-equivalent), per C3 precedence`,
    handler: (_, res) => sendJson(res, 200, DTSG_EXPIRED_JSON),
  },
];

// ── Route matcher + index ──

function matchRoute(pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const r of ROUTES) {
    if (typeof r.path === "string") {
      if (r.path === pathname) return { route: r, params: {} };
    } else {
      const m = pathname.match(r.path);
      if (m) {
        // Extract capture groups as named params (generic: param0, param1, ...
        // We only use one capture today — the :ms for latency)
        const params: Record<string, string> = {};
        if (m[1] !== undefined) params.ms = m[1];
        return { route: r, params };
      }
    }
  }
  return null;
}

// Index page — lists all routes for manual discovery
function sendIndex(res: ServerResponse) {
  const lines: string[] = [];
  lines.push("<!DOCTYPE html><html><body>");
  lines.push("<h1>mock-FB server — SAFEGUARD-SPEC.md §6</h1>");
  lines.push("<p>Booker contribution per spec §6.4. Drop-in test harness for niche-harvest safeguard chain.</p>");
  lines.push("<table border=1 cellpadding=6>");
  lines.push("<tr><th>Path</th><th>Spec</th><th>Gap</th><th>Summary</th></tr>");
  for (const r of ROUTES) {
    const pathStr = typeof r.path === "string" ? r.path : r.path.source;
    lines.push(`<tr><td><code>${pathStr}</code></td><td>${r.spec}</td><td>${r.gap ?? ""}</td><td>${r.summary}</td></tr>`);
  }
  lines.push("</table></body></html>");
  sendHtml(res, 200, lines.join("\n"));
}

// ── Server ──

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${argPort}`);
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/mock") {
      return sendIndex(res);
    }

    const match = matchRoute(pathname);
    if (!match) {
      return sendJson(res, 404, { error: "no-mock-route", hint: "GET / for route index" });
    }

    await match.route.handler(req, res, match.params);
  } catch (e: any) {
    sendJson(res, 500, { error: "mock-fb-handler-failed", detail: String(e?.message ?? e) });
  }
});

server.listen(argPort, "127.0.0.1", () => {
  console.log(`[mock-fb] listening on http://127.0.0.1:${argPort}`);
  console.log(`[mock-fb] route index: http://127.0.0.1:${argPort}/`);
  console.log(`[mock-fb] ${ROUTES.length} routes loaded`);
});

// Graceful shutdown on SIGTERM/SIGINT (useful for test runners)
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[mock-fb] ${sig} received, closing server`);
    server.close(() => process.exit(0));
  });
}
