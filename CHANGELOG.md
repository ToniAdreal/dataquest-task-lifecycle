# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version below is the version declared in `package.json`. Every entry
summarizes one or more commits in this repository's `git log`, grouped by
change type; no entry describes a feature that is not in the history.

## [Unreleased]

### Added

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

### Fixed

- Corrected the `PayoutWebhookPayload.eventId` JSDoc, which still described
  the retrying delivery layer as future work: `deliverPayoutWebhook` retries
  and `deliverPayoutWebhookToMany` fan-out re-POST the same logical event
  under the same `eventId` today, and receivers deduplicate on it (see
  `PayoutEventDedupe`). Documentation only; no behavior change.

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
