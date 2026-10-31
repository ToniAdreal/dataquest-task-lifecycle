/**
 * Local micro-benchmark for the dataquest-task-lifecycle state machine.
 *
 * Measures real, locally-observed throughput for the fifty hot-path
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
 *      set, as opposed to the per-task webhook paths above. A combined
 *      row runs the whole forwarder-to-reconciliation chain over the
 *      same batch: per task `historyToNdjson` -> `historyFromNdjson`
 *      -> `TaskLifecycle.fromHistory`, then `unreconciledPayouts`
 *      over the rebuilt batch, self-checked against the hand-computed
 *      unreconciled ids and byte-identical re-exported NDJSON;
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
 *      (IN_REVIEW) fail in isolation. A third executor row runs the
 *      same batch through `actOnStaleTasks` with a notify-only action
 *      (the demo's reminder-loop shape: record the id, dispatch
 *      nothing): all 4 stale tasks are notified in batch order, every
 *      outcome is acted with no audit entry, and every task's state
 *      and history bytes are unchanged. The notify-only action
 *      mutates nothing, but the row still rebuilds the fixture fresh
 *      on every iteration, so its numbers stay comparable with the
 *      other executor rows (fixture-rebuild cost included) instead
 *      of flattering the notify path with a reused batch. A fourth
 *      executor row (backlog #746, the bench variant of the #732
 *      test row) runs the same batch with a collecting listener
 *      subscribed to every task before the default ABANDON action:
 *      exactly 1 notification — the WD-04 ABANDON, ACCEPTED ->
 *      ABANDONED, carrying its audit entry — because only WD-04
 *      can be abandoned and the three failed attempts notify
 *      nobody. Outside the timed loop, a notify-only action
 *      notifies nobody and an unsubscribed batch stays silent
 *      while WD-04 is still abandoned. A fifth executor row
 *      (backlog #754, the bench variant of the #748 test row)
 *      runs the same batch with a collecting listener subscribed
 *      to every task before `expireOverdueTasks`: exactly 3
 *      notifications — the WD-01 / WD-10 / WD-12 EXPIREs, each
 *      carrying its audit entry — because only those three can
 *      expire and the failed WD-06 attempt notifies nobody.
 *      Outside the timed loop, a failure-isolated batch notifies
 *      nobody for its stuck task while the rest still expires,
 *      and an unsubscribed batch stays silent while the executor
 *      still expires.
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
 *  33. payout event dedupe first-sighting / LRU eviction —
 *      `PayoutEventDedupe.checkAndRecord()` on a fresh dedupe
 *      rebuilt on every iteration (see the dedupe miss/evict
 *      fixture below): a capacity of 100 under an injected
 *      fixed clock, recording a deterministic sequence of
 *      250 brand-new ids on every pass, so every call is a
 *      first sighting (miss) and the 150 records beyond
 *      capacity force LRU evictions of the oldest surviving
 *      ids. This is the miss direction a receiver pays for
 *      every genuinely new payout event it receives — insert
 *      plus, under capacity pressure, eviction — whose cost
 *      composition differs entirely from the steady-state
 *      duplicate hit in group 8 (lookup plus recency
 *      refresh). One timed pass is one rebuild + 250
 *      first-sighting records + the post-pass self-check;
 *      its per-iteration self-check pins the stats to the
 *      hand-written expectation (`{ size: 100, hits: 0,
 *      misses: 250, evictions: 150 }` — size pinned at
 *      capacity). Outside the timed loop, a probe pins that
 *      the oldest surviving id still records as a duplicate
 *      hit and an already-evicted id records as a new event
 *      again. No network, no randomness, and no wall clock:
 *      the miss clock is fixed and the id sequence is a
 *      precomputed deterministic array.
 *
 *  34. keyed hash-chain verification — `verifyHistoryChain(history,
 *      { auditSecret })` over a fixed 8-entry history chained
 *      under a pinned audit secret (see the auditSecret fixture
 *      below): the same full DRAFT -> PAID lifecycle and fixed
 *      timestamps as group 3, but every link is HMAC-SHA256
 *      keyed by the secret instead of plain SHA-256. This is
 *      the tamper-evidence check a holder of a keyed audit log
 *      pays on every read: recompute every HMAC link under the
 *      secret and compare. Its cost was previously invisible
 *      inside the unkeyed verifyHistoryChain row (group 3).
 *      One timed pass is one keyed verification of the 8-entry
 *      history; its per-iteration self-check pins the verdict
 *      to exactly true. Outside the timed loop, a wrong secret
 *      is pinned to return false, a detached tampered copy is
 *      pinned to return false, and verifying the same keyed
 *      history without a secret is pinned to return false
 *      (fail-closed, the semantics the keyed hash-chain tests
 *      pin). No network, no randomness, and no wall clock:
 *      the secret and every timestamp are pinned.
 *
 *  35. dispatch idempotency dedupe — `dispatch(event,
 *      { idempotencyKey })` on a fresh task per iteration (see
 *      the idempotency fixture below): one keyed `PUBLISH`
 *      under a pinned key, then the same event under the same
 *      key again. This is the retry-safety cost every
 *      payment-flavored dispatch pays: the first call runs the
 *      full validation chain and consumes the key alongside its
 *      append, the repeat is answered from the consumed-key set
 *      after option validation and before transition / RBAC /
 *      budget checks. Its cost was previously invisible inside
 *      the plain dispatch row (group 1), which never carries a
 *      key. One timed pass is one fresh task plus the keyed
 *      dispatch pair (the fresh-task rebuild is inside the timed
 *      region, because the first dispatch consumes the key);
 *      its per-iteration self-check pins the first return and
 *      the duplicate return to the current state, the history
 *      growth to exactly one entry with a gap-free seq, the
 *      consumed-key snapshot to exactly the pinned key, and
 *      the listener notifications to exactly the first dispatch.
 *      Outside the timed loop, the same key under a different
 *      event is pinned to dedupe, a stale retry after the task
 *      moved on is pinned to answer with the current state, a
 *      failed dispatch is pinned to consume no key (the
 *      corrected retry under the same key executes), and two
 *      keyless dispatches are pinned to append two entries.
 *      No network, no randomness, and no wall clock: the key
 *      and every timestamp are pinned.
 *
 *  36. payout webhook secret-rotation verification —
 *      `verifyPayoutWebhook` with the rotation candidate
 *      set `{ secrets: [newSecret, oldSecret] }` over the
 *      fixed webhook fixture (signed with the OLD secret at
 *      the fixed `WEBHOOK_NOW` / `WEBHOOK_EVENT_ID`, so the
 *      matching candidate is the SECOND one tried) on every
 *      iteration, checked to return exactly `true` on every
 *      iteration. This is the steady-state receiver cost
 *      inside a rotation window: every delivery pays one
 *      failed HMAC trial before the match, a cost the
 *      single-secret verify row (group 4) never exercises.
 *      Outside the timed loop, a candidate pair in which
 *      neither secret matches is pinned to return `false`
 *      (all-mismatch fails closed, no throw), and an empty
 *      `secrets` array is pinned to throw the exact
 *      configuration error. No network, no randomness, and
 *      no wall clock: the signed fixture is built once from
 *      pinned secret / timestamp / eventId.
 *
 *  37. payout webhook Retry-After cap delivery —
 *      `deliverPayoutWebhook(url, webhook)` delivering the
 *      module-scope signed webhook through an injected fake
 *      fetch that answers 429 with a pinned
 *      `Retry-After: 30` hint (30000 ms) on the first attempt
 *      and 200 on the second, with `backoffMs` 100, an
 *      injected recording `sleepImpl`, and
 *      `maxRetryDelayMs` 5000 (see the Retry-After cap fixture
 *      below). This is the runaway-hint guard every hinted
 *      retry pays: the hint wins over exponential backoff
 *      only after `Math.min(hinted, maxRetryDelayMs)`
 *      clamps it, so a faulty or malicious server cannot
 *      stall delivery with an absurd hint. Its cost was
 *      previously invisible inside the single-target row
 *      (group 28), whose 200-immediately script never
 *      retries at all. Every timed iteration checks the
 *      result is `{ ok: true, attempts: 2, status: 200 }`,
 *      exactly two captured calls went to the pinned URL
 *      with byte-identical signed bodies, and the recording
 *      sleep received exactly the clamped 5000 ms (the
 *      100 ms backoff base never ran). Outside the timed
 *      loop, three probes pin the neighbouring branches: a
 *      429 without a hint falls back to the exponential
 *      backoff base (100 ms), a hint below the cap
 *      (`Retry-After: 2`) is honored exactly (2000 ms), and
 *      a 500 carrying a `Retry-After` header is NOT a hint
 *      (only 429 hints are read) and also falls back to the
 *      backoff base. Zero network, zero randomness, and no
 *      real waiting: the recording sleep never sleeps.
 *
 *  38. dispatch payout-reference enforcement —
 *      `dispatch("PAYOUT_COMPLETE", { payoutRef })` on a fresh
 *      task constructed with `{ requirePayoutRef: true }` and
 *      driven through the pinned lifecycle steps to
 *      PAYOUT_PENDING under fixed timestamps (see the
 *      requirePayoutRef fixture below). This is the
 *      settlement-reconciliation guard every enforced payout
 *      pays: a `PAYOUT_COMPLETE` without a non-empty
 *      `payoutRef` is rejected at dispatch time, before any
 *      audit entry is written, so a settlement can never
 *      enter the audit trail without naming the transfer it
 *      claims. Its cost was previously invisible inside the
 *      plain dispatch row (group 1), whose tasks never enable
 *      the option. Every timed iteration rebuilds a fresh
 *      enforced task to PAYOUT_PENDING (the final dispatch
 *      mutates it to PAID, so no task can serve two
 *      iterations — the rebuild cost is inside the timed
 *      region, the same accounting the watchdog-execution
 *      rows use), dispatches `PAYOUT_COMPLETE` with the
 *      pinned payoutRef and payoutAmount, and checks the
 *      return is PAID, the history grew to exactly 8 entries,
 *      and the last entry is the pinned settlement entry
 *      (seq 8, `PAYOUT_COMPLETE`, at BASE + 7s, carrying the
 *      pinned payoutRef verbatim). Outside the timed loop, a
 *      ref-less dispatch on an enforced task is pinned to
 *      throw the exact pinned error and leave state and
 *      history untouched, and a default task (option unset)
 *      is pinned to still settle without a reference. No
 *      network, no randomness, and no wall clock: every
 *      dispatch timestamp is fixed.
 *
 *  39. payout webhook AbortSignal pre-abort delivery —
 *      `deliverPayoutWebhook(url, webhook)` delivering the
 *      module-scope signed webhook to the single-target
 *      endpoint through an injected counting fake fetch,
 *      with a pre-aborted external `signal` on every
 *      iteration (see the AbortSignal pre-abort fixture
 *      below). This is the deterministic cancellation
 *      guard every externally-signalled delivery pays
 *      before it starts: the signal is already aborted,
 *      so no request may be made at all and the abort is
 *      reported — never thrown, per this module's
 *      convention — instead of starting a delivery the
 *      caller has already cancelled. Its cost was
 *      previously invisible inside the single-target row
 *      (group 28), whose script never carries a signal at
 *      all. Every timed iteration checks the result is
 *      exactly `{ ok: false, attempts: 0,
 *      error: "payout webhook delivery aborted" }` with
 *      no status, and that the counting fetch was never
 *      called. Outside the timed loop, a non-`AbortSignal`
 *      signal value is pinned to throw its exact
 *      configuration error before any request, and a
 *      signal that never aborts is pinned to leave the
 *      normal delivery unchanged (`{ ok: true,
 *      attempts: 1, status: 200 }` after exactly one
 *      fetch call). Zero network, zero randomness, zero
 *      real sleep, and no wall clock: the signal is
 *      aborted once, before the timed loop, and the
 *      injected sleep is a no-op that is never reached.
 *
 *  40. payout webhook maxAgeMs freshness-window verification —
 *      `verifyPayoutWebhook(body, signature, secret,
 *      { maxAgeMs, now })` over the module-scope signed
 *      webhook with an injected receiver `now` 60 seconds
 *      after signing and a 300,000 ms (5 minute) window on
 *      every iteration (see the maxAgeMs fixture below).
 *      This is the opt-in replay bound every freshness-
 *      checking receiver pays after the signature matches:
 *      a legitimately-signed payload older than the window
 *      must fail closed, even though its signature alone
 *      would verify forever. Its cost was previously
 *      invisible inside the plain verify row (group 4),
 *      whose options never carry a freshness window at
 *      all. Every timed iteration checks the verdict is
 *      exactly true (an age of 60,000 ms inside the
 *      window). Outside the timed loop, a payload aged
 *      1 ms past the window is pinned to false, a payload
 *      aged exactly `maxAgeMs` is pinned to true (the
 *      boundary is inclusive: only `now - at > maxAgeMs`
 *      fails), and an illegal `maxAgeMs` of -1 is pinned
 *      to throw its exact configuration error. Zero
 *      network, zero randomness, and no wall clock: the
 *      signing time and every receiver `now` are injected
 *      fixed instants.
 *
 *  41. payout webhook maxFutureSkewMs future-skew verification —
 *      `verifyPayoutWebhook(body, signature, secret,
 *      { maxFutureSkewMs, now })` over the module-scope signed
 *      webhook with an injected receiver `now` 60 seconds
 *      before signing and a 300,000 ms (5 minute) window on
 *      every iteration (see the maxFutureSkewMs fixture
 *      below). This is the future side of the two-sided
 *      freshness window every freshness-checking receiver
 *      pays after the signature matches: a legitimately-
 *      signed payload dated further in the future than the
 *      window must fail closed, even though a `maxAgeMs`-
 *      only check would pass it (a negative age always
 *      passes) and its signature alone would verify
 *      forever — without this bound a far-future timestamp
 *      gains a near-unbounded replay window. Its cost was
 *      previously invisible inside the plain verify row
 *      (group 4) and the maxAgeMs row (group 40), whose
 *      options never bound the future direction at all.
 *      Every timed iteration checks the verdict is
 *      exactly true (a future skew of 60,000 ms inside
 *      the window). Outside the timed loop, a payload
 *      1 ms beyond the window is pinned to false, a
 *      payload skewed exactly `maxFutureSkewMs` is
 *      pinned to true (the boundary is inclusive: only
 *      `at - now > maxFutureSkewMs` fails), the two-sided
 *      window formed with `maxAgeMs` is pinned on all
 *      three sides (inside both bounds true, beyond the
 *      future bound false, beyond the age bound false),
 *      and an illegal `maxFutureSkewMs` of -1 is pinned
 *      to throw its exact configuration error. Zero
 *      network, zero randomness, and no wall clock: the
 *      signing time and every receiver `now` are injected
 *      fixed instants.
 *
 *  42. dispatch optimistic-concurrency guard —
 *      `dispatch("START_CAPTURE", { expectedSeq: 2 })` on a
 *      fresh task driven under fixed timestamps to a pinned
 *      2-entry history (PUBLISH, ACCEPT) on every iteration
 *      (see the expectedSeq fixture below). This is the
 *      stale-snapshot guard every concurrent writer pays
 *      before any other dispatch check: the caller asserts
 *      the history length it based its decision on, and a
 *      task that has moved on fails loudly with a dispatch
 *      conflict instead of silently advancing a state the
 *      caller never saw. Its cost was previously invisible
 *      inside the plain dispatch row (group 1), whose
 *      dispatches never carry the guard. Every timed
 *      iteration rebuilds a fresh task to the pinned
 *      2-entry history (the guarded dispatch mutates it,
 *      so no task can serve two iterations — the rebuild
 *      cost is inside the timed region), dispatches
 *      `START_CAPTURE` with the correct `expectedSeq`,
 *      and checks the return is CAPTURING, the history
 *      grew by exactly one entry to 3, and the last entry
 *      is the pinned step (seq 3, `START_CAPTURE`, at
 *      BASE + 2s). Outside the timed loop, a stale
 *      `expectedSeq` is pinned to throw the exact pinned
 *      conflict error and leave state and history
 *      byte-identical (compared through the canonical
 *      NDJSON serializer), `expectedSeq: 0` on an empty
 *      history is pinned to advance, illegal values
 *      (-1 and 1.5) are pinned to throw their exact
 *      configuration errors, and dispatch without
 *      `expectedSeq` is pinned to behave unchanged. No
 *      network, no randomness, and no wall clock: every
 *      dispatch timestamp is fixed.
 *
 *  43. dispatch dispute budget — `dispatch("DISPUTE")` on a
 *      fresh task constructed with the pinned budget
 *      `maxDisputes: 1` and driven under fixed timestamps
 *      to a pinned 6-entry history in REJECTED on every
 *      iteration (see the maxDisputes fixture below). This
 *      is the appeal-round cap a moderation deployment
 *      pays on every contested rejection: the transition
 *      table alone would let REJECTED -> DISPUTED ->
 *      ARBITRATE_REJECT -> REJECTED loop forever, and the
 *      budget check (which runs after the RESUBMIT budget
 *      check) is what closes the loop. Its cost was
 *      previously invisible inside the plain dispatch row
 *      (group 1), whose tasks carry no budget, and inside
 *      the snapshot row, where `maxDisputes` appears only
 *      as a fixture field, never as a timed constructor
 *      option. Every timed iteration rebuilds a fresh
 *      budgeted task to REJECTED (the DISPUTE dispatch
 *      spends the single budget unit and mutates the task,
 *      so no task can serve two iterations — the rebuild
 *      cost is inside the timed region), spends the one
 *      DISPUTE, and checks the return is DISPUTED, the
 *      history grew by exactly one entry to 7, and the
 *      last entry is the pinned step (seq 7, `DISPUTE`,
 *      at BASE + 6s). Outside the timed loop, a second
 *      DISPUTE after one full appeal round is pinned to
 *      throw the exact pinned budget error and leave state
 *      and history byte-identical (compared through the
 *      canonical NDJSON serializer), a budget of 0 is
 *      pinned to make the first DISPUTE throw at once, a
 *      task built without the option is pinned to run
 *      repeated appeal rounds (the pre-budget default), a
 *      snapshot round-trip is pinned to keep the budget
 *      exhausted (the used count is history-derived, so
 *      it does not reset), and illegal budgets (-1 and
 *      1.5) are pinned to throw their exact `invalid
 *      option` errors at construction, with an illegal
 *      snapshot budget pinned to its exact `invalid
 *      snapshot` error. No network, no randomness, and no
 *      wall clock: every dispatch timestamp is fixed.
 *
 *  44. payout webhook timeoutMs timeout delivery —
 *      `deliverPayoutWebhook(url, webhook)` delivering the
 *      module-scope signed webhook to the single-target
 *      endpoint through an injected hanging fake fetch,
 *      with `timeoutMs` pinned at 10 and `maxAttempts: 1`
 *      on every iteration (see the timeoutMs timeout
 *      fixture below). This is the per-attempt deadline
 *      every delivery to a slow or hung receiver pays:
 *      the fake never answers on its own and only settles
 *      when the per-attempt abort fires, so the pinned
 *      short timeout is the only thing that can end the
 *      attempt. Its cost was previously invisible inside
 *      the single-target row (group 28), whose fake fetch
 *      answers 200 immediately and never reaches the
 *      timer at all. Every timed iteration checks the
 *      reported result is exactly `{ ok: false,
 *      attempts: 1, error: "webhook delivery timed out
 *      after 10ms" }` with no status, and that the hanging
 *      fetch was called exactly once. Outside the timed
 *      loop, an illegal `timeoutMs` of 0 is pinned to
 *      throw its exact configuration error before any
 *      request (zero fetch calls), and a generous
 *      `timeoutMs` of 5000 over an immediately-200 fake
 *      is pinned to the unchanged normal delivery
 *      (`{ ok: true, attempts: 1, status: 200 }` after
 *      exactly one fetch call). Honest limit: the timeout
 *      wait itself is the object under test, at its
 *      pinned short length of 10 ms, and no elapsed-time
 *      assertion is made anywhere. Zero network and zero
 *      randomness: the injected sleep is a no-op that is
 *      never reached with `maxAttempts: 1`.
 *
 *  45. dispatch rolePolicy authorization — `dispatch("ACCEPT")`
 *      on a fresh task constructed with the pinned
 *      `rolePolicy: { ACCEPT: ["reviewer"] }` and driven
 *      under fixed timestamps to a pinned 1-entry history in
 *      OPEN on every iteration (see the rolePolicy fixture
 *      below). This is the event-level RBAC check every
 *      dispatch into a policy-covered event pays: the
 *      transition check runs first, then the allowlist
 *      gates the actor before any history is appended. Its
 *      cost was previously invisible inside the plain
 *      dispatch row (group 1), whose tasks carry no policy,
 *      and inside the snapshot row, where `rolePolicy`
 *      appears only as a fixture field annotated "none
 *      set", never as a timed constructor option. Every
 *      timed iteration rebuilds a fresh policy-carrying
 *      task to OPEN (the ACCEPT dispatch advances the task
 *      to ACCEPTED, so no task can serve two iterations —
 *      the rebuild cost is inside the timed region),
 *      dispatches the one authorized ACCEPT, and checks the
 *      return is ACCEPTED, the history grew by exactly one
 *      entry to 2, and the last entry is the pinned step
 *      (seq 2, `ACCEPT`, at BASE + 1s, actor
 *      "reviewer"). Outside the timed loop, an
 *      unauthorized actor ("viewer") is pinned to throw
 *      exactly `actor not authorized for ACCEPT: "viewer"
 *      is not in [reviewer]` and leave state and
 *      history byte-identical (compared through the
 *      canonical NDJSON serializer), a missing actor is
 *      pinned to throw exactly `actor not authorized for
 *      ACCEPT: policy requires an actor in [reviewer]`
 *      the same untouched way, and a task built without a
 *      policy is pinned to advance the same actorless
 *      ACCEPT with no authorization check (the pre-RBAC
 *      default). No network, no randomness, and no wall
 *      clock: every dispatch timestamp is fixed.
 *
 *  46. dispatch retry budget — `dispatch("RESUBMIT")` on a
 *      fresh task constructed with the pinned budget
 *      `maxResubmits: 2` and driven under fixed timestamps
 *      to a pinned 6-entry history in REJECTED on every
 *      iteration (see the maxResubmits fixture below). This
 *      is the resubmit cap a retry-heavy deployment pays on
 *      every contested rejection: the transition table
 *      alone would let REJECTED -> CAPTURING -> SUBMITTED
 *      -> IN_REVIEW -> REJECTED loop forever, and the
 *      history-derived budget check (which runs after the
 *      transition legality check, before the audit entry is
 *      appended) is what closes the loop. Its cost was
 *      previously invisible inside the plain dispatch row
 *      (group 1), whose tasks carry no budget, and inside
 *      the snapshot row, where `maxResubmits` appears only
 *      as a fixture field, never as a timed constructor
 *      option. Every timed iteration rebuilds a fresh
 *      budgeted task to REJECTED (the RESUBMIT dispatch
 *      spends one budget unit and mutates the task to
 *      CAPTURING, so no task can serve two iterations —
 *      the rebuild cost is inside the timed region),
 *      spends the one RESUBMIT, and checks the return is
 *      CAPTURING, the history grew by exactly one entry to
 *      7, and the last entry is the pinned step (seq 7,
 *      `RESUBMIT`, REJECTED -> CAPTURING, at BASE + 6s,
 *      actor "contributor"). Outside the timed loop, a
 *      third RESUBMIT after two full resubmit rounds is
 *      pinned to throw exactly `resubmit budget exhausted:
 *      2 of 2 RESUBMITs already used` and leave state and
 *      history byte-identical (compared through the
 *      canonical NDJSON serializer), a budget of 0 is
 *      pinned to make the first RESUBMIT throw at once, a
 *      task built without the option is pinned to run
 *      repeated resubmit rounds (the pre-budget default),
 *      and illegal budgets (-1 and 1.5) are pinned to
 *      throw their exact `invalid option` errors at
 *      construction, with an illegal snapshot budget
 *      pinned to its exact `invalid snapshot` error. No
 *      network, no randomness, and no wall clock: every
 *      dispatch timestamp is fixed.
 *
 *  47. policy snapshot round-trip — `toJSON()` -> JSON text
 *      -> `TaskLifecycle.fromJSON()` over a fixed task that
 *      carries a pinned `rolePolicy` and finite
 *      `maxResubmits` / `maxDisputes` budgets (see the policy
 *      snapshot fixture below). This is the persistence path
 *      groups 43/45/46 exercise only in fragments: an RBAC
 *      policy and finite budgets must survive a restart with
 *      their enforcement intact — the rolePolicy allowlist
 *      must come back verbatim, and the history-derived used
 *      counts must not reset when the snapshot is
 *      rehydrated. One timed pass is one export to JSON text
 *      plus one strict rehydration of the 10-entry REJECTED
 *      snapshot; its per-iteration self-check pins the
 *      restored state, the full history entry for entry, the
 *      history-derived used RESUBMIT / DISPUTE counts, the
 *      envelope's pinned rolePolicy and finite budget
 *      fields, and the re-export fixed point to the
 *      hand-written expectations. Outside the timed loop,
 *      two probe dispatches pin the post-restore
 *      enforcement side: an unauthorized actor on the
 *      policy-covered DISPUTE is rejected with the pinned
 *      authorization wording while the appeal budget is
 *      still unspent, and an authorized RESUBMIT is
 *      rejected with the pinned exhaustion wording — the
 *      budget is history-derived, so persistence does not
 *      reset it; both rejections leave state and history
 *      byte-identical. No network, no randomness, and no
 *      wall clock: every dispatch timestamp is fixed.
 *
 *  48. dispatch explicit timestamp — `dispatch("START_CAPTURE",
 *      { at })` with a pinned canonical ISO-8601 `at` on a
 *      fresh task driven under fixed timestamps to a pinned
 *      2-entry ACCEPTED history on every iteration (see the
 *      dispatchAt fixture below). This is the audit-determinism
 *      path: the injected `at` lands verbatim in the history
 *      entry, replacing the wall-clock read the plain dispatch
 *      paths (group 1) pay on every append — the bench never
 *      timed this core reproducibility path before (its
 *      coverage existed only as unit tests in
 *      test/dispatchAt.test.ts). The rebuild cost is inside the
 *      timed region because the timestamped dispatch advances
 *      the task to CAPTURING. Its per-iteration self-check pins
 *      the CAPTURING return, the exactly-3-entry history, and
 *      the last entry's pinned step fields (seq 3,
 *      `START_CAPTURE`, `at` byte-identical to the injected
 *      BASE + 2s value, actor "reviewer"). Outside the timed
 *      loop, a non-canonical `at` ("not-a-date") is pinned to
 *      throw exactly `invalid dispatch options: at must be
 *      canonical ISO-8601, got not-a-date` and leave state and
 *      history byte-identical (compared through the canonical
 *      NDJSON serializer) — the fail-fast rule the
 *      dispatchAt unit tests pin. No network, no randomness,
 *      and no wall clock: every dispatch timestamp is fixed.
 *
 *  49. history getter defensive copy — `get history()` on a fixed
 *      task carrying 64 hash-chained entries (see the
 *      history-getter fixture below): one getter call per timed
 *      iteration. This is
 *      the read a polling UI or an audit exporter pays every
 *      time it looks at the audit trail: the accessor copies
 *      all n entries and Object.freeze's each one, so the
 *      guarantee that the append-only audit log cannot be
 *      rewritten at runtime carries an O(n) tax that no earlier
 *      row timed — the subscribe / replay / snapshot rows all
 *      read history too, but their rows never isolated the
 *      getter itself. Its per-iteration self-check pins the
 *      hand-written expectations: exactly 64 entries, the array
 *      and every entry frozen, the snapshot content
 *      byte-identical to the fixture baseline, and consecutive
 *      calls never sharing entry references (detached copies).
 *      Outside the timed loop, one-off probes pin that a push,
 *      a splice, and an entry-field write on the returned
 *      snapshot all throw and leave the internal history
 *      untouched — the same assertions the historyFreeze unit
 *      tests pin (test/historyFreeze.test.ts). No network, no
 *      randomness, and no wall clock: every dispatch timestamp
 *      is fixed at fixture build.
 *
 *  50. SLA approaching-deadline screening — `tasksApproachingDeadline`
 *      over a fixed batch of 6 tasks under one injected fixed `now`
 *      with a 24-hour window (see the approaching-deadline fixture
 *      below): one deadline inside the window, one exactly on the
 *      upper bound, one exactly on the lower bound, one already
 *      past, one task with no deadline, and one terminal PAID task
 *      whose deadline falls inside the window. This is the
 *      warn-before-it-is-too-late pass a watchdog runs before the
 *      overdue pass: the half-open window `(now, now + withinMs]`
 *      means the upper-bound task is approaching (inclusive) while
 *      the lower-bound task is already overdue (exclusive) and
 *      belongs to `expiredTasks`, never to both. Its
 *      per-iteration self-check pins the hand-written selection
 *      [AP-01, AP-02] — the screening is pure, so the same batch
 *      serves every iteration with no rebuild. Outside the timed
 *      loop, the overdue contrast is pinned once: `expiredTasks`
 *      over the same batch returns exactly [AP-03, AP-04]. No
 *      network, no randomness, and no wall clock: every deadline
 *      and the screening `now` are fixed at fixture build.
 *
 *  51. State-filter listing — `tasksByState` over the fixed
 *      12-task watchdog batch (see the watchdog fixture below):
 *      the timed loop filters for OPEN, self-checking the
 *      hand-pinned slice [WD-01, WD-02, WD-08, WD-12] in input
 *      order holding the same task objects (the #562
 *      order-preservation / same-object semantics, not a copy).
 *      Outside the timed loop, the terminal contrast is pinned
 *      once: `tasksByState(batch, "PAID")` returns exactly
 *      [WD-03] — terminal states filter like any other — and an
 *      unknown state fails fast with the exact
 *      `invalid tasksByState` error instead of an empty list.
 *      The screening is pure, so the same batch serves every
 *      iteration with no rebuild. No network, no randomness,
 *      and no wall clock: states come from the fixed fixture.
 *
 *  52. Actor-filter listing — `tasksByActor` over a fixed
 *      6-task mixed-actor batch (see the actor fixture below):
 *      the timed loop filters for "moderator", self-checking
 *      the hand-pinned slice [BENCH-ACTOR-01, BENCH-ACTOR-02,
 *      BENCH-ACTOR-04] in input order holding the same task
 *      objects — the twice-touched task matches exactly once,
 *      the anonymous task and the no-history task match
 *      nothing. Outside the timed loop, the contributor
 *      contrast is pinned once: `tasksByActor(batch,
 *      "contributor")` returns exactly [BENCH-ACTOR-02,
 *      BENCH-ACTOR-05] — and an empty actor fails fast with
 *      the exact `invalid tasksByActor` error instead of an
 *      empty list. The filter is pure, so the same batch
 *      serves every iteration with no rebuild. No network,
 *      no randomness, and no wall clock: actors come from
 *      the fixed fixture, mirroring the #589 demo semantics.
 *
 *  53. Minor-unit display formatting — `formatMinorUnits`
 *      over the fixed 11-vector demo corpus (see the demo
 *      segment below): the timed loop formats every vector
 *      plus the finance-pass total (1634900 minor units) and
 *      self-checks each output against the demo's pinned
 *      strings — positive, zero, negative, -0 (which renders
 *      without a minus sign), large, and MAX_SAFE_INTEGER
 *      (exact through integer arithmetic, never float
 *      division). Outside the timed loop, a fractional input
 *      fails fast with the exact `minor units must be an
 *      integer` error instead of a rounded string. Pure, so
 *      no fixture rebuild is needed. No network, no
 *      randomness, and no wall clock.
 *
 *  54. Minor-unit conversion — `toMinorUnits` /
 *      `fromMinorUnits` over a fixed 4-vector corpus (the
 *      finance-pass total 16349 major units ↔ 1634900 minor
 *      units, zero, a negative amount, and the 0.33
 *      round-trip), plus the 0.333 nearest-cent rounding
 *      vector: the timed loop converts every vector both
 *      ways and self-checks each result against its pinned
 *      value, and pins `toMinorUnits(0.333)` to 33 (round,
 *      never truncate). Outside the timed loop, a
 *      fractional minor input fails fast with the exact
 *      `minor units must be an integer` error instead of a
 *      rounded amount. Pure, so no fixture rebuild is
 *      needed. No network, no randomness, and no wall
 *      clock.
 *  55. Payout webhook fan-out limits — `deliverPayoutWebhookToMany`
 *      under `maxEndpoints` / `overallDeadlineMs`: the timed loop
 *      runs the deadline case (3 endpoints, two answering 200 at
 *      once and one hanging until its abort signal fires, under a
 *      pinned 50 ms overall budget), self-checking the two kept
 *      { ok: true, attempts: 1, status: 200 } results, the
 *      deadline-stopped { ok: false, attempts: 1 } result carrying
 *      the deadline timeout error (not the plain abort text),
 *      delivered 2 / failed 1 with deadlineExceeded true, and
 *      exactly 3 fetch calls, one per endpoint. Outside the timed
 *      loop, 3 endpoints under maxEndpoints 2 throw the pinned
 *      over-cap configuration error with zero fetch calls. Honest
 *      limit: the 50 ms deadline wait is the behaviour under test
 *      itself, so this row's throughput is deadline-bound, not a
 *      measure of fan-out overhead — compare the plain 4-endpoint
 *      row for that. No elapsed wall-clock duration is asserted.
 *
 *  56. Payout webhook jitterMs backoff — `deliverPayoutWebhook`
 *      with `jitterMs` over a 500 / 500 / 200 script (backoffMs
 *      100, maxAttempts 3, injected recording sleep): one timed
 *      pass is two deliveries — the jittered script, whose two
 *      sleeps must land inside [100, 1100] and [200, 1200]
 *      (exponential bases 100 and 200 plus a uniform
 *      Math.random() * 1000 spread), and the zero-jitter
 *      control, whose sleeps must be exactly [100, 200]. The
 *      timed loop asserts bounds only, never exact values or
 *      variation: with live Math.random an exact sleep is
 *      unknowable in advance. Outside the timed loop, a
 *      stubbed Math.random sequence [0, 0.5] pins the exact
 *      jittered sleeps [100, 700] and the zero-jitter sleeps
 *      [100, 200], and the stub's restore is asserted. No
 *      network and no real waiting: the sleep only records.
 *
 *  57. Payout webhook delivery-header verification —
 *      `deliverPayoutWebhook` against a real loopback HTTP server
 *      answering 500 then 200 (backoffMs 0, no-op sleep, default
 *      fetch): one timed pass is one delivery, self-checked per
 *      iteration for result { ok: true, attempts: 2, status: 200 }
 *      with exactly two captured requests, every attempt carrying
 *      `Idempotency-Key` and `X-Event-Id` both equal to the body
 *      `eventId` (the same value across the retry, never a fresh id
 *      per attempt), and both request bodies byte-identical to the
 *      signed body. Outside the timed loop, the captured
 *      `X-Hub-Signature-256` is pinned equal to the build-time
 *      signature and verified over the captured body — the two
 *      headers are transport hints outside signature coverage, so a
 *      receiver must verify the body first and deduplicate on the
 *      verified body's `eventId`, never on a header alone. Honest
 *      limit: the loopback round trips are the behaviour under
 *      test, so this row's throughput is local-HTTP-bound, not a
 *      measure of delivery logic overhead — compare the injected
 *      fake-fetch single-endpoint row for that. No elapsed
 *      wall-clock duration is asserted.
 *
 *  58. Payout webhook fan-out jitterMs backoff —
 *      `deliverPayoutWebhookToMany` to 4 fixed endpoints, every
 *      endpoint answering 500 / 500 / 200 with backoffMs 100,
 *      maxAttempts 3, and jitterMs 1000 at the call level: one
 *      timed pass is two fan-outs — the jittered fan-out, whose
 *      per-endpoint sleeps must land inside [100, 1100] and
 *      [200, 1200] (each endpoint records its own sleeps, because
 *      the deliveries run concurrently and a shared recorder
 *      could not pin per-endpoint windows), and the zero-jitter
 *      control fan-out, whose per-endpoint sleeps must be exactly
 *      [100, 200]. Every endpoint must report { ok: true,
 *      attempts: 3, status: 200 } with exactly 3 fetch calls, so
 *      a retrying endpoint never consumes or blocks another's
 *      budget. The timed loop asserts bounds only, never exact
 *      values; the exact [100, 700] spread is pinned by the
 *      single-endpoint jitter row, not repeated here, because
 *      under concurrency the endpoints share the global
 *      Math.random and draw order is nondeterministic. Outside
 *      the timed loop, every endpoint's final call body carries
 *      the shared eventId and verifies under that endpoint's own
 *      secret. No network and no real waiting: every sleep only
 *      records.
 *
 *  59. payout webhook secrets-rotation x maxFutureSkewMs
 *      combination verification — `verifyPayoutWebhook` with
 *      `{ secrets: [new, old], maxFutureSkewMs, now }` over the
 *      fixed webhook (signed with the OLD secret at the fixed
 *      `WEBHOOK_NOW` / `WEBHOOK_EVENT_ID`, so the matching
 *      candidate is the SECOND one tried) with an injected
 *      receiver `now` 60 seconds before signing and a 300,000 ms
 *      (5 minute) future-skew window on every iteration (see
 *      the rotation x future-skew fixture below). This is the
 *      steady-state receiver cost inside a rotation window
 *      when the sender clock runs ahead: every delivery pays
 *      one failed HMAC trial before the match (the rotation
 *      row, group 36) AND the freshness gate after the match
 *      (the future-skew row, group 41) — the semantic anchor
 *      is that the freshness gate runs only after a signature
 *      matches, so rotation matching comes first and the skew
 *      rejection second, and neither row alone exercises the
 *      pair. Every timed iteration checks the verdict is
 *      exactly true (a future skew of 60,000 ms inside the
 *      window, matched by the second candidate). Outside the
 *      timed loop, a payload skewed exactly `maxFutureSkewMs`
 *      under rotation is pinned to true (the inclusive
 *      boundary, same as the single-secret row), a payload
 *      1 ms beyond the window under rotation is pinned to
 *      false (the skew gate rejects even a correctly
 *      rotation-matched signature), and an all-mismatch
 *      candidate pair under the same skew window is pinned to
 *      false both inside and beyond the window (the failure
 *      is signature-driven and skew-independent: no
 *      freshness window can rescue a signature that never
 *      matched). No network, no randomness, and no wall
 *      clock: the signed fixture is built once from pinned
 *      secret / timestamp / eventId and every receiver `now`
 *      is an injected fixed instant.
 *
 *  60. payout webhook verify x dedupe receiver flow —
 *      `verifyPayoutWebhook` followed by
 *      `PayoutEventDedupe.checkAndRecord()` over the fixed signed
 *      webhook, one measured op per receiver pass (see the
 *      receiver-flow fixture below). This is the #726 test row's
 *      bench variant: the per-delivery cost a receiver actually
 *      pays, which neither the verify-only rows nor the
 *      dedupe-only rows exercise together. One measured op runs
 *      three deliveries: a first sighting (the genuine body
 *      verifies true, a fresh id records as first-seen), its
 *      redelivery (the same body verifies true again, the same
 *      id reports duplicate), and a tampered delivery (the
 *      tampered body verifies false, so the receiver never
 *      reaches the dedupe step — proven by a later genuine
 *      delivery carrying the tampered delivery's claimed id
 *      still recording as first-seen). The dedupe step takes
 *      the id string, not the body, so the timed path uses
 *      per-iteration synthetic ids standing in for
 *      `payload.eventId`; the verify steps run over the real
 *      fixed signed body and its one-character-tampered twin.
 *      No network, no randomness, no wall clock: the dedupe
 *      runs under an injected fixed clock, so no entry expires
 *      or is evicted in the timed loop.
 *
 *  61. payout webhook fan-out x dedupe receiver flow —
 *      `deliverPayoutWebhookToMany` followed, per endpoint, by
 *      `verifyPayoutWebhook` under that endpoint's own secret and
 *      `PayoutEventDedupe.checkAndRecord()` on the shared eventId
 *      (see the fan-out receiver fixture below). This is the #740
 *      test row's bench variant: the per-delivery cost each of the
 *      4 receivers actually pays when one settlement event fans
 *      out, which neither the fan-out-only row nor the
 *      single-endpoint receiver-flow row exercises together. One
 *      measured op runs two fan-outs of one fresh eventId: the
 *      first fan-out's 4 copies each verify and record as a first
 *      sighting, and the redelivery fan-out's 4 copies each verify
 *      again but report duplicate. Each endpoint owns an
 *      independent dedupe under the same injected fixed clock
 *      (capacity 100,000, so the 3,200 ids recorded per dedupe
 *      across warmup + timed calls never evict). No network, no
 *      randomness, no wall clock: the fan-out uses the injected
 *      fake fetch that answers 200 immediately.
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
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  actOnStaleTasks,
  allowedEvents,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  deliverPayoutWebhook,
  deliverPayoutWebhookToMany,
  expiredTasks,
  expireOverdueTasks,
  formatMinorUnits,
  fromMinorUnits,
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
  tasksApproachingDeadline,
  tasksByActor,
  tasksByState,
  totalPaidOut,
  toMinorUnits,
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
  type RolePolicy,
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
const WEBHOOK_ROTATION_NEW_SECRET = "bench-payout-webhook-secret-new";
const WEBHOOK_ROTATION_UNRELATED_SECRET =
  "bench-payout-webhook-secret-unrelated";
const WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR =
  "cannot verify payout webhook: secrets must be a non-empty array";
const WEBHOOK_MAX_AGE_MS = 300_000;
const WEBHOOK_MAX_AGE_NOW = new Date(WEBHOOK_NOW.getTime() + 60_000);
const WEBHOOK_MAX_AGE_OPTS = {
  maxAgeMs: WEBHOOK_MAX_AGE_MS,
  now: WEBHOOK_MAX_AGE_NOW,
};
const WEBHOOK_MAX_AGE_BOUNDARY_NOW = new Date(
  WEBHOOK_NOW.getTime() + WEBHOOK_MAX_AGE_MS,
);
const WEBHOOK_MAX_AGE_BEYOND_NOW = new Date(
  WEBHOOK_NOW.getTime() + WEBHOOK_MAX_AGE_MS + 1,
);
const WEBHOOK_MAX_AGE_ILLEGAL_ERROR =
  "cannot verify payout webhook: maxAgeMs must be a finite non-negative number, got -1";
const WEBHOOK_MAX_FUTURE_SKEW_MS = 300_000;
const WEBHOOK_MAX_FUTURE_SKEW_NOW = new Date(WEBHOOK_NOW.getTime() - 60_000);
const WEBHOOK_MAX_FUTURE_SKEW_OPTS = {
  maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
  now: WEBHOOK_MAX_FUTURE_SKEW_NOW,
};
const WEBHOOK_MAX_FUTURE_SKEW_BOUNDARY_NOW = new Date(
  WEBHOOK_NOW.getTime() - WEBHOOK_MAX_FUTURE_SKEW_MS,
);
const WEBHOOK_MAX_FUTURE_SKEW_BEYOND_NOW = new Date(
  WEBHOOK_NOW.getTime() - WEBHOOK_MAX_FUTURE_SKEW_MS - 1,
);
const WEBHOOK_MAX_FUTURE_SKEW_ILLEGAL_ERROR =
  "cannot verify payout webhook: maxFutureSkewMs must be a finite non-negative number, got -1";

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
// Secret-rotation fixture checks, outside the timed loop: the main
// webhook above is signed with WEBHOOK_SECRET, which plays the OLD
// secret; under { secrets: [new, old] } it must verify (the match is
// the second candidate tried), a candidate pair with no match must
// return false without throwing, and an empty candidate set must
// throw the pinned configuration error.
const WEBHOOK_ROTATION_OPTS = {
  secrets: [WEBHOOK_ROTATION_NEW_SECRET, WEBHOOK_SECRET],
};
if (
  !verifyPayoutWebhook(
    webhookBody,
    webhook.signature,
    undefined,
    WEBHOOK_ROTATION_OPTS,
  )
) {
  throw new Error("benchmark fixture failed: webhook rotation verify");
}
if (
  verifyPayoutWebhook(webhookBody, webhook.signature, undefined, {
    secrets: [WEBHOOK_ROTATION_NEW_SECRET, WEBHOOK_ROTATION_UNRELATED_SECRET],
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook rotation all-mismatch must be false",
  );
}
let webhookRotationEmptyError = "";
try {
  verifyPayoutWebhook(webhookBody, webhook.signature, undefined, {
    secrets: [],
  });
} catch (err) {
  webhookRotationEmptyError = err instanceof Error ? err.message : String(err);
}
if (webhookRotationEmptyError !== WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR) {
  throw new Error(
    "benchmark fixture failed: webhook rotation empty secrets error mismatch",
  );
}
// maxAgeMs freshness fixture checks, outside the timed loop: the
// main webhook above is signed at WEBHOOK_NOW; under
// { maxAgeMs: 300000, now: WEBHOOK_NOW + 60s } it must verify (an
// age of 60,000 ms inside the 5-minute window), exactly at the
// inclusive boundary (now = at + maxAgeMs) it must still verify,
// 1 ms past the window it must return false without throwing,
// and an illegal maxAgeMs of -1 must throw the pinned
// configuration error.
if (
  !verifyPayoutWebhook(
    webhookBody,
    webhook.signature,
    WEBHOOK_SECRET,
    WEBHOOK_MAX_AGE_OPTS,
  )
) {
  throw new Error("benchmark fixture failed: webhook maxAgeMs verify");
}
if (
  !verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET, {
    maxAgeMs: WEBHOOK_MAX_AGE_MS,
    now: WEBHOOK_MAX_AGE_BOUNDARY_NOW,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook maxAgeMs boundary must be true",
  );
}
if (
  verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET, {
    maxAgeMs: WEBHOOK_MAX_AGE_MS,
    now: WEBHOOK_MAX_AGE_BEYOND_NOW,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook maxAgeMs over-age must be false",
  );
}
let webhookMaxAgeIllegalError = "";
try {
  verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET, {
    maxAgeMs: -1,
    now: WEBHOOK_MAX_AGE_NOW,
  });
} catch (err) {
  webhookMaxAgeIllegalError = err instanceof Error ? err.message : String(err);
}
if (webhookMaxAgeIllegalError !== WEBHOOK_MAX_AGE_ILLEGAL_ERROR) {
  throw new Error(
    "benchmark fixture failed: webhook maxAgeMs illegal value error mismatch",
  );
}
// maxFutureSkewMs future-skew fixture checks, outside the timed
// loop: the main webhook above is signed at WEBHOOK_NOW; under
// { maxFutureSkewMs: 300000, now: WEBHOOK_NOW - 60s } it must
// verify (a future skew of 60,000 ms inside the 5-minute
// window), exactly at the inclusive boundary (now = at -
// maxFutureSkewMs) it must still verify, 1 ms beyond the window
// (now = at - maxFutureSkewMs - 1) it must return false without
// throwing, with maxAgeMs also set the two-sided window must
// hold on all three sides (inside both bounds verifies,
// beyond the future bound fails even though the negative age
// passes maxAgeMs, beyond the age bound fails even though the
// skew bound passes), and an illegal maxFutureSkewMs of -1
// must throw the pinned configuration error.
if (
  !verifyPayoutWebhook(
    webhookBody,
    webhook.signature,
    WEBHOOK_SECRET,
    WEBHOOK_MAX_FUTURE_SKEW_OPTS,
  )
) {
  throw new Error("benchmark fixture failed: webhook maxFutureSkewMs verify");
}
if (
  !verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET, {
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: WEBHOOK_MAX_FUTURE_SKEW_BOUNDARY_NOW,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook maxFutureSkewMs boundary must be true",
  );
}
if (
  verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET, {
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: WEBHOOK_MAX_FUTURE_SKEW_BEYOND_NOW,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook maxFutureSkewMs beyond-skew must be false",
  );
}
if (
  !verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET, {
    maxAgeMs: WEBHOOK_MAX_AGE_MS,
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: WEBHOOK_MAX_FUTURE_SKEW_NOW,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook two-sided window inside must be true",
  );
}
if (
  verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET, {
    maxAgeMs: WEBHOOK_MAX_AGE_MS,
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: WEBHOOK_MAX_FUTURE_SKEW_BEYOND_NOW,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook two-sided window future side must be false",
  );
}
if (
  verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET, {
    maxAgeMs: WEBHOOK_MAX_AGE_MS,
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: WEBHOOK_MAX_AGE_BEYOND_NOW,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook two-sided window age side must be false",
  );
}
let webhookMaxFutureSkewIllegalError = "";
try {
  verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET, {
    maxFutureSkewMs: -1,
    now: WEBHOOK_MAX_FUTURE_SKEW_NOW,
  });
} catch (err) {
  webhookMaxFutureSkewIllegalError =
    err instanceof Error ? err.message : String(err);
}
if (webhookMaxFutureSkewIllegalError !== WEBHOOK_MAX_FUTURE_SKEW_ILLEGAL_ERROR) {
  throw new Error(
    "benchmark fixture failed: webhook maxFutureSkewMs illegal value error mismatch",
  );
}
// secrets-rotation x maxFutureSkewMs fixture checks, outside the
// timed loop: the main webhook above is signed with WEBHOOK_SECRET,
// which plays the OLD secret; under { secrets: [new, old],
// maxFutureSkewMs: 300000, now: WEBHOOK_NOW - 60s } it must verify
// (a future skew of 60,000 ms inside the 5-minute window, matched
// by the second candidate — one failed HMAC trial, then the
// freshness gate, in that order), exactly at the inclusive skew
// boundary (now = at - maxFutureSkewMs) it must still verify,
// 1 ms beyond the window it must return false even though the
// rotation match succeeds (the skew gate runs after the match),
// and an all-mismatch candidate pair must return false both
// inside and beyond the window (the failure is signature-driven
// and skew-independent: freshness never rescues a bad signature).
const WEBHOOK_ROTATION_FUTURE_SKEW_OPTS = {
  secrets: [WEBHOOK_ROTATION_NEW_SECRET, WEBHOOK_SECRET],
  maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
  now: WEBHOOK_MAX_FUTURE_SKEW_NOW,
};
if (
  !verifyPayoutWebhook(
    webhookBody,
    webhook.signature,
    undefined,
    WEBHOOK_ROTATION_FUTURE_SKEW_OPTS,
  )
) {
  throw new Error(
    "benchmark fixture failed: webhook rotation x maxFutureSkewMs verify",
  );
}
if (
  !verifyPayoutWebhook(webhookBody, webhook.signature, undefined, {
    secrets: [WEBHOOK_ROTATION_NEW_SECRET, WEBHOOK_SECRET],
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: WEBHOOK_MAX_FUTURE_SKEW_BOUNDARY_NOW,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook rotation x maxFutureSkewMs boundary must be true",
  );
}
if (
  verifyPayoutWebhook(webhookBody, webhook.signature, undefined, {
    secrets: [WEBHOOK_ROTATION_NEW_SECRET, WEBHOOK_SECRET],
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: WEBHOOK_MAX_FUTURE_SKEW_BEYOND_NOW,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook rotation x maxFutureSkewMs beyond-skew must be false",
  );
}
if (
  verifyPayoutWebhook(webhookBody, webhook.signature, undefined, {
    secrets: [WEBHOOK_ROTATION_NEW_SECRET, WEBHOOK_ROTATION_UNRELATED_SECRET],
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: WEBHOOK_MAX_FUTURE_SKEW_NOW,
  }) ||
  verifyPayoutWebhook(webhookBody, webhook.signature, undefined, {
    secrets: [WEBHOOK_ROTATION_NEW_SECRET, WEBHOOK_ROTATION_UNRELATED_SECRET],
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: WEBHOOK_MAX_FUTURE_SKEW_BEYOND_NOW,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook rotation x maxFutureSkewMs all-mismatch must be false",
  );
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
const expectedByStateOpen = [
  watchdogBatch[0],
  watchdogBatch[1],
  watchdogBatch[7],
  watchdogBatch[11],
];
const expectedByStateOpenIds = ["BENCH-WD-01", "BENCH-WD-02", "BENCH-WD-08", "BENCH-WD-12"];
let byStateUnknownThrew = false;
try {
  tasksByState(watchdogBatch, "OPENN" as TaskState);
} catch (error) {
  byStateUnknownThrew =
    error instanceof Error &&
    error.message ===
      'invalid tasksByState: unknown state "OPENN"';
}
if (
  tasksByState(watchdogBatch, "OPEN").map((t) => t.id).join(",") !==
    expectedByStateOpenIds.join(",") ||
  tasksByState(watchdogBatch, "PAID").map((t) => t.id).join(",") !==
    "BENCH-WD-03" ||
  !byStateUnknownThrew
) {
  throw new Error(
    "benchmark fixture failed: tasksByState batch shape",
  );
}
// Actor-filter fixture (backlog #604): a fixed 6-task batch mirroring
// the #589 demo semantics — a single-touch moderator task, a task
// touched by both actors, an anonymous task, a twice-touched
// moderator task, a contributor-only task, and a fresh task with no
// history at all. The filter is pure, so this single batch serves
// every timed iteration with no rebuild.
function buildActorTask(
  id: string,
  steps: Array<{ event: TaskEvent; actor?: string; atMs: number }>,
): TaskLifecycle {
  const task = new TaskLifecycle(id);
  for (const step of steps) {
    task.dispatch(step.event, {
      ...(step.actor === undefined ? {} : { actor: step.actor }),
      at: new Date(step.atMs).toISOString(),
    });
  }
  return task;
}
const actorBatch: TaskLifecycle[] = [
  buildActorTask("BENCH-ACTOR-01", [
    { event: "PUBLISH", actor: "moderator", atMs: BASE_MS },
  ]),
  buildActorTask("BENCH-ACTOR-02", [
    { event: "PUBLISH", actor: "contributor", atMs: BASE_MS },
    { event: "ACCEPT", actor: "moderator", atMs: BASE_MS + HOUR_MS },
  ]),
  buildActorTask("BENCH-ACTOR-03", [
    { event: "PUBLISH", atMs: BASE_MS },
  ]),
  buildActorTask("BENCH-ACTOR-04", [
    { event: "PUBLISH", actor: "moderator", atMs: BASE_MS },
    { event: "ACCEPT", actor: "moderator", atMs: BASE_MS + HOUR_MS },
  ]),
  buildActorTask("BENCH-ACTOR-05", [
    { event: "PUBLISH", actor: "contributor", atMs: BASE_MS },
  ]),
  buildActorTask("BENCH-ACTOR-06", []),
];
const expectedByActorModerator = [
  actorBatch[0],
  actorBatch[1],
  actorBatch[3],
];
const expectedByActorModeratorIds = [
  "BENCH-ACTOR-01",
  "BENCH-ACTOR-02",
  "BENCH-ACTOR-04",
];
let byActorEmptyThrew = false;
try {
  tasksByActor(actorBatch, "");
} catch (error) {
  byActorEmptyThrew =
    error instanceof Error &&
    error.message ===
      'invalid tasksByActor: actor must be a non-empty string, got ""';
}
if (
  tasksByActor(actorBatch, "moderator").map((t) => t.id).join(",") !==
    expectedByActorModeratorIds.join(",") ||
  tasksByActor(actorBatch, "contributor").map((t) => t.id).join(",") !==
    "BENCH-ACTOR-02,BENCH-ACTOR-05" ||
  !byActorEmptyThrew
) {
  throw new Error(
    "benchmark fixture failed: tasksByActor batch shape",
  );
}
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

// SLA approaching-deadline screening fixture (backlog #592): the
// half-open window `(now, now + withinMs]` over a fixed 6-task batch,
// hand-counted from the `tasksApproachingDeadline` boundary rules
// (see also the #580 demo segment, which pins the same boundaries
// with DEMO-046–DEMO-049):
//   AP-01 OPEN, deadline now + 12h  -> inside the window: approaching
//   AP-02 OPEN, deadline now + 24h  -> exactly on the upper bound
//     (inclusive): approaching
//   AP-03 OPEN, deadline exactly now -> lower bound (exclusive):
//     already overdue, not approaching
//   AP-04 OPEN, deadline now - 24h  -> overdue, not approaching
//   AP-05 OPEN, no deadline         -> never selected
//   AP-06 PAID, deadline now + 12h  -> terminal: never selected,
//     even though its deadline falls inside the window
const APPROACHING_NOW = new Date(BASE_MS + 40 * DAY_MS);
const APPROACHING_WINDOW_MS = 24 * HOUR_MS;
const approachingPaidTask = buildPaidTask("BENCH-AP-06", {
  quotedAmount: 100,
  payoutAmount: 100,
  payoutRef: "bench-pay-ap-06",
});
approachingPaidTask.setSlaDeadline(
  new Date(APPROACHING_NOW.getTime() + 12 * HOUR_MS),
  "PAID",
);
const approachingBatch: TaskLifecycle[] = [
  buildWatchdogTask(
    "BENCH-AP-01",
    [{ event: "PUBLISH", actor: "researcher", atMs: BASE_MS }],
    { state: "OPEN", atMs: APPROACHING_NOW.getTime() + 12 * HOUR_MS },
  ),
  buildWatchdogTask(
    "BENCH-AP-02",
    [{ event: "PUBLISH", actor: "researcher", atMs: BASE_MS }],
    { state: "OPEN", atMs: APPROACHING_NOW.getTime() + 24 * HOUR_MS },
  ),
  buildWatchdogTask(
    "BENCH-AP-03",
    [{ event: "PUBLISH", actor: "researcher", atMs: BASE_MS }],
    { state: "OPEN", atMs: APPROACHING_NOW.getTime() },
  ),
  buildWatchdogTask(
    "BENCH-AP-04",
    [{ event: "PUBLISH", actor: "researcher", atMs: BASE_MS }],
    { state: "OPEN", atMs: APPROACHING_NOW.getTime() - 24 * HOUR_MS },
  ),
  buildWatchdogTask("BENCH-AP-05", [
    { event: "PUBLISH", actor: "researcher", atMs: BASE_MS },
  ]),
  approachingPaidTask,
];
const expectedApproaching = [approachingBatch[0], approachingBatch[1]];
const expectedApproachingIds = ["BENCH-AP-01", "BENCH-AP-02"];
if (
  approachingBatch.length !== 6 ||
  approachingBatch.map((t) => t.state).join(",") !==
    "OPEN,OPEN,OPEN,OPEN,OPEN,PAID" ||
  tasksApproachingDeadline(
    approachingBatch,
    APPROACHING_WINDOW_MS,
    APPROACHING_NOW,
  ).map((t) => t.id).join(",") !== expectedApproachingIds.join(",") ||
  expiredTasks(approachingBatch, APPROACHING_NOW).map((t) => t.id).join(",") !==
    "BENCH-AP-03,BENCH-AP-04"
) {
  throw new Error(
    "benchmark fixture failed: approaching-deadline batch shape",
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
//   Each successful outcome also carries `entry`, checked against
//   that task's history last entry (seq/event/from/to/at); the
//   failed WD-06 outcome must carry no entry.
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
  // Audit-entry check (backlog #626, the dataquest mirror of the
  // escrow #625 check): every successful outcome's `entry` must be
  // exactly the EXPIRE audit entry the dispatch appended — i.e. the
  // task history's last entry on seq/event/from/to/at — and the one
  // failed outcome (WD-06, IN_REVIEW) must carry no entry at all,
  // because a failed dispatch appends nothing.
  for (const result of results) {
    const last = result.task.history[result.task.history.length - 1];
    if (result.expired) {
      const entry = result.entry;
      if (
        entry === undefined ||
        entry.seq !== last.seq ||
        entry.event !== last.event ||
        entry.from !== last.from ||
        entry.to !== last.to ||
        entry.at !== last.at
      ) {
        throw new Error(
          `benchmark self-check failed: ${where} (result.entry does not match history last entry for ${result.task.id})`,
        );
      }
    } else if (result.entry !== undefined) {
      throw new Error(
        `benchmark self-check failed: ${where} (failed outcome for ${result.task.id} must carry no entry)`,
      );
    }
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
{
  // One-time notify-only fixture validation (backlog #686), on a
  // throwaway fresh batch like the executor checks above.
  const notifyBatch = buildWatchdogBatch();
  const notifyBefore = notifyBatch.map((task) => ({
    state: task.state,
    historyBytes: JSON.stringify(task.history),
  }));
  const notifyNotified: string[] = [];
  checkStaleNotifyOnlyResults(
    actOnStaleTasks(
      notifyBatch,
      (task) => {
        notifyNotified.push(task.id);
      },
      WATCHDOG_MAX_AGE,
      WATCHDOG_NOW,
    ),
    notifyNotified,
    notifyBatch,
    notifyBefore,
    "actOnStaleTasks notify-only fixture",
  );
}

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

// Fan-out limits fixture: the same PAID task fanned out to 3 fixed
// endpoints under the two call-level guards of
// `deliverPayoutWebhookToMany` that the plain fan-out row never
// exercises — `maxEndpoints` and `overallDeadlineMs` (see the CLI
// demo's fan-out limits segment and
// test/payoutWebhookFanoutLimits.test.ts for the same contract).
// Hand-written expectations — written out here from the
// DeliverPayoutWebhookToManyOptions docs in
// src/settlementWebhook.ts, never derived by calling
// deliverPayoutWebhookToMany itself:
//   - outside the timed loop, 3 endpoints under maxEndpoints 2
//     throw exactly
//     "cannot deliver payout webhook to many endpoints: 3
//     endpoints exceed maxEndpoints 2" before any request is made
//     (0 fetch calls) — the cap is a call-level configuration
//     error, not a per-endpoint outcome;
//   - inside the timed loop, under overallDeadlineMs 50, the two
//     answering endpoints report { ok: true, attempts: 1,
//     status: 200 } and keep their results, the hanging endpoint
//     (risk, which only settles when its abort signal fires)
//     reports { ok: false, attempts: 1, error: "payout webhook
//     delivery timed out: overall deadline of 50ms exceeded" }
//     with no status, the aggregate reports delivered 2 /
//     failed 1 with deadlineExceeded true, and exactly 3 fetch
//     calls are made, one per endpoint — the deadline aborts the
//     in-flight attempt, it does not retry it.
// Honest limit, as in the timeout row: the 50 ms deadline wait is
// the behaviour under test itself, at its pinned short length, so
// this row's throughput is deadline-bound (~20 ops/sec), not a
// measure of fan-out overhead — compare the plain 4-endpoint row
// for that. No elapsed wall-clock duration is asserted.
const FANOUT_LIMITS_MAX_ENDPOINTS = 2;
const FANOUT_LIMITS_OVERALL_DEADLINE_MS = 50;
const FANOUT_LIMITS_OVER_CAP_ERROR =
  "cannot deliver payout webhook to many endpoints: 3 endpoints exceed maxEndpoints 2";
const FANOUT_LIMITS_DEADLINE_ERROR =
  "payout webhook delivery timed out: overall deadline of 50ms exceeded";
const FANOUT_LIMITS_ENDPOINTS: PayoutWebhookEndpoint[] = [
  { url: "https://billing.example.com/hooks/payout", secret: "bench-fanout-limits-secret-billing" },
  { url: "https://risk.example.com/hooks/payout", secret: "bench-fanout-limits-secret-risk" },
  { url: "https://notifications.example.com/hooks/payout", secret: "bench-fanout-limits-secret-notifications" },
];
let fanoutLimitsCalls = 0;
const fanoutLimitsFetch: PayoutWebhookFetchImpl = async (url, init) => {
  fanoutLimitsCalls++;
  if (url === FANOUT_LIMITS_ENDPOINTS[1].url) {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal === null || signal === undefined) {
        reject(new Error("benchmark hanging fetch received no request signal"));
        return;
      }
      if (signal.aborted) {
        reject(new Error("benchmark hanging fetch aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("benchmark hanging fetch aborted")),
        { once: true },
      );
    });
  }
  return new Response("{}", { status: 200 });
};
const fanoutLimitsNoSleep = async () => {};

async function runFanoutLimits() {
  fanoutLimitsCalls = 0;
  const out = await deliverPayoutWebhookToMany(paidTask, FANOUT_LIMITS_ENDPOINTS, {
    fetchImpl: fanoutLimitsFetch,
    sleepImpl: fanoutLimitsNoSleep,
    backoffMs: 0,
    overallDeadlineMs: FANOUT_LIMITS_OVERALL_DEADLINE_MS,
    now: WEBHOOK_NOW,
    eventId: WEBHOOK_EVENT_ID,
  });
  if (
    out.results.length !== FANOUT_LIMITS_ENDPOINTS.length ||
    out.delivered !== 2 ||
    out.failed !== 1 ||
    out.deadlineExceeded !== true ||
    out.results[0].ok !== true ||
    out.results[0].attempts !== 1 ||
    out.results[0].status !== 200 ||
    out.results[0].error !== undefined ||
    out.results[1].ok !== false ||
    out.results[1].attempts !== 1 ||
    out.results[1].status !== undefined ||
    out.results[1].error !== FANOUT_LIMITS_DEADLINE_ERROR ||
    out.results[2].ok !== true ||
    out.results[2].attempts !== 1 ||
    out.results[2].status !== 200 ||
    out.results[2].error !== undefined ||
    fanoutLimitsCalls !== FANOUT_LIMITS_ENDPOINTS.length
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhookToMany fan-out limits",
    );
  }
  return out;
}

// One-time fixture validation (outside the timed loop): the
// deadline case runs once here, and the over-cap call must throw
// the pinned configuration error with zero fetch calls.
await runFanoutLimits();
{
  let overCapCalls = 0;
  const overCapFetch: PayoutWebhookFetchImpl = async () => {
    overCapCalls++;
    return new Response("{}", { status: 200 });
  };
  let overCapError = "";
  try {
    await deliverPayoutWebhookToMany(paidTask, FANOUT_LIMITS_ENDPOINTS, {
      fetchImpl: overCapFetch,
      sleepImpl: fanoutLimitsNoSleep,
      backoffMs: 0,
      maxEndpoints: FANOUT_LIMITS_MAX_ENDPOINTS,
      now: WEBHOOK_NOW,
      eventId: WEBHOOK_EVENT_ID,
    });
  } catch (err) {
    overCapError = err instanceof Error ? err.message : String(err);
  }
  if (overCapError !== FANOUT_LIMITS_OVER_CAP_ERROR || overCapCalls !== 0) {
    throw new Error(
      "benchmark fixture failed: deliverPayoutWebhookToMany maxEndpoints over-cap rejection",
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

// Retry-After cap delivery fixture: the same signed webhook delivered
// through an injected fake fetch that answers 429 with a pinned
// `Retry-After: 30` header (a 30000 ms hint) on the first attempt of
// every delivery and 200 on the second, with backoffMs 100 and an
// injected recording sleep. With maxRetryDelayMs pinned at 5000, the
// one sleep of every delivery must be exactly the clamped hint —
// Math.min(30000, 5000) = 5000 — never the raw hint and never the
// 100 ms exponential-backoff base (the hint wins over backoff, but
// only after the clamp). No network, no randomness, no real waiting.
const RETRY_CAP_HINT_SECONDS = "30";
const RETRY_CAP_HINTED_MS = 30_000;
const RETRY_CAP_MAX_MS = 5_000;
const RETRY_CAP_BACKOFF_MS = 100;
let retryCapCalls: Array<{ url: string; body: string; signature: string }> = [];
let retryCapSleeps: number[] = [];
const retryCapFetch: PayoutWebhookFetchImpl = async (url, init) => {
  retryCapCalls.push({
    url,
    body: String(init.body),
    signature: String(new Headers(init.headers).get("x-hub-signature-256")),
  });
  if (retryCapCalls.length % 2 === 1) {
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": RETRY_CAP_HINT_SECONDS },
    });
  }
  return new Response("{}", { status: 200 });
};
const retryCapSleep = async (ms: number) => {
  retryCapSleeps.push(ms);
};

async function runRetryCapDelivery() {
  retryCapCalls = [];
  retryCapSleeps = [];
  const result = await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
    fetchImpl: retryCapFetch,
    sleepImpl: retryCapSleep,
    backoffMs: RETRY_CAP_BACKOFF_MS,
    maxRetryDelayMs: RETRY_CAP_MAX_MS,
  });
  if (
    result.ok !== true ||
    result.attempts !== 2 ||
    result.status !== 200 ||
    result.error !== undefined ||
    retryCapCalls.length !== 2 ||
    retryCapCalls.some(
      (c) =>
        c.url !== SINGLE_DELIVERY_URL ||
        c.body !== webhookBody ||
        c.signature !== webhook.signature,
    ) ||
    retryCapSleeps.length !== 1 ||
    retryCapSleeps[0] !== RETRY_CAP_MAX_MS
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhook maxRetryDelayMs cap",
    );
  }
  return result;
}

// One-time fixture validation (outside the timed loop).
await runRetryCapDelivery();

// Neighbouring-branch probes (outside the timed loop, never timed):
// the clamp applies only to a 429 hint — a 429 WITHOUT a hint and a
// 500 carrying a Retry-After header both fall back to the exponential
// backoff base (backoffMs * 2^0 = 100), and a hint below the cap is
// honored exactly, unclamped.
{
  const probe = async (
    firstStatus: number,
    firstHeaders: Record<string, string> | undefined,
    expectedSleeps: number[],
    where: string,
  ) => {
    let probeCalls = 0;
    const probeSleeps: number[] = [];
    const probeFetch: PayoutWebhookFetchImpl = async () => {
      probeCalls++;
      return probeCalls === 1
        ? new Response("first", { status: firstStatus, headers: firstHeaders })
        : new Response("{}", { status: 200 });
    };
    const probeResult = await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
      fetchImpl: probeFetch,
      sleepImpl: async (ms: number) => {
        probeSleeps.push(ms);
      },
      backoffMs: RETRY_CAP_BACKOFF_MS,
      maxRetryDelayMs: RETRY_CAP_MAX_MS,
    });
    if (
      probeResult.ok !== true ||
      probeResult.attempts !== 2 ||
      probeResult.status !== 200 ||
      probeCalls !== 2 ||
      probeSleeps.length !== expectedSleeps.length ||
      probeSleeps.some((v, i) => v !== expectedSleeps[i])
    ) {
      throw new Error(`benchmark fixture failed: maxRetryDelayMs cap ${where}`);
    }
  };
  await probe(429, undefined, [RETRY_CAP_BACKOFF_MS], "no-hint backoff fallback");
  await probe(429, { "retry-after": "2" }, [2_000], "below-cap hint honored");
  await probe(
    500,
    { "retry-after": RETRY_CAP_HINT_SECONDS },
    [RETRY_CAP_BACKOFF_MS],
    "500 hint ignored",
  );
}

// Jitter delivery fixture: the same signed webhook (`webhook`, built
// once above) delivered through an injected fake fetch that answers
// 500 on the first two attempts of every delivery and 200 on the
// third, with backoffMs 100, maxAttempts 3, and an injected
// recording sleep. With jitterMs 1000 the two sleeps of every
// jittered delivery must land inside [100, 1100] and [200, 1200] —
// the exponential bases 100 * 2^0 and 100 * 2^1 plus a uniform
// Math.random() * 1000 spread — and with jitterMs 0 (the default)
// the same script must sleep exactly [100, 200], the pure
// exponential schedule with no spread. The 500 path carries no
// Retry-After hint, so no hint clamping is involved; the jitter
// spread is the only thing moving the sleeps. No network and no
// real waiting: the sleep only records.
// Per-iteration self-checks assert bounds only, never exact
// values: with live Math.random an exact sleep is unknowable in
// advance, and asserting variation would flake on a coincidental
// repeat. The exact values are pinned once, outside the timed
// loop, below with a stubbed Math.random sequence.
const JITTER_BACKOFF_MS = 100;
const JITTER_JITTER_MS = 1000;
const JITTER_MAX_ATTEMPTS = 3;

function makeJitterFetch() {
  let calls = 0;
  const fetch: PayoutWebhookFetchImpl = async () => {
    calls++;
    if (calls % 3 !== 0) {
      return new Response("boom", { status: 500 });
    }
    return new Response("{}", { status: 200 });
  };
  return {
    fetch,
    calls: () => calls,
  };
}

async function runJitterDelivery(jitterMs: number) {
  const jitterFetch = makeJitterFetch();
  const jitterSleeps: number[] = [];
  const result = await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
    fetchImpl: jitterFetch.fetch,
    sleepImpl: async (ms: number) => {
      jitterSleeps.push(ms);
    },
    backoffMs: JITTER_BACKOFF_MS,
    jitterMs,
    maxAttempts: JITTER_MAX_ATTEMPTS,
  });
  if (
    result.ok !== true ||
    result.attempts !== JITTER_MAX_ATTEMPTS ||
    result.status !== 200 ||
    result.error !== undefined ||
    jitterFetch.calls() !== JITTER_MAX_ATTEMPTS ||
    jitterSleeps.length !== JITTER_MAX_ATTEMPTS - 1
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhook jitterMs backoff",
    );
  }
  if (jitterMs > 0) {
    const bases = [JITTER_BACKOFF_MS, JITTER_BACKOFF_MS * 2];
    const inWindow = jitterSleeps.every(
      (sleep, i) => sleep >= bases[i] && sleep <= bases[i] + jitterMs,
    );
    if (!inWindow) {
      throw new Error(
        "benchmark self-check failed: deliverPayoutWebhook jitterMs sleep outside [backoff, backoff + jitterMs]",
      );
    }
  } else if (
    jitterSleeps[0] !== JITTER_BACKOFF_MS ||
    jitterSleeps[1] !== JITTER_BACKOFF_MS * 2
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhook jitterMs=0 not pure exponential",
    );
  }
  return jitterSleeps;
}

// One-time fixture validation (outside the timed loop): one
// jittered and one zero-jitter delivery each, then the
// deterministic jitter probe — with Math.random stubbed to the
// fixed sequence [0, 0.5], the two jittered sleeps must be exactly
// [100, 700] (100 + 0 * 1000, then 200 + 0.5 * 1000), proving the
// spread is applied per attempt on top of the exponential base,
// not once and not at all; with jitterMs 0 the same stubbed
// sequence must still sleep exactly [100, 200], proving the random
// source is never consulted when jitter is off. The stub is
// restored in a finally block, and the restore itself is asserted.
await runJitterDelivery(JITTER_JITTER_MS);
await runJitterDelivery(0);
{
  const originalRandom = Math.random;
  const stubSequence = [0, 0.5];
  let stubIndex = 0;
  Math.random = () => stubSequence[stubIndex++ % stubSequence.length];
  try {
    const stubbed = await runJitterDelivery(JITTER_JITTER_MS);
    if (stubbed[0] !== 100 || stubbed[1] !== 700) {
      throw new Error(
        "benchmark fixture failed: deliverPayoutWebhook jitterMs deterministic spread",
      );
    }
    const stubbedZero = await runJitterDelivery(0);
    if (stubbedZero[0] !== 100 || stubbedZero[1] !== 200) {
      throw new Error(
        "benchmark fixture failed: deliverPayoutWebhook jitterMs=0 ignores Math.random",
      );
    }
  } finally {
    Math.random = originalRandom;
  }
  if (Math.random !== originalRandom) {
    throw new Error(
      "benchmark fixture failed: Math.random not restored after jitter probe",
    );
  }
}

// Fan-out jitter fixture: the combination the single-endpoint jitter
// row and the plain fan-out row each cover alone —
// `deliverPayoutWebhookToMany` to 4 fixed endpoints, every endpoint
// answering 500 on its first two attempts and 200 on the third, with
// backoffMs 100, maxAttempts 3, and jitterMs 1000 passed at the call
// level. Deliveries run concurrently and retry budgets are per
// endpoint, so each endpoint gets its OWN recording sleep: a shared
// recorder would interleave the four endpoints' sleeps into one
// unordered list and could not pin per-endpoint windows. Per
// iteration, every endpoint's two sleeps must land inside
// [100, 1100] and [200, 1200] — the same windows as the
// single-endpoint row — and every endpoint must report
// { ok: true, attempts: 3, status: 200 } with exactly 3 fetch calls,
// so a retrying endpoint never consumes or blocks another's budget.
// The zero-jitter control fan-out (same scripts, jitterMs 0) must
// sleep exactly [100, 200] per endpoint. Per-iteration checks assert
// bounds only, never exact values: with live Math.random an exact
// sleep is unknowable in advance. The exact [100, 700] spread is
// pinned by the single-endpoint jitter fixture, not repeated here:
// under concurrency the four endpoints share the global
// Math.random and draw order is nondeterministic, so a stubbed
// sequence cannot pin per-endpoint exact sleeps. No network and no
// real waiting: every sleep only records.
const FANOUT_JITTER_ENDPOINTS: Array<{ url: string; secret: string }> = [
  { url: "https://billing.example.com/hooks/payout", secret: "bench-fanout-jitter-secret-billing" },
  { url: "https://risk.example.com/hooks/payout", secret: "bench-fanout-jitter-secret-risk" },
  { url: "https://notifications.example.com/hooks/payout", secret: "bench-fanout-jitter-secret-notifications" },
  { url: "https://ledger.example.com/hooks/payout", secret: "bench-fanout-jitter-secret-ledger" },
];

async function runFanoutJitter(jitterMs: number) {
  const perEndpoint: Array<{
    calls: number;
    sleeps: number[];
    bodies: string[];
    signatures: string[];
  }> = FANOUT_JITTER_ENDPOINTS.map(() => ({
    calls: 0,
    sleeps: [],
    bodies: [],
    signatures: [],
  }));
  const endpoints: PayoutWebhookEndpoint[] = FANOUT_JITTER_ENDPOINTS.map(
    (endpoint, i) => ({
      ...endpoint,
      fetchImpl: async (_url, init) => {
        const slot = perEndpoint[i];
        slot.calls++;
        slot.bodies.push(String(init.body));
        slot.signatures.push(
          String(new Headers(init.headers).get("x-hub-signature-256")),
        );
        if (slot.calls % 3 !== 0) {
          return new Response("boom", { status: 500 });
        }
        return new Response("{}", { status: 200 });
      },
      sleepImpl: async (ms: number) => {
        perEndpoint[i].sleeps.push(ms);
      },
    }),
  );
  const out = await deliverPayoutWebhookToMany(paidTask, endpoints, {
    backoffMs: JITTER_BACKOFF_MS,
    jitterMs,
    maxAttempts: JITTER_MAX_ATTEMPTS,
    now: WEBHOOK_NOW,
    eventId: WEBHOOK_EVENT_ID,
  });
  if (
    out.results.length !== FANOUT_JITTER_ENDPOINTS.length ||
    out.delivered !== FANOUT_JITTER_ENDPOINTS.length ||
    out.failed !== 0 ||
    out.results.some(
      (r) =>
        !r.ok ||
        r.attempts !== JITTER_MAX_ATTEMPTS ||
        r.status !== 200 ||
        r.error !== undefined,
    ) ||
    perEndpoint.some(
      (slot) =>
        slot.calls !== JITTER_MAX_ATTEMPTS ||
        slot.sleeps.length !== JITTER_MAX_ATTEMPTS - 1,
    )
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhookToMany jitterMs fan-out",
    );
  }
  if (jitterMs > 0) {
    const bases = [JITTER_BACKOFF_MS, JITTER_BACKOFF_MS * 2];
    const inWindow = perEndpoint.every((slot) =>
      slot.sleeps.every(
        (sleep, i) => sleep >= bases[i] && sleep <= bases[i] + jitterMs,
      ),
    );
    if (!inWindow) {
      throw new Error(
        "benchmark self-check failed: deliverPayoutWebhookToMany jitterMs sleep outside [backoff, backoff + jitterMs]",
      );
    }
  } else if (
    !perEndpoint.every(
      (slot) =>
        slot.sleeps[0] === JITTER_BACKOFF_MS &&
        slot.sleeps[1] === JITTER_BACKOFF_MS * 2,
    )
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhookToMany jitterMs=0 not pure exponential",
    );
  }
  return perEndpoint;
}

// One-time fixture validation (outside the timed loop): one jittered
// and one zero-jitter fan-out each, then a signature probe — every
// endpoint's final call body carries the shared eventId and verifies
// under that endpoint's own secret, proving the fan-out signs each
// copy independently even while all four retry with jitter.
await runFanoutJitter(JITTER_JITTER_MS);
await runFanoutJitter(0);
{
  const probed = await runFanoutJitter(JITTER_JITTER_MS);
  for (const [i, endpoint] of FANOUT_JITTER_ENDPOINTS.entries()) {
    const slot = probed[i];
    const last = slot.bodies.length - 1;
    if (slot.bodies.some((body) => JSON.parse(body).eventId !== WEBHOOK_EVENT_ID)) {
      throw new Error(
        `benchmark fixture failed: fan-out jitter endpoint ${i} body eventId mismatch`,
      );
    }
    if (!verifyPayoutWebhook(slot.bodies[last], slot.signatures[last], endpoint.secret)) {
      throw new Error(
        `benchmark fixture failed: fan-out jitter endpoint ${i} signature does not verify`,
      );
    }
  }
}

// Fan-out Retry-After cap fixture: the combination the fan-out jitter
// row and the single-endpoint Retry-After cap row each cover alone —
// `deliverPayoutWebhookToMany` to 4 fixed endpoints, one endpoint
// (billing) answering 429 with a pinned `Retry-After: 30` header (a
// 30000 ms hint) on its first attempt and 200 on its second, the
// other three answering 200 immediately, with backoffMs 100 and
// maxRetryDelayMs 5000 passed at the call level. Deliveries run
// concurrently and retry budgets are per endpoint, so each endpoint
// gets its OWN recording sleep: a shared recorder would interleave
// the four endpoints' sleeps into one unordered list and could not
// pin that exactly one clamped sleep belongs to the 429 endpoint
// while the healthy endpoints sleep never. Per iteration, billing
// must report { ok: true, attempts: 2, status: 200 } with exactly
// one recorded sleep of exactly 5000 ms — Math.min(30000, 5000),
// never the raw hint and never the 100 ms backoff base — while
// every other endpoint reports { ok: true, attempts: 1,
// status: 200 } with zero sleeps, so a clamped retry on one
// endpoint never stalls or retries its siblings. All four bodies
// must be byte-identical copies of the same shared eventId. No
// network and no real waiting: every sleep only records, so the
// 5000 ms clamp is asserted as a recorded value, never slept.
// The exact clamp is pinned by the single-endpoint row too; this
// row pins that the cap survives the fan-out path, where the
// option could be dropped at the call level or at a per-endpoint
// override without any single-endpoint test noticing.
const FANOUT_RETRY_CAP_ENDPOINTS: Array<{ url: string; secret: string }> = [
  { url: "https://billing.example.com/hooks/payout", secret: "bench-fanout-retrycap-secret-billing" },
  { url: "https://risk.example.com/hooks/payout", secret: "bench-fanout-retrycap-secret-risk" },
  { url: "https://notifications.example.com/hooks/payout", secret: "bench-fanout-retrycap-secret-notifications" },
  { url: "https://ledger.example.com/hooks/payout", secret: "bench-fanout-retrycap-secret-ledger" },
];
const FANOUT_RETRY_CAP_HINT_SECONDS = "30";
const FANOUT_RETRY_CAP_MAX_MS = 5_000;
const FANOUT_RETRY_CAP_BACKOFF_MS = 100;

interface FanoutRetryCapSlot {
  calls: number;
  sleeps: number[];
  bodies: string[];
  signatures: string[];
}

async function runFanoutRetryCapVariant(billingFirst: {
  status: number;
  headers?: Record<string, string>;
}): Promise<{
  out: Awaited<ReturnType<typeof deliverPayoutWebhookToMany>>;
  perEndpoint: FanoutRetryCapSlot[];
}> {
  const perEndpoint: FanoutRetryCapSlot[] = FANOUT_RETRY_CAP_ENDPOINTS.map(
    () => ({ calls: 0, sleeps: [], bodies: [], signatures: [] }),
  );
  const endpoints: PayoutWebhookEndpoint[] = FANOUT_RETRY_CAP_ENDPOINTS.map(
    (endpoint, i) => ({
      ...endpoint,
      fetchImpl: async (_url, init) => {
        const slot = perEndpoint[i];
        slot.calls++;
        slot.bodies.push(String(init.body));
        slot.signatures.push(
          String(new Headers(init.headers).get("x-hub-signature-256")),
        );
        if (i === 0 && slot.calls === 1) {
          return new Response("rate limited", {
            status: billingFirst.status,
            headers: billingFirst.headers,
          });
        }
        return new Response("{}", { status: 200 });
      },
      sleepImpl: async (ms: number) => {
        perEndpoint[i].sleeps.push(ms);
      },
    }),
  );
  const out = await deliverPayoutWebhookToMany(paidTask, endpoints, {
    backoffMs: FANOUT_RETRY_CAP_BACKOFF_MS,
    maxRetryDelayMs: FANOUT_RETRY_CAP_MAX_MS,
    now: WEBHOOK_NOW,
    eventId: WEBHOOK_EVENT_ID,
  });
  return { out, perEndpoint };
}

async function runFanoutRetryCap(): Promise<FanoutRetryCapSlot[]> {
  const { out, perEndpoint } = await runFanoutRetryCapVariant({
    status: 429,
    headers: { "retry-after": FANOUT_RETRY_CAP_HINT_SECONDS },
  });
  if (
    out.results.length !== FANOUT_RETRY_CAP_ENDPOINTS.length ||
    out.delivered !== FANOUT_RETRY_CAP_ENDPOINTS.length ||
    out.failed !== 0 ||
    out.results[0].ok !== true ||
    out.results[0].attempts !== 2 ||
    out.results[0].status !== 200 ||
    out.results[0].error !== undefined ||
    out.results
      .slice(1)
      .some(
        (r) =>
          !r.ok || r.attempts !== 1 || r.status !== 200 || r.error !== undefined,
      ) ||
    perEndpoint[0].calls !== 2 ||
    perEndpoint.slice(1).some((slot) => slot.calls !== 1) ||
    perEndpoint[0].sleeps.length !== 1 ||
    perEndpoint[0].sleeps[0] !== FANOUT_RETRY_CAP_MAX_MS ||
    perEndpoint.slice(1).some((slot) => slot.sleeps.length !== 0) ||
    perEndpoint.some((slot) =>
      slot.bodies.some((body) => body !== perEndpoint[0].bodies[0]),
    ) ||
    JSON.parse(perEndpoint[0].bodies[0]).eventId !== WEBHOOK_EVENT_ID
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhookToMany maxRetryDelayMs fan-out",
    );
  }
  return perEndpoint;
}

// One-time fixture validation (outside the timed loop): one clamped
// fan-out, then a signature probe — every endpoint's final call body
// carries the shared eventId and verifies under that endpoint's own
// secret — and two neighbouring-branch probes: a below-cap
// `Retry-After: 2` hint on the 429 endpoint must be honored exactly
// at 2000 ms (the cap clamps, it does not replace the hint), and a
// 500 carrying a `Retry-After: 30` header must ignore the hint and
// fall back to the 100 ms backoff base, the same rule as the
// single-endpoint row and test/payoutWebhookFanoutRetryCap.test.ts.
await runFanoutRetryCap();
{
  const probed = await runFanoutRetryCap();
  for (const [i, endpoint] of FANOUT_RETRY_CAP_ENDPOINTS.entries()) {
    const slot = probed[i];
    const last = slot.bodies.length - 1;
    if (
      slot.bodies.some((body) => JSON.parse(body).eventId !== WEBHOOK_EVENT_ID)
    ) {
      throw new Error(
        `benchmark fixture failed: fan-out retry-cap endpoint ${i} body eventId mismatch`,
      );
    }
    if (
      !verifyPayoutWebhook(slot.bodies[last], slot.signatures[last], endpoint.secret)
    ) {
      throw new Error(
        `benchmark fixture failed: fan-out retry-cap endpoint ${i} signature does not verify`,
      );
    }
  }
  const belowCap = await runFanoutRetryCapVariant({
    status: 429,
    headers: { "retry-after": "2" },
  });
  if (
    belowCap.perEndpoint[0].sleeps.length !== 1 ||
    belowCap.perEndpoint[0].sleeps[0] !== 2_000 ||
    belowCap.perEndpoint.slice(1).some((slot) => slot.sleeps.length !== 0)
  ) {
    throw new Error(
      "benchmark fixture failed: fan-out retry-cap below-cap hint not honored",
    );
  }
  const ignoredHint = await runFanoutRetryCapVariant({
    status: 500,
    headers: { "retry-after": FANOUT_RETRY_CAP_HINT_SECONDS },
  });
  if (
    ignoredHint.perEndpoint[0].sleeps.length !== 1 ||
    ignoredHint.perEndpoint[0].sleeps[0] !== FANOUT_RETRY_CAP_BACKOFF_MS ||
    ignoredHint.perEndpoint.slice(1).some((slot) => slot.sleeps.length !== 0)
  ) {
    throw new Error(
      "benchmark fixture failed: fan-out retry-cap 500 hint not ignored",
    );
  }
}

// AbortSignal pre-abort delivery fixture: the same signed webhook
// (`webhook`, built once above) delivered to the single-target
// endpoint through an injected counting fake fetch, with an
// external signal that is aborted BEFORE the call on every pass.
// Hand-written expectations — written out here from the
// DeliverPayoutWebhookOptions signal docs in
// src/settlementWebhook.ts and cross-checked against
// test/payoutWebhookAbortSignal.test.ts and the CLI demo
// AbortSignal segment, never derived by calling
// deliverPayoutWebhook itself:
//   - the pre-aborted delivery reports exactly
//     { ok: false, attempts: 0,
//       error: "payout webhook delivery aborted" }
//     with no status, and the counting fetch is never called
//     (0 calls) — the caller asked to stop before the
//     delivery started, and the abort is reported, not thrown;
//   - outside the timed loop, a non-AbortSignal signal value
//     throws exactly the pinned configuration error below
//     before any request is made (0 fetch calls);
//   - outside the timed loop, a signal that never aborts
//     leaves the normal delivery unchanged: the same webhook
//     delivered through an immediate-200 fake fetch reports
//     { ok: true, attempts: 1, status: 200 } after exactly
//     one fetch call.
const ABORT_PRE_ERROR = "payout webhook delivery aborted";
const ABORT_BAD_SIGNAL_VALUE = "bench-not-a-signal";
const ABORT_BAD_SIGNAL_ERROR =
  "cannot deliver payout webhook: signal must be an AbortSignal, got bench-not-a-signal";
const abortPreController = new AbortController();
abortPreController.abort();
let abortPreCalls = 0;
const abortPreFetch: PayoutWebhookFetchImpl = async () => {
  abortPreCalls++;
  return new Response("{}", { status: 200 });
};
const abortPreNoSleep = async () => {};

async function runAbortPreDelivery() {
  abortPreCalls = 0;
  const result = await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
    fetchImpl: abortPreFetch,
    sleepImpl: abortPreNoSleep,
    signal: abortPreController.signal,
  });
  if (
    result.ok !== false ||
    result.attempts !== 0 ||
    result.status !== undefined ||
    result.error !== ABORT_PRE_ERROR ||
    abortPreCalls !== 0
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhook AbortSignal pre-abort",
    );
  }
  return result;
}

// One-time fixture validation (outside the timed loop).
await runAbortPreDelivery();

// Non-AbortSignal probe (outside the timed loop, never timed): a
// caller configuration error throws before any request is made.
{
  let badSignalCalls = 0;
  const badSignalFetch: PayoutWebhookFetchImpl = async () => {
    badSignalCalls++;
    return new Response("{}", { status: 200 });
  };
  let badSignalError = "";
  try {
    await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
      fetchImpl: badSignalFetch,
      sleepImpl: abortPreNoSleep,
      signal: ABORT_BAD_SIGNAL_VALUE as unknown as AbortSignal,
    });
  } catch (err) {
    badSignalError = err instanceof Error ? err.message : String(err);
  }
  if (badSignalError !== ABORT_BAD_SIGNAL_ERROR || badSignalCalls !== 0) {
    throw new Error(
      "benchmark fixture failed: deliverPayoutWebhook AbortSignal non-AbortSignal rejection",
    );
  }
}

// Unaborted-signal probe (outside the timed loop, never timed): a
// signal that never aborts leaves the normal delivery unchanged.
{
  const liveController = new AbortController();
  let liveCalls = 0;
  const liveFetch: PayoutWebhookFetchImpl = async () => {
    liveCalls++;
    return new Response("{}", { status: 200 });
  };
  const liveResult = await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
    fetchImpl: liveFetch,
    sleepImpl: abortPreNoSleep,
    backoffMs: 0,
    signal: liveController.signal,
  });
  if (
    liveResult.ok !== true ||
    liveResult.attempts !== 1 ||
    liveResult.status !== 200 ||
    liveResult.error !== undefined ||
    liveCalls !== 1
  ) {
    throw new Error(
      "benchmark fixture failed: deliverPayoutWebhook AbortSignal unaborted delivery",
    );
  }
}

// timeoutMs timeout fixture: the same signed webhook (`webhook`,
// built once above) delivered to the single-target endpoint
// through an injected hanging fake fetch with `timeoutMs` pinned
// at 10 and `maxAttempts: 1`. The fake never answers on its own:
// it only settles when its request signal aborts, so the pinned
// short timeout is the only thing that can end the attempt —
// the timeout is reported, never thrown (this module's
// convention), as exactly
//   { ok: false, attempts: 1,
//     error: "webhook delivery timed out after 10ms" }
// with no status, after exactly one fetch call. The call count
// is reset at the start of every run. Hand-written expectations
// — written out here from the DeliverPayoutWebhookOptions
// timeoutMs docs in src/settlementWebhook.ts and cross-checked
// against test/payoutWebhookDelivery.test.ts and the CLI demo
// timeout segment, never derived by calling
// deliverPayoutWebhook itself:
//   - outside the timed loop, an illegal `timeoutMs` of 0
//     throws exactly the pinned configuration error below
//     before any request is made (0 fetch calls);
//   - outside the timed loop, a generous `timeoutMs` of 5000
//     over an immediately-200 fake leaves the normal delivery
//     unchanged: { ok: true, attempts: 1, status: 200 } after
//     exactly one fetch call.
// Honest limit: the timeout wait is the object under test and
// is the pinned short 10 ms — no elapsed-time assertion is
// made anywhere. No network, no randomness.
const TIMEOUT_MS = 10;
const TIMEOUT_GENEROUS_MS = 5000;
const TIMEOUT_ERROR = "webhook delivery timed out after 10ms";
const TIMEOUT_ILLEGAL_ERROR =
  "cannot deliver payout webhook: timeoutMs must be a positive number, got 0";
let timeoutCalls = 0;
const timeoutHangingFetch: PayoutWebhookFetchImpl = async (_url, init) => {
  timeoutCalls++;
  return new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal === null || signal === undefined) {
      reject(new Error("benchmark hanging fetch received no request signal"));
      return;
    }
    if (signal.aborted) {
      reject(new Error("benchmark hanging fetch aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("benchmark hanging fetch aborted")),
      { once: true },
    );
  });
};
const timeoutNoSleep = async () => {};

async function runTimeoutDelivery() {
  timeoutCalls = 0;
  const result = await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
    fetchImpl: timeoutHangingFetch,
    sleepImpl: timeoutNoSleep,
    backoffMs: 0,
    timeoutMs: TIMEOUT_MS,
    maxAttempts: 1,
  });
  if (
    result.ok !== false ||
    result.attempts !== 1 ||
    result.status !== undefined ||
    result.error !== TIMEOUT_ERROR ||
    timeoutCalls !== 1
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhook timeoutMs timeout",
    );
  }
  return result;
}

// One-time fixture validation (outside the timed loop).
await runTimeoutDelivery();

// Illegal timeoutMs check (outside the timed loop, never
// timed): `timeoutMs: 0` must throw the exact pinned
// configuration error before any request — the counting fake
// fetch must still be at zero calls afterwards.
{
  let illegalTimeoutCalls = 0;
  const illegalTimeoutFetch: PayoutWebhookFetchImpl = async () => {
    illegalTimeoutCalls++;
    return new Response("{}", { status: 200 });
  };
  let illegalTimeoutError = "";
  try {
    await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
      fetchImpl: illegalTimeoutFetch,
      sleepImpl: timeoutNoSleep,
      timeoutMs: 0,
    });
  } catch (err) {
    illegalTimeoutError = err instanceof Error ? err.message : String(err);
  }
  if (illegalTimeoutError !== TIMEOUT_ILLEGAL_ERROR || illegalTimeoutCalls !== 0) {
    throw new Error(
      "benchmark fixture failed: deliverPayoutWebhook timeoutMs illegal shape",
    );
  }
}

// Generous timeoutMs check (outside the timed loop, never
// timed): under the generous pinned timeout an immediately-200
// fake delivers successfully with the unchanged
// { ok: true, attempts: 1, status: 200 } shape after exactly
// one fetch call.
{
  let generousTimeoutCalls = 0;
  const generousTimeoutFetch: PayoutWebhookFetchImpl = async () => {
    generousTimeoutCalls++;
    return new Response("{}", { status: 200 });
  };
  const generousResult = await deliverPayoutWebhook(SINGLE_DELIVERY_URL, webhook, {
    fetchImpl: generousTimeoutFetch,
    sleepImpl: timeoutNoSleep,
    backoffMs: 0,
    timeoutMs: TIMEOUT_GENEROUS_MS,
  });
  if (
    generousResult.ok !== true ||
    generousResult.attempts !== 1 ||
    generousResult.status !== 200 ||
    generousResult.error !== undefined ||
    generousTimeoutCalls !== 1
  ) {
    throw new Error(
      "benchmark fixture failed: deliverPayoutWebhook timeoutMs generous shape",
    );
  }
}

// Delivery-header verification fixture: the same signed webhook
// (`webhook`, built once above with the pinned WEBHOOK_EVENT_ID)
// delivered through the default fetch — the real global fetch, no
// injected fake — to a loopback HTTP server that records every
// request's headers and body and answers 500 on odd-numbered
// requests, 200 on even ones, so every delivery is exactly a
// 500 → 200 retry pair (backoffMs 0, no-op sleep, no real
// waiting). Per-iteration self-checks: result
// { ok: true, attempts: 2, status: 200 }, exactly two captured
// requests, every attempt's `Idempotency-Key` and `X-Event-Id`
// both equal to the body `eventId` (WEBHOOK_EVENT_ID, the same
// value across the retry), and both bodies byte-identical to the
// signed body. The server is started once here, used by the
// timed loop, and closed by the bench function after measuring —
// nothing after this section needs it.
interface DeliveryHeaderCapture {
  idempotencyKey: string | string[] | undefined;
  eventIdHeader: string | string[] | undefined;
  signatureHeader: string | string[] | undefined;
  body: string;
}
const deliveryHeaderCaptures: DeliveryHeaderCapture[] = [];
let deliveryHeaderRequests = 0;
const deliveryHeaderServer = createServer(
  (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      deliveryHeaderRequests += 1;
      deliveryHeaderCaptures.push({
        idempotencyKey: req.headers["idempotency-key"],
        eventIdHeader: req.headers["x-event-id"],
        signatureHeader: req.headers["x-hub-signature-256"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(deliveryHeaderRequests % 2 === 1 ? 500 : 200, {
        "content-type": "application/json",
      });
      res.end("{}");
    });
  },
);
await new Promise<void>((resolve) =>
  deliveryHeaderServer.listen(0, "127.0.0.1", resolve),
);
const deliveryHeaderAddress = deliveryHeaderServer.address();
if (deliveryHeaderAddress === null || typeof deliveryHeaderAddress === "string") {
  throw new Error(
    "benchmark fixture failed: delivery-header loopback server did not bind",
  );
}
const DELIVERY_HEADER_URL = `http://127.0.0.1:${deliveryHeaderAddress.port}/hooks/payout`;
const deliveryHeaderNoSleep = async () => {};

async function runDeliveryHeaderDelivery() {
  const before = deliveryHeaderCaptures.length;
  const result = await deliverPayoutWebhook(DELIVERY_HEADER_URL, webhook, {
    sleepImpl: deliveryHeaderNoSleep,
    backoffMs: 0,
    // Loopback-only explicit opt-in (backlog #701's HTTPS default
    // otherwise rejects this http://127.0.0.1 row; the same opt-in
    // the demo and header tests already use for loopback servers).
    allowInsecureHttp: true,
  });
  const captured = deliveryHeaderCaptures.slice(before);
  if (
    result.ok !== true ||
    result.attempts !== 2 ||
    result.status !== 200 ||
    result.error !== undefined ||
    captured.length !== 2
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhook delivery headers",
    );
  }
  for (const req of captured) {
    if (
      req.idempotencyKey !== WEBHOOK_EVENT_ID ||
      req.eventIdHeader !== WEBHOOK_EVENT_ID ||
      req.body !== webhookBody ||
      (JSON.parse(req.body) as { eventId: string }).eventId !== WEBHOOK_EVENT_ID
    ) {
      throw new Error(
        "benchmark self-check failed: deliverPayoutWebhook delivery headers",
      );
    }
  }
  return captured;
}

// One-time fixture validation (outside the timed loop): the
// captured signature header is exactly the build-time signature
// and verifies over the captured body — the two delivery headers
// never entered the signed bytes, so they are transport hints
// outside signature coverage and a receiver must verify the body
// first and deduplicate on the verified body's `eventId` (see the
// #568 header contract in src/settlementWebhook.ts).
{
  const captured = await runDeliveryHeaderDelivery();
  if (
    captured[0].signatureHeader !== webhook.signature ||
    captured[1].signatureHeader !== webhook.signature ||
    !verifyPayoutWebhook(captured[0].body, webhook.signature, WEBHOOK_SECRET)
  ) {
    throw new Error(
      "benchmark fixture failed: deliverPayoutWebhook delivery headers not outside signature coverage",
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

// Receiver-flow fixture: verifyPayoutWebhook x PayoutEventDedupe —
// the #726 test row's bench variant. The verify steps run over the
// fixed signed webhook (`webhookBody` / `webhook.signature`) and its
// one-character-tampered twin (the `eventId` value swapped from
// `bench-event-001` to `bench-event-002`, so the signature no longer
// matches). The dedupe step takes the id string, not the body, so
// the timed path uses per-iteration synthetic ids standing in for
// `payload.eventId` (see `benchVerifyPayoutWebhookDedupe`). The
// dedicated dedupe runs under an injected FIXED clock (the same
// `DEDUPE_NOW_MS` instant, so no entry expires) with capacity
// 100,000 — one measured op records exactly two ids, and warmup +
// timed calls total 3,200 ops, so 6,400 live entries stay far under
// the cap and nothing is evicted in the timed loop. No network, no
// randomness, no wall clock.
const WEBHOOK_TAMPERED_BODY = webhookBody.replace(
  WEBHOOK_EVENT_ID,
  "bench-event-002",
);
if (
  WEBHOOK_TAMPERED_BODY === webhookBody ||
  verifyPayoutWebhook(
    WEBHOOK_TAMPERED_BODY,
    webhook.signature,
    WEBHOOK_SECRET,
  )
) {
  throw new Error(
    "benchmark fixture failed: tampered webhook body must fail verification",
  );
}
const receiverDedupe = new PayoutEventDedupe({
  now: () => DEDUPE_NOW_MS,
  maxEntries: 100_000,
});
let receiverDedupeCounter = 0;

// Fan-out receiver fixture: deliverPayoutWebhookToMany x
// PayoutEventDedupe — the #740 test row's bench variant. One
// independent dedupe per fan-out endpoint (the #740 isolation
// rule: endpoint A's first sighting must never mark endpoint B's
// first delivery of the same eventId a duplicate), each under the
// same injected FIXED clock (DEDUPE_NOW_MS, so no entry expires)
// with capacity 100,000 — one measured op records exactly one
// fresh id per dedupe, and warmup + timed calls total 3,200 ops,
// so 3,200 live entries per dedupe stay far under the cap and
// nothing is evicted in the timed loop. The fan-out itself reuses
// the plain fan-out fixture above (FANOUT_ENDPOINTS, fanoutFetch,
// fanoutNoSleep, WEBHOOK_NOW) with a per-iteration fresh eventId,
// so the first fan-out is a genuine first sighting on every
// receiver and the second fan-out with the same eventId is a
// genuine redelivery on every receiver. No network, no
// randomness, no wall clock.
const fanoutReceiverDedupes: PayoutEventDedupe[] = FANOUT_ENDPOINTS.map(
  () =>
    new PayoutEventDedupe({
      now: () => DEDUPE_NOW_MS,
      maxEntries: 100_000,
    }),
);
let fanoutReceiverCounter = 0;

async function runFanoutReceiver(eventId: string): Promise<{
  delivered: number;
  firstSeen: number;
  duplicates: number;
}> {
  fanoutCalls = [];
  const out = await deliverPayoutWebhookToMany(paidTask, FANOUT_ENDPOINTS, {
    fetchImpl: fanoutFetch,
    sleepImpl: fanoutNoSleep,
    now: WEBHOOK_NOW,
    eventId,
  });
  if (
    out.results.length !== FANOUT_ENDPOINTS.length ||
    out.delivered !== FANOUT_ENDPOINTS.length ||
    out.failed !== 0 ||
    out.results.some((r) => !r.ok || r.attempts !== 1 || r.status !== 200) ||
    fanoutCalls.length !== FANOUT_ENDPOINTS.length
  ) {
    throw new Error(
      "benchmark self-check failed: deliverPayoutWebhookToMany x dedupe fan-out",
    );
  }
  let firstSeen = 0;
  let duplicates = 0;
  for (const [i, endpoint] of FANOUT_ENDPOINTS.entries()) {
    const call = fanoutCalls.find((c) => c.url === endpoint.url);
    if (
      !call ||
      JSON.parse(call.body).eventId !== eventId ||
      !verifyPayoutWebhook(call.body, call.signature, endpoint.secret)
    ) {
      throw new Error(
        `benchmark self-check failed: deliverPayoutWebhookToMany x dedupe endpoint ${i} copy does not verify`,
      );
    }
    if (fanoutReceiverDedupes[i].checkAndRecord(eventId)) {
      duplicates++;
    } else {
      firstSeen++;
    }
  }
  return { delivered: out.delivered, firstSeen, duplicates };
}

// One-time fixture validation (outside the timed loop): a fresh
// fan-out records a first sighting on all 4 receivers, and its
// redelivery reports duplicate on all 4 — the same shapes the
// timed loop self-checks on every iteration, pinned once here
// on a fixture eventId the timed loop never reuses.
{
  const fixture = await runFanoutReceiver("bench-fanout-recv-fixture");
  if (
    fixture.delivered !== 4 ||
    fixture.firstSeen !== 4 ||
    fixture.duplicates !== 0
  ) {
    throw new Error(
      "benchmark fixture failed: deliverPayoutWebhookToMany x dedupe first fan-out",
    );
  }
  const redelivery = await runFanoutReceiver("bench-fanout-recv-fixture");
  if (
    redelivery.delivered !== 4 ||
    redelivery.firstSeen !== 0 ||
    redelivery.duplicates !== 4
  ) {
    throw new Error(
      "benchmark fixture failed: deliverPayoutWebhookToMany x dedupe redelivery fan-out",
    );
  }
}

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

// Dedupe miss/evict fixture: a deterministic sequence of 250
// brand-new `eventId`s recorded in a fresh `PayoutEventDedupe`
// under an injected FIXED clock (the clock never advances, so no
// entry expires), with a capacity of 100. Hand-written
// expectations — written out here from the composition above and
// the `checkAndRecord` / prune semantics the dedupe tests pin,
// never derived by calling the store itself:
//   - the first 100 records fill the store exactly: every one is
//     a first sighting (false), misses reach 100, evictions
//     stay 0 and size reaches capacity;
//   - each of the remaining 150 records is also a first sighting,
//     and making room for it LRU-evicts exactly the oldest
//     surviving id (no entry is expired under the fixed clock),
//     so evictions reach exactly 150;
//   - after the full pass the stats are exactly
//     `{ size: 100, hits: 0, misses: 250, evictions: 150 }`,
//     size pinned at capacity, and the survivors are exactly
//     the last 100 ids recorded (`bench-miss-0150` ..
//     `bench-miss-0249`).
// `checkAndRecord` on a miss mutates the store, so the fixture
// is a builder: every timed iteration constructs a fresh dedupe
// and replays the whole sequence, and the reported numbers
// include that rebuild cost (the same accounting the
// watchdog-execution and dedupe-clear rows use).
const DEDUPE_MISS_CAPACITY = 100;
const DEDUPE_MISS_RECORDS = 250;
const DEDUPE_MISS_NOW_MS = BASE_MS + 420_000;
const DEDUPE_MISS_EXPECTED = {
  size: DEDUPE_MISS_CAPACITY,
  hits: 0,
  misses: DEDUPE_MISS_RECORDS,
  evictions: DEDUPE_MISS_RECORDS - DEDUPE_MISS_CAPACITY,
};
const dedupeMissIds: string[] = Array.from(
  { length: DEDUPE_MISS_RECORDS },
  (_, i) => `bench-miss-${String(i).padStart(4, "0")}`,
);
function runDedupeMissEvictPass(where: string): PayoutEventDedupe {
  const fresh = new PayoutEventDedupe({
    maxEntries: DEDUPE_MISS_CAPACITY,
    now: () => DEDUPE_MISS_NOW_MS,
  });
  for (const id of dedupeMissIds) {
    if (fresh.checkAndRecord(id)) {
      throw new Error(
        `benchmark ${where} failed: PayoutEventDedupe miss/evict saw a duplicate`,
      );
    }
  }
  const after = fresh.stats();
  if (
    fresh.size !== DEDUPE_MISS_EXPECTED.size ||
    after.size !== DEDUPE_MISS_EXPECTED.size ||
    after.hits !== DEDUPE_MISS_EXPECTED.hits ||
    after.misses !== DEDUPE_MISS_EXPECTED.misses ||
    after.evictions !== DEDUPE_MISS_EXPECTED.evictions
  ) {
    throw new Error(
      `benchmark ${where} failed: PayoutEventDedupe miss/evict stats`,
    );
  }
  return fresh;
}
// Fixture validation (outside the timed loop): a full pass
// matches the hand-written expectations above.
runDedupeMissEvictPass("fixture");
// Survivor / evicted probe (outside the timed loop): on a fresh
// full pass, the oldest surviving id (`bench-miss-0150`, the
// first of the last 100 recorded) still records as a duplicate
// hit — exactly one hit, nothing else moves — and the first
// recorded id (`bench-miss-0000`, evicted long ago) records as
// a new event again: one more miss, and making room for it
// LRU-evicts one more id, so evictions reach 151 while size
// stays pinned at capacity.
{
  const probe = runDedupeMissEvictPass("fixture");
  const oldestSurviving =
    dedupeMissIds[DEDUPE_MISS_RECORDS - DEDUPE_MISS_CAPACITY];
  if (oldestSurviving !== "bench-miss-0150" || dedupeMissIds[0] !== "bench-miss-0000") {
    throw new Error(
      "benchmark fixture failed: dedupe miss/evict probe id composition",
    );
  }
  if (!probe.checkAndRecord(oldestSurviving)) {
    throw new Error(
      "benchmark fixture failed: dedupe miss/evict oldest surviving id is not a hit",
    );
  }
  const afterHit = probe.stats();
  if (
    afterHit.size !== DEDUPE_MISS_EXPECTED.size ||
    afterHit.hits !== 1 ||
    afterHit.misses !== DEDUPE_MISS_EXPECTED.misses ||
    afterHit.evictions !== DEDUPE_MISS_EXPECTED.evictions
  ) {
    throw new Error(
      "benchmark fixture failed: dedupe miss/evict stats after the survivor hit",
    );
  }
  if (probe.checkAndRecord(dedupeMissIds[0])) {
    throw new Error(
      "benchmark fixture failed: dedupe miss/evict evicted id is not a new event",
    );
  }
  const afterMiss = probe.stats();
  if (
    afterMiss.size !== DEDUPE_MISS_EXPECTED.size ||
    afterMiss.hits !== 1 ||
    afterMiss.misses !== DEDUPE_MISS_EXPECTED.misses + 1 ||
    afterMiss.evictions !== DEDUPE_MISS_EXPECTED.evictions + 1
  ) {
    throw new Error(
      "benchmark fixture failed: dedupe miss/evict stats after the evicted re-record",
    );
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

// Policy snapshot round-trip fixture: a module-scope task that
// carries both a pinned RBAC policy and finite retry/appeal
// budgets, driven REJECTED through a fixed 8-dispatch path.
// Hand-written expectations — written out here from the snapshot
// contract in src/taskLifecycle.ts and cross-checked against
// test/rbac.test.ts, test/resubmitBudget.test.ts,
// test/disputeBudget.test.ts, test/idempotencyKeySnapshot.test.ts
// (envelope option fields), and the dispatch fail-fast order in
// src/taskLifecycle.ts (transition legality, then RBAC, then the
// RESUBMIT/DISPUTE budget gates), never derived by calling
// toJSON/fromJSON themselves:
//   - BENCH-522 is constructed with rolePolicy { DISPUTE:
//     ["contributor"], RESUBMIT: ["contributor"] } (a policy
//     covering exactly the two events a REJECTED task can still
//     take), maxResubmits: 1, and maxDisputes: 2;
//   - PUBLISH (contributor) -> OPEN, ACCEPT (contributor) ->
//     ACCEPTED (ACCEPT is not policy-covered, so any actor
//     passes), START_CAPTURE (contributor) -> CAPTURING,
//     SUBMIT (contributor) -> SUBMITTED, BEGIN_REVIEW
//     (reviewer) -> IN_REVIEW, REJECT (reviewer) -> REJECTED,
//     RESUBMIT (contributor) -> CAPTURING (policy-covered
//     event with an authorized actor; spends the single
//     RESUBMIT budget, 1 of 1 used), SUBMIT (contributor) ->
//     SUBMITTED, BEGIN_REVIEW (reviewer) -> IN_REVIEW, REJECT
//     (reviewer) -> REJECTED: 10 entries, final state
//     REJECTED, timestamps BASE_MS + 0/1000/../9000 ms fixed;
//   - the envelope carries v 1, maxResubmits 1, maxDisputes 2,
//     and rolePolicy byte-identical to the pinned object (the
//     constructor's Map preserves the option's key order
//     through Object.fromEntries); slaDeadlines is the empty
//     object (the fixture sets no deadlines), idempotencyKeys
//     is absent (no key consumed), and the used counts are NOT
//     stored in the envelope — RESUBMIT reads 1 and DISPUTE
//     reads 0 on both sides of the trip, re-derived from the
//     history;
//   - re-exporting a restored task is the fixed point at the
//     same serialized byte length;
//   - outside the timed loop, two probe dispatches pin the
//     post-restore enforcement side: an unauthorized actor on
//     the policy-covered DISPUTE throws exactly
//     `actor not authorized for DISPUTE: "intruder" is not in
//     [contributor]` (the same wording test/rbac.test.ts pins,
//     specialized to this fixture's policy) while the appeal
//     budget is still unspent — proving RBAC survived the
//     trip; and an authorized RESUBMIT on the restored task
//     throws exactly `resubmit budget exhausted: 1 of 1
//     RESUBMITs already used` (the wording
//     test/resubmitBudget.test.ts pins) — the budget is
//     history-derived, so persistence does not reset it.
//     Both rejected dispatches leave state and history
//     byte-identical (compared through the canonical NDJSON
//     serializer).
const POLICY_SNAPSHOT_ID = "BENCH-522";
const POLICY_SNAPSHOT_ROLE_POLICY: RolePolicy = {
  DISPUTE: ["contributor"],
  RESUBMIT: ["contributor"],
};
const POLICY_SNAPSHOT_MAX_RESUBMITS = 1;
const POLICY_SNAPSHOT_MAX_DISPUTES = 2;
const POLICY_SNAPSHOT_RESUBMIT_USED = 1;
const POLICY_SNAPSHOT_DISPUTE_USED = 0;
const POLICY_SNAPSHOT_RBAC_ERROR =
  'actor not authorized for DISPUTE: "intruder" is not in [contributor]';
const POLICY_SNAPSHOT_RESUBMIT_EXHAUSTED_ERROR =
  "resubmit budget exhausted: 1 of 1 RESUBMITs already used";
function buildPolicySnapshotTask(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id, {
    rolePolicy: POLICY_SNAPSHOT_ROLE_POLICY,
    maxResubmits: POLICY_SNAPSHOT_MAX_RESUBMITS,
    maxDisputes: POLICY_SNAPSHOT_MAX_DISPUTES,
  });
  const steps: Array<{ event: TaskEvent; actor: string }> = [
    { event: "PUBLISH", actor: "contributor" },
    { event: "ACCEPT", actor: "contributor" },
    { event: "START_CAPTURE", actor: "contributor" },
    { event: "SUBMIT", actor: "contributor" },
    { event: "BEGIN_REVIEW", actor: "reviewer" },
    { event: "REJECT", actor: "reviewer" },
    { event: "RESUBMIT", actor: "contributor" },
    { event: "SUBMIT", actor: "contributor" },
    { event: "BEGIN_REVIEW", actor: "reviewer" },
    { event: "REJECT", actor: "reviewer" },
  ];
  steps.forEach(({ event, actor }, i) => {
    task.dispatch(event, {
      actor,
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return task;
}
const policySnapshotTask = buildPolicySnapshotTask(POLICY_SNAPSHOT_ID);
if (
  policySnapshotTask.state !== "REJECTED" ||
  policySnapshotTask.history.length !== 10
) {
  throw new Error(
    "benchmark fixture failed: policy snapshot lifecycle did not reach REJECTED",
  );
}
const policySnapshotFixture: TaskSnapshot = policySnapshotTask.toJSON();
const policySnapshotFixtureJsonText = JSON.stringify(policySnapshotFixture);
const policySnapshotFixtureBytes = new TextEncoder().encode(
  policySnapshotFixtureJsonText,
).length;
function checkPolicySnapshotRoundTrip(
  restored: TaskLifecycle,
  where: string,
): void {
  if (
    restored.id !== POLICY_SNAPSHOT_ID ||
    restored.state !== "REJECTED" ||
    restored.history.length !== 10 ||
    usedCountOf(restored, "RESUBMIT") !== POLICY_SNAPSHOT_RESUBMIT_USED ||
    usedCountOf(restored, "DISPUTE") !== POLICY_SNAPSHOT_DISPUTE_USED
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < 10; i++) {
    const a = restored.history[i];
    const b = policySnapshotTask.history[i];
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
    reExported.v !== policySnapshotFixture.v ||
    reExported.id !== policySnapshotFixture.id ||
    reExported.state !== policySnapshotFixture.state ||
    reExported.maxResubmits !== POLICY_SNAPSHOT_MAX_RESUBMITS ||
    reExported.maxDisputes !== POLICY_SNAPSHOT_MAX_DISPUTES ||
    JSON.stringify(reExported.rolePolicy) !==
      JSON.stringify(POLICY_SNAPSHOT_ROLE_POLICY) ||
    reExported.idempotencyKeys !== undefined ||
    Object.keys(reExported.slaDeadlines ?? {}).length !== 0 ||
    reExportedBytes !== policySnapshotFixtureBytes
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
if (
  policySnapshotFixture.v !== 1 ||
  policySnapshotFixture.id !== POLICY_SNAPSHOT_ID ||
  policySnapshotFixture.state !== "REJECTED" ||
  policySnapshotFixture.history.length !== 10 ||
  policySnapshotFixture.maxResubmits !== POLICY_SNAPSHOT_MAX_RESUBMITS ||
  policySnapshotFixture.maxDisputes !== POLICY_SNAPSHOT_MAX_DISPUTES ||
  JSON.stringify(policySnapshotFixture.rolePolicy) !==
    JSON.stringify(POLICY_SNAPSHOT_ROLE_POLICY) ||
  policySnapshotFixture.idempotencyKeys !== undefined ||
  Object.keys(policySnapshotFixture.slaDeadlines ?? {}).length !== 0 ||
  usedCountOf(policySnapshotTask, "RESUBMIT") !==
    POLICY_SNAPSHOT_RESUBMIT_USED ||
  usedCountOf(policySnapshotTask, "DISPUTE") !== POLICY_SNAPSHOT_DISPUTE_USED
) {
  throw new Error("benchmark fixture failed: policy snapshot shape");
}
// One-time validation (outside the timed loop): the in-memory
// envelope restores to exactly the hand-written expectations.
checkPolicySnapshotRoundTrip(
  TaskLifecycle.fromJSON(policySnapshotFixture),
  "policy snapshot fixture",
);
// One-time JSON text round-trip validation (outside the timed
// loop): the persisted text form (JSON.stringify / JSON.parse —
// what a document store actually keeps) restores identically.
checkPolicySnapshotRoundTrip(
  TaskLifecycle.fromJSON(JSON.parse(policySnapshotFixtureJsonText) as unknown),
  "policy snapshot text round-trip",
);
// RBAC probe (outside the timed loop): on the restored task, an
// unauthorized actor on the policy-covered DISPUTE throws the
// pinned authorization error (the appeal budget is unspent, so
// this is purely the RBAC gate firing) and leaves state and
// history byte-identical.
{
  const probe = TaskLifecycle.fromJSON(
    JSON.parse(policySnapshotFixtureJsonText) as unknown,
  );
  const historyBefore = historyToNdjson(probe.history);
  let rbacError = "";
  try {
    probe.dispatch("DISPUTE", {
      actor: "intruder",
      at: new Date(BASE_MS + 10000).toISOString(),
    });
  } catch (err) {
    rbacError = err instanceof Error ? err.message : String(err);
  }
  if (
    rbacError !== POLICY_SNAPSHOT_RBAC_ERROR ||
    probe.state !== "REJECTED" ||
    probe.history.length !== 10 ||
    historyToNdjson(probe.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: policy snapshot RBAC probe",
    );
  }
}
// Budget probe (outside the timed loop): on the restored task,
// an authorized RESUBMIT throws the pinned exhaustion error —
// the used count is re-derived from the history, so persistence
// does not reset the budget — and leaves state and history
// byte-identical.
{
  const probe = TaskLifecycle.fromJSON(
    JSON.parse(policySnapshotFixtureJsonText) as unknown,
  );
  const historyBefore = historyToNdjson(probe.history);
  let budgetError = "";
  try {
    probe.dispatch("RESUBMIT", {
      actor: "contributor",
      at: new Date(BASE_MS + 10000).toISOString(),
    });
  } catch (err) {
    budgetError = err instanceof Error ? err.message : String(err);
  }
  if (
    budgetError !== POLICY_SNAPSHOT_RESUBMIT_EXHAUSTED_ERROR ||
    probe.state !== "REJECTED" ||
    probe.history.length !== 10 ||
    historyToNdjson(probe.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: policy snapshot budget probe",
    );
  }
}

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

// AuditSecret keyed-chain fixture: a second full lifecycle on a
// task constructed with a pinned `auditSecret`, driven through
// the exact same LIFECYCLE steps, actors, and fixed timestamps
// (BASE_MS + per-step offsets) as the unkeyed `historyFixture`,
// so the only difference between the two histories is the chain
// mode: every link here is HMAC-SHA256 keyed by the secret
// instead of plain SHA-256. Hand-written expectations — written
// out here from the keyed-chain semantics in
// src/taskLifecycle.ts and cross-checked against
// test/keyedHashChain.test.ts, never derived by calling
// verifyHistoryChain itself:
//   - the keyed history holds exactly 8 entries and verifies
//     (returns exactly true) under the pinned secret;
//   - its first entry's prevHash is exactly GENESIS_PREV_HASH
//     and every later entry's prevHash equals its predecessor's
//     hash, the same linkage convention as the unkeyed chain;
//   - under a different (wrong) secret it must return false —
//     checked once, outside the timed loop;
//   - a detached copy whose middle entry (index 3, SUBMIT)
//     gains a payoutAmount it never carried no longer
//     recomputes its stored HMAC, so it must return false
//     under the pinned secret — checked once, outside the
//     timed loop, and the intact fixture must still verify
//     afterwards, proving the tamper copy was detached;
//   - verified without any secret, the same keyed history
//     must return false (fail-closed both ways: a keyed chain
//     never verifies unkeyed, exactly as an unkeyed chain
//     never verifies under a secret) — checked once, outside
//     the timed loop.
const BENCH_AUDIT_SECRET = "bench-audit-secret";
const BENCH_AUDIT_WRONG_SECRET = "bench-audit-secret-wrong";
function runKeyedLifecycle(): TaskLifecycle {
  const task = new TaskLifecycle("BENCH-KEYED-001", {
    auditSecret: BENCH_AUDIT_SECRET,
  });
  LIFECYCLE.forEach(({ event, actor, extra }, i) => {
    task.dispatch(event, {
      actor,
      at: new Date(BASE_MS + i * 1000).toISOString(),
      ...extra,
    });
  });
  return task;
}
const keyedPaidTask = runKeyedLifecycle();
if (keyedPaidTask.state !== "PAID" || keyedPaidTask.history.length !== 8) {
  throw new Error(
    "benchmark fixture failed: keyed lifecycle did not reach PAID",
  );
}
// Detached plain copies, exactly what a persisted keyed audit
// log looks like.
const keyedHistoryFixture: TaskHistoryEntry[] = keyedPaidTask.history.map(
  (e) => ({ ...e }),
);
function checkVerifyHistoryChainAuditSecret(where: string): void {
  if (
    keyedHistoryFixture.length !== 8 ||
    !verifyHistoryChain(keyedHistoryFixture, {
      auditSecret: BENCH_AUDIT_SECRET,
    })
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  if (keyedHistoryFixture[0].prevHash !== GENESIS_PREV_HASH) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 1; i < keyedHistoryFixture.length; i++) {
    if (keyedHistoryFixture[i].prevHash !== keyedHistoryFixture[i - 1].hash) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time validation (outside the timed loop): the intact
// keyed fixture verifies under the pinned secret with its
// genesis and successor links pinned.
checkVerifyHistoryChainAuditSecret("verifyHistoryChain auditSecret fixture");
// Wrong-secret rejection (outside the timed loop): the same
// history under a different secret must return false.
if (
  verifyHistoryChain(keyedHistoryFixture, {
    auditSecret: BENCH_AUDIT_WRONG_SECRET,
  })
) {
  throw new Error(
    "benchmark fixture failed: verifyHistoryChain auditSecret accepted a wrong secret",
  );
}
// Tamper rejection (outside the timed loop): the altered copy
// must return false under the pinned secret — and the intact
// fixture must still verify afterwards, proving the tamper
// copy was detached.
const keyedChainTampered: TaskHistoryEntry[] = keyedHistoryFixture.map(
  (e) => ({ ...e }),
);
keyedChainTampered[3] = {
  ...keyedChainTampered[3],
  payoutAmount: 999,
};
if (
  verifyHistoryChain(keyedChainTampered, {
    auditSecret: BENCH_AUDIT_SECRET,
  })
) {
  throw new Error(
    "benchmark fixture failed: verifyHistoryChain auditSecret accepted a tampered history",
  );
}
checkVerifyHistoryChainAuditSecret(
  "verifyHistoryChain auditSecret fixture after tamper check",
);
// Fail-closed without a secret (outside the timed loop): the
// keyed history verified with no secret at all must return
// false — the pinned source semantics for a keyed chain read
// unkeyed.
if (verifyHistoryChain(keyedHistoryFixture)) {
  throw new Error(
    "benchmark fixture failed: verifyHistoryChain auditSecret verified a keyed history without a secret",
  );
}
checkVerifyHistoryChainAuditSecret(
  "verifyHistoryChain auditSecret fixture after unkeyed check",
);


// Dispatch idempotency dedupe fixture: a fresh task per pass —
// the first keyed dispatch consumes the pinned key, so no task
// can serve two passes. Hand-written expectations — written out
// here from the dispatch idempotency semantics in
// src/taskLifecycle.ts and cross-checked against
// test/idempotencyKey.test.ts and the CLI demo segment, never
// derived from the dedupe path itself:
//   - the first `PUBLISH` under the pinned key returns OPEN and
//     appends exactly one entry (seq 1, DRAFT -> OPEN, at the
//     base instant);
//   - the same event under the same key again returns the
//     current state (OPEN) and appends nothing — the history
//     stays at exactly that one entry, so the pass's total
//     growth is +1 with a gap-free seq;
//   - the consumed-key snapshot (`toJSON().idempotencyKeys`)
//     holds exactly the pinned key, and the collecting listener
//     is notified exactly once (for the first dispatch only).
// Outside the timed loop, three probes pin the wider semantics:
//   - cross-event dedupe: the same key under `ACCEPT` (a legal
//     next event) still dedupes — it returns OPEN and appends
//     nothing, because the key, not the event, is the identity;
//   - stale retry: after the task moves on to ACCEPTED under a
//     keyless dispatch, the original key under `PUBLISH` returns
//     the current state (ACCEPTED) and appends nothing;
//   - failed dispatch consumes no key: an illegal `ACCEPT` from
//     DRAFT under a fresh key throws the hand-pinned
//     invalid-transition error and leaves no trace, and the
//     corrected `PUBLISH` under that same key then executes;
//   - keyless dispatches keep the pre-idempotency behavior: two
//     keyless dispatches append two entries with seq 1 and 2.
const IDEMPOTENCY_KEY = "bench-idem-publish";
const IDEMPOTENCY_RETRY_KEY = "bench-idem-retry";
function runIdempotencyPass(where: string): TaskLifecycle {
  const task = new TaskLifecycle("BENCH-IDEM-001");
  const notified: TaskEvent[] = [];
  task.subscribe((event) => {
    notified.push(event);
  });
  const first = task.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS).toISOString(),
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  const duplicate = task.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS + 1000).toISOString(),
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  const entry = task.history[0];
  if (
    first !== "OPEN" ||
    duplicate !== "OPEN" ||
    task.state !== "OPEN" ||
    task.history.length !== 1 ||
    entry.seq !== 1 ||
    entry.event !== "PUBLISH" ||
    entry.from !== "DRAFT" ||
    entry.to !== "OPEN" ||
    entry.at !== new Date(BASE_MS).toISOString() ||
    JSON.stringify(task.toJSON().idempotencyKeys) !==
      JSON.stringify([IDEMPOTENCY_KEY]) ||
    notified.length !== 1 ||
    notified[0] !== "PUBLISH"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  return task;
}
// One-time validation (outside the timed loop): the timed pass
// itself, run once end to end.
runIdempotencyPass("dispatch idempotency dedupe fixture");
// Cross-event + stale-retry probes (outside the timed loop):
// the pinned key dedupes under a different event, and still
// dedupes — answering with the then-current state — after the
// task has moved on under a keyless dispatch.
{
  const probe = runIdempotencyPass("dispatch idempotency cross-event probe");
  const crossEvent = probe.dispatch("ACCEPT", {
    actor: "contributor",
    at: new Date(BASE_MS + 2000).toISOString(),
    quotedAmount: 125,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  if (
    crossEvent !== "OPEN" ||
    probe.state !== "OPEN" ||
    probe.history.length !== 1
  ) {
    throw new Error(
      "benchmark fixture failed: dispatch idempotency cross-event dedupe",
    );
  }
  const advanced = probe.dispatch("ACCEPT", {
    actor: "contributor",
    at: new Date(BASE_MS + 3000).toISOString(),
    quotedAmount: 125,
  });
  const stale = probe.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS + 4000).toISOString(),
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  // Widened reads: the checks above narrowed the getter types
  // to their first-probe literals, so re-read through explicitly
  // typed locals before comparing against the moved-on values.
  const probeStateAfter = probe.state as TaskState;
  const probeLengthAfter = probe.history.length as number;
  if (
    advanced !== "ACCEPTED" ||
    stale !== "ACCEPTED" ||
    probeStateAfter !== "ACCEPTED" ||
    probeLengthAfter !== 2 ||
    probe.history[1].seq !== 2
  ) {
    throw new Error(
      "benchmark fixture failed: dispatch idempotency stale retry",
    );
  }
}
// Failed-dispatch probe (outside the timed loop): an illegal
// dispatch under a fresh key throws the hand-pinned error,
// consumes nothing, and the corrected retry under the same key
// executes.
{
  const probe = new TaskLifecycle("BENCH-IDEM-002");
  let failedMessage = "";
  try {
    probe.dispatch("ACCEPT", {
      actor: "contributor",
      at: new Date(BASE_MS).toISOString(),
      idempotencyKey: IDEMPOTENCY_RETRY_KEY,
    });
  } catch (err) {
    failedMessage = err instanceof Error ? err.message : String(err);
  }
  const corrected = probe.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS + 1000).toISOString(),
    idempotencyKey: IDEMPOTENCY_RETRY_KEY,
  });
  if (
    failedMessage !== "invalid transition: ACCEPT from DRAFT" ||
    corrected !== "OPEN" ||
    probe.state !== "OPEN" ||
    probe.history.length !== 1 ||
    probe.history[0].seq !== 1 ||
    JSON.stringify(probe.toJSON().idempotencyKeys) !==
      JSON.stringify([IDEMPOTENCY_RETRY_KEY])
  ) {
    throw new Error(
      "benchmark fixture failed: dispatch idempotency failed dispatch consumed a key",
    );
  }
}
// Keyless probe (outside the timed loop): omitting the key
// preserves the pre-idempotency behavior — every dispatch
// validates and appends, seq gap-free.
{
  const probe = new TaskLifecycle("BENCH-IDEM-003");
  probe.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS).toISOString(),
  });
  probe.dispatch("ACCEPT", {
    actor: "contributor",
    at: new Date(BASE_MS + 1000).toISOString(),
    quotedAmount: 125,
  });
  if (
    probe.state !== "ACCEPTED" ||
    probe.history.length !== 2 ||
    probe.history[0].seq !== 1 ||
    probe.history[1].seq !== 2 ||
    probe.toJSON().idempotencyKeys !== undefined
  ) {
    throw new Error(
      "benchmark fixture failed: dispatch idempotency keyless dispatches",
    );
  }
}


// RequirePayoutRef dispatch fixture: a fresh task per pass —
// the enforced `PAYOUT_COMPLETE` dispatch mutates its task to
// the terminal PAID state, so no task can serve two passes.
// The fixture builder drives a task through the first seven
// pinned LIFECYCLE steps (PUBLISH .. REQUEST_PAYOUT, at
// BASE_MS + step-index seconds — the same fixed timestamps
// `runLifecycle()` uses) to PAYOUT_PENDING. Hand-written
// expectations — written out here from the TaskLifecycleOptions
// docs in src/taskLifecycle.ts and cross-checked against
// test/requirePayoutRef.test.ts and the CLI demo segment,
// never derived from the gate itself:
//   - an enforced task (constructed with
//     `requirePayoutRef: true`) settles under a
//     `PAYOUT_COMPLETE` carrying the pinned payoutRef: the
//     dispatch returns PAID, the history grows from 7 to
//     exactly 8 entries, and the last entry is seq 8 /
//     `PAYOUT_COMPLETE` / at BASE + 7s, carrying the pinned
//     payoutRef verbatim;
//   - outside the timed loop, a ref-less `PAYOUT_COMPLETE`
//     on an enforced task throws exactly the pinned error
//     below and leaves the task in PAYOUT_PENDING with
//     exactly 7 history entries (nothing was appended —
//     the gate is fail-fast, checked before the audit
//     entry is written);
//   - outside the timed loop, a default task (the option
//     unset — the advisory default) still settles without
//     a reference, and its last entry carries no payoutRef.
const REQUIRE_PAYOUT_REF_ERROR =
  "payout reference required: PAYOUT_COMPLETE must carry a non-empty payoutRef when requirePayoutRef is enabled";
const REQUIRE_PAYOUT_REF_REF = "bench-pay-require-001";
function buildPayoutPendingTask(
  id: string,
  opts?: { requirePayoutRef: boolean },
): TaskLifecycle {
  const task = new TaskLifecycle(id, opts);
  LIFECYCLE.slice(0, 7).forEach(({ event, actor, extra }, i) => {
    task.dispatch(event, {
      actor,
      at: new Date(BASE_MS + i * 1000).toISOString(),
      ...extra,
    });
  });
  return task;
}
function runRequirePayoutRefDispatch(where: string): TaskLifecycle {
  const task = buildPayoutPendingTask("BENCH-RPR-001", {
    requirePayoutRef: true,
  });
  if (task.state !== "PAYOUT_PENDING" || task.history.length !== 7) {
    throw new Error(`benchmark self-check failed: ${where} fixture`);
  }
  const result = task.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    at: new Date(BASE_MS + 7000).toISOString(),
    payoutRef: REQUIRE_PAYOUT_REF_REF,
    payoutAmount: 125,
  });
  const last = task.history[task.history.length - 1];
  const stateAfter = task.state as TaskState;
  const lengthAfter = task.history.length as number;
  if (
    result !== "PAID" ||
    stateAfter !== "PAID" ||
    lengthAfter !== 8 ||
    last.seq !== 8 ||
    last.event !== "PAYOUT_COMPLETE" ||
    last.from !== "PAYOUT_PENDING" ||
    last.to !== "PAID" ||
    last.at !== new Date(BASE_MS + 7000).toISOString() ||
    last.payoutRef !== REQUIRE_PAYOUT_REF_REF ||
    last.payoutAmount !== 125
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  return task;
}
// One-time validation (outside the timed loop): the timed pass
// itself, run once end to end.
runRequirePayoutRefDispatch("requirePayoutRef dispatch fixture");
// Rejection probe (outside the timed loop): a ref-less
// PAYOUT_COMPLETE on an enforced task throws the pinned error
// and leaves state and history untouched.
{
  const probe = buildPayoutPendingTask("BENCH-RPR-002", {
    requirePayoutRef: true,
  });
  let rejectedError = "";
  try {
    probe.dispatch("PAYOUT_COMPLETE", {
      actor: "system",
      at: new Date(BASE_MS + 7000).toISOString(),
    });
  } catch (err) {
    rejectedError = err instanceof Error ? err.message : String(err);
  }
  const probeStateAfter = probe.state as TaskState;
  const probeLengthAfter = probe.history.length as number;
  if (
    rejectedError !== REQUIRE_PAYOUT_REF_ERROR ||
    probeStateAfter !== "PAYOUT_PENDING" ||
    probeLengthAfter !== 7 ||
    probe.history[6].seq !== 7 ||
    probe.history[6].event !== "REQUEST_PAYOUT"
  ) {
    throw new Error(
      "benchmark fixture failed: requirePayoutRef ref-less rejection",
    );
  }
}
// Default probe (outside the timed loop): the option unset
// keeps the advisory default — a ref-less PAYOUT_COMPLETE
// still settles, and its last entry carries no payoutRef.
{
  const probe = buildPayoutPendingTask("BENCH-RPR-003");
  const result = probe.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    at: new Date(BASE_MS + 7000).toISOString(),
    payoutAmount: 125,
  });
  const probeStateAfter = probe.state as TaskState;
  const last = probe.history[probe.history.length - 1];
  if (
    result !== "PAID" ||
    probeStateAfter !== "PAID" ||
    probe.history.length !== 8 ||
    last.seq !== 8 ||
    last.event !== "PAYOUT_COMPLETE" ||
    last.payoutRef !== undefined
  ) {
    throw new Error(
      "benchmark fixture failed: requirePayoutRef default settles without a reference",
    );
  }
}

// ExpectedSeq dispatch fixture: a fresh task per pass —
// the guarded `START_CAPTURE` dispatch mutates its task to
// CAPTURING, so no task can serve two passes. The fixture
// builder drives a task through the first two pinned
// LIFECYCLE steps (PUBLISH, ACCEPT, at BASE_MS + step-index
// seconds — the same fixed timestamps `runLifecycle()`
// uses) to a pinned 2-entry history in ACCEPTED.
// Hand-written expectations — written out here from the
// DispatchOptions docs in src/taskLifecycle.ts and
// cross-checked against test/expectedSeq.test.ts, never
// derived from the guard itself:
//   - a task at seq 2 advances under
//     `dispatch("START_CAPTURE", { expectedSeq: 2 })`: the
//     dispatch returns CAPTURING, the history grows from 2
//     to exactly 3 entries, and the last entry is seq 3 /
//     `START_CAPTURE` / ACCEPTED -> CAPTURING / at
//     BASE + 2s, carrying the pinned actor verbatim;
//   - outside the timed loop, a stale `expectedSeq: 1`
//     on that same task shape throws exactly the pinned
//     conflict error below and leaves the task in
//     ACCEPTED with its history byte-identical through
//     the canonical NDJSON serializer (the guard runs
//     before every other check and changes nothing);
//   - outside the timed loop, `expectedSeq: 0` is the
//     guard for an empty history: a fresh task advances
//     under it to OPEN with exactly 1 entry;
//   - outside the timed loop, illegal values -1 and 1.5
//     throw exactly their pinned configuration errors
//     below and append nothing;
//   - outside the timed loop, dispatch without
//     `expectedSeq` keeps the exact pre-guard behavior.
const EXPECTED_SEQ_CONFLICT_ERROR =
  "dispatch conflict: expected seq 1 but task is at seq 2";
const EXPECTED_SEQ_ILLEGAL_NEGATIVE_ERROR =
  "invalid dispatch options: expectedSeq must be a non-negative integer, got -1";
const EXPECTED_SEQ_ILLEGAL_FRACTION_ERROR =
  "invalid dispatch options: expectedSeq must be a non-negative integer, got 1.5";
function buildExpectedSeqTask(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id);
  LIFECYCLE.slice(0, 2).forEach(({ event, actor, extra }, i) => {
    task.dispatch(event, {
      actor,
      at: new Date(BASE_MS + i * 1000).toISOString(),
      ...extra,
    });
  });
  return task;
}
function runExpectedSeqDispatch(where: string): TaskLifecycle {
  const task = buildExpectedSeqTask("BENCH-SEQ-001");
  if (task.state !== "ACCEPTED" || task.history.length !== 2) {
    throw new Error(`benchmark self-check failed: ${where} fixture`);
  }
  const result = task.dispatch("START_CAPTURE", {
    actor: "contributor",
    at: new Date(BASE_MS + 2000).toISOString(),
    expectedSeq: 2,
  });
  const last = task.history[task.history.length - 1];
  const stateAfter = task.state as TaskState;
  const lengthAfter = task.history.length as number;
  if (
    result !== "CAPTURING" ||
    stateAfter !== "CAPTURING" ||
    lengthAfter !== 3 ||
    last.seq !== 3 ||
    last.event !== "START_CAPTURE" ||
    last.from !== "ACCEPTED" ||
    last.to !== "CAPTURING" ||
    last.at !== new Date(BASE_MS + 2000).toISOString() ||
    last.actor !== "contributor"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  return task;
}
// One-time validation (outside the timed loop): the timed pass
// itself, run once end to end.
runExpectedSeqDispatch("expectedSeq dispatch fixture");
// Conflict probe (outside the timed loop): a stale
// expectedSeq throws the pinned conflict error and leaves
// state and history byte-identical.
{
  const probe = buildExpectedSeqTask("BENCH-SEQ-002");
  const historyBefore = historyToNdjson(probe.history);
  let conflictError = "";
  try {
    probe.dispatch("START_CAPTURE", {
      actor: "contributor",
      at: new Date(BASE_MS + 2000).toISOString(),
      expectedSeq: 1,
    });
  } catch (err) {
    conflictError = err instanceof Error ? err.message : String(err);
  }
  const probeStateAfter = probe.state as TaskState;
  if (
    conflictError !== EXPECTED_SEQ_CONFLICT_ERROR ||
    probeStateAfter !== "ACCEPTED" ||
    probe.history.length !== 2 ||
    historyToNdjson(probe.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: expectedSeq stale conflict",
    );
  }
}
// Empty-history probe (outside the timed loop): expectedSeq
// 0 is the guard for an empty history and advances it.
{
  const probe = new TaskLifecycle("BENCH-SEQ-003");
  const result = probe.dispatch("PUBLISH", {
    actor: "researcher",
    at: new Date(BASE_MS).toISOString(),
    expectedSeq: 0,
  });
  const last = probe.history[probe.history.length - 1];
  if (
    result !== "OPEN" ||
    probe.history.length !== 1 ||
    last.seq !== 1 ||
    last.event !== "PUBLISH"
  ) {
    throw new Error(
      "benchmark fixture failed: expectedSeq 0 on an empty history",
    );
  }
}
// Illegal-value probes (outside the timed loop): -1 and
// 1.5 throw their exact pinned configuration errors and
// append nothing.
for (const [bad, pinned] of [
  [-1, EXPECTED_SEQ_ILLEGAL_NEGATIVE_ERROR],
  [1.5, EXPECTED_SEQ_ILLEGAL_FRACTION_ERROR],
] as Array<[number, string]>) {
  const probe = new TaskLifecycle("BENCH-SEQ-004");
  let illegalError = "";
  try {
    probe.dispatch("PUBLISH", {
      actor: "researcher",
      at: new Date(BASE_MS).toISOString(),
      expectedSeq: bad,
    });
  } catch (err) {
    illegalError = err instanceof Error ? err.message : String(err);
  }
  if (
    illegalError !== pinned ||
    probe.state !== "DRAFT" ||
    probe.history.length !== 0
  ) {
    throw new Error(
      "benchmark fixture failed: expectedSeq illegal value",
    );
  }
}
// No-guard probe (outside the timed loop): omitting
// expectedSeq preserves the exact pre-guard behavior.
{
  const probe = buildExpectedSeqTask("BENCH-SEQ-005");
  const result = probe.dispatch("START_CAPTURE", {
    actor: "contributor",
    at: new Date(BASE_MS + 2000).toISOString(),
  });
  if (result !== "CAPTURING" || probe.history.length !== 3) {
    throw new Error(
      "benchmark fixture failed: expectedSeq omitted behavior",
    );
  }
}

// MaxDisputes dispute-budget fixture: a fresh task per pass —
// the budgeted `DISPUTE` dispatch spends the single appeal
// round and mutates its task to DISPUTED, so no task can
// serve two passes. The fixture builder constructs a task
// with the caller's budget and drives it through the first
// five pinned LIFECYCLE steps plus REJECT (at BASE_MS +
// step-index seconds — the same fixed timestamps
// `runLifecycle()` uses) to a pinned 6-entry history in
// REJECTED, the only DISPUTE-able state.
// Hand-written expectations — written out here from the
// TaskLifecycleOptions docs in src/taskLifecycle.ts and
// cross-checked against test/disputeBudget.test.ts, never
// derived from the budget check itself:
//   - the single budgeted DISPUTE advances the task exactly
//     one step: the dispatch returns DISPUTED, the history
//     grows from 6 to exactly 7 entries, and the last entry
//     is seq 7 / `DISPUTE` / REJECTED -> DISPUTED / at
//     BASE + 6s, carrying the pinned actor verbatim;
//   - outside the timed loop, a second DISPUTE after one
//     full appeal round (DISPUTE + ARBITRATE_REJECT back to
//     REJECTED) throws exactly the pinned budget error
//     below and leaves the task in REJECTED with its
//     history byte-identical through the canonical NDJSON
//     serializer (a failed dispatch appends nothing);
//   - outside the timed loop, a budget of 0 makes the very
//     first DISPUTE throw the pinned budget error at once;
//   - outside the timed loop, a task built without the
//     option (default Infinity) runs repeated appeal rounds
//     exactly as far as the state machine permits — the
//     pre-budget behavior;
//   - outside the timed loop, a snapshot round-trip
//     (toJSON / fromJSON) does not reset the used count:
//     the restored task's budget is still exhausted;
//   - outside the timed loop, illegal budgets -1 and 1.5
//     throw exactly their pinned `invalid option` errors at
//     construction, and an illegal snapshot budget throws
//     its pinned `invalid snapshot` error.
const MAX_DISPUTES_EXHAUSTED_ERROR =
  "dispute budget exhausted: 1 of 1 DISPUTEs already used";
const MAX_DISPUTES_ZERO_ERROR =
  "dispute budget exhausted: 0 of 0 DISPUTEs already used";
const MAX_DISPUTES_ILLEGAL_NEGATIVE_ERROR =
  "invalid option: maxDisputes must be a non-negative integer or Infinity, got -1";
const MAX_DISPUTES_ILLEGAL_FRACTION_ERROR =
  "invalid option: maxDisputes must be a non-negative integer or Infinity, got 1.5";
const MAX_DISPUTES_SNAPSHOT_ILLEGAL_ERROR =
  "invalid snapshot: maxDisputes must be a non-negative integer or Infinity, got -1";
function buildMaxDisputesTask(
  id: string,
  opts?: { maxDisputes?: number },
): TaskLifecycle {
  const task = new TaskLifecycle(id, opts);
  LIFECYCLE.slice(0, 5).forEach(({ event, actor, extra }, i) => {
    task.dispatch(event, {
      actor,
      at: new Date(BASE_MS + i * 1000).toISOString(),
      ...extra,
    });
  });
  task.dispatch("REJECT", {
    actor: "reviewer",
    at: new Date(BASE_MS + 5000).toISOString(),
  });
  return task;
}
function runMaxDisputesDispatch(where: string): TaskLifecycle {
  const task = buildMaxDisputesTask("BENCH-DISPUTE-001", {
    maxDisputes: 1,
  });
  if (task.state !== "REJECTED" || task.history.length !== 6) {
    throw new Error(`benchmark self-check failed: ${where} fixture`);
  }
  const result = task.dispatch("DISPUTE", {
    actor: "contributor",
    at: new Date(BASE_MS + 6000).toISOString(),
  });
  const last = task.history[task.history.length - 1];
  const stateAfter = task.state as TaskState;
  const lengthAfter = task.history.length as number;
  if (
    result !== "DISPUTED" ||
    stateAfter !== "DISPUTED" ||
    lengthAfter !== 7 ||
    last.seq !== 7 ||
    last.event !== "DISPUTE" ||
    last.from !== "REJECTED" ||
    last.to !== "DISPUTED" ||
    last.at !== new Date(BASE_MS + 6000).toISOString() ||
    last.actor !== "contributor"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  return task;
}
// One-time validation (outside the timed loop): the timed pass
// itself, run once end to end.
runMaxDisputesDispatch("maxDisputes dispute budget fixture");
// Exhaustion probe (outside the timed loop): after one full
// appeal round the budget is spent, and the next DISPUTE
// throws the pinned budget error and leaves state and
// history byte-identical.
{
  const probe = buildMaxDisputesTask("BENCH-DISPUTE-002", {
    maxDisputes: 1,
  });
  probe.dispatch("DISPUTE", {
    actor: "contributor",
    at: new Date(BASE_MS + 6000).toISOString(),
  });
  probe.dispatch("ARBITRATE_REJECT", {
    actor: "moderator",
    at: new Date(BASE_MS + 7000).toISOString(),
  });
  const historyBefore = historyToNdjson(probe.history);
  let budgetError = "";
  try {
    probe.dispatch("DISPUTE", {
      actor: "contributor",
      at: new Date(BASE_MS + 8000).toISOString(),
    });
  } catch (err) {
    budgetError = err instanceof Error ? err.message : String(err);
  }
  const probeStateAfter = probe.state as TaskState;
  if (
    budgetError !== MAX_DISPUTES_EXHAUSTED_ERROR ||
    probeStateAfter !== "REJECTED" ||
    probe.history.length !== 8 ||
    historyToNdjson(probe.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: maxDisputes budget exhausted",
    );
  }
}
// Zero-budget probe (outside the timed loop): a budget of 0
// makes the very first DISPUTE throw at once.
{
  const probe = buildMaxDisputesTask("BENCH-DISPUTE-003", {
    maxDisputes: 0,
  });
  const historyBefore = historyToNdjson(probe.history);
  let budgetError = "";
  try {
    probe.dispatch("DISPUTE", {
      actor: "contributor",
      at: new Date(BASE_MS + 6000).toISOString(),
    });
  } catch (err) {
    budgetError = err instanceof Error ? err.message : String(err);
  }
  if (
    budgetError !== MAX_DISPUTES_ZERO_ERROR ||
    probe.state !== "REJECTED" ||
    probe.history.length !== 6 ||
    historyToNdjson(probe.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: maxDisputes zero budget",
    );
  }
}
// Default probe (outside the timed loop): omitting the
// option keeps the pre-budget behavior — repeated appeal
// rounds run exactly as far as the state machine permits.
{
  const probe = buildMaxDisputesTask("BENCH-DISPUTE-004");
  for (let round = 0; round < 3; round++) {
    probe.dispatch("DISPUTE", {
      actor: "contributor",
      at: new Date(BASE_MS + 6000 + round * 2000).toISOString(),
    });
    probe.dispatch("ARBITRATE_REJECT", {
      actor: "moderator",
      at: new Date(BASE_MS + 7000 + round * 2000).toISOString(),
    });
  }
  const disputeCount = probe.history.filter(
    (e) => e.event === "DISPUTE",
  ).length;
  if (
    probe.state !== "REJECTED" ||
    probe.history.length !== 12 ||
    disputeCount !== 3
  ) {
    throw new Error(
      "benchmark fixture failed: maxDisputes default unlimited",
    );
  }
}
// Snapshot probe (outside the timed loop): the round-trip
// does not reset the used count — the restored task's
// budget is still exhausted.
{
  const probe = buildMaxDisputesTask("BENCH-DISPUTE-005", {
    maxDisputes: 1,
  });
  probe.dispatch("DISPUTE", {
    actor: "contributor",
    at: new Date(BASE_MS + 6000).toISOString(),
  });
  probe.dispatch("ARBITRATE_REJECT", {
    actor: "moderator",
    at: new Date(BASE_MS + 7000).toISOString(),
  });
  const snapshot = probe.toJSON();
  const restored = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(snapshot)),
  );
  const historyBefore = historyToNdjson(restored.history);
  let budgetError = "";
  try {
    restored.dispatch("DISPUTE", {
      actor: "contributor",
      at: new Date(BASE_MS + 8000).toISOString(),
    });
  } catch (err) {
    budgetError = err instanceof Error ? err.message : String(err);
  }
  if (
    snapshot.maxDisputes !== 1 ||
    restored.state !== "REJECTED" ||
    restored.history.length !== 8 ||
    budgetError !== MAX_DISPUTES_EXHAUSTED_ERROR ||
    historyToNdjson(restored.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: maxDisputes snapshot round-trip",
    );
  }
}
// Illegal-value probes (outside the timed loop): -1 and
// 1.5 throw their exact pinned `invalid option` errors at
// construction, and an illegal snapshot budget throws its
// pinned `invalid snapshot` error.
for (const [bad, pinned] of [
  [-1, MAX_DISPUTES_ILLEGAL_NEGATIVE_ERROR],
  [1.5, MAX_DISPUTES_ILLEGAL_FRACTION_ERROR],
] as Array<[number, string]>) {
  let illegalError = "";
  try {
    new TaskLifecycle("BENCH-DISPUTE-006", { maxDisputes: bad });
  } catch (err) {
    illegalError = err instanceof Error ? err.message : String(err);
  }
  if (illegalError !== pinned) {
    throw new Error(
      "benchmark fixture failed: maxDisputes illegal value",
    );
  }
}
{
  let snapshotError = "";
  try {
    TaskLifecycle.fromJSON({
      id: "BENCH-DISPUTE-007",
      state: "DRAFT",
      history: [],
      slaDeadlines: {},
      maxDisputes: -1,
    });
  } catch (err) {
    snapshotError = err instanceof Error ? err.message : String(err);
  }
  if (snapshotError !== MAX_DISPUTES_SNAPSHOT_ILLEGAL_ERROR) {
    throw new Error(
      "benchmark fixture failed: maxDisputes snapshot illegal value",
    );
  }
}

// ---------------------------------------------------------------------
// maxResubmits fixture: the timed dispatch below is the budgeted
// RESUBMIT back into CAPTURING on a fresh task constructed with the
// pinned budget `maxResubmits: 2` and driven under fixed timestamps
// to a pinned 6-entry history in REJECTED on every iteration. Hand-
// written expectations — written out here from the fixture
// composition and cross-checked against test/resubmitBudget.test.ts,
// never derived by running the path itself:
//   - the builder dispatches PUBLISH, ACCEPT (quotedAmount 125),
//     START_CAPTURE, SUBMIT, BEGIN_REVIEW under fixed timestamps
//     (BASE + 0..4s), then REJECT (actor "reviewer") at BASE + 5s;
//   - the timed dispatch is RESUBMIT at BASE + 6s (actor
//     "contributor"): REJECTED -> CAPTURING, history grows from 6
//     to 7, last entry seq 7, event RESUBMIT, from REJECTED,
//     to CAPTURING, at BASE + 6s, actor "contributor";
//   - the budget is history-derived: each RESUBMIT entry counts
//     once, so the exhaustion error pins the used count
//     ("resubmit budget exhausted: 2 of 2 RESUBMITs already used")
//     after two full RESUBMIT -> CAPTURING -> SUBMIT ->
//     BEGIN_REVIEW -> REJECT rounds (14 history entries, task back
//     in REJECTED); the budget check runs after the transition
//     legality check and before the audit entry is appended, so a
//     rejected dispatch leaves state and history byte-identical
//     (compared through the canonical NDJSON serializer).
const MAX_RESUBMITS_EXHAUSTED_ERROR =
  "resubmit budget exhausted: 2 of 2 RESUBMITs already used";
const MAX_RESUBMITS_ZERO_ERROR =
  "resubmit budget exhausted: 0 of 0 RESUBMITs already used";
const MAX_RESUBMITS_ILLEGAL_NEGATIVE_ERROR =
  "invalid option: maxResubmits must be a non-negative integer or Infinity, got -1";
const MAX_RESUBMITS_ILLEGAL_FRACTION_ERROR =
  "invalid option: maxResubmits must be a non-negative integer or Infinity, got 1.5";
const MAX_RESUBMITS_SNAPSHOT_ILLEGAL_ERROR =
  "invalid snapshot: maxResubmits must be a non-negative integer or Infinity, got -1";
function buildMaxResubmitsTask(
  id: string,
  opts?: { maxResubmits?: number },
): TaskLifecycle {
  const task = new TaskLifecycle(id, opts);
  LIFECYCLE.slice(0, 5).forEach(({ event, actor, extra }, i) => {
    task.dispatch(event, {
      actor,
      at: new Date(BASE_MS + i * 1000).toISOString(),
      ...extra,
    });
  });
  task.dispatch("REJECT", {
    actor: "reviewer",
    at: new Date(BASE_MS + 5000).toISOString(),
  });
  return task;
}
function runMaxResubmitsDispatch(where: string): TaskLifecycle {
  const task = buildMaxResubmitsTask("BENCH-RESUBMIT-001", {
    maxResubmits: 2,
  });
  if (task.state !== "REJECTED" || task.history.length !== 6) {
    throw new Error(`benchmark self-check failed: ${where} fixture`);
  }
  const result = task.dispatch("RESUBMIT", {
    actor: "contributor",
    at: new Date(BASE_MS + 6000).toISOString(),
  });
  const last = task.history[task.history.length - 1];
  const stateAfter = task.state as TaskState;
  const lengthAfter = task.history.length as number;
  if (
    result !== "CAPTURING" ||
    stateAfter !== "CAPTURING" ||
    lengthAfter !== 7 ||
    last.seq !== 7 ||
    last.event !== "RESUBMIT" ||
    last.from !== "REJECTED" ||
    last.to !== "CAPTURING" ||
    last.at !== new Date(BASE_MS + 6000).toISOString() ||
    last.actor !== "contributor"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  return task;
}
// One-time validation (outside the timed loop): the timed pass
// itself, run once end to end.
runMaxResubmitsDispatch("maxResubmits retry budget fixture");
// Exhaustion probe (outside the timed loop): two full
// RESUBMIT rounds back to REJECTED spend the budget, and the
// third RESUBMIT throws the pinned budget error and leaves
// state and history byte-identical.
{
  const probe = buildMaxResubmitsTask("BENCH-RESUBMIT-002", {
    maxResubmits: 2,
  });
  for (let round = 0; round < 2; round++) {
    probe.dispatch("RESUBMIT", {
      actor: "contributor",
      at: new Date(BASE_MS + 6000 + round * 4000).toISOString(),
    });
    probe.dispatch("SUBMIT", {
      actor: "contributor",
      at: new Date(BASE_MS + 7000 + round * 4000).toISOString(),
    });
    probe.dispatch("BEGIN_REVIEW", {
      actor: "reviewer",
      at: new Date(BASE_MS + 8000 + round * 4000).toISOString(),
    });
    probe.dispatch("REJECT", {
      actor: "reviewer",
      at: new Date(BASE_MS + 9000 + round * 4000).toISOString(),
    });
  }
  const historyBefore = historyToNdjson(probe.history);
  let budgetError = "";
  try {
    probe.dispatch("RESUBMIT", {
      actor: "contributor",
      at: new Date(BASE_MS + 14000).toISOString(),
    });
  } catch (err) {
    budgetError = err instanceof Error ? err.message : String(err);
  }
  const probeStateAfter = probe.state as TaskState;
  if (
    budgetError !== MAX_RESUBMITS_EXHAUSTED_ERROR ||
    probeStateAfter !== "REJECTED" ||
    probe.history.length !== 14 ||
    historyToNdjson(probe.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: maxResubmits budget exhausted",
    );
  }
}
// Zero-budget probe (outside the timed loop): a budget of 0
// makes the very first RESUBMIT throw at once.
{
  const probe = buildMaxResubmitsTask("BENCH-RESUBMIT-003", {
    maxResubmits: 0,
  });
  const historyBefore = historyToNdjson(probe.history);
  let budgetError = "";
  try {
    probe.dispatch("RESUBMIT", {
      actor: "contributor",
      at: new Date(BASE_MS + 6000).toISOString(),
    });
  } catch (err) {
    budgetError = err instanceof Error ? err.message : String(err);
  }
  if (
    budgetError !== MAX_RESUBMITS_ZERO_ERROR ||
    probe.state !== "REJECTED" ||
    probe.history.length !== 6 ||
    historyToNdjson(probe.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: maxResubmits zero budget",
    );
  }
}
// Default probe (outside the timed loop): omitting the
// option keeps the pre-budget behavior — repeated resubmit
// rounds run exactly as far as the state machine permits.
{
  const probe = buildMaxResubmitsTask("BENCH-RESUBMIT-004");
  for (let round = 0; round < 3; round++) {
    probe.dispatch("RESUBMIT", {
      actor: "contributor",
      at: new Date(BASE_MS + 6000 + round * 4000).toISOString(),
    });
    probe.dispatch("SUBMIT", {
      actor: "contributor",
      at: new Date(BASE_MS + 7000 + round * 4000).toISOString(),
    });
    probe.dispatch("BEGIN_REVIEW", {
      actor: "reviewer",
      at: new Date(BASE_MS + 8000 + round * 4000).toISOString(),
    });
    probe.dispatch("REJECT", {
      actor: "reviewer",
      at: new Date(BASE_MS + 9000 + round * 4000).toISOString(),
    });
  }
  const resubmitCount = probe.history.filter(
    (e) => e.event === "RESUBMIT",
  ).length;
  if (
    probe.state !== "REJECTED" ||
    probe.history.length !== 18 ||
    resubmitCount !== 3
  ) {
    throw new Error(
      "benchmark fixture failed: maxResubmits default unlimited",
    );
  }
}
// Illegal-value probes (outside the timed loop): -1 and
// 1.5 throw their exact pinned `invalid option` errors at
// construction, and an illegal snapshot budget throws its
// pinned `invalid snapshot` error.
for (const [bad, pinned] of [
  [-1, MAX_RESUBMITS_ILLEGAL_NEGATIVE_ERROR],
  [1.5, MAX_RESUBMITS_ILLEGAL_FRACTION_ERROR],
] as Array<[number, string]>) {
  let illegalError = "";
  try {
    new TaskLifecycle("BENCH-RESUBMIT-006", { maxResubmits: bad });
  } catch (err) {
    illegalError = err instanceof Error ? err.message : String(err);
  }
  if (illegalError !== pinned) {
    throw new Error(
      "benchmark fixture failed: maxResubmits illegal value",
    );
  }
}
{
  let snapshotError = "";
  try {
    TaskLifecycle.fromJSON({
      id: "BENCH-RESUBMIT-007",
      state: "DRAFT",
      history: [],
      slaDeadlines: {},
      maxResubmits: -1,
    });
  } catch (err) {
    snapshotError = err instanceof Error ? err.message : String(err);
  }
  if (snapshotError !== MAX_RESUBMITS_SNAPSHOT_ILLEGAL_ERROR) {
    throw new Error(
      "benchmark fixture failed: maxResubmits snapshot illegal value",
    );
  }
}

// ---------------------------------------------------------------------
// rolePolicy fixture: the timed dispatch below is the authorized
// ACCEPT into a policy-covered event. Hand-written expectations —
// written out here from the fixture composition and cross-checked
// against test/rbac.test.ts, never derived by running the path
// itself:
const ROLE_POLICY: RolePolicy = {
  ACCEPT: ["reviewer"],
};
const ROLE_POLICY_UNAUTHORIZED_ERROR =
  'actor not authorized for ACCEPT: "viewer" is not in [reviewer]';
const ROLE_POLICY_MISSING_ACTOR_ERROR =
  "actor not authorized for ACCEPT: policy requires an actor in [reviewer]";
function buildRolePolicyTask(
  id: string,
  withPolicy = true,
): TaskLifecycle {
  const task = withPolicy
    ? new TaskLifecycle(id, { rolePolicy: ROLE_POLICY })
    : new TaskLifecycle(id);
  task.dispatch("PUBLISH", {
    actor: "contributor",
    at: new Date(BASE_MS).toISOString(),
  });
  return task;
}
function runRolePolicyDispatch(where: string): TaskLifecycle {
  const task = buildRolePolicyTask("BENCH-RBAC-001");
  if (task.state !== "OPEN" || task.history.length !== 1) {
    throw new Error(`benchmark self-check failed: ${where} fixture`);
  }
  const result = task.dispatch("ACCEPT", {
    actor: "reviewer",
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  const last = task.history[task.history.length - 1];
  const stateAfter = task.state as TaskState;
  const lengthAfter = task.history.length as number;
  if (
    result !== "ACCEPTED" ||
    stateAfter !== "ACCEPTED" ||
    lengthAfter !== 2 ||
    last.seq !== 2 ||
    last.event !== "ACCEPT" ||
    last.from !== "OPEN" ||
    last.to !== "ACCEPTED" ||
    last.at !== new Date(BASE_MS + 1000).toISOString() ||
    last.actor !== "reviewer"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  return task;
}
// One-time validation (outside the timed loop): the timed pass
// itself, run once end to end.
runRolePolicyDispatch("rolePolicy dispatch fixture");
// Unauthorized-actor probe (outside the timed loop): an actor
// outside the allowlist throws the pinned authorization error
// and leaves state and history byte-identical.
{
  const probe = buildRolePolicyTask("BENCH-RBAC-002");
  const historyBefore = historyToNdjson(probe.history);
  let rbacError = "";
  try {
    probe.dispatch("ACCEPT", {
      actor: "viewer",
      at: new Date(BASE_MS + 1000).toISOString(),
    });
  } catch (err) {
    rbacError = err instanceof Error ? err.message : String(err);
  }
  if (
    rbacError !== ROLE_POLICY_UNAUTHORIZED_ERROR ||
    probe.state !== "OPEN" ||
    probe.history.length !== 1 ||
    historyToNdjson(probe.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: rolePolicy unauthorized actor",
    );
  }
}
// Missing-actor probe (outside the timed loop): no actor on a
// policy-covered event throws the pinned missing-actor error
// and leaves state and history byte-identical.
{
  const probe = buildRolePolicyTask("BENCH-RBAC-003");
  const historyBefore = historyToNdjson(probe.history);
  let rbacError = "";
  try {
    probe.dispatch("ACCEPT", {
      at: new Date(BASE_MS + 1000).toISOString(),
    });
  } catch (err) {
    rbacError = err instanceof Error ? err.message : String(err);
  }
  if (
    rbacError !== ROLE_POLICY_MISSING_ACTOR_ERROR ||
    probe.state !== "OPEN" ||
    probe.history.length !== 1 ||
    historyToNdjson(probe.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: rolePolicy missing actor",
    );
  }
}
// Default probe (outside the timed loop): a task built with no
// policy still runs the same actorless dispatch exactly as
// before RBAC existed.
{
  const probe = buildRolePolicyTask("BENCH-RBAC-004", false);
  const result = probe.dispatch("ACCEPT", {
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (
    result !== "ACCEPTED" ||
    probe.state !== "ACCEPTED" ||
    probe.history.length !== 2
  ) {
    throw new Error(
      "benchmark fixture failed: rolePolicy default no policy",
    );
  }
}

// ---------------------------------------------------------------------
// dispatchAt fixture: the timed dispatch below injects an explicit
// `at` timestamp into a START_CAPTURE. Hand-written expectations —
// written out here from the fixture composition and cross-checked
// against test/dispatchAt.test.ts (canonical ISO-8601 rule,
// non-decreasing rule, fail-fast before the transition check),
// never derived by running the path itself:
const DISPATCH_AT = new Date(BASE_MS + 2000).toISOString();
const DISPATCH_AT_REJECTED_ERROR =
  "invalid dispatch options: at must be canonical ISO-8601, got not-a-date";
function buildDispatchAtTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { at: new Date(BASE_MS).toISOString() });
  t.dispatch("ACCEPT", {
    actor: "reviewer",
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (t.state !== "ACCEPTED" || t.history.length !== 2) {
    throw new Error("benchmark fixture failed: dispatchAt build");
  }
  return t;
}
function runDispatchAtDispatch(where: string): TaskLifecycle {
  const task = buildDispatchAtTask("BENCH-AT-001");
  if (task.state !== "ACCEPTED" || task.history.length !== 2) {
    throw new Error(`benchmark self-check failed: ${where} fixture`);
  }
  const result = task.dispatch("START_CAPTURE", {
    actor: "reviewer",
    at: DISPATCH_AT,
  });
  const last = task.history[task.history.length - 1];
  const stateAfter = task.state as TaskState;
  const lengthAfter = task.history.length as number;
  if (
    result !== "CAPTURING" ||
    stateAfter !== "CAPTURING" ||
    lengthAfter !== 3 ||
    last.seq !== 3 ||
    last.event !== "START_CAPTURE" ||
    last.from !== "ACCEPTED" ||
    last.to !== "CAPTURING" ||
    last.at !== DISPATCH_AT ||
    last.actor !== "reviewer"
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  return task;
}
// One-time validation (outside the timed loop): the timed pass
// itself, run once end to end.
runDispatchAtDispatch("dispatchAt dispatch fixture");
// Illegal-at probe (outside the timed loop): a non-canonical
// `at` throws the pinned fail-fast error before the transition
// check and leaves state and history byte-identical (compared
// through the canonical NDJSON serializer), cross-checked
// against test/dispatchAt.test.ts ("dispatch: non-canonical ISO
// at values are rejected" and "dispatch: at validation is
// fail-fast, before the transition check").
{
  const probe = buildDispatchAtTask("BENCH-AT-002");
  const historyBefore = historyToNdjson(probe.history);
  let atError = "";
  try {
    probe.dispatch("START_CAPTURE", {
      actor: "reviewer",
      at: "not-a-date",
    });
  } catch (err) {
    atError = err instanceof Error ? err.message : String(err);
  }
  if (
    atError !== DISPATCH_AT_REJECTED_ERROR ||
    probe.state !== "ACCEPTED" ||
    probe.history.length !== 2 ||
    historyToNdjson(probe.history) !== historyBefore
  ) {
    throw new Error("benchmark fixture failed: dispatchAt illegal at");
  }
}

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

function benchDispatchIdempotencyDedupe(): number {
  return measure(() => {
    // Fresh task per iteration: the first keyed dispatch
    // consumes the pinned key, so no task can serve two
    // iterations. The rebuild cost is inside the timed region.
    // Per-iteration self-check: the first and duplicate returns,
    // the exactly-one-entry history growth with a gap-free seq,
    // the consumed-key snapshot, and the single listener
    // notification (see the idempotency fixture above).
    runIdempotencyPass("dispatch idempotency dedupe");
  }, ITERATIONS);
}

function benchDispatchRequirePayoutRef(): number {
  return measure(() => {
    // Fresh task per iteration: the enforced dispatch
    // settles its task to PAID, so no task can serve two
    // iterations. The rebuild cost is inside the timed
    // region. Per-iteration self-check: the return, the
    // settled state, the exactly-8-entry history, and the
    // last entry's pinned settlement fields (see the
    // requirePayoutRef fixture above).
    runRequirePayoutRefDispatch("dispatch requirePayoutRef");
  }, ITERATIONS);
}

function benchDispatchExpectedSeq(): number {
  return measure(() => {
    // Fresh task per iteration: the guarded dispatch
    // mutates its task to CAPTURING, so no task can serve
    // two iterations. The rebuild cost is inside the timed
    // region. Per-iteration self-check: the return, the
    // advanced state, the exactly-3-entry history, and the
    // last entry's pinned fields (see the expectedSeq
    // fixture above).
    runExpectedSeqDispatch("dispatch expectedSeq");
  }, ITERATIONS);
}

function benchDispatchMaxDisputes(): number {
  return measure(() => {
    // Fresh task per iteration: the budgeted dispatch
    // spends the single DISPUTE and mutates its task to
    // DISPUTED, so no task can serve two iterations. The
    // rebuild cost is inside the timed region.
    // Per-iteration self-check: the return, the advanced
    // state, the exactly-7-entry history, and the last
    // entry's pinned fields (see the maxDisputes fixture
    // above).
    runMaxDisputesDispatch("dispatch maxDisputes");
  }, ITERATIONS);
}

function benchDispatchMaxResubmits(): number {
  return measure(() => {
    // Fresh task per iteration: the budgeted dispatch spends
    // one RESUBMIT unit and mutates its task to CAPTURING, so
    // no task can serve two iterations. The rebuild cost is
    // inside the timed region.
    // Per-iteration self-check: the return, the advanced
    // state, the exactly-7-entry history, and the last
    // entry's pinned fields (see the maxResubmits fixture
    // above).
    runMaxResubmitsDispatch("dispatch maxResubmits");
  }, ITERATIONS);
}

function benchDispatchRolePolicy(): number {
  return measure(() => {
    // Fresh task per iteration: the authorized dispatch
    // advances its task to ACCEPTED, so no task can serve
    // two iterations. The rebuild cost is inside the timed
    // region. Per-iteration self-check: the return, the
    // advanced state, the exactly-2-entry history, and the
    // last entry's pinned fields (see the rolePolicy
    // fixture above).
    runRolePolicyDispatch("dispatch rolePolicy");
  }, ITERATIONS);
}

function benchDispatchAt(): number {
  return measure(() => {
    // Fresh task per iteration: the timestamped dispatch
    // advances its task to CAPTURING, so no task can serve
    // two iterations. The rebuild cost is inside the timed
    // region. Per-iteration self-check: the return, the
    // advanced state, the exactly-3-entry history, and the
    // last entry's pinned injected timestamp (see the
    // dispatchAt fixture above).
    runDispatchAtDispatch("dispatch {at}");
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

function benchVerifyHistoryChainAuditSecret(): number {
  return measure(() => {
    // Per-iteration self-check: the intact keyed fixture
    // verifies under the pinned audit secret and its genesis /
    // successor links match the hand-written linkage
    // expectations (see the auditSecret fixture above).
    checkVerifyHistoryChainAuditSecret("verifyHistoryChain auditSecret");
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

function benchVerifyPayoutWebhookSecretsRotation(): number {
  return measure(() => {
    if (
      verifyPayoutWebhook(
        webhookBody,
        webhook.signature,
        undefined,
        WEBHOOK_ROTATION_OPTS,
      ) !== true
    ) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook secrets rotation",
      );
    }
  }, ITERATIONS);
}

function benchVerifyPayoutWebhookMaxAge(): number {
  return measure(() => {
    if (
      verifyPayoutWebhook(
        webhookBody,
        webhook.signature,
        WEBHOOK_SECRET,
        WEBHOOK_MAX_AGE_OPTS,
      ) !== true
    ) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook maxAgeMs",
      );
    }
  }, ITERATIONS);
}

function benchVerifyPayoutWebhookMaxFutureSkew(): number {
  return measure(() => {
    if (
      verifyPayoutWebhook(
        webhookBody,
        webhook.signature,
        WEBHOOK_SECRET,
        WEBHOOK_MAX_FUTURE_SKEW_OPTS,
      ) !== true
    ) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook maxFutureSkewMs",
      );
    }
  }, ITERATIONS);
}

function benchVerifyPayoutWebhookRotationFutureSkew(): number {
  return measure(() => {
    if (
      verifyPayoutWebhook(
        webhookBody,
        webhook.signature,
        undefined,
        WEBHOOK_ROTATION_FUTURE_SKEW_OPTS,
      ) !== true
    ) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook secrets rotation x maxFutureSkewMs",
      );
    }
  }, ITERATIONS);
}

function benchVerifyPayoutWebhookDedupe(): number {
  return measure(() => {
    const n = receiverDedupeCounter++;
    const freshId = `bench-recv-${n}`;
    const tamperedId = `bench-recv-tampered-${n}`;
    // First sighting: the genuine delivery verifies and records as
    // first-seen (process the event).
    if (
      !verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET)
    ) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook x dedupe first sighting verify",
      );
    }
    if (receiverDedupe.checkAndRecord(freshId)) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook x dedupe first sighting must be new",
      );
    }
    // Redelivery: the same body verifies again, but the same id now
    // reports duplicate (acknowledge, do not pay out twice).
    if (
      !verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET)
    ) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook x dedupe redelivery verify",
      );
    }
    if (!receiverDedupe.checkAndRecord(freshId)) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook x dedupe redelivery must be duplicate",
      );
    }
    // Tampered delivery: the signature fails, so the receiver never
    // reaches the dedupe step. Proven by the next step: a genuine
    // delivery carrying the tampered delivery's claimed id still
    // records as first-seen, so the rejection recorded nothing.
    if (
      verifyPayoutWebhook(
        WEBHOOK_TAMPERED_BODY,
        webhook.signature,
        WEBHOOK_SECRET,
      )
    ) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook x dedupe tampered body must fail",
      );
    }
    if (
      !verifyPayoutWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET)
    ) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook x dedupe post-tamper verify",
      );
    }
    if (receiverDedupe.checkAndRecord(tamperedId)) {
      throw new Error(
        "benchmark self-check failed: verifyPayoutWebhook x dedupe tampered id must still be new",
      );
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

async function benchDeliverPayoutWebhookToManyLimits(): Promise<number> {
  return measureAsync(async () => {
    await runFanoutLimits();
  }, ITERATIONS);
}

function benchDeliverPayoutWebhook(): Promise<number> {
  return measureAsync(async () => {
    await runSingleDelivery();
  }, ITERATIONS);
}

async function benchDeliverPayoutWebhookRetryCap(): Promise<number> {
  return measureAsync(async () => {
    await runRetryCapDelivery();
  }, ITERATIONS);
}

async function benchDeliverPayoutWebhookJitter(): Promise<number> {
  return measureAsync(async () => {
    // One timed pass is two deliveries: the jittered script
    // (sleeps inside [100, 1100] and [200, 1200]) and the
    // zero-jitter control (sleeps exactly [100, 200]), each
    // self-checked per iteration (see the jitter fixture above).
    await runJitterDelivery(JITTER_JITTER_MS);
    await runJitterDelivery(0);
  }, ITERATIONS);
}

async function benchDeliverPayoutWebhookToManyJitter(): Promise<number> {
  return measureAsync(async () => {
    // One timed pass is two fan-outs: the jittered 4-endpoint
    // fan-out (per-endpoint sleeps inside [100, 1100] and
    // [200, 1200]) and the zero-jitter control fan-out (per-endpoint
    // sleeps exactly [100, 200]), each self-checked per iteration
    // (see the fan-out jitter fixture above).
    await runFanoutJitter(JITTER_JITTER_MS);
    await runFanoutJitter(0);
  }, ITERATIONS);
}

async function benchDeliverPayoutWebhookToManyRetryCap(): Promise<number> {
  return measureAsync(async () => {
    // One timed pass is one clamped fan-out: the 429 endpoint's
    // single sleep is recorded as exactly 5000 ms, the three
    // healthy endpoints sleep never (see the fan-out retry-cap
    // fixture above).
    await runFanoutRetryCap();
  }, ITERATIONS);
}

async function benchDeliverPayoutWebhookToManyDedupe(): Promise<number> {
  return measureAsync(async () => {
    // One timed pass is two fan-outs of one fresh eventId: the
    // first fan-out's 4 copies each verify and record as a first
    // sighting, and the redelivery fan-out's 4 copies each verify
    // again but report duplicate (see the fan-out receiver
    // fixture above).
    const eventId = `bench-fanout-recv-${fanoutReceiverCounter++}`;
    const first = await runFanoutReceiver(eventId);
    if (
      first.delivered !== 4 ||
      first.firstSeen !== 4 ||
      first.duplicates !== 0
    ) {
      throw new Error(
        "benchmark self-check failed: deliverPayoutWebhookToMany x dedupe first sightings",
      );
    }
    const redelivery = await runFanoutReceiver(eventId);
    if (
      redelivery.delivered !== 4 ||
      redelivery.firstSeen !== 0 ||
      redelivery.duplicates !== 4
    ) {
      throw new Error(
        "benchmark self-check failed: deliverPayoutWebhookToMany x dedupe redelivery must be duplicate",
      );
    }
  }, ITERATIONS);
}

async function benchDeliverPayoutWebhookAbortPre(): Promise<number> {
  return measureAsync(async () => {
    await runAbortPreDelivery();
  }, ITERATIONS);
}

async function benchDeliverPayoutWebhookTimeout(): Promise<number> {
  return measureAsync(async () => {
    await runTimeoutDelivery();
  }, ITERATIONS);
}

async function benchDeliverPayoutWebhookDeliveryHeaders(): Promise<number> {
  try {
    return await measureAsync(async () => {
      await runDeliveryHeaderDelivery();
    }, ITERATIONS);
  } finally {
    await new Promise<void>((resolve, reject) =>
      deliveryHeaderServer.close((err) => (err ? reject(err) : resolve())),
    );
  }
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

function benchPayoutEventDedupeMissEvict(): number {
  return measure(() => {
    runDedupeMissEvictPass("self-check");
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

function benchTasksApproachingDeadline(): number {
  return measure(() => {
    // Shared fixture batch per iteration: the screening is pure, so
    // no rebuild is needed. Per-iteration self-check: exactly the
    // hand-written selection, in batch order (see the
    // approaching-deadline fixture above).
    const out = tasksApproachingDeadline(
      approachingBatch,
      APPROACHING_WINDOW_MS,
      APPROACHING_NOW,
    );
    if (
      out.length !== expectedApproaching.length ||
      out.some((t, i) => t !== expectedApproaching[i])
    ) {
      throw new Error(
        "benchmark self-check failed: tasksApproachingDeadline",
      );
    }
  }, ITERATIONS);
}

function benchTasksByState(): number {
  return measure(() => {
    // Shared fixture batch per iteration: the filter is pure, so
    // no rebuild is needed. Per-iteration self-check: exactly the
    // hand-written OPEN slice, in batch order, holding the same
    // task objects (see the watchdog fixture above).
    const out = tasksByState(watchdogBatch, "OPEN");
    if (
      out.length !== expectedByStateOpen.length ||
      out.some((t, i) => t !== expectedByStateOpen[i])
    ) {
      throw new Error("benchmark self-check failed: tasksByState");
    }
  }, ITERATIONS);
}

function benchTasksByActor(): number {
  return measure(() => {
    // Shared fixture batch per iteration: the filter is pure, so
    // no rebuild is needed. Per-iteration self-check: exactly the
    // hand-written moderator slice, in batch order, holding the
    // same task objects — the twice-touched task appears exactly
    // once (see the actor fixture above).
    const out = tasksByActor(actorBatch, "moderator");
    if (
      out.length !== expectedByActorModerator.length ||
      out.some((t, i) => t !== expectedByActorModerator[i])
    ) {
      throw new Error("benchmark self-check failed: tasksByActor");
    }
  }, ITERATIONS);
}

// The demo's pinned `formatMinorUnits` vectors (see src/demo.ts),
// plus the finance-pass total: 1634900 minor units renders
// "16349.00". The -0 vector renders "0.00" without a minus sign —
// the sign handling is the point, not a typo.
const FORMAT_MINOR_UNITS_CASES: Array<{
  input: number;
  formatted: string;
}> = [
  { input: 10098, formatted: "100.98" },
  { input: 1, formatted: "0.01" },
  { input: 100, formatted: "1.00" },
  { input: 0, formatted: "0.00" },
  { input: -0, formatted: "0.00" },
  { input: -100, formatted: "-1.00" },
  { input: -10098, formatted: "-100.98" },
  { input: 250000, formatted: "2500.00" },
  { input: 1000000000, formatted: "10000000.00" },
  { input: 1234567890123, formatted: "12345678901.23" },
  { input: Number.MAX_SAFE_INTEGER, formatted: "90071992547409.91" },
  { input: 1634900, formatted: "16349.00" },
];

function benchFormatMinorUnits(): number {
  // Outside the timed loop: a fractional "minor unit" is a caller
  // error, not a representable amount — it fails fast with the
  // exact error instead of a rounded string.
  let fractionalError = "";
  try {
    formatMinorUnits(1.5);
  } catch (e) {
    fractionalError = (e as Error).message;
  }
  if (fractionalError !== "minor units must be an integer, got 1.5") {
    throw new Error(
      "benchmark fixture failed: formatMinorUnits fractional input error mismatch",
    );
  }
  return measure(() => {
    // Pure formatting, so no rebuild is needed. Per-iteration
    // self-check: every vector renders exactly its pinned string.
    for (const { input, formatted } of FORMAT_MINOR_UNITS_CASES) {
      if (formatMinorUnits(input) !== formatted) {
        throw new Error(
          `benchmark self-check failed: formatMinorUnits(${input})`,
        );
      }
    }
  }, ITERATIONS);
}

// The conversion counterpart of the display path above: the #623
// demo segment's finance-pass total (16349 major units ↔ 1634900
// minor units), plus zero, a negative amount, and the 0.33
// round-trip. The 0.333 vector is a rounding probe, not a
// round-trip vector — `toMinorUnits(0.333)` rounds to 33, while
// `fromMinorUnits(33)` is 0.33 — so it is pinned separately
// below instead of as a (major, minor) pair.
const MINOR_UNITS_CONVERSION_CASES: Array<{
  major: number;
  minor: number;
}> = [
  { major: 16349, minor: 1634900 },
  { major: 0, minor: 0 },
  { major: -100.98, minor: -10098 },
  { major: 0.33, minor: 33 },
];

function benchMinorUnitsConversion(): number {
  // Outside the timed loop: a fractional "minor unit" is a caller
  // error, not a representable amount — it fails fast with the
  // exact error instead of a rounded amount (the same vector
  // the #623 demo segment rejects).
  let fractionalError = "";
  try {
    fromMinorUnits(1634900.5);
  } catch (e) {
    fractionalError = (e as Error).message;
  }
  if (
    fractionalError !== "minor units must be an integer, got 1634900.5"
  ) {
    throw new Error(
      "benchmark fixture failed: fromMinorUnits fractional input error mismatch",
    );
  }
  return measure(() => {
    // Pure conversion, so no rebuild is needed. Per-iteration
    // self-check: every vector converts both ways to exactly
    // its pinned value, and the sub-cent amount rounds to the
    // nearest cent instead of truncating.
    for (const { major, minor } of MINOR_UNITS_CONVERSION_CASES) {
      if (
        toMinorUnits(major) !== minor ||
        fromMinorUnits(minor) !== major
      ) {
        throw new Error(
          `benchmark self-check failed: minor-unit conversion (${major} <-> ${minor})`,
        );
      }
    }
    if (toMinorUnits(0.333) !== 33) {
      throw new Error(
        "benchmark self-check failed: toMinorUnits(0.333) rounding",
      );
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

// Per-iteration self-check for the notify-only row (backlog #686):
// the 4 stale tasks are notified in batch order, every outcome is
// acted with no error and no audit entry (a notify-only action
// appends nothing), and every task in the batch — acted-on or not —
// keeps exactly its pre-run state and history bytes.
function checkStaleNotifyOnlyResults(
  results: ReturnType<typeof actOnStaleTasks>,
  notified: readonly string[],
  batch: readonly TaskLifecycle[],
  before: ReadonlyArray<{ state: string; historyBytes: string }>,
  where: string,
): void {
  if (
    results.length !== expectedStaleIds.length ||
    results.map((r) => r.task.id).join(",") !== expectedStaleIds.join(",") ||
    notified.join(",") !== expectedStaleIds.join(",") ||
    results.some((r) => !r.acted || r.error !== undefined || r.entry !== undefined) ||
    batch.some(
      (task, i) =>
        task.state !== before[i].state ||
        JSON.stringify(task.history) !== before[i].historyBytes,
    )
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}

function benchActOnStaleTasksNotifyOnly(): number {
  return measure(() => {
    // Fresh fixture per iteration for parity with the other
    // executor rows, even though the notify-only action mutates
    // nothing: the reported numbers include the fixture-rebuild
    // cost, so the row is comparable, not flattered.
    const batch = buildWatchdogBatch();
    const before = batch.map((task) => ({
      state: task.state,
      historyBytes: JSON.stringify(task.history),
    }));
    const notified: string[] = [];
    const results = actOnStaleTasks(
      batch,
      (task) => {
        notified.push(task.id);
      },
      WATCHDOG_MAX_AGE,
      WATCHDOG_NOW,
    );
    checkStaleNotifyOnlyResults(
      results,
      notified,
      batch,
      before,
      "actOnStaleTasks notify-only",
    );
  }, ITERATIONS);
}

// Per-iteration self-check for the actOnStaleTasks x subscribe row
// (backlog #746, the bench variant of test/staleActionSubscribe):
// the executor outcomes must match the hand-counted stale-action
// expectations (only WD-04 abandoned), and the notification count
// must equal the successful ABANDON count — exactly 1, the WD-04
// ABANDON ACCEPTED -> ABANDONED, whose delivered entry is exactly
// the audit entry the dispatch appended (and the executor's
// reported entry). A failed attempt notifies nobody, so any extra
// or missing notification fails the row rather than inflating it.
type StaleSubscribeNotification = {
  taskId: string;
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
  entry: TaskHistoryEntry;
};
function checkStaleSubscribeResults(
  results: ReturnType<typeof actOnStaleTasks>,
  notifications: readonly StaleSubscribeNotification[],
  where: string,
): void {
  checkStaleResults(results, where);
  const acted = results.filter((r) => r.acted);
  const abandoned = results.find(
    (r) => r.task.id === "BENCH-WD-04",
  );
  if (
    acted.length !== 1 ||
    abandoned === undefined ||
    !abandoned.acted ||
    abandoned.task.state !== "ABANDONED" ||
    notifications.length !== acted.length ||
    notifications.length !== 1
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  const n = notifications[0]!;
  const last =
    abandoned.task.history[abandoned.task.history.length - 1]!;
  if (
    n.taskId !== "BENCH-WD-04" ||
    n.event !== "ABANDON" ||
    n.from !== "ACCEPTED" ||
    n.to !== "ABANDONED" ||
    n.entry.seq !== last.seq ||
    n.entry.event !== last.event ||
    n.entry.from !== last.from ||
    n.entry.to !== last.to ||
    n.entry.at !== last.at ||
    n.entry.actor !== last.actor ||
    abandoned.entry === undefined ||
    n.entry.seq !== abandoned.entry.seq ||
    n.entry.hash !== abandoned.entry.hash
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}

function benchActOnStaleTasksSubscribe(): number {
  return measure(() => {
    // Fresh fixture per iteration, same reason as the other
    // executor rows: the default action dispatches ABANDON on the
    // task it can act on. A collecting listener is subscribed to
    // every task in the batch before the run, so the timed region
    // covers the full batch ABANDON plus its fan-out — the
    // steady-state cost a watchdog deployment pays when its
    // abandoned tasks page their listeners.
    const batch = buildWatchdogBatch();
    const notifications: StaleSubscribeNotification[] = [];
    for (const task of batch) {
      task.subscribe((event, from, to, entry) => {
        notifications.push({ taskId: task.id, event, from, to, entry });
      });
    }
    const results = actOnStaleTasks(
      batch,
      undefined,
      WATCHDOG_MAX_AGE,
      WATCHDOG_NOW,
    );
    checkStaleSubscribeResults(
      results,
      notifications,
      "actOnStaleTasks x subscribe",
    );
  }, ITERATIONS);
}

// One-time validation (outside the timed loop) for the
// actOnStaleTasks x subscribe row, mirroring the #732 test
// conclusions the timed self-check does not cover: a notify-only
// action notifies nobody, and an unsubscribed batch stays silent
// while the executor still abandons WD-04.
{
  const notifyBatch = buildWatchdogBatch();
  const notifyNotifications: StaleSubscribeNotification[] = [];
  for (const task of notifyBatch) {
    task.subscribe((event, from, to, entry) => {
      notifyNotifications.push({ taskId: task.id, event, from, to, entry });
    });
  }
  const notifyBefore = notifyBatch.map((task) => ({
    state: task.state,
    historyBytes: JSON.stringify(task.history),
  }));
  const notifyNotified: string[] = [];
  const notifyResults = actOnStaleTasks(
    notifyBatch,
    (task) => {
      notifyNotified.push(task.id);
    },
    WATCHDOG_MAX_AGE,
    WATCHDOG_NOW,
  );
  checkStaleNotifyOnlyResults(
    notifyResults,
    notifyNotified,
    notifyBatch,
    notifyBefore,
    "actOnStaleTasks x subscribe notify-only fixture",
  );
  if (notifyNotifications.length !== 0) {
    throw new Error(
      "benchmark self-check failed: actOnStaleTasks x subscribe notify-only fixture",
    );
  }
}
{
  const unsubBatch = buildWatchdogBatch();
  const unsubNotifications: StaleSubscribeNotification[] = [];
  const unsubscribes: Array<() => void> = [];
  for (const task of unsubBatch) {
    unsubscribes.push(
      task.subscribe((event, from, to, entry) => {
        unsubNotifications.push({ taskId: task.id, event, from, to, entry });
      }),
    );
  }
  for (const unsubscribe of unsubscribes) unsubscribe();
  const unsubResults = actOnStaleTasks(
    unsubBatch,
    undefined,
    WATCHDOG_MAX_AGE,
    WATCHDOG_NOW,
  );
  // Executor outcomes must still hold (WD-04 abandoned, the rest
  // failed in isolation), while the unsubscribed listeners stay
  // silent — the notification half of checkStaleSubscribeResults
  // cannot hold here by design, so it is asserted separately.
  checkStaleResults(
    unsubResults,
    "actOnStaleTasks x subscribe unsubscribe fixture",
  );
  if (unsubNotifications.length !== 0) {
    throw new Error(
      "benchmark self-check failed: actOnStaleTasks x subscribe unsubscribe fixture",
    );
  }
}

// Per-iteration self-check for the expireOverdueTasks x subscribe row
// (backlog #754, the bench variant of test/expireOverdueSubscribe):
// the executor outcomes must match the hand-counted expiry
// expectations (WD-01 / WD-10 / WD-12 expire, WD-06 fails in
// isolation), and the notification count must equal the successful
// EXPIRE count — exactly 3, in batch order, each carrying its audit
// entry (the EXPIRE entry the dispatch appended, the task history's
// last entry, and the executor's reported entry, all three identical
// on seq/event/from/to/at/actor/hash). The failed WD-06 attempt
// notifies nobody, so any notification from WD-06 — or any missing
// or extra notification — fails the row rather than inflating it.
type ExpireSubscribeNotification = {
  taskId: string;
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
  entry: TaskHistoryEntry;
};
const expectedExpireSubscribe: Array<{
  taskId: string;
  from: TaskState;
  to: TaskState;
}> = [
  { taskId: "BENCH-WD-01", from: "OPEN", to: "EXPIRED" },
  { taskId: "BENCH-WD-10", from: "CAPTURING", to: "EXPIRED" },
  { taskId: "BENCH-WD-12", from: "OPEN", to: "EXPIRED" },
];
function checkExpireSubscribeResults(
  results: ReturnType<typeof expireOverdueTasks>,
  notifications: readonly ExpireSubscribeNotification[],
  where: string,
): void {
  checkExpireResults(results, where);
  if (
    notifications.length !== expectedExpireSubscribe.length ||
    notifications.map((n) => n.taskId).join(",") !==
      expectedExpireSubscribe.map((e) => e.taskId).join(",") ||
    notifications.some((n) => n.taskId === "BENCH-WD-06")
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < expectedExpireSubscribe.length; i++) {
    const expected = expectedExpireSubscribe[i]!;
    const n = notifications[i]!;
    const result = results.find((r) => r.task.id === expected.taskId);
    const last = result!.task.history[result!.task.history.length - 1]!;
    if (
      n.event !== "EXPIRE" ||
      n.from !== expected.from ||
      n.to !== expected.to ||
      n.entry.event !== "EXPIRE" ||
      n.entry.from !== expected.from ||
      n.entry.to !== expected.to ||
      n.entry.actor !== "system" ||
      n.entry.seq !== last.seq ||
      n.entry.event !== last.event ||
      n.entry.from !== last.from ||
      n.entry.to !== last.to ||
      n.entry.at !== last.at ||
      n.entry.actor !== last.actor ||
      result!.entry === undefined ||
      n.entry.seq !== result!.entry.seq ||
      n.entry.hash !== result!.entry.hash
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}

function benchExpireOverdueTasksSubscribe(): number {
  return measure(() => {
    // Fresh fixture per iteration, same reason as the other
    // executor rows: the executor dispatches EXPIRE on the tasks
    // it expires. A collecting listener is subscribed to every
    // task in the batch before the run, so the timed region covers
    // the full batch expiry plus its fan-out — the steady-state
    // cost a watchdog deployment pays when its expired tasks page
    // their listeners.
    const batch = buildWatchdogBatch();
    const notifications: ExpireSubscribeNotification[] = [];
    for (const task of batch) {
      task.subscribe((event, from, to, entry) => {
        notifications.push({ taskId: task.id, event, from, to, entry });
      });
    }
    const results = expireOverdueTasks(batch, WATCHDOG_NOW);
    checkExpireSubscribeResults(
      results,
      notifications,
      "expireOverdueTasks x subscribe",
    );
  }, ITERATIONS);
}

// One-time validation (outside the timed loop) for the
// expireOverdueTasks x subscribe row, mirroring the #748 test
// conclusions the timed self-check does not isolate: a
// failure-isolated task notifies nobody while the rest of the batch
// still expires, and an unsubscribed batch stays silent while the
// executor still expires its tasks.
{
  const stuck = buildWatchdogTask("BENCH-EXP-SUB-STUCK", [
    { event: "PUBLISH", actor: "researcher", atMs: BASE_MS },
    { event: "ACCEPT", actor: "contributor", atMs: BASE_MS + 1 * HOUR_MS },
    { event: "START_CAPTURE", actor: "contributor", atMs: BASE_MS + 2 * HOUR_MS },
    { event: "SUBMIT", actor: "contributor", atMs: BASE_MS + 3 * HOUR_MS },
    { event: "BEGIN_REVIEW", actor: "reviewer", atMs: BASE_MS + 2 * DAY_MS },
  ], { state: "IN_REVIEW", atMs: BASE_MS + 20 * DAY_MS });
  const expirable = buildWatchdogTask("BENCH-EXP-SUB-OK", [
    { event: "PUBLISH", actor: "researcher", atMs: BASE_MS },
  ], { state: "OPEN", atMs: BASE_MS + 10 * DAY_MS });
  const stuckNotifications: ExpireSubscribeNotification[] = [];
  const okNotifications: ExpireSubscribeNotification[] = [];
  stuck.subscribe((event, from, to, entry) => {
    stuckNotifications.push({ taskId: stuck.id, event, from, to, entry });
  });
  expirable.subscribe((event, from, to, entry) => {
    okNotifications.push({ taskId: expirable.id, event, from, to, entry });
  });
  const stuckBefore = JSON.stringify(stuck.history);
  const stuckResults = expireOverdueTasks([stuck, expirable], WATCHDOG_NOW);
  const blocked = stuckResults.find((r) => r.task.id === stuck.id);
  if (
    stuckResults.length !== 2 ||
    blocked === undefined ||
    blocked.expired ||
    !(blocked.error ?? "").includes(
      "invalid transition: EXPIRE from IN_REVIEW",
    ) ||
    blocked.entry !== undefined ||
    stuckNotifications.length !== 0 ||
    stuck.state !== "IN_REVIEW" ||
    JSON.stringify(stuck.history) !== stuckBefore ||
    okNotifications.length !== 1 ||
    okNotifications[0]!.event !== "EXPIRE" ||
    okNotifications[0]!.to !== "EXPIRED" ||
    okNotifications[0]!.entry.actor !== "system"
  ) {
    throw new Error(
      "benchmark self-check failed: expireOverdueTasks x subscribe failure-isolation fixture",
    );
  }
}
{
  const unsubBatch = buildWatchdogBatch();
  const unsubNotifications: ExpireSubscribeNotification[] = [];
  const unsubscribes: Array<() => void> = [];
  for (const task of unsubBatch) {
    unsubscribes.push(
      task.subscribe((event, from, to, entry) => {
        unsubNotifications.push({ taskId: task.id, event, from, to, entry });
      }),
    );
  }
  for (const unsubscribe of unsubscribes) unsubscribe();
  const unsubResults = expireOverdueTasks(unsubBatch, WATCHDOG_NOW);
  // Executor outcomes must still hold (WD-01 / WD-10 / WD-12
  // expired, WD-06 failed in isolation), while the unsubscribed
  // listeners stay silent — the notification half of
  // checkExpireSubscribeResults cannot hold here by design, so it
  // is asserted separately.
  checkExpireResults(
    unsubResults,
    "expireOverdueTasks x subscribe unsubscribe fixture",
  );
  if (unsubNotifications.length !== 0) {
    throw new Error(
      "benchmark self-check failed: expireOverdueTasks x subscribe unsubscribe fixture",
    );
  }
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

function benchPolicySnapshotRoundTrip(): number {
  return measure(() => {
    // Per-iteration self-check: the restored task's state, full
    // history (entry for entry), and history-derived used budget
    // counts match the hand-written expectations, and the
    // envelope's pinned rolePolicy and finite budget fields
    // survive the JSON text round-trip byte-identically (see
    // the policy snapshot fixture above).
    const restored = TaskLifecycle.fromJSON(
      JSON.parse(JSON.stringify(policySnapshotTask.toJSON())) as unknown,
    );
    checkPolicySnapshotRoundTrip(restored, "policySnapshotRoundTrip");
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

// ---------------------------------------------------------------------
// NDJSON x unreconciledPayouts (12 PAID tasks): the forwarder-to-
// reconciliation chain a batch pipeline actually runs — export each
// screening-batch task to NDJSON, parse it back, rebuild the task with
// `TaskLifecycle.fromHistory`, then screen the rebuilt batch. The
// per-iteration self-check pins three things, so a degenerate replay
// cannot fake the number: every rebuilt task keeps its id, PAID state,
// and 8-entry history; re-exporting the rebuilt task reproduces the
// original NDJSON byte for byte (canonical key order, hashes
// included); and the rebuilt batch screens to exactly the
// hand-computed unreconciled ids (BENCH-SCR-03 / -06 / -09 / -12),
// in batch order — the same set the pre-hop batch screens to, so no
// task gains or loses a payout reference in serialization.
function benchNdjsonUnreconciledPayouts(): number {
  return measure(() => {
    const rebuilt = screeningBatch.map((task) => {
      const ndjson = historyToNdjson(task);
      const restored = TaskLifecycle.fromHistory(
        task.id,
        historyFromNdjson(ndjson),
      );
      if (
        restored.id !== task.id ||
        restored.state !== "PAID" ||
        restored.history.length !== 8 ||
        historyToNdjson(restored) !== ndjson
      ) {
        throw new Error(
          "benchmark self-check failed: NDJSON x unreconciledPayouts replay fidelity",
        );
      }
      return restored;
    });
    const screened = unreconciledPayouts(rebuilt);
    if (
      screened.map((t) => t.id).join(",") !==
      expectedUnreconciledIds.join(",")
    ) {
      throw new Error(
        "benchmark self-check failed: NDJSON x unreconciledPayouts screening",
      );
    }
  }, ITERATIONS);
}

// ---------------------------------------------------------------------
// history getter (defensive copy, 64 entries): `get history()` returns
// a frozen array of frozen entry copies on every call — the O(n) copy
// + per-entry Object.freeze the audit-immutability guarantee costs on
// every read. The fixture is one fixed task (BENCH-HG) with a
// 64-entry hash-chained history: PUBLISH / ACCEPT / START_CAPTURE /
// SUBMIT / BEGIN_REVIEW / REJECT (6 entries to REJECTED), then 14
// RESUBMIT rounds of RESUBMIT / SUBMIT / BEGIN_REVIEW / REJECT
// (4 entries each — 56 entries back to REJECTED, 62 total), then a
// final RESUBMIT / SUBMIT (2 entries, ending in SUBMITTED —
// 64 total). All dispatch timestamps are fixed; the frozen shape,
// frozen entries, exact content, and reference independence of
// consecutive snapshots are pinned by the checks below.
const HISTORY_GETTER_ENTRY_COUNT = 64;
function buildHistoryGetterTask(): TaskLifecycle {
  const task = new TaskLifecycle("BENCH-HG");
  let atMs = BASE_MS;
  const at = (): string => {
    atMs += 1000;
    return new Date(atMs).toISOString();
  };
  const step = (event: TaskEvent, actor: string): void => {
    task.dispatch(event, { actor, at: at() });
  };
  step("PUBLISH", "researcher");
  step("ACCEPT", "contributor");
  step("START_CAPTURE", "contributor");
  step("SUBMIT", "contributor");
  step("BEGIN_REVIEW", "reviewer");
  step("REJECT", "reviewer");
  for (let round = 0; round < 14; round += 1) {
    step("RESUBMIT", "contributor");
    step("SUBMIT", "contributor");
    step("BEGIN_REVIEW", "reviewer");
    step("REJECT", "reviewer");
  }
  step("RESUBMIT", "contributor");
  step("SUBMIT", "contributor");
  return task;
}
const historyGetterTask = buildHistoryGetterTask();
if (historyGetterTask.history.length !== HISTORY_GETTER_ENTRY_COUNT) {
  throw new Error(
    `benchmark fixture failed: history getter task has ${historyGetterTask.history.length} entries, expected ${HISTORY_GETTER_ENTRY_COUNT}`,
  );
}
if (historyGetterTask.state !== "SUBMITTED") {
  throw new Error(
    `benchmark fixture failed: history getter task ended in ${historyGetterTask.state}, expected SUBMITTED`,
  );
}
// Content baseline frozen at fixture build: every timed iteration
// compares its fresh snapshot against this JSON. Reference
// independence is checked across consecutive timed calls (the
// previous snapshot's first entry must never be the same object
// as this call's), so a getter that returned shared entry
// references would fail here even though the content matched.
const HISTORY_GETTER_JSON = JSON.stringify(historyGetterTask.history);
let historyGetterPreviousSnapshot: readonly TaskHistoryEntry[] | null =
  null;
function checkHistoryGetter(where: string): void {
  const snapshot = historyGetterTask.history;
  if (snapshot.length !== HISTORY_GETTER_ENTRY_COUNT) {
    throw new Error(
      `benchmark self-check failed: ${where}: history length ${snapshot.length}, expected ${HISTORY_GETTER_ENTRY_COUNT}`,
    );
  }
  if (!Object.isFrozen(snapshot)) {
    throw new Error(
      `benchmark self-check failed: ${where}: snapshot array not frozen`,
    );
  }
  for (const entry of snapshot) {
    if (!Object.isFrozen(entry)) {
      throw new Error(
        `benchmark self-check failed: ${where}: entry seq ${entry.seq} not frozen`,
      );
    }
  }
  if (JSON.stringify(snapshot) !== HISTORY_GETTER_JSON) {
    throw new Error(
      `benchmark self-check failed: ${where}: snapshot content drift`,
    );
  }
  if (
    historyGetterPreviousSnapshot !== null &&
    snapshot[0] === historyGetterPreviousSnapshot[0]
  ) {
    throw new Error(
      `benchmark self-check failed: ${where}: consecutive snapshots share entry references`,
    );
  }
  historyGetterPreviousSnapshot = snapshot;
}
function benchHistoryGetter(): number {
  return measure(() => {
    // Shared fixture task per iteration: the getter never mutates,
    // so no rebuild is needed. Per-iteration self-check: exactly
    // 64 frozen entries, content byte-identical to the fixture
    // baseline, and consecutive calls never share entry references
    // (see the history-getter fixture above).
    checkHistoryGetter("history getter");
  }, ITERATIONS);
}
// Off-timer hardening, run once at fixture build: a push, a splice,
// and an entry-field write on the returned snapshot all throw, and
// the internal history stays at 64 entries in SUBMITTED afterwards.
{
  const probe = historyGetterTask.history;
  const expectThrow = (fn: () => void, what: string): void => {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error(
        `benchmark fixture failed: history getter ${what} must throw`,
      );
    }
  };
  expectThrow(
    () => (probe as unknown as TaskHistoryEntry[]).push(probe[0]!),
    "push",
  );
  expectThrow(() => (probe as unknown as TaskHistoryEntry[]).splice(0, 1), "splice");
  expectThrow(
    () => ((probe[0] as { note?: string }).note = "forged"),
    "entry-field write",
  );
  if (
    historyGetterTask.history.length !== HISTORY_GETTER_ENTRY_COUNT ||
    historyGetterTask.state !== "SUBMITTED"
  ) {
    throw new Error(
      "benchmark fixture failed: history getter probe mutated the task",
    );
  }
}

console.log("dataquest-task-lifecycle benchmark");
console.log(`Node: ${process.version} on ${process.platform}/${process.arch}`);
console.log(`CPU: ${cpus()[0]?.model ?? "unknown"}`);
console.log(
  "Fixture: one task, full DRAFT -> PAID lifecycle (8 hash-chained audit entries); payout webhook HMAC-SHA256 with fixed secret/timestamp/eventId; NDJSON text exported from the same 8-entry history; reconciliation screening and totalPaidOut summary over a fixed batch of 12 PAID tasks (4 exact+ref, 4 mismatched+ref, 2 exact without ref, 2 mismatched without ref); payout webhook fan-out to 4 endpoints through an injected fake fetch (immediate 200, no network); payout webhook single-target delivery (deliverPayoutWebhook to 1 fixed endpoint through an injected fake fetch — immediate 200, no network, backoffMs 0 with an injected no-op sleep — checked for result {ok: true, attempts: 1, status: 200}, exactly one captured call, and a captured body byte-identical to the signed body whose X-Hub-Signature-256 equals the buildPayoutWebhook signature and verifies over the captured body on every iteration, with the persistent-500 reported exhaustion shape {ok: false, attempts: 3, status: 500, error: \"server responded with status 500\"} pinned once outside the timed loop); payout event dedupe duplicate hits cycling over 1,000 pre-recorded eventIds under a fixed injected clock; payout event dedupe restore from a 1,000-entry JSON-round-tripped snapshot under the same fixed clock (all entries live at load, default TTL and capacity, observability counters restarting at zero); payout event dedupe snapshot export (PayoutEventDedupe.exportSnapshot) over a fixed 6-id dedupe under an injectable clock that advances only during fixture construction (60-second TTL, the first id expired at export time and 5 live ids with staggered first-seen times), self-checked on every iteration for the hand-pinned live entries in recorded order with the expired id absent, with a detached-copy mutation check and an empty-dedupe export check outside the timed loop; payout event dedupe clear (PayoutEventDedupe.clear) over a fresh 1,000-id dedupe rebuilt on every iteration under a fixed injected clock (1,000 first sightings plus 1 duplicate hit before the clear, so the reported numbers include the fixture-rebuild cost — prefill plus clear), self-checked on every iteration for an all-zero size and stats right after the clear and the first id recording as a new event again, with an empty-dedupe clear no-op check outside the timed loop; payout event dedupe stats (PayoutEventDedupe.stats) over a fixed 7-record dedupe under an injectable clock that advances only during fixture construction (60-second TTL, capacity 6 — one id LRU-evicted during construction and one id expired at the stats instant, 5 live ids), self-checked on every iteration for the hand-pinned snapshot {size: 5, hits: 1, misses: 7, evictions: 1} where size counts only the live ids, with a detached-copy mutation check and an empty-dedupe all-zero check outside the timed loop; payout event dedupe checkAndRecord miss/evict (PayoutEventDedupe.checkAndRecord) over a fresh capacity-100 dedupe rebuilt on every iteration under a fixed injected clock, recording a deterministic sequence of 250 brand-new ids on every pass (every call a first sighting, the 150 records beyond capacity forcing LRU evictions of the oldest surviving ids), self-checked on every iteration for the hand-pinned stats {size: 100, hits: 0, misses: 250, evictions: 150} with size pinned at capacity, with an oldest-surviving-id hit probe and an evicted-id-as-new-event probe outside the timed loop; batch payout webhook building over a fixed batch of 12 PAID tasks (settled as quoted, each with a payoutRef) under one shared timestamp with deterministic per-task eventIds from an injected factory; watchdog screening (expiredTasks / staleTasks) over a fixed batch of 12 mixed-state tasks (4 hand-counted expired, 4 hand-counted stale) under one injected fixed now with per-state dwell budgets; watchdog execution (expireOverdueTasks / actOnStaleTasks with the default ABANDON action) over the same batch, rebuilt fresh on every iteration because the executors mutate their inputs (3 of 4 expire, 1 of 4 stale actions succeed, the rest fail in isolation); watchdog notify-only execution (actOnStaleTasks with a notify-only action) over the same batch, rebuilt fresh on every iteration for parity with the other executor rows even though the action dispatches nothing (self-checked per iteration for 4 notifications in batch order, every outcome acted with no audit entry, and byte-identical states and histories across the whole batch); watchdog subscribe execution (actOnStaleTasks with the default ABANDON action over the same batch, rebuilt fresh on every iteration, with a collecting listener subscribed to every task before the run — self-checked per iteration for exactly 1 notification, the WD-04 ABANDON ACCEPTED -> ABANDONED carrying its audit entry, because only WD-04 can be abandoned and the three failed attempts notify nobody; outside the timed loop, a notify-only action notifies nobody and an unsubscribed batch stays silent while WD-04 is still abandoned); watchdog subscribe expiry execution (expireOverdueTasks over the same batch, rebuilt fresh on every iteration, with a collecting listener subscribed to every task before the run — self-checked per iteration for exactly 3 notifications, the WD-01 / WD-10 / WD-12 EXPIREs each carrying its audit entry, because only those three can expire and the failed WD-06 attempt notifies nobody; outside the timed loop, a failure-isolated batch notifies nobody for its stuck task while the rest still expires, and an unsubscribed batch stays silent while the executor still expires) payout Retry-After parsing (parsePayoutRetryAfter) over a fixed 11-value corpus (delay-seconds, future/past HTTP-dates, signed and garbage values, and absent values) under an injected fixed nowMs; payout mismatch judgement (payoutMismatch) over a fixed set of 5 tasks (settled exactly as quoted, settled for a different amount, missing quote, missing settled amount, and one non-PAID task) with fixed dispatch timestamps; allowed-events query (allowedEvents) over all 13 states with hand-written per-state expectations (terminal states PAID / ABANDONED / EXPIRED returning an empty list); standalone history parsing (parseHistory) over the same fixed 8-entry chained history (full validation — unknown-field fail-closed, gapless seq, from/to chain and hash-chain re-verification — without per-line JSON parsing, with a detached tampered copy rejected outside the timed loop); terminal-state judgement (isTerminal) over all 13 states with hand-written per-state truth values (only PAID / ABANDONED / EXPIRED returning true); transition-table JSON export (transitionTableJson) with no arguments, serialized as canonical JSON in declaration order, parsed back on every iteration to exactly the 19 snapshot-pinned edges with the first, payout, and last edges in place; state diagram generation (stateDiagram) with no arguments, rendered as a Mermaid stateDiagram-v2 block on every iteration to exactly the 24 hand-pinned lines with all 13 states present and the 19 snapshot-pinned edges in place; README diagram sync check (readmeDiagramInSync) with no arguments, reading only this repo's README.md on every iteration and returning true, the in-sync state pinned by the test suite; SLA overdue judgement (isOverdue) over a fixed corpus of 4 ACCEPTED tasks (already overdue, exactly at the deadline, not yet overdue, and no SLA deadline) under one injected fixed now, with hand-written per-task expectations pinning the inclusive deadline boundary; dispatch subscription notification (subscribe) with 1 fixed collecting listener over the same full 8-dispatch lifecycle on a fresh task per iteration, self-checked per iteration against the hand-written (event, from, to) sequence and the task's own history entry for entry, with unsubscribe and throwing-listener isolation checks outside the timed loop; JSON snapshot round-trip (toJSON + TaskLifecycle.fromJSON) over the same task's fixed 8-entry snapshot envelope (v 1, empty SLA deadlines, unlimited budgets so no budget fields in the envelope), self-checked per iteration against the hand-written expectations (restored state and history entry for entry, hashes included, history-derived used RESUBMIT / DISPUTE counts at 0 on both sides, re-export fixed point at the same serialized byte length), with a JSON text (stringify / parse) round-trip check outside the timed loop and two detached tampered copies (v rewritten to 2, one extra top-level field) rejected with their hand-pinned envelope errors outside the timed loop; event-sourced rebuild (TaskLifecycle.fromHistory) over the same fixed 8-entry history, self-checked per iteration for the rebuilt id and state and the full history entry for entry (hashes included, compared field-wise and through the canonical NDJSON serializer, because rehydration normalizes entry key order), with a detached tampered copy (PAYOUT_COMPLETE payoutAmount altered from 125 to 126) rejected with the hash-chain error outside the timed loop; hash-chain verification (verifyHistoryChain) over the same fixed 8-entry history, self-checked per iteration for the genesis link (the first entry's prevHash is GENESIS_PREV_HASH) and every successor link (each entry's prevHash equals its predecessor's hash), with a detached tampered copy (the middle SUBMIT entry gaining a payoutAmount of 999) returning false outside the timed loop; SLA deadline read (getSlaDeadline) over all 13 states on one fixed ACCEPTED task carrying deadlines for exactly two states (OPEN 2026-02-01T09:00:00.000Z and ACCEPTED 2026-03-01T09:00:00.000Z, the other eleven states returning undefined, and the no-argument form returning the current ACCEPTED state's deadline), self-checked per iteration against the hand-written per-state expectations, with an overwrite readback check on a separate probe task outside the timed loop; dispatch note length guard (MAX_NOTE_LENGTH) over a fixed 2-case corpus (a note of exactly 32768 characters accepted on a fresh task — OPEN with 1 history entry whose stored note length is 32768 — and a note of 32769 characters rejected with the hand-pinned length error, leaving a fresh task in DRAFT with 0 history entries), self-checked per iteration against the hand-written expectations cross-checked against the actor/note hardening tests, with the notes presented only by length and never printed; SLA deadline write (setSlaDeadline + clearSlaDeadline) as one write cycle on a shared fixed OPEN task (set the current state's deadline from a Date, overwrite it from an ISO string, then clear it — the clear restores the fixture's initial no-deadline state so the same task serves every iteration), self-checked per iteration against the hand-written read-backs (the set and overwritten deadlines read back exactly, the cleared state reads back undefined, and the task stays in OPEN with its single PUBLISH entry throughout), with per-state / clear-all, normalized-storage, unparseable-rejection, and terminal-state checks on separate probe tasks outside the timed loop; single-step transition dispatch (benchTransition restoring the fixed OPEN snapshot \u2014 1 PUBLISH entry at the base instant \u2014 and dispatching one ACCEPT step pinned at BASE + 1s with quotedAmount 125, checked on every iteration for the one-step state advance OPEN -> ACCEPTED, exactly one appended entry, and a gap-free seq continuation, with an exhaustive pure-transition check over all 13 states x 15 events \u2014 19 legal edges returning their hand-pinned targets, every other pair throwing the exact invalid-transition message, including the illegal PAYOUT_COMPLETE dispatch from OPEN \u2014 asserted once outside the timed loop; transition-table pure object construction (transitionTable) with no arguments, checked on every iteration against the hand-pinned 19 edges written out in full in declaration order (every edge key order from, event, to; spot-checked against the transitionTableJson edge set via the shared pinned first, payout (index 14), and last edges), with the full edge set compared to the parsed JSON edge set edge for edge and a hand-pinned non-existent edge (DRAFT / PAYOUT_COMPLETE / PAID) confirmed absent from both once outside the timed loop; subscribe onError error routing (subscribe with 1 fixed throwing listener and a collecting onError hook) over the same full 8-dispatch lifecycle on a fresh task per iteration, self-checked per iteration that every dispatch succeeded, the history count and the onError report count both equal the dispatch count (8), every report carries the pinned listener message, and the first report's context is the hand-pinned PUBLISH DRAFT -> OPEN, with a throwing-onError swallowing probe and the exact non-function onError rejection (invalid subscribe: onError must be a function, got string, registering nothing) asserted once outside the timed loop; keyed hash-chain verification (verifyHistoryChain with auditSecret) over a fixed 8-entry HMAC-chained history under a pinned audit secret (the same lifecycle steps and fixed timestamps as the unkeyed fixture, chained in keyed mode), self-checked on every iteration for exactly true with the genesis and successor links pinned, with a wrong secret returning false, a detached tampered copy (the middle SUBMIT entry gaining a payoutAmount of 999) returning false, and the same keyed history verified without a secret returning false (fail-closed), each asserted once outside the timed loop; dispatch idempotency dedupe (dispatch with idempotencyKey) over a fresh task per iteration (one keyed PUBLISH under a pinned key appends exactly one entry and consumes the key, and the same event under the same key returns the current state and appends nothing — self-checked per iteration for both returns, the exactly-one-entry history with a gap-free seq, the consumed-key snapshot holding exactly the pinned key, and exactly one listener notification), with cross-event dedupe, a stale retry answering with the current state after the task moved on, a failed dispatch consuming no key (the corrected retry under the same key executes), and two keyless dispatches appending two entries, each asserted once outside the timed loop; payout webhook secret-rotation verification (verifyPayoutWebhook with { secrets: [new, old] } over the old-signed fixed webhook \u2014 the matching candidate is second, so every iteration pays one failed HMAC trial before the match \u2014 checked exactly true on every iteration, with an all-mismatch candidate pair pinned to false and an empty secrets array pinned to its exact configuration error, both once outside the timed loop); payout webhook Retry-After cap delivery (deliverPayoutWebhook through an injected fake fetch answering 429 with a pinned Retry-After: 30 hint then 200, with backoffMs 100, an injected recording sleep, and maxRetryDelayMs 5000 — checked on every iteration for result {ok: true, attempts: 2, status: 200}, exactly two captured calls with byte-identical signed bodies, and the recording sleep receiving exactly the clamped 5000 ms, with a no-hint 429 falling back to the 100 ms backoff base, a below-cap Retry-After: 2 hint honored exactly at 2000 ms, and a 500 carrying a Retry-After header ignored as a hint, each pinned once outside the timed loop); payout webhook jitterMs backoff delivery (deliverPayoutWebhook through an injected fake fetch answering 500 twice then 200, with backoffMs 100, maxAttempts 3, and an injected recording sleep — checked on every iteration for result {ok: true, attempts: 3, status: 200}, exactly three captured calls, the two jittered sleeps (jitterMs 1000) landing inside [100, 1100] and [200, 1200], and the zero-jitter delivery sleeping exactly [100, 200], with the exact jittered sleeps [100, 700] under a stubbed Math.random sequence [0, 0.5] pinned once outside the timed loop); dispatch requirePayoutRef enforcement (dispatch PAYOUT_COMPLETE with the pinned payoutRef on a fresh task constructed with { requirePayoutRef: true } and driven to PAYOUT_PENDING under fixed timestamps on every iteration — the rebuild cost is inside the timed region because the dispatch settles the task — checked on every iteration for the PAID return, the exactly-8-entry history, and the last entry's pinned seq / event / timestamp / payoutRef, with a ref-less dispatch on an enforced task pinned to the exact payout-reference-required error and untouched state and history, and a default task pinned to still settle without a reference, each once outside the timed loop); dispatch expectedSeq optimistic-concurrency guard (dispatch START_CAPTURE with expectedSeq 2 on a fresh task driven under fixed timestamps to a pinned 2-entry ACCEPTED history on every iteration — the rebuild cost is inside the timed region because the guarded dispatch mutates the task — checked on every iteration for the CAPTURING return, the exactly-3-entry history, and the last entry's pinned seq / event / timestamp / actor, with a stale expectedSeq pinned to the exact dispatch-conflict error and byte-identical state and history, expectedSeq 0 on an empty history pinned to advance, illegal values -1 and 1.5 pinned to their exact configuration errors, and dispatch without expectedSeq pinned to behave unchanged, each once outside the timed loop); payout webhook AbortSignal pre-abort delivery (deliverPayoutWebhook through an injected counting fake fetch — immediate 200 if ever called, no network — with a pre-aborted external signal, checked on every iteration for the reported result {ok: false, attempts: 0, error: \"payout webhook delivery aborted\"} with no status and exactly zero fetch calls, with a non-AbortSignal signal value pinned to its exact configuration error and an unaborted signal pinned to the unchanged normal delivery, each once outside the timed loop); payout webhook maxAgeMs freshness-window verification (verifyPayoutWebhook with { maxAgeMs: 300000, now: at + 60s } over the fixed signed webhook — checked exactly true on every iteration, with a payload 1 ms past the window pinned to false, a payload exactly at the inclusive boundary pinned to true, and an illegal -1 maxAgeMs pinned to its exact configuration error, each once outside the timed loop); payout webhook maxFutureSkewMs future-skew verification (verifyPayoutWebhook with { maxFutureSkewMs: 300000, now: at \u2212 60s } over the fixed signed webhook \u2014 checked exactly true on every iteration, with a payload 1 ms beyond the window pinned to false, a payload exactly at the inclusive boundary pinned to true, the two-sided window with maxAgeMs pinned on all three sides (inside both bounds true, beyond the future bound false, beyond the age bound false), and an illegal -1 maxFutureSkewMs pinned to its exact configuration error, each once outside the timed loop); dispatch maxDisputes dispute budget (dispatch DISPUTE with the pinned budget maxDisputes 1 on a fresh task driven under fixed timestamps to a pinned 6-entry REJECTED history on every iteration — the rebuild cost is inside the timed region because the dispatch spends the single budget unit — checked on every iteration for the DISPUTED return, the exactly-7-entry history, and the last entry's pinned seq / event / timestamp / actor, with a second DISPUTE after one full appeal round pinned to the exact dispute-budget-exhausted error and byte-identical state and history, a budget of 0 pinned to make the first DISPUTE throw at once, a task built without the option pinned to run repeated appeal rounds, a snapshot round-trip pinned to keep the budget exhausted, and illegal budgets -1 and 1.5 pinned to their exact invalid-option errors plus an illegal snapshot budget pinned to its exact invalid-snapshot error, each once outside the timed loop); dispatch maxResubmits retry budget (dispatch RESUBMIT with the pinned budget maxResubmits 2 on a fresh task driven under fixed timestamps to a pinned 6-entry REJECTED history on every iteration — the rebuild cost is inside the timed region because the dispatch spends one budget unit and advances the task to CAPTURING — checked on every iteration for the CAPTURING return, the exactly-7-entry history, and the last entry's pinned seq / event / timestamp / actor, with a third RESUBMIT after two full resubmit rounds pinned to the exact resubmit-budget-exhausted error and byte-identical state and history, a budget of 0 pinned to make the first RESUBMIT throw at once, a task built without the option pinned to run repeated resubmit rounds, and illegal budgets -1 and 1.5 pinned to their exact invalid-option errors plus an illegal snapshot budget pinned to its exact invalid-snapshot error, each once outside the timed loop); dispatch rolePolicy authorization (dispatch ACCEPT with the pinned allowlist \`ACCEPT: [\"reviewer\"]\` on a fresh task driven under fixed timestamps to a pinned 1-entry OPEN history on every iteration — the rebuild cost is inside the timed region because the authorized dispatch advances the task to ACCEPTED — checked on every iteration for the ACCEPTED return, the exactly-2-entry history, and the last entry's pinned seq / event / timestamp / actor, with an unauthorized actor (\"viewer\") pinned to the exact \`actor not authorized for ACCEPT: \"viewer\" is not in [reviewer]\` error and byte-identical state and history, a missing actor pinned to the exact \`actor not authorized for ACCEPT: policy requires an actor in [reviewer]\` error with the same untouched state and history, and a task built without a policy pinned to advance the same actorless ACCEPT unchanged (the pre-RBAC default), each once outside the timed loop); payout webhook timeoutMs timeout delivery (deliverPayoutWebhook through an injected hanging fake fetch \u2014 it never answers on its own and only settles when the per-attempt abort fires, no network \u2014 with timeoutMs pinned at 10 and maxAttempts 1, checked on every iteration for the reported result {ok: false, attempts: 1, error: \"webhook delivery timed out after 10ms\"} with no status and exactly one fetch call, with an illegal timeoutMs of 0 pinned to its exact configuration error (cannot deliver payout webhook: timeoutMs must be a positive number, got 0) with zero fetch calls and a generous timeoutMs of 5000 pinned to the unchanged immediate-200 delivery {ok: true, attempts: 1, status: 200}, each once outside the timed loop; honest limit: the timeout wait itself is the object under test, at its pinned short length of 10 ms, and no elapsed duration is asserted); policy snapshot round-trip (toJSON + JSON text + TaskLifecycle.fromJSON) over a fixed task (BENCH-522) driven under fixed timestamps to a pinned 10-entry REJECTED history while carrying a pinned rolePolicy (DISPUTE: [\"contributor\"], RESUBMIT: [\"contributor\"]) and finite budgets (maxResubmits 1 with 1 of 1 used, maxDisputes 2 with 0 used) — checked on every iteration for the restored state and history entry for entry, the history-derived used counts, the envelope's byte-identical rolePolicy and budget fields, and the re-export fixed point at the same byte length, with an unauthorized actor (\"intruder\") on the policy-covered DISPUTE pinned to the exact actor-not-authorized error and an authorized RESUBMIT pinned to the exact resubmit-budget-exhausted error (the budget is history-derived, so persistence does not reset it), each once outside the timed loop; dispatch explicit timestamp (dispatch START_CAPTURE with a pinned canonical ISO-8601 at injected verbatim into the history entry) on a fresh task driven under fixed timestamps to a pinned 2-entry ACCEPTED history on every iteration — the rebuild cost is inside the timed region because the timestamped dispatch advances the task to CAPTURING — checked on every iteration for the CAPTURING return, the exactly-3-entry history, and the last entry's pinned seq / event / timestamp (byte-identical to the injected BASE + 2s value) / actor, with a non-canonical at pinned to the exact invalid-dispatch-options error and byte-identical state and history once outside the timed loop; history getter defensive copy (one get history() call per iteration) on a fixed task (BENCH-HG) with a pinned 64-entry hash-chained history (PUBLISH / ACCEPT / START_CAPTURE / SUBMIT / BEGIN_REVIEW / REJECT, then 14 RESUBMIT rounds of RESUBMIT / SUBMIT / BEGIN_REVIEW / REJECT, then a final RESUBMIT / SUBMIT, ending in SUBMITTED) under fixed timestamps — the O(n) copy + per-entry Object.freeze tax the audit-immutability guarantee costs on every read, previously invisible inside the subscribe / replay / snapshot rows, which never isolated the getter itself — checked on every iteration for exactly 64 entries, the frozen array and frozen entries, content byte-identical to the fixture baseline, and consecutive calls never sharing entry references, with one-off push / splice / entry-field-write probes pinned to throw and to leave the internal history untouched once outside the timed loop (the same assertions the historyFreeze unit tests pin); SLA approaching-deadline screening (tasksApproachingDeadline) over a fixed batch of 6 tasks (in-window, upper-bound-inclusive, lower-bound-exclusive, overdue, no-deadline, and terminal-PAID) under one injected fixed now with a 24-hour window, self-checked on every iteration for the hand-pinned [AP-01, AP-02] selection with the overdue contrast [AP-03, AP-04] pinned once outside the timed loop; state-filter listing (tasksByState) over the fixed 12-task watchdog batch — the OPEN slice [WD-01, WD-02, WD-08, WD-12] in input order holding the same task objects, with the terminal-PAID contrast [WD-03] and the unknown-state fail-fast pinned once outside the timed loop; actor-filter listing (tasksByActor) over a fixed 6-task mixed-actor batch — the moderator slice [BENCH-ACTOR-01, BENCH-ACTOR-02, BENCH-ACTOR-04] in input order holding the same task objects, with the twice-touched task matching once, the anonymous and no-history tasks excluded, and the contributor contrast and empty-actor fail-fast pinned once outside the timed loop; minor-unit display formatting (formatMinorUnits) over the fixed 12-vector demo corpus — positive, zero, negative, -0 without a minus sign, large, and MAX_SAFE_INTEGER, plus the finance-pass total — self-checked per iteration against the demo's pinned strings, with a fractional input pinned to its exact fail-fast error once outside the timed loop; minor-unit conversion (toMinorUnits/fromMinorUnits) over the fixed 4-vector corpus — the finance-pass total 16349 major units ↔ 1634900 minor units, zero, a negative amount, and the 0.33 round-trip — plus the 0.333 nearest-cent rounding vector, self-checked per iteration in both directions, with a fractional minor input pinned to its exact fail-fast error once outside the timed loop; payout webhook delivery-header verification (deliverPayoutWebhook to a loopback server answering 500 then 200, backoffMs 0, no-op sleep, default fetch — checked on every iteration for result {ok: true, attempts: 2, status: 200}, exactly two captured requests, every attempt's Idempotency-Key and X-Event-Id both equal to the body eventId, and both bodies byte-identical to the signed body, with the captured X-Hub-Signature-256 pinned equal to the build-time signature and verifying over the captured body once outside the timed loop, pinning both headers outside signature coverage; honest limit: the row is local-HTTP-bound, not a measure of delivery logic overhead); payout webhook fan-out jitterMs backoff delivery (deliverPayoutWebhookToMany to 4 fixed endpoints, every endpoint answering 500 twice then 200, backoffMs 100, maxAttempts 3, jitterMs 1000 at the call level — checked on every iteration for every endpoint reporting {ok: true, attempts: 3, status: 200} with exactly 3 fetch calls and per-endpoint sleeps inside [100, 1100] and [200, 1200], and the zero-jitter control fan-out sleeping exactly [100, 200] per endpoint, with every endpoint's final call body carrying the shared eventId and verifying under its own secret pinned once outside the timed loop; honest limit: the exact jitter spread is pinned by the single-endpoint row, not here, because concurrent endpoints share the global Math.random and draw order is nondeterministic); ",
);
console.log(`Iterations per op: ${ITERATIONS} (after ${WARMUP} warmup)`);
console.log("");

const results: Array<{ path: string; ops: number }> = [
  { path: "dispatch (full lifecycle, 8 dispatches)", ops: benchDispatchLifecycle() },
  { path: "dispatch idempotency dedupe (keyed dispatch + duplicate)", ops: benchDispatchIdempotencyDedupe() },
  { path: "dispatch requirePayoutRef (with payoutRef)", ops: benchDispatchRequirePayoutRef() },
  { path: "dispatch expectedSeq (optimistic concurrency guard)", ops: benchDispatchExpectedSeq() },
  { path: "dispatch maxDisputes (dispute budget, 1 DISPUTE)", ops: benchDispatchMaxDisputes() },
  { path: "dispatch maxResubmits (retry budget, 1 RESUBMIT)", ops: benchDispatchMaxResubmits() },
  { path: "dispatch rolePolicy (authorized ACCEPT dispatch)", ops: benchDispatchRolePolicy() },
  { path: "dispatch {at} (explicit timestamp)", ops: benchDispatchAt() },
  { path: "replay (8-entry history)", ops: benchReplay() },
  { path: "fromHistory (8-entry history)", ops: benchFromHistory() },
  { path: "verifyHistoryChain (8 entries)", ops: benchVerifyHistoryChain() },
  { path: "verifyHistoryChain auditSecret (8 entries, keyed)", ops: benchVerifyHistoryChainAuditSecret() },
  { path: "buildPayoutWebhook (sign)", ops: benchBuildPayoutWebhook() },
  { path: "verifyPayoutWebhook", ops: benchVerifyPayoutWebhook() },
  { path: "verifyPayoutWebhook (secrets rotation, 2 candidates)", ops: benchVerifyPayoutWebhookSecretsRotation() },
  { path: "verifyPayoutWebhook maxAgeMs freshness window", ops: benchVerifyPayoutWebhookMaxAge() },
  { path: "verifyPayoutWebhook maxFutureSkewMs future-skew window", ops: benchVerifyPayoutWebhookMaxFutureSkew() },
  { path: "verifyPayoutWebhook (secrets rotation x maxFutureSkewMs)", ops: benchVerifyPayoutWebhookRotationFutureSkew() },
  { path: "verifyPayoutWebhook x PayoutEventDedupe receiver flow", ops: benchVerifyPayoutWebhookDedupe() },
  { path: "historyToNdjson (8 entries)", ops: benchHistoryToNdjson() },
  { path: "historyFromNdjson (8 entries, chain re-verify)", ops: benchHistoryFromNdjson() },
  { path: "mismatchedPayouts (12 PAID tasks)", ops: benchMismatchedPayouts() },
  { path: "unreconciledPayouts (12 PAID tasks)", ops: benchUnreconciledPayouts() },
  { path: "NDJSON -> fromHistory -> unreconciledPayouts (12 PAID tasks)", ops: benchNdjsonUnreconciledPayouts() },
  { path: "totalPaidOut (12 PAID tasks)", ops: benchTotalPaidOut() },
  { path: "deliverPayoutWebhookToMany (4 endpoints)", ops: await benchDeliverPayoutWebhookToMany() },
  { path: "deliverPayoutWebhookToMany x PayoutEventDedupe fan-out receiver flow (4 endpoints)", ops: await benchDeliverPayoutWebhookToManyDedupe() },
  { path: "deliverPayoutWebhookToMany limits (maxEndpoints / overallDeadlineMs)", ops: await benchDeliverPayoutWebhookToManyLimits() },
  { path: "deliverPayoutWebhook (single endpoint)", ops: await benchDeliverPayoutWebhook() },
  { path: "deliverPayoutWebhook maxRetryDelayMs cap", ops: await benchDeliverPayoutWebhookRetryCap() },
  { path: "deliverPayoutWebhook jitterMs backoff", ops: await benchDeliverPayoutWebhookJitter() },
  { path: "deliverPayoutWebhookToMany jitterMs fan-out (4 endpoints)", ops: await benchDeliverPayoutWebhookToManyJitter() },
  { path: "deliverPayoutWebhookToMany maxRetryDelayMs fan-out (4 endpoints)", ops: await benchDeliverPayoutWebhookToManyRetryCap() },
  { path: "deliverPayoutWebhook AbortSignal pre-abort", ops: await benchDeliverPayoutWebhookAbortPre() },
  { path: "deliverPayoutWebhook timeoutMs timeout", ops: await benchDeliverPayoutWebhookTimeout() },
  { path: "deliverPayoutWebhook delivery headers (loopback, 500 then 200)", ops: await benchDeliverPayoutWebhookDeliveryHeaders() },
  { path: "PayoutEventDedupe checkAndRecord (hit, 1,000 recorded ids)", ops: benchPayoutEventDedupe() },
  { path: "PayoutEventDedupe.restore (1,000-entry snapshot)", ops: benchPayoutEventDedupeRestore() },
  { path: "PayoutEventDedupe.exportSnapshot (5 live entries, 1 expired)", ops: benchPayoutEventDedupeExportSnapshot() },
  { path: "PayoutEventDedupe.clear (1,000 recorded ids, fresh fixture)", ops: benchPayoutEventDedupeClear() },
  { path: "PayoutEventDedupe.stats (5 live entries, 1 expired)", ops: benchPayoutEventDedupeStats() },
  { path: "PayoutEventDedupe checkAndRecord (miss/evict, 250 new ids, capacity 100)", ops: benchPayoutEventDedupeMissEvict() },
  { path: "buildPayoutWebhooks (batch of 12 PAID tasks)", ops: benchBuildPayoutWebhooks() },
  { path: "expiredTasks (12 mixed-state tasks)", ops: benchExpiredTasks() },
  { path: "staleTasks (12 mixed-state tasks)", ops: benchStaleTasks() },
  { path: "expireOverdueTasks (12 mixed-state tasks, fresh fixture)", ops: benchExpireOverdueTasks() },
  { path: "actOnStaleTasks (12 mixed-state tasks, fresh fixture)", ops: benchActOnStaleTasks() },
  { path: "actOnStaleTasks notify-only (12 mixed-state tasks, fresh fixture)", ops: benchActOnStaleTasksNotifyOnly() },
  { path: "actOnStaleTasks x subscribe (12 mixed-state tasks, fresh fixture)", ops: benchActOnStaleTasksSubscribe() },
  { path: "expireOverdueTasks x subscribe (12 mixed-state tasks, fresh fixture)", ops: benchExpireOverdueTasksSubscribe() },
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
  { path: "toJSON + fromJSON policy snapshot round-trip (10 entries, rolePolicy + budgets)", ops: benchPolicySnapshotRoundTrip() },
  { path: "getSlaDeadline (13 states, 2 set)", ops: benchGetSlaDeadline() },
  { path: "MAX_NOTE_LENGTH note guard (2-case corpus)", ops: benchMaxNoteLength() },
  { path: "setSlaDeadline + clearSlaDeadline (OPEN task write cycle)", ops: benchSetClearSlaDeadline() },
  { path: "benchTransition (single step, snapshot restore)", ops: benchTransition() },
  { path: "history getter (defensive copy, 64 entries)", ops: benchHistoryGetter() },
  { path: "tasksApproachingDeadline (6 mixed tasks, 24h window)", ops: benchTasksApproachingDeadline() },
  { path: "tasksByState (12 mixed-state tasks, OPEN slice)", ops: benchTasksByState() },
  { path: "tasksByActor (6 mixed-actor tasks, moderator slice)", ops: benchTasksByActor() },
  { path: "formatMinorUnits (12 fixed vectors, pinned strings)", ops: benchFormatMinorUnits() },
  { path: "toMinorUnits/fromMinorUnits (4-vector conversion + 0.333 rounding)", ops: benchMinorUnitsConversion() },
];

console.log("path                                              throughput");
console.log("---------------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.path.padEnd(50)} ${fmt(r.ops)}`);
}
console.log("");
console.log("Numbers are machine-local measurements, not guarantees.");
