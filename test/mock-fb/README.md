# mock-FB server — niche-harvest SAFEGUARD-SPEC.md §6 test harness

**Author:** Booker contribution per spec §6.4 (2026-04-24)
**Target location:** `niche-harvest/test/mock-fb/`
**Review path:** AIDI cleared SAFEGUARD-SPEC v3 before this shipped; no further review gate on the server itself, but niche-harvest's block-detector integration tests that *consume* this server go through normal Narvest → AIDI flow.

## What this is

A zero-dependency Node HTTP server that responds with the 13 bad-pattern shapes enumerated in SAFEGUARD-SPEC.md §6.2. Purpose: exercise niche-harvest's block-detector + rate-limiter + watchdog chain without burning a real FB session. Every route is tagged with the originating spec section (§3.2 hard / §3.3 soft / §3.4 canary) and, where applicable, the v3 gap item (G1/G2/G3/C3) the route was added to validate.

The 2026-04-17 soft-block incident that scared CDP off would have been caught by running the detector against `/mock/interstitial` before first live session. That test now exists.

## Files

- **`mock-fb-server.ts`** — the server. One file, ~220 lines, Node 22 `http` built-in only.
- **`smoke-test.ts`** — 15 shape tests (status codes + body/header assertions). Verifies the server itself; does NOT exercise niche-harvest's detector. Safe to run on every CI.
- **`README.md`** — this file.

## Quick start

```bash
# Run the server
node --experimental-strip-types mock-fb-server.ts --port 9995

# In a separate terminal — browse the route index
open http://127.0.0.1:9995/

# Smoke-test the server
node --experimental-strip-types smoke-test.ts --port 9995
```

All 15 smoke tests should pass in under 1 second.

## Route matrix (13 routes)

| Path | Spec | Gap | Behavior |
|------|------|-----|----------|
| `/mock/ok` | §3.4 baseline | — | 200 normal event list JSON (canary should pass, no detectors fire) |
| `/mock/429` | §3.2 hard | — | 429 with `retry-after: 3600` |
| `/mock/checkpoint` | §3.2 hard | — | 302 → `/checkpoint/?next=%2F` |
| `/mock/interstitial` | §3.2 hard | — | 200 with `"We limit how often you can post, comment, or do other things"` HTML |
| `/mock/logout` | §3.2 hard | — | 302 → `/privacy/confirmation/?ref=logout` |
| `/mock/challenge` | §3.2 hard | G1 | 200 with `"help us understand"` / `"verify your identity"` HTML |
| `/mock/empty` | §3.3 soft | — | 200 with empty `events.edges: []` |
| `/mock/latency/:ms` | §3.3 soft | — | 200 delayed by `:ms` milliseconds (tested range 0-60000) |
| `/mock/access-denied` | §3.3 soft | — | 200 with GraphQL ACCESS_DENIED error |
| `/mock/redirect-home` | §3.3 soft | G3 | 302 → `/home.php` (unexpected path) |
| `/mock/group-deleted` | §3.4 canary | G2 | 404 on group URL |
| `/mock/private-group` | §3.4 canary | G2 | 302 → `/groups/12345/request_to_join/` |
| `/mock/dtsg-expired` | §3.4 canary | C3 | 200 with FB error code 1357004 "Session has expired" |

Index page at `/` lists all routes with their spec tags.

## Fidelity to real FB behavior

Where possible, response shapes match what FB actually serves:

- **`/mock/interstitial`** — the "We limit how often you can post..." string was captured from the 2026-04-17 soft-block incident. Detectors should match on literal substring; do not paraphrase or translate.
- **`/mock/access-denied`** — GraphQL error shape (`errors[].category = "ACCESS_DENIED"`, `errors[].code = 1357033`) matches FB's actual response for permission-denied.
- **`/mock/dtsg-expired`** — error code `1357004` is FB's "session expired, user must log in again" marker.
- **`/mock/checkpoint`** — FB's actual challenge URL is `/checkpoint/?next=<encoded-target>`. Matched.
- **`/mock/private-group`** — private groups redirect to `/groups/:id/request_to_join/?target_id=:id`. Matched.

Routes NOT based on captured traffic:
- **`/mock/challenge`** — identity-challenge language is representative, not exact. FB rotates this UI. Detector should match on any of {"help us understand", "verify your identity", "confirm your account"} — all three appear in the fixture.

## How niche-harvest consumes this

Expected integration (per SAFEGUARD-SPEC §6.3):

1. niche-harvest's block-detector is code-callable given a response object
2. Integration test spins up mock-fb-server on a local port
3. For each route, test fires an HTTP request to the mock, captures the response, feeds it to the block-detector, asserts the expected detection outcome
4. State-persistence assertion: after simulated kill, resume-point is recoverable from SQLite
5. Hub escalation assertion: every kill produces exactly one hub message

The smoke tests here cover step 1-2 (server itself behaves correctly). Steps 3-5 belong to niche-harvest's test tree and consume this server as a test dependency.

## Test assertion guide (§6.3)

Mapping from spec assertions to mock routes:

| Spec assertion | Test shape |
|----------------|------------|
| Every hard signal mock fires exactly one kill | For each of `/mock/{429,checkpoint,interstitial,logout,challenge}`: issue request, feed to detector, assert `kill_event_count === 1` |
| Zero false-positives on `/mock/ok` | Issue request, feed to detector, assert no kill AND no soft-signal count increment |
| `/mock/empty` fires soft ONLY when baseline expects nonzero | Two-part: (a) fresh group, no baseline → assert `signal_logged_as_baseline_missing`; (b) same group with baseline of 10 events → assert `soft_signal_count += 1` |
| Latency fires at 2.0× but not 1.9× baseline | Baseline = 200ms. Issue `/mock/latency/400` → assert soft signal fires. Issue `/mock/latency/380` → assert does NOT fire. |
| State-persistence: resume after kill | Simulate kill via hard signal, restart worker, assert `last_successful_group_slug` matches pre-kill state |
| Hub escalation: one kill = one message | Mock the hub transport, issue hard-signal request, assert exactly one `hub.send` call with expected body shape |

## CI integration recipe

```bash
# In niche-harvest's test script:
node --experimental-strip-types test/mock-fb/mock-fb-server.ts --port 9995 &
SERVER_PID=$!
trap "kill $SERVER_PID" EXIT
# Wait for server to boot (smoke-test has this helper)
sleep 1
# Run niche-harvest's block-detector integration tests against the mock
node --experimental-strip-types test/safeguards/block-detector-integration.ts
# smoke tests run independently
node --experimental-strip-types test/mock-fb/smoke-test.ts
```

## Extending the server

Add a new route entry to the `ROUTES` array in `mock-fb-server.ts`. Each entry needs:
- `path`: string or RegExp
- `spec`: which SAFEGUARD-SPEC section the route validates
- `gap` (optional): G1/G2/G3/C1/C2/C3 if the route addresses a v3 gap
- `summary`: one-line description for the index page
- `handler`: `(req, res, params) => void` (or async)

If the new route adds a new class of signal (not currently in spec), coordinate with Narvest to update SAFEGUARD-SPEC first; don't ship detection logic the spec doesn't authorize.

## Known limitations

- **Stateful per-group baseline NOT simulated here.** The mock server is stateless — it returns the same response every time. niche-harvest's baseline tracking (per-group expected nonzero counts, rolling latency p90) is detector-side state; tests that need "baseline exists for group X" must pre-populate the detector's baseline SQLite table before issuing the mock request.
- **Time-based signals NOT simulated via the server.** The 10-min rolling window for "2+ soft signals = slow-down" is detector-side clock/state; test harness uses fake-time or clock-shim on the detector, not on the mock server.
- **No backoff simulation.** The mock doesn't simulate FB's "you keep hitting me so I'll get quieter" progressive block. The detector's job is to avoid ever getting there; the mock's job is just to fire the individual signals.

## Out of scope

- niche-harvest's block-detector implementation (belongs in niche-harvest's tree)
- Rate-limiter unit tests (per-group cooldown, per-event jitter — those are pure timer tests, don't need the mock)
- Watchdog unit tests (heartbeat file monitoring — needs fake clock / fake filesystem, not an HTTP mock)
- Real FB traffic capture (do NOT add captured real-user data to fixtures — PII, ToS issues)

## Handoff from Booker

This bundle was developed in Booker's `/tmp/` workspace and parked here for Narvest to integrate. Per lane-separation discipline, Narvest owns the commit into niche-harvest's tree. No changes to Booker's own code.

When integrated:
- `niche-harvest/test/mock-fb/mock-fb-server.ts`
- `niche-harvest/test/mock-fb/smoke-test.ts`
- `niche-harvest/test/mock-fb/README.md`

Smoke-test should land in CI as a standalone job — catches mock-server regressions independent of detector work.

Questions / issues: ping Booker. Spec-level changes go through Narvest → AIDI first.
