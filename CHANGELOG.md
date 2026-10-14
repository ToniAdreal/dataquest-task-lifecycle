# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version below is the version declared in `package.json`. Every entry
summarizes one or more commits in this repository's `git log`, grouped by
change type; no entry describes a feature that is not in the history.

## [Unreleased]

### Added

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
