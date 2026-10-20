/**
 * Local micro-benchmark for the dataquest-task-lifecycle state machine.
 *
 * Measures real, locally-observed throughput for the thirty-two hot-path
 * groups a watchdog / reconciliation deployment actually hammers:
 *
 *   1. dispatch — one full DRAFT -> PAID lifecycle (8 dispatches, each
 *      appending a hash-chained audit entry) on a fresh task;
 *   2. event-sourced replay / rehydration — `replay(history)` deriving
 *      the final state, and `TaskLifecycle.fromHistory(...)` rebuilding
 *      the task, both over a fixed 8-entry chained history. The
 *      `fromHistory` path's per-iteration self-check pins the rebuilt
 *      task's id and state and its full history, entry for entry
 *      (hashes included), against the source history, and a detached
 *      tampered history is rejected once, outside the timed loop
 *      (see the fromHistory fidelity fixture below);
 *   3. `verifyHistoryChain(history)` — full SHA-256 hash-chain
 *      re-verification of that same history. The path's
 *      per-iteration self-check pins the fixture's genesis
 *      linkage (the first entry's `prevHash` is
 *      `GENESIS_PREV_HASH`) and every later entry's `prevHash`
 *      linkage to its predecessor's `hash`, and a detached
 *      tampered history returns false once, outside the timed
 *      loop (see the verifyHistoryChain linkage fixture below);
 *   4. payout webhook build / verify — `buildPayoutWebhook` (HMAC-SHA256
 *      signing) and `verifyPayoutWebhook` over the signed body;
 *   5. NDJSON export / import — `historyToNdjson` (validated export of
 *      the same 8-entry history) and `historyFromNdjson` (per-line JSON
 *      parsing interleaved with a full `parseHistory` hash-chain
 *      re-verification — a differently-shaped cost from the standalone
 *      `verifyHistoryChain` path above);
 *   6. payout reconciliation screening — `mismatchedPayouts(tasks)`,
 *      `unreconciledPayouts(tasks)`, and `totalPaidOut(tasks)` over a
 *      fixed batch of 12 PAID tasks (each with the full 8-entry
 *      history), scanning every task's history for its `ACCEPT` quote /
 *      `PAYOUT_COMPLETE` settlement evidence. `totalPaidOut` is the
 *      summary counterpart of the two screening helpers: it sums the
 *      recorded `payoutAmount`s across the batch, the day-end total
 *      finance reconciliation checks the screened set against. This is
 *      the batch pass finance reconciliation runs over a whole task
 *      set, as opposed to the per-task webhook paths above;
 *   7. payout webhook fan-out delivery — `deliverPayoutWebhookToMany()`
 *      delivering one PAID task's settlement event to 4 endpoints at
 *      once (one shared `eventId`, one byte-identical body, each copy
 *      signed with its endpoint's own secret) through an injected
 *      deterministic fake fetch that answers 200 immediately. No real
 *      network, retries, or sleeps are involved, so this measures this
 *      library's fan-out overhead only — not network throughput;
 *   8. payout event dedupe — `PayoutEventDedupe.checkAndRecord()`
 *      steady-state duplicate hits cycling over 1,000 pre-recorded
 *      `eventId`s under an injected fixed clock (the clock never
 *      advances, so no entry expires and none is evicted in the timed
 *      loop), and `PayoutEventDedupe.restore(snapshot, opts)`
 *      rebuilding a dedupe from a 1,000-entry snapshot (see the
 *      restore fixture below for its composition and the hand-written
 *      expectations). This is the receiver-side counterpart of the
 *      sender paths above: every delivered payout notification pays
 *      this check before it may be processed, and every receiver
 *      restart pays the restore before the first check;
 *   9. batch payout webhook building — `buildPayoutWebhooks()` over a
 *      fixed batch of 12 PAID tasks under one shared payload timestamp,
 *      with per-task `eventId`s from an injected deterministic factory
 *      (a batch must never share one `eventId` across tasks). This is
 *      the settlement-peak signing path: a whole settled batch signed
 *      in one call, with per-task failure isolation (a non-PAID task
 *      fails only itself) instead of the single-build throw aborting
 *      the batch — the isolation rule is self-checked once, outside
 *      the timed loop, on a mixed batch.
 *
 *  10. watchdog screening — `expiredTasks(tasks, now)` (SLA-overdue
 *      screening) and `staleTasks(tasks, maxAgeByState, now)`
 *      (per-state dwell screening) over a fixed batch of 12 tasks in
 *      mixed states (see the watchdog fixture below for the per-task
 *      composition and the hand-counted expectations), both under one
 *      injected fixed `now`. This is the batch pass a watchdog polls
 *      on every tick before dispatching EXPIRE / paging a human, as
 *      opposed to the reconciliation passes above.
 *
 *  11. watchdog execution — `expireOverdueTasks(tasks, now)` and
 *      `actOnStaleTasks(tasks, undefined, maxAgeByState, now)` (the
 *      default ABANDON action) over the same fixed 12-task watchdog
 *      batch as group 10. Unlike the pure screening helpers, both
 *      executors MUTATE the tasks they act on (an auditable EXPIRE /
 *      ABANDON dispatch plus its hash-chained audit entry), so every
 *      timed iteration rebuilds the whole 12-task fixture from
 *      scratch first — the reported numbers therefore include the
 *      fixture-rebuild cost and are a conservative floor for the
 *      executor cost, not the pure executor throughput. Selection
 *      uses the same injected fixed `now` / budgets as group 10; the
 *      executors' own dispatches carry no injected timestamp (their
 *      API has no `at` option), and no self-check here depends on
 *      those timestamps. Hand-counted outcomes, from the fixture
 *      composition and the transition table (EXPIRE edges exist only
 *      on OPEN / ACCEPTED / CAPTURING / SUBMITTED; ABANDON edges
 *      only on ACCEPTED / CAPTURING): expire attempts the 4 overdue
 *      tasks — WD-01 / WD-10 / WD-12 expire, WD-06 (IN_REVIEW) fails
 *      in isolation; stale action attempts the 4 stale tasks — only
 *      WD-04 (ACCEPTED) is abandoned, WD-01 / WD-08 (OPEN) and WD-06
 *      (IN_REVIEW) fail in isolation.
 *
 *  12. payout Retry-After parsing — `parsePayoutRetryAfter(value,
 *      nowMs)` over a fixed 11-value corpus under one injected fixed
 *      `nowMs` (see the retry-after fixture below for the composition
 *      and the hand-written expectation for every value). This is the
 *      pure parsing step every 429 response pays before a delivery
 *      retry can be scheduled: delay-seconds values, HTTP-dates in
 *      the future and the past, signed numbers, garbage, and absent
 *      values, whose outcomes are respectively a wait in
 *      milliseconds, a clamp to 0, or `undefined` (the caller then
 *      falls back to exponential backoff). No network and no wall
 *      clock: `nowMs` is injected, never read.
 *
 *  13. payout mismatch judgement — `payoutMismatch(task)` over a
 *      fixed set of 5 tasks (see the mismatch fixture below for the
 *      five shapes and the hand-written expectation for each). This
 *      is the per-task primitive the batch screening in group 6 is
 *      built on: the call a reconciliation worker makes for one task
 *      at a time, scanning that task's history for its last `ACCEPT`
 *      quote and its `PAYOUT_COMPLETE` settlement. One timed pass is
 *      one full set pass of 5 per-task calls. No network and no
 *      wall clock: every dispatch timestamp is fixed.
 *
 *  14. allowed-events query — `allowedEvents(state)` over a fixed
 *      set of all 13 states (see the allowed-events fixture below
 *      for the hand-written expectation for every state). This is
 *      the primitive a task-list UI and a watchdog check for every
 *      row they render: which events may fire from this state right
 *      now. Its cost was previously invisible inside the dispatch
 *      totals. One timed pass is one full state-set pass of 13
 *      per-state calls; the terminal states (PAID / ABANDONED /
 *      EXPIRED) must return an empty list. No network and no wall
 *      clock.
 *
 *  15. standalone history parsing — `parseHistory(history)` over
 *      the same fixed 8-entry chained history as groups 2 and 5
 *      (see the parse-history fixture below). This is the direct
 *      validation a holder of a bare history array pays:
 *      unknown-field fail-closed checks, gapless `seq`, from/to
 *      chain continuity, and a full hash-chain re-verification —
 *      without the per-line JSON parsing the NDJSON import path
 *      (group 5) bundles into its number. One timed pass is one
 *      parse of the 8-entry history; a detached tampered copy is
 *      rejected once, outside the timed loop. No network and no
 *      wall clock.
 *
 *  16. terminal-state judgement — `isTerminal(state)` over the
 *      fixed set of all 13 states (see the isTerminal fixture below
 *      for the hand-written truth table for every state). This is
 *      the check a watchdog / batch scan pays for every task it
 *      walks: is this task finished, or can it still move. Its
 *      cost was previously invisible inside the watchdog totals.
 *      One timed pass is one full state-set pass of 13 per-state
 *      calls; exactly the terminal states (PAID / ABANDONED /
 *      EXPIRED) must return true. No network and no wall clock.
 *
 *  17. transition-table JSON export — `transitionTableJson()` with
 *      no arguments (see the transition-table JSON fixture below).
 *      This is the export a frontend / documentation tool pays to
 *      consume the state machine: a full enumeration of every
 *      transition edge, serialized as canonical JSON (declaration
 *      order, 2-space indent, trailing newline). Its cost was
 *      previously invisible inside the diagram / snapshot totals.
 *      One timed pass is one full export call; the output must
 *      parse back to exactly the 19 edges pinned by the committed
 *      snapshot, with the key edges in place. No network and no
 *      wall clock.
 *
 *  18. state diagram generation — `stateDiagram()` with no
 *      arguments (see the state-diagram fixture below). This is
 *      the rendering a documentation site / tool chain pays every
 *      time it renders the docs: a full enumeration of every
 *      transition edge plus Mermaid text assembly into a
 *      stateDiagram-v2 block (the block the README embeds verbatim,
 *      guarded against drift by test/stateDiagram.test.ts). Its
 *      cost was previously invisible inside the snapshot totals.
 *      One timed pass is one full render call; the output must
 *      contain every state, exactly the 19 edges pinned by the
 *      committed transition-table snapshot, and the hand-pinned
 *      first / last lines. No network and no wall clock.
 *
 *  19. README diagram sync check — `readmeDiagramInSync()` with
 *      no arguments (see the sync-check fixture below), imported
 *      directly from src/diagram.ts (it is not re-exported from
 *      src/index.ts). This is the check a documentation CI pays
 *      on every run: read this repo's own README.md from disk,
 *      and confirm it embeds the exact diagram block generated
 *      from the transition table at module load. Its cost was
 *      previously invisible inside the test-suite totals. One
 *      timed pass is one full check call, whose return value
 *      must be the hand-written in-sync expectation (true — the
 *      state the test suite pins: test/diagram.test.ts runs the
 *      CLI `--check` form and test/stateDiagram.test.ts asserts
 *      the README embeds the generated diagram). The only file
 *      read is this repo's README.md; no network, no randomness,
 *      and no wall clock.
 *
 *  20. SLA overdue judgement — `isOverdue(task, now)` over a
 *      fixed corpus of 4 tasks (see the isOverdue fixture below)
 *      under one injected fixed `now`. This is the per-task
 *      primitive the watchdog screening in group 10 is built
 *      on: the call a watchdog makes for one task at a time
 *      before it may dispatch EXPIRE. One timed pass is one
 *      full corpus pass of 4 per-task calls; the hand-written
 *      expectations pin the inclusive boundary (a task whose
 *      deadline is exactly `now` is overdue). No network and
 *      no wall clock: `now` is injected, never read.
 *
 *  21. dispatch subscription notification — `subscribe()` with
 *      one fixed collecting listener on a fresh task, driven
 *      through the same fixed full DRAFT -> PAID lifecycle as
 *      group 1 (see the subscribe fixture below). This is the
 *      in-process fan-out every successful dispatch pays after
 *      its audit entry is appended: listeners run in
 *      subscription order, and a throwing listener is isolated
 *      (the dispatch still succeeds and its peers still run).
 *      One timed pass is one full subscribed lifecycle of 8
 *      dispatches + 8 notifications; its per-iteration
 *      self-check pins the notification sequence to the
 *      hand-written (event, from, to) expectations and to the
 *      task's own history, entry for entry. Outside the timed
 *      loop, an unsubscribe check pins that a further dispatch
 *      notifies nobody, and an isolation check pins that a
 *      throwing listener neither breaks a dispatch nor starves
 *      its peer. No network, no randomness, and no wall
 *      clock: every dispatch timestamp is fixed.
 *
 *  22. JSON snapshot round-trip — `toJSON()` +
 *      `TaskLifecycle.fromJSON(snapshot)` over the fixed
 *      full-lifecycle task (see the snapshot fixture below).
 *      This is the persistence path every restart pays: export
 *      the live task as a plain JSON snapshot envelope (schema
 *      version, state, full history, SLA deadlines), then
 *      rehydrate it through the strict untrusted-snapshot
 *      reader (envelope validation, seq / from-to chain,
 *      hash-chain re-verification, used-budget re-derivation
 *      from the history). One timed pass is one export + one
 *      rehydration of the 8-entry snapshot; its per-iteration
 *      self-check pins the restored state, the full history
 *      entry for entry, the history-derived used RESUBMIT /
 *      DISPUTE counts, and the re-export fixed point to the
 *      hand-written expectations. Outside the timed loop, a
 *      JSON text round-trip (stringify / parse) pins that the
 *      persisted text form restores identically, and two
 *      detached tampered copies pin the reader's rejection
 *      side: a `v: 2` envelope is rejected with the version
 *      error and an envelope carrying one extra top-level
 *      field is rejected with the unknown-field error. No
 *      network, no randomness, and no wall clock: every
 *      dispatch timestamp is fixed.
 *
 *  23. SLA deadline read — `getSlaDeadline(state)` over all
 *      13 states on one fixed task (see the getSlaDeadline
 *      fixture below). This is the read a watchdog pays on
 *      every poll tick before it may judge overdue: look up
 *      the deadline attached to a state, or `undefined` when
 *      none is set. Its cost was previously invisible inside
 *      the watchdog / isOverdue totals (those paths call it
 *      internally for one state at a time). One timed pass
 *      is one full state-set pass of 13 per-state calls on a
 *      task carrying deadlines for exactly two states; the
 *      other eleven states must read back `undefined`, and
 *      the no-argument form must read back the current
 *      state's deadline. Outside the timed loop, an
 *      exhaustive check on a separate probe task pins that
 *      overwriting a deadline reads back the new value and
 *      leaves the timed fixture untouched. No network, no
 *      randomness, and no wall clock: every dispatch
 *      timestamp and every deadline is fixed.
 *
 *  24. dispatch note length guard — the `MAX_NOTE_LENGTH`
 *      boundary in `dispatch()` over a fixed 2-case corpus
 *      (see the note-length fixture below). This is the
 *      audit-history anti-inflation guard every dispatch
 *      pays: a note is written verbatim into the append-only
 *      history and serialized by every export, so a note
 *      longer than the limit is rejected before anything
 *      mutates. Its cost was previously invisible inside the
 *      dispatch totals. One timed pass is one full corpus
 *      pass of 2 dispatch attempts on fresh tasks (one
 *      accepted at exactly the limit, one rejected one
 *      character over); its per-iteration self-check pins
 *      the accepted task's state and stored note length and
 *      the rejected task's untouched state and history to
 *      the hand-written expectations, and the notes are
 *      presented only by length, never printed. No network,
 *      no randomness, and no wall clock: every dispatch
 *      timestamp is fixed.
 *
 *  25. SLA deadline write — `setSlaDeadline(deadline)` /
 *      `clearSlaDeadline(state)` over one fixed OPEN task (see
 *      the set/clear fixture below). This is the write side of
 *      group 23's read: the renegotiation a watchdog operator
 *      pays whenever a deadline is granted, extended, or
 *      revoked. Its cost was previously invisible inside the
 *      watchdog / isOverdue totals (those paths only read).
 *      One timed pass is one full write cycle on the shared
 *      fixture task: set the current (OPEN) state's deadline,
 *      overwrite it, then clear it — the clear restores the
 *      fixture's initial no-deadline state, so the same task
 *      serves every iteration. Its per-iteration self-check
 *      pins every read-back to the hand-written expectations
 *      and pins that the writes never move the task or append
 *      history (deadlines are configuration, not a dispatch).
 *      Outside the timed loop, exhaustive checks pin the
 *      per-state / clear-all forms, the normalized-ISO storage
 *      of a non-ISO parseable input, the one rejection the
 *      setter actually has (an unparseable deadline, with its
 *      hand-pinned message, leaving the stored value
 *      untouched), and that setting a deadline on a terminal
 *      (ABANDONED) task is stored, not rejected — the setter
 *      has no state guard. No network, no randomness, and no
 *      wall clock: every dispatch timestamp and every deadline
 *      is fixed.
 *
 *  26. single-step transition dispatch — `benchTransition`:
 *      one legal step (`ACCEPT`) dispatched on a task restored
 *      from the same fixed OPEN snapshot (one PUBLISH entry at
 *      the fixed base instant) on every iteration (see the
 *      single-step transition fixture below). This is the
 *      steady-state cost of a single dispatch — restore plus
 *      one hash-chained audit append — that the full-lifecycle
 *      row (group 1) only reports as an 8-step aggregate, so a
 *      per-step regression could previously hide inside the
 *      lifecycle average. The restore cost is inside the timed
 *      region (dispatch mutates the task, so no instance can
 *      be reused), the same accounting the watchdog-execution
 *      rows use. Every timed iteration checks the state
 *      advanced exactly one step (OPEN -> ACCEPTED), the
 *      history grew by exactly one entry, and the appended
 *      entry's seq continues the snapshot's seq with no gap.
 *      Outside the timed loop, an exhaustive pure-`transition()`
 *      check pins every state/event pair: the 19 legal edges
 *      return their hand-pinned target and every other pair
 *      throws the exact message `invalid transition: <event>
 *      from <state>` — including the one-step illegal dispatch
 *      PAYOUT_COMPLETE from OPEN, whose rejection through
 *      `TaskLifecycle.dispatch` is pinned with that same exact
 *      message and leaves the restored task untouched. No
 *      network, no randomness, and no wall clock: every
 *      dispatch timestamp is fixed.
 *
 *  27. transition-table pure object construction —
 *      `transitionTable()` with no arguments (see the
 *      transition-table fixture below). This is the plain-object
 *      edge list in declaration order, without any serialization,
 *      that the JSON export (group 17) and the diagram (group 18)
 *      both derive from: the enumeration a state-machine consumer
 *      pays when it wants the edges as objects rather than text.
 *      Its cost was previously invisible inside the JSON row's
 *      construction-plus-serialization total, so a pure
 *      construction regression could previously hide inside the
 *      serialization share. One timed pass is one full
 *      construction call; the output must equal exactly the 19
 *      edges pinned by the committed snapshot, written out in
 *      full in declaration order. No network and no wall clock.
 *
 *  28. single-target payout webhook delivery —
 *      `deliverPayoutWebhook(url, webhook)` delivering the
 *      module-scope signed webhook to one fixed endpoint
 *      through an injected fake `fetchImpl` that answers 200
 *      immediately, with `backoffMs` 0 and an injected no-op
 *      `sleepImpl` (see the single-delivery fixture below).
 *      This is the steady-state cost of one signed POST — the
 *      single-target path under the fan-out wrapper (group 7),
 *      previously visible only inside the 4-endpoint fan-out
 *      numbers. Every timed iteration checks the result is
 *      `{ ok: true, attempts: 1, status: 200 }`, exactly one
 *      captured call went to the pinned URL, and its body is
 *      byte-identical to the signed body and its
 *      `X-Hub-Signature-256` equals the
 *      `buildPayoutWebhook` product's signature and verifies
 *      over the captured body. Outside the timed loop, a
 *      persistent-500 script is pinned to the reported (never
 *      thrown) exhaustion shape `{ ok: false, attempts: 3,
 *      status: 500, error: "server responded with status
 *      500" }` after exactly 3 captured calls (the default
 *      `maxAttempts`, with the no-op sleep standing in for
 *      the backoff waits). Zero network, zero randomness,
 *      and no real waiting.
 *
 *  29. subscribe onError error routing — `subscribe()` with
 *      one fixed throwing listener and a collecting `onError`
 *      hook on a fresh task, driven through the same fixed
 *      full DRAFT -> PAID lifecycle as group 1 (see the
 *      subscribe onError fixture below). This is the
 *      failure-visibility side of group 21: every notification
 *      throws, every throw is routed to `onError` with the
 *      dispatch context, and dispatch itself never fails.
 *      One timed pass is one full subscribed lifecycle of 8
 *      dispatches + 8 routed error reports; its per-iteration
 *      self-check pins that every dispatch succeeded, the
 *      history count and the report count both equal the
 *      dispatch count (8), and the first report's message and
 *      context match the hand-written expectations. Outside
 *      the timed loop, a probe pins that a throwing `onError`
 *      is swallowed too, and the non-function `onError`
 *      rejection is pinned to its exact message. No network,
 *      no randomness, and no wall clock: every dispatch
 *      timestamp is fixed.
 *
 *  30. payout event dedupe snapshot export —
 *      `PayoutEventDedupe.exportSnapshot()` on a fixed dedupe
 *      (see the dedupe export fixture below): 6 ids recorded
 *      under an injectable clock that advances only during
 *      fixture construction, with a 60-second TTL — the first
 *      id recorded exactly one TTL before the export instant,
 *      so it is expired at export time, and 5 later ids with
 *      staggered first-seen times all still live. This is the
 *      export direction the receiver pays before every restart
 *      (filter the expired entries against its own clock and
 *      build the detached `{ v: 1, entries }` copy), previously
 *      visible only as an incidental fixture construction for
 *      the restore path (group 8). One timed pass is one full
 *      export call; its per-iteration self-check pins the
 *      snapshot to the hand-written expectations (v is 1,
 *      exactly the 5 live entries in recorded order, first and
 *      last entries pinned in full, the expired id absent).
 *      Outside the timed loop, a mutated detached copy is
 *      pinned to leave a re-export unchanged, and an empty
 *      dedupe is pinned to export `{ v: 1, entries: [] }`.
 *      No network, no randomness, and no wall clock after
 *      fixture construction: the export clock is fixed.
 *
 *  31. payout event dedupe clear —
 *      `PayoutEventDedupe.clear()` on a fresh dedupe rebuilt
 *      on every iteration (see the dedupe clear fixture
 *      below): 1,000 fixed ids recorded under an injected
 *      fixed clock, plus one duplicate hit on the first id,
 *      so the counters about to be zeroed are non-trivial
 *      (`{ size: 1,000, hits: 1, misses: 1,000, evictions: 0 }`).
 *      This is the window-reset path a receiver pays on key
 *      rotation, for test isolation, or for a deliberate
 *      dedupe-window reset: drop every tracked id and zero
 *      all three observability counters in one call. `clear()`
 *      mutates the store, so no instance can be reused — every
 *      timed iteration rebuilds the whole fixture first, and
 *      the reported numbers therefore include the fixture-
 *      rebuild cost (prefill plus clear), a conservative floor
 *      for the pure clear cost, not the pure cost itself (the
 *      same accounting the watchdog-execution rows use). One
 *      timed pass is one rebuild + one clear + the post-clear
 *      self-checks; its per-iteration self-check pins the size
 *      and every counter at zero right after the clear, and
 *      pins that the first id records as a new event again
 *      (counters re-accumulating from zero). Outside the timed
 *      loop, clearing an empty dedupe is pinned as a harmless
 *      no-op. No network, no randomness, and no wall clock:
 *      the clear clock is fixed.
 *
 *  32. payout event dedupe stats —
 *      `PayoutEventDedupe.stats()` on a fixed dedupe
 *      (see the dedupe stats fixture below): 7 ids recorded
 *      under an injectable clock that advances only during
 *      fixture construction, with a 60-second TTL and a
 *      capacity of 6 — one id is LRU-evicted during
 *      construction, one id sits expired in the map at the
 *      stats instant, and 5 ids are live, with the counters
 *      pinned at 1 hit / 7 misses / 1 eviction from the
 *      construction script. This is the observability
 *      snapshot a receiver's monitoring polls on every tick:
 *      traverse the map counting only the live entries
 *      against the store's own clock, then copy the three
 *      counters into a detached object. Its cost was
 *      previously invisible inside the checkAndRecord /
 *      restore rows (those paths read `stats()` only as a
 *      fixture self-check, never as the timed object). One
 *      timed pass is one full `stats()` call; its
 *      per-iteration self-check pins the snapshot to the
 *      hand-written expectation (`{ size: 5, hits: 1,
 *      misses: 7, evictions: 1 }` — size counts only the
 *      live ids, so the expired id still sitting in the map
 *      is excluded). Outside the timed loop, a mutated
 *      detached snapshot is pinned to leave a re-read
 *      unchanged, and an empty dedupe is pinned to report
 *      all-zero stats. No network, no randomness, and no
 *      wall clock after fixture construction: the stats
 *      clock is fixed.
 *
 * Fixtures are fully deterministic: fixed task id, actors, timestamps
 * (a fixed base instant plus per-step offsets), webhook secret, payload
 * timestamp and eventId. Nothing here reads the network, a random
 * source, or the wall clock for fixture data — only the timing loop
 * itself uses `process.hrtime`. Numbers vary with hardware — do not
 * treat them as guaranteed throughput.
 *
 * Run: `npm run bench`
 */
import { cpus } from "node:os";
import {
  actOnStaleTasks,
  allowedEvents,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  deliverPayoutWebhook,
  deliverPayoutWebhookToMany,
  expiredTasks,
  expireOverdueTasks,
  GENESIS_PREV_HASH,
  historyFromNdjson,
  MAX_NOTE_LENGTH,
  historyToNdjson,
  isOverdue,
  isTerminal,
  mismatchedPayouts,
  parseHistory,
  parsePayoutRetryAfter,
  payoutMismatch,
  PayoutEventDedupe,
  replay,
  staleTasks,
  stateDiagram,
  TaskLifecycle,
  totalPaidOut,
  transition,
  transitionTable,
  transitionTableJson,
  unreconciledPayouts,
  verifyHistoryChain,
  verifyPayoutWebhook,
  type ListenerErrorContext,
  type PayoutMismatch,
  type PayoutWebhookEndpoint,
  type PayoutWebhookFetchImpl,
  type SubscribeOptions,
  type TaskEvent,
  type TaskHistoryEntry,
  type TaskSnapshot,
  type TaskState,
  type TransitionEdge,
} from "../src/index.js";
import { readmeDiagramInSync } from "../src/diagram.js";

const ITERATIONS = 3000;
const WARMUP = 200;

/** Fixed base instant for every dispatch timestamp (deterministic). */
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const WEBHOOK_SECRET = "bench-webhook-secret";
const WEBHOOK_NOW = new Date(BASE_MS + 60_000);
const WEBHOOK_EVENT_ID = "bench-event-001";

const LIFECYCLE: Array<{
  event: TaskEvent;
  actor: string;
  extra?: { quotedAmount?: number; payoutRef?: string; payoutAmount?: number };
}> = [
  { event: "PUBLISH", actor: "researcher" },
  { event: "ACCEPT", actor: "contributor", extra: { quotedAmount: 125 } },
  { event: "START_CAPTURE", actor: "contributor" },
  { event: "SUBMIT", actor: "contributor" },
  { event: "BEGIN_REVIEW", actor: "reviewer" },
  { event: "APPROVE", actor: "reviewer" },
  { event: "REQUEST_PAYOUT", actor: "contributor" },
  {
    event: "PAYOUT_COMPLETE",
    actor: "system",
    extra: { payoutRef: "bench-pay-001", payoutAmount: 125 },
  },
];

/** One full deterministic DRAFT -> PAID lifecycle on a fresh task. */
function runLifecycle(): TaskLifecycle {
  const task = new TaskLifecycle("BENCH-001");
  LIFECYCLE.forEach(({ event, actor, extra }, i) => {
    task.dispatch(event, {
      actor,
      at: new Date(BASE_MS + i * 1000).toISOString(),
      ...extra,
    });
  });
  return task;
}

/**
 * One deterministic PAID task with a caller-chosen quote, settled
 * amount, and optional payout reference — the building block of the
 * reconciliation-screening batch below. Same lifecycle shape, actors,
 * and per-step timestamp offsets as `runLifecycle()`; only the task id
 * and the ACCEPT / PAYOUT_COMPLETE amounts and ref vary.
 */
function buildPaidTask(
  id: string,
  opts: { quotedAmount: number; payoutAmount: number; payoutRef?: string },
): TaskLifecycle {
  const task = new TaskLifecycle(id);
  LIFECYCLE.forEach(({ event, actor }, i) => {
    const extra: {
      quotedAmount?: number;
      payoutRef?: string;
      payoutAmount?: number;
    } = {};
    if (event === "ACCEPT") extra.quotedAmount = opts.quotedAmount;
    if (event === "PAYOUT_COMPLETE") {
      extra.payoutAmount = opts.payoutAmount;
      if (opts.payoutRef !== undefined) extra.payoutRef = opts.payoutRef;
    }
    task.dispatch(event, {
      actor,
      at: new Date(BASE_MS + i * 1000).toISOString(),
      ...extra,
    });
  });
  return task;
}

function measure(fn: () => void, iterations: number): number {
  for (let i = 0; i < WARMUP; i++) fn(); // warmup: JIT, module caches
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  return iterations / elapsedSec;
}

async function measureAsync(
  fn: () => Promise<void>,
  iterations: number,
): Promise<number> {
  for (let i = 0; i < WARMUP; i++) await fn(); // warmup: JIT, module caches
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  return iterations / elapsedSec;
}

function fmt(ops: number): string {
  const s =
    ops >= 1000
      ? ops.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : ops.toFixed(1);
  const perOpUs = (1e6 / ops).toFixed(2);
  return `${s} ops/sec (${perOpUs} µs/op)`;
}

// ---------------------------------------------------------------------
// Deterministic fixtures, built once outside the timed loops.
// ---------------------------------------------------------------------
const paidTask = runLifecycle();
if (paidTask.state !== "PAID" || paidTask.history.length !== 8) {
  throw new Error("benchmark fixture failed: lifecycle did not reach PAID");
}
// Detached plain copies, exactly what a persisted audit log looks like.
const historyFixture: TaskHistoryEntry[] = paidTask.history.map((e) => ({
  ...e,
}));
if (!verifyHistoryChain(historyFixture)) {
  throw new Error("benchmark fixture failed: history chain does not verify");
}
const webhook = buildPayoutWebhook(paidTask, WEBHOOK_SECRET, {
  now: WEBHOOK_NOW,
  eventId: WEBHOOK_EVENT_ID,
});
const webhookBody = JSON.stringify(webhook.payload);
if (!verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET)) {
  throw new Error("benchmark fixture failed: webhook does not verify");
}
const ndjsonFixture = historyToNdjson(historyFixture);
const ndjsonRoundTrip = historyFromNdjson(ndjsonFixture);
// parseHistory returns entries in canonical key order, so compare the
// round-trip through the canonical serializer rather than raw stringify.
if (
  ndjsonRoundTrip.length !== 8 ||
  historyToNdjson(ndjsonRoundTrip) !== ndjsonFixture
) {
  throw new Error("benchmark fixture failed: NDJSON round-trip mismatch");
}

// Reconciliation-screening batch: 12 PAID tasks in three hand-counted
// categories (every task carries the full 8-entry history):
//   - 4 settled exactly as quoted, WITH a payoutRef
//       -> selected by neither screening helper;
//   - 4 settled for a different amount than quoted, WITH a payoutRef
//       -> selected by mismatchedPayouts only;
//   - 2 settled exactly as quoted, WITHOUT a payoutRef, plus
//     2 settled for a different amount, WITHOUT a payoutRef
//       -> the no-ref pair settled exactly is selected by
//          unreconciledPayouts only; the no-ref mismatched pair is
//          selected by both.
// Hand-computed expectations: mismatchedPayouts selects 6 tasks,
// unreconciledPayouts selects 4 tasks, in batch order.
const screeningBatch: TaskLifecycle[] = [
  buildPaidTask("BENCH-SCR-01", { quotedAmount: 100, payoutAmount: 100, payoutRef: "bench-pay-scr-01" }),
  buildPaidTask("BENCH-SCR-02", { quotedAmount: 100, payoutAmount: 80, payoutRef: "bench-pay-scr-02" }),
  buildPaidTask("BENCH-SCR-03", { quotedAmount: 150, payoutAmount: 150 }),
  buildPaidTask("BENCH-SCR-04", { quotedAmount: 200, payoutAmount: 200, payoutRef: "bench-pay-scr-04" }),
  buildPaidTask("BENCH-SCR-05", { quotedAmount: 120, payoutAmount: 132, payoutRef: "bench-pay-scr-05" }),
  buildPaidTask("BENCH-SCR-06", { quotedAmount: 90, payoutAmount: 75 }),
  buildPaidTask("BENCH-SCR-07", { quotedAmount: 300, payoutAmount: 300, payoutRef: "bench-pay-scr-07" }),
  buildPaidTask("BENCH-SCR-08", { quotedAmount: 250, payoutAmount: 200, payoutRef: "bench-pay-scr-08" }),
  buildPaidTask("BENCH-SCR-09", { quotedAmount: 175, payoutAmount: 175 }),
  buildPaidTask("BENCH-SCR-10", { quotedAmount: 80, payoutAmount: 80, payoutRef: "bench-pay-scr-10" }),
  buildPaidTask("BENCH-SCR-11", { quotedAmount: 400, payoutAmount: 440, payoutRef: "bench-pay-scr-11" }),
  buildPaidTask("BENCH-SCR-12", { quotedAmount: 60, payoutAmount: 54 }),
];
if (
  screeningBatch.length !== 12 ||
  screeningBatch.some((t) => t.state !== "PAID" || t.history.length !== 8)
) {
  throw new Error("benchmark fixture failed: screening batch shape");
}
const expectedMismatchedIds = [
  "BENCH-SCR-02",
  "BENCH-SCR-05",
  "BENCH-SCR-06",
  "BENCH-SCR-08",
  "BENCH-SCR-11",
  "BENCH-SCR-12",
];
const expectedUnreconciledIds = [
  "BENCH-SCR-03",
  "BENCH-SCR-06",
  "BENCH-SCR-09",
  "BENCH-SCR-12",
];
const expectedMismatched = mismatchedPayouts(screeningBatch);
const expectedUnreconciled = unreconciledPayouts(screeningBatch);
if (
  expectedMismatched.map((t) => t.id).join(",") !==
    expectedMismatchedIds.join(",") ||
  expectedUnreconciled.map((t) => t.id).join(",") !==
    expectedUnreconciledIds.join(",")
) {
  throw new Error(
    "benchmark fixture failed: screening counts differ from the hand-computed expectations",
  );
}
// Hand-computed totalPaidOut expectation: it sums every task's
// recorded payoutAmount (all 12 are PAID and carry one):
// 100 + 80 + 150 + 200 + 132 + 75 + 300 + 200 + 175 + 80 + 440 + 54
// = 1986. The expectation is written out by hand here — it is never
// derived by calling totalPaidOut itself.
const expectedTotalPaidOut = 1986;
if (totalPaidOut(screeningBatch) !== expectedTotalPaidOut) {
  throw new Error(
    "benchmark fixture failed: totalPaidOut differs from the hand-computed expectation",
  );
}

// Watchdog-screening batch: 12 tasks in mixed states, built with
// fixed dispatch timestamps relative to BASE_MS (DAY = 86,400,000 ms).
// The screening instant and budgets are fixed:
//   WATCHDOG_NOW = BASE + 40 days (2026-02-10T00:00:00.000Z)
//   maxAgeByState = { OPEN: 30 days, ACCEPTED: 7 days, IN_REVIEW: 7 days }
// Per-task composition (deadline = SLA deadline on the CURRENT state;
// dwell = WATCHDOG_NOW minus the last history entry's timestamp):
//   WD-01 OPEN,      entered BASE+0d,  deadline BASE+10d (past)
//                    -> expired YES; dwell 40d > 30d -> stale YES
//   WD-02 OPEN,      entered BASE+35d, deadline BASE+50d (future)
//                    -> expired no;  dwell 5d <= 30d -> stale no
//   WD-03 PAID (terminal, full lifecycle), deadline on PAID BASE+10d
//                    -> expired no (terminal); stale no (terminal)
//   WD-04 ACCEPTED,  entered BASE+1d,  NO deadline
//                    -> expired no;  dwell 39d > 7d -> stale YES
//   WD-05 ACCEPTED,  entered BASE+38d, NO deadline
//                    -> expired no;  dwell 2d <= 7d -> stale no
//   WD-06 IN_REVIEW, entered BASE+2d,  deadline BASE+20d (past)
//                    -> expired YES; dwell 38d > 7d -> stale YES
//   WD-07 IN_REVIEW, entered BASE+39d, deadline BASE+60d (future)
//                    -> expired no;  dwell 1d <= 7d -> stale no
//   WD-08 OPEN,      entered BASE+5d,  NO deadline
//                    -> expired no;  dwell 35d > 30d -> stale YES
//   WD-09 DRAFT,     no history, NO deadline
//                    -> expired no;  stale no (no measurable dwell)
//   WD-10 CAPTURING, entered BASE+3d,  deadline BASE+15d (past)
//                    -> expired YES; stale no (CAPTURING has no budget)
//   WD-11 SUBMITTED, entered BASE+36d, deadline BASE+50d (future)
//                    -> expired no;  stale no (SUBMITTED has no budget)
//   WD-12 OPEN,      entered BASE+10d, deadline exactly WATCHDOG_NOW
//                    -> expired YES (isOverdue is >= the deadline);
//                       dwell exactly 30d -> stale no (stale is
//                       strictly > the budget)
// Hand-computed expectations, in batch order — written out here from
// the composition above, never derived by calling the helpers:
//   expiredTasks selects 4: WD-01, WD-06, WD-10, WD-12
//   staleTasks   selects 4: WD-01, WD-04, WD-06, WD-08
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WATCHDOG_NOW = new Date(BASE_MS + 40 * DAY_MS);
const WATCHDOG_MAX_AGE = {
  OPEN: 30 * DAY_MS,
  ACCEPTED: 7 * DAY_MS,
  IN_REVIEW: 7 * DAY_MS,
};
function buildWatchdogTask(
  id: string,
  steps: Array<{ event: TaskEvent; actor: string; atMs: number }>,
  deadline?: { state: Parameters<TaskLifecycle["setSlaDeadline"]>[1]; atMs: number },
): TaskLifecycle {
  const task = new TaskLifecycle(id);
  for (const step of steps) {
    task.dispatch(step.event, {
      actor: step.actor,
      at: new Date(step.atMs).toISOString(),
    });
  }
  if (deadline !== undefined) {
    task.setSlaDeadline(new Date(deadline.atMs), deadline.state);
  }
  return task;
}
// The batch is built by a factory, not once at module scope: the
// watchdog EXECUTOR paths (group 11) dispatch on the tasks they act
// on, so every timed iteration needs a fresh, unmutated copy. The
// screening paths keep using the single module-scope instance below.
function buildWatchdogBatch(): TaskLifecycle[] {
  const watchdogPaidTask = buildPaidTask("BENCH-WD-03", {
    quotedAmount: 100,
    payoutAmount: 100,
    payoutRef: "bench-pay-wd-03",
  });
  watchdogPaidTask.setSlaDeadline(new Date(BASE_MS + 10 * DAY_MS), "PAID");
  return [
    buildWatchdogTask("BENCH-WD-01", [
      { event: "PUBLISH", actor: "researcher", atMs: BASE_MS },
    ], { state: "OPEN", atMs: BASE_MS + 10 * DAY_MS }),
    buildWatchdogTask("BENCH-WD-02", [
      { event: "PUBLISH", actor: "researcher", atMs: BASE_MS + 35 * DAY_MS },
    ], { state: "OPEN", atMs: BASE_MS + 50 * DAY_MS }),
    watchdogPaidTask,
    buildWatchdogTask("BENCH-WD-04", [
      { event: "PUBLISH", actor: "researcher", atMs: BASE_MS },
      { event: "ACCEPT", actor: "contributor", atMs: BASE_MS + 1 * DAY_MS },
    ]),
    buildWatchdogTask("BENCH-WD-05", [
      { event: "PUBLISH", actor: "researcher", atMs: BASE_MS + 37 * DAY_MS },
      { event: "ACCEPT", actor: "contributor", atMs: BASE_MS + 38 * DAY_MS },
    ]),
    buildWatchdogTask("BENCH-WD-06", [
      { event: "PUBLISH", actor: "researcher", atMs: BASE_MS },
      { event: "ACCEPT", actor: "contributor", atMs: BASE_MS + 1 * HOUR_MS },
      { event: "START_CAPTURE", actor: "contributor", atMs: BASE_MS + 2 * HOUR_MS },
      { event: "SUBMIT", actor: "contributor", atMs: BASE_MS + 3 * HOUR_MS },
      { event: "BEGIN_REVIEW", actor: "reviewer", atMs: BASE_MS + 2 * DAY_MS },
    ], { state: "IN_REVIEW", atMs: BASE_MS + 20 * DAY_MS }),
    buildWatchdogTask("BENCH-WD-07", [
      { event: "PUBLISH", actor: "researcher", atMs: BASE_MS + 38 * DAY_MS },
      { event: "ACCEPT", actor: "contributor", atMs: BASE_MS + 38 * DAY_MS + 1 * HOUR_MS },
      { event: "START_CAPTURE", actor: "contributor", atMs: BASE_MS + 38 * DAY_MS + 2 * HOUR_MS },
      { event: "SUBMIT", actor: "contributor", atMs: BASE_MS + 38 * DAY_MS + 3 * HOUR_MS },
      { event: "BEGIN_REVIEW", actor: "reviewer", atMs: BASE_MS + 39 * DAY_MS },
    ], { state: "IN_REVIEW", atMs: BASE_MS + 60 * DAY_MS }),
    buildWatchdogTask("BENCH-WD-08", [
      { event: "PUBLISH", actor: "researcher", atMs: BASE_MS + 5 * DAY_MS },
    ]),
    buildWatchdogTask("BENCH-WD-09", []),
    buildWatchdogTask("BENCH-WD-10", [
      { event: "PUBLISH", actor: "researcher", atMs: BASE_MS + 1 * DAY_MS },
      { event: "ACCEPT", actor: "contributor", atMs: BASE_MS + 2 * DAY_MS },
      { event: "START_CAPTURE", actor: "contributor", atMs: BASE_MS + 3 * DAY_MS },
    ], { state: "CAPTURING", atMs: BASE_MS + 15 * DAY_MS }),
    buildWatchdogTask("BENCH-WD-11", [
      { event: "PUBLISH", actor: "researcher", atMs: BASE_MS + 33 * DAY_MS },
      { event: "ACCEPT", actor: "contributor", atMs: BASE_MS + 34 * DAY_MS },
      { event: "START_CAPTURE", actor: "contributor", atMs: BASE_MS + 35 * DAY_MS },
      { event: "SUBMIT", actor: "contributor", atMs: BASE_MS + 36 * DAY_MS },
    ], { state: "SUBMITTED", atMs: BASE_MS + 50 * DAY_MS }),
    buildWatchdogTask("BENCH-WD-12", [
      { event: "PUBLISH", actor: "researcher", atMs: BASE_MS + 10 * DAY_MS },
    ], { state: "OPEN", atMs: BASE_MS + 40 * DAY_MS }),
  ];
}
const watchdogBatch: TaskLifecycle[] = buildWatchdogBatch();
const expectedWatchdogStates = [
  "OPEN", "OPEN", "PAID", "ACCEPTED", "ACCEPTED", "IN_REVIEW",
  "IN_REVIEW", "OPEN", "DRAFT", "CAPTURING", "SUBMITTED", "OPEN",
];
if (
  watchdogBatch.length !== 12 ||
  watchdogBatch.some((t, i) => t.state !== expectedWatchdogStates[i])
) {
  throw new Error("benchmark fixture failed: watchdog batch shape");
}
const expectedExpired = [
  watchdogBatch[0],
  watchdogBatch[5],
  watchdogBatch[9],
  watchdogBatch[11],
];
const expectedStale = [
  watchdogBatch[0],
  watchdogBatch[3],
  watchdogBatch[5],
  watchdogBatch[7],
];
const expectedExpiredIds = ["BENCH-WD-01", "BENCH-WD-06", "BENCH-WD-10", "BENCH-WD-12"];
const expectedStaleIds = ["BENCH-WD-01", "BENCH-WD-04", "BENCH-WD-06", "BENCH-WD-08"];
if (
  expiredTasks(watchdogBatch, WATCHDOG_NOW).map((t) => t.id).join(",") !==
    expectedExpiredIds.join(",") ||
  staleTasks(watchdogBatch, WATCHDOG_MAX_AGE, WATCHDOG_NOW).map((t) => t.id).join(",") !==
    expectedStaleIds.join(",")
) {
  throw new Error(
    "benchmark fixture failed: watchdog counts differ from the hand-computed expectations",
  );
}

// Watchdog-executor expectations, hand-counted from the fixture
// composition above and the transition table — never derived by
// calling the executors:
//   expireOverdueTasks attempts the 4 overdue tasks in batch order
//   (WD-01 OPEN, WD-06 IN_REVIEW, WD-10 CAPTURING, WD-12 OPEN).
//   EXPIRE has an edge from OPEN and CAPTURING but not IN_REVIEW, so
//   expired = [true, false, true, true], only WD-06 carries an error,
//   and the post-states are EXPIRED / IN_REVIEW / EXPIRED / EXPIRED.
//   actOnStaleTasks with the default ABANDON action attempts the 4
//   stale tasks in batch order (WD-01 OPEN, WD-04 ACCEPTED, WD-06
//   IN_REVIEW, WD-08 OPEN). ABANDON has an edge only from ACCEPTED
//   (and CAPTURING, absent here), so acted = [false, true, false,
//   false], only WD-04 ends ABANDONED, and the other three keep
//   their states and carry the invalid-transition error.
const expectedExpireFlags = [true, false, true, true];
const expectedExpireStates = ["EXPIRED", "IN_REVIEW", "EXPIRED", "EXPIRED"];
const expectedActedFlags = [false, true, false, false];
const expectedActedStates = ["OPEN", "ABANDONED", "IN_REVIEW", "OPEN"];
function checkExpireResults(
  results: ReturnType<typeof expireOverdueTasks>,
  where: string,
): void {
  if (
    results.length !== expectedExpiredIds.length ||
    results.map((r) => r.task.id).join(",") !== expectedExpiredIds.join(",") ||
    results.map((r) => r.expired).join(",") !==
      expectedExpireFlags.join(",") ||
    results.map((r) => r.task.state).join(",") !==
      expectedExpireStates.join(",") ||
    results[0].error !== undefined ||
    !(results[1].error ?? "").includes(
      "invalid transition: EXPIRE from IN_REVIEW",
    ) ||
    results[2].error !== undefined ||
    results[3].error !== undefined
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
function checkStaleResults(
  results: ReturnType<typeof actOnStaleTasks>,
  where: string,
): void {
  if (
    results.length !== expectedStaleIds.length ||
    results.map((r) => r.task.id).join(",") !== expectedStaleIds.join(",") ||
    results.map((r) => r.acted).join(",") !== expectedActedFlags.join(",") ||
    results.map((r) => r.task.state).join(",") !==
      expectedActedStates.join(",") ||
    !(results[0].error ?? "").includes(
      "invalid transition: ABANDON from OPEN",
    ) ||
    results[1].error !== undefined ||
    !(results[2].error ?? "").includes(
      "invalid transition: ABANDON from IN_REVIEW",
    ) ||
    !(results[3].error ?? "").includes(
      "invalid transition: ABANDON from OPEN",
    )
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time executor validation (outside the timed loops), each on a
// throwaway fresh batch so the module-scope screening batch above
// stays unmutated for its own paths.
checkExpireResults(
  expireOverdueTasks(buildWatchdogBatch(), WATCHDOG_NOW),
  "expireOverdueTasks fixture",
);
checkStaleResults(
  actOnStaleTasks(buildWatchdogBatch(), undefined, WATCHDOG_MAX_AGE, WATCHDOG_NOW),
  "actOnStaleTasks fixture",
);

// Fan-out delivery fixture: the same PAID task fanned out to 4 fixed
// endpoints, each with its own signing secret, under the shared fixed
// `WEBHOOK_NOW` / `WEBHOOK_EVENT_ID` above. The injected fetch is fully
// deterministic: it records the calls of the current fan-out, then
// answers 200 immediately — no network, no randomness, no real sleep
// (the injected sleep is a no-op and is never reached on a 200).
const FANOUT_ENDPOINTS: PayoutWebhookEndpoint[] = [
  { url: "https://billing.example.com/hooks/payout", secret: "bench-fanout-secret-billing" },
  { url: "https://risk.example.com/hooks/payout", secret: "bench-fanout-secret-risk" },
  { url: "https://notifications.example.com/hooks/payout", secret: "bench-fanout-secret-notifications" },
  { url: "https://ledger.example.com/hooks/payout", secret: "bench-fanout-secret-ledger" },
];
let fanoutCalls: Array<{ url: string; body: string; signature: string }> = [];
const fanoutFetch: PayoutWebhookFetchImpl = async (url, init) => {
  fanoutCalls.push({
    url,
    body: String(init.body),
    signature: String(new Headers(init.headers).get("x-hub-signature-256")),
  });
  return new Response("{}", { status: 200 });
};
const fanoutNoSleep = async () => {};

async function runFanout() {
  fanoutCalls = [];
  const out = await deliverPayoutWebhookToMany(paidTask, FANOUT_ENDPOINTS, {
    fetchImpl: fanoutFetch,
    sleepImpl: fanoutNoSleep,
    now: WEBHOOK_NOW,
    eventId: WEBHOOK_EVENT_ID,
  });
  if (
    out.results.length !== FANOUT_ENDPOINTS.length ||
    out.delivered !== FANOUT_ENDPOINTS.length ||
    out.failed !== 0 ||
    out.results.some((r) => !r.ok || r.attempts !== 1 || r.status !== 200) ||
    fanoutCalls.length !== FANOUT_ENDPOINTS.length ||
    fanoutCalls.some((c) => c.body !== fanoutCalls[0].body) ||
    JSON.parse(fanoutCalls[0].body).eventId !== WEBHOOK_EVENT_ID
  ) {
    throw new Error("benchmark self-check failed: deliverPayoutWebhookToMany");
  }
  return out;
}

// One-time fixture validation (outside the timed loop): every endpoint
// received a copy signed with its OWN secret.
await runFanout();
for (const [i, endpoint] of FANOUT_ENDPOINTS.entries()) {
  const call = fanoutCalls.find((c) => c.url === endpoint.url);
  if (!call || !verifyPayoutWebhook(call.body, call.signature, endpoint.secret)) {
    throw new Error(
      `benchmark fixture failed: fan-out endpoint ${i} signature does not verify`,
    );
  }
}

// Single-target delivery fixture: the same PAID task's signed
// webhook (`webhook`, built once above via `buildPayoutWebhook`)
// delivered alone to one fixed endpoint through an injected fake
// fetch that records the call and answers 200 immediately — no
// network, no randomness, and no retry sleep is ever reached on a
// 200 (backoffMs 0 and an injected no-op sleep regardless).
const SINGLE_DELIVERY_URL = "https://payout.example.com/hooks/payout";
let singleCalls: Array<{ url: string; body: string; signature: string }> = [];
const singleFetch: PayoutWebhookFetchImpl = async (url, init) => {
  singleCalls.push({
    url,
    body: String(init.body),
    signature: String(new Headers(init.headers).get("x-hub-signature-256")),
  });
  return new Response("{}", { status: 200 });
};
const singleNoSleep = async () => {};

async function runSingleDelivery() {
  singleCalls = [];
  const result = await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
    fetchImpl: singleFetch,
    sleepImpl: singleNoSleep,
    backoffMs: 0,
  });
  if (
    result.ok !== true ||
    result.attempts !== 1 ||
    result.status !== 200 ||
    result.error !== undefined ||
    singleCalls.length !== 1 ||
    singleCalls[0].url !== SINGLE_DELIVERY_URL ||
    singleCalls[0].body !== webhookBody ||
    singleCalls[0].signature !== webhook.signature
  ) {
    throw new Error("benchmark self-check failed: deliverPayoutWebhook");
  }
  return result;
}

// One-time fixture validation (outside the timed loop): the captured
// signature verifies over the captured body under the bench secret.
await runSingleDelivery();
if (
  !verifyPayoutWebhook(singleCalls[0].body, singleCalls[0].signature, WEBHOOK_SECRET)
) {
  throw new Error(
    "benchmark fixture failed: single-target signature does not verify",
  );
}

// Retry-exhaustion check (outside the timed loop, never timed): a
// persistent-500 script under the default maxAttempts (3) with
// backoffMs 0 and the no-op sleep must REPORT — delivery outcomes
// are reported, never thrown in this module — exactly
// { ok: false, attempts: 3, status: 500,
//   error: "server responded with status 500" }
// after exactly 3 captured calls.
{
  let exhaustedCalls = 0;
  const exhaustedFetch: PayoutWebhookFetchImpl = async () => {
    exhaustedCalls++;
    return new Response("boom", { status: 500 });
  };
  const exhausted = await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
    fetchImpl: exhaustedFetch,
    sleepImpl: singleNoSleep,
    backoffMs: 0,
  });
  if (
    exhausted.ok !== false ||
    exhausted.attempts !== 3 ||
    exhausted.status !== 500 ||
    exhausted.error !== "server responded with status 500" ||
    exhaustedCalls !== 3
  ) {
    throw new Error(
      "benchmark fixture failed: deliverPayoutWebhook exhaustion shape",
    );
  }
}

// Dedupe fixture: 1,000 fixed `eventId`s pre-recorded in a
// `PayoutEventDedupe` under an injected FIXED clock — the clock never
// advances, so in the timed loop no entry can expire (default TTL is
// 1 hour) and none is evicted (1,001 live entries, far under the
// default 10,000 cap): the measured path is the pure steady-state
// duplicate hit, LRU recency refresh included. No network, no
// randomness, no wall clock.
const DEDUPE_PREFILL = 1000;
const DEDUPE_NOW_MS = BASE_MS + 120_000;
const dedupeIds: string[] = Array.from(
  { length: DEDUPE_PREFILL },
  (_, i) => `bench-dedupe-${String(i).padStart(4, "0")}`,
);
const dedupe = new PayoutEventDedupe({ now: () => DEDUPE_NOW_MS });
for (const id of dedupeIds) {
  if (dedupe.checkAndRecord(id)) {
    throw new Error("benchmark fixture failed: dedupe prefill saw a duplicate");
  }
}
// Semantics self-checks (outside the timed loop): an already-recorded
// id is a duplicate; an unseen id is admitted on first sight and
// judged a duplicate on the second; and the stats counters agree
// exactly with the calls made so far (1,000 prefill misses, then
// hit + miss + hit, no evictions).
if (!dedupe.checkAndRecord(dedupeIds[0])) {
  throw new Error("benchmark fixture failed: dedupe missed a recorded id");
}
if (dedupe.checkAndRecord("bench-dedupe-unseen")) {
  throw new Error("benchmark fixture failed: dedupe flagged a first sighting");
}
if (!dedupe.checkAndRecord("bench-dedupe-unseen")) {
  throw new Error("benchmark fixture failed: dedupe missed a second sighting");
}
const dedupeStatsFixture = dedupe.stats();
if (
  dedupeStatsFixture.size !== DEDUPE_PREFILL + 1 ||
  dedupeStatsFixture.hits !== 2 ||
  dedupeStatsFixture.misses !== DEDUPE_PREFILL + 1 ||
  dedupeStatsFixture.evictions !== 0
) {
  throw new Error("benchmark fixture failed: dedupe stats do not match calls");
}
let dedupeCursor = 0;

// Dedupe-restore fixture: a 1,000-entry snapshot of a dedupe that
// recorded the fixed ids `bench-restore-0000` ..
// `bench-restore-0999`, in that order, under an injected FIXED clock
// (`DEDUPE_RESTORE_NOW_MS`, a fixed instant after BASE_MS — the
// clock never advances). The snapshot goes through a JSON
// stringify/parse round-trip, exactly the persisted form a receiver
// reloads at startup. Restore runs under the default TTL (1 hour)
// and the default capacity (10,000): every entry was first seen at
// the restore instant itself (age 0), so no entry is expired at
// load and none is evicted for capacity. Hand-written expectations
// — written out here from the composition above, never derived by
// calling `restore` itself:
//   - the snapshot is `{ v: 1, entries }` with exactly 1,000 pairs,
//     in prefill order, each `seenAtMs` exactly
//     DEDUPE_RESTORE_NOW_MS;
//   - a restored dedupe reports size 1,000 with all observability
//     counters at zero (counters are not part of a snapshot);
//   - `checkAndRecord` on every snapshot id is a duplicate (true):
//     1,000 hits in total, the size stays 1,000, and an unseen id is
//     still a first sighting (false) followed by a duplicate (true).
// The exhaustive 1,000-id check runs ONCE, outside the timed loop,
// below; the timed path re-checks the counters and spot-checks the
// first / middle / last ids on every iteration (see
// `benchPayoutEventDedupeRestore`).
const DEDUPE_RESTORE_PREFILL = 1000;
const DEDUPE_RESTORE_NOW_MS = BASE_MS + 180_000;
const dedupeRestoreIds: string[] = Array.from(
  { length: DEDUPE_RESTORE_PREFILL },
  (_, i) => `bench-restore-${String(i).padStart(4, "0")}`,
);
const dedupeRestoreSource = new PayoutEventDedupe({
  now: () => DEDUPE_RESTORE_NOW_MS,
});
for (const id of dedupeRestoreIds) {
  if (dedupeRestoreSource.checkAndRecord(id)) {
    throw new Error(
      "benchmark fixture failed: dedupe restore prefill saw a duplicate",
    );
  }
}
const dedupeRestoreSnapshot = JSON.parse(
  JSON.stringify(dedupeRestoreSource.exportSnapshot()),
) as { v: unknown; entries: Array<[string, number]> };
if (
  dedupeRestoreSnapshot.v !== 1 ||
  !Array.isArray(dedupeRestoreSnapshot.entries) ||
  dedupeRestoreSnapshot.entries.length !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreSnapshot.entries.some(
    (pair, i) =>
      pair[0] !== dedupeRestoreIds[i] || pair[1] !== DEDUPE_RESTORE_NOW_MS,
  )
) {
  throw new Error("benchmark fixture failed: dedupe restore snapshot shape");
}
// Exhaustive validation (outside the timed loop): every snapshot id
// restores as a duplicate, the counts agree exactly with the calls
// made, and an unseen id keeps first-sighting semantics.
const dedupeRestoreProbe = PayoutEventDedupe.restore(dedupeRestoreSnapshot, {
  now: () => DEDUPE_RESTORE_NOW_MS,
});
const dedupeRestoreProbeFresh = dedupeRestoreProbe.stats();
if (
  dedupeRestoreProbeFresh.size !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreProbeFresh.hits !== 0 ||
  dedupeRestoreProbeFresh.misses !== 0 ||
  dedupeRestoreProbeFresh.evictions !== 0
) {
  throw new Error(
    "benchmark fixture failed: restored dedupe counters do not start at zero",
  );
}
for (const id of dedupeRestoreIds) {
  if (!dedupeRestoreProbe.checkAndRecord(id)) {
    throw new Error(
      "benchmark fixture failed: restored dedupe missed a snapshot id",
    );
  }
}
const dedupeRestoreProbeHits = dedupeRestoreProbe.stats();
if (
  dedupeRestoreProbeHits.size !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreProbeHits.hits !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreProbeHits.misses !== 0 ||
  dedupeRestoreProbeHits.evictions !== 0
) {
  throw new Error(
    "benchmark fixture failed: restored dedupe hit count differs from the hand-written expectation",
  );
}
if (dedupeRestoreProbe.checkAndRecord("bench-restore-unseen")) {
  throw new Error(
    "benchmark fixture failed: restored dedupe flagged a first sighting",
  );
}
if (!dedupeRestoreProbe.checkAndRecord("bench-restore-unseen")) {
  throw new Error(
    "benchmark fixture failed: restored dedupe missed a second sighting",
  );
}

// Dedupe-export fixture: 6 fixed `eventId`s recorded in a
// `PayoutEventDedupe` under an injectable clock that advances only
// while the fixture is built (a 60-second TTL throughout):
//   - `bench-export-expired` is recorded at the fixture base
//     instant DEDUPE_EXPORT_BASE_MS;
//   - the clock then advances exactly one TTL (60,000 ms), so at
//     every later instant that first id is expired (age >= TTL —
//     the boundary rule the snapshot tests pin);
//   - 5 live ids `bench-export-live-00` .. `bench-export-live-04`
//     are recorded 1 second apart starting at that instant, so
//     their first-seen times are DEDUPE_EXPORT_BASE_MS + 60,000
//     .. + 64,000 and every one is still live at the export
//     instant (the last live recording instant, where the clock
//     then stays fixed for the whole timed loop).
// Hand-written expectation — written out here from the
// composition above and cross-checked against the
// exportSnapshot tests, never derived by calling
// `exportSnapshot` itself: the export is `{ v: 1, entries }`
// with exactly the 5 live pairs in recorded order and the
// expired id absent.
const DEDUPE_EXPORT_TTL_MS = 60_000;
const DEDUPE_EXPORT_BASE_MS = BASE_MS + 240_000;
const DEDUPE_EXPORT_LIVE_IDS: string[] = Array.from(
  { length: 5 },
  (_, i) => `bench-export-live-${String(i).padStart(2, "0")}`,
);
const DEDUPE_EXPORT_EXPECTED_ENTRIES: Array<[string, number]> =
  DEDUPE_EXPORT_LIVE_IDS.map((id, i) => [
    id,
    DEDUPE_EXPORT_BASE_MS + DEDUPE_EXPORT_TTL_MS + i * 1_000,
  ]);
const DEDUPE_EXPORT_NOW_MS =
  DEDUPE_EXPORT_BASE_MS + DEDUPE_EXPORT_TTL_MS + 4_000;
let dedupeExportClockMs = DEDUPE_EXPORT_BASE_MS;
const dedupeExport = new PayoutEventDedupe({
  ttlMs: DEDUPE_EXPORT_TTL_MS,
  now: () => dedupeExportClockMs,
});
if (dedupeExport.checkAndRecord("bench-export-expired")) {
  throw new Error(
    "benchmark fixture failed: dedupe export prefill saw a duplicate",
  );
}
dedupeExportClockMs += DEDUPE_EXPORT_TTL_MS;
for (const id of DEDUPE_EXPORT_LIVE_IDS) {
  if (dedupeExport.checkAndRecord(id)) {
    throw new Error(
      "benchmark fixture failed: dedupe export prefill saw a duplicate",
    );
  }
  dedupeExportClockMs += 1_000;
}
// The clock advanced 1 second past the last live recording inside
// the loop; step it back to the last live instant and keep it
// fixed there for the timed loop (export instant above).
dedupeExportClockMs = DEDUPE_EXPORT_NOW_MS;
function checkDedupeExportSnapshot(where: string): void {
  const snapshot = dedupeExport.exportSnapshot();
  if (
    snapshot.v !== 1 ||
    snapshot.entries.length !== DEDUPE_EXPORT_EXPECTED_ENTRIES.length ||
    snapshot.entries.some(
      (pair, i) =>
        pair[0] !== DEDUPE_EXPORT_EXPECTED_ENTRIES[i][0] ||
        pair[1] !== DEDUPE_EXPORT_EXPECTED_ENTRIES[i][1],
    ) ||
    snapshot.entries[0][0] !== "bench-export-live-00" ||
    snapshot.entries[0][1] !== DEDUPE_EXPORT_BASE_MS + DEDUPE_EXPORT_TTL_MS ||
    snapshot.entries[snapshot.entries.length - 1][0] !==
      "bench-export-live-04" ||
    snapshot.entries[snapshot.entries.length - 1][1] !==
      DEDUPE_EXPORT_NOW_MS ||
    snapshot.entries.some((pair) => pair[0] === "bench-export-expired")
  ) {
    throw new Error(`benchmark ${where} failed: PayoutEventDedupe exportSnapshot`);
  }
}
// Fixture validation (outside the timed loop): the full export
// matches the hand-written expectation above.
checkDedupeExportSnapshot("fixture");
// Detached-copy check (outside the timed loop): mutating an
// exported snapshot — rewriting its first pair and appending a
// pair — leaves a re-export of the store unchanged.
{
  const detached = dedupeExport.exportSnapshot();
  detached.entries[0][0] = "bench-export-mutated";
  detached.entries[0][1] = 0;
  detached.entries.push(["bench-export-extra", 0]);
  checkDedupeExportSnapshot("fixture");
}
// Empty-store check (outside the timed loop): a dedupe that has
// recorded nothing exports the empty envelope.
{
  const empty = new PayoutEventDedupe({
    ttlMs: DEDUPE_EXPORT_TTL_MS,
    now: () => DEDUPE_EXPORT_NOW_MS,
  });
  const emptySnapshot = empty.exportSnapshot();
  if (
    emptySnapshot.v !== 1 ||
    !Array.isArray(emptySnapshot.entries) ||
    emptySnapshot.entries.length !== 0
  ) {
    throw new Error(
      "benchmark fixture failed: empty dedupe exportSnapshot shape",
    );
  }
}

// Dedupe-clear fixture: 1,000 fixed `eventId`s recorded in a fresh
// `PayoutEventDedupe` under an injected FIXED clock (the clock never
// advances, so no entry expires and none is evicted), plus one
// duplicate hit on the first id. Hand-written expectations — written
// out here from the composition above and cross-checked against the
// dedupe clear test / demo segment, never derived by calling
// `clear()` itself:
//   - before the clear the stats are exactly
//     `{ size: 1,000, hits: 1, misses: 1,000, evictions: 0 }`;
//   - right after `clear()` the size is 0 and the stats are exactly
//     `{ size: 0, hits: 0, misses: 0, evictions: 0 }`;
//   - recording the first id again after the clear is a first
//     sighting (false), and the stats then read exactly
//     `{ size: 1, hits: 0, misses: 1, evictions: 0 }`.
// `clear()` mutates the store, so the fixture is a builder: every
// timed iteration constructs a fresh dedupe, and the reported
// numbers include that rebuild cost (see group 31 above).
const DEDUPE_CLEAR_PREFILL = 1000;
const DEDUPE_CLEAR_NOW_MS = BASE_MS + 300_000;
const dedupeClearIds: string[] = Array.from(
  { length: DEDUPE_CLEAR_PREFILL },
  (_, i) => `bench-clear-${String(i).padStart(4, "0")}`,
);
function buildDedupeClearFixture(): PayoutEventDedupe {
  const fresh = new PayoutEventDedupe({ now: () => DEDUPE_CLEAR_NOW_MS });
  for (const id of dedupeClearIds) {
    if (fresh.checkAndRecord(id)) {
      throw new Error(
        "benchmark fixture failed: dedupe clear prefill saw a duplicate",
      );
    }
  }
  if (!fresh.checkAndRecord(dedupeClearIds[0])) {
    throw new Error(
      "benchmark fixture failed: dedupe clear prefill missed a recorded id",
    );
  }
  const before = fresh.stats();
  if (
    before.size !== DEDUPE_CLEAR_PREFILL ||
    before.hits !== 1 ||
    before.misses !== DEDUPE_CLEAR_PREFILL ||
    before.evictions !== 0
  ) {
    throw new Error(
      "benchmark fixture failed: dedupe clear stats before the clear",
    );
  }
  return fresh;
}
function checkDedupeClear(where: string): void {
  const fresh = buildDedupeClearFixture();
  fresh.clear();
  const afterClear = fresh.stats();
  if (
    fresh.size !== 0 ||
    afterClear.size !== 0 ||
    afterClear.hits !== 0 ||
    afterClear.misses !== 0 ||
    afterClear.evictions !== 0 ||
    fresh.checkAndRecord(dedupeClearIds[0])
  ) {
    throw new Error(`benchmark ${where} failed: PayoutEventDedupe clear`);
  }
  const afterReRecord = fresh.stats();
  if (
    afterReRecord.size !== 1 ||
    afterReRecord.hits !== 0 ||
    afterReRecord.misses !== 1 ||
    afterReRecord.evictions !== 0
  ) {
    throw new Error(`benchmark ${where} failed: PayoutEventDedupe clear`);
  }
}
// Fixture validation (outside the timed loop): a full rebuild +
// clear + re-record pass matches the hand-written expectations above.
checkDedupeClear("fixture");
// Empty-store check (outside the timed loop): clearing a dedupe
// that has recorded nothing — twice — is a harmless no-op, and the
// store still records a first sighting afterwards.
{
  const empty = new PayoutEventDedupe({ now: () => DEDUPE_CLEAR_NOW_MS });
  empty.clear();
  empty.clear();
  const emptyStats = empty.stats();
  if (
    empty.size !== 0 ||
    emptyStats.size !== 0 ||
    emptyStats.hits !== 0 ||
    emptyStats.misses !== 0 ||
    emptyStats.evictions !== 0 ||
    empty.checkAndRecord(dedupeClearIds[0])
  ) {
    throw new Error(
      "benchmark fixture failed: empty dedupe clear is not a no-op",
    );
  }
}

// Dedupe-stats fixture: 7 fixed `eventId`s recorded in a
// `PayoutEventDedupe` under an injectable clock that advances only
// while the fixture is built (a 60-second TTL and a capacity of 6
// throughout):
//   - at the fixture base instant, `bench-stats-evicted` and
//     `bench-stats-expired` are recorded (2 misses);
//   - the clock then advances 50 seconds and 4 live ids
//     `bench-stats-live-00` .. `bench-stats-live-03` are recorded
//     at that instant (4 more misses; the map is now full at 6);
//   - the first live id is recorded again (1 hit, refreshing its
//     LRU recency, so the earlier `bench-stats-evicted` stays at
//     the head of the map);
//   - one further id, `bench-stats-new`, is recorded (1 more
//     miss): making room LRU-evicts `bench-stats-evicted` —
//     nothing is expired yet at that instant — (1 eviction);
//   - the clock then advances 10 more seconds to the stats
//     instant and stays fixed there: `bench-stats-expired` is
//     now exactly one TTL old (age >= TTL — the boundary rule
//     the dedupe tests pin), so it is expired but still sits in
//     the map (no miss has run since, so nothing pruned it),
//     and the 5 later ids are 10 seconds old and live.
// Hand-written expectation — written out here from the script
// above and cross-checked against the dedupe stats test, never
// derived by calling `stats()` itself: the snapshot is exactly
// `{ size: 5, hits: 1, misses: 7, evictions: 1 }`, where `size`
// counts only the 5 live ids (the expired id in the map is
// excluded) and the `size` getter agrees. `stats()` is a pure
// read, so the timed loop reuses this one fixture — no rebuild.
const DEDUPE_STATS_TTL_MS = 60_000;
const DEDUPE_STATS_MAX_ENTRIES = 6;
const DEDUPE_STATS_BASE_MS = BASE_MS + 360_000;
const DEDUPE_STATS_NOW_MS = DEDUPE_STATS_BASE_MS + DEDUPE_STATS_TTL_MS;
const DEDUPE_STATS_EXPECTED = { size: 5, hits: 1, misses: 7, evictions: 1 };
let dedupeStatsClockMs = DEDUPE_STATS_BASE_MS;
const dedupeStats = new PayoutEventDedupe({
  ttlMs: DEDUPE_STATS_TTL_MS,
  maxEntries: DEDUPE_STATS_MAX_ENTRIES,
  now: () => dedupeStatsClockMs,
});
if (dedupeStats.checkAndRecord("bench-stats-evicted")) {
  throw new Error(
    "benchmark fixture failed: dedupe stats prefill saw a duplicate",
  );
}
if (dedupeStats.checkAndRecord("bench-stats-expired")) {
  throw new Error(
    "benchmark fixture failed: dedupe stats prefill saw a duplicate",
  );
}
dedupeStatsClockMs = DEDUPE_STATS_BASE_MS + 50_000;
const DEDUPE_STATS_LIVE_IDS: string[] = Array.from(
  { length: 4 },
  (_, i) => `bench-stats-live-${String(i).padStart(2, "0")}`,
);
for (const id of DEDUPE_STATS_LIVE_IDS) {
  if (dedupeStats.checkAndRecord(id)) {
    throw new Error(
      "benchmark fixture failed: dedupe stats prefill saw a duplicate",
    );
  }
}
if (!dedupeStats.checkAndRecord(DEDUPE_STATS_LIVE_IDS[0])) {
  throw new Error(
    "benchmark fixture failed: dedupe stats prefill missed a recorded id",
  );
}
if (dedupeStats.checkAndRecord("bench-stats-new")) {
  throw new Error(
    "benchmark fixture failed: dedupe stats prefill saw a duplicate",
  );
}
dedupeStatsClockMs = DEDUPE_STATS_NOW_MS;
function checkDedupeStats(where: string): void {
  const snapshot = dedupeStats.stats();
  if (
    snapshot.size !== DEDUPE_STATS_EXPECTED.size ||
    snapshot.hits !== DEDUPE_STATS_EXPECTED.hits ||
    snapshot.misses !== DEDUPE_STATS_EXPECTED.misses ||
    snapshot.evictions !== DEDUPE_STATS_EXPECTED.evictions ||
    dedupeStats.size !== DEDUPE_STATS_EXPECTED.size
  ) {
    throw new Error(`benchmark ${where} failed: PayoutEventDedupe stats`);
  }
}
// Fixture validation (outside the timed loop): the full snapshot
// matches the hand-written expectation above.
checkDedupeStats("fixture");
// Detached-copy check (outside the timed loop): mutating a
// returned snapshot — rewriting every field — leaves a re-read
// unchanged.
{
  const detached = dedupeStats.stats();
  detached.size = 999;
  detached.hits = 999;
  detached.misses = 999;
  detached.evictions = 999;
  checkDedupeStats("fixture");
}
// Empty-store check (outside the timed loop): a dedupe that has
// recorded nothing reports all-zero stats.
{
  const empty = new PayoutEventDedupe({
    ttlMs: DEDUPE_STATS_TTL_MS,
    maxEntries: DEDUPE_STATS_MAX_ENTRIES,
    now: () => DEDUPE_STATS_NOW_MS,
  });
  const emptyStats = empty.stats();
  if (
    empty.size !== 0 ||
    emptyStats.size !== 0 ||
    emptyStats.hits !== 0 ||
    emptyStats.misses !== 0 ||
    emptyStats.evictions !== 0
  ) {
    throw new Error("benchmark fixture failed: empty dedupe stats shape");
  }
}

// Batch-build fixture: 12 PAID tasks built with the same
// `buildPaidTask` fixture as the screening batch (full 8-entry
// history, settled exactly as quoted, each with a payoutRef). The
// batch shares one fixed payload timestamp (`WEBHOOK_NOW`); per-task
// `eventId`s come from an injected deterministic factory — a counter
// modulo the batch size, so every call yields the same 12 distinct
// ids in input order and nothing reads a random source.
const BATCH_BUILD_SIZE = 12;
const batchBuildTasks: TaskLifecycle[] = Array.from(
  { length: BATCH_BUILD_SIZE },
  (_, i) =>
    buildPaidTask(`BENCH-BATCH-${String(i + 1).padStart(2, "0")}`, {
      quotedAmount: 100 + i * 10,
      payoutAmount: 100 + i * 10,
      payoutRef: `bench-pay-batch-${String(i + 1).padStart(2, "0")}`,
    }),
);
if (
  batchBuildTasks.some((t) => t.state !== "PAID" || t.history.length !== 8)
) {
  throw new Error("benchmark fixture failed: batch-build batch shape");
}
const expectedBatchEventIds: string[] = Array.from(
  { length: BATCH_BUILD_SIZE },
  (_, i) => `bench-batch-event-${String(i).padStart(2, "0")}`,
);
let batchEventSeq = 0;
const batchEventIdFactory = (): string => {
  const id = expectedBatchEventIds[batchEventSeq % BATCH_BUILD_SIZE];
  batchEventSeq++;
  return id;
};
function runBatchBuild() {
  batchEventSeq = 0;
  const results = buildPayoutWebhooks(batchBuildTasks, WEBHOOK_SECRET, {
    now: WEBHOOK_NOW,
    eventIdFactory: batchEventIdFactory,
  });
  if (
    results.length !== BATCH_BUILD_SIZE ||
    results.some(
      (r, i) =>
        r.taskId !== batchBuildTasks[i].id ||
        r.error !== undefined ||
        r.webhook === undefined ||
        r.webhook.payload.taskId !== batchBuildTasks[i].id ||
        r.webhook.payload.eventId !== expectedBatchEventIds[i] ||
        r.webhook.payload.at !== WEBHOOK_NOW.toISOString(),
    ) ||
    new Set(results.map((r) => r.webhook?.payload.eventId)).size !==
      BATCH_BUILD_SIZE
  ) {
    throw new Error("benchmark self-check failed: buildPayoutWebhooks batch");
  }
  return results;
}
// One-time fixture validation (outside the timed loop): every webhook
// in the batch verifies under the batch secret.
for (const r of runBatchBuild()) {
  if (
    !r.webhook ||
    !verifyPayoutWebhook(
      JSON.stringify(r.webhook.payload),
      r.webhook.signature,
      WEBHOOK_SECRET,
    )
  ) {
    throw new Error(
      "benchmark fixture failed: batch-build webhook does not verify",
    );
  }
}
// Per-task isolation (outside the timed loop): one non-PAID task in a
// mixed batch fails only itself and never blocks the PAID tasks
// around it.
const batchOpenTask = new TaskLifecycle("BENCH-BATCH-OPEN");
batchOpenTask.dispatch("PUBLISH", {
  actor: "researcher",
  at: new Date(BASE_MS).toISOString(),
});
batchEventSeq = 0;
const mixedBatch = buildPayoutWebhooks(
  [batchBuildTasks[0], batchOpenTask, batchBuildTasks[1]],
  WEBHOOK_SECRET,
  { now: WEBHOOK_NOW, eventIdFactory: batchEventIdFactory },
);
if (
  mixedBatch.length !== 3 ||
  mixedBatch[0].taskId !== batchBuildTasks[0].id ||
  mixedBatch[0].webhook === undefined ||
  mixedBatch[1].taskId !== "BENCH-BATCH-OPEN" ||
  mixedBatch[1].webhook !== undefined ||
  typeof mixedBatch[1].error !== "string" ||
  !mixedBatch[1].error.includes("state OPEN") ||
  mixedBatch[2].taskId !== batchBuildTasks[1].id ||
  mixedBatch[2].webhook === undefined ||
  !verifyPayoutWebhook(
    JSON.stringify(mixedBatch[2].webhook.payload),
    mixedBatch[2].webhook.signature,
    WEBHOOK_SECRET,
  )
) {
  throw new Error(
    "benchmark fixture failed: buildPayoutWebhooks per-task isolation",
  );
}

// Retry-After parsing fixture: a fixed 11-value corpus parsed under
// one injected fixed instant, RETRY_NOW_MS =
// Date.parse("2026-06-01T12:00:00.000Z"). The HTTP-date strings are
// built with toUTCString() from that instant; toUTCString() has
// one-second precision and RETRY_NOW_MS sits exactly on a whole
// second, so the date expectations below are exact, not ranges.
// Hand-written expectations — written out here from the documented
// semantics of parsePayoutRetryAfter, never derived by calling it:
//   "120"                          -> 120,000 (120 s x 1,000)
//   "0"                            -> 0
//   "2.5"                          -> 2,500 (fractional seconds)
//   "  30 "                        -> 30,000 (value is trimmed)
//   HTTP-date at RETRY_NOW + 5,000 -> 5,000 (future date delta)
//   HTTP-date at RETRY_NOW - 1,000 -> 0 (past date clamps, never
//                                        negative)
//   "-5"                           -> undefined (signed numbers are
//                                        rejected explicitly, not
//                                        read as a date / year)
//   "+5"                           -> undefined (same signed rule)
//   "banana"                       -> undefined (unparsable; the
//                                        caller falls back to
//                                        exponential backoff)
//   null                           -> undefined (absent header)
//   undefined                      -> undefined (absent header)
const RETRY_NOW_MS = Date.parse("2026-06-01T12:00:00.000Z");
const retryAfterCorpus: Array<{
  value: string | null | undefined;
  expected: number | undefined;
}> = [
  { value: "120", expected: 120_000 },
  { value: "0", expected: 0 },
  { value: "2.5", expected: 2_500 },
  { value: "  30 ", expected: 30_000 },
  { value: new Date(RETRY_NOW_MS + 5_000).toUTCString(), expected: 5_000 },
  { value: new Date(RETRY_NOW_MS - 1_000).toUTCString(), expected: 0 },
  { value: "-5", expected: undefined },
  { value: "+5", expected: undefined },
  { value: "banana", expected: undefined },
  { value: null, expected: undefined },
  { value: undefined, expected: undefined },
];
function checkRetryAfterCorpus(where: string): void {
  for (const { value, expected } of retryAfterCorpus) {
    if (parsePayoutRetryAfter(value, RETRY_NOW_MS) !== expected) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time exhaustive validation (outside the timed loop): every
// corpus value returns exactly its hand-written expectation.
checkRetryAfterCorpus("parsePayoutRetryAfter fixture");

// Payout-mismatch fixture: a fixed set of 5 tasks covering the five
// shapes a per-task reconciliation call meets, each built with the
// same lifecycle steps, actors, and per-step timestamp offsets as
// `runLifecycle()` (BASE_MS + step index seconds — fixed timestamps,
// never the wall clock). The first four run the full lifecycle to
// PAID (8 history entries); the fifth stops after ACCEPT (2 entries,
// state ACCEPTED). Hand-written expectations — written out here from
// the documented semantics of payoutMismatch, never derived by
// calling it:
//   MIS-01 quoted 200, paid 200   -> undefined (settled exactly as
//                                    quoted: no mismatch to report)
//   MIS-02 quoted 200, paid 175.5 -> { quoted: 200, paid: 175.5,
//                                    delta: -24.5 } (175.5 - 200,
//                                    computed by hand)
//   MIS-03 no quote, paid 90      -> undefined (no ACCEPT quote was
//                                    ever recorded, so there is
//                                    nothing to compare against)
//   MIS-04 quoted 150, no amount  -> undefined (the PAYOUT_COMPLETE
//                                    entry records no settled
//                                    amount, so there is nothing to
//                                    compare against)
//   MIS-05 quoted 120, ACCEPTED   -> undefined (not PAID: nothing
//                                    has settled yet)
function buildMismatchTask(
  id: string,
  opts: { quotedAmount?: number; payoutAmount?: number; settle: boolean },
): TaskLifecycle {
  const task = new TaskLifecycle(id);
  const steps = opts.settle ? LIFECYCLE : LIFECYCLE.slice(0, 2);
  steps.forEach(({ event, actor }, i) => {
    const extra: { quotedAmount?: number; payoutAmount?: number } = {};
    if (event === "ACCEPT" && opts.quotedAmount !== undefined) {
      extra.quotedAmount = opts.quotedAmount;
    }
    if (event === "PAYOUT_COMPLETE" && opts.payoutAmount !== undefined) {
      extra.payoutAmount = opts.payoutAmount;
    }
    task.dispatch(event, {
      actor,
      at: new Date(BASE_MS + i * 1000).toISOString(),
      ...extra,
    });
  });
  return task;
}
const mismatchCorpus: Array<{
  task: TaskLifecycle;
  expected: PayoutMismatch | undefined;
}> = [
  {
    task: buildMismatchTask("BENCH-MIS-01", {
      quotedAmount: 200,
      payoutAmount: 200,
      settle: true,
    }),
    expected: undefined,
  },
  {
    task: buildMismatchTask("BENCH-MIS-02", {
      quotedAmount: 200,
      payoutAmount: 175.5,
      settle: true,
    }),
    expected: { quoted: 200, paid: 175.5, delta: -24.5 },
  },
  {
    task: buildMismatchTask("BENCH-MIS-03", {
      payoutAmount: 90,
      settle: true,
    }),
    expected: undefined,
  },
  {
    task: buildMismatchTask("BENCH-MIS-04", {
      quotedAmount: 150,
      settle: true,
    }),
    expected: undefined,
  },
  {
    task: buildMismatchTask("BENCH-MIS-05", {
      quotedAmount: 120,
      settle: false,
    }),
    expected: undefined,
  },
];
if (
  mismatchCorpus.length !== 5 ||
  mismatchCorpus
    .slice(0, 4)
    .some(({ task }) => task.state !== "PAID" || task.history.length !== 8) ||
  mismatchCorpus[4].task.state !== "ACCEPTED" ||
  mismatchCorpus[4].task.history.length !== 2
) {
  throw new Error("benchmark fixture failed: payoutMismatch set shape");
}
function checkPayoutMismatchCorpus(where: string): void {
  for (const { task, expected } of mismatchCorpus) {
    const actual = payoutMismatch(task);
    if (expected === undefined) {
      if (actual !== undefined) {
        throw new Error(`benchmark self-check failed: ${where}`);
      }
    } else if (
      actual === undefined ||
      actual.quoted !== expected.quoted ||
      actual.paid !== expected.paid ||
      actual.delta !== expected.delta
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time exhaustive validation (outside the timed loop): every task
// in the set returns exactly its hand-written expectation.
checkPayoutMismatchCorpus("payoutMismatch fixture");

// Allowed-events fixture: all 13 states, in transition-table
// declaration order, with the events allowed from each. Hand-written
// expectations — written out here from the transition table in
// src/taskLifecycle.ts, never derived by calling allowedEvents
// itself:
//   DRAFT          -> [PUBLISH]
//   OPEN           -> [ACCEPT, EXPIRE]
//   ACCEPTED       -> [START_CAPTURE, ABANDON, EXPIRE]
//   CAPTURING      -> [SUBMIT, ABANDON, EXPIRE]
//   SUBMITTED      -> [BEGIN_REVIEW, EXPIRE]
//   IN_REVIEW      -> [APPROVE, REJECT]
//   APPROVED       -> [REQUEST_PAYOUT]
//   PAYOUT_PENDING -> [PAYOUT_COMPLETE]
//   PAID           -> [] (terminal)
//   REJECTED       -> [DISPUTE, RESUBMIT]
//   DISPUTED       -> [ARBITRATE_APPROVE, ARBITRATE_REJECT]
//   ABANDONED      -> [] (terminal)
//   EXPIRED        -> [] (terminal)
const allowedEventsFixture: Array<{
  state: TaskState;
  expected: TaskEvent[];
}> = [
  { state: "DRAFT", expected: ["PUBLISH"] },
  { state: "OPEN", expected: ["ACCEPT", "EXPIRE"] },
  { state: "ACCEPTED", expected: ["START_CAPTURE", "ABANDON", "EXPIRE"] },
  { state: "CAPTURING", expected: ["SUBMIT", "ABANDON", "EXPIRE"] },
  { state: "SUBMITTED", expected: ["BEGIN_REVIEW", "EXPIRE"] },
  { state: "IN_REVIEW", expected: ["APPROVE", "REJECT"] },
  { state: "APPROVED", expected: ["REQUEST_PAYOUT"] },
  { state: "PAYOUT_PENDING", expected: ["PAYOUT_COMPLETE"] },
  { state: "PAID", expected: [] },
  { state: "REJECTED", expected: ["DISPUTE", "RESUBMIT"] },
  { state: "DISPUTED", expected: ["ARBITRATE_APPROVE", "ARBITRATE_REJECT"] },
  { state: "ABANDONED", expected: [] },
  { state: "EXPIRED", expected: [] },
];
if (allowedEventsFixture.length !== 13) {
  throw new Error("benchmark fixture failed: allowedEvents state set shape");
}
function checkAllowedEvents(where: string): void {
  for (const { state, expected } of allowedEventsFixture) {
    const actual = allowedEvents(state);
    if (
      actual.length !== expected.length ||
      actual.some((event, i) => event !== expected[i])
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time exhaustive validation (outside the timed loop): every
// state returns exactly its hand-written expectation, terminal
// states included (empty list).
checkAllowedEvents("allowedEvents fixture");

// Parse-history fixture: reuse the module-scope `historyFixture`
// above — the same detached 8-entry chained history the replay /
// fromHistory paths (group 2) and the NDJSON paths (group 5) use.
// Hand-written expectations — written out here from the fixture
// composition, never derived by calling parseHistory itself:
//   - the parse returns exactly 8 entries;
//   - the last entry has seq 8 and lands in PAID (the fixture's
//     full DRAFT -> PAID lifecycle).
function checkParseHistory(where: string): void {
  const entries = parseHistory(historyFixture);
  if (
    entries.length !== 8 ||
    entries[7].seq !== 8 ||
    entries[7].to !== "PAID"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time validation (outside the timed loop): the intact fixture
// parses to exactly the hand-written expectations above.
checkParseHistory("parseHistory fixture");
// Tamper rejection (outside the timed loop): a detached copy whose
// PAYOUT_COMPLETE entry's payoutAmount is altered from 125 to 126
// no longer recomputes its stored hash, so parseHistory must reject
// it explicitly with the hash-chain error — and the original
// fixture must still parse afterwards, proving the tamper copy was
// detached.
const parseHistoryTampered: TaskHistoryEntry[] = historyFixture.map(
  (e) => ({ ...e }),
);
parseHistoryTampered[7] = {
  ...parseHistoryTampered[7],
  payoutAmount: 126,
};
let parseHistoryTamperRejected = false;
try {
  parseHistory(parseHistoryTampered);
} catch (err) {
  parseHistoryTamperRejected =
    err instanceof Error &&
    err.message.includes("history hash chain is broken");
}
if (!parseHistoryTamperRejected) {
  throw new Error(
    "benchmark fixture failed: parseHistory accepted a tampered history",
  );
}
checkParseHistory("parseHistory fixture after tamper check");

// IsTerminal fixture: all 13 states, in transition-table declaration
// order, with the hand-written terminal truth value for each.
// Hand-written expectations — written out here from the TERMINAL
// set in src/taskLifecycle.ts, never derived by calling isTerminal
// itself:
//   DRAFT          -> false
//   OPEN           -> false
//   ACCEPTED       -> false
//   CAPTURING      -> false
//   SUBMITTED      -> false
//   IN_REVIEW      -> false
//   APPROVED       -> false
//   PAYOUT_PENDING -> false
//   PAID           -> true (terminal)
//   REJECTED       -> false
//   DISPUTED       -> false
//   ABANDONED      -> true (terminal)
//   EXPIRED        -> true (terminal)
const isTerminalFixture: Array<{
  state: TaskState;
  expected: boolean;
}> = [
  { state: "DRAFT", expected: false },
  { state: "OPEN", expected: false },
  { state: "ACCEPTED", expected: false },
  { state: "CAPTURING", expected: false },
  { state: "SUBMITTED", expected: false },
  { state: "IN_REVIEW", expected: false },
  { state: "APPROVED", expected: false },
  { state: "PAYOUT_PENDING", expected: false },
  { state: "PAID", expected: true },
  { state: "REJECTED", expected: false },
  { state: "DISPUTED", expected: false },
  { state: "ABANDONED", expected: true },
  { state: "EXPIRED", expected: true },
];
if (isTerminalFixture.length !== 13) {
  throw new Error("benchmark fixture failed: isTerminal state set shape");
}
function checkIsTerminal(where: string): void {
  for (const { state, expected } of isTerminalFixture) {
    if (isTerminal(state) !== expected) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time exhaustive validation (outside the timed loop): every
// state returns exactly its hand-written truth value, terminal
// states included.
checkIsTerminal("isTerminal fixture");

// Transition-table JSON fixture: the canonical export of the full
// transition table. Hand-written expectations — written out here
// from the committed snapshot
// (test/__snapshots__/transitionTable.snapshot.json) and the
// transition table in src/taskLifecycle.ts, never derived by
// calling transitionTableJson itself:
//   - the parsed output is an array of exactly 19 edges;
//   - the first edge is DRAFT --PUBLISH--> OPEN;
//   - the payout edge PAYOUT_PENDING --PAYOUT_COMPLETE--> PAID
//     is present;
//   - the last edge is DISPUTED --ARBITRATE_REJECT--> REJECTED;
//   - the raw text ends with a trailing newline (canonical form).
const TRANSITION_TABLE_JSON_EDGE_COUNT = 19;
function checkTransitionTableJson(where: string): void {
  const text = transitionTableJson();
  if (!text.endsWith("\n")) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== TRANSITION_TABLE_JSON_EDGE_COUNT ||
    parsed[0]?.from !== "DRAFT" ||
    parsed[0]?.event !== "PUBLISH" ||
    parsed[0]?.to !== "OPEN" ||
    !parsed.some(
      (e) =>
        e?.from === "PAYOUT_PENDING" &&
        e?.event === "PAYOUT_COMPLETE" &&
        e?.to === "PAID",
    ) ||
    parsed[TRANSITION_TABLE_JSON_EDGE_COUNT - 1]?.from !== "DISPUTED" ||
    parsed[TRANSITION_TABLE_JSON_EDGE_COUNT - 1]?.event !==
      "ARBITRATE_REJECT" ||
    parsed[TRANSITION_TABLE_JSON_EDGE_COUNT - 1]?.to !== "REJECTED"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time validation (outside the timed loop): the export parses
// to exactly the hand-written expectations above.
checkTransitionTableJson("transitionTableJson fixture");

// Transition-table fixture: the pure object construction behind
// the JSON export above. Hand-written expectations — written out
// here in full from the committed snapshot
// (test/__snapshots__/transitionTable.snapshot.json) and the
// transition table in src/taskLifecycle.ts, never derived by
// calling transitionTable itself:
//   - the output is an array of exactly 19 edges, in declaration
//     order (state, then event within state), written out in full
//     below;
//   - every edge's keys are in the pinned order from, event, to;
//   - the first edge is DRAFT --PUBLISH--> OPEN, the payout edge
//     at index 14 is PAYOUT_PENDING --PAYOUT_COMPLETE--> PAID, and
//     the last edge is DISPUTED --ARBITRATE_REJECT--> REJECTED —
//     the same three edges the transitionTableJson fixture above
//     pins, so the per-iteration check also spot-checks
//     consistency with the JSON edge set.
// Outside the timed loop, an exhaustive check compares the full
// edge set to the parsed transitionTableJson() edge set edge for
// edge and confirms the hand-pinned non-existent edge
// DRAFT --PAYOUT_COMPLETE--> PAID is absent from both.
const TRANSITION_TABLE_EDGE_COUNT = 19;
const TRANSITION_TABLE_PAYOUT_INDEX = 14;
const TRANSITION_TABLE_EDGES: readonly TransitionEdge[] = [
  { from: "DRAFT", event: "PUBLISH", to: "OPEN" },
  { from: "OPEN", event: "ACCEPT", to: "ACCEPTED" },
  { from: "OPEN", event: "EXPIRE", to: "EXPIRED" },
  { from: "ACCEPTED", event: "START_CAPTURE", to: "CAPTURING" },
  { from: "ACCEPTED", event: "ABANDON", to: "ABANDONED" },
  { from: "ACCEPTED", event: "EXPIRE", to: "EXPIRED" },
  { from: "CAPTURING", event: "SUBMIT", to: "SUBMITTED" },
  { from: "CAPTURING", event: "ABANDON", to: "ABANDONED" },
  { from: "CAPTURING", event: "EXPIRE", to: "EXPIRED" },
  { from: "SUBMITTED", event: "BEGIN_REVIEW", to: "IN_REVIEW" },
  { from: "SUBMITTED", event: "EXPIRE", to: "EXPIRED" },
  { from: "IN_REVIEW", event: "APPROVE", to: "APPROVED" },
  { from: "IN_REVIEW", event: "REJECT", to: "REJECTED" },
  { from: "APPROVED", event: "REQUEST_PAYOUT", to: "PAYOUT_PENDING" },
  { from: "PAYOUT_PENDING", event: "PAYOUT_COMPLETE", to: "PAID" },
  { from: "REJECTED", event: "DISPUTE", to: "DISPUTED" },
  { from: "REJECTED", event: "RESUBMIT", to: "CAPTURING" },
  { from: "DISPUTED", event: "ARBITRATE_APPROVE", to: "APPROVED" },
  { from: "DISPUTED", event: "ARBITRATE_REJECT", to: "REJECTED" },
];
const TRANSITION_TABLE_ABSENT_EDGE: TransitionEdge = {
  from: "DRAFT",
  event: "PAYOUT_COMPLETE",
  to: "PAID",
};
const transitionTableTriple = (edge: TransitionEdge): string =>
  `${edge.from}/${edge.event}/${edge.to}`;
function checkTransitionTable(where: string): void {
  const edges = transitionTable();
  if (
    edges.length !== TRANSITION_TABLE_EDGE_COUNT ||
    edges.some(
      (edge, i) =>
        transitionTableTriple(edge) !==
          transitionTableTriple(TRANSITION_TABLE_EDGES[i]!) ||
        Object.keys(edge).join(",") !== "from,event,to",
    ) ||
    transitionTableTriple(edges[0]!) !==
      transitionTableTriple(TRANSITION_TABLE_EDGES[0]!) ||
    transitionTableTriple(edges[TRANSITION_TABLE_PAYOUT_INDEX]!) !==
      transitionTableTriple(
        TRANSITION_TABLE_EDGES[TRANSITION_TABLE_PAYOUT_INDEX]!,
      ) ||
    transitionTableTriple(edges[edges.length - 1]!) !==
      transitionTableTriple(
        TRANSITION_TABLE_EDGES[TRANSITION_TABLE_EDGES.length - 1]!,
      )
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time validation (outside the timed loop): the pure
// construction matches every hand-pinned expectation above.
checkTransitionTable("transitionTable fixture");
// Exhaustive check outside the timed loop: the pure edge set
// equals the parsed transitionTableJson() edge set edge for edge,
// and the pinned non-existent edge is absent from both.
{
  const pureTriples = transitionTable().map(transitionTableTriple);
  const jsonTriples = (
    JSON.parse(transitionTableJson()) as TransitionEdge[]
  ).map(transitionTableTriple);
  const absent = transitionTableTriple(TRANSITION_TABLE_ABSENT_EDGE);
  if (
    pureTriples.length !== TRANSITION_TABLE_EDGE_COUNT ||
    jsonTriples.length !== TRANSITION_TABLE_EDGE_COUNT ||
    pureTriples.some((triple, i) => triple !== jsonTriples[i]) ||
    pureTriples.includes(absent) ||
    jsonTriples.includes(absent)
  ) {
    throw new Error(
      "benchmark fixture failed: transitionTable exhaustive JSON consistency / absent-edge check",
    );
  }
}

// State-diagram fixture: the Mermaid rendering of the full
// transition table. Hand-written expectations — written out here
// from src/taskLifecycle.ts and the committed snapshot
// (test/__snapshots__/transitionTable.snapshot.json), never derived
// by calling stateDiagram itself:
//   - the output is exactly 24 lines: the opening ```mermaid
//     fence, `stateDiagram-v2`, `    direction LR`, the initial
//     `    [*] --> DRAFT` line, 19 edge lines, and the closing
//     ``` fence;
//   - the first edge line is `    DRAFT --> OPEN : PUBLISH`;
//   - the payout edge line
//     `    PAYOUT_PENDING --> PAID : PAYOUT_COMPLETE` is present;
//   - the last edge line is
//     `    DISPUTED --> REJECTED : ARBITRATE_REJECT`;
//   - every one of the 13 hand-written states below appears as
//     the source or target of at least one edge / initial line.
const STATE_DIAGRAM_STATES: TaskState[] = [
  "DRAFT",
  "OPEN",
  "ACCEPTED",
  "CAPTURING",
  "SUBMITTED",
  "IN_REVIEW",
  "APPROVED",
  "PAYOUT_PENDING",
  "PAID",
  "REJECTED",
  "DISPUTED",
  "ABANDONED",
  "EXPIRED",
];
const STATE_DIAGRAM_EDGE_COUNT = 19;
const STATE_DIAGRAM_LINE_COUNT = 24;
function checkStateDiagram(where: string): void {
  const lines = stateDiagram().split("\n");
  if (
    lines.length !== STATE_DIAGRAM_LINE_COUNT ||
    lines[0] !== "```mermaid" ||
    lines[1] !== "stateDiagram-v2" ||
    lines[2] !== "    direction LR" ||
    lines[3] !== "    [*] --> DRAFT" ||
    lines[STATE_DIAGRAM_LINE_COUNT - 1] !== "```"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  const edgeLines = lines.slice(4, STATE_DIAGRAM_LINE_COUNT - 1);
  if (
    edgeLines.length !== STATE_DIAGRAM_EDGE_COUNT ||
    edgeLines[0] !== "    DRAFT --> OPEN : PUBLISH" ||
    !edgeLines.includes("    PAYOUT_PENDING --> PAID : PAYOUT_COMPLETE") ||
    edgeLines[STATE_DIAGRAM_EDGE_COUNT - 1] !==
      "    DISPUTED --> REJECTED : ARBITRATE_REJECT"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  const seen = new Set<string>();
  for (const line of [lines[3], ...edgeLines]) {
    const m = /^    (\S+) --> (\S+)(?: : .+)?$/.exec(line);
    if (!m) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
    if (m[1] !== "[*]") seen.add(m[1]);
    seen.add(m[2]);
  }
  if (
    seen.size !== STATE_DIAGRAM_STATES.length ||
    STATE_DIAGRAM_STATES.some((s) => !seen.has(s))
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time validation (outside the timed loop): the rendering
// matches exactly the hand-written expectations above.
checkStateDiagram("stateDiagram fixture");

// README diagram sync-check fixture: no corpus to build — the
// check reads this repo's own README.md from disk on every call
// and compares it against the diagram block generated from the
// transition table when src/diagram.ts was loaded. Hand-written
// expectation — written out here from the state the test suite
// pins, never derived by calling readmeDiagramInSync itself:
//   - the return value is exactly true: test/diagram.test.ts
//     runs the CLI `--check` form of this same function and
//     requires the in-sync outcome, and
//     test/stateDiagram.test.ts asserts the README embeds the
//     exact generated diagram (no drift). A drifted README
//     would fail the test suite before it could fail here, so
//     true is the only expectation consistent with a green
//     suite; the bench self-check would catch a drift the
//     moment the README and the table diverged.
function checkReadmeDiagramInSync(where: string): void {
  if (readmeDiagramInSync() !== true) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time validation (outside the timed loop): the README on
// disk is in sync with the generated diagram.
checkReadmeDiagramInSync("readmeDiagramInSync fixture");

// IsOverdue fixture: a fixed corpus of 4 tasks, all in ACCEPTED
// (PUBLISH then ACCEPT, fixed dispatch timestamps at BASE_MS and
// BASE_MS + 1s), judged under one injected fixed `now`
// (2026-10-04T00:00:00.000Z — the same fixed instant the SLA tests
// in test/sla.test.ts judge at). Hand-written expectations —
// written out here from src/taskLifecycle.ts (`isOverdue` reads
// the deadline attached to the task's CURRENT state, returns
// false when no deadline is set or the task is terminal, and
// otherwise `now >= deadline`) and cross-checked against
// test/sla.test.ts, never derived by calling isOverdue itself:
//   BENCH-OD-01 deadline 2020-01-01 (past)     -> true
//                    (sla test: true after the deadline)
//   BENCH-OD-02 deadline exactly `now`       -> true
//                    (sla test: true exactly at the deadline,
//                     inclusive boundary — `>=`, not `>`)
//   BENCH-OD-03 deadline 2099-01-01 (future) -> false
//                    (sla test: false before the deadline)
//   BENCH-OD-04 no SLA deadline              -> false
//                    (sla test: false when no deadline is set)
const IS_OVERDUE_NOW = new Date("2026-10-04T00:00:00.000Z");
function buildIsOverdueTask(id: string, deadline?: Date): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS).toISOString(),
  });
  task.dispatch("ACCEPT", {
    actor: "contributor",
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (deadline !== undefined) task.setSlaDeadline(deadline);
  return task;
}
const isOverdueFixture: Array<{
  task: TaskLifecycle;
  expected: boolean;
}> = [
  {
    task: buildIsOverdueTask(
      "BENCH-OD-01",
      new Date("2020-01-01T00:00:00.000Z"),
    ),
    expected: true,
  },
  { task: buildIsOverdueTask("BENCH-OD-02", IS_OVERDUE_NOW), expected: true },
  {
    task: buildIsOverdueTask(
      "BENCH-OD-03",
      new Date("2099-01-01T00:00:00.000Z"),
    ),
    expected: false,
  },
  { task: buildIsOverdueTask("BENCH-OD-04"), expected: false },
];
if (
  isOverdueFixture.length !== 4 ||
  isOverdueFixture.some((e) => e.task.state !== "ACCEPTED")
) {
  throw new Error("benchmark fixture failed: isOverdue corpus shape");
}
function checkIsOverdue(where: string): void {
  for (const { task, expected } of isOverdueFixture) {
    if (isOverdue(task, IS_OVERDUE_NOW) !== expected) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time exhaustive validation (outside the timed loop): every
// corpus task returns exactly its hand-written expectation.
checkIsOverdue("isOverdue fixture");

// Subscribe fixture: one fixed collecting listener subscribed to a
// fresh task BEFORE any dispatch, then the task is driven through
// the same fixed full lifecycle as `runLifecycle()` (the LIFECYCLE
// table above: same events, actors, per-step timestamp offsets from
// BASE_MS, and ACCEPT quote / PAYOUT_COMPLETE settlement extras).
// Hand-written expectations — written out here from the transition
// table in src/taskLifecycle.ts and cross-checked against
// test/subscribe.test.ts and the demo's subscription branch, never
// derived by calling subscribe itself:
//   - exactly 8 notifications, one per successful dispatch, in
//     dispatch order, with these (event, from, to) triples:
//       PUBLISH         DRAFT          -> OPEN
//       ACCEPT          OPEN           -> ACCEPTED
//       START_CAPTURE   ACCEPTED       -> CAPTURING
//       SUBMIT          CAPTURING      -> SUBMITTED
//       BEGIN_REVIEW    SUBMITTED      -> IN_REVIEW
//       APPROVE         IN_REVIEW      -> APPROVED
//       REQUEST_PAYOUT  APPROVED       -> PAYOUT_PENDING
//       PAYOUT_COMPLETE PAYOUT_PENDING -> PAID
//   - notification i carries the audit entry appended by dispatch i:
//     its seq is i + 1 and every recorded field (event, from, to,
//     at, actor, quote / settlement extras, hash-chain links) equals
//     history[i] field for field;
//   - the task has exactly 1 listener while subscribed.
const SUBSCRIBE_EXPECTED: Array<{
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
}> = [
  { event: "PUBLISH", from: "DRAFT", to: "OPEN" },
  { event: "ACCEPT", from: "OPEN", to: "ACCEPTED" },
  { event: "START_CAPTURE", from: "ACCEPTED", to: "CAPTURING" },
  { event: "SUBMIT", from: "CAPTURING", to: "SUBMITTED" },
  { event: "BEGIN_REVIEW", from: "SUBMITTED", to: "IN_REVIEW" },
  { event: "APPROVE", from: "IN_REVIEW", to: "APPROVED" },
  { event: "REQUEST_PAYOUT", from: "APPROVED", to: "PAYOUT_PENDING" },
  { event: "PAYOUT_COMPLETE", from: "PAYOUT_PENDING", to: "PAID" },
];
type SubscribeNotification = {
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
  entry: TaskHistoryEntry;
};
function runSubscribedLifecycle(): {
  task: TaskLifecycle;
  notifications: SubscribeNotification[];
} {
  const task = new TaskLifecycle("BENCH-SUB-001");
  const notifications: SubscribeNotification[] = [];
  task.subscribe((event, from, to, entry) => {
    notifications.push({ event, from, to, entry });
  });
  LIFECYCLE.forEach(({ event, actor, extra }, i) => {
    task.dispatch(event, {
      actor,
      at: new Date(BASE_MS + i * 1000).toISOString(),
      ...extra,
    });
  });
  return { task, notifications };
}
function checkSubscribe(
  task: TaskLifecycle,
  notifications: SubscribeNotification[],
  where: string,
): void {
  if (
    task.state !== "PAID" ||
    task.listenerCount !== 1 ||
    task.history.length !== SUBSCRIBE_EXPECTED.length ||
    notifications.length !== SUBSCRIBE_EXPECTED.length
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < SUBSCRIBE_EXPECTED.length; i++) {
    const n = notifications[i];
    const expected = SUBSCRIBE_EXPECTED[i];
    const entry = task.history[i];
    if (
      n.event !== expected.event ||
      n.from !== expected.from ||
      n.to !== expected.to ||
      n.entry.seq !== i + 1 ||
      n.entry.event !== entry.event ||
      n.entry.from !== entry.from ||
      n.entry.to !== entry.to ||
      n.entry.at !== entry.at ||
      n.entry.actor !== entry.actor ||
      n.entry.note !== entry.note ||
      n.entry.quotedAmount !== entry.quotedAmount ||
      n.entry.payoutRef !== entry.payoutRef ||
      n.entry.payoutAmount !== entry.payoutAmount ||
      n.entry.prevHash !== entry.prevHash ||
      n.entry.hash !== entry.hash
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time validation (outside the timed loop): a subscribed
// lifecycle produces exactly the hand-written notification
// sequence, entry for entry against the task's history.
{
  const { task, notifications } = runSubscribedLifecycle();
  checkSubscribe(task, notifications, "subscribe fixture");
}
// One-time unsubscribe validation (outside the timed loop): after
// unsubscribe, a further successful dispatch notifies nobody —
// the count stays at the 1 notification collected before it,
// while the task itself still moves (hand-written expectations
// from test/subscribe.test.ts: unsubscribe stops delivery and is
// idempotent).
{
  const task = new TaskLifecycle("BENCH-SUB-002");
  let count = 0;
  const unsubscribe = task.subscribe(() => {
    count++;
  });
  task.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS).toISOString(),
  });
  unsubscribe();
  unsubscribe();
  task.dispatch("ACCEPT", {
    actor: "contributor",
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (
    count !== 1 ||
    task.listenerCount !== 0 ||
    task.state !== "ACCEPTED" ||
    task.history.length !== 2
  ) {
    throw new Error("benchmark self-check failed: subscribe unsubscribe");
  }
}
// One-time isolation validation (outside the timed loop): a
// throwing listener neither breaks the dispatch nor starves its
// peer — the dispatch returns the new state, the audit entry is
// appended, and the peer still receives the notification
// (hand-written expectations from test/subscribe.test.ts).
{
  const task = new TaskLifecycle("BENCH-SUB-003");
  const seen: string[] = [];
  task.subscribe(() => {
    throw new Error("bench: bad fan-out consumer");
  });
  task.subscribe(() => {
    seen.push("peer");
  });
  const to = task.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS).toISOString(),
  });
  if (
    to !== "OPEN" ||
    task.history.length !== 1 ||
    task.history[0].event !== "PUBLISH" ||
    seen.length !== 1
  ) {
    throw new Error("benchmark self-check failed: subscribe isolation");
  }
}

// Subscribe onError fixture: one fixed throwing listener subscribed
// to a fresh task BEFORE any dispatch, with a collecting `onError`
// hook, then the task is driven through the same fixed full
// lifecycle as `runSubscribedLifecycle()` (the LIFECYCLE table
// above: same events, actors, per-step timestamp offsets from
// BASE_MS, and ACCEPT quote / PAYOUT_COMPLETE settlement extras).
// Hand-written expectations — written out here from the subscribe
// source in src/taskLifecycle.ts and cross-checked against
// test/subscribeOnError.test.ts and the demo's subscribe onError
// segment, never derived by calling the routing itself:
//   - all 8 dispatches return normally, in lifecycle order
//     (OPEN, ACCEPTED, CAPTURING, SUBMITTED, IN_REVIEW, APPROVED,
//     PAYOUT_PENDING, PAID), and the task lands in PAID with all
//     8 audit entries intact;
//   - `onError` receives exactly 8 reports — one per dispatch,
//     equal to the dispatch count — each carrying the thrown
//     error's message ("bench listener failure") and the dispatch
//     context of the step being notified; the first report is
//     pinned in full: PUBLISH, DRAFT -> OPEN;
//   - the task has exactly 1 listener while subscribed.
const SUBSCRIBE_ONERROR_EXPECTED_COUNT = 8;
const SUBSCRIBE_ONERROR_EXPECTED_RESULTS: TaskState[] = [
  "OPEN",
  "ACCEPTED",
  "CAPTURING",
  "SUBMITTED",
  "IN_REVIEW",
  "APPROVED",
  "PAYOUT_PENDING",
  "PAID",
];
const SUBSCRIBE_ONERROR_MESSAGE = "bench listener failure";
const SUBSCRIBE_ONERROR_FIRST: {
  message: string;
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
} = {
  message: SUBSCRIBE_ONERROR_MESSAGE,
  event: "PUBLISH",
  from: "DRAFT",
  to: "OPEN",
};
type SubscribeOnErrorReport = {
  message: string;
  ctx: ListenerErrorContext;
};
function runSubscribedOnErrorLifecycle(): {
  task: TaskLifecycle;
  reports: SubscribeOnErrorReport[];
  results: TaskState[];
} {
  const task = new TaskLifecycle("BENCH-SUB-ONERR-001");
  const reports: SubscribeOnErrorReport[] = [];
  task.subscribe(
    () => {
      throw new Error(SUBSCRIBE_ONERROR_MESSAGE);
    },
    {
      onError: (err, ctx) => {
        reports.push({
          message: err instanceof Error ? err.message : String(err),
          ctx,
        });
      },
    },
  );
  const results: TaskState[] = [];
  LIFECYCLE.forEach(({ event, actor, extra }, i) => {
    results.push(
      task.dispatch(event, {
        actor,
        at: new Date(BASE_MS + i * 1000).toISOString(),
        ...extra,
      }),
    );
  });
  return { task, reports, results };
}
function checkSubscribeOnError(
  task: TaskLifecycle,
  reports: SubscribeOnErrorReport[],
  results: TaskState[],
  where: string,
): void {
  if (
    task.state !== "PAID" ||
    task.listenerCount !== 1 ||
    task.history.length !== SUBSCRIBE_ONERROR_EXPECTED_COUNT ||
    reports.length !== SUBSCRIBE_ONERROR_EXPECTED_COUNT ||
    JSON.stringify(results) !==
      JSON.stringify(SUBSCRIBE_ONERROR_EXPECTED_RESULTS) ||
    reports.some((r) => r.message !== SUBSCRIBE_ONERROR_MESSAGE) ||
    reports[0].ctx.event !== SUBSCRIBE_ONERROR_FIRST.event ||
    reports[0].ctx.from !== SUBSCRIBE_ONERROR_FIRST.from ||
    reports[0].ctx.to !== SUBSCRIBE_ONERROR_FIRST.to
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time validation (outside the timed loop): a subscribed
// throwing lifecycle routes exactly the hand-written report count,
// with the first report's context pinned in full.
{
  const { task, reports, results } = runSubscribedOnErrorLifecycle();
  checkSubscribeOnError(task, reports, results, "subscribe onError fixture");
}
// One-time throwing-onError validation (outside the timed loop): an
// `onError` hook that itself throws is swallowed too — both probe
// dispatches return normally and the audit history holds both
// entries (hand-written expectations from
// test/subscribeOnError.test.ts).
{
  const task = new TaskLifecycle("BENCH-SUB-ONERR-002");
  task.subscribe(
    () => {
      throw new Error("bench probe listener failure");
    },
    {
      onError: () => {
        throw new Error("bench probe onError failure");
      },
    },
  );
  const first = task.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS).toISOString(),
  });
  const second = task.dispatch("ACCEPT", {
    actor: "contributor",
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (
    first !== "OPEN" ||
    second !== "ACCEPTED" ||
    task.state !== "ACCEPTED" ||
    task.history.length !== 2
  ) {
    throw new Error("benchmark self-check failed: subscribe onError probe");
  }
}
// One-time invalid-onError validation (outside the timed loop): a
// non-function `onError` is rejected at subscribe time with exactly
// `invalid subscribe: onError must be a function, got string`
// (the wording test/subscribeOnError.test.ts pins), and nothing is
// registered by the failed attempt.
{
  const task = new TaskLifecycle("BENCH-SUB-ONERR-003");
  let caught: unknown;
  try {
    task.subscribe(() => {}, {
      onError: "nope",
    } as unknown as SubscribeOptions);
  } catch (err) {
    caught = err;
  }
  if (
    !(caught instanceof Error) ||
    caught.message !==
      "invalid subscribe: onError must be a function, got string" ||
    task.listenerCount !== 0
  ) {
    throw new Error(
      "benchmark self-check failed: subscribe onError rejection",
    );
  }
}

// Snapshot round-trip fixture: the module-scope `paidTask` above
// (the same fixed full lifecycle as group 1: BENCH-001 driven
// DRAFT -> PAID by the LIFECYCLE table — same events, actors,
// per-step timestamp offsets from BASE_MS, ACCEPT quote 125 and
// PAYOUT_COMPLETE settlement ref bench-pay-001 / amount 125)
// exported once with `toJSON()`.
// Hand-written expectations — written out here from the snapshot
// contract in src/taskLifecycle.ts and cross-checked against
// test/serialization.test.ts, test/snapshotVersion.test.ts,
// test/snapshotUnknownFields.test.ts, and the demo's JSON
// snapshot segment, never derived by calling
// toJSON/fromJSON themselves:
//   - the envelope carries exactly v 1 (SNAPSHOT_VERSION), id
//     BENCH-001, state PAID, and the full 8-entry history;
//   - slaDeadlines is the empty object (the lifecycle sets no
//     deadlines) and the optional envelope fields are all absent:
//     maxResubmits / maxDisputes (both budgets unlimited, and JSON
//     cannot carry Infinity), rolePolicy (none set), and
//     idempotencyKeys (no key consumed);
//   - the used budget counts are NOT stored in the envelope —
//     they are derived from the history on both sides, and the
//     lifecycle history holds no RESUBMIT and no DISPUTE entry,
//     so both used counts read 0 before and after the trip;
//   - re-exporting a restored task yields the identical snapshot
//     content at the same serialized byte length — the round-trip
//     is a fixed point (fromJSON normalizes history-entry key
//     order; every value and hash is unchanged);
//   - the strict reader's rejection side is pinned too, outside
//     the timed loop: a detached copy whose v is rewritten from
//     1 to 2 must be rejected with exactly
//     `invalid snapshot: unsupported snapshot version 2` (the
//     version gate — the same wording the snapshot-version tests
//     and the demo's v: 2 segment pin), and a detached copy
//     carrying one extra top-level field must be rejected with
//     exactly `invalid snapshot: unknown field "benchExtraField"`
//     (the fail-closed unknown-field gate — the same wording the
//     unknown-field tests pin); the intact fixture must still
//     restore afterwards, proving both tamper copies were
//     detached and never touched it.
const snapshotFixture: TaskSnapshot = paidTask.toJSON();
const snapshotFixtureJsonText = JSON.stringify(snapshotFixture);
const snapshotFixtureBytes = new TextEncoder().encode(
  snapshotFixtureJsonText,
).length;
const SNAPSHOT_RESUBMIT_USED = 0;
const SNAPSHOT_DISPUTE_USED = 0;
function usedCountOf(task: TaskLifecycle, event: TaskEvent): number {
  return task.history.filter((entry) => entry.event === event).length;
}
function checkSnapshotRoundTrip(
  restored: TaskLifecycle,
  where: string,
): void {
  if (
    restored.id !== "BENCH-001" ||
    restored.state !== "PAID" ||
    restored.history.length !== 8 ||
    usedCountOf(restored, "RESUBMIT") !== SNAPSHOT_RESUBMIT_USED ||
    usedCountOf(restored, "DISPUTE") !== SNAPSHOT_DISPUTE_USED ||
    historyToNdjson(restored.history) !== ndjsonFixture
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < 8; i++) {
    const a = restored.history[i];
    const b = paidTask.history[i];
    if (
      a.seq !== b.seq ||
      a.event !== b.event ||
      a.from !== b.from ||
      a.to !== b.to ||
      a.at !== b.at ||
      a.actor !== b.actor ||
      a.note !== b.note ||
      a.quotedAmount !== b.quotedAmount ||
      a.payoutRef !== b.payoutRef ||
      a.payoutAmount !== b.payoutAmount ||
      a.prevHash !== b.prevHash ||
      a.hash !== b.hash
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
  const reExported = restored.toJSON();
  const reExportedBytes = new TextEncoder().encode(
    JSON.stringify(reExported),
  ).length;
  if (
    reExported.v !== snapshotFixture.v ||
    reExported.id !== snapshotFixture.id ||
    reExported.state !== snapshotFixture.state ||
    reExported.maxResubmits !== snapshotFixture.maxResubmits ||
    reExported.maxDisputes !== snapshotFixture.maxDisputes ||
    JSON.stringify(reExported.slaDeadlines) !==
      JSON.stringify(snapshotFixture.slaDeadlines) ||
    reExportedBytes !== snapshotFixtureBytes
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
if (
  snapshotFixture.v !== 1 ||
  snapshotFixture.id !== "BENCH-001" ||
  snapshotFixture.state !== "PAID" ||
  snapshotFixture.history.length !== 8 ||
  Object.keys(snapshotFixture.slaDeadlines).length !== 0 ||
  snapshotFixture.maxResubmits !== undefined ||
  snapshotFixture.maxDisputes !== undefined ||
  snapshotFixture.rolePolicy !== undefined ||
  snapshotFixture.idempotencyKeys !== undefined ||
  usedCountOf(paidTask, "RESUBMIT") !== SNAPSHOT_RESUBMIT_USED ||
  usedCountOf(paidTask, "DISPUTE") !== SNAPSHOT_DISPUTE_USED
) {
  throw new Error("benchmark fixture failed: snapshot shape");
}
// One-time validation (outside the timed loop): the in-memory
// envelope restores to exactly the hand-written expectations.
checkSnapshotRoundTrip(
  TaskLifecycle.fromJSON(snapshotFixture),
  "snapshot fixture",
);
// One-time JSON text round-trip validation (outside the timed
// loop): the persisted text form (JSON.stringify / JSON.parse —
// what a document store actually keeps) restores identically.
checkSnapshotRoundTrip(
  TaskLifecycle.fromJSON(JSON.parse(snapshotFixtureJsonText) as unknown),
  "snapshot text round-trip",
);
// Envelope rejection (outside the timed loop): a detached copy
// whose schema version is rewritten from 1 to 2 describes a
// format this reader does not understand, so fromJSON must
// reject it with the hand-pinned version error — and the
// original fixture must still restore afterwards, proving the
// tamper copy was detached.
const snapshotVersionTampered = JSON.parse(
  snapshotFixtureJsonText,
) as Record<string, unknown>;
snapshotVersionTampered.v = 2;
let snapshotVersionRejected = false;
try {
  TaskLifecycle.fromJSON(snapshotVersionTampered);
} catch (err) {
  snapshotVersionRejected =
    err instanceof Error &&
    err.message ===
      "invalid snapshot: unsupported snapshot version 2";
}
if (!snapshotVersionRejected) {
  throw new Error(
    "benchmark fixture failed: fromJSON accepted a v: 2 snapshot",
  );
}
// Envelope rejection (outside the timed loop): a detached copy
// carrying one extra top-level field the envelope never defines
// must fail closed with the hand-pinned unknown-field error
// (a typo'd field must never be silently dropped) — and the
// original fixture must still restore afterwards, proving the
// tamper copy was detached.
const snapshotUnknownFieldTampered = JSON.parse(
  snapshotFixtureJsonText,
) as Record<string, unknown>;
snapshotUnknownFieldTampered.benchExtraField = true;
let snapshotUnknownFieldRejected = false;
try {
  TaskLifecycle.fromJSON(snapshotUnknownFieldTampered);
} catch (err) {
  snapshotUnknownFieldRejected =
    err instanceof Error &&
    err.message ===
      'invalid snapshot: unknown field "benchExtraField"';
}
if (!snapshotUnknownFieldRejected) {
  throw new Error(
    "benchmark fixture failed: fromJSON accepted an unknown snapshot field",
  );
}
checkSnapshotRoundTrip(
  TaskLifecycle.fromJSON(snapshotFixture),
  "snapshot fixture after envelope rejection checks",
);

// VerifyHistoryChain linkage fixture: reuse the module-scope
// `historyFixture` above — the same detached 8-entry chained
// history the replay / fromHistory paths use. The bench has
// timed `verifyHistoryChain` since the first bench commit, but
// its self-check pinned only the boolean verdict on the intact
// fixture; this fixture pins the linkage that verdict rests
// on. Hand-written expectations — written out here from the
// chain convention in src/taskLifecycle.ts (the genesis entry
// links to GENESIS_PREV_HASH, every later entry links to its
// predecessor's hash) and cross-checked against
// test/historyHashChain.test.ts, never derived by calling
// verifyHistoryChain itself:
//   - the intact fixture verifies (verifyHistoryChain returns
//     true);
//   - the first entry's prevHash is exactly GENESIS_PREV_HASH
//     (the genesis link — the boolean alone would not catch a
//     fixture whose genesis link drifted while its hashes were
//     recomputed to match);
//   - every later entry's prevHash equals its predecessor's
//     hash, entry for entry;
//   - a detached copy whose middle entry (index 3, SUBMIT)
//     gains a payoutAmount it never carried no longer
//     recomputes its stored hash, so verifyHistoryChain must
//     return false for it — checked once, outside the timed
//     loop, and the intact fixture must still verify
//     afterwards, proving the tamper copy was detached.
function checkVerifyHistoryChain(where: string): void {
  if (!verifyHistoryChain(historyFixture)) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  if (historyFixture[0].prevHash !== GENESIS_PREV_HASH) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 1; i < historyFixture.length; i++) {
    if (historyFixture[i].prevHash !== historyFixture[i - 1].hash) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time validation (outside the timed loop): the intact
// fixture verifies with its genesis and successor links pinned.
checkVerifyHistoryChain("verifyHistoryChain fixture");
// Tamper rejection (outside the timed loop): the altered copy
// must return false — and the original fixture must still
// verify afterwards, proving the tamper copy was detached.
const verifyChainTampered: TaskHistoryEntry[] = historyFixture.map(
  (e) => ({ ...e }),
);
verifyChainTampered[3] = {
  ...verifyChainTampered[3],
  payoutAmount: 999,
};
if (verifyHistoryChain(verifyChainTampered)) {
  throw new Error(
    "benchmark fixture failed: verifyHistoryChain accepted a tampered history",
  );
}
checkVerifyHistoryChain("verifyHistoryChain fixture after tamper check");

// FromHistory fidelity fixture: reuse the module-scope
// `historyFixture` above — the same detached 8-entry chained
// history the replay path (group 2) and the NDJSON paths
// (group 5) use. The bench has timed `TaskLifecycle.fromHistory`
// since the first bench commit, but its self-check pinned only
// the rebuilt task's final state; this fixture pins the rebuild
// fidelity itself. Hand-written expectations — written out here
// from the fixture composition and cross-checked against
// test/replay.test.ts ("history is the only source of truth"),
// never derived by calling fromHistory itself:
//   - the rebuilt task carries the requested id BENCH-001, lands
//     in PAID (the fixture's full DRAFT -> PAID lifecycle), and
//     holds exactly 8 history entries;
//   - every rebuilt entry equals the source entry field for
//     field (seq / event / from / to / at / actor / note /
//     quotedAmount / payoutRef / payoutAmount / prevHash /
//     hash), so its canonical NDJSON form is the fixture's own
//     `ndjsonFixture` (fromHistory normalizes history-entry key
//     order on rehydration, so the comparison is field-wise and
//     through the canonical serializer, never raw JSON text);
//   - a detached copy whose PAYOUT_COMPLETE entry's
//     payoutAmount is altered from 125 to 126 no longer
//     recomputes its stored hash, so fromHistory must reject it
//     with the hash-chain error — checked once, outside the
//     timed loop, mirroring the parseHistory tamper check.
function checkFromHistory(restored: TaskLifecycle, where: string): void {
  if (
    restored.id !== "BENCH-001" ||
    restored.state !== "PAID" ||
    restored.history.length !== 8 ||
    historyToNdjson(restored.history) !== ndjsonFixture
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < 8; i++) {
    const a = restored.history[i];
    const b = historyFixture[i];
    if (
      a.seq !== b.seq ||
      a.event !== b.event ||
      a.from !== b.from ||
      a.to !== b.to ||
      a.at !== b.at ||
      a.actor !== b.actor ||
      a.note !== b.note ||
      a.quotedAmount !== b.quotedAmount ||
      a.payoutRef !== b.payoutRef ||
      a.payoutAmount !== b.payoutAmount ||
      a.prevHash !== b.prevHash ||
      a.hash !== b.hash
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time validation (outside the timed loop): the intact
// fixture rebuilds to exactly the hand-written expectations.
checkFromHistory(
  TaskLifecycle.fromHistory("BENCH-001", historyFixture),
  "fromHistory fixture",
);
// Tamper rejection (outside the timed loop): the altered copy
// must be rejected explicitly — and the original fixture must
// still rebuild afterwards, proving the tamper copy was
// detached.
const fromHistoryTampered: TaskHistoryEntry[] = historyFixture.map(
  (e) => ({ ...e }),
);
fromHistoryTampered[7] = {
  ...fromHistoryTampered[7],
  payoutAmount: 126,
};
let fromHistoryTamperRejected = false;
try {
  TaskLifecycle.fromHistory("BENCH-001", fromHistoryTampered);
} catch (err) {
  fromHistoryTamperRejected =
    err instanceof Error &&
    err.message.includes("history hash chain is broken");
}
if (!fromHistoryTamperRejected) {
  throw new Error(
    "benchmark fixture failed: fromHistory accepted a tampered history",
  );
}
checkFromHistory(
  TaskLifecycle.fromHistory("BENCH-001", historyFixture),
  "fromHistory fixture after tamper check",
);

// GetSlaDeadline fixture: one fixed task in ACCEPTED (PUBLISH at
// BASE_MS, ACCEPT at BASE_MS + 1s, the same fixed timestamps the
// isOverdue fixture uses), carrying an SLA deadline for exactly
// two states. Hand-written expectations — written out here from
// the deadlines set immediately below and cross-checked against
// test/sla.test.ts ("deadline is per-state: another state's
// deadline is ignored" pins the OPEN value and the ACCEPTED
// `undefined` on a task that set only OPEN; "setSlaDeadline:
// overwrites, stores normalized ISO, clears" pins the normalized
// ISO storage), never derived by calling getSlaDeadline itself:
//   DRAFT          -> undefined (never set)
//   OPEN           -> "2026-02-01T09:00:00.000Z" (set below)
//   ACCEPTED       -> "2026-03-01T09:00:00.000Z" (set below)
//   CAPTURING      -> undefined (never set)
//   SUBMITTED      -> undefined (never set)
//   IN_REVIEW      -> undefined (never set)
//   APPROVED       -> undefined (never set)
//   PAYOUT_PENDING -> undefined (never set)
//   PAID           -> undefined (never set)
//   REJECTED       -> undefined (never set)
//   DISPUTED       -> undefined (never set)
//   ABANDONED      -> undefined (never set)
//   EXPIRED        -> undefined (never set)
// The task's current state is ACCEPTED, so the no-argument form
// getSlaDeadline() must read back the ACCEPTED deadline — the
// default-argument behaviour the watchdog relies on when it
// polls the state a task is actually in.
const GET_SLA_OPEN_DEADLINE = "2026-02-01T09:00:00.000Z";
const GET_SLA_ACCEPTED_DEADLINE = "2026-03-01T09:00:00.000Z";
function buildGetSlaDeadlineTask(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS).toISOString(),
  });
  task.dispatch("ACCEPT", {
    actor: "contributor",
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  task.setSlaDeadline(new Date(GET_SLA_OPEN_DEADLINE), "OPEN");
  task.setSlaDeadline(new Date(GET_SLA_ACCEPTED_DEADLINE), "ACCEPTED");
  return task;
}
const getSlaDeadlineTask = buildGetSlaDeadlineTask("BENCH-SLA-001");
const getSlaDeadlineFixture: Array<{
  state: TaskState;
  expected: string | undefined;
}> = [
  { state: "DRAFT", expected: undefined },
  { state: "OPEN", expected: GET_SLA_OPEN_DEADLINE },
  { state: "ACCEPTED", expected: GET_SLA_ACCEPTED_DEADLINE },
  { state: "CAPTURING", expected: undefined },
  { state: "SUBMITTED", expected: undefined },
  { state: "IN_REVIEW", expected: undefined },
  { state: "APPROVED", expected: undefined },
  { state: "PAYOUT_PENDING", expected: undefined },
  { state: "PAID", expected: undefined },
  { state: "REJECTED", expected: undefined },
  { state: "DISPUTED", expected: undefined },
  { state: "ABANDONED", expected: undefined },
  { state: "EXPIRED", expected: undefined },
];
if (
  getSlaDeadlineFixture.length !== 13 ||
  getSlaDeadlineTask.state !== "ACCEPTED" ||
  getSlaDeadlineTask.history.length !== 2
) {
  throw new Error("benchmark fixture failed: getSlaDeadline corpus shape");
}
function checkGetSlaDeadline(where: string): void {
  for (const { state, expected } of getSlaDeadlineFixture) {
    if (getSlaDeadlineTask.getSlaDeadline(state) !== expected) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
  if (getSlaDeadlineTask.getSlaDeadline() !== GET_SLA_ACCEPTED_DEADLINE) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time exhaustive validation (outside the timed loop): every
// state returns exactly its hand-written expectation, and the
// no-argument form returns the current (ACCEPTED) state's value.
checkGetSlaDeadline("getSlaDeadline fixture");
// Outside the timed loop, on a separate probe task built the
// same way: overwriting a state's deadline reads back the new
// normalized value, the other set state is untouched, and the
// timed fixture above is untouched by the probe's mutation.
const getSlaDeadlineProbe = buildGetSlaDeadlineTask("BENCH-SLA-002");
getSlaDeadlineProbe.setSlaDeadline(
  new Date("2026-04-01T09:00:00.000Z"),
  "OPEN",
);
if (
  getSlaDeadlineProbe.getSlaDeadline("OPEN") !==
    "2026-04-01T09:00:00.000Z" ||
  getSlaDeadlineProbe.getSlaDeadline("ACCEPTED") !==
    GET_SLA_ACCEPTED_DEADLINE
) {
  throw new Error(
    "benchmark fixture failed: getSlaDeadline overwrite readback",
  );
}
checkGetSlaDeadline("getSlaDeadline fixture after overwrite probe");

// Note-length guard fixture: a fixed 2-case corpus for the
// `MAX_NOTE_LENGTH` boundary in `dispatch()`. Hand-written
// expectations — written out here from `src/taskLifecycle.ts`
// (the exported constant and the dispatch validation) and
// cross-checked against `test/actorNoteHardening.test.ts`
// ("dispatch: oversized note is rejected with no history
// residue" and "dispatch: note at exactly the limit passes"),
// never derived by calling dispatch itself:
//   - `MAX_NOTE_LENGTH` is 32768;
//   - a note of exactly 32768 characters is accepted: a fresh
//     task dispatched with PUBLISH lands in OPEN with exactly
//     1 history entry (seq 1) whose stored note is the exact
//     note, of length 32768;
//   - a note of 32769 characters is rejected with exactly
//     "invalid dispatch options: note must be at most 32768
//     characters, got 32769", before anything mutates: the
//     fresh task stays in DRAFT with 0 history entries.
// The filler notes are built once, outside the timed loop,
// from the hand-pinned limit below — a drift between that
// pin, the exported constant, and the rejection text fails
// the bench itself. Notes are presented only by length:
// neither filler string is ever printed.
const NOTE_LIMIT_PINNED: number = 32768;
const NOTE_EXACT = "x".repeat(NOTE_LIMIT_PINNED);
const NOTE_OVER = "x".repeat(NOTE_LIMIT_PINNED + 1);
const EXPECTED_NOTE_REJECTION =
  "invalid dispatch options: note must be at most 32768 characters, got 32769";
function checkMaxNoteLength(where: string): void {
  if (
    MAX_NOTE_LENGTH !== NOTE_LIMIT_PINNED ||
    NOTE_EXACT.length !== NOTE_LIMIT_PINNED ||
    NOTE_OVER.length !== NOTE_LIMIT_PINNED + 1
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  const accepted = new TaskLifecycle("BENCH-NOTE-001");
  accepted.dispatch("PUBLISH", {
    actor: "researcher",
    note: NOTE_EXACT,
    at: new Date(BASE_MS).toISOString(),
  });
  if (
    accepted.state !== "OPEN" ||
    accepted.history.length !== 1 ||
    accepted.history[0].seq !== 1 ||
    accepted.history[0].note !== NOTE_EXACT ||
    accepted.history[0].note?.length !== NOTE_LIMIT_PINNED
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  const rejected = new TaskLifecycle("BENCH-NOTE-002");
  let rejection = "";
  try {
    rejected.dispatch("PUBLISH", {
      actor: "researcher",
      note: NOTE_OVER,
      at: new Date(BASE_MS).toISOString(),
    });
  } catch (err) {
    rejection = err instanceof Error ? err.message : String(err);
  }
  if (
    rejection !== EXPECTED_NOTE_REJECTION ||
    rejected.state !== "DRAFT" ||
    rejected.history.length !== 0
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time exhaustive validation (outside the timed loop):
// both corpus cases match their hand-written expectations.
checkMaxNoteLength("MAX_NOTE_LENGTH fixture");

// Set/clear SLA deadline fixture: one fixed task in OPEN (PUBLISH
// at BASE_MS, the same fixed timestamp the other fixtures use),
// starting with no deadline for any state. Hand-written
// expectations — written out here from `setSlaDeadline` /
// `clearSlaDeadline` in src/taskLifecycle.ts and cross-checked
// against test/sla.test.ts ("setSlaDeadline: overwrites, stores
// normalized ISO, clears" pins the overwrite, the normalized
// storage, and the clear; "setSlaDeadline: rejects unparseable
// input" pins the one rejection), never derived by calling the
// write methods themselves:
//   - setSlaDeadline(FIRST) with no state argument writes the
//     current (OPEN) state's deadline: getSlaDeadline() and
//     getSlaDeadline("OPEN") both read back FIRST, and every
//     other state still reads back `undefined`;
//   - setSlaDeadline(OVERWRITTEN) again overwrites in place:
//     both read-backs return OVERWRITTEN;
//   - clearSlaDeadline("OPEN") removes it: both read-backs
//     return `undefined` again;
//   - none of the writes is a dispatch: the task stays in OPEN
//     with exactly 1 history entry (seq 1, PUBLISH) throughout.
// FIRST is passed as a `Date`, OVERWRITTEN as an ISO string, so
// the cycle covers both input forms the setter accepts.
const SET_CLEAR_SLA_FIRST = "2026-05-01T09:00:00.000Z";
const SET_CLEAR_SLA_OVERWRITTEN = "2026-06-01T09:00:00.000Z";
function buildSetClearSlaDeadlineTask(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS).toISOString(),
  });
  return task;
}
const setClearSlaDeadlineTask =
  buildSetClearSlaDeadlineTask("BENCH-SLA-WRITE-001");
if (
  setClearSlaDeadlineTask.state !== "OPEN" ||
  setClearSlaDeadlineTask.history.length !== 1 ||
  setClearSlaDeadlineTask.getSlaDeadline("OPEN") !== undefined
) {
  throw new Error("benchmark fixture failed: set/clear SLA corpus shape");
}
function checkSetClearSlaDeadline(where: string): void {
  const task = setClearSlaDeadlineTask;
  task.setSlaDeadline(new Date(SET_CLEAR_SLA_FIRST));
  // Expected read-backs are written as literals here, separate
  // from the input constants above, so a drift on either side
  // fails the bench instead of moving both sides together.
  if (
    task.getSlaDeadline() !== "2026-05-01T09:00:00.000Z" ||
    task.getSlaDeadline("OPEN") !== "2026-05-01T09:00:00.000Z" ||
    task.getSlaDeadline("ACCEPTED") !== undefined
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  task.setSlaDeadline(SET_CLEAR_SLA_OVERWRITTEN);
  if (
    task.getSlaDeadline() !== "2026-06-01T09:00:00.000Z" ||
    task.getSlaDeadline("OPEN") !== "2026-06-01T09:00:00.000Z"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  task.clearSlaDeadline("OPEN");
  if (
    task.getSlaDeadline() !== undefined ||
    task.getSlaDeadline("OPEN") !== undefined ||
    task.state !== "OPEN" ||
    task.history.length !== 1 ||
    task.history[0].seq !== 1 ||
    task.history[0].event !== "PUBLISH"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time exhaustive validation (outside the timed loop): the
// full write cycle matches its hand-written expectations.
checkSetClearSlaDeadline("set/clear SLA fixture");
// Outside the timed loop, on separate probe tasks: the per-state
// and clear-all forms, the normalized storage, the setter's one
// rejection, and the terminal-state behaviour.
// (a) Per-state writes are independent: clearing one state
//     leaves the other state's deadline in place, and clearing
//     with no argument then clears every state.
const setClearProbe = buildSetClearSlaDeadlineTask("BENCH-SLA-WRITE-002");
setClearProbe.setSlaDeadline(new Date(SET_CLEAR_SLA_FIRST), "OPEN");
setClearProbe.setSlaDeadline(
  new Date(SET_CLEAR_SLA_OVERWRITTEN),
  "ACCEPTED",
);
setClearProbe.clearSlaDeadline("OPEN");
if (
  setClearProbe.getSlaDeadline("OPEN") !== undefined ||
  setClearProbe.getSlaDeadline("ACCEPTED") !== SET_CLEAR_SLA_OVERWRITTEN
) {
  throw new Error(
    "benchmark fixture failed: set/clear SLA per-state clear",
  );
}
setClearProbe.clearSlaDeadline();
if (
  setClearProbe.getSlaDeadline("OPEN") !== undefined ||
  setClearProbe.getSlaDeadline("ACCEPTED") !== undefined ||
  setClearProbe.state !== "OPEN" ||
  setClearProbe.history.length !== 1
) {
  throw new Error("benchmark fixture failed: set/clear SLA clear-all");
}
// (b) A non-ISO but parseable input is stored normalized to
//     canonical ISO (the storage form test/sla.test.ts pins).
const setClearNormalizeProbe =
  buildSetClearSlaDeadlineTask("BENCH-SLA-WRITE-003");
setClearNormalizeProbe.setSlaDeadline("2020-06-01 00:00:00 UTC");
if (
  setClearNormalizeProbe.getSlaDeadline("OPEN") !==
  "2020-06-01T00:00:00.000Z"
) {
  throw new Error(
    "benchmark fixture failed: setSlaDeadline normalized storage",
  );
}
// (c) The setter's only rejection: an unparseable deadline is
//     rejected with exactly `invalid SLA deadline: not-a-date`,
//     and the previously stored deadline is left untouched.
let setSlaRejection = "";
try {
  setClearNormalizeProbe.setSlaDeadline("not-a-date");
} catch (err) {
  setSlaRejection = err instanceof Error ? err.message : String(err);
}
if (
  setSlaRejection !== "invalid SLA deadline: not-a-date" ||
  setClearNormalizeProbe.getSlaDeadline("OPEN") !==
    "2020-06-01T00:00:00.000Z"
) {
  throw new Error(
    "benchmark fixture failed: setSlaDeadline unparseable rejection",
  );
}
// (d) Terminal state: the setter has no state guard, so setting
//     a deadline on an ABANDONED task (for its ABANDONED state)
//     is stored and reads back — it is NOT rejected. This is
//     the behaviour test/sla.test.ts pins (a deadline is set
//     for ABANDONED after the ABANDON dispatch) and the demo's
//     DEMO-020 task relies on; isOverdue still judges a
//     terminal task not overdue. State and history (3 entries)
//     are untouched by the write.
const setClearTerminalProbe = new TaskLifecycle("BENCH-SLA-WRITE-004");
setClearTerminalProbe.dispatch("PUBLISH", {
  actor: "researcher",
  at: new Date(BASE_MS).toISOString(),
});
setClearTerminalProbe.dispatch("ACCEPT", {
  actor: "contributor",
  at: new Date(BASE_MS + 1000).toISOString(),
});
setClearTerminalProbe.dispatch("ABANDON", {
  actor: "contributor",
  at: new Date(BASE_MS + 2000).toISOString(),
});
setClearTerminalProbe.setSlaDeadline(
  new Date(SET_CLEAR_SLA_FIRST),
  "ABANDONED",
);
if (
  setClearTerminalProbe.state !== "ABANDONED" ||
  setClearTerminalProbe.history.length !== 3 ||
  setClearTerminalProbe.getSlaDeadline("ABANDONED") !==
    SET_CLEAR_SLA_FIRST ||
  isOverdue(setClearTerminalProbe, new Date(BASE_MS + 365 * 86_400_000)) !==
    false
) {
  throw new Error(
    "benchmark fixture failed: setSlaDeadline on a terminal task",
  );
}
// The probes above must not have disturbed the timed fixture.
checkSetClearSlaDeadline("set/clear SLA fixture after probes");

// ---------------------------------------------------------------------
// Single-step transition fixture: one fixed OPEN task — published
// in a single PUBLISH dispatch at BASE_MS — exported ONCE, outside
// the timed loop, as a plain snapshot. The timed path restores that
// snapshot with `TaskLifecycle.fromJSON()` and dispatches exactly
// one legal step, ACCEPT (carrying the same quotedAmount 125 the
// full lifecycle's ACCEPT step carries), pinned to BASE_MS + 1s.
// Hand-written expectations — written out here from the transition
// table in src/taskLifecycle.ts (OPEN carries ACCEPT -> ACCEPTED;
// PAYOUT_COMPLETE is not an edge from OPEN) and cross-checked
// against the committed transition-table snapshot (19 edges),
// never derived by calling the timed path itself:
//   - the snapshot is exactly { state OPEN, 1 history entry:
//     seq 1, PUBLISH, DRAFT -> OPEN, actor researcher, at BASE_MS };
//   - after the one step, the restored task is in ACCEPTED, its
//     history holds exactly 2 entries, and the appended entry is
//     seq 2 (the snapshot's last seq + 1, no gap), ACCEPT,
//     OPEN -> ACCEPTED, actor contributor, quotedAmount 125, at
//     BASE_MS + 1s.
// ---------------------------------------------------------------------
const TRANSITION_STEP_AT = new Date(BASE_MS + 1000).toISOString();
const transitionOpenTask = new TaskLifecycle("BENCH-TRANSITION-001");
transitionOpenTask.dispatch("PUBLISH", {
  actor: "researcher",
  at: new Date(BASE_MS).toISOString(),
});
const transitionSnapshot: TaskSnapshot = transitionOpenTask.toJSON();
if (
  transitionSnapshot.state !== "OPEN" ||
  transitionSnapshot.history.length !== 1 ||
  transitionSnapshot.history[0].seq !== 1 ||
  transitionSnapshot.history[0].event !== "PUBLISH" ||
  transitionSnapshot.history[0].from !== "DRAFT" ||
  transitionSnapshot.history[0].to !== "OPEN" ||
  transitionSnapshot.history[0].actor !== "researcher" ||
  transitionSnapshot.history[0].at !== new Date(BASE_MS).toISOString()
) {
  throw new Error(
    "benchmark fixture failed: single-step transition snapshot shape",
  );
}
function checkTransitionStep(restored: TaskLifecycle, where: string): void {
  const history = restored.history;
  const last = history[history.length - 1];
  if (
    restored.state !== "ACCEPTED" ||
    history.length !== transitionSnapshot.history.length + 1 ||
    last.seq !==
      transitionSnapshot.history[transitionSnapshot.history.length - 1].seq +
        1 ||
    last.event !== "ACCEPT" ||
    last.from !== "OPEN" ||
    last.to !== "ACCEPTED" ||
    last.actor !== "contributor" ||
    last.quotedAmount !== 125 ||
    last.at !== TRANSITION_STEP_AT
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
function runTransitionStep(): TaskLifecycle {
  const restored = TaskLifecycle.fromJSON(transitionSnapshot);
  restored.dispatch("ACCEPT", {
    actor: "contributor",
    at: TRANSITION_STEP_AT,
    quotedAmount: 125,
  });
  return restored;
}
// One-time validation (outside the timed loop): the restored +
// stepped task matches the hand-written expectations exactly.
checkTransitionStep(runTransitionStep(), "single-step transition fixture");
// Exhaustive pure-transition check (outside the timed loop): every
// state/event pair is pinned — the 19 legal edges (hand-written
// from the transition table, in declaration order below) return
// their target, and every other pair throws the exact message
// `invalid transition: <event> from <state>`.
{
  const states: TaskState[] = [
    "DRAFT",
    "OPEN",
    "ACCEPTED",
    "CAPTURING",
    "SUBMITTED",
    "IN_REVIEW",
    "APPROVED",
    "PAYOUT_PENDING",
    "PAID",
    "REJECTED",
    "DISPUTED",
    "ABANDONED",
    "EXPIRED",
  ];
  const events: TaskEvent[] = [
    "PUBLISH",
    "ACCEPT",
    "START_CAPTURE",
    "SUBMIT",
    "BEGIN_REVIEW",
    "APPROVE",
    "REJECT",
    "RESUBMIT",
    "REQUEST_PAYOUT",
    "PAYOUT_COMPLETE",
    "DISPUTE",
    "ARBITRATE_APPROVE",
    "ARBITRATE_REJECT",
    "ABANDON",
    "EXPIRE",
  ];
  const legal = new Map<string, TaskState>([
    ["DRAFT/PUBLISH", "OPEN"],
    ["OPEN/ACCEPT", "ACCEPTED"],
    ["OPEN/EXPIRE", "EXPIRED"],
    ["ACCEPTED/START_CAPTURE", "CAPTURING"],
    ["ACCEPTED/ABANDON", "ABANDONED"],
    ["ACCEPTED/EXPIRE", "EXPIRED"],
    ["CAPTURING/SUBMIT", "SUBMITTED"],
    ["CAPTURING/ABANDON", "ABANDONED"],
    ["CAPTURING/EXPIRE", "EXPIRED"],
    ["SUBMITTED/BEGIN_REVIEW", "IN_REVIEW"],
    ["SUBMITTED/EXPIRE", "EXPIRED"],
    ["IN_REVIEW/APPROVE", "APPROVED"],
    ["IN_REVIEW/REJECT", "REJECTED"],
    ["APPROVED/REQUEST_PAYOUT", "PAYOUT_PENDING"],
    ["PAYOUT_PENDING/PAYOUT_COMPLETE", "PAID"],
    ["REJECTED/DISPUTE", "DISPUTED"],
    ["REJECTED/RESUBMIT", "CAPTURING"],
    ["DISPUTED/ARBITRATE_APPROVE", "APPROVED"],
    ["DISPUTED/ARBITRATE_REJECT", "REJECTED"],
  ]);
  if (legal.size !== 19) {
    throw new Error("benchmark fixture failed: single-step legal edge count");
  }
  for (const state of states) {
    for (const event of events) {
      const expected = legal.get(`${state}/${event}`);
      if (expected !== undefined) {
        if (transition(state, event) !== expected) {
          throw new Error(
            `benchmark fixture failed: transition ${event} from ${state}`,
          );
        }
      } else {
        let message = "";
        try {
          transition(state, event);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        if (message !== `invalid transition: ${event} from ${state}`) {
          throw new Error(
            `benchmark fixture failed: transition rejection for ${event} from ${state}`,
          );
        }
      }
    }
  }
  // The one-step illegal dispatch, through TaskLifecycle.dispatch
  // itself: PAYOUT_COMPLETE from OPEN is rejected with that same
  // exact message and leaves the restored task's state and history
  // untouched.
  const illegal = TaskLifecycle.fromJSON(transitionSnapshot);
  let illegalMessage = "";
  try {
    illegal.dispatch("PAYOUT_COMPLETE", {
      actor: "system",
      at: TRANSITION_STEP_AT,
    });
  } catch (err) {
    illegalMessage = err instanceof Error ? err.message : String(err);
  }
  if (
    illegalMessage !== "invalid transition: PAYOUT_COMPLETE from OPEN" ||
    illegal.state !== "OPEN" ||
    illegal.history.length !== transitionSnapshot.history.length
  ) {
    throw new Error(
      "benchmark fixture failed: single-step illegal dispatch rejection",
    );
  }
}


// ---------------------------------------------------------------------
// Scenarios (each with a self-check so a broken path cannot report a
// plausible-looking number).
// ---------------------------------------------------------------------
function benchDispatchLifecycle(): number {
  return measure(() => {
    const task = runLifecycle();
    if (task.state !== "PAID") {
      throw new Error("benchmark self-check failed: dispatch lifecycle");
    }
  }, ITERATIONS);
}

function benchReplay(): number {
  return measure(() => {
    if (replay(historyFixture) !== "PAID") {
      throw new Error("benchmark self-check failed: replay");
    }
  }, ITERATIONS);
}

function benchFromHistory(): number {
  return measure(() => {
    // Per-iteration self-check: the rebuilt task's id, state, and
    // full history match the source history entry for entry
    // (see the fromHistory fidelity fixture above).
    checkFromHistory(
      TaskLifecycle.fromHistory("BENCH-001", historyFixture),
      "fromHistory",
    );
  }, ITERATIONS);
}

function benchVerifyHistoryChain(): number {
  return measure(() => {
    // Per-iteration self-check: the intact fixture verifies and
    // its genesis / successor links match the hand-written
    // linkage expectations (see the verifyHistoryChain linkage
    // fixture above).
    checkVerifyHistoryChain("verifyHistoryChain");
  }, ITERATIONS);
}

function benchBuildPayoutWebhook(): number {
  return measure(() => {
    const built = buildPayoutWebhook(paidTask, WEBHOOK_SECRET, {
      now: WEBHOOK_NOW,
      eventId: WEBHOOK_EVENT_ID,
    });
    if (built.signature !== webhook.signature) {
      throw new Error("benchmark self-check failed: buildPayoutWebhook");
    }
  }, ITERATIONS);
}

function benchVerifyPayoutWebhook(): number {
  return measure(() => {
    if (!verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET)) {
      throw new Error("benchmark self-check failed: verifyPayoutWebhook");
    }
  }, ITERATIONS);
}

function benchHistoryToNdjson(): number {
  return measure(() => {
    if (historyToNdjson(historyFixture) !== ndjsonFixture) {
      throw new Error("benchmark self-check failed: historyToNdjson");
    }
  }, ITERATIONS);
}

function benchHistoryFromNdjson(): number {
  return measure(() => {
    const entries = historyFromNdjson(ndjsonFixture);
    if (entries.length !== 8 || entries[7].to !== "PAID") {
      throw new Error("benchmark self-check failed: historyFromNdjson");
    }
  }, ITERATIONS);
}

function benchMismatchedPayouts(): number {
  return measure(() => {
    const out = mismatchedPayouts(screeningBatch);
    if (
      out.length !== expectedMismatched.length ||
      out.some((t, i) => t !== expectedMismatched[i])
    ) {
      throw new Error("benchmark self-check failed: mismatchedPayouts");
    }
  }, ITERATIONS);
}

async function benchDeliverPayoutWebhookToMany(): Promise<number> {
  return measureAsync(async () => {
    await runFanout();
  }, ITERATIONS);
}

function benchDeliverPayoutWebhook(): Promise<number> {
  return measureAsync(async () => {
    await runSingleDelivery();
  }, ITERATIONS);
}

function benchPayoutEventDedupe(): number {
  const hitsBefore = dedupe.stats().hits;
  const ops = measure(() => {
    const id = dedupeIds[dedupeCursor];
    dedupeCursor = (dedupeCursor + 1) % dedupeIds.length;
    if (!dedupe.checkAndRecord(id)) {
      throw new Error("benchmark self-check failed: PayoutEventDedupe hit");
    }
  }, ITERATIONS);
  // Stats consistency across the timed loop: every warmup + timed
  // call was a duplicate hit on a pre-recorded id, nothing else.
  const after = dedupe.stats();
  if (
    after.hits !== hitsBefore + WARMUP + ITERATIONS ||
    after.misses !== DEDUPE_PREFILL + 1 ||
    after.evictions !== 0 ||
    after.size !== DEDUPE_PREFILL + 1
  ) {
    throw new Error("benchmark self-check failed: PayoutEventDedupe stats");
  }
  return ops;
}

function benchPayoutEventDedupeRestore(): number {
  return measure(() => {
    const restored = PayoutEventDedupe.restore(dedupeRestoreSnapshot, {
      now: () => DEDUPE_RESTORE_NOW_MS,
    });
    // Per-iteration self-check against the hand-written
    // expectations above: the restore kept all 1,000 entries, the
    // observability counters restarted at zero, and the first /
    // middle / last snapshot ids are all duplicates (3 hits). The
    // exhaustive all-ids check runs once, outside the timed loop,
    // in the fixture validation.
    const fresh = restored.stats();
    if (
      fresh.size !== DEDUPE_RESTORE_PREFILL ||
      fresh.hits !== 0 ||
      fresh.misses !== 0 ||
      fresh.evictions !== 0 ||
      !restored.checkAndRecord(dedupeRestoreIds[0]) ||
      !restored.checkAndRecord(
        dedupeRestoreIds[DEDUPE_RESTORE_PREFILL / 2],
      ) ||
      !restored.checkAndRecord(
        dedupeRestoreIds[DEDUPE_RESTORE_PREFILL - 1],
      ) ||
      restored.stats().hits !== 3
    ) {
      throw new Error(
        "benchmark self-check failed: PayoutEventDedupe restore",
      );
    }
  }, ITERATIONS);
}

function benchPayoutEventDedupeExportSnapshot(): number {
  return measure(() => {
    checkDedupeExportSnapshot("self-check");
  }, ITERATIONS);
}

function benchPayoutEventDedupeClear(): number {
  return measure(() => {
    checkDedupeClear("self-check");
  }, ITERATIONS);
}

function benchPayoutEventDedupeStats(): number {
  return measure(() => {
    checkDedupeStats("self-check");
  }, ITERATIONS);
}

function benchBuildPayoutWebhooks(): number {
  return measure(() => {
    runBatchBuild();
  }, ITERATIONS);
}

function benchTotalPaidOut(): number {
  return measure(() => {
    if (totalPaidOut(screeningBatch) !== expectedTotalPaidOut) {
      throw new Error("benchmark self-check failed: totalPaidOut");
    }
  }, ITERATIONS);
}

function benchExpiredTasks(): number {
  return measure(() => {
    const out = expiredTasks(watchdogBatch, WATCHDOG_NOW);
    if (
      out.length !== expectedExpired.length ||
      out.some((t, i) => t !== expectedExpired[i])
    ) {
      throw new Error("benchmark self-check failed: expiredTasks");
    }
  }, ITERATIONS);
}

function benchStaleTasks(): number {
  return measure(() => {
    const out = staleTasks(watchdogBatch, WATCHDOG_MAX_AGE, WATCHDOG_NOW);
    if (
      out.length !== expectedStale.length ||
      out.some((t, i) => t !== expectedStale[i])
    ) {
      throw new Error("benchmark self-check failed: staleTasks");
    }
  }, ITERATIONS);
}

function benchExpireOverdueTasks(): number {
  return measure(() => {
    // Fresh fixture per iteration: the executor dispatches EXPIRE on
    // the tasks it expires, so no batch can be reused across calls.
    // The rebuild cost is inside the timed region (see the header).
    const batch = buildWatchdogBatch();
    checkExpireResults(
      expireOverdueTasks(batch, WATCHDOG_NOW),
      "expireOverdueTasks",
    );
  }, ITERATIONS);
}

function benchActOnStaleTasks(): number {
  return measure(() => {
    // Fresh fixture per iteration, same reason as above: the default
    // action dispatches ABANDON on the tasks it can act on.
    const batch = buildWatchdogBatch();
    checkStaleResults(
      actOnStaleTasks(batch, undefined, WATCHDOG_MAX_AGE, WATCHDOG_NOW),
      "actOnStaleTasks",
    );
  }, ITERATIONS);
}

function benchParsePayoutRetryAfter(): number {
  return measure(() => {
    // Per-iteration self-check: every corpus value returns exactly
    // its hand-written expectation (see the fixture above).
    checkRetryAfterCorpus("parsePayoutRetryAfter");
  }, ITERATIONS);
}

function benchPayoutMismatch(): number {
  return measure(() => {
    // Per-iteration self-check: every task in the set returns
    // exactly its hand-written expectation (see the fixture above).
    checkPayoutMismatchCorpus("payoutMismatch");
  }, ITERATIONS);
}

function benchAllowedEvents(): number {
  return measure(() => {
    // Per-iteration self-check: every state returns exactly its
    // hand-written expectation (see the fixture above).
    checkAllowedEvents("allowedEvents");
  }, ITERATIONS);
}

function benchParseHistory(): number {
  return measure(() => {
    // Per-iteration self-check: the returned entry count and the
    // last entry's seq/state match the fixture (see above).
    checkParseHistory("parseHistory");
  }, ITERATIONS);
}

function benchIsTerminal(): number {
  return measure(() => {
    // Per-iteration self-check: every state returns exactly its
    // hand-written truth value (see the fixture above).
    checkIsTerminal("isTerminal");
  }, ITERATIONS);
}

function benchTransitionTableJson(): number {
  return measure(() => {
    // Per-iteration self-check: the export parses, the edge count
    // matches the snapshot-pinned count, and the key edges are in
    // place (see the fixture above).
    checkTransitionTableJson("transitionTableJson");
  }, ITERATIONS);
}

function benchTransitionTable(): number {
  return measure(() => {
    // Per-iteration self-check: every edge matches the
    // hand-pinned edge list in declaration order, with the key
    // order pinned (see the fixture above).
    checkTransitionTable("transitionTable");
  }, ITERATIONS);
}

function benchStateDiagram(): number {
  return measure(() => {
    // Per-iteration self-check: every state is present, the edge
    // count matches the snapshot-pinned count, and the first /
    // last lines are in place (see the fixture above).
    checkStateDiagram("stateDiagram");
  }, ITERATIONS);
}

function benchIsOverdue(): number {
  return measure(() => {
    // Per-iteration self-check: every corpus task returns exactly
    // its hand-written expectation (see the fixture above).
    checkIsOverdue("isOverdue");
  }, ITERATIONS);
}

function benchSubscribe(): number {
  return measure(() => {
    // Fresh task per iteration: dispatch mutates the task, so no
    // subscribed lifecycle can be reused across calls. The
    // fixture rebuild cost is inside the timed region.
    // Per-iteration self-check: the notification sequence matches
    // the hand-written expectations and the task's own history,
    // entry for entry (see the fixture above).
    const { task, notifications } = runSubscribedLifecycle();
    checkSubscribe(task, notifications, "subscribe");
  }, ITERATIONS);
}

function benchSubscribeOnError(): number {
  return measure(() => {
    // Fresh task per iteration: dispatch mutates the task, so no
    // subscribed lifecycle can be reused across calls. The
    // fixture rebuild cost is inside the timed region.
    // Per-iteration self-check: every dispatch succeeded, the
    // history count and the routed report count both equal the
    // dispatch count, and the first report matches the
    // hand-written expectations (see the fixture above).
    const { task, reports, results } = runSubscribedOnErrorLifecycle();
    checkSubscribeOnError(task, reports, results, "subscribe onError");
  }, ITERATIONS);
}

function benchSnapshotRoundTrip(): number {
  return measure(() => {
    // Per-iteration self-check: the restored task's state, full
    // history (entry for entry), and history-derived used budget
    // counts match the hand-written expectations, and its
    // re-export is the fixed point (see the fixture above).
    const restored = TaskLifecycle.fromJSON(paidTask.toJSON());
    checkSnapshotRoundTrip(restored, "snapshotRoundTrip");
  }, ITERATIONS);
}

function benchGetSlaDeadline(): number {
  return measure(() => {
    // Per-iteration self-check: every state returns exactly its
    // hand-written expectation (see the fixture above).
    checkGetSlaDeadline("getSlaDeadline");
  }, ITERATIONS);
}

function benchMaxNoteLength(): number {
  return measure(() => {
    // Fresh tasks per iteration: the accepted dispatch mutates
    // its task, so no corpus task can be reused across calls.
    // Per-iteration self-check: the at-limit dispatch appends
    // exactly one entry and the over-limit dispatch leaves no
    // trace (see the fixture above).
    checkMaxNoteLength("MAX_NOTE_LENGTH guard");
  }, ITERATIONS);
}

function benchSetClearSlaDeadline(): number {
  return measure(() => {
    // Shared fixture task per iteration: the cycle ends with
    // the deadline cleared, restoring the fixture's initial
    // no-deadline state, so no rebuild is needed. Per-iteration
    // self-check: every read-back matches the hand-written
    // expectations and the writes never move the task or append
    // history (see the fixture above).
    checkSetClearSlaDeadline("setSlaDeadline + clearSlaDeadline");
  }, ITERATIONS);
}

function benchTransition(): number {
  return measure(() => {
    // Per-iteration self-check: the state advanced exactly one
    // step, the history grew by exactly one entry, and the
    // appended entry's seq continues the snapshot's seq with no
    // gap (see the single-step transition fixture above).
    checkTransitionStep(runTransitionStep(), "benchTransition");
  }, ITERATIONS);
}

function benchReadmeDiagramInSync(): number {
  return measure(() => {
    // Per-iteration self-check: the return value is the
    // hand-written in-sync expectation, true (see the fixture
    // above). The only file read is this repo's README.md.
    checkReadmeDiagramInSync("readmeDiagramInSync");
  }, ITERATIONS);
}

function benchUnreconciledPayouts(): number {
  return measure(() => {
    const out = unreconciledPayouts(screeningBatch);
    if (
      out.length !== expectedUnreconciled.length ||
      out.some((t, i) => t !== expectedUnreconciled[i])
    ) {
      throw new Error("benchmark self-check failed: unreconciledPayouts");
    }
  }, ITERATIONS);
}

console.log("dataquest-task-lifecycle benchmark");
console.log(`Node: ${process.version} on ${process.platform}/${process.arch}`);
console.log(`CPU: ${cpus()[0]?.model ?? "unknown"}`);
console.log(
  "Fixture: one task, full DRAFT -> PAID lifecycle (8 hash-chained audit entries); payout webhook HMAC-SHA256 with fixed secret/timestamp/eventId; NDJSON text exported from the same 8-entry history; reconciliation screening and totalPaidOut summary over a fixed batch of 12 PAID tasks (4 exact+ref, 4 mismatched+ref, 2 exact without ref, 2 mismatched without ref); payout webhook fan-out to 4 endpoints through an injected fake fetch (immediate 200, no network); payout webhook single-target delivery (deliverPayoutWebhook to 1 fixed endpoint through an injected fake fetch — immediate 200, no network, backoffMs 0 with an injected no-op sleep — checked for result {ok: true, attempts: 1, status: 200}, exactly one captured call, and a captured body byte-identical to the signed body whose X-Hub-Signature-256 equals the buildPayoutWebhook signature and verifies over the captured body on every iteration, with the persistent-500 reported exhaustion shape {ok: false, attempts: 3, status: 500, error: \"server responded with status 500\"} pinned once outside the timed loop); payout event dedupe duplicate hits cycling over 1,000 pre-recorded eventIds under a fixed injected clock; payout event dedupe restore from a 1,000-entry JSON-round-tripped snapshot under the same fixed clock (all entries live at load, default TTL and capacity, observability counters restarting at zero); payout event dedupe snapshot export (PayoutEventDedupe.exportSnapshot) over a fixed 6-id dedupe under an injectable clock that advances only during fixture construction (60-second TTL, the first id expired at export time and 5 live ids with staggered first-seen times), self-checked on every iteration for the hand-pinned live entries in recorded order with the expired id absent, with a detached-copy mutation check and an empty-dedupe export check outside the timed loop; payout event dedupe clear (PayoutEventDedupe.clear) over a fresh 1,000-id dedupe rebuilt on every iteration under a fixed injected clock (1,000 first sightings plus 1 duplicate hit before the clear, so the reported numbers include the fixture-rebuild cost — prefill plus clear), self-checked on every iteration for an all-zero size and stats right after the clear and the first id recording as a new event again, with an empty-dedupe clear no-op check outside the timed loop; payout event dedupe stats (PayoutEventDedupe.stats) over a fixed 7-record dedupe under an injectable clock that advances only during fixture construction (60-second TTL, capacity 6 — one id LRU-evicted during construction and one id expired at the stats instant, 5 live ids), self-checked on every iteration for the hand-pinned snapshot {size: 5, hits: 1, misses: 7, evictions: 1} where size counts only the live ids, with a detached-copy mutation check and an empty-dedupe all-zero check outside the timed loop; batch payout webhook building over a fixed batch of 12 PAID tasks (settled as quoted, each with a payoutRef) under one shared timestamp with deterministic per-task eventIds from an injected factory; watchdog screening (expiredTasks / staleTasks) over a fixed batch of 12 mixed-state tasks (4 hand-counted expired, 4 hand-counted stale) under one injected fixed now with per-state dwell budgets; watchdog execution (expireOverdueTasks / actOnStaleTasks with the default ABANDON action) over the same batch, rebuilt fresh on every iteration because the executors mutate their inputs (3 of 4 expire, 1 of 4 stale actions succeed, the rest fail in isolation); payout Retry-After parsing (parsePayoutRetryAfter) over a fixed 11-value corpus (delay-seconds, future/past HTTP-dates, signed and garbage values, and absent values) under an injected fixed nowMs; payout mismatch judgement (payoutMismatch) over a fixed set of 5 tasks (settled exactly as quoted, settled for a different amount, missing quote, missing settled amount, and one non-PAID task) with fixed dispatch timestamps; allowed-events query (allowedEvents) over all 13 states with hand-written per-state expectations (terminal states PAID / ABANDONED / EXPIRED returning an empty list); standalone history parsing (parseHistory) over the same fixed 8-entry chained history (full validation — unknown-field fail-closed, gapless seq, from/to chain and hash-chain re-verification — without per-line JSON parsing, with a detached tampered copy rejected outside the timed loop); terminal-state judgement (isTerminal) over all 13 states with hand-written per-state truth values (only PAID / ABANDONED / EXPIRED returning true); transition-table JSON export (transitionTableJson) with no arguments, serialized as canonical JSON in declaration order, parsed back on every iteration to exactly the 19 snapshot-pinned edges with the first, payout, and last edges in place; state diagram generation (stateDiagram) with no arguments, rendered as a Mermaid stateDiagram-v2 block on every iteration to exactly the 24 hand-pinned lines with all 13 states present and the 19 snapshot-pinned edges in place; README diagram sync check (readmeDiagramInSync) with no arguments, reading only this repo's README.md on every iteration and returning true, the in-sync state pinned by the test suite; SLA overdue judgement (isOverdue) over a fixed corpus of 4 ACCEPTED tasks (already overdue, exactly at the deadline, not yet overdue, and no SLA deadline) under one injected fixed now, with hand-written per-task expectations pinning the inclusive deadline boundary; dispatch subscription notification (subscribe) with 1 fixed collecting listener over the same full 8-dispatch lifecycle on a fresh task per iteration, self-checked per iteration against the hand-written (event, from, to) sequence and the task's own history entry for entry, with unsubscribe and throwing-listener isolation checks outside the timed loop; JSON snapshot round-trip (toJSON + TaskLifecycle.fromJSON) over the same task's fixed 8-entry snapshot envelope (v 1, empty SLA deadlines, unlimited budgets so no budget fields in the envelope), self-checked per iteration against the hand-written expectations (restored state and history entry for entry, hashes included, history-derived used RESUBMIT / DISPUTE counts at 0 on both sides, re-export fixed point at the same serialized byte length), with a JSON text (stringify / parse) round-trip check outside the timed loop and two detached tampered copies (v rewritten to 2, one extra top-level field) rejected with their hand-pinned envelope errors outside the timed loop; event-sourced rebuild (TaskLifecycle.fromHistory) over the same fixed 8-entry history, self-checked per iteration for the rebuilt id and state and the full history entry for entry (hashes included, compared field-wise and through the canonical NDJSON serializer, because rehydration normalizes entry key order), with a detached tampered copy (PAYOUT_COMPLETE payoutAmount altered from 125 to 126) rejected with the hash-chain error outside the timed loop; hash-chain verification (verifyHistoryChain) over the same fixed 8-entry history, self-checked per iteration for the genesis link (the first entry's prevHash is GENESIS_PREV_HASH) and every successor link (each entry's prevHash equals its predecessor's hash), with a detached tampered copy (the middle SUBMIT entry gaining a payoutAmount of 999) returning false outside the timed loop; SLA deadline read (getSlaDeadline) over all 13 states on one fixed ACCEPTED task carrying deadlines for exactly two states (OPEN 2026-02-01T09:00:00.000Z and ACCEPTED 2026-03-01T09:00:00.000Z, the other eleven states returning undefined, and the no-argument form returning the current ACCEPTED state's deadline), self-checked per iteration against the hand-written per-state expectations, with an overwrite readback check on a separate probe task outside the timed loop; dispatch note length guard (MAX_NOTE_LENGTH) over a fixed 2-case corpus (a note of exactly 32768 characters accepted on a fresh task — OPEN with 1 history entry whose stored note length is 32768 — and a note of 32769 characters rejected with the hand-pinned length error, leaving a fresh task in DRAFT with 0 history entries), self-checked per iteration against the hand-written expectations cross-checked against the actor/note hardening tests, with the notes presented only by length and never printed; SLA deadline write (setSlaDeadline + clearSlaDeadline) as one write cycle on a shared fixed OPEN task (set the current state's deadline from a Date, overwrite it from an ISO string, then clear it — the clear restores the fixture's initial no-deadline state so the same task serves every iteration), self-checked per iteration against the hand-written read-backs (the set and overwritten deadlines read back exactly, the cleared state reads back undefined, and the task stays in OPEN with its single PUBLISH entry throughout), with per-state / clear-all, normalized-storage, unparseable-rejection, and terminal-state checks on separate probe tasks outside the timed loop; single-step transition dispatch (benchTransition restoring the fixed OPEN snapshot \u2014 1 PUBLISH entry at the base instant \u2014 and dispatching one ACCEPT step pinned at BASE + 1s with quotedAmount 125, checked on every iteration for the one-step state advance OPEN -> ACCEPTED, exactly one appended entry, and a gap-free seq continuation, with an exhaustive pure-transition check over all 13 states x 15 events \u2014 19 legal edges returning their hand-pinned targets, every other pair throwing the exact invalid-transition message, including the illegal PAYOUT_COMPLETE dispatch from OPEN \u2014 asserted once outside the timed loop; transition-table pure object construction (transitionTable) with no arguments, checked on every iteration against the hand-pinned 19 edges written out in full in declaration order (every edge key order from, event, to; spot-checked against the transitionTableJson edge set via the shared pinned first, payout (index 14), and last edges), with the full edge set compared to the parsed JSON edge set edge for edge and a hand-pinned non-existent edge (DRAFT / PAYOUT_COMPLETE / PAID) confirmed absent from both once outside the timed loop; subscribe onError error routing (subscribe with 1 fixed throwing listener and a collecting onError hook) over the same full 8-dispatch lifecycle on a fresh task per iteration, self-checked per iteration that every dispatch succeeded, the history count and the onError report count both equal the dispatch count (8), every report carries the pinned listener message, and the first report's context is the hand-pinned PUBLISH DRAFT -> OPEN, with a throwing-onError swallowing probe and the exact non-function onError rejection (invalid subscribe: onError must be a function, got string, registering nothing) asserted once outside the timed loop",
);
console.log(`Iterations per op: ${ITERATIONS} (after ${WARMUP} warmup)`);
console.log("");

const results: Array<{ path: string; ops: number }> = [
  { path: "dispatch (full lifecycle, 8 dispatches)", ops: benchDispatchLifecycle() },
  { path: "replay (8-entry history)", ops: benchReplay() },
  { path: "fromHistory (8-entry history)", ops: benchFromHistory() },
  { path: "verifyHistoryChain (8 entries)", ops: benchVerifyHistoryChain() },
  { path: "buildPayoutWebhook (sign)", ops: benchBuildPayoutWebhook() },
  { path: "verifyPayoutWebhook", ops: benchVerifyPayoutWebhook() },
  { path: "historyToNdjson (8 entries)", ops: benchHistoryToNdjson() },
  { path: "historyFromNdjson (8 entries, chain re-verify)", ops: benchHistoryFromNdjson() },
  { path: "mismatchedPayouts (12 PAID tasks)", ops: benchMismatchedPayouts() },
  { path: "unreconciledPayouts (12 PAID tasks)", ops: benchUnreconciledPayouts() },
  { path: "totalPaidOut (12 PAID tasks)", ops: benchTotalPaidOut() },
  { path: "deliverPayoutWebhookToMany (4 endpoints)", ops: await benchDeliverPayoutWebhookToMany() },
  { path: "deliverPayoutWebhook (single endpoint)", ops: await benchDeliverPayoutWebhook() },
  { path: "PayoutEventDedupe checkAndRecord (hit, 1,000 recorded ids)", ops: benchPayoutEventDedupe() },
  { path: "PayoutEventDedupe.restore (1,000-entry snapshot)", ops: benchPayoutEventDedupeRestore() },
  { path: "PayoutEventDedupe.exportSnapshot (5 live entries, 1 expired)", ops: benchPayoutEventDedupeExportSnapshot() },
  { path: "PayoutEventDedupe.clear (1,000 recorded ids, fresh fixture)", ops: benchPayoutEventDedupeClear() },
  { path: "PayoutEventDedupe.stats (5 live entries, 1 expired)", ops: benchPayoutEventDedupeStats() },
  { path: "buildPayoutWebhooks (batch of 12 PAID tasks)", ops: benchBuildPayoutWebhooks() },
  { path: "expiredTasks (12 mixed-state tasks)", ops: benchExpiredTasks() },
  { path: "staleTasks (12 mixed-state tasks)", ops: benchStaleTasks() },
  { path: "expireOverdueTasks (12 mixed-state tasks, fresh fixture)", ops: benchExpireOverdueTasks() },
  { path: "actOnStaleTasks (12 mixed-state tasks, fresh fixture)", ops: benchActOnStaleTasks() },
  { path: "parsePayoutRetryAfter (11-value corpus)", ops: benchParsePayoutRetryAfter() },
  { path: "payoutMismatch (5-task set)", ops: benchPayoutMismatch() },
  { path: "allowedEvents (13 states)", ops: benchAllowedEvents() },
  { path: "parseHistory (8-entry history)", ops: benchParseHistory() },
  { path: "isTerminal (13 states)", ops: benchIsTerminal() },
  { path: "transitionTableJson (19 edges)", ops: benchTransitionTableJson() },
  { path: "transitionTable (19 edges)", ops: benchTransitionTable() },
  { path: "stateDiagram (19 edges)", ops: benchStateDiagram() },
  { path: "readmeDiagramInSync (README file read)", ops: benchReadmeDiagramInSync() },
  { path: "isOverdue (4-task corpus)", ops: benchIsOverdue() },
  { path: "subscribe (full lifecycle, 1 collecting listener)", ops: benchSubscribe() },
  { path: "subscribe onError (full lifecycle, 1 throwing listener)", ops: benchSubscribeOnError() },
  { path: "toJSON + fromJSON snapshot round-trip (8 entries)", ops: benchSnapshotRoundTrip() },
  { path: "getSlaDeadline (13 states, 2 set)", ops: benchGetSlaDeadline() },
  { path: "MAX_NOTE_LENGTH note guard (2-case corpus)", ops: benchMaxNoteLength() },
  { path: "setSlaDeadline + clearSlaDeadline (OPEN task write cycle)", ops: benchSetClearSlaDeadline() },
  { path: "benchTransition (single step, snapshot restore)", ops: benchTransition() },
];

console.log("path                                              throughput");
console.log("---------------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.path.padEnd(50)} ${fmt(r.ops)}`);
}
console.log("");
console.log("Numbers are machine-local measurements, not guarantees.");
