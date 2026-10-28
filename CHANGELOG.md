# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version below is the version declared in `package.json`. Every entry
summarizes one or more commits in this repository's `git log`, grouped by
change type; no entry describes a feature that is not in the history.

## [Unreleased]

### Added

- Watchdog `actOnStaleTasks` notify-only benchmark row
  (backlog #686): `bench/bench.ts` adds an
  `actOnStaleTasks notify-only (12 mixed-state tasks, fresh fixture)`
  row — the reminder-loop shape (record the id, dispatch nothing)
  that the demo's notify-only loop uses, previously invisible
  beside the default-ABANDON executor row. One timed pass rebuilds
  the same 12-task watchdog batch fresh (for parity with the other
  executor rows, even though the action mutates nothing), runs
  `actOnStaleTasks` with a notify-only action, and self-checks
  every iteration: 4 notifications in batch order (WD-01, WD-04,
  WD-06, WD-08), every outcome acted with no error and no audit
  entry, and byte-identical states and histories across the whole
  batch. This run: ~2,478 ops/sec (403.58 µs/op), against ~912.1
  ops/sec for the default-ABANDON row — the gap is the dispatch
  plus hash-chained audit entry the notify path skips, with the
  fixture rebuild and byte self-checks still inside the timed
  region. No source change: the path was unmeasured, not
  unimplemented. README Benchmarks table refreshed from this run.
- Payout webhook fan-out x jitterMs benchmark row
  (backlog #685): `bench/bench.ts` adds a
  `deliverPayoutWebhookToMany jitterMs fan-out (4 endpoints)` row
  — the combination the single-endpoint jitter row and the plain
  fan-out row each cover alone. One timed pass is two fan-outs:
  a jittered 4-endpoint fan-out (every endpoint on a 500 / 500 /
  200 script, backoffMs 100, maxAttempts 3, jitterMs 1000) whose
  per-endpoint sleeps must land inside [100, 1100] and
  [200, 1200], and a zero-jitter control fan-out sleeping exactly
  [100, 200] per endpoint; every endpoint must report
  `{ ok: true, attempts: 3, status: 200 }` with exactly 3 fetch
  calls, so a retrying endpoint never consumes or blocks
  another's budget. Each endpoint records its own sleeps,
  because the deliveries run concurrently and a shared recorder
  could not pin per-endpoint windows; the exact [100, 700]
  spread stays pinned by the single-endpoint row, since
  concurrent endpoints share the global `Math.random` and draw
  order is nondeterministic. Every endpoint's final call body
  carries the shared eventId and verifies under its own secret
  (pinned outside the timed loop). No source change: the
  combination was unmeasured, not unimplemented. README
  Benchmarks table refreshed from this run.
- RESUBMIT budget x payoutRef gate combination coverage
  (backlog #684): `test/resubmitPayoutRef.test.ts` (5 cases) pins
  that the two mechanisms are orthogonal — a maxResubmits-1 task
  with requirePayoutRef that has spent its RESUBMIT and reached
  PAYOUT_PENDING still rejects a payout without a ref
  (`payout reference required: …`) with no history residue, no
  seq gap and the RESUBMIT count still 1, and the corrected
  payout with a ref (reusing the failed attempt's idempotency
  key) succeeds; the budget stays exhausted for a second
  RESUBMIT after a full resubmit round, the same round without
  the gate pays out without a ref (control), and fromHistory
  re-attaches both switches together. No source change: the
  combination was untested, not unimplemented.
- SLA overdue x DISPUTE budget combination coverage
  (backlog #683): `test/slaDisputeBudget.test.ts` (6 cases) pins
  that the two mechanisms are orthogonal — an exhausted budget
  never blocks EXPIRE (a budget-1 task that spent its DISPUTE,
  then RESUBMITs into CAPTURING, still expires once overdue, and
  a budget-0 task expires without ever disputing), while being
  overdue never waives the budget (a budget-1 task back in
  REJECTED and overdue still gets `dispute budget exhausted:
  1 of 1`); `expiredTasks` screening is budget-blind, the
  `expireOverdueTasks` watchdog batch expires the CAPTURING
  task and reports the REJECTED one as `invalid transition:
  EXPIRE from REJECTED` (never a budget error), and a snapshot
  round-trip preserves the combination on both sides. No
  source change: the combination was untested, not
  unimplemented — with one honest correction to the backlog
  text, which assumed an overdue task that just disputed could
  EXPIRE, but DISPUTED and REJECTED have no EXPIRE edge, so
  the EXPIRE leg runs in CAPTURING, the state a RESUBMIT
  lands in after the dispute round.
- SLA overdue x RESUBMIT budget combination coverage
  (backlog #676): `test/slaResubmitBudget.test.ts` (6 cases) pins
  that the two mechanisms are orthogonal — an exhausted budget
  never blocks EXPIRE (a budget-1 task that spent its RESUBMIT
  and sits in CAPTURING still expires once overdue, and a
  budget-0 task expires without ever resubmitting), while being
  overdue never waives the budget (a budget-1 task back in
  REJECTED and overdue still gets `resubmit budget exhausted:
  1 of 1`); `expiredTasks` screening is budget-blind, the
  `expireOverdueTasks` watchdog batch expires the CAPTURING
  task and reports the REJECTED one as `invalid transition:
  EXPIRE from REJECTED` (never a budget error), and a snapshot
  round-trip preserves the combination on both sides. No
  source change: the combination was untested, not
  unimplemented — with one honest correction to the backlog
  text, which assumed an overdue REJECTED task could EXPIRE,
  but REJECTED has no EXPIRE edge, so the EXPIRE leg runs in
  CAPTURING, the state a RESUBMIT lands in.
- NDJSON history export x payout fields combination coverage
  (backlog #674): `test/ndjsonPayout.test.ts` (12 cases) pins
  that a PAID task's history — `payoutRef`/`payoutAmount` on its
  PAYOUT_COMPLETE entry — survives NDJSON export and
  `fromHistory` replay with history deep-equal, state PAID,
  and `totalPaidOut` unchanged; zero amount, amount without
  ref, and ref without amount each round-trip; a
  PAYOUT_PENDING history keeps `requirePayoutRef` enforcement
  after the NDJSON hop; and damaged payout lines fail closed
  with the NDJSON line number (`invalid ndjson: line 8: …`
  for negative / non-number amounts and empty refs, line 16
  under blank-line shift), while a payoutAmount rewritten to
  another valid number is caught by the hash chain instead
  (the chain error carries no entry index, so it is not
  retagged with a line number). No source change: the
  combination was untested, not unimplemented.
- A stale-task watchdog reminder loop in the CLI demo (backlog
  #672): a mixed batch — DEMO-057 idle in OPEN past its 7-day
  budget, DEMO-058 freshly active in OPEN, DEMO-059 terminal in
  PAID despite a 22-day dwell — screened by `staleTasks()` and
  walked by `actOnStaleTasks()` with a notify-only action, so
  only DEMO-057 is selected and notified and no task's state or
  history changes. The stale task's SLA deadline is still ahead,
  pinning stale-is-not-overdue, and the segment states plainly
  that the state machine has no REMIND event: the reminder is
  the caller's out-of-band notification, and the disposition is
  the caller's choice. `DemoResult` gains
  `watchdogReminderTasks`, `watchdogReminderSelected`,
  `watchdogReminderResults`, and `watchdogReminderNotifiedIds`,
  and the demo's printed line count grows from 580 to 589.
- A benchmark path for payout webhook delivery-header verification
  (backlog #653): `deliverPayoutWebhook` against a real loopback
  HTTP server answering 500 then 200 (backoffMs 0, no-op sleep,
  default fetch) — one timed pass is one delivery, self-checked on
  every iteration for result { ok: true, attempts: 2, status: 200 }
  with exactly two captured requests, every attempt's
  `Idempotency-Key` and `X-Event-Id` both equal to the body
  `eventId` (the same value across the retry), and both bodies
  byte-identical to the signed body; the captured
  `X-Hub-Signature-256` is pinned equal to the build-time
  signature and verified over the captured body once outside the
  timed loop, pinning both headers outside signature coverage.
  This run measured ~1,466 ops/sec (681.92 µs/op) for the new row
  on Node v24.22.1 / AMD EPYC 9D25. The Benchmarks table is
  refreshed from this run (65 rows). Honest limit: the row is
  local-HTTP-bound, not a measure of delivery logic overhead.
- A jitter backoff segment in the CLI demo (backlog #652):
  `deliverPayoutWebhook` with `jitterMs` over a loopback
  receiver with a recording sleep — one signed webhook
  delivered three times, once per path-scripted script
  (backoffMs 100, maxAttempts 3): the jittered
  500 / 500 / 200 script whose two waits must land
  inside [100, 1100] and [200, 1200] (intervals only,
  never the random draw), the jitterMs 0 control over
  the same script sleeping exactly [100, 200], and the
  429 `Retry-After: 30` script under jitterMs 1000
  waiting exactly [30000] — the receiver's prescribed
  time with no jitter added. The demo's golden output
  and the X-Event-Id segment tests are updated for the
  new closing section.
- A benchmark path for payout webhook jitter backoff (backlog #634):
  `deliverPayoutWebhook` with `jitterMs` over a 500 / 500 / 200
  script (backoffMs 100, maxAttempts 3, injected recording sleep) —
  one timed pass is two deliveries, the jittered script whose two
  sleeps must land inside [100, 1100] and [200, 1200] and the
  zero-jitter control sleeping exactly [100, 200]; the exact
  jittered sleeps [100, 700] under a stubbed `Math.random`
  sequence [0, 0.5] are pinned once outside the timed loop, and
  the stub's restore is asserted. This run measured ~3,720
  ops/sec (268.81 µs/op) for the new row on Node v24.22.1 /
  AMD EPYC 9D25. The Benchmarks table is refreshed from this run
  (64 rows).
- A benchmark path for payout webhook fan-out limits (backlog #628):
  `deliverPayoutWebhookToMany` under `maxEndpoints` /
  `overallDeadlineMs` — the timed loop runs the 50 ms deadline case
  (3 endpoints, two answering 200 at once and one hanging until its
  abort signal fires), self-checking the two kept
  `{ ok: true, attempts: 1, status: 200 }` results, the
  deadline-stopped `{ ok: false, attempts: 1 }` result carrying the
  deadline timeout error, delivered 2 / failed 1 with
  `deadlineExceeded: true`, and exactly 3 fetch calls; the over-cap
  case (3 endpoints under `maxEndpoints: 2`) is pinned once outside
  the timed loop to the exact configuration error with zero fetch
  calls. The new row's throughput is deadline-bound by the pinned
  50 ms wait, not a measure of fan-out overhead. The Benchmarks
  table is refreshed from this run.
- A benchmark self-check for `expireOverdueTasks` audit entries
  (backlog #626, the dataquest mirror of the escrow #625 check):
  `checkExpireResults` now also requires every successful
  outcome's `entry` to equal that task's history last entry on
  seq/event/from/to/at, and requires the failed WD-06 outcome
  (IN_REVIEW, no `EXPIRE` edge) to carry no entry. The
  Benchmarks table is not refreshed for this change: the added
  assertions do not change the measured rows' inputs.
- A benchmark path for minor-unit conversion (backlog #624):
  `toMinorUnits`/`fromMinorUnits` over a fixed 4-vector corpus —
  the finance-pass total (16349 major units ↔ 1634900 minor
  units), zero, a negative amount, and the 0.33 round-trip —
  plus the 0.333 nearest-cent rounding vector, with every vector
  self-checked per iteration in both directions and a fractional
  minor input (1634900.5) pinned once outside the timed loop to
  its exact `minor units must be an integer` fail-fast error.
  This run measured ~11,609,098 ops/sec (0.09 µs/op) for the new
  row on Node v24.22.1 / AMD EPYC 9D25. The Benchmarks table is
  refreshed from this run (62 rows).
- A minor-unit conversion branch in the CLI demo (backlog #623):
  after the `formatMinorUnits` display branch, the demo turns the
  finance-pass total 16349 major units into 1634900 integer cents
  with `toMinorUnits` and back with `fromMinorUnits`, cross-checked
  against `totalPaidOut` itself (not a second hard-coded copy),
  and shows a fractional minor unit (1634900.5) rejected fail-fast
  with `minor units must be an integer, got 1634900.5`. `DemoResult`
  gains `minorUnitsConversion` (`{ major, minor, roundTrip }`) and
  `minorUnitsFractionalError`, and the demo's printed line count
  grows from 568 to 573.
- An audit-entry citation block in the CLI demo's SLA watchdog
  batch execution branch (backlog #616): after the per-task
  result lines, the demo prints each successful
  `expireOverdueTasks` result's `entry` — `entry seq 3 EXPIRE
  ACCEPTED -> EXPIRED at <wall-clock>`, `entry seq 2 EXPIRE OPEN
  -> EXPIRED at <wall-clock>` — with a `no entry — failed
  dispatch appends nothing` line for any failed dispatch, so a
  reader sees the audit record without re-reading
  `task.history`. A fail-fast self-check requires every
  successful entry to equal the task history's last entry
  (seq/event/from/to/at/actor) and every failed outcome to
  carry no entry, and `DemoResult` gains
  `expireExecutionEntryRefs` (one `{ taskId, entry }` per
  expired task, in batch order). Honest limit carried over
  from the segment's own comment: the printed `at` is the
  executor's wall-clock dispatch timestamp — the fixed
  screening now only selects, it does not stamp — so the
  demo tests pin seq/event/from/to/actor and normalize the
  printed `at`, never asserting a wall-clock value; the
  demo's printed line count grows from 565 to 568.
- A benchmark path for minor-unit display formatting (backlog
  #614): `formatMinorUnits` over the fixed 12-vector demo
  corpus — the eleven demo vectors (positive, zero, negative,
  -0 rendering without a minus sign, large, and
  `MAX_SAFE_INTEGER` exact through integer arithmetic) plus
  the finance-pass total (1634900 minor units rendering
  "16349.00") — with every vector self-checked per iteration
  against the demo's pinned strings and a fractional input
  pinned once outside the timed loop to its exact
  `minor units must be an integer` fail-fast error. This run
  measured ~393,323 ops/sec (2.54 µs/op) for the new row on
  Node v24.22.1 / AMD EPYC 9D25. The Benchmarks table is
  refreshed from this run (61 rows).
- A fan-out limits segment in the CLI demo (backlog
  #607): the two call-level guards of
  `deliverPayoutWebhookToMany` that the earlier fan-out
  segments never exercised — 3 endpoints under a
  `maxEndpoints` cap of 2 throw the pinned `3 endpoints
  exceed maxEndpoints 2` configuration error before any
  request, with zero fetch calls; and under an
  `overallDeadlineMs` budget of 50, two endpoints
  answering 200 at once keep their results while the
  hanging endpoint reports the deadline timeout error
  with `deadlineExceeded: true`. Any drift from the
  hand-written expectations fails the demo fast
  (non-zero exit), and the demo's printed line count
  grows from 560 to 565.
- A benchmark path for actor-filter listing (backlog
  #604): `tasksByActor` over a fixed 6-task mixed-actor batch
  — the timed loop filters for "moderator" and self-checks
  the hand-pinned slice [BENCH-ACTOR-01, BENCH-ACTOR-02,
  BENCH-ACTOR-04] in input order holding the same task
  objects (the twice-touched task matches exactly once, the
  anonymous task and the no-history task match nothing),
  with the contributor contrast [BENCH-ACTOR-02,
  BENCH-ACTOR-05] and the empty-actor fail-fast pinned once
  outside the timed loop, mirroring the #589 demo semantics.
  This run measured ~103,611 ops/sec (9.65 µs/op) for the
  new row on Node v24.22.1 / AMD EPYC 9D25. The Benchmarks
  table is refreshed from this run (60 rows).
- An X-Event-Id header segment in the CLI demo (backlog
  #601): one more PAID task (DEMO-055) whose signed payout
  webhook is delivered twice to a real loopback receiver — the
  first delivery and the redelivery of the same webhook object —
  with both captured requests carrying `X-Event-Id` equal to the
  pinned payload `eventId` (`evt_demo_x_event_id_001`) and the
  same requests also carrying `Idempotency-Key` equal to that
  same eventId, teaching that `deliverPayoutWebhook` sends both
  headers on every delivery (one logical event, two header names)
  and that the headers are unsigned transport hints beside the
  verified body's `eventId`, which is the authoritative dedup key.
  The loopback port is ephemeral and never printed, so the
  segment's output is byte-identical across runs. Any drift from
  the hand-written expectations fails the demo fast (non-zero
  exit).
- A benchmark path for state-filter listing (backlog
  #598): `tasksByState` over the fixed 12-task watchdog batch
  — the timed loop filters for OPEN and self-checks the
  hand-pinned slice [WD-01, WD-02, WD-08, WD-12] in input
  order holding the same task objects (the #562
  order-preservation / same-object semantics), with the
  terminal-PAID contrast [WD-03] and the unknown-state
  fail-fast pinned once outside the timed loop. The
  Benchmarks table is refreshed from this run (59 rows).
- An Idempotency-Key header segment in the CLI demo (backlog
  #595): one more PAID task (DEMO-054) whose signed payout
  webhook is delivered twice to a real loopback receiver — the
  first delivery and the redelivery of the same webhook object —
  with both captured requests carrying `Idempotency-Key` equal
  to the pinned payload `eventId`
  (`evt_demo_idempotency_key_001`), teaching that
  `deliverPayoutWebhook` has no separate idempotency-key option
  (the eventId IS the key) and that the header is an unsigned
  transport hint beside the verified body's `eventId`, which is
  the authoritative dedup key. The loopback port is ephemeral
  and never printed, so the segment's output is byte-identical
  across runs. Any drift from the hand-written expectations
  fails the demo fast (non-zero exit).
- A benchmark path for SLA approaching-deadline screening (backlog
  #592): `tasksApproachingDeadline` over a fixed 6-task batch under
  one injected fixed `now` with a 24-hour window — in-window,
  upper-bound-inclusive, lower-bound-exclusive, overdue,
  no-deadline, and terminal-PAID cases — self-checked on every
  iteration for the hand-pinned [AP-01, AP-02] selection, with the
  overdue contrast [AP-03, AP-04] pinned once outside the timed
  loop. The Benchmarks table is refreshed from this run (58 rows).
- An actor-filter branch in the CLI demo (backlog #589): four
  more tasks (DEMO-050–DEMO-053) under fixed-literal timestamps
  showing `tasksByActor()` beside `tasksByState()` on the same
  batch — the moderator slice (DEMO-050, DEMO-051, DEMO-053)
  and the contributor slice (DEMO-051) against the OPEN slice
  (DEMO-050, DEMO-052) — so the demo teaches that the actor
  slice and the state slice are orthogonal: a twice-touched task
  matches once, and an anonymous task matches no actor. Any
  drift from the hand-written expectations fails the demo fast
  (non-zero exit).
- A minor-unit display branch in the CLI demo (backlog #586):
  eleven fixed `formatMinorUnits` vectors (positive, zero, negative,
  large, up to MAX_SAFE_INTEGER) plus the finance-pass total itself —
  1634900 minor units rendered "16349.00" — so the demo shows the
  pinned statement format for settlement amounts instead of leaving
  the display convention to the caller's imagination. Any drift from
  the hand-written expectations fails the demo fast (non-zero exit).
- An `X-Event-Id` header on payout webhook delivery (backlog
  #583): every `deliverPayoutWebhook` attempt — and every endpoint
  in a `deliverPayoutWebhookToMany` fan-out — carries
  `X-Event-Id: <payload eventId>` alongside the existing
  `Idempotency-Key` header (retries reuse the same value; fan-out
  endpoints share the one logical event's id, so they carry the same
  value). The header is the event-dedup counterpart to the
  idempotency header: a gateway that keys only on `X-Event-Id` can
  deduplicate without parsing the body, including when body parsing
  fails. Like `Idempotency-Key` it is a transport-layer hint only —
  it is not covered by the signature, so receivers must verify the
  signature over the raw body and deduplicate on the verified
  body's `eventId`, never on the header alone.
- An approaching-deadline screening branch in the CLI demo (backlog
  #580): four more tasks (DEMO-046–DEMO-049) under the stale
  branch's fixed screening `now` with a 24-hour warning window —
  one deadline 12 hours out, one exactly 24 hours out, one exactly
  at `now`, one a day past — showing the half-open window
  `(now, now + 24h]` semantics beside both screens' subsets:
  `tasksApproachingDeadline()` selects only the first two (the
  upper bound is inclusive) while `expiredTasks()` selects only
  the last two (the lower bound is exclusive, so a deadline
  exactly at `now` is already overdue). The segment fails fast
  (non-zero demo exit) if either subset drifts from the
  hand-written expectation, and both screens are pure.
- A fixed-format minor-unit display helper (backlog #577):
  `formatMinorUnits(minorUnits)` renders integer cents as a bare
  two-decimal string (`10098` → `"100.98"`, `0` → `"0.00"`,
  `-100` → `"-1.00"`), with no thousands separator and no currency
  symbol, so statement and reconciliation text no longer drifts per
  caller. A non-integer input throws the same error as
  `fromMinorUnits`, and the whole/cents split is integer arithmetic,
  so large amounts format exactly.
- An audit entry on stale-patrol outcomes (backlog #571):
  `StaleActionResult` gains an optional `entry` field — a frozen,
  detached copy of the audit entry the action appended — present only
  when the action ran successfully and grew the task's history (the
  default ABANDON dispatch does; a notify-only custom action does not).
  Failed actions omit the field, keeping the failure shape backward
  compatible. This mirrors the `ExpireOverdueResult.entry` added for
  `expireOverdueTasks` (backlog #544), so a stale-patrol report can
  cite the entry without re-reading `task.history`.
- An `Idempotency-Key` header on payout webhook delivery (backlog
  #568): every `deliverPayoutWebhook` attempt — and every endpoint in
  a `deliverPayoutWebhookToMany` fan-out — carries
  `Idempotency-Key: <payload eventId>` (retries reuse the same value;
  fan-out endpoints share the one logical event's id, so they carry
  the same value). The header is a transport-layer idempotency hint
  only: it is not covered by the signature, so receivers must verify
  the signature over the raw body and deduplicate on the verified
  body's `eventId`, never on the header alone.
- An SLA warning-window filter (backlog #565):
  `tasksApproachingDeadline(tasks, withinMs, now)` returns the
  non-terminal tasks whose current-state SLA deadline falls inside the
  half-open window `(now, now + withinMs]`. It is the "warn before it
  is too late" counterpart to `expiredTasks`: a task already past its
  deadline is never reported here (so no task is reported twice), a
  deadline exactly on `now + withinMs` counts as within, and tasks with
  no deadline for their current state or in a terminal state are never
  selected. The call is pure (no mutation or dispatch) and an invalid
  `withinMs` fails fast with an explicit error.
- A generic batch filter (backlog #562): `tasksByState(tasks, state)`
  returns the tasks currently in the given state, in input order.
  It is the generic counterpart to the watchdog screens (`expiredTasks`
  for past-deadline tasks, `staleTasks` for stuck tasks): terminal
  states filter exactly like any other state, the result holds the same
  task objects (not copies), the call is pure (no mutation or dispatch),
  and an unknown state fails fast with an explicit error instead of
  silently returning an empty list.
- Fan-out limits on payout webhook delivery (backlog #559):
  `DeliverPayoutWebhookToManyOptions.maxEndpoints` (a positive
  integer; exceeding it throws a caller configuration error before
  any request is made) and `overallDeadlineMs` (a positive number of
  milliseconds; when the budget expires, every still-in-flight
  endpoint is aborted through a deadline signal composed with that
  endpoint's own signal, so a per-endpoint signal override cannot
  bypass the deadline). Deadline-stopped endpoints report the
  deadline timeout error, already-completed endpoints keep their
  results, and the aggregate result gains `deadlineExceeded: true`
  (false otherwise, including calls with no deadline). Invalid values
  for either option throw before any request. The deadline aborts via
  the fetch signal, so a fetch implementation that ignores its signal
  cannot be force-stopped by it, exactly as with an external abort.
- Opt-in retry jitter on payout webhook delivery (backlog #547):
  `DeliverPayoutWebhookOptions.jitterMs` (default `0` — the delay
  schedule stays exactly the deterministic exponential backoff).
  When greater than `0`, each backoff wait becomes
  `backoffMs * 2^(n-1) + Math.random() * jitterMs`, spreading retries
  that failed together (a thundering herd after the receiver restarts)
  across the `[backoff, backoff + jitterMs]` window. `Math.random` is
  documented as de-synchronization only, never cryptographic; a 429
  `Retry-After` hint is the receiver's own prescribed time and is
  always waited exactly, with no jitter added. Invalid values
  (negative, `NaN`, infinite, non-number) throw a caller configuration
  error before any request is made. `deliverPayoutWebhookToMany`
  forwards the option call-level and accepts a per-endpoint
  `jitterMs` override.
- An auditable watchdog report on `expireOverdueTasks()` (backlog #544):
  `ExpireOverdueResult` gains an optional `entry?: TaskHistoryEntry` —
  on a successful EXPIRE dispatch the outcome now carries a frozen,
  detached copy of the appended EXPIRE audit entry (event, from, to, seq,
  at), so an SLA operations report can cite it per task without
  re-reading `task.history`. Failed dispatches omit the field entirely,
  leaving the `{ task, expired: false, error }` failure shape unchanged
  and backward compatible.
- A history getter defensive-copy benchmark path (backlog #539):
  `npm run bench` now also times one `get history()` call per
  iteration on a fixed task (BENCH-HG) with a pinned 64-entry
  hash-chained history (PUBLISH / ACCEPT / START_CAPTURE / SUBMIT /
  BEGIN_REVIEW / REJECT, then 14 RESUBMIT rounds of RESUBMIT / SUBMIT /
  BEGIN_REVIEW / REJECT, then a final RESUBMIT / SUBMIT, ending in
  SUBMITTED) — the O(n) copy + per-entry Object.freeze tax the
  audit-immutability guarantee costs on every read, previously
  invisible inside the subscribe / replay / snapshot rows, which
  never isolated the getter itself. Per-iteration self-checks pin
  exactly 64 entries, the frozen array and frozen entries, content
  byte-identical to the fixture baseline, and consecutive calls never
  sharing entry references; one-off push / splice / entry-field-write
  probes are pinned to throw (and to leave the internal history
  untouched) outside the timed loop, and a mutation check pins that a
  broken expected entry count exits the bench with code 1. The README
  Benchmarks table is refreshed to this run's real numbers, with the
  honest note that immutability is not free.
- A history getter immutability segment in `npm run demo` (backlog #537):
  the demo now shows the audit trail cannot be rewritten at runtime —
  on a task (DEMO-045) driven PUBLISH -> ACCEPT under fixed timestamps,
  a push of a forged entry, a splice, and an entry.note rewrite on the
  returned snapshot all throw TypeError while the internal history stays
  at exactly 2 unchanged entries; two getter calls return deep-equal but
  reference-independent snapshots; and a later START_CAPTURE dispatch
  leaves the earlier snapshot at 2 entries while the live history grows
  to 3 — the frozen detached copy, with dispatch() the only append path
  (the historyFreeze tests' assertions, shown instead of only asserted).
  The segment is pinned by two new demo tests (structure + print-line
  determinism) plus a mutation check (the getter temporarily returning
  the internal reference turns the new segment test red, restored green),
  and the demo golden output gains seven lines (481 → 488).
- A constructor id fail-fast segment in `npm run demo` (backlog #534):
  the demo now shows the first door of the audit chain — constructing
  `TaskLifecycle` with `""`, `undefined`, or `123` is rejected with the
  pinned `invalid task: id must be a non-empty string` error (the same
  wording `test/constructorId.test.ts` pins), and a legal id (`DEMO-044`)
  then constructs and dispatches `PUBLISH` normally. The segment is
  pinned by two new demo tests (structure + print-line determinism),
  and the demo golden output gains six lines (475 → 481).
- A dispatch explicit-timestamp benchmark path:
  `npm run bench` now also times
  `dispatch("START_CAPTURE", { at })` with a pinned
  canonical ISO-8601 timestamp — one timestamped dispatch
  on a fresh task driven under fixed timestamps to a pinned
  2-entry ACCEPTED history. The injected `at` lands verbatim
  in the history entry, replacing the wall-clock read the
  plain dispatch rows take; this core audit-determinism path
  previously had only unit-test coverage
  (`test/dispatchAt.test.ts`) and no benchmark number. Every
  timed iteration rebuilds the fresh task, dispatches the
  timestamped START_CAPTURE, and self-checks the CAPTURING
  return, the exactly-3-entry history, and the last entry's
  pinned step fields (seq 3, `START_CAPTURE`, `at`
  byte-identical to the injected BASE + 2s value, actor
  "reviewer"). Outside the timed loop, a non-canonical `at`
  is pinned to the exact
  `invalid dispatch options: at must be canonical ISO-8601, got not-a-date`
  error with byte-identical state and history, cross-checking
  the fail-fast rule the dispatchAt unit tests pin. The README
  Benchmarks table is refreshed from a single real run with
  the new row added (~47,114 ops/sec / 21.23 µs/op on this
  machine — machine-local, not a guarantee).

- A policy snapshot round-trip benchmark path:
  `npm run bench` now also times
  `toJSON` → JSON text → `TaskLifecycle.fromJSON`
  over a fixed 10-entry REJECTED snapshot that carries a
  pinned `rolePolicy` (`DISPUTE`/`RESUBMIT` →
  `["contributor"]`) and finite budgets (`maxResubmits` 1
  with 1 of 1 used, `maxDisputes` 2 with 0 used) —
  the persistence combination the plain snapshot row
  never timed (its fixture deliberately carries no policy
  and unlimited budgets). Every timed iteration exports
  the envelope to JSON text and rehydrates it through the
  strict reader, self-checking the restored state and the
  full history entry for entry (hashes included), the
  history-derived used counts, the envelope's
  byte-identical policy and budget fields, and the
  re-export fixed point. Outside the timed loop, an
  unauthorized actor on the policy-covered `DISPUTE` is
  pinned to the exact authorization wording and an
  authorized `RESUBMIT` to the exact budget-exhaustion
  wording — the budget is history-derived, so
  persistence does not reset it — each leaving state and
  history byte-identical. The README Benchmarks table is
  refreshed from a single real run with the new row added.

- A `listenerCount` lifecycle segment in the CLI demo: `npm run demo`
  now acts out the subscription registry's observable surface on a
  dedicated task (DEMO-043) — listenerCount pinned at 0 with no
  subscriptions, 2 after two collectors subscribe, 1 after one
  unsubscribes, 0 after the survivor unsubscribes, and still 0 after a
  second call of the same unsubscribe (idempotent). Between the two
  unsubscribes, one fixed-timestamp PUBLISH proves the surviving
  listener still receives its notification while the departed
  collector stays silent. The demo's `DemoResult` carries the new
  task, the pinned timeline, and both collectors' notifications; the
  demo test suite pins the timeline, the notifications, and the
  segment's printed lines verbatim, and the golden demo output and
  README test count are refreshed to match.

- A dispatch `maxResubmits` retry-budget benchmark
  path: `npm run bench` now also times
  `dispatch("RESUBMIT")` on a fresh task constructed
  with `maxResubmits: 2` and driven through
  `PUBLISH` → `ACCEPT` → `START_CAPTURE` → `SUBMIT` →
  `BEGIN_REVIEW` → `REJECT` to a pinned 6-entry
  REJECTED history under fixed timestamps — the
  history-derived retry cap every resubmit cycle pays
  (transition check first, then the budget gates the
  RESUBMIT before any history is appended),
  previously invisible inside the plain dispatch row,
  whose tasks carry no budget, and inside the snapshot
  row, where `maxResubmits` appears only as a fixture
  field. Every timed iteration rebuilds a fresh
  budgeted task (the RESUBMIT dispatch spends one
  budget unit and advances the task to CAPTURING, so
  the rebuild cost is inside the timed region) and
  checks the return is CAPTURING, the history grew by
  exactly one entry to 7, and the last entry is the
  pinned step (seq 7, `RESUBMIT`, REJECTED →
  CAPTURING, at BASE + 6s, actor "contributor").
  Outside the timed loop, a third RESUBMIT after two
  full resubmit rounds is pinned to throw exactly
  `resubmit budget exhausted: 2 of 2 RESUBMITs already
  used` and to leave state and history byte-identical
  (compared through the canonical NDJSON serializer),
  a budget of 0 is pinned to make the first RESUBMIT
  throw at once, a task built without the option is
  pinned to run repeated resubmit rounds (the
  pre-budget default), and illegal budgets (-1 and 1.5)
  are pinned to throw their exact `invalid option`
  errors at construction, with an illegal snapshot
  budget pinned to its exact `invalid snapshot` error.
  The README Benchmarks table is refreshed from one
  real run (the new path measured 11,258 ops/sec on
  2026-10-23). No network and no randomness. Bench
  only; no library behavior change.

- A dispatch `rolePolicy` authorization benchmark
  path: `npm run bench` now also times
  `dispatch("ACCEPT")` on a fresh task constructed
  with `rolePolicy: { ACCEPT: ["reviewer"] }` and
  driven through `PUBLISH` to a pinned 1-entry OPEN
  history under fixed timestamps — the event-level
  RBAC check every dispatch into a policy-covered
  event pays (transition check first, then the
  allowlist gates the actor before any history is
  appended), previously invisible inside the plain
  dispatch row, whose tasks carry no policy, and
  inside the snapshot row, where `rolePolicy`
  appears only as a fixture field. Every timed
  iteration rebuilds a fresh policy-carrying task
  (the ACCEPT dispatch advances it, so the rebuild
  cost is inside the timed region) and checks the
  return is ACCEPTED, the history grew by exactly
  one entry to 2, and the last entry is the pinned
  step (seq 2, `ACCEPT`, at BASE + 1s, actor
  "reviewer"). Outside the timed loop, an
  unauthorized actor ("viewer") is pinned to throw
  exactly
  `actor not authorized for ACCEPT: "viewer" is not in [reviewer]`
  and to leave state and history byte-identical
  (compared through the canonical NDJSON
  serializer), a missing actor is pinned to throw
  exactly
  `actor not authorized for ACCEPT: policy requires an actor in [reviewer]`
  the same untouched way, and a task built without
  a policy is pinned to advance the same actorless
  ACCEPT with no authorization check (the
  pre-RBAC default). The README Benchmarks table is
  refreshed from one real run (the new path measured
  66,701 ops/sec on 2026-10-23). No network and no
  randomness. Bench only; no library behavior change.

- A stale patrol CLI demo segment: `npm run demo` now
  closes with five further tasks screened by
  `staleTasks()` alone at the stale branches' fixed
  `now` under a patrol budget map — the
  `maxAgeByState` parameter itself (DRAFT / OPEN /
  PAID at 7 days each, IN_REVIEW deliberately
  absent), which the earlier stale branches only
  ever passed under local names. Exactly one task
  is stale (an OPEN task at 21 days of dwell); the
  other four are each excluded for a different
  pinned reason — exactly at the budget (7 days,
  not strictly past), terminal (PAID, despite
  carrying a patrol budget), no history (a fresh
  DRAFT task has no measurable dwell) and unmapped
  state (IN_REVIEW carries no budget) — with a
  notify-only disposition through `actOnStaleTasks()`
  that records the notified id and dispatches
  nothing, and a fail-fast check pinning the exact
  `invalid maxAgeByState: unknown state "BOGUS"`
  configuration error. The demo tests gain two
  cases for the segment (in-process verdicts with
  independent reproduction, and byte-identical
  determinism), for 582 tests in total.
- A dispatch `expectedSeq` optimistic-concurrency
  CLI demo segment: `npm run demo` now closes with
  five dedicated tasks under fixed timestamps acting
  out the `dispatch(event, { expectedSeq })` guard —
  a task driven to a pinned 2-entry ACCEPTED history
  advances exactly one step under `START_CAPTURE`
  with `expectedSeq: 2`, its last entry hand-pinned
  (seq 3, START_CAPTURE, ACCEPTED -> CAPTURING, the
  pinned instant and actor); a second task at the
  same history rejects the same dispatch with a
  stale `expectedSeq: 1` with exactly
  `dispatch conflict: expected seq 1 but task is at seq 2`,
  its state and history byte-identical afterwards
  through the canonical NDJSON serializer; a fresh
  task advances under `expectedSeq: 0`, the guard
  for an empty history; `-1` and `1.5` throw exactly
  their pinned
  `invalid dispatch options: expectedSeq must be a non-negative integer, got …`
  configuration errors and append nothing; and a
  task dispatched with no `expectedSeq` at all
  advances exactly as before the guard existed.
  Honest limit: the guard is a single-process
  optimistic lock against the in-memory history —
  cross-process writers still need compare-and-swap
  in the durable store itself. The demo tests gain
  two cases for the segment (in-process verdicts
  with independent reproduction, and byte-identical
  determinism), for 580 tests in total. No network
  and no randomness. Demo only; no library behavior
  change.

- A payout webhook `timeoutMs` timeout benchmark
  path: `npm run bench` now also times
  `deliverPayoutWebhook` delivering the fixed signed
  webhook to the single-target endpoint through an
  injected hanging fake fetch with `timeoutMs` pinned
  at 10 and `maxAttempts: 1` — the per-attempt deadline
  every delivery to a slow or hung receiver pays,
  previously invisible inside the plain single-target
  row, whose fake fetch answers 200 immediately and
  never reaches the timer at all. The fake never
  answers on its own and only settles when the
  per-attempt abort fires, so the pinned short timeout
  is the only thing that can end the attempt. Every
  timed iteration checks the reported result is
  exactly
  `{ ok: false, attempts: 1, error: "webhook delivery timed out after 10ms" }`
  with no status, after exactly one fetch call — the
  timeout is reported, never thrown, per this module's
  convention. Outside the timed loop, an illegal
  `timeoutMs` of 0 is pinned to throw exactly
  `cannot deliver payout webhook: timeoutMs must be a positive number, got 0`
  before any request (zero fetch calls), and a
  generous `timeoutMs` of 5000 over an
  immediately-200 fake is pinned to the unchanged
  normal delivery
  `{ ok: true, attempts: 1, status: 200 }` after
  exactly one fetch call. Honest limit: the timeout
  wait itself is the object under test, at its pinned
  short length of 10 ms, and no elapsed duration is
  asserted anywhere. The README Benchmarks table is
  refreshed from one real run (the new path measured
  88.8 ops/sec on 2026-10-22). No network and no
  randomness. Bench only; no library behavior change.

- A payout webhook fan-out per-endpoint timeout
  override CLI demo segment: `npm run demo` now
  closes with the main task's payout event fanned
  out by `deliverPayoutWebhookToMany` to three fixed
  endpoints (one shared fixed `now` / `eventId`, each
  endpoint signed with its own secret, all delivery
  through injected fetches) in three pinned forms —
  under a loose call-level `timeoutMs: 5000`, the
  slow endpoint's per-endpoint override of 50 (with
  its own hanging injected fetch) cuts every attempt
  off at 50 ms and its result is exactly
  `{ ok: false, attempts: 3, error: "webhook delivery timed out after 50ms" }`
  after 3 fetch calls, while the endpoints without an
  override still succeed and the results stay in
  input order; an invalid per-endpoint override of
  0 lands as exactly
  `{ ok: false, attempts: 0, error: "cannot deliver payout webhook: timeoutMs must be a positive number, got 0" }`
  for that endpoint alone, with zero fetch calls to
  it; and a fan-out with no override anywhere
  delivers all three endpoints unchanged. The 50 ms
  waits are the behaviour under test itself, at
  their pinned short length — no elapsed wall-clock
  duration is asserted. The demo tests gain two
  cases for the segment (in-process verdicts with
  independent reproduction, and byte-identical
  determinism), for 578 tests in total. No real
  network and no randomness. Demo only; no library
  behavior change.

- A dispatch `maxDisputes` dispute-budget benchmark
  path: `npm run bench` now also times
  `dispatch("DISPUTE")` on a fresh task constructed
  with the pinned budget `maxDisputes: 1` and driven
  under fixed timestamps to a pinned 6-entry history
  (PUBLISH, ACCEPT, START_CAPTURE, SUBMIT,
  BEGIN_REVIEW, REJECT) in REJECTED — the appeal-round
  cap every moderation deployment pays on a contested
  rejection, previously invisible inside the plain
  dispatch row, whose tasks carry no budget, and
  inside the snapshot row, where `maxDisputes` appears
  only as a fixture field, never as a timed
  constructor option. Every timed iteration rebuilds
  the fresh task (the DISPUTE dispatch spends the
  single budget unit and mutates it, so the rebuild
  cost is inside the timed region) and checks the
  DISPUTED return, the exactly-7-entry history, and
  the last entry's pinned fields (seq 7, `DISPUTE`,
  at BASE + 6s, the pinned actor). Outside the timed
  loop, a second DISPUTE after one full appeal round
  is pinned to throw exactly
  `dispute budget exhausted: 1 of 1 DISPUTEs already used`
  and leave state and history byte-identical (compared
  through the canonical NDJSON serializer), a budget
  of 0 is pinned to make the first DISPUTE throw
  `dispute budget exhausted: 0 of 0 DISPUTEs already used`
  at once, a task built without the option is pinned
  to run repeated appeal rounds (the pre-budget
  default), a snapshot round-trip is pinned to keep
  the budget exhausted (the used count is
  history-derived, so it does not reset), and illegal
  budgets (-1 and 1.5) are pinned to throw their exact
  configuration errors
  (`invalid option: maxDisputes must be a non-negative integer or Infinity, got -1`
  and the same with `got 1.5`), with an illegal
  snapshot budget pinned to
  `invalid snapshot: maxDisputes must be a non-negative integer or Infinity, got -1`.
  The README Benchmarks table is refreshed from one
  real run (the new path measured 20,692 ops/sec on
  2026-10-22). No network, no randomness, and no wall
  clock. Bench only; no library behavior change.

- A dispatch `expectedSeq` optimistic-concurrency
  benchmark path: `npm run bench` now also times
  `dispatch("START_CAPTURE", { expectedSeq: 2 })` on a
  fresh task driven under fixed timestamps to a pinned
  2-entry history (PUBLISH, ACCEPT) in ACCEPTED — the
  stale-snapshot guard every concurrent writer pays
  before any other dispatch check, previously invisible
  inside the plain dispatch row, whose dispatches never
  carry the guard. Every timed iteration rebuilds the
  fresh task (the guarded dispatch mutates it, so the
  rebuild cost is inside the timed region) and checks
  the CAPTURING return, the exactly-3-entry history,
  and the last entry's pinned fields (seq 3,
  `START_CAPTURE`, at BASE + 2s, the pinned actor).
  Outside the timed loop, a stale `expectedSeq: 1` is
  pinned to throw exactly
  `dispatch conflict: expected seq 1 but task is at seq 2`
  and leave state and history byte-identical (compared
  through the canonical NDJSON serializer),
  `expectedSeq: 0` on an empty history is pinned to
  advance, illegal values (-1 and 1.5) are pinned to
  throw their exact configuration errors
  (`invalid dispatch options: expectedSeq must be a non-negative integer, got -1`
  and the same with `got 1.5`), and dispatch without
  `expectedSeq` is pinned to behave unchanged. The
  README Benchmarks table is refreshed from one real
  run (the new path measured 25,988 ops/sec on
  2026-10-22). No network, no randomness, and no wall
  clock. Bench only; no library behavior change.

- A payout webhook `timeoutMs` CLI demo segment:
  `npm run demo` now closes with the main task's
  signed webhook delivered by `deliverPayoutWebhook`
  under a pinned per-attempt `timeoutMs` in three
  forms. A hanging injected fetch — one that only
  settles when its abort signal fires — under
  `timeoutMs: 50` and `maxAttempts: 1` is cut off by
  the per-attempt `AbortController`, and the timeout
  is reported, never thrown, as exactly
  `{ ok: false, attempts: 1, error: "webhook delivery timed out after 50ms" }`
  after exactly one fetch call. A `timeoutMs` of 0
  throws the pinned configuration error
  (`cannot deliver payout webhook: timeoutMs must be a positive number, got 0`)
  before any request, with zero fetch calls. The
  same endpoint under a loose `timeoutMs: 5000`
  answers 200 at once and reports the unchanged
  success shape
  (`{ ok: true, attempts: 1, status: 200 }`). The
  50 ms wait is the behaviour under test itself, at
  its pinned short length — no elapsed wall-clock
  duration is asserted. The demo tests gain two
  cases for the segment (in-process verdicts with
  independent reproduction, and byte-identical
  determinism), for 576 tests in total. No real
  network and no randomness. Demo only; no library
  behavior change.

- A preseeded idempotency keys CLI demo segment:
  `npm run demo` now closes with a dedicated task
  (DEMO-031) constructed with a pinned
  `idempotencyKeys` seed
  (`["demo-seed-publish", "demo-seed-publish",
  "demo-seed-accept"]`) and driven under fixed
  timestamps, plus a seed-free task (DEMO-032). The
  duplicate seed entry is deduped (first occurrence
  wins), so the opening snapshot carries exactly
  `["demo-seed-publish", "demo-seed-accept"]` — the
  re-attachment path for `fromHistory()`, whose
  audit log cannot carry the key set. An ACCEPT
  dispatched from DRAFT under the seeded key
  `demo-seed-accept` — an event with no edge from
  DRAFT — returns DRAFT as a complete no-op: the
  transition is not validated, nothing is appended,
  and no listener is notified. The same ACCEPT
  event under the fresh key `demo-fresh-accept`
  (after a fresh-key PUBLISH) advances to ACCEPTED
  and consumes its key, so the closing snapshot
  lists the seed keys followed by the two fresh
  keys. A construction attempt with an empty-string
  seed is rejected with the pinned error
  (`invalid option: idempotencyKeys entries must be
  non-empty strings, got ""`), and the seed-free
  task dispatches keylessly with no snapshot key
  field, pinning the unchanged pre-seeding default.
  The demo tests gain two cases for the segment
  (in-process verdicts with independent
  reproduction, and byte-identical determinism),
  for 574 tests in total. No network, no
  randomness, and no wall clock. Demo only; no
  library behavior change.

- A payout webhook `maxFutureSkewMs` future-skew
  benchmark path: `npm run bench` now also times
  `verifyPayoutWebhook` over the fixed signed webhook
  with `{ maxFutureSkewMs: 300000, now }` and the
  receiver `now` injected 60 seconds before signing —
  the future side of the two-sided freshness window
  every freshness-checking receiver pays after the
  signature matches (a legitimately-signed payload
  dated further in the future than the window fails
  closed even though a `maxAgeMs`-only check would
  pass it — a negative age always passes — and its
  signature alone would verify forever, so without
  this bound a far-future timestamp gains a
  near-unbounded replay window), previously
  invisible inside the plain verify row and the
  `maxAgeMs` row, whose options never bound the
  future direction at all. Its per-iteration
  self-check pins the verdict to exactly `true` (a
  future skew of 60,000 ms inside the 5-minute
  window); outside the timed loop, a payload 1 ms
  beyond the window is pinned to return `false`, a
  payload skewed exactly `maxFutureSkewMs` is pinned
  to still verify (the boundary is inclusive — only
  `at - now > maxFutureSkewMs` fails), the two-sided
  window formed with `maxAgeMs` is pinned on all
  three sides (inside both bounds verifies, beyond
  the future bound returns `false`, beyond the age
  bound returns `false`), and an illegal
  `maxFutureSkewMs` of -1 is pinned to throw the
  exact configuration error
  (`cannot verify payout webhook: maxFutureSkewMs must be a finite non-negative number, got -1`).
  The README Benchmarks table is refreshed from one
  real run and gains the new row
  (`verifyPayoutWebhook maxFutureSkewMs future-skew window` at
  ~51,430 ops/sec on that run).
  No network, no randomness, and no wall clock —
  the signing time and every receiver `now` are
  injected fixed instants. Benchmark only; no
  library behavior change.

- A payout webhook `maxAgeMs` freshness-window
  benchmark path: `npm run bench` now also times
  `verifyPayoutWebhook` over the fixed signed webhook
  with `{ maxAgeMs: 300000, now }` and the receiver
  `now` injected 60 seconds after signing — the
  opt-in replay bound every freshness-checking
  receiver pays after the signature matches (a
  legitimately-signed payload older than the window
  fails closed even though its signature alone would
  verify forever), previously invisible inside the
  plain verify row, whose options never carry a
  freshness window at all. Its per-iteration
  self-check pins the verdict to exactly `true` (an
  age of 60,000 ms inside the 5-minute window);
  outside the timed loop, a payload aged 1 ms past
  the window is pinned to return `false`, a payload
  aged exactly `maxAgeMs` is pinned to still verify
  (the boundary is inclusive — only
  `now - at > maxAgeMs` fails), and an illegal
  `maxAgeMs` of -1 is pinned to throw the exact
  configuration error
  (`cannot verify payout webhook: maxAgeMs must be a finite non-negative number, got -1`).
  The README Benchmarks table is refreshed from one
  real run and gains the new row
  (`verifyPayoutWebhook maxAgeMs freshness window` at
  ~100,078 ops/sec on that run).
  No network, no randomness, and no wall clock —
  the signing time and every receiver `now` are
  injected fixed instants. Benchmark only; no
  library behavior change.

- A payout webhook `AbortSignal` pre-abort benchmark
  path: `npm run bench` now also times
  `deliverPayoutWebhook` delivering the fixed signed
  webhook through an injected counting fake fetch
  with an external `signal` aborted before the call —
  the deterministic cancellation guard every
  externally-signalled delivery pays before it starts
  (a pre-aborted signal makes zero fetch calls and
  the abort is reported, never thrown), previously
  invisible inside the single-target delivery row,
  whose script never carries a signal at all. Its
  per-iteration self-check pins the reported result
  to exactly
  `{ ok: false, attempts: 0, error: "payout webhook delivery aborted" }`
  with no status, and the counting fetch to exactly
  zero calls; outside the timed loop, a
  non-`AbortSignal` signal value is pinned to throw
  the exact configuration error
  (`cannot deliver payout webhook: signal must be an AbortSignal, got bench-not-a-signal`)
  before any request, and a signal that never aborts
  is pinned to leave the normal delivery unchanged
  (`{ ok: true, attempts: 1, status: 200 }` after
  exactly one fetch call). The README Benchmarks
  table is refreshed from one real run and gains
  the new row
  (`deliverPayoutWebhook AbortSignal pre-abort` at
  ~1,249,972 ops/sec on that run).
  No network, no randomness, no real sleep, and no
  wall clock. Benchmark only; no library behavior
  change.

- An event-level RBAC CLI demo segment:
  `npm run demo` now closes with a dedicated task
  (DEMO-029) constructed with a pinned `rolePolicy`
  (PUBLISH: [researcher], ACCEPT: [contributor],
  ARBITRATE_APPROVE / ARBITRATE_REJECT:
  [senior-moderator]) and driven under fixed
  timestamps. PUBLISH by contributor and an
  actor-less PUBLISH are both rejected with the
  pinned `actor not authorized for …` errors,
  leaving DRAFT with zero history entries; the
  allowlisted researcher publishes and the
  allowlisted contributor accepts; the uncovered
  events run with no actor at all to DISPUTED;
  arbitration by contributor and actor-less
  arbitration are likewise rejected with no trace,
  and the senior moderator then arbitrates to
  APPROVED. A second task (DEMO-030) built without
  any policy is driven to DISPUTED and arbitrated
  actor-less, pinning the unchanged pre-policy
  default. The segment prints the honest limit
  itself: an allowlist is an authorization check
  on the actor name, not identity authentication.
  The demo tests gain two cases for the segment
  (in-process verdicts with independent
  reproduction, and byte-identical determinism),
  for 572 tests in total. No network, no
  randomness, and no wall clock. Demo only; no
  library behavior change.

- A dispatch payout-reference enforcement benchmark
  path: `npm run bench` now also times
  `dispatch("PAYOUT_COMPLETE", { payoutRef })` on a
  fresh task constructed with
  `{ requirePayoutRef: true }` and driven through the
  pinned lifecycle steps to PAYOUT_PENDING under fixed
  timestamps — the settlement-reconciliation guard
  every enforced payout pays (a `PAYOUT_COMPLETE`
  without a non-empty `payoutRef` is rejected at
  dispatch time, before any audit entry is written),
  previously invisible inside the plain dispatch row,
  whose tasks never enable the option. Because the
  dispatch settles its task, every iteration rebuilds
  a fresh enforced task and the reported numbers
  include that rebuild cost. Its per-iteration
  self-check pins the dispatch return to PAID, the
  history to exactly 8 entries, and the last entry to
  the pinned settlement fields (seq 8,
  `PAYOUT_COMPLETE`, at the pinned timestamp, carrying
  the pinned payoutRef verbatim); outside the timed
  loop, a ref-less dispatch on an enforced task is
  pinned to throw the exact pinned
  `payout reference required: …` error and leave state
  and history untouched, and a default task (option
  unset) is pinned to still settle without a
  reference. The README Benchmarks table is refreshed
  from one real run and gains the new row
  (`dispatch requirePayoutRef (with payoutRef)` at
  ~13,903 ops/sec on that run).
  No network, no randomness, and no wall clock.
  Benchmark only; no library behavior change.

- A payout webhook `maxRetryDelayMs` Retry-After cap
  benchmark path: `npm run bench` now also times
  `deliverPayoutWebhook` delivering the fixed signed
  webhook through an injected fake fetch that answers
  429 with a pinned `Retry-After: 30` hint (30000 ms)
  on the first attempt and 200 on the second, with
  `backoffMs` 100, an injected recording sleep, and
  `maxRetryDelayMs` 5000 — the runaway-hint guard
  (`Math.min(hinted, maxRetryDelayMs)`) every hinted
  retry pays, previously invisible inside the
  single-target row, whose 200-immediately script
  never retries at all. Its per-iteration self-check
  pins the result to `{ ok: true, attempts: 2,
  status: 200 }`, exactly two captured calls with
  byte-identical signed bodies, and the recording
  sleep receiving exactly the clamped 5000 ms;
  outside the timed loop, a 429 without a hint is
  pinned to fall back to the 100 ms exponential-
  backoff base, a below-cap hint (`Retry-After: 2`)
  is pinned to be honored exactly at 2000 ms, and a
  500 carrying a `Retry-After` header is pinned to be
  ignored as a hint (only 429 hints are read). The
  README Benchmarks table is refreshed from one real
  run and gains the new row
  (`deliverPayoutWebhook maxRetryDelayMs cap` at
  ~27,444 ops/sec on that run). No network, no
  randomness, and no real waiting. Benchmark only;
  no library behavior change.

- A keyed audit hash-chain CLI demo segment:
  `npm run demo` now closes with a dedicated task
  (DEMO-028) constructed with a pinned `auditSecret`
  and driven PUBLISH -> SUBMIT under fixed timestamps,
  so every audit link is HMAC-SHA256 keyed by that
  secret instead of plain SHA-256. The segment prints
  and asserts the four fail-closed verdicts of
  `verifyHistoryChain(history, { auditSecret })`:
  the correct secret verifies the 4-entry history,
  a wrong secret returns `false`, a detached tampered
  copy (the middle START_CAPTURE entry gaining a
  `payoutAmount` of 999) returns `false` under the
  correct secret while the original history still
  verifies afterwards, and the same keyed history
  verified with no secret at all returns `false`.
  The secrets themselves are never printed. The demo
  tests gain two cases for the segment (in-process
  verdicts with independent reproduction, and
  byte-identical determinism), for 570 tests in
  total. No network, no randomness, and no wall
  clock. Demo only; no library behavior change.

- A payout webhook secret-rotation verification
  benchmark path: `npm run bench` now also times
  `verifyPayoutWebhook` with the rotation candidate
  set `{ secrets: [new, old] }` over the fixed webhook
  fixture (signed with the old secret at the fixed
  timestamp / `eventId`, so the matching candidate is
  the second one tried) — the steady-state receiver
  cost inside a rotation window, which pays one failed
  HMAC trial before the match and was previously
  invisible inside the single-secret verify row. Its
  per-iteration self-check pins the verdict to
  exactly `true`; outside the timed loop, a candidate
  pair in which neither secret matches is pinned to
  return `false` (all-mismatch fails closed, no
  throw), and an empty `secrets` array is pinned to
  throw the exact configuration error. The README
  Benchmarks table is refreshed from one real run and
  gains the new row (`verifyPayoutWebhook (secrets
  rotation, 2 candidates)` at ~55,723 ops/sec on that
  run). No network, no randomness, and no wall clock.
  Benchmark only; no library behavior change.

- A dispatch idempotency dedupe benchmark path:
  `npm run bench` now also times `dispatch` with a
  pinned `idempotencyKey` over a fresh task per
  iteration — one keyed `PUBLISH` that appends exactly
  one entry and consumes the key, plus the same event
  under the same key again, which returns the current
  state and appends nothing — the retry-safety cost
  previously invisible inside the plain dispatch row,
  which never carries a key. Its per-iteration
  self-check pins both returns, the exactly-one-entry
  history with a gap-free seq, the consumed-key
  snapshot holding exactly the pinned key, and exactly
  one listener notification; outside the timed loop,
  the same key under a different event is pinned to
  dedupe, a stale retry after the task moved on is
  pinned to answer with the current state, a failed
  dispatch is pinned to consume no key (the corrected
  retry under the same key executes), and two keyless
  dispatches are pinned to append two entries. The
  README Benchmarks table is refreshed from one real
  run and gains the new row (`dispatch idempotency
  dedupe (keyed dispatch + duplicate)` at ~59,303
  ops/sec on that run). No network, no randomness, and
  no wall clock. Benchmark only; no library behavior
  change.

- A keyed hash-chain verification benchmark path:
  `npm run bench` now also times
  `verifyHistoryChain(history, { auditSecret })` over a
  fixed 8-entry history chained under a pinned audit
  secret (the same lifecycle steps and fixed timestamps
  as the unkeyed fixture, with every link HMAC-SHA256
  instead of plain SHA-256) — the keyed tamper-evidence
  cost previously invisible inside the unkeyed
  `verifyHistoryChain` row. Its per-iteration self-check
  pins the verdict to exactly `true` with the genesis
  and successor links pinned; outside the timed loop, a
  wrong secret is pinned to return `false`, a detached
  tampered copy is pinned to return `false`, and the
  same keyed history verified without a secret is
  pinned to return `false` (fail-closed). The README
  Benchmarks table is refreshed from one real run and
  gains the new row (`verifyHistoryChain auditSecret
  (8 entries, keyed)` at ~14,765 ops/sec on that run).
  No network, no randomness, and no wall clock.
  Benchmark only; no library behavior change.

- A dispatch idempotency key segment closing the CLI
  demo: a dedicated task (DEMO-026) dispatches under
  fixed timestamps with pinned `idempotencyKey`s — its
  `PUBLISH` under `demo-idem-publish` lands OPEN with
  one history entry, and the same event under the same
  key returns OPEN and appends nothing (its listener
  is not notified again); after an `ACCEPT` under a
  second key moves it to ACCEPTED, a `START_CAPTURE`
  under the old publish key (a different, would-be
  legal event) and the stale `PUBLISH` under that same
  old key both return ACCEPTED without throwing, and
  the listener ends with exactly `[PUBLISH, ACCEPT]`.
  A second dedicated task (DEMO-027) first fails an
  `ACCEPT` from DRAFT under `demo-idem-retry` with the
  pinned error `invalid transition: ACCEPT from DRAFT`,
  which consumes no key, so the corrected `PUBLISH`
  under the same key succeeds, and a final keyless
  `ACCEPT` appends normally. All forms are asserted
  outside the printed lines against hand-written
  expectations. Fixed timestamps only: no network, no
  randomness. Demo and tests only; no library behavior
  change.

- A payout reference enforcement segment closing the
  CLI demo: a dedicated task constructed with
  `requirePayoutRef: true` (DEMO-024) is driven to
  PAYOUT_PENDING under fixed timestamps and its
  `PAYOUT_COMPLETE` without a `payoutRef` is rejected
  with the pinned error
  `payout reference required: PAYOUT_COMPLETE must carry a non-empty payoutRef when requirePayoutRef is enabled`,
  leaving its state at PAYOUT_PENDING and its history
  at 7 entries; the same dispatch with the pinned
  `payoutRef` `xfer-demo-require-ref` then settles it
  to PAID and the history's last entry (seq 8) carries
  that reference verbatim. A second dedicated task
  under the default (DEMO-025, the option unset) still
  settles without a reference. All three forms are
  asserted outside the printed lines against
  hand-written expectations. Fixed timestamps only: no
  network, no randomness. Demo and tests only; no
  library behavior change.

- A payout webhook freshness window segment closing
  the CLI demo: one fixed notification is built from
  the main task at a pinned signing time
  (`2026-03-28T09:00:00.000Z`, eventId
  `evt_demo_freshness`) and the same body and signature
  are verified with `verifyPayoutWebhook` under
  injected receiver clocks. Inside the `maxAgeMs`
  window (3600000 ms, receiver 30 minutes after
  signing) it verifies; exactly at the window boundary
  it still verifies — the boundary is inclusive, only
  `now - at > maxAgeMs` fails; two hours after signing
  it fails closed even though the signature alone still
  verifies; and with the receiver two hours behind the
  payload, a `maxFutureSkewMs` of 3600000 ms also fails
  it closed. All four verdicts are asserted outside the
  printed lines against hand-written expectations.
  Fixed timestamp, injected clocks only: no network,
  no randomness. Demo and tests only; no library
  behavior change.

- A payout webhook AbortSignal segment closing the
  CLI demo: the main task's signed webhook is delivered
  with `deliverPayoutWebhook` under an external
  `AbortSignal` in two pinned forms. A signal aborted
  before the call makes zero fetch calls and is
  reported — never thrown — as
  `{ ok: false, attempts: 0, error: "payout webhook delivery aborted" }`;
  a signal aborted inside the backoff sleep after a
  first 500 answer (the abort fired from inside the
  injected hanging sleep itself, the deterministic
  trigger that proves the wait was entered) cuts the
  pending 30000 ms wait short, starts no second
  attempt, and reports
  `{ ok: false, attempts: 1, status: 500, error: "payout webhook delivery aborted" }`.
  Both forms are asserted outside the printed lines
  against hand-written expectations. Fake fetches and
  a hanging fake sleep only: no network, no real wait,
  no wall-clock trigger. Demo and tests only; no
  library behavior change.

- A payout webhook secret rotation segment closing
  the CLI demo: two fixed notifications are built from
  the main task under a fixed signing time — one signed
  with a new secret, one with the old — and both verify
  under `verifyPayoutWebhook`'s rotation shape
  `{ secrets: [new, old] }`, so an in-flight old-signed
  notification still passes inside the window and a
  new-signed one passes as soon as the new secret is
  listed. The segment also shows the window's edges
  failing closed — the new-signed notification under
  the old secret alone, and both under an unrelated
  secret list — and the pinned configuration error
  thrown when the positional secret and `secrets` are
  passed together, all asserted outside the printed
  lines against hand-written expectations. Fixed
  secrets, fixed timestamp, no network, no randomness.
  Demo and tests only; no library behavior change.

- A payout event dedupe checkAndRecord miss/evict
  benchmark path: `npm run bench` now also times
  `PayoutEventDedupe.checkAndRecord()` in its
  first-sighting direction on a fresh dedupe rebuilt on
  every iteration (a capacity of 100 under an injected
  fixed clock, recording a deterministic sequence of 250
  brand-new ids on every pass, so every call is a miss
  and the 150 records beyond capacity force LRU
  evictions of the oldest surviving ids) — the cost a
  receiver pays for every genuinely new payout event,
  previously invisible inside the steady-state duplicate
  hit row. Its per-iteration self-check pins the stats
  to the hand-written expectation
  (`{ size: 100, hits: 0, misses: 250, evictions: 150 }`
  — size pinned at capacity); outside the timed loop, a
  probe pins that the oldest surviving id still records
  as a duplicate hit and an already-evicted id records
  as a new event again. The README Benchmarks table is
  refreshed from one real run and gains the new row
  (`PayoutEventDedupe checkAndRecord (miss/evict, 250
  new ids, capacity 100)` at ~1,995 ops/sec on that
  run). No network, no randomness, and no wall clock.
  Benchmark only; no library behavior change.

- A payout webhook 429 Retry-After delivery segment
  closing the CLI demo: the main task's signed webhook is
  delivered with `deliverPayoutWebhook` to one fixed
  endpoint through an injected fake fetch scripted to
  answer 429 with a pinned `Retry-After: 30` header on the
  first attempt and 200 on the retry, with a recording
  fake sleep in place of a real wait. The recorded sleep
  is exactly `[5000]` — the parsed hint (30 s = 30000 ms)
  clamped to the segment's `maxRetryDelayMs` (5000),
  never the exponential backoff (`backoffMs` 100) — and
  the demo asserts outside the printed lines that the
  delivery reports `{ ok: true, attempts: 2, status: 200 }`,
  both wire calls carry the byte-identical signed body,
  and the captured wire body verifies under the demo
  secret. The demo tests pin the segment against
  hand-written expectations, including an independent
  in-test 429 delivery. Demo and tests only; no library
  behavior change.

- A payout event dedupe stats benchmark path:
  `npm run bench` now also times
  `PayoutEventDedupe.stats()` on a fixed dedupe (7 ids
  recorded under an injectable clock that advances only
  while the fixture is built, with a 60-second TTL and a
  capacity of 6 — one id LRU-evicted during construction,
  one id expired at the stats instant but still sitting in
  the map, and 5 live ids) — the observability snapshot a
  receiver's monitoring polls on every tick, previously
  read only as an incidental fixture self-check inside the
  other dedupe paths. Its per-iteration self-check pins
  the snapshot to the hand-written expectation
  (`{ size: 5, hits: 1, misses: 7, evictions: 1 }` — size
  counts only the live ids, so the expired id still
  sitting in the map is excluded); outside the timed loop, a
  mutated detached snapshot is pinned to leave a re-read
  unchanged and an empty dedupe is pinned to report
  all-zero stats. The README Benchmarks table is
  refreshed from one real run and gains the new row
  (`PayoutEventDedupe.stats (5 live entries, 1 expired)`
  at ~2,814,391 ops/sec on that run). No network, no
  randomness, and no wall clock. Benchmark only; no
  library behavior change.

- A payout event dedupe clear benchmark path:
  `npm run bench` now also times
  `PayoutEventDedupe.clear()` on a fresh dedupe rebuilt
  on every iteration (1,000 fixed ids recorded under an
  injected fixed clock, plus one duplicate hit on the
  first id, so the stats about to be zeroed read
  `{ size: 1000, hits: 1, misses: 1000, evictions: 0 }`) —
  the window-reset path a receiver pays on key rotation,
  for test isolation, or for a deliberate dedupe-window
  reset, previously measured only on the demo side. Its
  per-iteration self-check pins the size and every
  counter at zero right after the clear and pins that
  the first id records as a new event again; outside the
  timed loop, clearing an empty dedupe is pinned as a
  harmless no-op. Because `clear()` mutates the store,
  the reported numbers include the fixture-rebuild cost
  (prefill plus clear). The README Benchmarks table is
  refreshed from one real run and gains the new row
  (`PayoutEventDedupe.clear (1,000 recorded ids, fresh
  fixture)` at ~6,963 ops/sec on that run). No network,
  no randomness, and no wall clock. Benchmark only; no
  library behavior change.

- A payout dedupe clear reset segment closing the CLI
  demo: a fresh `PayoutEventDedupe` under an injected
  fixed clock records one fixed payout `eventId` (new on
  first sight, a duplicate on immediate redelivery, stats
  pinned at `{ size: 1, hits: 1, misses: 1, evictions: 0 }`),
  then `clear()` drops every recorded id and resets the
  counters — size and stats print back at all zero — and
  the same `eventId` is recorded again as a new event,
  with the counters re-accumulating from zero
  (`{ size: 1, hits: 0, misses: 1, evictions: 0 }`): the
  explicit reset a receiver uses on key rotation, for
  test isolation, or to reset a dedupe window, instead of
  waiting for TTL expiry. The demo tests pin the segment
  against hand-written expectations, including an
  independent in-test clear script. Demo and tests only;
  no library behavior change.

- A payout event dedupe snapshot export benchmark path:
  `npm run bench` now also times
  `PayoutEventDedupe.exportSnapshot()` on a fixed dedupe
  (6 ids recorded under an injectable clock that advances
  only while the fixture is built, with a 60-second TTL —
  the first id recorded exactly one TTL before the export
  instant, so it is expired at export time, and 5 later ids
  with staggered first-seen times all still live) — the
  export direction a receiver pays before every restart,
  previously visible only as an incidental fixture
  construction for the restore row. Its per-iteration
  self-check pins the snapshot to the hand-written
  expectations (`v` is 1, exactly the 5 live entries in
  recorded order, the first and last entries pinned in
  full, the expired id absent); outside the timed loop, a
  mutated detached copy is pinned to leave a re-export
  unchanged, and an empty dedupe is pinned to export
  `{ v: 1, entries: [] }`. The README Benchmarks table is
  refreshed from one real run and gains the new row
  (`PayoutEventDedupe.exportSnapshot (5 live entries, 1
  expired)` at ~637,912 ops/sec on that run, against
  ~1,847 ops/sec for one 1,000-entry restore pass). No
  network, no randomness, and no wall clock after fixture
  construction. Benchmark only; no library behavior
  change.

- A payout dedupe stats observability segment closing
  the CLI demo: a fresh `PayoutEventDedupe` under an
  injected fixed clock with a small `maxEntries` (3)
  runs a pinned script (a new `eventId`, its immediate
  redelivery, two more new ids that fill the store, and
  a fourth new id that evicts the least recently seen
  one), printing `stats()` — `{ size, hits, misses,
  evictions }` — after every step; a returned stats
  object is then mutated (hits set to 999) and the store
  still reads `{ size: 3, hits: 1, misses: 4, evictions:
  1 }`, showing the snapshot is a detached copy, not a
  live view. The demo tests pin the segment against
  hand-written expectations, including an independent
  in-test counter script and detached-copy check. Demo
  and tests only; no library behavior change.

- A payout dedupe snapshot persistence segment closing
  the CLI demo: a fresh `PayoutEventDedupe` under an
  injected fixed clock records two fixed payout
  `eventId`s (each new on first sight, a duplicate on
  immediate redelivery), exports them with
  `exportSnapshot()` (only the snapshot version and
  entry count are printed, never the full entries),
  round-trips the snapshot through JSON text, and
  restores it with `PayoutEventDedupe.restore()` — the
  restored store's observability counters start at
  zero, yet both ids still read as duplicates and an
  unseen id reads as new — and a detached copy of the
  snapshot with its version rewritten to 2 is rejected
  with the exact invalid-snapshot error
  (`PayoutEventDedupe: invalid snapshot: unsupported
  snapshot version 2 (expected 1)`). The demo tests pin
  the segment against hand-written expectations,
  including an independent in-test round-trip and
  version rejection. Demo and tests only; no library
  behavior change.

- A subscribe `onError` error routing benchmark path:
  `npm run bench` now also times `subscribe` with one
  fixed throwing listener and a collecting `onError`
  hook over the full `DRAFT -> PAID` lifecycle on a
  fresh task per iteration — the failure-visibility
  side of the collecting-listener subscribe row,
  previously unmeasured (the bench's subscribe paths
  never routed a listener error). Its per-iteration
  self-check pins that every dispatch succeeded, the
  history count and the routed report count both equal
  the dispatch count (8), every report carries the
  pinned listener message, and the first report's
  context is the hand-pinned PUBLISH DRAFT -> OPEN;
  outside the timed loop, a probe pins that a throwing
  `onError` hook is swallowed too and the non-function
  `onError` rejection is pinned to its exact message
  (`invalid subscribe: onError must be a function, got
  string`, registering nothing). The README Benchmarks
  table is refreshed from one real run and gains the
  new row (`subscribe onError (full lifecycle, 1
  throwing listener)` at ~925.4 ops/sec on that run,
  against ~6,392 ops/sec for the collecting-listener
  subscribe pass). No network, no randomness, and no
  wall clock. Benchmark only; no library behavior
  change.

- A subscribe `onError` error routing segment closing
  the CLI demo: a dedicated task (DEMO-022) carries a
  listener that throws `Error("demo listener failure")`
  on every notification, subscribed with a collecting
  `onError` hook; a short fixed-timestamp chain
  (PUBLISH / ACCEPT / START_CAPTURE) is dispatched and
  the demo prints the routed count (3) and the first
  report's dispatch context (PUBLISH DRAFT -> OPEN),
  asserting outside the printed lines that all
  dispatches returned normally, the audit history is
  complete, every routed context matches the
  hand-pinned chain, and — on a probe task (DEMO-023)
  — that a throwing `onError` hook is swallowed too.
  The demo tests pin the segment against hand-written
  expectations, including independent in-test routing
  and probe tasks. Demo and tests only; no library
  behavior change.

- A single-target payout webhook delivery benchmark path:
  `npm run bench` now also times `deliverPayoutWebhook`
  delivering the bench's signed webhook to one fixed
  endpoint through an injected fake `fetchImpl` that
  answers 200 immediately, with `backoffMs` 0 and an
  injected no-op `sleepImpl` — the steady-state cost of
  one signed POST, previously visible only inside the
  4-endpoint fan-out row's numbers. Its per-iteration
  self-check pins the reported result (`{ ok: true,
  attempts: 1, status: 200 }`), exactly one captured
  call to the pinned URL, and a captured body
  byte-identical to the signed body whose
  `X-Hub-Signature-256` equals the `buildPayoutWebhook`
  product's signature and verifies over the captured
  body; outside the timed loop, a persistent-500 script
  is pinned to the reported (never thrown)
  retry-exhaustion shape (`{ ok: false, attempts: 3,
  status: 500, error: "server responded with status
  500" }` after exactly 3 calls under the default
  `maxAttempts`). The README Benchmarks table is
  refreshed from one real run and gains the new row
  (`deliverPayoutWebhook (single endpoint)` at ~53,958
  ops/sec on that run, against ~3,913 ops/sec for one
  4-endpoint fan-out pass). No network, no randomness,
  and no real waiting. Benchmark only; no library
  behavior change.

- A single-target payout webhook delivery segment closing
  the CLI demo: the main task's signed webhook is delivered
  with `deliverPayoutWebhook` to one fixed endpoint
  (`https://payouts.example.com/hooks/payout`) through an
  injected fake fetch scripted to answer 500 then 200, with
  `backoffMs` 0 and a no-op `sleepImpl` (no network, no real
  waiting). The demo prints the delivery result (`ok`,
  2 attempts, status 200) — noting that a 429 `Retry-After`
  hint would have set the retry's delay, clamped to
  `maxRetryDelayMs`, while the 500 fell back to exponential
  backoff — and asserts outside the printed lines that the
  result matches the hand-pinned contract, that both
  captured wire calls carry the byte-identical signed body
  and the webhook's own signature, and that the captured
  wire body verifies under the demo secret with
  `verifyPayoutWebhook`; the demo tests pin the segment
  against hand-written expectations, including an
  independent in-test redelivery of the same webhook.
  Demo and tests only; no library behavior change.

- A transition-table pure object construction benchmark
  path: `npm run bench` now also times `transitionTable()`
  with no arguments — the plain-object edge list in
  declaration order, without any serialization, that the
  JSON export and the diagram both derive from — whose
  cost was previously invisible inside the JSON row's
  construction-plus-serialization total. Its
  per-iteration self-check pins the output to the
  hand-written expectations in the bench comments (all
  19 edges written out in full in declaration order —
  the list pinned by the committed snapshot — with
  every edge's keys in from / event / to order,
  spot-checked against the `transitionTableJson` edge
  set through the shared pinned first edge, payout edge
  (index 14), and last edge); outside the timed loop,
  the full edge set is compared to the parsed JSON edge
  set edge for edge and a hand-pinned non-existent edge
  (`DRAFT` / `PAYOUT_COMPLETE` / `PAID`) is confirmed
  absent from both. The README Benchmarks table is
  refreshed from one real run and gains the new row
  (`transitionTable (19 edges)` at ~91,351 ops/sec on
  that run, against ~11,489 ops/sec for the JSON row —
  the serialization share of the export is now
  separable from the pure construction cost). No
  network, no randomness, and no wall clock. Benchmark
  only; no library behavior change.

- A single-step transition dispatch benchmark path:
  `npm run bench` now also times `benchTransition` —
  restoring a fixed OPEN snapshot (one `PUBLISH` entry
  at the fixed base instant) and dispatching exactly
  one legal step (`ACCEPT` with the quoted amount 125,
  pinned at `BASE + 1s`) on every iteration — the
  steady-state cost of a single dispatch (restore plus
  one hash-chained audit append), previously visible
  only inside the full-lifecycle aggregate. Its
  per-iteration self-check pins the hand-written
  expectations in the bench comments (the state
  advances exactly one step, OPEN to ACCEPTED; the
  history grows by exactly one entry; the appended
  entry's `seq` continues the snapshot's `seq` with no
  gap — cross-checked against the transition table);
  outside the timed loop, an exhaustive
  pure-`transition()` check pins all 13 states x 15
  events (the 19 legal edges return their hand-pinned
  targets, every other pair throws exactly
  `invalid transition: <event> from <state>`), and the
  illegal `PAYOUT_COMPLETE` dispatch from OPEN is
  pinned to be rejected with that same message,
  leaving the restored task untouched. The README
  Benchmarks table is refreshed from one real run and
  gains the new row (`benchTransition (single step,
  snapshot restore)` at ~26,157 ops/sec on that run).
  No network, no randomness, and no wall clock: every
  dispatch timestamp is fixed. Benchmark only; no
  library behavior change.

- An SLA deadline write benchmark path:
  `npm run bench` now also times
  `setSlaDeadline` / `clearSlaDeadline` as one
  write–overwrite–clear cycle on a shared fixed OPEN
  task (set the current state's deadline from a `Date`
  at `2026-05-01T09:00:00.000Z`, overwrite it from an
  ISO string at `2026-06-01T09:00:00.000Z`, then clear
  it — the clear restores the fixture's initial
  no-deadline state, so the same task serves every
  iteration) — the write side of the existing
  `getSlaDeadline` read path, whose cost was
  previously invisible inside the watchdog totals.
  Its per-iteration self-check pins every read-back
  to the hand-written expectations in the bench
  comments (the set and overwritten deadlines read
  back exactly, the cleared state reads back
  `undefined`, and the task stays in OPEN with its
  single PUBLISH entry throughout — the writes are
  configuration, never a dispatch; cross-checked
  against the SLA tests); outside the timed loop,
  exhaustive checks on separate probe tasks pin the
  per-state and clear-all forms, the normalized-ISO
  storage of a non-ISO parseable input, the setter's
  one rejection (an unparseable deadline, rejected
  with exactly `invalid SLA deadline: not-a-date`,
  leaving the stored value untouched), and that
  setting a deadline on a terminal (ABANDONED) task
  is stored rather than rejected — the setter has
  no state guard. The README Benchmarks table is
  refreshed from one real run and gains the new row
  (`setSlaDeadline + clearSlaDeadline (OPEN task
  write cycle)` at ~194,121 ops/sec on that run).
  No network, no randomness, and no wall clock:
  every dispatch timestamp and every deadline is
  fixed. Benchmark only; no library behavior change.
- A dispatch note length guard benchmark path:
  `npm run bench` now also times the `MAX_NOTE_LENGTH`
  boundary in `dispatch()` over a fixed 2-case corpus
  (a note of exactly 32768 characters accepted on a
  fresh task, and a note of 32769 characters rejected)
  — the audit-history anti-inflation guard every
  dispatch pays, whose cost was previously invisible
  inside the dispatch totals. Its per-iteration
  self-check pins both cases to the hand-written
  expectations in the bench comments (the at-limit
  dispatch lands in OPEN with exactly 1 history entry
  whose stored note length is 32768; the over-limit
  dispatch is rejected with exactly `invalid dispatch
  options: note must be at most 32768 characters, got
  32769`, leaving the fresh task in DRAFT with 0
  history entries; cross-checked against the
  actor/note hardening tests); the notes are
  presented only by length and are never printed.
  The README Benchmarks table is refreshed from one
  real run and gains the new row
  (`MAX_NOTE_LENGTH note guard (2-case corpus)` at
  ~6,908 ops/sec on that run). No network, no
  randomness, and no wall clock: every dispatch
  timestamp is fixed. Benchmark only; no library
  behavior change.
- An SLA deadline clearing segment closing the CLI
  demo: a dedicated task (DEMO-021) sits in ACCEPTED
  carrying fixed SLA deadlines for three states —
  ACCEPTED at `2026-03-25T09:00:00.000Z`, CAPTURING at
  `2026-03-26T09:00:00.000Z`, and SUBMITTED at
  `2026-03-27T09:00:00.000Z` — and is overdue at the
  fixed screening instant `2026-03-25T10:00:00.000Z`.
  `clearSlaDeadline("ACCEPTED")` clears only the current
  state's deadline: its read-back is `undefined` and the
  `isOverdue` verdict at the same instant turns `false`,
  while the CAPTURING and SUBMITTED deadlines read back
  untouched; `clearSlaDeadline()` with no argument then
  clears every remaining deadline (all three states read
  back `undefined`). Clearing is configuration, not a
  dispatch — the task stays in ACCEPTED with its 2
  history entries throughout. The segment itself asserts
  all of this outside the printed lines against the
  hand-pinned deadlines and verdicts (cross-checked
  against the `clearSlaDeadline` source and the SLA
  tests). `runDemo()` returns the dedicated task, the
  hand-pinned deadlines, and the before / after verdicts
  and read-backs; the demo tests pin them against
  hand-written expectations cross-checked against an
  independent in-test task, the exact printed lines in
  the golden output, and the segment's printed-line
  determinism across two runs. No network, no
  randomness, and no wall clock (fixed timestamps
  throughout). Demo and tests only; no library behavior
  change.
- An SLA deadline-read benchmark path: `npm run bench`
  now also times `getSlaDeadline(state)` over all 13
  states on one fixed ACCEPTED task carrying a deadline
  for exactly two states (OPEN at
  `2026-02-01T09:00:00.000Z` and ACCEPTED at
  `2026-03-01T09:00:00.000Z`) — the read a watchdog pays
  on every poll tick before it may judge overdue, whose
  cost was previously invisible inside the watchdog /
  `isOverdue` totals. Its per-iteration self-check pins
  every returned value to the hand-written expectations
  in the bench comments (the two set states return their
  fixed ISO deadlines, the other eleven states return
  `undefined`, and the no-argument form returns the
  current ACCEPTED state's deadline; cross-checked
  against the SLA tests); outside the timed loop, an
  exhaustive check on a separate probe task pins that
  overwriting a deadline reads back the new value and
  leaves the timed fixture untouched. The README
  Benchmarks table is refreshed from one real run and
  gains the new row (`getSlaDeadline (13 states, 2 set)`
  at ~681,379 ops/sec on that run). No network, no
  randomness, and no wall clock: every dispatch
  timestamp and every deadline is fixed. Benchmark
  only; no library behavior change.
- A terminal-state judgement segment closing the CLI
  demo: the standalone `isTerminal(state)` is called over
  all 13 states in transition-table declaration order and
  every verdict is printed with that state's outgoing-edge
  count — only PAID / ABANDONED / EXPIRED are terminal
  (3 of 13, each with 0 outgoing edges; the other ten
  states carry 1–3 outgoing edges, 19 edges in total). The
  segment itself asserts all of this outside the printed
  lines against the hand-pinned verdicts and counts
  (cross-checked against the `TERMINAL` set in the source
  and the `isTerminal` tests) and cross-checks the two
  views against each other: the isTerminal set equals,
  state for state, the set of states with no outgoing edge
  in `transitionTable()`, whose from/to enumeration is
  exactly the 13 listed states; the main task's PAID state
  reads terminal under both the standalone function and
  the instance getter. `runDemo()` returns the per-state
  verdicts, the terminal set, and the no-outgoing-edge
  set; the demo tests pin them against hand-written
  expectations cross-checked against an independent
  in-test recomputation, the exact printed lines in the
  golden output, and the segment's printed-line
  determinism across two runs. No network, no randomness,
  and no wall clock (the segment reads only the transition
  table). Demo and tests only; no library behavior change.
- Envelope-rejection benchmark self-checks for the JSON
  snapshot round-trip: the `toJSON + fromJSON snapshot
  round-trip (8 entries)` path in `npm run bench` (timed
  since the snapshot bench commit, but previously
  self-checked only on the positive fidelity side — the
  restored state, the full history entry for entry, and
  the re-export fixed point) now also pins, outside the
  timed loop, the strict snapshot reader's rejection
  side: a detached copy whose `v` is rewritten from 1 to
  2 is rejected with exactly `invalid snapshot:
  unsupported snapshot version 2`, and a detached copy
  carrying one extra top-level field is rejected with
  exactly `invalid snapshot: unknown field
  "benchExtraField"`; the intact fixture is pinned to
  restore afterwards, proving both tamper copies were
  detached. No network, no randomness, and no wall-clock
  reads. The README Benchmarks table is not refreshed in
  this change: the timed path set is unchanged (this
  strengthens an existing path's self-check rather than
  adding a path). Benchmark only; no library behavior
  change.
- A standalone overdue judgement segment closing the CLI
  demo: `isOverdue(task, now)` is called on three dedicated
  tasks (DEMO-018 in ACCEPTED with an ACCEPTED-state SLA
  deadline of 2026-03-24T09:00:00.000Z, DEMO-019 in ACCEPTED
  with no deadline, and DEMO-020 in ABANDONED with an
  ABANDONED-state deadline) at fixed instants, and its five
  boundary verdicts are printed — before the deadline
  `false`, exactly at the deadline `true` (the boundary is
  inclusive: `now >= deadline`), after the deadline `true`,
  the no-deadline task `false`, and the terminal task past
  its deadline `false`. The segment itself asserts all of
  this outside the printed lines against the hand-pinned
  verdicts (cross-checked against the `isOverdue` source
  and the SLA tests), and the predicate mutates nothing —
  DEMO-018 is still ACCEPTED when the segment ends.
  `runDemo()` returns the three dedicated tasks, the
  deadline, and the five verdicts in case order; the demo
  tests pin them against hand-written expectations
  cross-checked against an independent in-test task, the
  exact printed lines in the golden output, and the
  segment's printed-line determinism across two runs. No
  network, no randomness, and no wall clock (fixed
  timestamps throughout). Demo and tests only; no library
  behavior change.
- A note length limit segment closing the CLI demo: a
  dedicated task (DEMO-017) is dispatched under a fixed
  timestamp with a note of exactly `MAX_NOTE_LENGTH`
  (32768) characters — the dispatch succeeds, the task
  lands in OPEN with one history entry storing a note of
  that length, and only the length is printed, never the
  note itself — and a following dispatch with a
  32769-character note is rejected with `invalid dispatch
  options: note must be at most 32768 characters, got
  32769`, leaving state and history untouched. The segment
  itself asserts all of this outside the printed lines
  against the hand-pinned limit and error text
  (cross-checked against the dispatch source and the
  actor/note hardening tests). `runDemo()` returns the
  dedicated task, the limit, the boundary and over-limit
  lengths, the rejection error, and the post-rejection
  state and history length; the demo tests pin them
  against hand-written expectations cross-checked against
  an independent in-test dispatch, the exact printed lines
  in the golden output, and the segment's printed-line
  determinism across two runs. No network, no randomness,
  and no wall clock (fixed timestamps throughout). Demo
  and tests only; no library behavior change.
- Full-fidelity benchmark self-checks for hash-chain
  verification: the `verifyHistoryChain (8 entries)` path in
  `npm run bench` (timed since the first bench commit, but
  previously self-checked only on the boolean verdict for
  the intact history) now pins, on every iteration, the
  fixture's genesis link (the first entry's `prevHash`
  equal to `GENESIS_PREV_HASH`) and every successor link
  (each entry's `prevHash` equal to its predecessor's
  `hash`). Outside the timed loop, a detached tampered copy
  (the middle `SUBMIT` entry gaining a `payoutAmount` of
  999 it never carried) is pinned to return false, and the
  intact fixture is pinned to verify afterwards. No
  network, no randomness, and no wall-clock reads. The
  README Benchmarks table is not refreshed in this change:
  the timed path set is unchanged, and repeated real runs
  on this shared host swung too widely this round to
  publish a stable whole-table refresh. Benchmark only;
  no library behavior change.
- A snapshot version envelope segment closing the CLI demo:
  the main task snapshot's `v` field is printed and asserted
  equal to the imported `SNAPSHOT_VERSION` (1), a detached
  copy retagged `v: 2` is passed to
  `TaskLifecycle.fromJSON()` and its rejection is printed
  (`invalid snapshot: unsupported snapshot version 2` — a
  future format is refused, not silently misread), and the
  original snapshot is read back afterwards to show it
  still restores DEMO-001 in PAID. The segment itself
  asserts all three shapes outside the printed lines
  against the hand-pinned version and error text
  (cross-checked against the snapshot-version tests).
  `runDemo()` returns the snapshot version, the
  future-version rejection error, and the restored state;
  the demo tests pin them against hand-written
  expectations cross-checked against an independent
  in-test `fromJSON()` call, the exact printed lines in
  the golden output, and the segment's printed-line
  determinism across two runs. No network, no
  randomness, and no wall clock. Demo and tests only; no
  library behavior change.
- A single-task payout reconciliation detail segment closing
  the CLI demo: `payoutMismatch()` is called on the
  reconciliation branch's two settled tasks one at a time —
  the mismatched task (ACCEPT quote 4000, settled 3750.5)
  prints its full detail `{ quoted: 4000, paid: 3750.5,
  delta: -249.5 }`, and the task that settled exactly as
  quoted (2500 against 2500) prints the no-mismatch form,
  `undefined`. The segment itself asserts both shapes
  outside the printed lines against the hand-pinned amounts
  (delta = paid − quoted, rounded to cents; negative is an
  underpayment). `runDemo()` returns the detail object and
  the settled task's undefined result; the demo tests pin
  them against hand-written expectations cross-checked
  against an independent in-test `payoutMismatch()` call,
  the exact printed lines in the golden output, and the
  segment's printed-line determinism across two runs. No
  network, no randomness, and no wall clock. Demo and
  tests only; no library behavior change.
- Full-fidelity benchmark self-checks for the event-sourced
  rebuild: the `fromHistory (8-entry history)` path in
  `npm run bench` (timed since the first bench commit, but
  previously self-checked only on the rebuilt task's final
  state) now pins, on every iteration, the rebuilt task's
  id and state and its full history against the source
  history entry for entry (hashes included; compared
  field-wise and through the canonical NDJSON serializer,
  because rehydration normalizes history-entry key order).
  Outside the timed loop, a detached tampered copy (the
  `PAYOUT_COMPLETE` entry's `payoutAmount` altered from
  125 to 126) is pinned to be rejected with the hash-chain
  error, and the intact fixture is pinned to rebuild
  afterwards. No network, no randomness, and no
  wall-clock reads. The README Benchmarks table is
  refreshed from one real run. Benchmark only; no library
  behavior change.
- Benchmark coverage for the JSON snapshot round-trip:
  `toJSON()` + `TaskLifecycle.fromJSON()` over the fixed
  full-lifecycle task (8-entry history) now appears in
  `npm run bench` — the persistence path every restart
  pays (plain-JSON envelope export plus strict rehydration
  through the untrusted-snapshot reader). Per-iteration
  self-checks pin the restored state and the full history
  to the hand-written expectations in the bench comments
  (entry for entry, hashes included), the history-derived
  used RESUBMIT / DISPUTE counts (0 on both sides — the
  used counts are derived from the history, never stored),
  and the re-export fixed point at the same serialized
  byte length; outside the timed loop, a JSON text
  round-trip (`JSON.stringify` / `JSON.parse`) is pinned
  to restore identically. No network, no randomness, and
  no wall-clock reads. The README Benchmarks table is
  refreshed from one real run. Benchmark only; no library
  behavior change.
- A JSON snapshot round-trip segment closing the CLI demo:
  the main task is exported with `toJSON()`, serialized with
  `JSON.stringify` (the demo prints the serialized byte
  count — exact on every run, because the only varying
  fields, the main task's wall-clock timestamps and the
  hashes over them, are fixed-length), parsed back, and
  restored with `TaskLifecycle.fromJSON()`. The segment
  itself asserts the hand-pinned expectations outside the
  printed lines: snapshot `v` 1, state `PAID`, 12 history
  entries, the finite `maxResubmits` budget of 2 stored in
  the envelope, the restored state and full history equal
  to the original entry for entry (hashes included), the
  history-derived used RESUBMIT count at 1 of 2 on both
  sides, and an identical re-export at the same serialized
  length (the round-trip is a fixed point; `fromJSON`
  normalizes history-entry key order, values and hashes
  unchanged). `runDemo()` returns the snapshot text,
  its byte length, the restored task, and the used count;
  the demo tests pin them against hand-written expectations
  cross-checked against an independent in-test round-trip,
  the exact printed lines in the golden output, and the
  segment's printed-line determinism across two runs. No
  network, no randomness, and no new wall clock. Demo and
  tests only; no library behavior change.
- Benchmark coverage for dispatch subscription notification:
  `subscribe()` with one fixed collecting listener over the
  full `DRAFT → PAID` lifecycle (8 dispatches) now appears in
  `npm run bench`. The task is rebuilt fresh on every
  iteration because dispatch mutates it, so the number
  includes the fixture-rebuild cost. Per-iteration
  self-checks pin the notification sequence to the
  hand-written expectations in the bench comments (exactly 8
  notifications in dispatch order, each `(event, from, to)`
  triple in place, each carried entry equal to the history
  entry with the same `seq`, field for field, cross-checked
  against the subscribe tests); outside the timed loop, an
  unsubscribe check pins that a further dispatch notifies
  nobody and an isolation check pins that a throwing listener
  neither breaks a dispatch nor starves its peer. No network,
  no randomness, and no wall-clock reads. The README
  Benchmarks table is refreshed from one real run. Benchmark
  only; no library behavior change.
- A README diagram sync check segment closing the CLI demo:
  `readmeDiagramInSync()` — imported directly from
  `src/diagram.ts` (it is not re-exported from the package
  entry, the same import the benchmark uses) — reads this
  repo's README and reports whether it embeds the exact
  `stateDiagram()` block generated in the previous segment,
  and the demo prints that verdict plus the checked file and
  the CLI `--check` equivalent. The segment itself asserts
  the hand-pinned expectation (`true` — the in-sync state
  the test suite pins via the CLI `--check` test and the
  README drift test) outside the printed verdict.
  `runDemo()` returns the verdict; the demo tests pin it
  against hand-written expectations cross-checked against
  the library check itself and the README-embedded copy, the
  exact printed lines in the golden output, and the
  segment's printed-line determinism across two runs. The
  only file read is this repo's `README.md`; no network, no
  randomness, and no wall clock. Demo and tests only; no
  library behavior change.
- Benchmark coverage for SLA overdue judgement:
  `isOverdue(task, now)` over a fixed corpus of 4 tasks now
  appears in `npm run bench`. All four tasks sit in ACCEPTED
  under one injected fixed `now`
  (`2026-10-04T00:00:00.000Z`): one already past its deadline,
  one whose deadline is exactly `now`, one whose deadline is
  still ahead, and one with no SLA deadline at all.
  Per-iteration self-checks pin every returned value to the
  hand-written expectations in the bench comments (`true` /
  `true` / `false` / `false`, cross-checked against the SLA
  tests; the exactly-at case pins the inclusive boundary —
  `now >= deadline`, not `>`), and an exhaustive check runs
  once outside the timed loop. No network, no randomness,
  and no wall-clock reads. The README Benchmarks table is
  refreshed from one real run. Benchmark only; no library
  behavior change.
- A state diagram generation segment closing the CLI demo:
  `stateDiagram()` renders the transition table as the Mermaid
  stateDiagram-v2 block the README embeds verbatim, and the
  demo prints a generation summary — the 24-line total and
  19-edge count plus the first, second, initial, first-edge,
  last-edge, and last lines. The segment itself asserts the
  pinned shape outside the printed summary (first line is the
  mermaid fence, the block carries the `stateDiagram-v2`
  header, and the edge-line count equals the transition
  table's edge count). `runDemo()` returns the full generated
  text and the edge-line count; the demo tests pin the block
  against hand-written expectations cross-checked against
  the library generator and the README-embedded copy, the
  exact printed lines in the golden output, and the segment's
  printed-line determinism across two runs. No network, no
  randomness, and no wall clock. Demo and tests only; no
  library behavior change.
- Benchmark coverage for the README diagram sync check:
  `readmeDiagramInSync()` with no arguments now appears in
  `npm run bench`, imported directly from `src/diagram.ts`
  (it is not re-exported from the package entry). To make
  that import side-effect free, the diagram CLI now runs
  only when executed directly — the same guard
  `src/demo.ts` uses — with no change to the CLI's behavior
  or output. Per-iteration self-checks pin the return value
  to the hand-written expectation in the bench comments
  (exactly `true` — the in-sync state the test suite pins
  via the CLI `--check` test and the README drift test),
  and an exhaustive check runs once outside the timed loop.
  The only file read is this repo's `README.md`; no network
  and no wall-clock reads. The README Benchmarks table is
  refreshed from one real run. Benchmark and diagram CLI
  guard only; no library behavior change.
- A transition-table JSON export segment closing the CLI demo:
  `transitionTableJson()` exports the whole transition table
  as canonical JSON, and the demo prints an export summary —
  the 19-edge total plus the first, payout (index 14), and
  last edges parsed back from the export text, with the
  per-edge `from, event, to` key order confirmed on every
  edge. `runDemo()` returns the raw export text and the
  parsed-back edges; the demo tests pin the structured
  results against hand-written expectations cross-checked
  against the committed transition-table snapshot file, the
  exact printed lines in the golden output, and the segment's
  printed-line determinism across two runs. No network, no
  randomness, and no wall clock. Demo and tests only; no
  library behavior change.
- Benchmark coverage for state diagram generation:
  `stateDiagram()` with no arguments now appears in
  `npm run bench`. Per-iteration self-checks pin the output
  to the hand-written expectations in the bench comments
  (exactly 24 lines — the opening fence, the
  `stateDiagram-v2` / direction / initial lines, the
  19 edges — the count pinned by the committed snapshot —
  and the closing fence — with all 13 states present, the
  first edge DRAFT / PUBLISH / OPEN, the payout edge
  PAYOUT_PENDING / PAYOUT_COMPLETE / PAID present, and the
  last edge DISPUTED / ARBITRATE_REJECT / REJECTED in
  place), and an exhaustive check runs once outside the
  timed loop. No network and no wall-clock reads. The
  README Benchmarks table is refreshed from one real run.
  Benchmark only; no library behavior change.
- Benchmark coverage for transition-table JSON export:
  `transitionTableJson()` with no arguments now appears in
  `npm run bench`. Per-iteration self-checks parse the output
  back and pin it to the hand-written expectations in the bench
  comments (exactly 19 edges — the count pinned by the committed
  snapshot — with the first edge DRAFT / PUBLISH / OPEN, the
  payout edge PAYOUT_PENDING / PAYOUT_COMPLETE / PAID present,
  and the last edge DISPUTED / ARBITRATE_REJECT / REJECTED in
  place, and a trailing newline on the raw text), and an
  exhaustive check runs once outside the timed loop. No network
  and no wall-clock reads. The README Benchmarks table is
  refreshed from one real run. Benchmark only; no library
  behavior change.
- A standalone history parsing segment closing the CLI demo:
  a fixed JSON text carrying the same five-entry
  PUBLISH..BEGIN_REVIEW chain that opens the main task (fixed
  timestamps, hashless legacy form) is parsed with
  `parseHistory()` alone — no `TaskLifecycle` instance
  involved — printed entry by entry, and compared against the
  main task's own history prefix on one line; a detached copy
  whose third entry's `from` is rewritten is rejected with the
  chain-break error, asserted outside the printed parse and
  reported on one closing line. `runDemo()` returns the parsed
  entries, the prefix-match verdict, and the rejection message;
  the demo tests pin the structured results against
  hand-written expectations cross-checked by an independent
  re-parse, the exact printed lines in the golden output, and
  the segment's printed-line determinism across two runs. No
  network, no randomness, and no wall clock. Demo and tests
  only; no library behavior change.
- Benchmark coverage for terminal-state judgement:
  `isTerminal(state)` over all 13 states (in transition-table
  declaration order) now appears in `npm run bench`.
  Per-iteration self-checks pin every returned value to the
  hand-written truth table in the bench comments (only the
  terminal states PAID / ABANDONED / EXPIRED return `true`; the
  other ten states return `false`), and an exhaustive check
  runs once outside the timed loop. No network and no
  wall-clock reads. The README Benchmarks table is refreshed
  from one real run. Benchmark only; no library behavior change.
- An allowed-events listing segment closing the CLI demo:
  `allowedEvents(state)` is run over all 13 states in
  transition-table order and printed as one line per state — the
  query a task-list UI or a watchdog consults to decide what a
  task can do next. The three terminal states (PAID / ABANDONED /
  EXPIRED) return the empty list, and the main task's own PAID
  state is called out on its own line as that same empty set.
  The query is pure — no task instance, no dispatch, no
  mutation — so the segment adds no network, no randomness, and
  no wall clock. `runDemo()` returns the per-state listing plus
  the main task's (empty) allowed set; the demo tests pin the
  structured results against hand-written expectations
  cross-checked against the transition table, the exact printed
  lines in the golden output, and the segment's printed-line
  determinism across two runs. Demo and tests only; no library
  behavior change.
- A payout Retry-After parsing segment in the CLI demo: a fixed
  6-value corpus (`"2"`, `"  30 "`, a future HTTP-date, a past
  HTTP-date, `"banana"`, and `null`) is parsed with
  `parsePayoutRetryAfter()` under the fan-out segment's shared
  fixed instant (2026-03-20T09:00:00.000Z) reused as `nowMs` — no
  new instant, no network, no randomness, no wall clock.
  Delay-seconds normalize to milliseconds (2000 / 30000, the
  second value trimmed first), the future date yields its exact
  5000 ms delta, the past date clamps to 0, and the garbage and
  absent values return `undefined` (the caller's fallback to
  exponential backoff). A closing line ties the corpus to the
  fan-out segment: the risk endpoint answered 500, so its
  retries used backoff; had it answered 429 with a `Retry-After`
  header, the parsed wait (clamped to `maxRetryDelayMs`) would
  have set the next attempt's delay. `runDemo()` returns the six
  parsed results in corpus order; the demo tests pin the
  structured results (cross-checked by an independent re-parse
  of the same corpus under the same fixed now), the exact
  printed lines in the golden output, and the segment's
  printed-line determinism across two runs. Demo and tests only;
  no library behavior change.
- Benchmark coverage for standalone history parsing:
  `parseHistory(history)` over the fixed 8-entry chained
  history now appears in `npm run bench`. Per-iteration
  self-checks pin the returned entry count and the last
  entry's `seq` / state to the hand-written expectations
  (8 entries, last `seq` 8, final state PAID), and a detached
  tampered copy (its `PAYOUT_COMPLETE` entry's `payoutAmount`
  altered from 125 to 126) is rejected once, outside the timed
  loop, with the hash-chain error. No network and no
  wall-clock reads. The README Benchmarks table is refreshed
  from one real run. Benchmark only; no library behavior change.
- An SLA watchdog batch execution branch in the CLI demo:
  three more tasks (`DEMO-014` / `DEMO-015` / `DEMO-016`) rebuild
  the SLA screening branch's batch fresh from the same fixed
  literals — the executor mutates its inputs and the original
  SLA tasks are already settled (`DEMO-001` PAID, `DEMO-002`
  EXPIRED) — and are executed under the very same fixed
  screening `now` (2026-03-06T09:00:00.000Z, reused from the SLA
  branch; no new screening instant, no network, no randomness)
  with `expireOverdueTasks()`. `DEMO-014` mirrors `DEMO-002`'s
  setup exactly (ACCEPTED, deadline 2026-03-03) and `DEMO-015`
  sits in OPEN past its 2026-03-04 deadline: both are screened
  by `expiredTasks()` and both are expired by the executor, so
  the screening subset and the execution's acted set agree.
  `DEMO-016` (ACCEPTED, deadline 2026-03-10, still ahead) is
  never attempted and produces no result entry (2 attempted,
  2 expired, 0 failed). The executor takes no action callback,
  so its EXPIRE entries carry the library defaults (no actor, a
  wall-clock audit timestamp); the segment prints no history for
  the rebuilt tasks and none of those timestamps, so every
  printed line is a fixed literal or derived from one.
  `runDemo()` returns the three tasks, the pre-execution
  screening subset and the per-task results; the demo tests pin
  the structured results (cross-checked by an independent batch
  driven from the same fixed literals through the same
  executor), the exact printed lines in the golden output, and
  the segment's printed-line determinism across two runs. Demo
  and tests only; no library behavior change.
- Benchmark coverage for the allowed-events query:
  `allowedEvents(state)` over all 13 states (in transition-table
  declaration order) now appears in `npm run bench`. Per-iteration
  self-checks pin every returned list to the hand-written
  expectations in the bench comments (each non-terminal state
  returns exactly its outgoing events; the terminal states PAID /
  ABANDONED / EXPIRED return an empty list), and an exhaustive
  check runs once outside the timed loop. No network and no
  wall-clock reads. The README Benchmarks table is refreshed
  from one real run. Benchmark only; no library behavior change.
- An audit hash-chain segment in the CLI demo, printed right
  after the main task's history: `verifyHistoryChain` runs on
  the intact 12-entry history (genesis-linked, every hash
  recomputes — verdict `true`); a detached copy whose
  `PAYOUT_COMPLETE` entry's `payoutAmount` is altered from
  10098.5 to 10099.5 is detected (verdict `false` — the stored
  hash no longer recomputes from the altered canonical
  content); and the original history re-verifies `true`
  afterwards, proving the tamper check never touched it. This
  is the verify-before-replay check an auditor runs before
  trusting a persisted history (the demo's closing segment
  replays that same history). `runDemo()` returns the three
  structured values (`historyChainVerified`,
  `tamperedChainVerified`, `tamperedPayoutAmount`); the demo
  tests pin them (cross-checked by a hand-built tamper in the
  test itself), the exact printed lines in the golden output,
  and the segment's determinism across two runs (it prints no
  timestamps or hashes). Demo and tests only; no library
  behavior change.
- A stale-task batch execution branch in the CLI demo: four
  more tasks (`DEMO-010` / `DEMO-011` / `DEMO-012` / `DEMO-013`)
  are driven under fixed-literal timestamps and executed at the
  screening branch's fixed `now` (2026-03-22T09:00:00.000Z; no
  network, no randomness, no wall clock) with `actOnStaleTasks()`
  under 7-day dwell budgets for ACCEPTED, CAPTURING and
  SUBMITTED, using a custom action that dispatches `ABANDON`
  with the fixed execution instant as its audit timestamp.
  `DEMO-010` has sat in SUBMITTED for 12 days (stale, but
  SUBMITTED has no ABANDON edge) and is placed first on purpose:
  its action fails with `invalid transition: ABANDON from
  SUBMITTED`, it is left untouched, and the batch keeps going —
  `DEMO-011` (ACCEPTED for 17 days) and `DEMO-012` (CAPTURING
  for 14 days) are both abandoned, while `DEMO-013` (ACCEPTED
  for 1 day, within budget) is never attempted and produces no
  result entry (3 attempted, 2 acted, 1 failed). `runDemo()`
  returns the four tasks and the per-task results; the demo
  tests pin the structured results (cross-checked by an
  independent batch rebuilt from hand-written histories and run
  through the same executor), the exact printed lines, and the
  segment's byte-identical determinism across two runs. Demo
  and tests only; no library behavior change.
- A stale-task dwell screening branch in the CLI demo: three
  more tasks (`DEMO-007` / `DEMO-008` / `DEMO-009`) are driven
  under fixed-literal timestamps and screened at one fixed `now`
  (2026-03-22T09:00:00.000Z; no network, no randomness, no wall
  clock). `DEMO-007` has sat in OPEN for 21 days — past the
  7-day OPEN dwell budget, so `staleTasks()` selects it — but
  its OPEN SLA deadline (2026-03-25) is still ahead, so
  `expiredTasks()` does not; `DEMO-008` has sat in IN_REVIEW
  for 1 day — within the 5-day IN_REVIEW dwell budget, so not
  stale — but its IN_REVIEW SLA deadline (2026-03-21T12:00)
  has passed, so `expiredTasks()` selects it; `DEMO-009` has
  sat in OPEN for 1 day with no SLA deadline and is selected
  by neither screen. The branch prints each task's dwell
  beside its per-state budget and the two screens' subsets
  side by side — the same batch reads differently under the
  dwell lens than under the deadline lens — and both screens
  are pure, so no task is dispatched or mutated. `runDemo()`
  returns the three tasks and both subsets; the demo tests
  pin the structured results (cross-checked by an independent
  re-screening under the same fixed `now` and budgets), the
  exact printed lines, and the segment's byte-identical
  determinism across two runs. Demo and tests only; no
  library behavior change.
- A multi-endpoint fan-out delivery segment in the CLI demo:
  after the batch segment, the main task's payout event is
  delivered with `deliverPayoutWebhookToMany` to three fixed
  endpoints (billing / risk / notifications) under one shared
  fixed `now` (2026-03-20T09:00:00.000Z) and one shared
  `eventId`, each endpoint signed with its own demo secret,
  through an injected fake `fetchImpl` (no real network) and a
  no-op `sleepImpl` with `backoffMs: 0` (no real sleeps). The
  risk endpoint answers 500 on every attempt and fails after
  the default 3 attempts while the other two succeed on their
  first attempt — the results print in input order (2
  delivered, 1 failed) with a shared-event check line.
  `runDemo()` is now async and returns the fan-out result plus
  the wire calls the fake fetch received; the demo tests pin
  the structured results (cross-checked against the recorded
  wire bodies and signatures, each verifying only under its
  own endpoint's secret), the exact printed lines, and the
  segment's byte-identical determinism across two runs. Demo
  and tests only; no library behavior change.
- Benchmark coverage for per-task payout mismatch judgement:
  `payoutMismatch()` over a fixed set of 5 tasks (settled exactly
  as quoted, settled for a different amount, missing quote,
  missing settled amount, and one non-PAID task; fixed dispatch
  timestamps) now appears in `npm run bench`. Per-iteration
  self-checks pin every returned value to the hand-written
  expectations in the bench comments (the mismatched task's delta
  is computed by hand; the other four shapes yield `undefined`),
  and an exhaustive check runs once outside the timed loop. No
  network and no wall-clock reads. The README Benchmarks table
  is refreshed from one real run. Benchmark only; no library
  behavior change.
- A dispatch subscription branch in the CLI demo: a sixth task
  (`DEMO-006`) is created under fixed-literal timestamps
  (2026-03-19; no network, no randomness, no wall clock) and a
  collecting listener is subscribed before any dispatch. The
  listener receives the first three dispatches in order —
  `PUBLISH` DRAFT → OPEN, `ACCEPT` OPEN → ACCEPTED,
  `START_CAPTURE` ACCEPTED → CAPTURING — each `(event, from, to)`
  matching the audit history entry with the same seq; after
  `unsubscribe`, a further `SUBMIT` dispatch moves the task to
  SUBMITTED but produces no new notification. `runDemo()` returns
  the task, the collected notifications, the history-match
  verdict, and the post-unsubscribe notification count, and the
  demo tests pin the structured results (cross-checked against
  the task history), the exact printed lines, and the segment's
  byte-identical determinism across two runs. Demo and tests
  only; no library behavior change.
- Benchmark coverage for payout Retry-After parsing:
  `parsePayoutRetryAfter()` over a fixed 11-value corpus
  (delay-seconds, a future HTTP-date, a past HTTP-date, signed
  numbers, garbage, and absent values) under an injected fixed
  `nowMs` now appears in `npm run bench`. Per-iteration
  self-checks pin every returned value to the hand-written
  expectations in the bench comments (a past date clamps to 0,
  signed values are rejected, absent / garbage values yield
  `undefined`), and an exhaustive check runs once outside the
  timed loop. No network and no wall-clock reads. The README
  Benchmarks table is refreshed from one real run. Benchmark
  only; no library behavior change.
- An event-sourcing replay segment closing the CLI demo: the main
  task's 12-entry audit history is exported with
  `historyToNdjson()`, printed in full (one canonical JSON entry
  per line), parsed back with `historyFromNdjson()`, and replayed
  with `TaskLifecycle.fromHistory()` — the replayed task lands in
  the same PAID state with a history deep-equal to the original's,
  last entry included, and re-exporting it reproduces the NDJSON
  byte for byte. `runDemo()` returns the NDJSON text and the
  replayed task, and the demo tests pin the structured round-trip
  (cross-checked against an independent parse + replay), the
  exact printed lines, and the segment's agreement across two
  runs once the main task's own timestamps and derived hash-chain
  links are normalized. Demo and tests only; no library behavior
  change.
- A receiver-side dedupe segment in the CLI demo: after the single
  payout webhook is built and verified, its `eventId` is fed
  through a `PayoutEventDedupe` under an injected fixed clock
  (starting 2026-03-18T09:00:00.000Z, advanced by hand — no wall
  clock). The first delivery is a new event and the payout is
  booked, a redelivery of the same `eventId` is reported as a
  duplicate and skipped, and once the clock advances by exactly
  the demo TTL (60,000 ms; the library default is 3,600,000 ms)
  the same id is accepted again at the TTL boundary.
  `runDemo()` returns the three `checkAndRecord` outcomes, and
  the demo tests pin the structured results (cross-checked
  against an independent dedupe instance under the same clock),
  the exact printed lines, and the segment's determinism across
  two runs. Demo and tests only; no library behavior change.
- A reconciliation screening branch in the CLI demo: after the
  batch webhook segment, two more tasks are driven to PAID under
  fixed-literal timestamps, each with one deliberate flaw —
  `DEMO-004` settles exactly as quoted but its `PAYOUT_COMPLETE`
  entry carries no `payoutRef`, and `DEMO-005` settles under a
  `payoutRef` for 3750.5 against an `ACCEPT` quote of 4000. All
  five demo tasks are then screened with `unreconciledPayouts()` /
  `mismatchedPayouts()` / `totalPaidOut()`: each flawed task is
  flagged by exactly one screen, the main task by neither, and the
  paid-out total prints the hand-computed 16349
  (10098.5 + 2500 + 3750.5; the EXPIRED and REJECTED tasks
  contribute nothing). `runDemo()` returns both branch tasks, both
  screening results, and the total, and the demo tests pin the
  structured results, the exact screening lines, and the segment's
  determinism across two runs. Demo and tests only; no library
  behavior change.
- Benchmark coverage for payout event dedupe restore:
  `PayoutEventDedupe.restore()` rebuilding a dedupe from a
  1,000-entry snapshot (the persisted JSON-round-tripped form, all
  entries live at load under the default TTL and capacity) now
  appears in `npm run bench`, next to the existing duplicate-hit
  path. Per-iteration self-checks pin the restored size and the
  zeroed observability counters to the hand-written expectations in
  the bench comments and spot-check the first / middle / last
  snapshot ids as duplicates; an exhaustive all-ids check (1,000
  hits, unseen-id first-sighting semantics intact) runs once
  outside the timed loop. The README Benchmarks table is refreshed
  from one real run. Benchmark only; no library behavior change.
- A batch payout webhook segment in the CLI demo: after the
  single-build webhook section, the demo runs `buildPayoutWebhooks`
  over all three demo tasks (the PAID main task plus the EXPIRED SLA
  branch task and the REJECTED dispute branch task) under the shared
  demo secret, one shared fixed `now`, and a deterministic
  `eventId` factory, so the segment is byte-identical on every run.
  The PAID task's webhook is printed with its per-item `eventId` and
  verified with `verifyPayoutWebhook`; each non-PAID task prints
  only `{ taskId, error }`, and the closing summary states the
  per-item isolation rule — a non-PAID task fails only itself and
  never blocks later tasks (the third task is still attempted after
  the second errors). `runDemo()` returns the batch results and
  their per-item verification outcomes, and the demo tests pin the
  structured results, the exact error text, and the segment's
  determinism across two runs. Demo and tests only; no library
  behavior change.

- A DISPUTE appeal branch in the CLI demo: a third task (`DEMO-003`)
  is rejected in QA, the contributor DISPUTEs the rejection into
  DISPUTED, and a moderator's ARBITRATE_REJECT lands it back in
  REJECTED (not a terminal state), with the full audit history
  printed. The demo task carries `maxDisputes: 1` and uses 1 of the
  1 — the demo source and output state explicitly that the library
  default is unlimited, so the budget is not mistaken for a built-in
  cap — and the demo tests pin the branch's transition lines, its
  fixed-literal timestamps, and the fact that a second DISPUTE throws
  `dispute budget exhausted` without leaving a trace. The main
  DRAFT → PAID chain and the SLA watchdog branch are unchanged, and
  the payout webhook section still closes the demo. Demo and tests
  only; no library behavior change.
- Benchmark coverage for watchdog execution: `expireOverdueTasks()`
  and `actOnStaleTasks()` (with its default ABANDON action) over the
  same fixed batch of 12 mixed-state tasks as the watchdog screening
  paths now appear in `npm run bench`. Both executors dispatch and
  mutate the tasks they act on, so every timed iteration rebuilds the
  batch fresh — the reported numbers include that rebuild cost and
  are a conservative floor for the pure executor cost. Per-iteration
  self-checks pin the hand-counted outcomes written out in the bench
  comments (3 of the 4 overdue tasks expire, the IN_REVIEW one fails
  in isolation; 1 of the 4 stale actions succeeds, the rest fail in
  isolation) and the resulting task states, and the README
  Benchmarks table is refreshed from one real run. Benchmark only;
  no library behavior change.
- The CLI demo is now an importable `runDemo()` (same shape as the
  sibling demos): it returns both demo tasks, the SLA screening
  result, the built payout webhook with its verification outcome,
  and the exact printed `lines`, with printing kept behind the
  direct-execution guard. `npm run demo` output is unchanged — a
  golden test pins the pre-refactor output line for line, normalizing
  only the values that already varied between any two runs (the main
  task's wall-clock timestamps and the webhook `at` / `eventId` /
  signature derived from them) — and the demo tests now assert the
  structured payload/history values in-process, keeping one
  subprocess smoke test for the CLI entry point. Refactor and tests
  only; no library behavior change.
- Batch payout webhook building: `buildPayoutWebhooks(tasks, secret, opts?)`
  returns one `{ taskId, webhook }` / `{ taskId, error }` result per
  input task, in input order — a non-PAID task fails only itself and
  never blocks later tasks, while call-level configuration errors
  (empty secret, invalid shared `now`, non-function `eventIdFactory`,
  non-array `tasks`) throw for the whole batch. The batch shares the
  `now` timestamp and the `eventId` generation strategy
  (`eventIdFactory`, default `crypto.randomUUID()`), never the
  `eventId` value: each task is a distinct payout with its own
  `eventId`, and each built webhook verifies exactly as a single
  `buildPayoutWebhook` build does. Building is a signing primitive
  only — no delivery, queueing, or retry is added.
- A payout webhook field-set audit (README "Payout webhooks"): the
  payload's fields were checked one by one against the audit history
  and escrow's settlement payload — every identifier/settlement
  field derivable from the same history (`taskId`, `payoutRef`,
  `payoutAmount`, `quotedAmount`) is already carried, so no field
  was invented; the README documents each field's source, escrow
  counterpart, and omission rule, and new snapshot tests pin the
  exact field set and canonical key order (tampering with, stripping,
  or adding any field fails verification). Documentation and tests
  only; no behavior change.
- A README FAQ section answering the positioning questions honestly:
  this is an off-chain reproduction of the case study's lifecycle
  rules, not the real DataQuest platform backend; `PAID` records a
  dispatched `PAYOUT_COMPLETE`, not a verified external payment; SLA
  deadlines are advisory and expiry stays an explicit `EXPIRE` event;
  the payout webhook is a signed notification, not a payment; and
  snapshots/NDJSON are export formats, not built-in storage.
  Documentation only; no behavior change.
- Payout webhook payloads now carry `quotedAmount` (the owed amount
  from the last `ACCEPT` audit entry, derived exactly as
  `payoutMismatch()` derives it), placed after `payoutAmount` in the
  signed canonical key order and omitted as a whole key when the last
  `ACCEPT` entry carries no quote. Receivers can recompute the
  quoted-vs-settled comparison locally; the field only carries data,
  adjudication stays with the receiver.
- Benchmark coverage for the NDJSON audit-log round-trip:
  `historyToNdjson` export and `historyFromNdjson` import (per-line
  parsing interleaved with full hash-chain re-verification) now appear
  in `npm run bench` alongside the existing paths, with the README
  Benchmarks table refreshed from one real run.
- Benchmark coverage for payout reconciliation screening:
  `mismatchedPayouts` and `unreconciledPayouts` over a fixed batch of
  12 PAID tasks (hand-counted screening expectations as bench
  self-checks) now appear in `npm run bench`, with the README
  Benchmarks table refreshed from one real run.
- Benchmark coverage for payout webhook fan-out delivery:
  `deliverPayoutWebhookToMany` to 4 endpoints through an injected
  deterministic fake fetch (immediate 200 — no network, no real sleep;
  per-iteration self-checks pin one result per endpoint, all
  delivered, one shared `eventId`, and one byte-identical body, with a
  one-time check that each copy verifies under its endpoint's own
  secret) now appears in `npm run bench`, with the README Benchmarks
  table refreshed from one real run. This measures the library's
  fan-out overhead only, not network throughput.
- A `package.json` `exports` map for the package root
  (`.` → `types`/`import`/`default` under `dist/src/`), alongside a
  correction of `main`/`types`, which previously pointed at a
  non-existent `dist/index.js` instead of the real `dist/src/` build
  layout. Package self-reference import smoke tests pin the declared
  shape, the consistency with `main`/`types`, and that every declared
  entry file exists after a build.
- Continuous integration: a GitHub Actions workflow runs the test
  suite on push and on pull requests, on Node 20 and 22.
- The CLI demo (`npm run demo`) now exercises the reject→resubmit
  loop: the first submission is REJECTed in QA and RESUBMITted (the
  demo task is constructed with `maxResubmits: 2` and uses 1 of the 2;
  the library default remains unlimited), then passes on re-review
  and continues to PAID. Demo tests pin the new transition lines, the
  REJECT-before-RESUBMIT-before-APPROVE ordering, and the 12-entry
  audit history. Demo and documentation only; no behavior change.
- The CLI demo (`npm run demo`) now continues past the PAID state:
  it builds the signed payout webhook for the settled task with a
  clearly labelled demo-only secret (not a real credential), prints
  the payload fields and signature a receiver would see, and verifies
  it with `verifyPayoutWebhook`, printing the verification result.
  Demo tests pin the new output lines.
- The CLI demo (`npm run demo`) now includes an SLA watchdog branch:
  a second task (DEMO-002) whose ACCEPTED-state SLA deadline is
  already past at a fixed screening instant is found by
  `expiredTasks()` screening over both demo tasks, shown to still be
  ACCEPTED (the deadline is advisory and never expires a task by
  itself), and then explicitly dispatched `EXPIRE` by a watchdog
  actor into the EXPIRED terminal state, with its audit history
  printed. Every branch timestamp is a fixed literal or the injected
  screening `now` — the branch reads no wall clock. Demo tests pin
  the screening line, the EXPIRE transition, the fixed timestamps,
  and the EXPIRED end state. Demo and tests only; no behavior change.
- Benchmark coverage for the `PayoutEventDedupe` duplicate-hit hot
  path (repeat `check`/`record` on an already-seen `eventId`) now
  appears in `npm run bench`, with the README Benchmarks table
  refreshed from one real run.
- Benchmark coverage for batch payout webhook building:
  `buildPayoutWebhooks()` over a batch of tasks now appears in
  `npm run bench` alongside the single-build path, with the README
  Benchmarks table refreshed from one real run.
- Benchmark coverage for the payout reconciliation total:
  `totalPaidOut()` over the same fixed batch of 12 PAID tasks as the
  screening paths now appears in `npm run bench`, with a per-iteration
  self-check pinning the returned total to the hand-computed sum of
  the batch's recorded `payoutAmount`s (1986, written out in the bench
  comments), and the README Benchmarks table refreshed from one real
  run.
- Benchmark coverage for watchdog screening: `expiredTasks()` and
  `staleTasks()` over a fixed batch of 12 mixed-state tasks under one
  injected fixed `now` (with per-state dwell budgets) now appear in
  `npm run bench`, with per-iteration self-checks pinning both
  selections to the hand-counted expectations written out in the bench
  comments (4 expired, 4 stale), and the README Benchmarks table
  refreshed from one real run.
- Package discoverability metadata: `package.json` now declares
  `keywords` (`task-lifecycle`, `state-machine`, `event-sourcing`,
  `sla`, `webhooks`, `payments`, `typescript`, `zero-dependency`).

- A pure `replay()` terminal-state derivation in the CLI demo:
  `npm run demo`'s closing event-sourcing replay segment now also
  feeds the NDJSON round-tripped DEMO-001 history to the stateless
  `replay()` function (no instance, no snapshot envelope), prints
  the derived final state (`PAID`), and cross-checks it three ways
  — `replay()` vs the live task's `state` vs the
  `TaskLifecycle.fromHistory()` instance's state — plus pins the
  empty-history `DRAFT` sentinel. The demo's `DemoResult` carries
  the new `replayDerivedState` field; the demo test suite pins the
  derivation, the three-way agreement, and both printed lines
  verbatim (a mutated expectation turns the test red); the golden
  demo output and the README demo description and test count are
  refreshed to match.
- Integer minor-unit denomination for payout amounts (backlog #558):
  `dispatch()` now rejects `payoutAmount`/`quotedAmount` values with
  more than 2 decimal places — a sub-cent value throws
  `invalid dispatch options: … must be a minor-unit amount (at most 2
  decimal places)` before anything is appended, so no amount that
  cannot be stored as integer cents enters the audit trail.
  `totalPaidOut()` accumulates integer minor units via the new exported
  `toMinorUnits()` helper (with `fromMinorUnits()` as its inverse) and
  returns the total in major units, so binary-float error cannot
  accumulate across a batch. Only new writes are gated: the parse side
  deliberately still accepts legacy sub-cent amounts, and a legacy
  webhook payload carrying a float amount still builds and verifies
  (the verify path is untouched); stored fields stay major-unit
  numbers, so no existing amount changes meaning.

### Fixed

- De-flaked the history parser fuzz timing guard: the per-call 50ms
  wall-clock assertion in `historyParserFuzz` could fail under parallel
  load (a 101.6ms scheduler pause on sub-millisecond work). The guard
  now asserts the corpus median against the same 50ms budget, plus a
  1000ms catastrophic worst-case bound, so a systematic per-call
  slowdown still fails while a single pause does not. Tests only; no
  behavior change.
- Corrected the `PayoutWebhookPayload.eventId` JSDoc, which still described
  the retrying delivery layer as future work: `deliverPayoutWebhook` retries
  and `deliverPayoutWebhookToMany` fan-out re-POST the same logical event
  under the same `eventId` today, and receivers deduplicate on it (see
  `PayoutEventDedupe`). Documentation only; no behavior change.
- De-flaked the replay equal-timestamp test: it previously rewrote an
  already-chained history entry's `at` to match its predecessor without
  recomputing the hash chain (`at` is part of the canonical hash
  input), so it only passed when the first two wall-clock dispatches
  happened to land in the same millisecond. The equal timestamps are
  now built through dispatch's `at` injection so the entries are
  chained consistently from birth, and the decreasing-timestamp case
  is built on a hashless legacy history so only the non-decreasing
  rule can reject it. Tests only; no behavior change.
- De-flaked the payout webhook `AbortSignal` tests: aborts are now
  triggered from injected stub events (the stub fetch / sleep being
  called) instead of wall-clock timers racing the delivery attempts.
  Tests only; no behavior change.

### Tests

- Package entry smoke tests: `package.json` `main`/`types` are pinned
  to the real `dist/src/` build layout, every declared entry file is
  asserted to exist after a build, importing through the declared
  main entry is asserted to expose a usable core API, and the README
  Quickstart is asserted to import from that same entry path.

### Documentation

- A `CONTRIBUTING.md` covering prerequisites (Node ≥ 20, npm only),
  setup, the build-then-test flow, the demo/diagram/bench entry
  points, the repository's hard rules, and the pre-submit checks.

### Changed

- `expireOverdueTasks()` now signs its EXPIRE dispatches with the
  `system` actor (backlog #550). The watchdog's audit entries were
  previously anonymous, so a later reader could not tell a
  watchdog-driven expiry apart from a human-driven one; the entries
  now carry the same `system` attribution that `actOnStaleTasks` uses
  for its default ABANDON action. This is a behavior change: any
  reader that pinned `actor === undefined` on executor-produced EXPIRE
  entries must expect `"system"` instead.

## [0.1.0]

The only version declared in `package.json`. Entries cover the commit
history from the initial commit (2026-10-02) through 2026-10-10.

### Added

- Task lifecycle state machine (DataQuest reproduction): typed states,
  events, transition table, `allowedEvents` / `isTerminal` helpers.
- SLA deadlines per state with an `isOverdue` helper.
- CLI demo script (`npm run demo`) walking the DRAFT→PAID path, and an
  `npm run diagram` CLI that regenerates/verifies the mermaid state diagram.
- JSON snapshot persistence (`toJSON` / `fromJSON`) with strict validation,
  a snapshot schema version (`v: 1`) with legacy pass-through, and snapshot
  export/restore for the payout dedupe helper.
- Event-sourced replay from the audit history log, and NDJSON history
  export/import for event streams.
- Audit-history SHA-256 hash chain for tamper evidence, with an optional
  keyed HMAC mode.
- Event-level RBAC policy for dispatch.
- Retry and dispute budgets: `TaskLifecycleOptions.maxResubmits` for RESUBMIT
  and a `maxDisputes` appeal-round budget for DISPUTE.
- Watchdog helpers: `expiredTasks`, `staleTasks`, the `expireOverdueTasks()`
  executor, and `actOnStaleTasks()` for stale-task handling.
- Dispatch subscription hooks for notification fan-out, including an
  `onError` observability hook for `subscribe()`, dispatch timestamp
  injection for deterministic audit tests, and dispatch actor/note input
  validation.
- Dispatch idempotency keys, persisted in snapshots.
- Optimistic concurrency via `DispatchOptions.expectedSeq`.
- Settlement support: `payoutRef` reference on dispatch audit entries,
  `payoutAmount` + `totalPaidOut` amount reconciliation,
  `unreconciledPayouts()` screening, `quotedAmount` with payout mismatch
  reconciliation, and opt-in up-front payout-reference enforcement
  (`TaskLifecycleOptions.requirePayoutRef`).
- Payout webhook module: PAYOUT_COMPLETE settlement webhook signing,
  `deliverPayoutWebhook` with retry/backoff, multi-endpoint fan-out
  delivery, multi-secret rotation for verification, opt-in `maxAgeMs`
  freshness and `maxFutureSkewMs` future-timestamp bounds, external
  `AbortSignal` support, and the `PayoutEventDedupe` receiver-side
  eventId deduplication helper.
- Benchmark script (`npm run bench`) for dispatch, replay, chain
  verification, and payout webhooks.

### Fixed

- Freeze the `history` getter against runtime tampering.
- Reject empty/non-string ids in the `TaskLifecycle` constructor.
- Reject empty actors and oversized notes in dispatch/`parseHistory`.
- Reject unknown fields in snapshot and history parsing (fail-closed).
- Keep the webhook backoff timer and the per-attempt timeout timer ref'd
  so an awaited delivery always settles.

### Tests

- Transition-table JSON snapshot plus `allowedEvents`/`isTerminal` coverage.
- Audit history integrity tests (seq increment, from/to chain, ISO
  timestamps).
- Deterministic random-walk invariant tests with a fixed seed.
- A test that executes the README Quickstart code block.
- Seeded fuzz coverage for the history, NDJSON, and snapshot parsers.

### Documentation

- Mermaid state diagram generated from the transition table.
- `SECURITY.md` describing trust boundaries and the caller-trust model.
- README history-entry fields and snapshot shape kept in sync with the code.
- MIT `LICENSE` file; package published to GitHub Packages as the scoped
  `@toniadreal/dataquest-task-lifecycle` package.
