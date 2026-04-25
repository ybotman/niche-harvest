#!/usr/bin/env node --experimental-strip-types
// ============================================================
// mock-FB server smoke tests — SAFEGUARD-SPEC.md §6 assertions
// ============================================================
// Standalone verification that mock-fb-server.ts responds with the
// expected shape on each of its 13 routes. These are SHAPE tests
// (does the server return the right status/body/headers?). They do
// NOT exercise niche-harvest's block-detector — that's a separate
// integration suite that lives in niche-harvest's test tree once
// the detector is implemented.
//
// These smoke tests are safe to check in and run on every CI so a
// regression in the mock server is caught independently of detector
// work.
//
// Usage:
//   node --experimental-strip-types smoke-test.ts [--port 9995]
// ============================================================

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  if (i >= 0 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10);
  return 9995;
})();

const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

// Start the server once for the whole suite. node:test runs tests in order
// (when declared top-level sync) so we can rely on this scaffolding.
before(async () => {
  server = spawn("node", ["--experimental-strip-types", `${import.meta.dirname}/mock-fb-server.ts`, "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait until port is listening
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/`, { redirect: "manual" });
      if (r.ok) return;
    } catch {}
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("mock-fb server failed to start within 5s");
});

after(() => {
  server?.kill();
});

// Import node:test scaffolding helpers
import { before, after } from "node:test";

// ── Shape tests ──

test("§3.4 /mock/ok → 200 normal event list JSON", async () => {
  const r = await fetch(`${BASE}/mock/ok`, { redirect: "manual" });
  assert.equal(r.status, 200);
  const body = await r.json() as any;
  assert.ok(body?.data?.group?.events?.edges, "missing expected GraphQL shape");
  assert.ok(body.data.group.events.edges.length > 0, "should have at least one event");
});

test("§3.2 /mock/429 → 429 with retry-after header (hard signal)", async () => {
  const r = await fetch(`${BASE}/mock/429`, { redirect: "manual" });
  assert.equal(r.status, 429);
  assert.ok(r.headers.get("retry-after"), "missing retry-after");
});

test("§3.2 /mock/checkpoint → 302 redirect to /checkpoint/ (hard signal)", async () => {
  const r = await fetch(`${BASE}/mock/checkpoint`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const loc = r.headers.get("location") ?? "";
  assert.match(loc, /\/checkpoint\//, "location should point at /checkpoint/");
});

test(`§3.2 /mock/interstitial → 200 with "We limit how often" (hard signal)`, async () => {
  const r = await fetch(`${BASE}/mock/interstitial`, { redirect: "manual" });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /We limit how often you can post, comment, or do other things/);
});

test("§3.2 /mock/logout → 302 redirect to /privacy/confirmation/ (hard signal)", async () => {
  const r = await fetch(`${BASE}/mock/logout`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const loc = r.headers.get("location") ?? "";
  assert.match(loc, /\/privacy\/confirmation\//);
});

test(`§3.2 /mock/challenge → 200 with "help us understand" (hard signal, G1)`, async () => {
  const r = await fetch(`${BASE}/mock/challenge`, { redirect: "manual" });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /help us understand/i, "must contain case-insensitive 'help us understand'");
  assert.match(html, /verify your identity|confirm your account/i, "must contain identity-challenge language");
});

test("§3.3 /mock/empty → 200 with empty events array (soft signal when baseline exists)", async () => {
  const r = await fetch(`${BASE}/mock/empty`, { redirect: "manual" });
  assert.equal(r.status, 200);
  const body = await r.json() as any;
  assert.deepEqual(body.data.group.events.edges, [], "events.edges must be empty array");
});

test("§3.3 /mock/latency/300 → 200 delayed by ~300ms (soft signal when >2× baseline)", async () => {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/mock/latency/300`, { redirect: "manual" });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.ok(elapsed >= 280, `expected >=280ms delay, got ${elapsed}ms`);
  assert.ok(elapsed < 600, `expected <600ms total, got ${elapsed}ms (something is slow)`);
});

test("§3.3 /mock/access-denied → 200 with GraphQL ACCESS_DENIED (soft signal)", async () => {
  const r = await fetch(`${BASE}/mock/access-denied`, { redirect: "manual" });
  assert.equal(r.status, 200);
  const body = await r.json() as any;
  assert.ok(Array.isArray(body.errors), "expected errors array");
  assert.equal(body.errors[0].category, "ACCESS_DENIED");
});

test("§3.3 /mock/redirect-home → 302 to /home.php (soft signal, G3)", async () => {
  const r = await fetch(`${BASE}/mock/redirect-home`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const loc = r.headers.get("location") ?? "";
  assert.match(loc, /\/home\.php$/);
});

test("§3.4 /mock/group-deleted → 404 (canary fail, G2)", async () => {
  const r = await fetch(`${BASE}/mock/group-deleted`, { redirect: "manual" });
  assert.equal(r.status, 404);
});

test("§3.4 /mock/private-group → 302 to /request_to_join/ (canary fail, G2 variant)", async () => {
  const r = await fetch(`${BASE}/mock/private-group`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const loc = r.headers.get("location") ?? "";
  assert.match(loc, /\/request_to_join\//);
});

test(`§3.4 /mock/dtsg-expired → 200 with error code 1357004 (canary fail, C3)`, async () => {
  const r = await fetch(`${BASE}/mock/dtsg-expired`, { redirect: "manual" });
  assert.equal(r.status, 200);
  const body = await r.json() as any;
  assert.ok(Array.isArray(body.errors), "expected errors array");
  assert.equal(body.errors[0].code, 1357004, "must carry FB's session-expired error code");
});

test("/mock/unknown → 404 (not a mocked route)", async () => {
  const r = await fetch(`${BASE}/mock/unknown-route-xyz`, { redirect: "manual" });
  assert.equal(r.status, 404);
});

test("/ → 200 index page lists all routes", async () => {
  const r = await fetch(`${BASE}/`, { redirect: "manual" });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /\/mock\/ok/);
  assert.match(html, /\/mock\/challenge/);
  assert.match(html, /\/mock\/redirect-home/);
});
