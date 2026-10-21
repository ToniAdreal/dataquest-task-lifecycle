# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version below is the version declared in `package.json`. Every entry
summarizes one or more commits in this repository's `git log`, grouped by
change type; no entry describes a feature that is not in the history.

## [Unreleased]

### Added

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
