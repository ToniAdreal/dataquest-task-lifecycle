# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version below is the version declared in `package.json`. Every entry
summarizes one or more commits in this repository's `git log`, grouped by
change type; no entry describes a feature that is not in the history.

## [Unreleased]

### Added

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
- The CLI demo (`npm run demo`) now continues past the PAID state:
  it builds the signed payout webhook for the settled task with a
  clearly labelled demo-only secret (not a real credential), prints
  the payload fields and signature a receiver would see, and verifies
  it with `verifyPayoutWebhook`, printing the verification result.
  Demo tests pin the new output lines.
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
