---
date: 2026-04-24
persona: narvest
type: decision
state: locked
permanence: long-term
tags: [type/decision, app/tangotiempo, product/mongodb]
appid: 1
reviewers: [aidi, booker]
locked_at: 2026-04-25
locked_by: [aidi, booker]
---

# SAFEGUARD-SPEC — niche-harvest FB Session Safeguards

> **Status: LOCKED 2026-04-25** (AIDI Q1=C applied in v2 2026-04-24; Booker conditional-greenlight additions applied in v3 2026-04-24; AIDI v3 verification cleared 2026-04-25; mock-FB integrated 2026-04-24 with 15/15 smoke green). Implementation begins; drift returns to this doc, not silent divergence. Live-run gate still requires AIDI greenlight on the readiness artifact (§7.1) before any live FB session.

> **Scope:** The three mandatory safeguards niche-harvest implements before any live authenticated FB session. Applies to all FB-adapter operations (group event-list scrapes, event-detail fetches, profile-page fetches). Does NOT cover FB extraction logic (that's `LOADER-CONTRACT.md §14` and Booker's `facebook.ts`), nor general-purpose rate-limiting for iCal / web / API adapters (those have their own per-source rules).

> **Cross-niche scope note:** The PATTERN (block-detector + rate-limiter + watchdog) is universal for any future niche scraping a rate-limited / policy-sensitive platform. The VALUES in this doc are FB-specific. Other platforms (Instagram, Meetup, partner feeds) will have their own spec document with their own values. Do not treat FB's thresholds as defaults for other sources.

---

## 1. Purpose

**Why this spec exists:** Path D (authenticated non-stealth FB access) was re-authorized by Toby 2026-04-24 after the 2026-04-17 soft-block incident forced CDP off. Re-authorization is contingent on disciplined safeguards. The three safeguards below are AIDI's non-negotiable gate.

**What "success" looks like operationally:**
- niche-harvest runs FB sessions for months without triggering a soft-block
- When a soft-block signal appears, session halts BEFORE escalation (not after)
- Every safeguard event is observable on the hub (no silent failures)
- Operators have a clear resume protocol when a session is paused

**FTPNTD alignment:** these safeguards fix the PROCESS that broke 2026-04-17, not the symptom. The 2026-04-17 root cause was retrospective watchdog + inconsistent per-group cooldown enforcement. Both are addressed below.

---

## 2. The three non-negotiable safeguards

Per AIDI 2026-04-24 ruling. All three must be demonstrably operational (running and tested, not "planned") before any live FB session. No exceptions, no "move fast and ask forgiveness."

| # | Safeguard | One-line responsibility |
|---|-----------|-------------------------|
| 1 | **Block-detector** | Detects soft-block signals and halts IMMEDIATELY |
| 2 | **Rate-limiter** | Enforces delays, never best-effort |
| 3 | **Watchdog** | External kill-switch, not in-process |

---

## 3. Block-detector

### 3.1 Design principle

Detect **before** the line is crossed, not after. Booker's current watchdog was retrospective (killed runs after bad signals had already stacked up). M1 design is proactive — we catch early-warning signals and halt or slow down before escalation.

### 3.2 Hard signals (immediate pause, require manual resume)

Any single hard signal triggers immediate session kill. No rolling window, no threshold, no "let's see if it recovers."

| Signal | Detection | Action |
|--------|-----------|--------|
| HTTP 429 or redirect to `/checkpoint/` | Response status + URL match | CAPTCHA served. Dead stop. Write `fb_blocked` quality_flag on in-flight event. Hub message to operator. |
| FB "We limit how often you can post, comment, or do other things" interstitial | HTML string match | Soft-block in flight. Pause FB sessions 24–72h per operator discretion. |
| 3+ consecutive TCP reset / connection-refused on `.facebook.com` | Rolling count within session | IP or session blacklist. Escalate to operator. |
| Redirect to `/privacy/confirmation/` or `/help/?ref=logout` | URL match | Session invalidated. Manual re-login required. |
| **Identity challenge / "help us understand" interstitial** (Booker v3 G1) | URL contains `/help/contact/` OR HTML contains `help us understand` / `verify your identity` / `confirm your account` | Account-flagged. Kill session. Manual review required before resume. Cannot be automated past. |

**Implementation note:** detection runs on the CDP Network domain event stream. Intercept the response before the extraction logic sees it; if hard signal fires, stop the tab.

### 3.3 Soft signals (slow down, don't stop)

Two or more soft signals in a 10-minute window trigger rate-limiter cooldown (§4). Five or more trigger a session kill.

| Signal | Detection | Baseline required? |
|--------|-----------|-------------------|
| Empty event list from a known-nonzero-baseline group | Per-group `expected_nonzero_baseline` tracked historically | YES — baseline per-group |
| 3+ consecutive empties from high-expected-yield groups | Rolling per-group | YES |
| Response latency p90 > 2× baseline | Rolling per-adapter | YES — latency baseline tracked |
| GraphQL response contains `error: ACCESS_DENIED` or truncated payload | Payload inspection | NO |
| **Unexpected redirect to non-target page** (Booker v3 G3) | Response URL doesn't match expected path structure (e.g., redirects to `/home.php`, `/groups/` without target slug, `/login/`) | NO |

**Baseline tracking:** niche-harvest maintains a `fb_group_baseline` table with `(group_id, expected_nonzero_event_count, latency_p90_ms, measured_at)`. Updated on every successful scrape; read on every run to calibrate what "abnormal" looks like.

**First-run behavior (AIDI 2026-04-24 Gap 2):** signals that require a baseline are SKIPPED when the baseline has not yet been established. Specifically:
- If `fb_group_baseline.latency_p90_ms` is null for a group → latency soft-signal is skipped (not enough data). Log as `baseline_establishing`.
- If `fb_group_baseline.expected_nonzero_event_count` is null → empty-list soft-signal is skipped. Log as `baseline_establishing`.
- Baseline becomes ACTIVE for a group after **3 successful scrapes** of that group. Values computed as median of observed nonzero counts / latencies across those 3 runs.
- Baseline-skipped signals still log to `fb_signal_log` with a `baseline_missing` detail; they do NOT count toward the 2+/5+ thresholds.

**Rolling signal count ownership (AIDI 2026-04-24 Gap 1):** Block-detector is the SINGLE OWNER of the rolling soft-signal count. It persists signals to `fb_signal_log` table with columns `(timestamp, signal_type, group_id, session_id, detail)`. Watchdog (§5) READS from this same table to evaluate thresholds; it does NOT maintain its own count. One owner, one store — no split-brain risk. Table schema details live in `ARCHITECTURE.md`.

### 3.4 Canary signals (pre-flight, before any batch)

Runs before the first request of any batch. If canary fails, the batch does not start.

| Check | Detection | Action on fail |
|-------|-----------|----------------|
| Known-static FB page (own profile or `/facebook/`) fetches OK | Expected DOM element present | Abort batch; session not logged in |
| Session `fb_dtsg` token age ≤ 24h | Token timestamp | Regenerate token before starting |
| Global daily ceiling not yet reached | §4.3 counters | Abort batch; today's quota spent |
| **First target group responds 200 (not 404, not redirect-to-home)** (Booker v3 G2) | HEAD request on group URL | Drop THAT group from the batch (not whole batch); proceed with remaining groups. If ALL groups fail this check, abort batch and alert operator. |

**Implementation:** canary results logged to `runs` table with outcome. Operator can review history before a batch starts.

---

## 4. Rate-limiter

### 4.1 Design principle

Three layers, **all must pass** before a request fires. Hard gates, not best-effort. Booker's 2026-04-17 incident traced to inconsistent per-group cooldown enforcement — some groups got hit 3-4× per week. M1 design closes that gap: rate-limiter is in-process enforcement, not organizational discipline.

### 4.2 Three layers

| Layer | Rule | Hard gate |
|-------|------|-----------|
| **Per-group cooldown** | Minimum 14 days between scrapes of the same FB group | YES — hard, refuse to queue |
| **Per-event cooldown** | 30–60 seconds between event-detail fetches within a group. Human-like variance: ±20% jitter randomized per-request | YES — hard, sleep before next request |
| **Global ceiling** | Max 5 groups/day AND max 50 event-detail fetches/day per niche-harvest process | YES — refuse to start or continue |

### 4.3 Enforcement mechanics

- `fb_group_last_scraped_at` tracked per-group in SQLite; queries filter at group-selection time
- `fb_event_last_fetched_at` in a rolling daily counter; asserts at event-fetch time
- Global counters in the runs table: `fb_groups_today`, `fb_events_today`, reset at UTC midnight
- **If any layer blocks: log reason as `rate_limited`, queue/session state persists, resume on next available window**
- Rate-limiter refuses to bypass even for operator "just this one" requests — bypass requires code change + new deploy

### 4.4 Jitter specifics (per-event cooldown)

- Base delay: 30s minimum, 60s maximum, uniformly sampled per request
- ±20% jitter applied: so effective delay is 24–72s range
- Jitter seed is crypto-random, not deterministic — prevents signature pattern detection

---

## 5. Watchdog

### 5.1 Design principle

External kill-switch, not in-process. An in-process watchdog can be bypassed if the worker process hangs or enters a bad state. External means a separate process / systemd timer / cron that monitors and can SIGKILL.

### 5.2 Cadence and triggers

| Aspect | Value | Why |
|--------|-------|-----|
| Check interval | **60 seconds** | 2026-04-17 incident progressed in <10 min; 300s (Booker's original) was too slow |
| Hard signal trigger | **Single occurrence = kill** | Not "3 in rolling window." Hard signals are hard. |
| Soft signal trigger | 2+ in 10-min window = slow-down; 5+ = kill | Calibrated to distinguish transient from sustained |
| State persistence on kill | Last-successful-group-slug written after each completion | Resume-point clear on next run |
| Escalation on kill | Auto-send hub message to operator (`narvest-tango` → hub broadcast or AIDI-routed) | Don't make humans discover the kill from silent logs |

### 5.3 Implementation

**Laptop M1 (AIDI 2026-04-24: file-based heartbeat):**
- Worker writes `data/watchdog/fb-heartbeat.json` every **30 seconds** during active FB sessions. Content: `{timestamp, state, last_group_id, session_id, signals_in_window}`.
- Watchdog process (separate Node process, not in-worker) checks heartbeat file age every **60 seconds**.
- If `now - heartbeat.timestamp > 90s` → SIGKILL worker PID (1 missed heartbeat + safety margin).
- Watchdog also reads `fb_signal_log` from SQLite (§3.3) to evaluate threshold-based kills independent of heartbeat.
- Kill triggers hub-escalation message (§5.4).

**Pi M1.5:** systemd service with `Restart=no` and a separate watchdog systemd service that monitors the worker's health-check file (same file-based heartbeat pattern). Kill via `systemctl stop narvest-tango` or `kill -9` on worker PID.

**Startup race (Booker v3 C1):** On worker start, the worker writes an initial heartbeat BEFORE entering the main loop. Watchdog has a **30-second grace period on first-start**: no kill triggered until watchdog has seen at least one valid heartbeat. After the first valid heartbeat, the 90s miss threshold applies. Prevents the "crash-on-start SIGKILL of already-dead process" noise.

**Dry-run / test:** watchdog mock that fires programmatic triggers; end-to-end test verifies kill + escalation pipeline. Mock-FB test matrix (§6.3) exercises the full chain.

### 5.4 Hub escalation message format

```
{
  "from": "narvest-tango",
  "to": ["aidi", "broadcast"],
  "subject": "FB session killed",
  "priority": "high",
  "body": {
    "reason": "hard_signal | soft_signal_threshold | health_check_failed",
    "signal_detail": "...",
    "last_group": "argentinetangonyc",
    "last_event_id": "...",
    "killed_at": "2026-04-24T20:00:00Z",
    "resume_protocol": "manual review; check account state; AIDI greenlight to resume"
  }
}
```

---

## 6. Pre-first-run mock-FB dry-run

### 6.1 Why

Per Booker 2026-04-24: the 2026-04-17 soft-block incident would have been caught by a mock-FB test of the soft-block interstitial pattern. We catch the "watchdog triggers too late" class of bug without burning a real FB session.

### 6.2 Mock server contract

A local HTTP server that responds with known bad patterns on demand. Routes:

| Path | Response | Tests |
|------|----------|-------|
| `/mock/ok` | Normal event list JSON | Baseline / canary passes |
| `/mock/429` | HTTP 429 with rate-limit headers | Hard signal trigger |
| `/mock/checkpoint` | Redirect to `/checkpoint/` URL | Hard signal trigger |
| `/mock/interstitial` | HTML with "We limit how often..." string | Hard signal trigger |
| `/mock/logout` | Redirect to `/privacy/confirmation/` | Hard signal trigger |
| `/mock/challenge` | Identity-challenge interstitial at `/help/contact/` | Hard signal G1 |
| `/mock/empty` | JSON with empty events array | Soft signal (if group has baseline) |
| `/mock/latency/:ms` | Normal response delayed by Nms | Soft signal when >2× baseline |
| `/mock/access-denied` | GraphQL ACCESS_DENIED error | Soft signal trigger |
| `/mock/redirect-home` | 200 but response URL is `/home.php` (wrong path) | Soft signal G3 |
| `/mock/group-deleted` | 404 on target group URL | Canary G2 (drop group, not batch) |
| `/mock/private-group` | Redirect to "join to see" gate page | Canary G2 variant (drop group) |
| `/mock/dtsg-expired` | Response requiring token regen (4xx with expired-token signal) | Token regen trigger C3 |

### 6.3 Test assertions (automated)

- Every hard signal mock fires exactly one kill (not zero, not more than one)
- Zero false-positives on `/mock/ok` (normal traffic does not trigger)
- `/mock/empty` fires soft signal ONLY when the group's baseline expects nonzero
- Latency soft-trigger fires at 2.0× but not at 1.9× baseline
- State-persistence: after simulated kill, resume-point is recoverable from SQLite
- Hub escalation: every kill produces exactly one hub message

### 6.4 Booker's contribution

Booker has offered to write the mock-FB server. Accepting: the 2026-04-17 incident informs realistic patterns better than generic mocks. Mock lives in niche-harvest's test suite (`test/mock-fb/`) and is checked into the repo so future changes run the full matrix on every CI.

---

## 7. Overseer review gate

### 7.1 Readiness artifact

Before AIDI greenlights the first live FB session, niche-harvest produces:

**`niche-harvest/docs/readiness/FB-SAFEGUARD-READINESS-tango.md`**

Contents:
- Date produced + niche-harvest commit SHA
- For each of the 3 safeguards: implementation location (file:line), test evidence (pass/fail summary), mock-FB dry-run results
- Current `fb_group_baseline` contents (per-group nonzero expectations + latency p90)
- Global ceiling configuration (groups/day, events/day)
- Watchdog implementation + escalation path (hub recipient + message shape)
- Resume protocol documented
- Known limitations / not-yet-tested scenarios

### 7.2 AIDI gate mechanics

- AIDI reviews the readiness artifact in full
- Greenlight = explicit hub message "CLEARED FOR FIRST LIVE FB SESSION {niche} {date}"
- No verbal greenlight, no "looks good," no "proceed" without the specific string
- AIDI retains right to request additional evidence before greenlight

### 7.3 Post-first-run review

After the first live session (batch limited to 2 groups / 5 events as initial smoke):
- niche-harvest submits post-run report to AIDI within 24h
- Must include: events captured, signals observed, rate-limiter blocks, watchdog trigger count, any anomalies
- AIDI reviews before authorizing the next batch
- Full batch size (5 groups / 50 events per day) only after successful smoke run

**Auto-extend rule (AIDI 2026-04-24):** If the post-run report shows ANY soft signals fired during the smoke batch — even if the 2+/5+ kill thresholds weren't reached — the rate-limiter cooldowns **automatically extend by 50% for the next batch** before AIDI reviews. Affected: per-group cooldown (14d → 21d) and per-event cooldown (base 30-60s → 45-90s). Global ceiling unchanged. The extend is automatic and takes effect even if AIDI has not yet reviewed. This prevents "just below threshold" signal accumulation from going into the next run blind. AIDI's review can lift the extension after evaluating the smoke results.

**Auto-extend stacking + reset (Booker v3 C2):** Extensions compound up to a **cap of 2× baseline** — per-group 14d → 28d max; per-event 30-60s → 60-120s max. Further soft-signal batches at the cap do not extend further (already at max). The extension **resets to baseline** after **2 consecutive batches complete with zero soft signals fired**. AIDI manual lift takes precedence over auto-extend and auto-reset logic — AIDI can override either at any time via hub message.

**Manual-lift hub command format (AIDI 2026-04-24):**

```json
{
  "from": "aidi",
  "to": ["narvest-{niche}"],
  "subject": "FB cooldown manual lift",
  "priority": "normal",
  "body": {
    "action": "reset_cooldowns",
    "niche": "tango",
    "scope": "per_group | per_event | all",
    "reason": "freeform operator rationale",
    "effective_at": "<ISO 8601 timestamp, or immediate>"
  }
}
```

Worker receives the message, verifies sender is `aidi` (or Toby as override), resets the named scope's cooldowns to baseline, and acknowledges via hub reply. No other persona can issue this command; unauthorized senders get a logged + ignored + hub-notified ("unauthorized manual-lift attempt from {sender}") response.

### 7.4 Revocation

AIDI or Toby can revoke FB session authorization at any time via hub message. Revocation takes effect immediately — next canary check will fail and batch will abort.

---

## 8. Open questions / pending

| # | Question | Owner | Status |
|---|----------|-------|--------|
| 1 | ~~Watchdog implementation for laptop M1~~ | AIDI | ✅ RESOLVED 2026-04-24: file-based heartbeat at `data/watchdog/fb-heartbeat.json`, 30s write / 60s check / 90s SIGKILL threshold |
| 2 | Mock-FB server delivery timing | Booker | Lands AFTER Booker reviews this spec — he tailors mock patterns to the signal taxonomy rather than pre-building generic (confirmed Booker 2026-04-24) |
| 3 | ~~Hub escalation recipient~~ | AIDI | ✅ RESOLVED 2026-04-24: AIDI + broadcast (not AIDI-only; visibility when AIDI offline at kill time) |
| 4 | ~~Post-first-run batch size ramp~~ | AIDI | ✅ RESOLVED 2026-04-24: 2/5 → 5/50 is fine; smoke run IS the calibration; auto-extend rule in §7.3 handles borderline cases |
| 5 | ~~`fb_dtsg` TTL~~ | Booker | ✅ RESOLVED 2026-04-24 (v3 C3): **4xx regeneration takes precedence over age-based TTL.** 24h default is a backstop upper bound (regen even if no 4xx seen); 4xx trigger is the primary signal. So: age ≤ 24h + no 4xx = keep token. Any 4xx (regardless of age) = regen. Age > 24h (regardless of 4xx) = regen. |

---

## 9. Change log

| Date | Change | Source |
|------|--------|--------|
| 2026-04-24 | Initial draft | Narvest synthesis of Booker's 2026-04-24 safeguard spec + AIDI's non-negotiable gate + Toby's Read 2 re-authorization |
| 2026-04-24 | v2: AIDI Q1=C feedback — closed Gap 1 (signal-count ownership in `fb_signal_log`), Gap 2 (baseline-establishing first-run behavior), watchdog impl locked to file-based heartbeat, hub escalation recipient AIDI+broadcast, post-run auto-extend 50% rule | AIDI overseer review 2026-04-24 |
| 2026-04-24 | v3: Booker conditional-greenlight additions — G1 identity-challenge hard signal; G2 target-group-accessibility canary; G3 unexpected-redirect soft signal; C1 watchdog startup grace (30s initial heartbeat); C2 auto-extend cap (2× baseline) + reset (2 clean batches); C3 `fb_dtsg` 4xx-precedence over TTL; §6.2 mock-FB matrix expanded 8→13 routes | Booker implementation review 2026-04-24 |
| 2026-04-25 | **LOCKED** — AIDI v3 additive verification cleared; mock-FB integrated at `test/mock-fb/` (15/15 smoke green 495ms); readiness-artifact template authoring deferred to Phase 6 as non-blocking. | AIDI 2026-04-25 |

---

## 10. Review checklist (before locking)

- [x] AIDI: overseer Q1=C — returned 2026-04-24 with two gaps closed in v2
- [x] AIDI: post-fix verification of v2 (cleared 2026-04-24)
- [x] Booker: implementation review — conditional greenlight 2026-04-24 with v3 additions (G1-G3, C1-C3)
- [x] AIDI: v3 additive verification (Booker's additions cleared 2026-04-25)
- [x] Narvest: ARCHITECTURE.md captures watchdog process model (laptop M1 file-based heartbeat; Pi M1.5 systemd equivalent) — ARCHITECTURE.md §6 (2026-04-24)
- [x] Narvest: ARCHITECTURE.md specifies `fb_signal_log` SQLite table schema — ARCHITECTURE.md §3.1 (2026-04-24)
- [x] All open questions (§8) resolved or explicitly deferred — 5 of 5 now resolved (Q5 closed by Booker's v3 C3 ruling)
- [x] Mock-FB server committed to `test/mock-fb/` with full 13-route test matrix green — Booker delivered 2026-04-24; integrated by Narvest 2026-04-24; smoke test 15/15 pass in 495ms (`node --experimental-strip-types test/mock-fb/smoke-test.ts`)
- [ ] `FB-SAFEGUARD-READINESS-tango.md` template agreed before first implementation begins (Phase 6 deliverable; not lock-blocking)

When all checked → state: `locked`, implementation begins, readiness artifact produced after implementation, live FB session only after AIDI greenlight on readiness artifact.

**Locked 2026-04-25.** Readiness-artifact template authoring is a Phase 6 deliverable, not a lock blocker — the spec stands on its own.
