/**
 * Demo: drive one task from DRAFT to PAID — its first submission is
 * REJECTed in QA and RESUBMITted before it passes on re-review — print
 * the append-only audit history, verify that history's hash chain
 * with `verifyHistoryChain` (the intact chain passes; a detached
 * copy whose PAYOUT_COMPLETE entry's `payoutAmount` is altered by 1
 * is detected, and the original history re-verifies untouched), run
 * a second task through the SLA
 * watchdog branch (an advisory deadline passes, `expiredTasks()`
 * screening finds the task, and a watchdog explicitly dispatches
 * EXPIRE into the EXPIRED terminal state), run a third task through
 * the DISPUTE appeal branch (a REJECTED task is DISPUTEd into
 * DISPUTED and an arbitrator's ARBITRATE_REJECT lands it back in
 * REJECTED, consuming the task's one demo dispute), then build the
 * signed payout webhook for the settled task and verify it the way
 * a receiver would, feed its `eventId` through a receiver-side
 * `PayoutEventDedupe` under an injected fixed clock (the first
 * delivery is booked, the redelivery is skipped as a duplicate,
 * and the same id is accepted again once the demo TTL lapses),
 * run the batch builder
 * (`buildPayoutWebhooks`) over all three demo tasks — the
 * settlement-peak pipeline in which each non-PAID task fails only
 * itself and every built webhook is verified in turn — then fan
 * the main task's payout event out with
 * `deliverPayoutWebhookToMany` to three fixed endpoints under one
 * shared fixed `eventId` / `now`, each endpoint signed with its
 * own demo secret and delivered through an injected fake fetch
 * (one endpoint answers 500 on every attempt and exhausts its
 * retries; the other two still succeed — a failing endpoint never
 * blocks the rest), parse a fixed 6-value corpus of would-be
 * `Retry-After` hints with `parsePayoutRetryAfter` under the
 * fan-out segment's shared fixed instant reused as `nowMs`
 * (delay-seconds and HTTP-date forms normalized to milliseconds,
 * a past date clamped to 0, and garbage / absent values falling
 * back to `undefined` — the hint a 429 response would have used
 * to set the risk endpoint's next retry delay) — and finally
 * run a reconciliation screening branch: two more tasks driven to
 * PAID under fixed-literal timestamps, one settled with no
 * `payoutRef` on its `PAYOUT_COMPLETE` entry and one settled for
 * less than its `ACCEPT` quote, screened together with the three
 * earlier tasks by `unreconciledPayouts()` / `mismatchedPayouts()`
 * / `totalPaidOut()` — the post-settlement finance pass a platform
 * runs after payout day — run a sixth task through the dispatch
 * subscription branch (a collecting listener subscribed before any
 * dispatch receives each `(event, from, to)` in order, matching
 * the audit history entry for entry, and — after unsubscribe —
 * receives nothing for one further dispatch), run three more
 * tasks through the stale-task dwell screening branch (each task's
 * history ends at a fixed literal timestamp, so at one fixed
 * screening `now` the dwell in its current state — `now` minus the
 * last history entry's `at` — is exact: one task has sat in OPEN
 * past its dwell budget but its SLA deadline is still ahead, one
 * has sat in IN_REVIEW within its dwell budget but its SLA
 * deadline has passed, and one is within both — so `staleTasks()`
 * and `expiredTasks()` select different subsets of the same batch,
 * printed side by side), run four more tasks through the
 * stale-task batch execution branch (at the same fixed `now`,
 * `actOnStaleTasks()` runs an ABANDON action over the batch: a
 * stale task stuck in SUBMITTED — a state with no ABANDON edge —
 * fails in isolation and is left untouched, the stale ACCEPTED
 * and CAPTURING tasks after it are still abandoned, and a fresh
 * ACCEPTED task is never attempted), run three more tasks through
 * the SLA watchdog batch execution branch (a fresh rebuild of the
 * SLA screening batch's fixed-literal setup under the very same
 * fixed screening `now` — the executor mutates its inputs and the
 * original branch tasks are already settled — on which
 * `expireOverdueTasks()` dispatches EXPIRE for both overdue tasks
 * while the not-yet-overdue task produces no result entry at all,
 * and the screening subset is printed beside the execution's
 * acted set: the two agree), an
 * event-sourcing replay
 * segment: the main task's audit history is exported with
 * `historyToNdjson()`, printed in full, parsed back with
 * `historyFromNdjson()`, and replayed with
 * `TaskLifecycle.fromHistory()` — the history alone, as the single
 * source of truth, rebuilds the same PAID terminal state — and
 * finally an allowed-events listing segment: `allowedEvents(state)`
 * is run over all 13 states in transition-table order and printed
 * as a one-line-per-state overview — the query a task-list UI or a
 * watchdog consults to decide what a task can do next — with the
 * three terminal states (PAID / ABANDONED / EXPIRED) returning the
 * empty list, and the main task's own PAID state called out on its
 * own line as that same empty set — and finally a standalone
 * history parsing segment: a fixed JSON text carrying the same
 * five-entry PUBLISH..BEGIN_REVIEW chain that opens the main
 * task (fixed timestamps, hashless legacy form) is parsed with
 * `parseHistory` alone — no `TaskLifecycle` instance involved —
 * printed entry by entry, and compared against the main task's
 * own history prefix on one line; a detached copy whose third
 * entry's `from` is rewritten is rejected, asserted outside the
 * printed parse and reported on one closing line — and finally a
 * transition-table JSON export segment: `transitionTableJson()`
 * exports the whole transition table as canonical JSON for
 * front-end / docs tooling, and the demo prints an export summary
 * (the 19-edge total plus the first, payout, and last edges,
 * hand-pinned in the segment comment and cross-checked against
 * the committed transition-table snapshot by the demo tests) —
 * the machine-readable counterpart of the state diagram a reader
 * has only seen rendered as Mermaid so far — and finally a state
 * diagram generation segment: `stateDiagram()` renders that same
 * table as the Mermaid stateDiagram-v2 block the README embeds
 * verbatim, and the demo prints a generation summary (the
 * 24-line total and 19-edge count plus the first, second,
 * initial, first-edge, last-edge, and last lines, hand-pinned in
 * the segment comment and cross-checked against the full
 * generated block by the demo tests) — the docs-drift guard's
 * own output, shown instead of only asserted — and finally a
 * README diagram sync check segment: `readmeDiagramInSync()`
 * (imported directly from `src/diagram.ts`, as the benchmark
 * does — it is not re-exported from the package entry) reads
 * this repo's README and reports whether it embeds the exact
 * generated block, and the demo prints that verdict (hand-pinned
 * to `true` in the segment comment and cross-checked against
 * the diagram tests) — the sync conclusion itself, shown
 * instead of only asserted by the test suite — and finally a
 * JSON snapshot round-trip segment: the main task is exported
 * with `toJSON()`, serialized with `JSON.stringify` (the demo
 * prints the serialized byte count), parsed back and restored
 * with `TaskLifecycle.fromJSON()`, and the demo asserts outside
 * the printed lines that the restored task's state, full
 * history, and history-derived used RESUBMIT count match the
 * original, and that re-exporting the restored task yields the
 * identical snapshot content at the same serialized length
 * (fromJSON normalizes history-entry key order; values and
 * hashes are unchanged) — the persistence round-trip a
 * document store would rely on, shown instead of only asserted
 * by the serialization tests — and finally a single-task payout
 * reconciliation detail segment: `payoutMismatch()` is called on
 * the reconciliation branch's two settled tasks one at a time —
 * the mismatched task (its `ACCEPT` quote hand-pinned at 4000 in
 * the branch comment, settled 3750.5) prints its full detail
 * `{ quoted, paid, delta }` with delta -249.5, and the task that
 * settled exactly as quoted (2500 against 2500) prints the
 * no-mismatch form, `undefined` — the per-task follow-up finance
 * runs after the batch `mismatchedPayouts()` screen flags a task,
 * shown instead of only asserted by the reconciliation tests —
 * and a snapshot version envelope segment: the main
 * task's snapshot `v` field is printed and asserted equal to
 * the imported `SNAPSHOT_VERSION`, a detached copy retagged
 * `v: 2` is passed to `TaskLifecycle.fromJSON()` and its
 * rejection error is printed (the future format is refused,
 * not silently misread), and the original snapshot is read
 * back afterwards to show it still restores — the version
 * gate a document store relies on when a snapshot format
 * evolves, shown instead of only asserted by the snapshot
 * version tests — and a note length limit segment:
 * a dedicated task is dispatched under a fixed timestamp
 * with a note of exactly `MAX_NOTE_LENGTH` (32768)
 * characters and succeeds (only the note's length is
 * printed, never the note itself), and a following dispatch
 * with a note one character over the limit (32769) is
 * rejected with the length error, leaving the task's state
 * and history untouched — the audit-history anti-bloat
 * guard, shown instead of only asserted by the actor/note
 * hardening tests — and finally a standalone overdue
 * judgement segment: `isOverdue(task, now)` is called on
 * fixed tasks at fixed instants and its five boundary
 * verdicts are printed — before the deadline `false`,
 * exactly at the deadline `true` (the boundary is
 * inclusive), after the deadline `true`, a task with no
 * deadline `false`, and a terminal task past its deadline
 * `false` — the advisory SLA judgement itself, shown
 * instead of only asserted by the SLA tests (the watchdog
 * branches above show the batch screens built on it) —
 * and finally a terminal-state judgement segment:
 * the standalone `isTerminal(state)` is called over all
 * 13 states in transition-table declaration order and
 * every verdict is printed with that state's outgoing-edge
 * count — only PAID / ABANDONED / EXPIRED are terminal —
 * and the printed terminal set is cross-checked against
 * the transition table itself: it is exactly the set of
 * states with no outgoing edges (the branches above only
 * ever showed the instance getter as a `(terminal: …)`
 * aside on a branch's final line, never the full set) —
 * and finally an SLA deadline clearing segment: a dedicated
 * task carries fixed SLA deadlines for three states and is
 * overdue at a fixed instant; `clearSlaDeadline(state)`
 * clears only its current state's deadline (the read-back
 * is `undefined` and the overdue verdict turns `false`),
 * and `clearSlaDeadline()` with no argument then clears
 * the remaining states' deadlines — the renegotiated /
 * cancelled deadline a reader would otherwise never see
 * revoked, shown instead of only asserted by the SLA tests
 * — and a single-target payout webhook delivery
 * segment: the main task's signed webhook (built above) is
 * delivered with `deliverPayoutWebhook` to one fixed endpoint
 * through an injected fake fetch scripted to answer 500 then
 * 200 (backoffMs 0 with a no-op sleep, so the retry never
 * really waits and no network is touched), and the demo
 * prints the delivery result and asserts outside the printed
 * lines that both captured wire calls carry the byte-identical
 * signed body and that the captured signature verifies over
 * that body — the single-endpoint delivery path a reader has
 * only seen fanned out so far — and finally a subscribe
 * onError error routing segment: a dedicated task carries a
 * listener that throws on every notification, subscribed
 * with a collecting `onError` hook; the demo runs a short
 * fixed-timestamp dispatch chain, prints how many errors
 * `onError` received and the first report's dispatch context
 * (event / from / to), and asserts outside the printed lines
 * that every dispatch still succeeded, the audit history is
 * complete, every routed context matches the hand-pinned
 * chain, and — on a separate probe task — that an `onError`
 * hook that itself throws is swallowed too — the
 * listener-failure observability path a reader has only
 * seen with a collecting listener so far — and a
 * payout dedupe snapshot persistence segment: a fresh
 * `PayoutEventDedupe` under an injected fixed clock records
 * two fixed payout `eventId`s (each new on first sight, a
 * duplicate on immediate redelivery), exports them with
 * `exportSnapshot()` (only the snapshot version and entry
 * count are printed, never the full entries), round-trips
 * the snapshot through JSON text, and restores it with
 * `PayoutEventDedupe.restore()` — the restored store's
 * observability counters start at zero, yet both ids still
 * read as duplicates and an unseen id reads as new — and a
 * detached copy of the snapshot with its version rewritten
 * to 2 is rejected with the exact invalid-snapshot error —
 * the receiver-restart persistence path a reader has only
 * seen asserted by the dedupe snapshot tests so far —
 * a payout dedupe stats observability segment:
 * a fresh `PayoutEventDedupe` under an injected fixed clock
 * with a small `maxEntries` runs a pinned script (a new
 * `eventId`, its immediate redelivery, two more new ids that
 * fill the store, and a fourth new id that evicts the least
 * recently seen one), printing `stats()` — the `{ size,
 * hits, misses, evictions }` counters — after every step,
 * and a returned stats object is then mutated to show the
 * snapshot is a detached copy that leaves the store's own
 * counters unchanged — the receiver-operations
 * observability surface a reader has only seen asserted by
 * the dedupe stats tests so far —
 * a payout dedupe clear reset segment: a fresh
 * `PayoutEventDedupe` under an injected fixed clock records
 * one fixed payout `eventId` (new on first sight, a duplicate
 * on immediate redelivery, its stats pinned), then calls
 * `clear()` — printing size and stats back at all zero — and
 * records the same `eventId` again, which reads as a new
 * event (`false`) with the counters re-accumulating from
 * zero — the explicit reset surface (key rotation, test
 * isolation, window reset) a reader has only seen asserted
 * by the dedupe clear test so far, and could otherwise
 * mistake for something only TTL expiry can do —
 * and a payout webhook 429 Retry-After delivery
 * segment: the main task's signed webhook is delivered
 * with `deliverPayoutWebhook` to one fixed endpoint
 * through an injected fake fetch scripted to answer 429
 * with a pinned `Retry-After: 30` header on the first
 * attempt and 200 on the retry, with a recording fake
 * sleep in place of a real wait — the recorded sleep is
 * exactly the parsed hint (30 s = 30000 ms) clamped to
 * the segment's `maxRetryDelayMs` (5000), never the
 * exponential backoff — the actual end-to-end wait a
 * reader has only seen parsed in isolation and asserted
 * by the delivery tests so far —
 * and finally a payout webhook AbortSignal segment:
 * the main task's signed webhook is delivered with
 * `deliverPayoutWebhook` under an external `AbortSignal`
 * in two pinned forms — a signal aborted before the call
 * (zero fetch calls, the result reports
 * `{ ok: false, attempts: 0, error: "payout webhook delivery aborted" }`)
 * and a signal aborted inside the backoff sleep after a
 * first 500 answer (the pending 30000 ms wait is cut
 * short, no second attempt is started, and the result
 * reports the one attempt actually made, with its 500
 * status and the same pinned error) — the caller
 * cancellation path a reader has only seen asserted by
 * the payout webhook abort-signal tests so far —
 * and a payout webhook freshness window segment:
 * a fixed notification built from the main task at a
 * pinned signing time is verified with
 * `verifyPayoutWebhook`'s opt-in freshness window under
 * injected receiver clocks — inside the `maxAgeMs`
 * window it verifies, exactly at the window boundary it
 * still verifies (only `now - at > maxAgeMs` fails), the
 * same body and signature past the window fail closed
 * even though the signature alone still verifies, and a
 * payload lying further ahead of the receiver than
 * `maxFutureSkewMs` allows also fails closed — the
 * replay bound a reader has only seen asserted by the
 * payout webhook freshness and future-skew tests so far —
 * and a payout reference enforcement segment:
 * a dedicated task constructed with
 * `requirePayoutRef: true` is driven to PAYOUT_PENDING
 * under fixed timestamps and its `PAYOUT_COMPLETE`
 * without a `payoutRef` is rejected with the pinned
 * `payout reference required: …` error, leaving its
 * state and history untouched; the same dispatch with
 * a pinned `payoutRef` then succeeds and the history's
 * last entry carries that reference verbatim; a second
 * dedicated task under the default (the option unset)
 * completes without a reference — the fail-fast
 * settlement gate a reader has only seen asserted by
 * the requirePayoutRef tests so far —
 * and finally a dispatch idempotency key segment:
 * a dedicated task dispatches under fixed timestamps
 * with pinned `idempotencyKey`s — the same key sent
 * twice for the same event appends a single history
 * entry and notifies its listener once; after the task
 * moves on, retries under the old key still dedupe,
 * both for a different (would-be legal) event and for
 * the stale original event, returning the current
 * state without throwing `invalid transition`; a
 * second dedicated task first fails a dispatch under
 * a pinned key (an illegal transition), which consumes
 * nothing, so the corrected dispatch under the same
 * key then succeeds, and a final dispatch with no key
 * at all appends normally — the retry-safety valve a
 * reader has only seen asserted by the idempotency
 * key tests so far —
 * and finally a keyed audit hash chain segment:
 * a dedicated task constructed with a pinned
 * `auditSecret` is driven under fixed timestamps, so
 * every audit link is HMAC-SHA256 keyed by that secret
 * instead of plain SHA-256; `verifyHistoryChain` with
 * the correct secret verifies it, with a wrong secret
 * it returns `false`, a detached copy whose middle
 * entry gains a `payoutAmount` it never carried also
 * returns `false` under the correct secret, and the
 * same history verified with no secret at all returns
 * `false` too (fail-closed) — the keyed tamper-evidence
 * mode a reader has only seen on the main task's
 * unkeyed chain and in the keyed hash-chain tests and
 * benchmark so far. The secrets themselves are never
 * printed —
 * and finally an event-level RBAC segment:
 * a dedicated task constructed with a pinned
 * `rolePolicy` (PUBLISH only by researcher, ACCEPT
 * only by contributor, arbitration only by
 * senior-moderator) is driven under fixed timestamps:
 * a covered event dispatched by an actor outside the
 * allowlist — or with no actor at all — is rejected
 * with the pinned `actor not authorized for …` error
 * and leaves state and history untouched, an actor
 * inside the allowlist advances the task, events the
 * policy does not cover are unrestricted (no actor
 * needed), and a second dedicated task constructed
 * without any policy arbitrates with no actor at
 * all — the event-level authorization gate a reader
 * has only seen asserted by the RBAC tests so far.
 * Honest limit, printed in the segment itself: an
 * allowlist is an authorization check on the actor
 * name, not identity authentication —
 * and finally a preseeded idempotency keys segment:
 * a dedicated task constructed with a pinned
 * `idempotencyKeys` seed (one entry duplicated) starts
 * with those dispatch keys already consumed — the
 * re-attachment path for `fromHistory()`, whose audit
 * log cannot carry the key set: the duplicate seed is
 * deduped in order in the snapshot, a dispatch under a
 * seeded key is a complete no-op even for an event that
 * is illegal from the current state (no transition
 * validation, no history append, no listener
 * notification), the same event under a fresh key
 * advances once its turn comes and consumes that key,
 * an empty-string seed throws the pinned
 * `invalid option: idempotencyKeys …` error at
 * construction, and a second dedicated task constructed
 * without any seed dispatches keylessly exactly as
 * before — the exactly-once recovery path a reader has
 * only seen asserted by the idempotency key snapshot
 * tests so far.
 * and finally a payout webhook timeout segment:
 * the main task's signed webhook is delivered with
 * `deliverPayoutWebhook` under a pinned per-attempt
 * `timeoutMs` in three forms — a hanging injected
 * fetch that only settles when its abort signal
 * fires is cut off at the pinned 50 ms and the
 * timeout is reported (never thrown) as the pinned
 * `{ ok: false, attempts: 1, error: "webhook delivery timed out after 50ms" }`
 * under `maxAttempts: 1`, so exactly one fetch is
 * made; an invalid `timeoutMs` of 0 throws the
 * pinned `cannot deliver payout webhook: …`
 * configuration error before any request, so zero
 * fetches are made; and the same endpoint under a
 * loose 5000 ms timeout answers 200 at once and
 * reports the unchanged success shape — the
 * per-attempt deadline a reader has only seen
 * asserted by the payout webhook delivery tests so
 * far. Honest limit: the 50 ms wait is the behaviour
 * under test itself, at its pinned short length —
 * the segment asserts the reported result and the
 * fetch counts, never an elapsed wall-clock
 * duration.
 * and finally a payout webhook fan-out timeout
 * override segment: the main task's payout event is
 * fanned out with `deliverPayoutWebhookToMany` in
 * three pinned forms over the same three fixed
 * endpoints (one shared fixed `now` / `eventId`, each
 * endpoint signed with its own demo secret, all
 * delivery through injected fetches — zero real
 * network, zero randomness) — under a loose
 * call-level `timeoutMs` of 5000, the slow endpoint's
 * per-endpoint override of 50 (with its own hanging
 * injected fetch) cuts every one of its attempts off
 * at 50 ms and its result is exactly the pinned
 * timed-out failure shape after 3 attempts, while the
 * two endpoints without an override still succeed and
 * the results stay in input order; an invalid
 * per-endpoint override of 0 lands as exactly
 * `{ ok: false, attempts: 0, error: <the pinned
 * configuration text> }` for that endpoint alone —
 * reported, never thrown, and no fetch is made to it —
 * while the other endpoints are unchanged; and a
 * fan-out with no per-endpoint override anywhere
 * behaves exactly as the fan-out segment above did.
 * Honest limit, as in the timeout segment: the 50 ms
 * waits are the behaviour under test itself, at their
 * length — the segment asserts the
 * reported results and the fetch counts, never an
 * elapsed wall-clock duration.
 * and finally a dispatch `expectedSeq` optimistic
 * concurrency segment: five dedicated tasks under
 * fixed timestamps (zero network, zero randomness)
 * act out the `dispatch(event, { expectedSeq })`
 * guard a reader has only seen asserted by the
 * expectedSeq tests and timed by the benchmark —
 * DEMO-033 is driven to a pinned 2-entry ACCEPTED
 * history and advances exactly one step under
 * `START_CAPTURE` with `expectedSeq: 2`, its last
 * entry hand-pinned (seq 3, START_CAPTURE,
 * ACCEPTED -> CAPTURING, the pinned instant and
 * actor); DEMO-034 at the same pinned history
 * rejects the same dispatch with a stale
 * `expectedSeq: 1` with the pinned
 * `dispatch conflict: expected seq 1 but task is at seq 2`
 * error and its state and history are byte-identical
 * afterwards (through the canonical NDJSON
 * serializer); a fresh DEMO-035 advances under
 * `expectedSeq: 0`, the guard for an empty history;
 * a DEMO-036 probe rejects `-1` and `1.5` with their
 * pinned `invalid dispatch options: …` configuration
 * errors and appends nothing; and DEMO-037, at the
 * same pinned history, advances under a dispatch
 * with no `expectedSeq` at all, exactly as before
 * the guard existed. Honest limit, as in the
 * DispatchOptions docs: this is a single-process
 * optimistic lock against the in-memory history —
 * cross-process writers still need compare-and-swap
 * in the durable store itself.
 * and finally a stale patrol segment: five further
 * tasks screened by `staleTasks()` alone at the
 * stale branches' fixed `now` under a patrol budget
 * map (the parameter the library calls
 * `maxAgeByState`: DRAFT / OPEN / PAID at 7 days
 * each, IN_REVIEW deliberately absent) — exactly
 * one task is stale; the other four are each
 * excluded for a different pinned reason (exactly
 * at the budget, terminal, no history, unmapped
 * state) — with a notify-only disposition through
 * `actOnStaleTasks()` that dispatches nothing, and
 * a fail-fast check pinning the exact configuration
 * error an unknown state name in the map throws.
 *
 * Usage: `npm run demo` (builds with tsc, then runs node on the compiled
 * output). Zero runtime dependencies: this file only imports the state
 * machine itself.
 *
 * The script is structured as an importable `runDemo()` (the same
 * shape as the sibling demos in rfc9421-signing-demo and
 * escrow-state-machine-ts): it returns all nine tasks, the screening
 * results, the built webhook and its verification outcome, the
 * multi-endpoint fan-out delivery result and the wire copies the
 * injected fake fetch received, the Retry-After parsing results
 * for the fixed corpus under the fan-out instant, the
 * NDJSON export of the main task's history and the task replayed
 * from it, the allowed-events listing for all 13 states with the
 * main task's own (empty) allowed set, the standalone-parsed
 * external history entries with their main-prefix match verdict
 * and the invalid copy's rejection message, the transition-table
 * JSON export text with its parsed-back edges, the generated
 * state diagram text with its edge-line count, the README
 * diagram sync check verdict, the main task's JSON snapshot text
 * with its serialized byte length, the task restored from that
 * snapshot, and its history-derived used RESUBMIT count, the
 * single-task payout reconciliation detail for the mismatched
 * task and the exactly-settled task's undefined detail, the
 * snapshot version carried on the main snapshot with the
 * future-version rejection error and the state the original
 * snapshot restores to afterwards, the note-length-limit
 * task with its limit, boundary and over-limit note
 * lengths, rejection error, and post-rejection state and
 * history length, the standalone overdue judgement
 * segment's three tasks with its hand-pinned deadline and
 * its five verdicts (before / at / after the deadline, no
 * deadline, and terminal), the terminal-state judgement
 * segment's per-state verdicts with the terminal set and
 * the transition table's no-outgoing-edge set it is
 * cross-checked against, the SLA deadline clearing
 * segment's dedicated task with its hand-pinned deadlines
 * and its before / after overdue verdicts and read-backs,
 * the single-target delivery segment's endpoint, result,
 * captured wire calls and wire-body verification verdict,
 * the subscribe onError segment's dedicated task with its
 * collected error reports and its throwing-onError probe
 * task, the payout dedupe snapshot persistence segment's
 * source and restored dedupes with their first-sight /
 * duplicate outcomes, the exported snapshot, the restored
 * store's zeroed stats, its still-duplicate and unseen
 * verdicts, and the tampered copy's rejection error,
 * the payout dedupe stats observability segment's dedupe
 * with its pinned-script outcomes, its per-step stats
 * snapshots (the initial reading plus one after each
 * scripted call), and the stats read back after a detached
 * copy is mutated, the payout dedupe clear reset segment's
 * dedupe with its pinned outcomes (new / duplicate / new
 * again after the clear), its stats before the clear, its
 * all-zero size and stats right after the clear, and its
 * stats after the same id is re-recorded, the payout
 * webhook 429 Retry-After delivery segment's endpoint,
 * result, captured wire calls, recorded sleep delays,
 * and wire-body verification verdict, the payout
 * webhook secret rotation segment's two fixed webhooks,
 * its rotation-window and fail-closed edge verdicts, and
 * its mutual-exclusion configuration error, the payout
 * webhook AbortSignal segment's endpoint, its pre-aborted
 * result with its zero fetch-call count, and its
 * backoff-abort result with its fetch-call count and the
 * recorded sleep delays it entered, the payout webhook
 * freshness window segment's fixed notification, its
 * pinned `maxAgeMs` / `maxFutureSkewMs` windows, and its
 * four verdicts (inside the window, at the boundary,
 * past the window, and beyond the future-skew bound)
 * with the stale notification's signature-only verdict,
 * the payout reference enforcement segment's enforced
 * task with its rejection error and its post-rejection
 * state and history length, its pinned accepted
 * `payoutRef`, and its default (unenforced) task,
 * the dispatch idempotency key segment's main task with
 * its pinned publish key, its duplicate return and
 * post-duplicate history length, its notified event
 * list, its cross-event and stale retry returns and
 * its post-retry history length, and its retry task
 * with its failed-dispatch error and its pinned
 * retry key, the keyed audit hash chain segment's
 * dedicated task with its four verdicts (correct
 * secret, wrong secret, tampered copy under the
 * correct secret, and no secret), the event-level
 * RBAC segment's pinned policy with its policy task,
 * its publish and arbitration rejection errors with
 * their post-rejection states and history lengths,
 * and its policy-free default task,
 * the preseeded idempotency keys segment's seeded task
 * with its pinned seed keys, its deduped snapshot key
 * list, its seeded-key no-op return with its
 * post-no-op state, history length and notification
 * count, its notified event list, its post-fresh-key
 * snapshot key list, its empty-seed construction
 * error, and its seed-free default task with its
 * (absent) snapshot key list,
 * plus the exact `lines` the CLI prints — so tests assert on structured values
 * in-process instead of only regex-matching a child process's stdout.
 * The CLI entry point at the bottom prints those lines unchanged:
 * `npm run demo` output is line-for-line what the pre-refactor
 * top-level script printed (the golden comparison lives in
 * `test/demo.test.ts`, normalizing only the values that already
 * varied between any two runs of the old script — the main task's
 * wall-clock history timestamps and the webhook's `at` / `eventId` /
 * signature, which derive from them and from a random UUID).
 */

import { fileURLToPath } from "node:url";
import {
  PayoutEventDedupe,
  TaskLifecycle,
  actOnStaleTasks,
  allowedEvents,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  deliverPayoutWebhook,
  deliverPayoutWebhookToMany,
  expireOverdueTasks,
  expiredTasks,
  GENESIS_PREV_HASH,
  historyFromNdjson,
  historyToNdjson,
  isOverdue,
  isTerminal,
  MAX_NOTE_LENGTH,
  mismatchedPayouts,
  parseHistory,
  parsePayoutRetryAfter,
  payoutMismatch,
  replay,
  SNAPSHOT_VERSION,
  staleTasks,
  stateDiagram,
  tasksApproachingDeadline,
  totalPaidOut,
  transitionTable,
  transitionTableJson,
  unreconciledPayouts,
  verifyHistoryChain,
  verifyPayoutWebhook,
  type BuildPayoutWebhooksResult,
  type DeliverPayoutWebhookToManyResult,
  type DeliverWebhookResult,
  type ExpireOverdueResult,
  type PayoutEventDedupeSnapshot,
  type PayoutEventDedupeStats,
  type PayoutMismatch,
  type PayoutWebhook,
  type PayoutWebhookFetchImpl,
  type RolePolicy,
  type StaleActionResult,
  type TaskEvent,
  type TaskHistoryEntry,
  type TaskState,
  type TransitionEdge,
} from "./index.js";
import { readmeDiagramInSync } from "./diagram.js";

/**
 * Signing secret for the demo webhook only — a placeholder printed in
 * the source, NOT a real credential. A real deployment loads its
 * secret from its own credential store and never commits it.
 */
export const DEMO_WEBHOOK_SECRET = "demo-secret-do-not-use-in-production";

/**
 * Signing secrets for the demo's closing secret-rotation segment
 * only — placeholders printed in the source, NOT real credentials.
 * A real deployment loads its secrets from its own credential
 * store and never commits them.
 */
export const DEMO_ROTATION_NEW_SECRET = "demo-payout-webhook-secret-new";
export const DEMO_ROTATION_OLD_SECRET = "demo-payout-webhook-secret-old";

/**
 * Audit secrets for the demo's closing keyed hash-chain segment
 * only — placeholders printed in the source, NOT real credentials.
 * A real deployment loads its audit secret from its own credential
 * store and never commits it.
 */
export const DEMO_AUDIT_SECRET = "demo-audit-secret";
export const DEMO_AUDIT_WRONG_SECRET = "demo-audit-secret-wrong";

/**
 * Event-level RBAC policy for the demo's closing rolePolicy
 * segment only — pinned actor names, not credentials. A real
 * deployment authenticates its actors itself; the policy is
 * only an authorization check on the actor name a dispatch
 * carries.
 */
export const DEMO_ROLE_POLICY: RolePolicy = {
  PUBLISH: ["researcher"],
  ACCEPT: ["contributor"],
  ARBITRATE_APPROVE: ["senior-moderator"],
  ARBITRATE_REJECT: ["senior-moderator"],
};

/**
 * Already-consumed dispatch idempotency keys for the demo's
 * closing preseeded-keys segment only — pinned key names, not
 * credentials. The segment seeds its task with this list plus
 * one duplicate of the first entry; the snapshot must carry
 * exactly this deduped list, in this order.
 */
export const DEMO_SEEDED_IDEMPOTENCY_KEYS: string[] = [
  "demo-seed-publish",
  "demo-seed-accept",
];

/**
 * Stale-patrol fixtures for the demo's closing patrol segment
 * (backlog #510): five further tasks screened by `staleTasks` alone
 * on the SAME fixed `now` as the stale branches above
 * (2026-03-22T09:00:00.000Z) under a patrol budget map that
 * deliberately covers three states — DRAFT, OPEN and PAID, each
 * 7 days — while IN_REVIEW carries no budget at all. The map is
 * the `maxAgeByState` parameter of `staleTasks` /
 * `actOnStaleTasks`; the earlier stale branches pass their own
 * maps under local names, so the parameter name itself never
 * appeared in this demo before this segment. Hand-computed
 * expectations (dwell is `now` minus the last history entry's
 * `at`; stale only when STRICTLY past the budget):
 * - DEMO-038 (stale): OPEN at 2026-03-01T09:00 — dwell 21 days
 *   > the 7-day OPEN budget, so it is the ONLY selection.
 * - DEMO-039 (exactly at budget): OPEN at 2026-03-15T09:00 —
 *   dwell exactly 7 days; exactly at the budget is NOT stale.
 * - DEMO-040 (terminal): PAID, last entry at 2026-02-28T09:00 —
 *   dwell 22 days and PAID even carries a patrol budget, but
 *   terminal states are never stale.
 * - DEMO-041 (no history): a fresh DRAFT task that was never
 *   dispatched — DRAFT carries a patrol budget, but with no
 *   history there is no measurable dwell, so it is never stale.
 * - DEMO-042 (unmapped state): IN_REVIEW, last entry at
 *   2026-02-15T09:00 — dwell 35 days, but IN_REVIEW is absent
 *   from the patrol map (no budget = no staleness), so it is
 *   never stale.
 * The patrol disposition is a notify-only action through
 * `actOnStaleTasks` (recording the notified ids, dispatching
 * nothing), so every patrol task keeps its state and history.
 * A separate fail-fast check calls `staleTasks` with an unknown
 * state name in the map and pins the exact configuration error.
 */
export const DEMO_PATROL_NOW = "2026-03-22T09:00:00.000Z";
export const DEMO_PATROL_DAY_MS = 86_400_000;
export const DEMO_PATROL_MAX_AGE_MS = 7 * DEMO_PATROL_DAY_MS;
export const DEMO_PATROL_STALE_TASK_ID = "DEMO-038";
export const DEMO_PATROL_STALE_PUBLISH_AT = "2026-03-01T09:00:00.000Z";
export const DEMO_PATROL_EXACT_TASK_ID = "DEMO-039";
export const DEMO_PATROL_EXACT_PUBLISH_AT = "2026-03-15T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_TASK_ID = "DEMO-040";
export const DEMO_PATROL_TERMINAL_PUBLISH_AT = "2026-02-20T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_ACCEPT_AT = "2026-02-21T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_CAPTURE_AT = "2026-02-22T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_SUBMIT_AT = "2026-02-24T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_REVIEW_AT = "2026-02-25T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_APPROVE_AT = "2026-02-26T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_REQUEST_AT = "2026-02-27T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_COMPLETE_AT = "2026-02-28T09:00:00.000Z";
export const DEMO_PATROL_NO_HISTORY_TASK_ID = "DEMO-041";
export const DEMO_PATROL_UNMAPPED_TASK_ID = "DEMO-042";
export const DEMO_PATROL_UNMAPPED_PUBLISH_AT = "2026-02-10T09:00:00.000Z";
export const DEMO_PATROL_UNMAPPED_ACCEPT_AT = "2026-02-11T09:00:00.000Z";
export const DEMO_PATROL_UNMAPPED_CAPTURE_AT = "2026-02-12T09:00:00.000Z";
export const DEMO_PATROL_UNMAPPED_SUBMIT_AT = "2026-02-14T09:00:00.000Z";
export const DEMO_PATROL_UNMAPPED_REVIEW_AT = "2026-02-15T09:00:00.000Z";
export const DEMO_PATROL_STALE_CONFIG_ERROR =
  'invalid maxAgeByState: unknown state "BOGUS"';

/**
 * Exact constructor id rejection wording the constructor guard segment pins.
 * Must stay verbatim-equal to the `assert.match` in test/constructorId.test.ts
 * and the `throw` in the TaskLifecycle constructor (src/taskLifecycle.ts).
 */
export const DEMO_CONSTRUCTOR_ID_ERROR =
  "invalid task: id must be a non-empty string";

/** Task id the constructor guard segment uses for the legal construction. */
export const DEMO_GUARD_TASK_ID = "DEMO-044";

/**
 * Task id the history immutability segment uses for its tamper probes.
 * Next free DEMO number after the constructor-guard task.
 */
export const DEMO_HISTORY_TASK_ID = "DEMO-045";

/**
 * Fixed base instant the history immutability segment dispatches under.
 * PUBLISH / ACCEPT / START_CAPTURE land at base, base + 1s, base + 2s,
 * so the segment's printed lines never need timestamp normalization
 * and double runs are byte-identical.
 */
export const DEMO_HISTORY_BASE_AT = "2026-03-23T10:00:00.000Z";

const steps: Array<{
  event: TaskEvent;
  actor: string;
  note: string;
  payoutRef?: string;
  payoutAmount?: number;
}> = [
  { event: "PUBLISH", actor: "system", note: "Researcher publishes the data-collection task" },
  { event: "ACCEPT", actor: "contributor", note: "Contributor picks up the task" },
  { event: "START_CAPTURE", actor: "contributor", note: "Data capture begins" },
  { event: "SUBMIT", actor: "contributor", note: "Batch uploaded for QA" },
  { event: "BEGIN_REVIEW", actor: "reviewer", note: "QA specialist starts review" },
  { event: "REJECT", actor: "reviewer", note: "Sample fails QA: gaps in the capture" },
  {
    event: "RESUBMIT",
    actor: "contributor",
    note: "Contributor fixes the batch and resubmits (uses 1 of the demo's 2 allowed RESUBMITs)",
  },
  { event: "SUBMIT", actor: "contributor", note: "Revised batch uploaded for QA" },
  { event: "BEGIN_REVIEW", actor: "reviewer", note: "QA specialist re-reviews the revised batch" },
  { event: "APPROVE", actor: "reviewer", note: "Revised sample passes QA" },
  { event: "REQUEST_PAYOUT", actor: "contributor", note: "Contributor requests payout" },
  {
    event: "PAYOUT_COMPLETE",
    actor: "system",
    note: "Finance settles the payout",
    // Settlement evidence carried on the audit entry (same fixture
    // values the webhook tests use): the payout webhook payload below
    // derives payoutRef/payoutAmount from exactly this entry.
    payoutRef: "xfer-88f2",
    payoutAmount: 10098.5,
  },
];

/** One wire call recorded by the demo fan-out segment's fake fetch. */
export interface FanoutCall {
  url: string;
  body: string;
  signature: string;
}

/** One listener error routed to the demo's collecting `onError` hook. */
export interface ListenerErrorReport {
  message: string;
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
}

/** One notification collected by the demo's subscription listener. */
export interface SubscriptionNotification {
  event: TaskEvent;
  from: TaskState;
  to: TaskState;
  seq: number;
}

/** Pinned verdicts of the history-getter immutability segment (DEMO-045). */
export interface HistoryImmutabilityChecks {
  /** Error name the snapshot `push` probe threw ("TypeError"). */
  pushError: string;
  /** Error name the snapshot `splice` probe threw ("TypeError"). */
  spliceError: string;
  /** Error name the snapshot entry-field-write probe threw ("TypeError"). */
  entryWriteError: string;
  /** Internal history length after all three probes (2, unchanged). */
  internalLengthAfterProbes: number;
  /** Whether the two getter snapshots are deep-equal but reference-independent. */
  snapshotsDeepEqualButIndependent: boolean;
  /** Entries in the snapshot taken before the later dispatch (2, detached). */
  detachedSnapshotLengthAfterDispatch: number;
  /** Entries in the live history after the later dispatch (3). */
  liveLengthAfterDispatch: number;
}

export interface DemoResult {
  task: TaskLifecycle;
  /** `verifyHistoryChain` verdict on the main task's intact history. */
  historyChainVerified: boolean;
  /** `verifyHistoryChain` verdict on the detached tampered copy. */
  tamperedChainVerified: boolean;
  /** The tampered copy's altered PAYOUT_COMPLETE `payoutAmount`. */
  tamperedPayoutAmount: number;
  overdueTask: TaskLifecycle;
  overdueFound: TaskLifecycle[];
  disputeTask: TaskLifecycle;
  webhook: PayoutWebhook;
  webhookVerified: boolean;
  dedupeFirst: boolean;
  dedupeRedelivery: boolean;
  dedupeAfterTtl: boolean;
  batchResults: BuildPayoutWebhooksResult[];
  batchVerified: Array<boolean | undefined>;
  fanoutResult: DeliverPayoutWebhookToManyResult;
  fanoutCalls: FanoutCall[];
  /** Fixed endpoint of the closing single-target delivery segment. */
  singleDeliveryEndpoint: string;
  /** `deliverPayoutWebhook` result for the closing segment. */
  singleDeliveryResult: DeliverWebhookResult;
  /** Wire calls the closing segment's fake fetch received (2). */
  singleDeliveryCalls: FanoutCall[];
  /** Whether the captured wire body verifies under the demo secret. */
  singleDeliveryBodyVerifies: boolean;
  /** Dedicated task for the closing subscribe onError segment (DEMO-022). */
  onErrorTask: TaskLifecycle;
  /** Errors the closing segment's collecting `onError` hook received. */
  onErrorReports: ListenerErrorReport[];
  /** Probe task whose own `onError` hook throws (DEMO-023). */
  onErrorProbeTask: TaskLifecycle;
  /** Source dedupe for the closing snapshot persistence segment. */
  dedupeSnapshotSource: PayoutEventDedupe;
  /** First-sight `checkAndRecord` outcomes for the segment's two ids. */
  dedupeSnapshotFirst: boolean[];
  /** Immediate-redelivery outcomes for the same two ids. */
  dedupeSnapshotDuplicate: boolean[];
  /** Snapshot exported by the source dedupe ({ v: 1, entries }). */
  dedupeSnapshot: PayoutEventDedupeSnapshot;
  /** Dedupe restored from the snapshot after a JSON round-trip. */
  dedupeSnapshotRestored: PayoutEventDedupe;
  /** Restored store's stats read before any probe (counters at zero). */
  dedupeSnapshotStatsAfterRestore: PayoutEventDedupeStats;
  /** Restored store's outcomes for the two recorded ids (duplicates). */
  dedupeSnapshotRestoredSeen: boolean[];
  /** Restored store's outcome for a never-recorded id (new). */
  dedupeSnapshotRestoredUnseen: boolean;
  /** Rejection for the detached `v: 2` copy ("" if it was accepted). */
  dedupeSnapshotTamperedError: string;
  /** Dedupe for the closing stats observability segment. */
  dedupeStatsDedupe: PayoutEventDedupe;
  /** `checkAndRecord` outcomes for the segment's pinned script. */
  dedupeStatsOutcomes: boolean[];
  /** `stats()` after the initial read and each scripted call (6). */
  dedupeStatsSnapshots: PayoutEventDedupeStats[];
  /** Stats read back after a detached copy was mutated (unchanged). */
  dedupeStatsAfterMutation: PayoutEventDedupeStats;
  /** Dedupe for the closing clear reset segment. */
  dedupeClearDedupe: PayoutEventDedupe;
  /** The segment's single pinned `eventId`. */
  dedupeClearEventId: string;
  /** Outcomes: first sight, redelivery, same id after `clear()` (3). */
  dedupeClearOutcomes: boolean[];
  /** Stats pinned before the clear ({ size: 1, hits: 1, misses: 1, evictions: 0 }). */
  dedupeClearStatsBefore: PayoutEventDedupeStats;
  /** Stats right after `clear()` — every counter back at zero. */
  dedupeClearStatsAfterClear: PayoutEventDedupeStats;
  /** Stats after the cleared id is recorded again as a new event. */
  dedupeClearStatsAfterReRecord: PayoutEventDedupeStats;
  /** Fixed endpoint of the closing 429 Retry-After delivery segment. */
  retryAfterDeliveryEndpoint: string;
  /** `deliverPayoutWebhook` result for the 429 Retry-After segment. */
  retryAfterDeliveryResult: DeliverWebhookResult;
  /** Wire calls the segment's fake fetch received (2). */
  retryAfterDeliveryCalls: FanoutCall[];
  /** Delays the segment's recording sleep received ([5000]). */
  retryAfterDeliverySleeps: number[];
  /** Whether the captured wire body verifies under the demo secret. */
  retryAfterDeliveryBodyVerifies: boolean;
  /** New-secret webhook of the closing secret rotation segment. */
  rotationNewWebhook: PayoutWebhook;
  /** Old-secret webhook of the closing secret rotation segment. */
  rotationOldWebhook: PayoutWebhook;
  /** New-signed verdict under `{ secrets: [new, old] }` (true). */
  rotationNewUnderRotation: boolean;
  /** Old-signed verdict under `{ secrets: [new, old] }` (true). */
  rotationOldUnderRotation: boolean;
  /** New-signed verdict under the old secret alone (false). */
  rotationNewUnderOldOnly: boolean;
  /** New-/old-signed verdicts under an unrelated list ([false, false]). */
  rotationUnderUnrelatedList: boolean[];
  /** Error from passing positional secret + `secrets` ("" if none). */
  rotationBothError: string;
  /** Fixed endpoint of the closing AbortSignal delivery segment. */
  abortDeliveryEndpoint: string;
  /** `deliverPayoutWebhook` result for the pre-aborted form. */
  abortPreResult: DeliverWebhookResult;
  /** Fetch calls the pre-aborted form made (0). */
  abortPreFetchCalls: number;
  /** `deliverPayoutWebhook` result for the backoff-abort form. */
  abortWaitResult: DeliverWebhookResult;
  /** Fetch calls the backoff-abort form made (1). */
  abortWaitFetchCalls: number;
  /** Delays the backoff-abort form's hanging sleep entered ([30000]). */
  abortWaitSleeps: number[];
  /** Fixed notification of the closing freshness window segment. */
  freshnessWebhook: PayoutWebhook;
  /** The segment's pinned `maxAgeMs` window (3600000). */
  freshnessMaxAgeMs: number;
  /** The segment's pinned `maxFutureSkewMs` bound (3600000). */
  freshnessMaxFutureSkewMs: number;
  /** Verdict 30 minutes after signing, inside the window (true). */
  freshnessWithinWindow: boolean;
  /** Verdict exactly `maxAgeMs` after signing (true, inclusive). */
  freshnessAtBoundary: boolean;
  /** Verdict 2 hours after signing, past the window (false). */
  freshnessBeyondWindow: boolean;
  /** The stale verdict's signature-only counterpart (true). */
  freshnessBeyondWindowSignatureOnly: boolean;
  /** Verdict when the payload lies 2 hours ahead of the receiver (false). */
  freshnessFutureBeyondSkew: boolean;
  /** Enforced task of the closing requirePayoutRef segment (DEMO-024). */
  requirePayoutRefTask: TaskLifecycle;
  /** Error from DEMO-024's ref-less PAYOUT_COMPLETE ("" if accepted). */
  requirePayoutRefError: string;
  /** DEMO-024's state right after the rejection (PAYOUT_PENDING). */
  requirePayoutRefStateAfterReject: TaskState;
  /** DEMO-024's history length right after the rejection (7). */
  requirePayoutRefHistoryLengthAfterReject: number;
  /** Pinned `payoutRef` DEMO-024 then settled under (xfer-demo-require-ref). */
  requirePayoutRefPayoutRef: string;
  /** Default task of the closing requirePayoutRef segment (DEMO-025). */
  requirePayoutRefDefaultTask: TaskLifecycle;
  /** Main task of the closing dispatch idempotency segment (DEMO-026). */
  idempotencyTask: TaskLifecycle;
  /** Pinned key DEMO-026's PUBLISH consumes ("demo-idem-publish"). */
  idempotencyPublishKey: string;
  /** Return of DEMO-026's same-key duplicate PUBLISH (OPEN). */
  idempotencyDuplicateReturn: TaskState;
  /** DEMO-026's history length right after the duplicate (1). */
  idempotencyHistoryLengthAfterDuplicate: number;
  /** Events DEMO-026's listener was notified of ([PUBLISH, ACCEPT]). */
  idempotencyNotificationEvents: TaskEvent[];
  /** Return of the cross-event retry under the old key (ACCEPTED). */
  idempotencyCrossEventReturn: TaskState;
  /** Return of the stale-event retry under the old key (ACCEPTED). */
  idempotencyStaleReturn: TaskState;
  /** DEMO-026's history length after both old-key retries (2). */
  idempotencyHistoryLengthAfterRetries: number;
  /** Retry task of the closing dispatch idempotency segment (DEMO-027). */
  idempotencyRetryTask: TaskLifecycle;
  /** Error from DEMO-027's failed first dispatch ("" if it succeeded). */
  idempotencyFailedError: string;
  /** Pinned key DEMO-027 fails under, then succeeds under. */
  idempotencyRetryKey: string;
  /** Keyed task of the closing auditSecret segment (DEMO-028). */
  auditSecretTask: TaskLifecycle;
  /** Correct-secret verdict on DEMO-028's keyed history (true). */
  auditSecretVerified: boolean;
  /** Wrong-secret verdict on DEMO-028's keyed history (false). */
  auditSecretWrongVerified: boolean;
  /** Correct-secret verdict on the tampered copy (false). */
  auditSecretTamperedVerified: boolean;
  /** No-secret verdict on DEMO-028's keyed history (false). */
  auditSecretUnkeyedVerified: boolean;
  /** Policy task of the closing rolePolicy segment (DEMO-029). */
  rolePolicyTask: TaskLifecycle;
  /** The segment's pinned policy (DEMO_ROLE_POLICY). */
  rolePolicy: RolePolicy;
  /** Error from DEMO-029's PUBLISH by contributor ("" if accepted). */
  rolePolicyPublishUnauthorizedError: string;
  /** Error from DEMO-029's actor-less PUBLISH ("" if accepted). */
  rolePolicyPublishMissingActorError: string;
  /** DEMO-029's state after both PUBLISH rejections (DRAFT). */
  rolePolicyStateAfterPublishRejects: TaskState;
  /** DEMO-029's history length after both PUBLISH rejections (0). */
  rolePolicyHistoryLengthAfterPublishRejects: number;
  /** Error from DEMO-029's ARBITRATE_APPROVE by contributor. */
  rolePolicyArbitrateUnauthorizedError: string;
  /** Error from DEMO-029's actor-less ARBITRATE_APPROVE. */
  rolePolicyArbitrateMissingActorError: string;
  /** DEMO-029's state after both arbitration rejections (DISPUTED). */
  rolePolicyStateAfterArbitrateRejects: TaskState;
  /** DEMO-029's history length after both arbitration rejections (7). */
  rolePolicyHistoryLengthAfterArbitrateRejects: number;
  /** Default task of the closing rolePolicy segment (DEMO-030). */
  rolePolicyDefaultTask: TaskLifecycle;
  /** Seeded task of the closing preseeded idempotency keys segment (DEMO-031). */
  seededIdempotencyTask: TaskLifecycle;
  /** The segment's pinned deduped seed keys (DEMO_SEEDED_IDEMPOTENCY_KEYS). */
  seededIdempotencyKeys: string[];
  /** DEMO-031's snapshot key list right after construction (deduped, in seed order). */
  seededIdempotencySnapshotKeysAfterSeed: string[];
  /** Return of DEMO-031's seeded-key ACCEPT from DRAFT (DRAFT — a no-op). */
  seededIdempotencyNoopReturn: TaskState;
  /** DEMO-031's state after the seeded-key no-op (DRAFT). */
  seededIdempotencyStateAfterNoop: TaskState;
  /** DEMO-031's history length after the seeded-key no-op (0). */
  seededIdempotencyHistoryLengthAfterNoop: number;
  /** Listener notifications DEMO-031 had after the seeded-key no-op (0). */
  seededIdempotencyNotificationCountAfterNoop: number;
  /** Events DEMO-031's listener was notified of ([PUBLISH, ACCEPT]). */
  seededIdempotencyNotificationEvents: TaskEvent[];
  /** DEMO-031's snapshot key list after both fresh-key dispatches (seed keys, then fresh keys). */
  seededIdempotencySnapshotKeysAfterFreshKeys: string[];
  /** Error from constructing a task with an empty-string seed ("" if accepted). */
  seededIdempotencyEmptySeedError: string;
  /** Default task of the closing preseeded idempotency keys segment (DEMO-032). */
  seededIdempotencyDefaultTask: TaskLifecycle;
  /** DEMO-032's snapshot key list — undefined (the field is omitted while empty). */
  seededIdempotencyDefaultSnapshotKeys: string[] | undefined;
  /** Fixed endpoint of the closing payout webhook timeout segment. */
  timeoutDeliveryEndpoint: string;
  /** The segment's pinned per-attempt `timeoutMs` (50). */
  timeoutDeliveryTimeoutMs: number;
  /** Reported result of the hanging-fetch delivery (timed out). */
  timeoutDeliveryResult: DeliverWebhookResult;
  /** Fetch calls the hanging-fetch delivery made (1). */
  timeoutDeliveryFetchCalls: number;
  /** Error from the segment's `timeoutMs: 0` call ("" if accepted). */
  timeoutDeliveryInvalidError: string;
  /** Fetch calls the invalid-timeout call made (0). */
  timeoutDeliveryInvalidFetchCalls: number;
  /** Result of the loose-timeout immediate-200 delivery. */
  timeoutDeliveryLooseResult: DeliverWebhookResult;
  /** Fetch calls the loose-timeout delivery made (1). */
  timeoutDeliveryLooseFetchCalls: number;
  /** Call-level `timeoutMs` of the fan-out timeout override segment (5000). */
  fanoutTimeoutCallTimeoutMs: number;
  /** The slow endpoint's pinned per-endpoint `timeoutMs` override (50). */
  fanoutTimeoutOverrideMs: number;
  /** Aggregate result of the override fan-out call (2 delivered, 1 failed). */
  fanoutTimeoutResult: DeliverPayoutWebhookToManyResult;
  /** Fetch calls the hanging per-endpoint fetch made (3 — one per attempt). */
  fanoutTimeoutHangFetchCalls: number;
  /** Call-level fetch calls the override fan-out call made (2 — billing + notifications). */
  fanoutTimeoutFastFetchCalls: number;
  /** Aggregate result of the invalid-override fan-out call (2 delivered, 1 failed). */
  fanoutTimeoutInvalidResult: DeliverPayoutWebhookToManyResult;
  /** Fetch calls made to the invalid-override endpoint in its call (0). */
  fanoutTimeoutInvalidFetchCalls: number;
  /** Aggregate result of the no-override fan-out call (3 delivered, 0 failed). */
  fanoutTimeoutPlainResult: DeliverPayoutWebhookToManyResult;
  /** Guarded task of the closing expectedSeq segment (DEMO-033, CAPTURING, 3 entries). */
  expectedSeqTask: TaskLifecycle;
  /** Return of DEMO-033's guarded START_CAPTURE (CAPTURING). */
  expectedSeqGuardedReturn: TaskState;
  /** Conflict task of the closing expectedSeq segment (DEMO-034). */
  expectedSeqConflictTask: TaskLifecycle;
  /** Error from DEMO-034's stale expectedSeq dispatch ("" if accepted). */
  expectedSeqConflictError: string;
  /** DEMO-034's state after the conflict (ACCEPTED). */
  expectedSeqConflictStateAfter: TaskState;
  /** DEMO-034's history length after the conflict (2). */
  expectedSeqConflictHistoryLengthAfter: number;
  /** Empty-history task of the closing expectedSeq segment (DEMO-035). */
  expectedSeqEmptyTask: TaskLifecycle;
  /** Return of DEMO-035's PUBLISH under expectedSeq 0 (OPEN). */
  expectedSeqEmptyReturn: TaskState;
  /** Probe task of the closing expectedSeq segment (DEMO-036, DRAFT, 0 entries). */
  expectedSeqIllegalTask: TaskLifecycle;
  /** Error from DEMO-036's expectedSeq -1 dispatch ("" if accepted). */
  expectedSeqNegativeError: string;
  /** Error from DEMO-036's expectedSeq 1.5 dispatch ("" if accepted). */
  expectedSeqFractionError: string;
  /** Unguarded task of the closing expectedSeq segment (DEMO-037, CAPTURING, 3 entries). */
  expectedSeqUnguardedTask: TaskLifecycle;
  /** Return of DEMO-037's START_CAPTURE with no expectedSeq (CAPTURING). */
  expectedSeqUnguardedReturn: TaskState;
  /** The closing stale patrol segment's five tasks, in patrol order. */
  patrolTasks: TaskLifecycle[];
  /** `staleTasks` selection over {@link DemoResult.patrolTasks} (only DEMO-038). */
  patrolStaleSelected: TaskLifecycle[];
  /** Per-task outcomes of `actOnStaleTasks` running the notify-only patrol action. */
  patrolStaleActionResults: StaleActionResult[];
  /** Ids the patrol's notify-only action recorded, in action order. */
  patrolStaleNotifiedIds: string[];
  /** Exact error of `staleTasks` called with an unknown state name in the patrol map. */
  patrolStaleConfigError: string;
  /** Rejection verdicts for the constructor guard segment's bad ids (3), in tried order. */
  constructorGuardChecks: Array<{ input: string; error: string }>;
  /** Legal task of the closing constructor guard segment (DEMO-044). */
  constructorGuardTask: TaskLifecycle;
  /** Pinned probe verdicts of the history immutability segment (DEMO-045). */
  historyImmutabilityChecks: HistoryImmutabilityChecks;
  /** `parsePayoutRetryAfter` results for the fixed corpus, in corpus order. */
  retryAfterParsed: Array<number | undefined>;
  unreconciledTask: TaskLifecycle;
  mismatchedTask: TaskLifecycle;
  unreconciledFound: TaskLifecycle[];
  mismatchedFound: TaskLifecycle[];
  totalPaid: number;
  subscriptionTask: TaskLifecycle;
  subscriptionNotifications: SubscriptionNotification[];
  subscriptionMatchesHistory: boolean;
  subscriptionCountAfterUnsubscribe: number;
  /** Dedicated task for the listenerCount lifecycle branch (DEMO-043). */
  listenerCountTask: TaskLifecycle;
  /** Pinned listenerCount readings: [0, 2, 1, 0, 0]. */
  listenerCountTimeline: number[];
  /** Notifications the surviving collector received (exactly one PUBLISH). */
  listenerCountKept: SubscriptionNotification[];
  /** Notifications the unsubscribed collector received (none). */
  listenerCountDropped: SubscriptionNotification[];
  staleDwellTasks: TaskLifecycle[];
  staleFound: TaskLifecycle[];
  staleExpiredFound: TaskLifecycle[];
  /** The approaching-deadline screening branch's four tasks, in screening order. */
  approachingTasks: TaskLifecycle[];
  /** `tasksApproachingDeadline` selection over {@link DemoResult.approachingTasks} (DEMO-046, DEMO-047). */
  approachingFound: TaskLifecycle[];
  /** `expiredTasks` selection over {@link DemoResult.approachingTasks} (DEMO-048, DEMO-049). */
  approachingOverdueFound: TaskLifecycle[];
  staleActionTasks: TaskLifecycle[];
  staleActionResults: StaleActionResult[];
  expireExecutionTasks: TaskLifecycle[];
  expireExecutionFound: TaskLifecycle[];
  expireExecutionResults: ExpireOverdueResult[];
  ndjsonText: string;
  replayedTask: TaskLifecycle;
  /**
   * The terminal state the pure `replay()` function derives from the
   * NDJSON round-tripped history — no instance, no snapshot envelope.
   */
  replayDerivedState: TaskState;
  /** `allowedEvents(state)` for every state, in transition-table order. */
  allowedEventsByState: Array<{ state: TaskState; events: TaskEvent[] }>;
  /** `allowedEvents` for the main task's PAID state — the empty list. */
  mainTaskAllowedEvents: TaskEvent[];
  /** Entries `parseHistory` returns for the fixed external JSON text. */
  parsedHistoryEntries: TaskHistoryEntry[];
  /** Whether the parsed chain equals the main history's first-5 chain. */
  parsedHistoryMatchesMainPrefix: boolean;
  /** Whether the detached chain-broken copy was rejected. */
  parsedHistoryInvalidRejected: boolean;
  /** The rejection message for the invalid copy ("" if it parsed). */
  parsedHistoryInvalidError: string;
  /** Raw `transitionTableJson()` export text (trailing newline included). */
  transitionTableJsonText: string;
  /** Edges parsed back from `transitionTableJsonText`. */
  transitionTableEdges: TransitionEdge[];
  /** Full `stateDiagram()` Mermaid block text (no trailing newline). */
  stateDiagramText: string;
  /** Edge lines inside `stateDiagramText` (the 19 transition edges). */
  stateDiagramEdgeCount: number;
  /** `readmeDiagramInSync()` verdict on this repo's README. */
  readmeDiagramInSync: boolean;
  /** `JSON.stringify(task.toJSON())` text for the main task. */
  snapshotJsonText: string;
  /** UTF-8 byte length of `snapshotJsonText`. */
  snapshotBytes: number;
  /** Main task restored from the snapshot via `TaskLifecycle.fromJSON()`. */
  restoredTask: TaskLifecycle;
  /** RESUBMIT entries in the main task's history (its used budget count). */
  snapshotResubmitUsed: number;
  /** `payoutMismatch()` detail for the mismatched task DEMO-005. */
  payoutMismatchDetail: PayoutMismatch;
  /** `payoutMismatch()` for the exactly-settled task DEMO-004 — undefined. */
  payoutMismatchSettled: PayoutMismatch | undefined;
  /** `v` carried on the main snapshot — equals `SNAPSHOT_VERSION`. */
  snapshotVersion: number;
  /** Error from `fromJSON()` on the detached `v: 2` copy ("" if accepted). */
  snapshotVersionFutureError: string;
  /** State the original snapshot restores to after the rejection. */
  snapshotVersionRestoredState: TaskState;
  /** Dedicated task for the note-length-limit segment (DEMO-017). */
  noteLimitTask: TaskLifecycle;
  /** `MAX_NOTE_LENGTH` — the hand-pinned dispatch note ceiling. */
  noteLengthLimit: number;
  /** Length of the boundary note that was accepted (32768). */
  noteLimitBoundaryLength: number;
  /** Length of the over-limit note that was rejected (32769). */
  noteLimitOverLength: number;
  /** Error from the over-limit dispatch ("" if it was accepted). */
  noteLimitError: string;
  /** State of the note-limit task after the rejection (OPEN). */
  noteLimitStateAfter: TaskState;
  /** History length of the note-limit task after the rejection (1). */
  noteLimitHistoryLengthAfter: number;
  /** Dedicated deadline task for the isOverdue segment (DEMO-018). */
  overdueStandaloneTask: TaskLifecycle;
  /** Dedicated no-deadline task for the isOverdue segment (DEMO-019). */
  overdueStandaloneNoDeadlineTask: TaskLifecycle;
  /** Dedicated terminal task for the isOverdue segment (DEMO-020). */
  overdueStandaloneTerminalTask: TaskLifecycle;
  /** SLA deadline carried by DEMO-018 (and DEMO-020's ABANDONED state). */
  overdueStandaloneDeadline: string;
  /** `isOverdue` verdicts in case order: before, at, after, no-deadline, terminal. */
  overdueStandaloneVerdicts: boolean[];
  /** `isTerminal(state)` for every state, in transition-table order. */
  terminalByState: Array<{ state: TaskState; terminal: boolean }>;
  /** States where `isTerminal(state)` is true, in transition-table order. */
  terminalStates: TaskState[];
  /** States with no outgoing edges in `transitionTable()`, same order. */
  noOutEdgeStates: TaskState[];
  /** Dedicated task for the clearSlaDeadline segment (DEMO-021). */
  slaClearTask: TaskLifecycle;
  /** ACCEPTED-state SLA deadline carried by DEMO-021. */
  slaClearDeadline: string;
  /** CAPTURING / SUBMITTED deadlines carried by DEMO-021, in that order. */
  slaClearOtherDeadlines: string[];
  /** `isOverdue` verdict for DEMO-021 before any clearing (true). */
  slaClearOverdueBefore: boolean;
  /** `isOverdue` verdict after clearing only ACCEPTED (false). */
  slaClearOverdueAfterStateClear: boolean;
  /** ACCEPTED read-back after the per-state clear — undefined. */
  slaClearAcceptedAfterStateClear: string | undefined;
  /** CAPTURING / SUBMITTED read-backs after the per-state clear. */
  slaClearOthersAfterStateClear: Array<string | undefined>;
  /** ACCEPTED / CAPTURING / SUBMITTED read-backs after the no-arg clear. */
  slaClearAfterAllClear: Array<string | undefined>;
  lines: string[];
}

/**
 * Run the demo lifecycle without printing anything, and return the
 * sixteen tasks, the audit hash-chain verification verdicts for
 * the main task's history (intact, and a detached tampered copy),
 * the watchdog screening result, the built + verified
 * payout webhook, the receiver-side dedupe outcomes for its
 * `eventId`, the batch webhook results with their per-item
 * verification outcomes, the fan-out delivery result with the wire
 * calls the injected fake fetch received, the reconciliation
 * screening results with the paid-out total, the subscription branch's collected
 * notifications with their history-match verdict and the
 * post-unsubscribe notification count, the stale-task dwell
 * screening branch's three tasks with its stale and overdue
 * subsets, the stale-task batch execution branch's four tasks
 * with their per-task action results, the SLA watchdog batch
 * execution branch's three rebuilt tasks with its screening
 * subset and per-task expiry results, the NDJSON export of the main task's history
 * and the task replayed from that export, the allowed-events
 * listing for all 13 states with the main task's own (empty)
 * allowed set, the standalone-parsed external history entries
 * with their main-prefix match verdict and the invalid copy's
 * rejection message, the transition-table JSON export text with
 * its parsed-back edges, the generated state diagram text with
 * its edge-line count, the README diagram sync check verdict,
 * the main task's JSON snapshot text with its serialized byte
 * length, the task restored from that snapshot, and its
 * history-derived used RESUBMIT count, the single-task payout
 * reconciliation detail for the mismatched task and the
 * exactly-settled task's undefined detail, the snapshot version
 * carried on the main snapshot with the future-version
 * rejection error and the state the original snapshot restores
 * to afterwards, the payout webhook secret rotation
 * segment's two fixed webhooks with its rotation-window
 * and fail-closed edge verdicts and its mutual-exclusion
 * configuration error, the payout webhook freshness
 * window segment's fixed notification with its pinned
 * windows and its inside / boundary / stale / future-skew
 * verdicts, the payout reference enforcement segment's
 * enforced and default tasks with its rejection error,
 * post-rejection state and history length, and pinned
 * accepted reference, the dispatch idempotency key
 * segment's main and retry tasks with its pinned keys,
 * its duplicate / cross-event / stale retry returns,
 * its post-duplicate and post-retry history lengths,
 * its notified event list, and its failed-dispatch
 * error, the keyed audit hash chain segment's dedicated
 * task with its correct-secret, wrong-secret, tampered
 * and no-secret verdicts, the event-level RBAC segment's
 * pinned policy with its policy and default tasks, its
 * publish and arbitration rejection errors, and its
 * post-rejection states and history lengths, the preseeded
 * idempotency keys segment's seeded and default tasks
 * with its deduped and post-fresh-key snapshot key
 * lists, its seeded-key no-op return and post-no-op
 * state, history length and notification count, its
 * notified event list, and its empty-seed construction
 * error, the payout webhook timeout segment's endpoint
 * with its pinned `timeoutMs`, its timed-out reported
 * result and fetch-call count, its invalid-timeout
 * configuration error and zero fetch-call count, and
 * its loose-timeout success result and fetch-call
 * count, the payout webhook fan-out timeout override
 * segment's call-level and per-endpoint pinned
 * `timeoutMs` values with its override, invalid-override
 * and no-override aggregate results and its hanging,
 * fast and invalid-endpoint fetch-call counts, the
 * dispatch expectedSeq optimistic concurrency
 * segment's guarded, conflict, empty-history,
 * illegal-value and unguarded tasks with its pinned
 * conflict and configuration errors and its
 * post-rejection states and history lengths, and the exact lines
 * `main()` prints — so tests can assert on the demo itself, not
 * just on the library.
 */
export async function runDemo(): Promise<DemoResult> {
  // The demo sets an explicit resubmit budget of 2 so the REJECT ->
  // RESUBMIT loop below shows the budget being consumed (this script
  // uses 1 of the 2). The library default for `maxResubmits` is
  // unlimited — the budget here is a demo policy choice, not a
  // built-in cap, and a third RESUBMIT on this task would throw
  // "resubmit budget exhausted".
  const task = new TaskLifecycle("DEMO-001", { maxResubmits: 2 });
  const lines: string[] = [`Task ${task.id}: ${task.state}`];

  for (const { event, actor, note, payoutRef, payoutAmount } of steps) {
    const from = task.state;
    const to = task.dispatch(event, {
      actor,
      note,
      ...(payoutRef !== undefined ? { payoutRef } : {}),
      ...(payoutAmount !== undefined ? { payoutAmount } : {}),
    });
    lines.push(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
  }

  lines.push("", `Final state: ${task.state} (terminal: ${task.isTerminal})`);
  lines.push("History (append-only audit trail):");
  lines.push("  seq  event            from          -> to             actor        at");
  for (const h of task.history) {
    lines.push(
      `  ${String(h.seq).padStart(3)}  ${h.event.padEnd(16)} ${h.from.padEnd(13)} -> ${h.to.padEnd(13)} ${String(h.actor ?? "-").padEnd(12)} ${h.at}`,
    );
  }

  // Audit hash-chain segment: the history just printed is
  // hash-chained (each entry links to its predecessor's hash,
  // genesis-linked to GENESIS_PREV_HASH), and everything later in
  // this demo — the payout webhook, the replay segment at the
  // end — is derived from it, so the audit workflow verifies the
  // chain before trusting the history ("verify before replay").
  // verifyHistoryChain recomputes every link and returns a plain
  // boolean — true for the intact chain. To show what a rewrite
  // looks like, build a detached copy (fresh entry objects — the
  // task's history getter hands out frozen copies), alter the
  // PAYOUT_COMPLETE entry's payoutAmount by 1, and verify again:
  // the stored hash no longer recomputes from the altered
  // canonical content, so the verdict flips to false. This demo's
  // main task carries an unkeyed chain (no auditSecret), so no
  // secret argument is passed; a keyed chain would need its
  // secret here and would fail closed without it. The task's own
  // history is never touched, and re-verifying it after the
  // tamper check still passes. The segment adds no new
  // nondeterminism: it only reads the main task's existing
  // history and prints no timestamps or hashes.
  const historyChainVerified = verifyHistoryChain(task.history);
  const tamperedHistory = task.history.map((entry) => ({ ...entry }));
  const tamperedEntry = tamperedHistory.find(
    (entry) => entry.event === "PAYOUT_COMPLETE",
  );
  if (tamperedEntry === undefined || tamperedEntry.payoutAmount === undefined) {
    throw new Error("demo fixture broken: main history has no PAYOUT_COMPLETE payoutAmount");
  }
  const originalPayoutAmount = tamperedEntry.payoutAmount;
  tamperedEntry.payoutAmount = originalPayoutAmount + 1;
  const tamperedPayoutAmount = tamperedEntry.payoutAmount;
  const tamperedChainVerified = verifyHistoryChain(tamperedHistory);
  lines.push(
    "",
    "Audit hash chain (verifyHistoryChain on the main task history):",
    `  intact history: verifyHistoryChain: ${historyChainVerified} (${task.history.length} entries, genesis-linked, every hash recomputes)`,
    `  tampered copy: PAYOUT_COMPLETE payoutAmount ${originalPayoutAmount} -> ${tamperedPayoutAmount} — verifyHistoryChain: ${tamperedChainVerified} (tamper detected: the stored hash no longer recomputes)`,
    `  original history after the tamper check: verifyHistoryChain: ${verifyHistoryChain(task.history)} (detached copy — the task's own history is untouched)`,
  );

  // SLA watchdog branch: a second task whose ACCEPTED-state SLA
  // deadline has already passed at the screening instant. The deadline
  // is advisory only — it never moves the task by itself — so the
  // branch first screens the batch with expiredTasks() under a fixed
  // `now`, shows the task is still ACCEPTED, and only then does the
  // watchdog explicitly dispatch EXPIRE, exactly the wiring the README
  // FAQ describes. Every timestamp in this branch is a fixed literal
  // or the injected screening `now`: no wall clock is read here.
  const SLA_BRANCH_NOW = new Date("2026-03-06T09:00:00.000Z");
  const overdueTask = new TaskLifecycle("DEMO-002");
  lines.push("", "SLA watchdog branch (second task, advisory deadline):");
  lines.push(`Task ${overdueTask.id}: ${overdueTask.state}`);
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-03-01T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-03-01T09:05:00.000Z"],
  ] as const) {
    const from = overdueTask.state;
    const to = overdueTask.dispatch(event, { actor, at });
    lines.push(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
  }
  overdueTask.setSlaDeadline("2026-03-03T09:00:00.000Z");
  lines.push(
    `  SLA deadline (ACCEPTED): ${overdueTask.getSlaDeadline("ACCEPTED")}`,
  );
  const overdueFound = expiredTasks([task, overdueTask], SLA_BRANCH_NOW);
  lines.push(
    `  expiredTasks([${task.id}, ${overdueTask.id}], ${SLA_BRANCH_NOW.toISOString()}): ${overdueFound.map((t) => t.id).join(", ")} (${overdueFound.length} overdue)`,
  );
  lines.push(
    `  ${overdueTask.id} still ${overdueTask.state}: the deadline alone never expires a task`,
  );
  for (const found of overdueFound) {
    const from = found.state;
    const to = found.dispatch("EXPIRE", {
      actor: "watchdog",
      at: SLA_BRANCH_NOW.toISOString(),
    });
    lines.push(`  ${"EXPIRE".padEnd(15)} ${from.padEnd(12)} -> ${to}  (watchdog)`);
  }
  lines.push(
    "",
    `Final state (SLA branch): ${overdueTask.state} (terminal: ${overdueTask.isTerminal})`,
  );
  lines.push("History (SLA branch, append-only audit trail):");
  lines.push("  seq  event            from          -> to             actor        at");
  for (const h of overdueTask.history) {
    lines.push(
      `  ${String(h.seq).padStart(3)}  ${h.event.padEnd(16)} ${h.from.padEnd(13)} -> ${h.to.padEnd(13)} ${String(h.actor ?? "-").padEnd(12)} ${h.at}`,
    );
  }

  // DISPUTE appeal branch: a third task that is REJECTED in QA and
  // then appealed instead of resubmitted. The contributor DISPUTEs
  // the rejection (REJECTED -> DISPUTED) and a moderator arbitrates
  // against the appeal (ARBITRATE_REJECT -> REJECTED), so the branch
  // ends back in REJECTED — not a terminal state. The demo sets an
  // explicit dispute budget of 1 so the appeal shows the budget
  // being consumed (this script uses 1 of the 1). The library
  // default for `maxDisputes` is unlimited — the budget here is a
  // demo policy choice, not a built-in cap, and a second DISPUTE on
  // this task would throw "dispute budget exhausted". Every
  // timestamp in this branch is a fixed literal: no wall clock is
  // read here.
  const disputeTask = new TaskLifecycle("DEMO-003", { maxDisputes: 1 });
  lines.push("", "DISPUTE appeal branch (third task, dispute budget):");
  lines.push(`Task ${disputeTask.id}: ${disputeTask.state}`);
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-03-10T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-03-10T09:05:00.000Z"],
    ["START_CAPTURE", "contributor", "2026-03-10T09:10:00.000Z"],
    ["SUBMIT", "contributor", "2026-03-11T09:00:00.000Z"],
    ["BEGIN_REVIEW", "reviewer", "2026-03-11T09:05:00.000Z"],
    ["REJECT", "reviewer", "2026-03-11T09:10:00.000Z"],
    ["DISPUTE", "contributor", "2026-03-11T10:00:00.000Z"],
    ["ARBITRATE_REJECT", "moderator", "2026-03-12T09:00:00.000Z"],
  ] as const) {
    const from = disputeTask.state;
    const to = disputeTask.dispatch(event, { actor, at });
    lines.push(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
  }
  lines.push(
    "  dispute budget: 1 of 1 DISPUTEs used (demo sets maxDisputes: 1; the library default is unlimited)",
  );
  lines.push(
    "",
    `Final state (DISPUTE branch): ${disputeTask.state} (terminal: ${disputeTask.isTerminal})`,
  );
  lines.push("History (DISPUTE branch, append-only audit trail):");
  lines.push("  seq  event            from          -> to             actor        at");
  for (const h of disputeTask.history) {
    lines.push(
      `  ${String(h.seq).padStart(3)}  ${h.event.padEnd(16)} ${h.from.padEnd(13)} -> ${h.to.padEnd(13)} ${String(h.actor ?? "-").padEnd(12)} ${h.at}`,
    );
  }

  // The PAID state is where PAYOUT_COMPLETE settlement webhooks fire:
  // build the signed notification from the audit history, print what a
  // receiver would get, then verify it with the same secret.
  const webhook = buildPayoutWebhook(task, DEMO_WEBHOOK_SECRET);
  const { payload, signature } = webhook;
  lines.push("", "Payout webhook (signed PAYOUT_COMPLETE notification):");
  lines.push(`  event:        ${payload.event}`);
  lines.push(`  taskId:       ${payload.taskId}`);
  lines.push(`  payoutRef:    ${payload.payoutRef}`);
  lines.push(`  payoutAmount: ${payload.payoutAmount}`);
  lines.push(`  at:           ${payload.at}`);
  lines.push(`  eventId:      ${payload.eventId}`);
  lines.push(`  signature:    ${signature}`);
  const webhookVerified = verifyPayoutWebhook(payload, signature, DEMO_WEBHOOK_SECRET);
  lines.push(`  verifyPayoutWebhook: ${webhookVerified ? "ok" : "FAILED"}`);

  // Receiver-side dedupe segment: the other half of the webhook
  // story. Everything above is the sender's view — build, sign,
  // verify. A receiver that stopped at verification would still
  // book the payout twice when the sender (or a fan-out retry)
  // re-delivers the same event, so deduplication on `eventId` is
  // the receiver's own duty (the other half of the at-least-once
  // delivery semantics the README describes). The main webhook's
  // eventId is fed to a PayoutEventDedupe under an injected fixed
  // clock — starting at 2026-03-18T09:00:00.000Z and advanced by
  // hand, so no wall clock is read here:
  //   delivery 1 — first sighting: checkAndRecord returns false,
  //     the receiver books the payout;
  //   delivery 2 — the same eventId again within the TTL:
  //     checkAndRecord returns true (duplicate), the receiver
  //     acknowledges the delivery and skips it, booking nothing
  //     twice;
  //   delivery 3 — the clock is advanced by exactly the TTL
  //     (60_000 ms; the demo shortens the library default of
  //     3_600_000 ms so the expiry act fits the script): at
  //     exactly ttlMs the first-seen record has expired (the
  //     boundary rule in PayoutEventDedupe's docs), so the same
  //     id counts as unseen again and checkAndRecord returns
  //     false — accepted again.
  const DEDUPE_TTL_MS = 60_000;
  let dedupeNowMs = Date.parse("2026-03-18T09:00:00.000Z");
  const dedupe = new PayoutEventDedupe({
    ttlMs: DEDUPE_TTL_MS,
    now: () => dedupeNowMs,
  });
  lines.push("", "Receiver-side dedupe (PayoutEventDedupe on the webhook's eventId):");
  lines.push(
    `  dedupe ttl: ${DEDUPE_TTL_MS} ms (demo policy; the library default is 3600000 ms) — clock injected and fixed at ${new Date(dedupeNowMs).toISOString()}`,
  );
  const dedupeFirst = dedupe.checkAndRecord(payload.eventId);
  lines.push(
    `  delivery 1: eventId ${payload.eventId} -> checkAndRecord ${dedupeFirst} (new event, payout booked)`,
  );
  const dedupeRedelivery = dedupe.checkAndRecord(payload.eventId);
  lines.push(
    `  delivery 2: same eventId redelivered -> checkAndRecord ${dedupeRedelivery} (duplicate, skipped — no second booking)`,
  );
  dedupeNowMs += DEDUPE_TTL_MS;
  const dedupeAfterTtl = dedupe.checkAndRecord(payload.eventId);
  lines.push(
    `  delivery 3: clock advanced by exactly the ttl to ${new Date(dedupeNowMs).toISOString()} -> checkAndRecord ${dedupeAfterTtl} (record expired at the ttl boundary, accepted again)`,
  );

  // Batch payout webhook segment: the settlement-peak pipeline. A
  // single build handles one settled task; at settlement time the
  // norm is a batch — every demo task at once — built with
  // buildPayoutWebhooks under the shared demo secret, one shared
  // fixed `now`, and a deterministic eventId factory, so this whole
  // segment is byte-identical on every run (no network, no
  // randomness, no wall clock). The batch deliberately mixes the
  // PAID main task with the two non-PAID branch tasks: each non-PAID
  // task lands as `{ taskId, error }` only, fails only itself, and
  // never blocks the tasks after it — DEMO-003 is still attempted
  // after DEMO-002 errors. Every built webhook is then verified
  // with the demo secret, exactly as in the single-build section.
  const BATCH_NOW = new Date("2026-03-13T09:00:00.000Z");
  let batchSeq = 0;
  const batchResults = buildPayoutWebhooks(
    [task, overdueTask, disputeTask],
    DEMO_WEBHOOK_SECRET,
    {
      now: BATCH_NOW,
      eventIdFactory: () =>
        `evt_demo_batch_${String(++batchSeq).padStart(3, "0")}`,
    },
  );
  const batchVerified: Array<boolean | undefined> = batchResults.map((r) =>
    r.webhook
      ? verifyPayoutWebhook(r.webhook.payload, r.webhook.signature, DEMO_WEBHOOK_SECRET)
      : undefined,
  );
  lines.push("", "Batch payout webhooks (buildPayoutWebhooks over all three demo tasks):");
  lines.push(
    `  shared now: ${BATCH_NOW.toISOString()} (eventIds from a deterministic factory)`,
  );
  batchResults.forEach((r, i) => {
    if (r.webhook) {
      lines.push(
        `  ${r.taskId}: webhook eventId=${r.webhook.payload.eventId} payoutRef=${r.webhook.payload.payoutRef} payoutAmount=${r.webhook.payload.payoutAmount} verifyPayoutWebhook: ${batchVerified[i] ? "ok" : "FAILED"}`,
      );
    } else {
      lines.push(`  ${r.taskId}: error: ${r.error}`);
    }
  });
  const batchBuilt = batchResults.filter((r) => r.webhook).length;
  lines.push(
    `  batch: ${batchBuilt} webhook(s) built, ${batchResults.length - batchBuilt} error(s) — a non-PAID task fails only itself and never blocks later tasks`,
  );

  // Multi-endpoint fan-out delivery segment: building a webhook is
  // not delivering it. The batch segment above stops at signed
  // payloads; here the main task's payout event is actually
  // delivered with deliverPayoutWebhookToMany — ONE logical event
  // (shared fixed `now` 2026-03-20T09:00:00.000Z, shared fixed
  // eventId "evt_demo_fanout_001") fanned out to three fixed
  // endpoints, each signed with its OWN demo secret (placeholder
  // values in this source, not real credentials). All delivery
  // goes through an injected fake fetchImpl that records every
  // wire call and answers from a fixed script — billing 200, risk
  // 500 on every attempt, notifications 200 — so the segment
  // performs zero real network I/O; an injected no-op sleepImpl
  // plus backoffMs 0 mean the risk endpoint's retries (the default
  // maxAttempts of 3) never really sleep, so no wall clock is
  // waited on either. Hand-written expectations: results stay in
  // input order — billing ok (1 attempt, status 200), risk FAILED
  // (3 attempts, status 500, error "server responded with status
  // 500"), notifications ok (1 attempt, status 200) — delivered 2,
  // failed 1: the failing endpoint neither blocks nor fails the
  // others. The fake fetch sees 5 calls in total (1 + 3 + 1); the
  // first call per endpoint carries a byte-identical body (the
  // shared eventId / at) under three different signatures, each
  // verifying only under its own endpoint's secret.
  const FANOUT_NOW = new Date("2026-03-20T09:00:00.000Z");
  const FANOUT_EVENT_ID = "evt_demo_fanout_001";
  const fanoutEndpoints = [
    {
      name: "billing",
      url: "https://billing.example.com/hooks/payout",
      secret: "demo-fanout-billing-secret-do-not-use-in-production",
    },
    {
      name: "risk",
      url: "https://risk.example.com/hooks/payout",
      secret: "demo-fanout-risk-secret-do-not-use-in-production",
    },
    {
      name: "notifications",
      url: "https://notifications.example.com/hooks/payout",
      secret: "demo-fanout-notifications-secret-do-not-use-in-production",
    },
  ] as const;
  const fanoutCalls: FanoutCall[] = [];
  const fanoutFetch: PayoutWebhookFetchImpl = async (url, init) => {
    fanoutCalls.push({
      url,
      body: String(init.body ?? ""),
      signature: String(
        new Headers(init.headers).get("x-hub-signature-256") ?? "",
      ),
    });
    return new Response("{}", {
      status: url === fanoutEndpoints[1].url ? 500 : 200,
    });
  };
  const fanoutResult = await deliverPayoutWebhookToMany(
    task,
    fanoutEndpoints.map(({ url, secret }) => ({ url, secret })),
    {
      fetchImpl: fanoutFetch,
      sleepImpl: async () => {},
      backoffMs: 0,
      now: FANOUT_NOW,
      eventId: FANOUT_EVENT_ID,
    },
  );
  lines.push(
    "",
    "Payout webhook fan-out delivery (deliverPayoutWebhookToMany to 3 endpoints, fake fetch — no real network):",
  );
  lines.push(
    `  shared eventId: ${FANOUT_EVENT_ID}, shared at: ${FANOUT_NOW.toISOString()} (one logical event for all endpoints)`,
  );
  fanoutResult.results.forEach((r, i) => {
    const ep = fanoutEndpoints[i];
    lines.push(
      r.ok
        ? `  ${ep.name} (${ep.url}): ok attempts=${r.attempts} status=${r.status}`
        : `  ${ep.name} (${ep.url}): FAILED attempts=${r.attempts} status=${r.status} error=${r.error}`,
    );
  });
  lines.push(
    `  fan-out: ${fanoutResult.delivered} delivered, ${fanoutResult.failed} failed — the failing endpoint did not block the others`,
  );
  const fanoutFirstCalls = fanoutEndpoints.map(
    (ep) => fanoutCalls.find((c) => c.url === ep.url)!,
  );
  const fanoutSharedEvent =
    fanoutFirstCalls.every((c) => c.body === fanoutFirstCalls[0].body) &&
    fanoutFirstCalls.every(
      (c) =>
        (JSON.parse(c.body) as { eventId?: string }).eventId ===
        FANOUT_EVENT_ID,
    );
  lines.push(
    `  shared event check: all endpoints received the same eventId ${FANOUT_EVENT_ID}: ${fanoutSharedEvent} (identical payload bytes, signed per endpoint with its own secret)`,
  );

  // Payout Retry-After parsing segment: the sender-side half of
  // the retry story the fan-out segment acted out. The risk
  // endpoint answered 500 on every attempt, so its retries fell
  // back to exponential backoff — a Retry-After hint is only
  // honored on a 429. This segment shows how such a hint would
  // be read: a fixed 6-value corpus parsed with
  // parsePayoutRetryAfter under the fan-out segment's shared
  // fixed instant reused as `nowMs` (2026-03-20T09:00:00.000Z —
  // no new instant, no network, no randomness, no wall clock).
  // The HTTP-date strings are built with toUTCString() from that
  // instant; toUTCString() has one-second precision and the
  // instant sits exactly on a whole second, so the date
  // expectations below are exact, not ranges. Hand-written
  // expectations — written out here from the documented
  // semantics of parsePayoutRetryAfter, never derived by
  // calling it:
  //   "2"                                -> 2000 (delay-seconds:
  //                                          2 s x 1,000)
  //   "  30 "                            -> 30000 (the value is
  //                                          trimmed, then
  //                                          30 s x 1,000)
  //   HTTP-date at FANOUT_NOW + 5,000 ms -> 5000 (future date
  //                                          delta)
  //   HTTP-date at FANOUT_NOW - 1,000 ms -> 0 (a past date
  //                                          clamps to zero,
  //                                          never negative)
  //   "banana"                           -> undefined
  //                                          (unparsable; the
  //                                          caller falls back
  //                                          to backoff)
  //   null                               -> undefined (absent
  //                                          header; same
  //                                          fallback)
  const retryAfterCorpus: Array<{
    value: string | null;
    expected: number | undefined;
  }> = [
    { value: "2", expected: 2000 },
    { value: "  30 ", expected: 30_000 },
    {
      value: new Date(FANOUT_NOW.getTime() + 5_000).toUTCString(),
      expected: 5_000,
    },
    {
      value: new Date(FANOUT_NOW.getTime() - 1_000).toUTCString(),
      expected: 0,
    },
    { value: "banana", expected: undefined },
    { value: null, expected: undefined },
  ];
  const retryAfterParsed = retryAfterCorpus.map(({ value }) =>
    parsePayoutRetryAfter(value, FANOUT_NOW.getTime()),
  );
  lines.push(
    "",
    "Payout Retry-After parsing (parsePayoutRetryAfter under a fixed now):",
    `  fixed now: ${FANOUT_NOW.toISOString()} (the fan-out segment's shared instant, reused as nowMs; no wall clock)`,
  );
  retryAfterCorpus.forEach(({ value }, i) => {
    const display = value === null ? "null" : `"${value}"`;
    const parsed = retryAfterParsed[i];
    lines.push(
      `  parsePayoutRetryAfter(${display}) -> ${parsed === undefined ? "undefined" : `${parsed} ms`}`,
    );
  });
  lines.push(
    "  retry context: the fan-out risk endpoint answered 500, so its retries used exponential backoff; had it answered 429 with a Retry-After header, the parsed wait above (clamped to maxRetryDelayMs) would have set the next attempt's delay — an absent or unparsable header (undefined) falls back to that backoff",
  );

  // Reconciliation screening branch: payout day is not the end of
  // the story — finance then screens the settled tasks for the ones
  // whose settlement lacks external evidence or disagrees with the
  // quote. Two more tasks are driven to PAID here, each with one
  // deliberate flaw, every timestamp a fixed literal (no network,
  // no randomness, no wall clock):
  //   DEMO-004 settles exactly as quoted (ACCEPT quotedAmount 2500,
  //     PAYOUT_COMPLETE payoutAmount 2500) but its PAYOUT_COMPLETE
  //     entry carries NO payoutRef — paid, yet unevidenced, so
  //     unreconciledPayouts() must flag it and mismatchedPayouts()
  //     must not.
  //   DEMO-005 settles under payoutRef "xfer-91c7" but for 3750.5
  //     against an ACCEPT quote of 4000 (delta -249.5) — evidenced,
  //     yet short, so mismatchedPayouts() must flag it and
  //     unreconciledPayouts() must not.
  // The main task DEMO-001 (payoutRef "xfer-88f2", payoutAmount
  // 10098.5, no recorded quote) must be flagged by neither screen.
  // Hand-computed expectations for the screening over all five demo
  // tasks: unreconciled = [DEMO-004], mismatched = [DEMO-005],
  // totalPaidOut = 10098.5 + 2500 + 3750.5 = 16349 (the EXPIRED and
  // REJECTED tasks contribute nothing).
  const drivePaidTask = (
    id: string,
    spec: Array<{
      event: TaskEvent;
      actor: string;
      at: string;
      quotedAmount?: number;
      payoutRef?: string;
      payoutAmount?: number;
    }>,
  ): TaskLifecycle => {
    const driven = new TaskLifecycle(id);
    lines.push(`Task ${driven.id}: ${driven.state}`);
    for (const { event, actor, at, quotedAmount, payoutRef, payoutAmount } of spec) {
      const from = driven.state;
      const to = driven.dispatch(event, {
        actor,
        at,
        ...(quotedAmount !== undefined ? { quotedAmount } : {}),
        ...(payoutRef !== undefined ? { payoutRef } : {}),
        ...(payoutAmount !== undefined ? { payoutAmount } : {}),
      });
      lines.push(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
    }
    return driven;
  };
  lines.push("", "Reconciliation screening branch (two more PAID tasks, then the finance pass):");
  const unreconciledTask = drivePaidTask("DEMO-004", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-14T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-14T09:05:00.000Z", quotedAmount: 2500 },
    { event: "START_CAPTURE", actor: "contributor", at: "2026-03-14T09:10:00.000Z" },
    { event: "SUBMIT", actor: "contributor", at: "2026-03-15T09:00:00.000Z" },
    { event: "BEGIN_REVIEW", actor: "reviewer", at: "2026-03-15T09:05:00.000Z" },
    { event: "APPROVE", actor: "reviewer", at: "2026-03-15T09:10:00.000Z" },
    { event: "REQUEST_PAYOUT", actor: "contributor", at: "2026-03-15T09:15:00.000Z" },
    { event: "PAYOUT_COMPLETE", actor: "system", at: "2026-03-15T09:20:00.000Z", payoutAmount: 2500 },
  ]);
  lines.push(
    "  note: PAYOUT_COMPLETE records payoutAmount=2500 and no payoutRef (the ACCEPT quote was also 2500, so the amount itself agrees)",
  );
  const mismatchedTask = drivePaidTask("DEMO-005", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-16T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-16T09:05:00.000Z", quotedAmount: 4000 },
    { event: "START_CAPTURE", actor: "contributor", at: "2026-03-16T09:10:00.000Z" },
    { event: "SUBMIT", actor: "contributor", at: "2026-03-17T09:00:00.000Z" },
    { event: "BEGIN_REVIEW", actor: "reviewer", at: "2026-03-17T09:05:00.000Z" },
    { event: "APPROVE", actor: "reviewer", at: "2026-03-17T09:10:00.000Z" },
    { event: "REQUEST_PAYOUT", actor: "contributor", at: "2026-03-17T09:15:00.000Z" },
    { event: "PAYOUT_COMPLETE", actor: "system", at: "2026-03-17T09:20:00.000Z", payoutRef: "xfer-91c7", payoutAmount: 3750.5 },
  ]);
  lines.push(
    "  note: ACCEPT quoted 4000 but PAYOUT_COMPLETE settled 3750.5 under payoutRef xfer-91c7 (the amount, not the evidence, is the problem)",
  );
  const screenedTasks = [task, overdueTask, disputeTask, unreconciledTask, mismatchedTask];
  const unreconciledFound = unreconciledPayouts(screenedTasks);
  const mismatchedFound = mismatchedPayouts(screenedTasks);
  const totalPaid = totalPaidOut(screenedTasks);
  lines.push(`  screened: ${screenedTasks.map((t) => t.id).join(", ")} (all five demo tasks)`);
  lines.push(
    `  unreconciledPayouts: ${unreconciledFound.map((t) => t.id).join(", ")} (${unreconciledFound.length} hit: PAID but no payoutRef on the PAYOUT_COMPLETE entry)`,
  );
  lines.push(
    `  mismatchedPayouts: ${mismatchedFound
      .map((t) => {
        const m = payoutMismatch(t)!;
        return `${t.id} (quoted ${m.quoted}, paid ${m.paid}, delta ${m.delta})`;
      })
      .join(", ")} (${mismatchedFound.length} hit: settled amount differs from the ACCEPT quote)`,
  );
  lines.push(
    `  totalPaidOut: ${totalPaid} (10098.5 + 2500 + 3750.5 across the 3 PAID tasks; the EXPIRED and REJECTED tasks contribute nothing)`,
  );

  // Dispatch subscription branch: the demo's only in-process
  // notification fan-out point, acted out on a sixth task. A
  // collecting listener is subscribed BEFORE any dispatch, so it
  // receives every successful dispatch in order — each notification
  // is the (event, from, to) triple plus the seq of the audit entry
  // appended just before the listener ran. The branch then
  // unsubscribes and dispatches one further step: the task moves,
  // the listener hears nothing. Every timestamp in this branch is
  // a fixed literal (2026-03-19): no network, no randomness, no
  // wall clock. Hand-written expectations: the listener collects
  // exactly 3 notifications (PUBLISH DRAFT -> OPEN seq 1, ACCEPT
  // OPEN -> ACCEPTED seq 2, START_CAPTURE ACCEPTED -> CAPTURING
  // seq 3), each equal to the history entry with the same seq;
  // after unsubscribe the count stays 3 while the task lands in
  // SUBMITTED with 4 history entries.
  const subscriptionTask = new TaskLifecycle("DEMO-006");
  const subscriptionNotifications: SubscriptionNotification[] = [];
  const unsubscribeSubscription = subscriptionTask.subscribe(
    (event, from, to, entry) => {
      subscriptionNotifications.push({ event, from, to, seq: entry.seq });
    },
  );
  lines.push("", "Dispatch subscription branch (sixth task, in-process fan-out):");
  lines.push(`Task ${subscriptionTask.id}: ${subscriptionTask.state}`);
  lines.push(
    "  subscribed: 1 collecting listener (notified after each audit append, in subscription order)",
  );
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-03-19T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-03-19T09:05:00.000Z"],
    ["START_CAPTURE", "contributor", "2026-03-19T09:10:00.000Z"],
  ] as const) {
    subscriptionTask.dispatch(event, { actor, at });
  }
  lines.push(
    `  listener received ${subscriptionNotifications.length} notification(s), in dispatch order:`,
  );
  subscriptionNotifications.forEach((n, i) => {
    lines.push(
      `    notification ${i + 1}: ${n.event} ${n.from} -> ${n.to} (entry seq ${n.seq})`,
    );
  });
  const subscriptionMatchesHistory = subscriptionNotifications.every((n) => {
    const entry = subscriptionTask.history[n.seq - 1];
    return (
      entry !== undefined &&
      entry.seq === n.seq &&
      entry.event === n.event &&
      entry.from === n.from &&
      entry.to === n.to
    );
  });
  lines.push(
    `  notifications match the task history: ${subscriptionMatchesHistory} (each (event, from, to) equals the history entry with the same seq)`,
  );
  unsubscribeSubscription();
  lines.push(`  unsubscribed: listenerCount ${subscriptionTask.listenerCount}`);
  const subscriptionFrom = subscriptionTask.state;
  const subscriptionTo = subscriptionTask.dispatch("SUBMIT", {
    actor: "contributor",
    at: "2026-03-19T09:15:00.000Z",
  });
  lines.push(
    `  ${"SUBMIT".padEnd(15)} ${subscriptionFrom.padEnd(12)} -> ${subscriptionTo}  (contributor)`,
  );
  const subscriptionCountAfterUnsubscribe = subscriptionNotifications.length;
  lines.push(
    `  listener received after unsubscribe: ${subscriptionCountAfterUnsubscribe} notification(s) (unchanged — SUBMIT produced no new notification)`,
  );
  lines.push(
    "",
    `Final state (subscription branch): ${subscriptionTask.state} (terminal: ${subscriptionTask.isTerminal})`,
  );

  // listenerCount lifecycle branch: `listenerCount` is the
  // subscription registry's observable surface — the only way a
  // caller debugging a listener leak can see subscribe/unsubscribe
  // actually move the registry. Acted out on a seventh task. The
  // pinned lifecycle is 0 -> 2 -> 1 -> 0: no subscriptions, two
  // collectors subscribed, one of them unsubscribed, the survivor
  // unsubscribed, then a second call of the same unsubscribe
  // (idempotent — still 0). Between the two unsubscribes, one
  // PUBLISH dispatch proves the survivor still hears it while the
  // departed collector stays silent. Every value below is pinned;
  // the dispatch uses a fixed `at` and no wall clock, network, or
  // randomness is touched.
  const listenerCountTask = new TaskLifecycle("DEMO-043");
  const listenerCountKept: SubscriptionNotification[] = [];
  const listenerCountDropped: SubscriptionNotification[] = [];
  const listenerCountTimeline: number[] = [listenerCountTask.listenerCount];
  const unsubscribeKeptListener = listenerCountTask.subscribe(
    (event, from, to, entry) => {
      listenerCountKept.push({ event, from, to, seq: entry.seq });
    },
  );
  const unsubscribeDroppedListener = listenerCountTask.subscribe(
    (event, from, to, entry) => {
      listenerCountDropped.push({ event, from, to, seq: entry.seq });
    },
  );
  lines.push("", "listenerCount lifecycle (subscription registry observability):");
  lines.push(`Task ${listenerCountTask.id}: ${listenerCountTask.state}`);
  lines.push(
    `  listenerCount with no subscriptions: ${listenerCountTimeline[0]}`,
  );
  lines.push(
    `  subscribed: 2 collecting listeners (listenerCount ${listenerCountTask.listenerCount})`,
  );
  listenerCountTimeline.push(listenerCountTask.listenerCount);
  unsubscribeDroppedListener();
  lines.push(
    `  unsubscribed one listener (listenerCount ${listenerCountTask.listenerCount})`,
  );
  listenerCountTimeline.push(listenerCountTask.listenerCount);
  const listenerCountFrom = listenerCountTask.state;
  const listenerCountTo = listenerCountTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-03-19T09:30:00.000Z",
  });
  lines.push(
    `  ${"PUBLISH".padEnd(15)} ${listenerCountFrom.padEnd(12)} -> ${listenerCountTo}  (researcher)`,
  );
  lines.push(
    `  surviving listener heard ${listenerCountKept.length} notification(s): PUBLISH ${listenerCountKept[0].from} -> ${listenerCountKept[0].to} (entry seq ${listenerCountKept[0].seq}); departed listener heard ${listenerCountDropped.length}`,
  );
  unsubscribeKeptListener();
  lines.push(
    `  unsubscribed the survivor (listenerCount ${listenerCountTask.listenerCount})`,
  );
  listenerCountTimeline.push(listenerCountTask.listenerCount);
  unsubscribeKeptListener();
  lines.push(
    `  second call of the same unsubscribe is idempotent (listenerCount ${listenerCountTask.listenerCount})`,
  );
  listenerCountTimeline.push(listenerCountTask.listenerCount);
  lines.push(
    "",
    `Final state (listenerCount branch): ${listenerCountTask.state} (listenerCount ${listenerCountTask.listenerCount})`,
  );

  // Stale-task dwell screening branch: the watchdog's second
  // screening lens, acted out on three more tasks. The SLA branch
  // near the top screens by absolute deadline (`expiredTasks()`:
  // "past the deadline attached to the current state"); this branch
  // screens the same way a "stuck task" watchdog does — by dwell
  // (`staleTasks()`: "in the current state longer than the
  // per-state budget", measured from the last history entry's
  // `at`). The two lenses are independent, and this batch is built so
  // they disagree: every timestamp is a fixed literal and the
  // screening `now` is fixed at 2026-03-22T09:00:00.000Z, so every
  // dwell below is exact (no network, no randomness, no wall
  // clock). Hand-written expectations:
  //   DEMO-007 sits in OPEN since 2026-03-01T09:00:00.000Z —
  //     dwell 1814400000 ms (21 days) > the OPEN budget of
  //     604800000 ms (7 days), so stale; its OPEN SLA deadline is
  //     2026-03-25T09:00:00.000Z, still ahead, so NOT overdue.
  //   DEMO-008 sits in IN_REVIEW since 2026-03-21T09:00:00.000Z —
  //     dwell 86400000 ms (1 day) < the IN_REVIEW budget of
  //     432000000 ms (5 days), so NOT stale; its IN_REVIEW SLA
  //     deadline is 2026-03-21T12:00:00.000Z, already past, so
  //     overdue.
  //   DEMO-009 sits in OPEN since 2026-03-21T09:00:00.000Z —
  //     dwell 86400000 ms (1 day) < the OPEN budget, and it
  //     carries no SLA deadline at all, so neither stale nor
  //     overdue.
  // Screening is pure: staleTasks()/expiredTasks() never dispatch
  // or mutate, so all three tasks keep their states and history
  // lengths (the demo tests pin this).
  const STALE_BRANCH_NOW = new Date("2026-03-22T09:00:00.000Z");
  const STALE_BUDGETS = {
    OPEN: 7 * 24 * 3600_000,
    IN_REVIEW: 5 * 24 * 3600_000,
  } as const;
  const DAY_MS = 24 * 3600_000;
  const driveStaleTask = (
    id: string,
    spec: Array<{ event: TaskEvent; actor: string; at: string }>,
  ): TaskLifecycle => {
    const driven = new TaskLifecycle(id);
    lines.push(`Task ${driven.id}: ${driven.state}`);
    for (const { event, actor, at } of spec) {
      const from = driven.state;
      const to = driven.dispatch(event, { actor, at });
      lines.push(`  ${event.padEnd(15)} ${from.padEnd(12)} -> ${to}  (${actor})`);
    }
    return driven;
  };
  lines.push("", "Stale-task dwell screening branch (three more tasks, dwell vs deadline):");
  lines.push(
    `  screened at: ${STALE_BRANCH_NOW.toISOString()} (fixed now; no wall clock)`,
  );
  lines.push(
    `  budgets: OPEN ${STALE_BUDGETS.OPEN} ms (7 days), IN_REVIEW ${STALE_BUDGETS.IN_REVIEW} ms (5 days) — dwell is now minus the last history entry's at`,
  );
  const staleOpenTask = driveStaleTask("DEMO-007", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-01T09:00:00.000Z" },
  ]);
  staleOpenTask.setSlaDeadline("2026-03-25T09:00:00.000Z", "OPEN");
  lines.push(
    `  SLA deadline (OPEN): ${staleOpenTask.getSlaDeadline("OPEN")}`,
  );
  const staleReviewTask = driveStaleTask("DEMO-008", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-20T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-20T09:05:00.000Z" },
    { event: "START_CAPTURE", actor: "contributor", at: "2026-03-20T09:10:00.000Z" },
    { event: "SUBMIT", actor: "contributor", at: "2026-03-21T08:55:00.000Z" },
    { event: "BEGIN_REVIEW", actor: "reviewer", at: "2026-03-21T09:00:00.000Z" },
  ]);
  staleReviewTask.setSlaDeadline("2026-03-21T12:00:00.000Z", "IN_REVIEW");
  lines.push(
    `  SLA deadline (IN_REVIEW): ${staleReviewTask.getSlaDeadline("IN_REVIEW")}`,
  );
  const staleFreshTask = driveStaleTask("DEMO-009", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-21T09:00:00.000Z" },
  ]);
  lines.push("  SLA deadline (OPEN): none");
  const staleDwellTasks = [staleOpenTask, staleReviewTask, staleFreshTask];
  const staleFound = staleTasks(staleDwellTasks, STALE_BUDGETS, STALE_BRANCH_NOW);
  const staleExpiredFound = expiredTasks(staleDwellTasks, STALE_BRANCH_NOW);
  for (const t of staleDwellTasks) {
    const enteredAt = t.history[t.history.length - 1].at;
    const dwellMs = STALE_BRANCH_NOW.getTime() - Date.parse(enteredAt);
    const dwellDays = dwellMs / DAY_MS;
    const budget = STALE_BUDGETS[t.state as keyof typeof STALE_BUDGETS];
    lines.push(
      `  ${t.id}: state ${t.state}, entered at ${enteredAt}, dwell ${dwellMs} ms (${dwellDays} ${dwellDays === 1 ? "day" : "days"}) vs ${t.state} budget ${budget} ms -> stale: ${staleFound.includes(t)}, overdue: ${isOverdue(t, STALE_BRANCH_NOW)}`,
    );
  }
  lines.push(
    `  staleTasks([${staleDwellTasks.map((t) => t.id).join(", ")}], budgets, ${STALE_BRANCH_NOW.toISOString()}): ${staleFound.map((t) => t.id).join(", ")} (${staleFound.length} stale)`,
  );
  lines.push(
    `  expiredTasks([${staleDwellTasks.map((t) => t.id).join(", ")}], ${STALE_BRANCH_NOW.toISOString()}): ${staleExpiredFound.map((t) => t.id).join(", ")} (${staleExpiredFound.length} overdue)`,
  );
  lines.push(
    "  contrast: the two screens disagree on the same batch — DEMO-007 is stale but not overdue (dwell past budget, deadline still ahead), DEMO-008 is overdue but not stale (deadline passed, dwell within budget), DEMO-009 is neither",
  );
  lines.push(
    "  screening is pure: no task was dispatched or mutated by either screen",
  );

  // Approaching-deadline screening branch: the watchdog's third
  // screening lens. `expiredTasks()` answers "already past the
  // deadline" and `staleTasks()` answers "stuck in this state too
  // long"; neither warns before the deadline arrives. This branch
  // screens at the SAME fixed `now` as the stale branch above
  // (2026-03-22T09:00:00.000Z) with a 24-hour warning window, so
  // every deadline below is exact (no network, no randomness, no
  // wall clock). Hand-written expectations under the half-open
  // window `(now, now + withinMs]`:
  //   DEMO-046 sits in OPEN with an OPEN deadline 12 hours out
  //     (2026-03-22T21:00:00.000Z) — inside the window, so
  //     approaching.
  //   DEMO-047 sits in OPEN with an OPEN deadline exactly 24
  //     hours out (2026-03-23T09:00:00.000Z) — the upper bound
  //     is inclusive, so approaching.
  //   DEMO-048 sits in OPEN with an OPEN deadline exactly at
  //     `now` (2026-03-22T09:00:00.000Z) — the lower bound is
  //     exclusive, so NOT approaching; it is already overdue
  //     (`isOverdue` treats deadline-at-now as past), so it
  //     belongs to `expiredTasks`, not here.
  //   DEMO-049 sits in OPEN with an OPEN deadline a day past
  //     (2026-03-21T09:00:00.000Z) — overdue, not approaching.
  // Screening is pure: tasksApproachingDeadline()/expiredTasks()
  // never dispatch or mutate, so all four tasks keep their states
  // and history lengths (the demo tests pin this).
  const APPROACHING_BRANCH_NOW = new Date("2026-03-22T09:00:00.000Z");
  const APPROACHING_WINDOW_MS = 24 * 3600_000;
  const driveApproachingTask = (
    id: string,
    deadline: string,
  ): TaskLifecycle => {
    const driven = new TaskLifecycle(id);
    lines.push(`Task ${driven.id}: ${driven.state}`);
    const from = driven.state;
    const to = driven.dispatch("PUBLISH", {
      actor: "researcher",
      at: "2026-03-21T09:00:00.000Z",
    });
    lines.push(`  ${"PUBLISH".padEnd(15)} ${from.padEnd(12)} -> ${to}  (researcher)`);
    driven.setSlaDeadline(deadline, "OPEN");
    lines.push(`  SLA deadline (OPEN): ${driven.getSlaDeadline("OPEN")}`);
    return driven;
  };
  lines.push("", "Approaching-deadline screening branch (four more tasks, warning window vs deadline):");
  lines.push(
    `  screened at: ${APPROACHING_BRANCH_NOW.toISOString()} (fixed now; no wall clock)`,
  );
  lines.push(
    `  window: (now, now + ${APPROACHING_WINDOW_MS} ms] (24 hours) — lower bound exclusive, upper bound inclusive`,
  );
  const approachingInWindowTask = driveApproachingTask(
    "DEMO-046",
    "2026-03-22T21:00:00.000Z",
  );
  const approachingUpperTask = driveApproachingTask(
    "DEMO-047",
    "2026-03-23T09:00:00.000Z",
  );
  const approachingLowerTask = driveApproachingTask(
    "DEMO-048",
    "2026-03-22T09:00:00.000Z",
  );
  const approachingOverdueTask = driveApproachingTask(
    "DEMO-049",
    "2026-03-21T09:00:00.000Z",
  );
  const approachingTasks = [
    approachingInWindowTask,
    approachingUpperTask,
    approachingLowerTask,
    approachingOverdueTask,
  ];
  const approachingFound = tasksApproachingDeadline(
    approachingTasks,
    APPROACHING_WINDOW_MS,
    APPROACHING_BRANCH_NOW,
  );
  const approachingOverdueFound = expiredTasks(
    approachingTasks,
    APPROACHING_BRANCH_NOW,
  );
  if (
    approachingFound.map((t) => t.id).join(",") !== "DEMO-046,DEMO-047" ||
    approachingOverdueFound.map((t) => t.id).join(",") !== "DEMO-048,DEMO-049"
  ) {
    throw new Error(
      "demo approaching-deadline segment broken: expected approaching [DEMO-046,DEMO-047] and overdue [DEMO-048,DEMO-049]",
    );
  }
  for (const t of approachingTasks) {
    lines.push(
      `  ${t.id}: state ${t.state}, deadline ${t.getSlaDeadline("OPEN")} -> approaching: ${approachingFound.includes(t)}, overdue: ${isOverdue(t, APPROACHING_BRANCH_NOW)}`,
    );
  }
  lines.push(
    `  tasksApproachingDeadline([${approachingTasks.map((t) => t.id).join(", ")}], ${APPROACHING_WINDOW_MS}, ${APPROACHING_BRANCH_NOW.toISOString()}): ${approachingFound.map((t) => t.id).join(", ")} (${approachingFound.length} approaching)`,
  );
  lines.push(
    `  expiredTasks([${approachingTasks.map((t) => t.id).join(", ")}], ${APPROACHING_BRANCH_NOW.toISOString()}): ${approachingOverdueFound.map((t) => t.id).join(", ")} (${approachingOverdueFound.length} overdue)`,
  );
  lines.push(
    "  contrast: the window's bounds decide membership — DEMO-047 lands exactly on now + 24 hours and is approaching (upper bound inclusive), DEMO-048 lands exactly on now and is overdue instead (lower bound exclusive), DEMO-049 is overdue, DEMO-046 is approaching from inside the window",
  );
  lines.push(
    "  screening is pure: no task was dispatched or mutated by either screen",
  );

  // Stale-task batch execution branch: screening alone does not
  // move anything — this branch is the execution half of the
  // watchdog story, acted out on four more tasks at the SAME fixed
  // now as the screening branch above (2026-03-22T09:00:00.000Z;
  // no network, no randomness, no wall clock). The executor is
  // `actOnStaleTasks()` with a custom action that dispatches
  // ABANDON with the fixed execution instant as the audit
  // timestamp (the library default action dispatches the same
  // event with actor "system" at the wall clock; pinning `at`
  // here keeps the demo byte-deterministic). Hand-written
  // expectations under budgets of 7 days for ACCEPTED, CAPTURING
  // and SUBMITTED:
  //   DEMO-010 sits in SUBMITTED since 2026-03-10T09:00:00.000Z —
  //     dwell 12 days, so stale — but SUBMITTED has no ABANDON
  //     edge, so its action fails with
  //     "invalid transition: ABANDON from SUBMITTED" and the task
  //     is left untouched in SUBMITTED. It is placed FIRST in the
  //     batch on purpose: its failure must not block the rest.
  //   DEMO-011 sits in ACCEPTED since 2026-03-05T09:00:00.000Z —
  //     dwell 17 days, so stale — and ABANDON is legal there, so
  //     it lands in ABANDONED.
  //   DEMO-012 sits in CAPTURING since 2026-03-08T09:00:00.000Z —
  //     dwell 14 days, so stale — and ABANDON is legal there too,
  //     so it also lands in ABANDONED.
  //   DEMO-013 sits in ACCEPTED since 2026-03-21T09:00:00.000Z —
  //     dwell 1 day, within budget, so it is not stale: the
  //     executor never attempts it and it produces no result
  //     entry, staying untouched in ACCEPTED.
  // Results therefore read: 3 attempted, 2 acted, 1 failed — one
  // unactionable stale task never blocks the rest of the batch.
  const STALE_ACTION_NOW = STALE_BRANCH_NOW;
  const STALE_ACTION_BUDGETS = {
    ACCEPTED: 7 * DAY_MS,
    CAPTURING: 7 * DAY_MS,
    SUBMITTED: 7 * DAY_MS,
  } as const;
  const driveActionTask = driveStaleTask;
  lines.push("", "Stale-task batch execution branch (actOnStaleTasks over four more tasks):");
  lines.push(
    `  executed at: ${STALE_ACTION_NOW.toISOString()} (fixed now; no wall clock)`,
  );
  lines.push(
    `  budgets: ACCEPTED ${STALE_ACTION_BUDGETS.ACCEPTED} ms (7 days), CAPTURING ${STALE_ACTION_BUDGETS.CAPTURING} ms (7 days), SUBMITTED ${STALE_ACTION_BUDGETS.SUBMITTED} ms (7 days) — action dispatches ABANDON with the fixed execution instant as its audit timestamp`,
  );
  const actionSubmittedTask = driveActionTask("DEMO-010", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-02T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-02T09:05:00.000Z" },
    { event: "START_CAPTURE", actor: "contributor", at: "2026-03-02T09:10:00.000Z" },
    { event: "SUBMIT", actor: "contributor", at: "2026-03-10T09:00:00.000Z" },
  ]);
  const actionAcceptedTask = driveActionTask("DEMO-011", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-01T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-05T09:00:00.000Z" },
  ]);
  const actionCapturingTask = driveActionTask("DEMO-012", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-01T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-01T09:05:00.000Z" },
    { event: "START_CAPTURE", actor: "contributor", at: "2026-03-08T09:00:00.000Z" },
  ]);
  const actionFreshTask = driveActionTask("DEMO-013", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-21T08:55:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-21T09:00:00.000Z" },
  ]);
  const staleActionTasks = [
    actionSubmittedTask,
    actionAcceptedTask,
    actionCapturingTask,
    actionFreshTask,
  ];
  const staleActionResults = actOnStaleTasks(
    staleActionTasks,
    (t) =>
      t.dispatch("ABANDON", {
        actor: "watchdog",
        at: STALE_ACTION_NOW.toISOString(),
      }),
    STALE_ACTION_BUDGETS,
    STALE_ACTION_NOW,
  );
  for (const r of staleActionResults) {
    lines.push(
      r.acted
        ? `  ${r.task.id}: acted=true -> state ${r.task.state} (ABANDON dispatched; the batch kept going)`
        : `  ${r.task.id}: acted=false error="${r.error}" -> state ${r.task.state} (left untouched — the failure is isolated)`,
    );
  }
  lines.push(
    `  ${actionFreshTask.id}: not stale at the fixed now (dwell 86400000 ms (1 day) within the ACCEPTED budget) -> no result entry, untouched in ${actionFreshTask.state}`,
  );
  const staleActed = staleActionResults.filter((r) => r.acted).length;
  lines.push(
    `  execution: ${staleActionResults.length} attempted, ${staleActed} acted, ${staleActionResults.length - staleActed} failed — one unactionable stale task never blocks the rest of the batch`,
  );

  // SLA watchdog batch execution branch: the execution half of
  // the SLA story at the top of this demo, acted out on three
  // more tasks. The SLA branch near the top only screens
  // (`expiredTasks()` finds DEMO-002) and then expires that one
  // task with a hand-written dispatch loop; the batch executor
  // `expireOverdueTasks()` never appeared in the demo, so a
  // reader could not see screening and execution as two steps,
  // nor what the executor's per-task result entries look like.
  // The executor mutates its inputs, and the original SLA batch
  // is already settled (DEMO-001 is PAID, DEMO-002 is EXPIRED),
  // so this branch rebuilds the batch fresh from the same
  // fixed literals and reuses the very same fixed screening
  // instant (SLA_BRANCH_NOW, 2026-03-06T09:00:00.000Z — no new
  // screening instant, no network, no randomness):
  //   DEMO-014 is a byte-for-byte rebuild of DEMO-002's setup —
  //     PUBLISH 2026-03-01T09:00, ACCEPT 2026-03-01T09:05, SLA
  //     deadline (ACCEPTED) 2026-03-03T09:00 — so overdue at the
  //     fixed now, and EXPIRE is legal from ACCEPTED.
  //   DEMO-015 sits in OPEN since 2026-03-02T09:00 with an OPEN
  //     SLA deadline of 2026-03-04T09:00 — also overdue, and
  //     EXPIRE is legal from OPEN.
  //   DEMO-016 sits in ACCEPTED like DEMO-014 but its deadline
  //     is 2026-03-10T09:00, still ahead of the fixed now — not
  //     overdue, so the executor never attempts it and it
  //     produces no result entry, staying untouched in ACCEPTED.
  // Hand-written expectations: the screening subset is
  // [DEMO-014, DEMO-015]; the executor returns exactly one entry
  // per screened task, both expired=true and now EXPIRED, so the
  // screening subset and the execution's acted set agree.
  // Honest limit: `expireOverdueTasks()` takes no action
  // callback, so its EXPIRE dispatches are library-attributed
  // (`actor: "system"`, a wall-clock audit timestamp) — this segment
  // prints no history for the rebuilt tasks and no timestamp
  // from those entries, so every printed line below is a fixed
  // literal or derived from one; the demo tests pin the states
  // and outcomes, never those entries' `at`.
  const driveExpireTask = driveStaleTask;
  lines.push("", "SLA watchdog batch execution branch (expireOverdueTasks over a rebuilt SLA batch):");
  lines.push(
    `  executed at: ${SLA_BRANCH_NOW.toISOString()} (the SLA branch's fixed screening now, reused; no new screening instant)`,
  );
  lines.push(
    "  rebuilt batch: the executor mutates its inputs and the original SLA tasks are already settled, so the batch is rebuilt fresh from the same fixed literals (DEMO-014 mirrors DEMO-002's setup exactly)",
  );
  const expireMirrorTask = driveExpireTask("DEMO-014", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-01T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-01T09:05:00.000Z" },
  ]);
  expireMirrorTask.setSlaDeadline("2026-03-03T09:00:00.000Z");
  lines.push(
    `  SLA deadline (ACCEPTED): ${expireMirrorTask.getSlaDeadline("ACCEPTED")}`,
  );
  const expireOpenTask = driveExpireTask("DEMO-015", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-02T09:00:00.000Z" },
  ]);
  expireOpenTask.setSlaDeadline("2026-03-04T09:00:00.000Z", "OPEN");
  lines.push(
    `  SLA deadline (OPEN): ${expireOpenTask.getSlaDeadline("OPEN")}`,
  );
  const expireFreshTask = driveExpireTask("DEMO-016", [
    { event: "PUBLISH", actor: "researcher", at: "2026-03-01T09:00:00.000Z" },
    { event: "ACCEPT", actor: "contributor", at: "2026-03-01T09:05:00.000Z" },
  ]);
  expireFreshTask.setSlaDeadline("2026-03-10T09:00:00.000Z");
  lines.push(
    `  SLA deadline (ACCEPTED): ${expireFreshTask.getSlaDeadline("ACCEPTED")}`,
  );
  const expireExecutionTasks = [
    expireMirrorTask,
    expireOpenTask,
    expireFreshTask,
  ];
  const expireExecutionFound = expiredTasks(
    expireExecutionTasks,
    SLA_BRANCH_NOW,
  );
  lines.push(
    `  expiredTasks([${expireExecutionTasks.map((t) => t.id).join(", ")}], ${SLA_BRANCH_NOW.toISOString()}): ${expireExecutionFound.map((t) => t.id).join(", ")} (${expireExecutionFound.length} overdue)`,
  );
  const expireExecutionResults = expireOverdueTasks(
    expireExecutionTasks,
    SLA_BRANCH_NOW,
  );
  for (const r of expireExecutionResults) {
    lines.push(
      r.expired
        ? `  ${r.task.id}: expired=true -> state ${r.task.state} (EXPIRE dispatched by the executor)`
        : `  ${r.task.id}: expired=false error="${r.error}" -> state ${r.task.state} (left untouched — the failure is isolated)`,
    );
  }
  lines.push(
    `  ${expireFreshTask.id}: not overdue at the fixed now (deadline ${expireFreshTask.getSlaDeadline("ACCEPTED")} still ahead) -> no result entry, untouched in ${expireFreshTask.state}`,
  );
  const expireActedIds = expireExecutionResults
    .filter((r) => r.expired)
    .map((r) => r.task.id);
  const expireSetsAgree =
    expireActedIds.length === expireExecutionFound.length &&
    expireActedIds.every((id, i) => id === expireExecutionFound[i].id);
  lines.push(
    `  screening vs execution: expiredTasks subset [${expireExecutionFound.map((t) => t.id).join(", ")}] == expireOverdueTasks acted set [${expireActedIds.join(", ")}]: ${expireSetsAgree} (same tasks, same batch order)`,
  );
  const expireFailed = expireExecutionResults.length - expireActedIds.length;
  lines.push(
    `  execution: ${expireExecutionResults.length} attempted, ${expireActedIds.length} expired, ${expireFailed} failed — the not-yet-overdue task was never attempted`,
  );

  // Event-sourcing replay segment (closing): the demo's thesis —
  // the audit history is the single source of truth — acted out on
  // the main task. Its 12-entry history is exported as NDJSON
  // (one canonical JSON entry per line, trailing newline), printed
  // in full, parsed back with historyFromNdjson(), and replayed
  // with TaskLifecycle.fromHistory(). Hand-written expectations:
  // the export has exactly 12 lines; the parsed entries are the
  // original history entry for entry; the replayed task is in
  // state PAID with 12 history entries whose last entry is
  // seq 12 PAYOUT_COMPLETE PAYOUT_PENDING -> PAID, identical to
  // the original's last entry (the demo tests pin all of this,
  // including a full deep equality of the two histories). The
  // segment adds no new nondeterminism: it only serializes the
  // main task's existing history — whose timestamps already vary
  // between runs — and reads no network, no randomness, and no
  // new wall clock.
  const ndjsonText = historyToNdjson(task);
  const ndjsonLines = ndjsonText.trimEnd().split("\n");
  lines.push("", "Event-sourcing replay (NDJSON history export + fromHistory replay of DEMO-001):");
  lines.push(
    `  historyToNdjson(${task.id}): ${ndjsonLines.length} lines (one JSON entry per line, trailing newline)`,
  );
  for (const line of ndjsonLines) {
    lines.push(`  ${line}`);
  }
  const parsedEntries = historyFromNdjson(ndjsonText);
  lines.push(`  historyFromNdjson: ${parsedEntries.length} entries parsed back`);
  const replayedTask = TaskLifecycle.fromHistory(task.id, parsedEntries);
  lines.push(
    `  TaskLifecycle.fromHistory(${task.id}, entries): state ${replayedTask.state}, ${replayedTask.history.length} history entries`,
  );
  const replayedLast = replayedTask.history.at(-1)!;
  const replayMatches =
    replayedTask.state === task.state &&
    historyToNdjson(replayedTask) === ndjsonText;
  lines.push(
    `  replay matches the original (state + full history): ${replayMatches} — last entry seq ${replayedLast.seq} ${replayedLast.event} ${replayedLast.from} -> ${replayedLast.to}`,
  );
  // Pure replay derivation: the same NDJSON round-tripped history
  // feeds the stateless replay() function — no instance, no snapshot
  // envelope — and the derived terminal state is cross-checked three
  // ways: replay() vs the live task's state vs the fromHistory
  // instance's state. The empty-history call pins the DRAFT
  // sentinel: a history with no events replays to DRAFT. The segment
  // adds no new nondeterminism: replay() reads only the entries
  // above, and the empty call is a constant.
  const replayDerivedState = replay(parsedEntries);
  const replayDerivedMatches =
    replayDerivedState === task.state &&
    replayDerivedState === replayedTask.state;
  lines.push(
    `  replay(parsedEntries): pure function derives final state ${replayDerivedState} — matches task.state (${task.state}) and fromHistory state (${replayedTask.state}): ${replayDerivedMatches}`,
  );
  const replayEmptyState = replay([]);
  lines.push(
    `  replay([]): empty history replays to the ${replayEmptyState} sentinel (no events yet)`,
  );

  // Allowed-events listing segment (closing): every segment above
  // dispatches a fixed script, so a reader never sees the query a
  // task-list UI or a watchdog consults BEFORE dispatching —
  // "what can this task do next?" `allowedEvents(state)` answers
  // it from the transition table alone: pure, no task instance, no
  // dispatch, no mutation (no network, no randomness, no wall
  // clock). All 13 states are listed in transition-table
  // declaration order. Hand-written expectations — written out
  // here from the transition table in src/taskLifecycle.ts, never
  // derived by calling allowedEvents itself (the demo tests
  // cross-check the printed listing against the committed
  // transition-table snapshot as well):
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
  const ALL_STATES: TaskState[] = [
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
  const allowedEventsByState = ALL_STATES.map((state) => ({
    state,
    events: allowedEvents(state),
  }));
  const mainTaskAllowedEvents = allowedEvents(task.state);
  lines.push(
    "",
    "Allowed events by state (allowedEvents over all 13 states):",
  );
  for (const { state, events } of allowedEventsByState) {
    lines.push(
      `  ${state.padEnd(15)} -> ${events.length > 0 ? events.join(", ") : "(none — terminal)"}`,
    );
  }
  lines.push(
    `  main task ${task.id} (${task.state}): allowedEvents -> ${mainTaskAllowedEvents.length > 0 ? mainTaskAllowedEvents.join(", ") : "(none)"} — a terminal task offers no further events, so a task-list UI renders no actions for it`,
  );

  // Standalone history parsing segment (closing): every segment
  // above either drives a TaskLifecycle or parses text back
  // through one (the replay segment's historyFromNdjson feeds
  // TaskLifecycle.fromHistory). An import / migration / audit
  // review tool often holds only a bare history value — a JSON
  // text from a snapshot file or another store — and needs it
  // validated on its own, with no task instance at all. That is
  // `parseHistory(history)`: strict structural validation
  // (unknown fields fail closed, gapless seq, from/to chain
  // continuity, legal transitions, canonical timestamps, and a
  // full hash-chain re-verification when the entries carry
  // hashes) returning fresh sanitized entries. The corpus here
  // is a fixed JSON text (no network, no randomness, no wall
  // clock) carrying the same five-entry chain that opens the
  // main task, in hashless legacy form with fixed timestamps.
  // Hand-written expectations — written out here from the main
  // task's opening steps above, never derived by calling
  // parseHistory itself:
  //   seq 1 PUBLISH       DRAFT     -> OPEN      (system)
  //   seq 2 ACCEPT        OPEN      -> ACCEPTED  (contributor)
  //   seq 3 START_CAPTURE ACCEPTED  -> CAPTURING (contributor)
  //   seq 4 SUBMIT        CAPTURING -> SUBMITTED (contributor)
  //   seq 5 BEGIN_REVIEW  SUBMITTED -> IN_REVIEW (reviewer)
  // so the parse returns exactly 5 entries and the final state
  // (the last entry's `to`) is IN_REVIEW; the parsed seq/event/
  // from/to chain equals the main task history's first 5 entries.
  // The invalid check runs outside the printed parse: a detached
  // copy whose third entry's `from` is rewritten from ACCEPTED
  // to OPEN breaks the chain, so parseHistory must throw
  // "invalid history: entry[2]: from OPEN does not continue
  // previous to ACCEPTED" — and the original parse is untouched.
  const PARSE_HISTORY_TEXT = JSON.stringify([
    { seq: 1, event: "PUBLISH", from: "DRAFT", to: "OPEN", at: "2026-03-23T09:00:00.000Z", actor: "system", note: "Researcher publishes the data-collection task" },
    { seq: 2, event: "ACCEPT", from: "OPEN", to: "ACCEPTED", at: "2026-03-23T09:05:00.000Z", actor: "contributor", note: "Contributor picks up the task" },
    { seq: 3, event: "START_CAPTURE", from: "ACCEPTED", to: "CAPTURING", at: "2026-03-23T09:10:00.000Z", actor: "contributor", note: "Data capture begins" },
    { seq: 4, event: "SUBMIT", from: "CAPTURING", to: "SUBMITTED", at: "2026-03-23T09:15:00.000Z", actor: "contributor", note: "Batch uploaded for QA" },
    { seq: 5, event: "BEGIN_REVIEW", from: "SUBMITTED", to: "IN_REVIEW", at: "2026-03-23T09:20:00.000Z", actor: "reviewer", note: "QA specialist starts review" },
  ]);
  const parsedHistoryEntries = parseHistory(
    JSON.parse(PARSE_HISTORY_TEXT) as unknown,
  );
  const parsedHistoryMatchesMainPrefix =
    parsedHistoryEntries.length === 5 &&
    parsedHistoryEntries.every((entry, i) => {
      const main = task.history[i];
      return (
        main !== undefined &&
        entry.seq === main.seq &&
        entry.event === main.event &&
        entry.from === main.from &&
        entry.to === main.to
      );
    });
  let parsedHistoryInvalidRejected = false;
  let parsedHistoryInvalidError = "";
  const parsedHistoryInvalidCopy = parsedHistoryEntries.map((entry) => ({
    ...entry,
  }));
  parsedHistoryInvalidCopy[2] = {
    ...parsedHistoryInvalidCopy[2],
    from: "OPEN",
  };
  try {
    parseHistory(parsedHistoryInvalidCopy);
  } catch (err) {
    parsedHistoryInvalidError = err instanceof Error ? err.message : String(err);
    parsedHistoryInvalidRejected = parsedHistoryInvalidError.includes(
      "does not continue previous to",
    );
  }
  lines.push(
    "",
    "Standalone history parsing (parseHistory on a fixed external history):",
    "  source: fixed JSON text with 5 hashless entries (the PUBLISH..BEGIN_REVIEW chain that opens DEMO-001, fixed timestamps; no TaskLifecycle instance involved)",
  );
  for (const entry of parsedHistoryEntries) {
    lines.push(
      `  entry seq ${entry.seq}: ${entry.event} ${entry.from} -> ${entry.to} (actor ${entry.actor}, at ${entry.at})`,
    );
  }
  const parsedHistoryLast = parsedHistoryEntries.at(-1)!;
  lines.push(
    `  parsed: ${parsedHistoryEntries.length} entries, final state ${parsedHistoryLast.to} (last entry seq ${parsedHistoryLast.seq} ${parsedHistoryLast.event} ${parsedHistoryLast.from} -> ${parsedHistoryLast.to})`,
    `  matches DEMO-001 prefix: ${parsedHistoryMatchesMainPrefix} (the parsed seq/event/from/to chain equals the main task history's first 5 entries)`,
    `  invalid copy: parseHistory FAILED — ${parsedHistoryInvalidError} (a broken chain is rejected and the original parse is untouched)`,
  );

  // Transition-table JSON export segment (closing): every segment
  // above either runs tasks through the table or renders it as a
  // Mermaid diagram, but a front-end or docs tool consumes the
  // table itself — as JSON. `transitionTableJson()` is that
  // export: the whole table in declaration order, canonical
  // 2-space JSON with a trailing newline (the exact text the
  // committed snapshot in test/__snapshots__ pins). The demo
  // prints a summary, not the 97-line document: the edge total
  // plus the first, payout, and last edges parsed back from the
  // export text. Hand-written expectations — written out here
  // from the transition table in src/taskLifecycle.ts, never
  // derived by calling transitionTableJson itself (the demo
  // tests cross-check the full parsed edge list against the
  // committed snapshot as well):
  //   19 edges in total
  //   index 0  (first):  DRAFT --PUBLISH--> OPEN
  //   index 14 (payout): PAYOUT_PENDING --PAYOUT_COMPLETE--> PAID
  //   index 18 (last):   DISPUTED --ARBITRATE_REJECT--> REJECTED
  //   every edge carries its keys in from, event, to order
  // The segment is pure: no task instance, no dispatch, no
  // network, no randomness, no wall clock.
  const transitionTableJsonText = transitionTableJson();
  const transitionTableEdges = JSON.parse(
    transitionTableJsonText,
  ) as TransitionEdge[];
  const transitionTableFirst = transitionTableEdges[0]!;
  const transitionTablePayout = transitionTableEdges[14]!;
  const transitionTableLast = transitionTableEdges.at(-1)!;
  const transitionTableKeyOrder = transitionTableEdges.every(
    (edge) => Object.keys(edge).join(",") === "from,event,to",
  );
  lines.push(
    "",
    "Transition table JSON export (transitionTableJson for front-end / docs tooling):",
    `  transitionTableJson(): ${transitionTableEdges.length} edges as canonical JSON (2-space indent, trailing newline; parsed back: ${transitionTableEdges.length} edges)`,
    `  first edge (index 0): ${transitionTableFirst.from} --${transitionTableFirst.event}--> ${transitionTableFirst.to}`,
    `  payout edge (index 14): ${transitionTablePayout.from} --${transitionTablePayout.event}--> ${transitionTablePayout.to}`,
    `  last edge (index ${transitionTableEdges.length - 1}): ${transitionTableLast.from} --${transitionTableLast.event}--> ${transitionTableLast.to}`,
    `  key order per edge: from, event, to on every edge: ${transitionTableKeyOrder} (the canonical field order a consumer can rely on)`,
  );

  // State diagram generation segment (closing): the segment above
  // exports the table as JSON for tooling; this one renders it the
  // way a reader actually sees it — `stateDiagram()` generates the
  // Mermaid stateDiagram-v2 block from transitionTable() (the
  // single source of truth), the exact block the README embeds
  // verbatim and test/stateDiagram.test.ts guards against drift.
  // The demo prints a summary, not the 24-line block: the line
  // total and edge count plus the first, second, initial,
  // first-edge, last-edge, and last lines. Hand-written
  // expectations — written out here from src/taskLifecycle.ts,
  // never derived by calling stateDiagram itself (the demo tests
  // cross-check the full generated block line by line as well):
  //   24 lines in total, 19 of them edge lines
  //   line 1:  ```mermaid (the opening fence)
  //   line 2:  stateDiagram-v2
  //   line 4:      [*] --> DRAFT (the initial transition)
  //   line 5:      DRAFT --> OPEN : PUBLISH (the first edge)
  //   line 23:     DISPUTED --> REJECTED : ARBITRATE_REJECT (last edge)
  //   line 24: ``` (the closing fence)
  // The edge-line count must equal the transition table's edge
  // count — the same 19 the committed snapshot pins — and the
  // segment asserts that here, outside the printed summary: a
  // diagram whose shape broke would fail the demo itself, not
  // just a test. The segment is pure: no task instance, no
  // dispatch, no network, no randomness, no wall clock.
  const stateDiagramText = stateDiagram();
  const stateDiagramLines = stateDiagramText.split("\n");
  const stateDiagramEdgeLines = stateDiagramLines.slice(4, -1);
  const stateDiagramEdgeCount = stateDiagramEdgeLines.length;
  if (
    stateDiagramLines[0] !== "```mermaid" ||
    !stateDiagramText.includes("stateDiagram-v2") ||
    stateDiagramEdgeCount !== transitionTable().length
  ) {
    throw new Error(
      "demo fixture broken: stateDiagram() output does not have the pinned shape (mermaid fence, stateDiagram-v2 header, one edge line per transition-table edge)",
    );
  }
  lines.push(
    "",
    "State diagram generation (stateDiagram from the transition table):",
    `  stateDiagram(): ${stateDiagramLines.length} lines, ${stateDiagramEdgeCount} edges (generated from transitionTable() — the Mermaid block the README embeds verbatim)`,
    `  first line: ${stateDiagramLines[0]}`,
    `  second line: ${stateDiagramLines[1]}`,
    `  initial transition (line 4): ${stateDiagramLines[3].trim()}`,
    `  first edge (line 5): ${stateDiagramEdgeLines[0].trim()}`,
    `  last edge (line ${stateDiagramLines.length - 1}): ${stateDiagramEdgeLines.at(-1)!.trim()}`,
    `  last line: ${stateDiagramLines.at(-1)}`,
  );

  // README diagram sync check segment (closing): the segment
  // above generates the diagram block; this one reports the
  // conclusion the whole docs-drift guard exists for —
  // `readmeDiagramInSync()` (imported directly from
  // src/diagram.ts, as the benchmark does — it is not
  // re-exported from the package entry) reads this repo's
  // README.md and returns true iff it embeds the exact
  // generated block. Hand-written expectation — written out
  // here from the state the test suite pins, never derived by
  // calling readmeDiagramInSync itself:
  //   - the return value is exactly true: test/diagram.test.ts
  //     runs the CLI `--check` form of this same function and
  //     requires the in-sync outcome, and
  //     test/stateDiagram.test.ts asserts the README embeds
  //     the exact generated diagram (no drift). A drifted
  //     README would fail the test suite before it could fail
  //     here, so true is the only expectation consistent with
  //     a green suite.
  // The segment asserts that here, outside the printed
  // verdict: a drifted README would fail the demo itself, not
  // just a test. The only file read is this repo's README.md;
  // no network, no randomness, no wall clock.
  const readmeDiagramInSyncValue = readmeDiagramInSync();
  if (readmeDiagramInSyncValue !== true) {
    throw new Error(
      "demo fixture broken: readmeDiagramInSync() returned false — README.md diagram drifted from stateDiagram()",
    );
  }
  lines.push(
    "",
    "README diagram sync check (readmeDiagramInSync on this repo's README):",
    `  readmeDiagramInSync(): ${readmeDiagramInSyncValue} (README.md embeds the exact stateDiagram() block generated above — no diagram drift)`,
    "  checked file: README.md (this repo only — the sole file read by the check; no network, no wall clock)",
    "  CLI equivalent: node dist/src/diagram.js --check (exit 0 in sync, exit 1 on drift — the same check test/diagram.test.ts runs)",
  );

  // JSON snapshot round-trip segment (closing): every segment
  // above either drives the main task or reads its history back
  // through the NDJSON / history-only paths; the persistence
  // path a real deployment uses — the snapshot envelope — never
  // appeared. Here the main task is exported with `toJSON()`,
  // serialized with `JSON.stringify` (the exact detached
  // plain-JSON text a document store would persist), parsed
  // back, and restored with `TaskLifecycle.fromJSON()` — the
  // untrusted-snapshot reader, which re-validates the envelope
  // (schema version, seq continuity, from/to chain, legal
  // edges, canonical timestamps, hash chain) before rebuilding.
  // Hand-written expectations — written out here from the main
  // task's construction at the top of this demo, never derived
  // by calling toJSON/fromJSON themselves:
  //   - the snapshot carries v 1, id DEMO-001, state PAID, and
  //     exactly 12 history entries;
  //   - maxResubmits 2 is stored in the envelope (the demo set
  //     a finite budget of 2); the used count is NOT stored —
  //     it is derived from the history on both sides, and the
  //     main history holds exactly 1 RESUBMIT entry, so the
  //     used count reads 1 of 2 before and after the trip;
  //   - the restored task's state and full history equal the
  //     original's entry for entry (compared through the
  //     canonical NDJSON serialization, hashes included);
  //   - re-exporting the restored task yields the identical
  //     snapshot content at the same serialized byte length —
  //     the round-trip is a fixed point. (The JSON text is not
  //     string-identical: fromJSON's sanitizer rebuilds each
  //     history entry in canonical field order, so `prevHash`
  //     moves after `note`; every value and hash is unchanged,
  //     which the demo tests pin with a deep equality check.)
  // The serialized byte count is exact on every run: the only
  // fields that vary between runs (the main task's wall-clock
  // timestamps and the hashes computed over them) are
  // fixed-length, so the total never moves. The segment
  // asserts all of this here, outside the printed lines: a
  // snapshot that lost fidelity would fail the demo itself,
  // not just a test. No network, no randomness, and no new
  // wall clock is read — the segment only serializes the main
  // task's existing state.
  const snapshot = task.toJSON();
  const snapshotJsonText = JSON.stringify(snapshot);
  const snapshotBytes = new TextEncoder().encode(snapshotJsonText).length;
  const restoredTask = TaskLifecycle.fromJSON(
    JSON.parse(snapshotJsonText) as unknown,
  );
  const resubmitUsedOf = (t: TaskLifecycle): number =>
    t.history.filter((entry) => entry.event === "RESUBMIT").length;
  const snapshotResubmitUsed = resubmitUsedOf(task);
  const restoredResubmitUsed = resubmitUsedOf(restoredTask);
  const restoredSnapshot = restoredTask.toJSON();
  const restoredJsonText = JSON.stringify(restoredSnapshot);
  const restoredBytes = new TextEncoder().encode(restoredJsonText).length;
  const snapshotRoundTripMatches =
    restoredTask.id === task.id &&
    restoredTask.state === task.state &&
    historyToNdjson(restoredTask) === historyToNdjson(task);
  const snapshotFixedPoint =
    restoredSnapshot.v === snapshot.v &&
    restoredSnapshot.id === snapshot.id &&
    restoredSnapshot.state === snapshot.state &&
    restoredSnapshot.maxResubmits === snapshot.maxResubmits &&
    JSON.stringify(restoredSnapshot.slaDeadlines) ===
      JSON.stringify(snapshot.slaDeadlines) &&
    snapshotRoundTripMatches &&
    restoredBytes === snapshotBytes;
  if (
    snapshot.v !== 1 ||
    snapshot.id !== "DEMO-001" ||
    snapshot.state !== "PAID" ||
    snapshot.history.length !== 12 ||
    snapshot.maxResubmits !== 2 ||
    !snapshotRoundTripMatches ||
    snapshotResubmitUsed !== 1 ||
    restoredResubmitUsed !== 1 ||
    !snapshotFixedPoint
  ) {
    throw new Error(
      "demo fixture broken: toJSON()/fromJSON() round-trip lost fidelity (snapshot envelope, restored state/history, used RESUBMIT count, or re-export fixed point mismatch)",
    );
  }
  lines.push(
    "",
    "JSON snapshot round-trip (toJSON/fromJSON on the main task):",
    `  toJSON(): snapshot v${snapshot.v} for ${task.id} — state ${snapshot.state}, ${snapshot.history.length} history entries, maxResubmits ${snapshot.maxResubmits} stored (the finite budget travels in the envelope; the used count is derived from the history, never stored)`,
    `  serialized: ${snapshotBytes} bytes (JSON.stringify of the snapshot — the detached plain-JSON form a document store persists)`,
    `  TaskLifecycle.fromJSON(parsed snapshot): state ${restoredTask.state}, ${restoredTask.history.length} history entries — state and full history match the original: ${snapshotRoundTripMatches} (entry for entry, hashes included)`,
    `  RESUBMIT budget: ${snapshotResubmitUsed} of ${snapshot.maxResubmits} used before and after the round-trip (derived from the history on both sides)`,
    `  fixed point: re-exporting the restored task yields the identical snapshot content (${restoredBytes} bytes; fromJSON normalizes history-entry key order — values and hashes unchanged) — a second round-trip changes nothing`,
  );

  // Single-task payout reconciliation detail segment (closing):
  // the reconciliation screening branch above screens a batch —
  // `mismatchedPayouts()` names the tasks whose settled amount
  // disagrees with the quote, but the screen's own line only
  // borrows the detail inline. This segment is the per-task
  // follow-up finance runs next: `payoutMismatch()` on one task
  // at a time. Both tasks come from that branch, every amount a
  // fixed literal hand-pinned in the branch comment above, never
  // derived by calling payoutMismatch itself:
  //   - DEMO-005 (the screen's one mismatched hit): ACCEPT
  //     quotedAmount 4000, PAYOUT_COMPLETE payoutAmount 3750.5,
  //     so the detail is exactly { quoted: 4000, paid: 3750.5,
  //     delta: -249.5 } — delta = paid - quoted rounded to
  //     cents, negative because the task was underpaid;
  //   - DEMO-004 (settled exactly as quoted): ACCEPT
  //     quotedAmount 2500, PAYOUT_COMPLETE payoutAmount 2500,
  //     so payoutMismatch returns undefined — settled as
  //     agreed, no mismatch to report.
  // The segment asserts both shapes here, outside the printed
  // lines: a detail that drifted from the hand-pinned amounts
  // would fail the demo itself, not just a test. The helper is
  // pure — it reads the tasks, never mutates or dispatches —
  // and the segment adds no network, no randomness, and no
  // wall clock (both tasks carry only fixed-literal timestamps).
  const payoutMismatchDetail = payoutMismatch(mismatchedTask);
  const payoutMismatchSettled = payoutMismatch(unreconciledTask);
  if (
    payoutMismatchDetail === undefined ||
    payoutMismatchDetail.quoted !== 4000 ||
    payoutMismatchDetail.paid !== 3750.5 ||
    payoutMismatchDetail.delta !== -249.5 ||
    payoutMismatchSettled !== undefined
  ) {
    throw new Error(
      "demo fixture broken: payoutMismatch() detail does not match the hand-pinned amounts (DEMO-005 quoted 4000 / paid 3750.5 / delta -249.5, DEMO-004 settled exactly as quoted)",
    );
  }
  lines.push(
    "",
    "Single-task payout reconciliation detail (payoutMismatch on the screened tasks):",
    `  DEMO-005: payoutMismatch -> quoted ${payoutMismatchDetail.quoted}, paid ${payoutMismatchDetail.paid}, delta ${payoutMismatchDetail.delta} (underpaid by ${-payoutMismatchDetail.delta} — the batch screen's one mismatched hit, opened up per task)`,
    "  DEMO-004: payoutMismatch -> undefined (quoted 2500, paid 2500 — settled exactly as quoted, so there is no mismatch to report)",
    "  reading the detail: delta = paid - quoted, rounded to cents — negative is an underpayment, positive an overpayment (the per-task follow-up finance runs after mismatchedPayouts flags a task)",
  );

  // Snapshot version envelope segment (closing): the JSON
  // snapshot round-trip segment above shows the envelope
  // travelling, but never the version field that guards it.
  // `toJSON()` always writes `v: SNAPSHOT_VERSION` (1), and
  // `fromJSON()` is fail-closed about any other present version
  // — that gate is what keeps a future format evolution
  // distinguishable from corruption (see
  // test/snapshotVersion.test.ts, which pins the contract this
  // segment presents). Hand-written expectations — written out
  // here from the snapshotVersion tests and the parser source,
  // never derived by calling fromJSON itself:
  //   - the main snapshot (the same `snapshot` the round-trip
  //     segment exported) carries v 1, exactly the imported
  //     SNAPSHOT_VERSION;
  //   - a detached copy retagged v: 2 is rejected with exactly
  //     "invalid snapshot: unsupported snapshot version 2";
  //   - the original snapshot is untouched by that rejection
  //     and still restores DEMO-001 in state PAID.
  // The segment asserts all of this here, outside the printed
  // lines: a version gate that drifted would fail the demo
  // itself, not just a test. No network, no randomness, and no
  // wall clock — the segment only re-reads the main task's
  // existing snapshot and a detached copy of it.
  const snapshotVersion = snapshot.v;
  let snapshotVersionFutureError = "";
  try {
    TaskLifecycle.fromJSON({ ...snapshot, v: 2 });
  } catch (err) {
    snapshotVersionFutureError =
      err instanceof Error ? err.message : String(err);
  }
  const snapshotVersionRestored = TaskLifecycle.fromJSON(snapshot);
  const snapshotVersionRestoredState = snapshotVersionRestored.state;
  if (
    snapshotVersion !== SNAPSHOT_VERSION ||
    snapshotVersion !== 1 ||
    SNAPSHOT_VERSION !== 1 ||
    snapshotVersionFutureError !==
      "invalid snapshot: unsupported snapshot version 2" ||
    snapshotVersionRestored.id !== "DEMO-001" ||
    snapshotVersionRestoredState !== "PAID" ||
    snapshotVersionRestored.history.length !== 12
  ) {
    throw new Error(
      "demo fixture broken: SNAPSHOT_VERSION envelope does not match the hand-pinned contract (snapshot v must equal SNAPSHOT_VERSION 1, the v: 2 copy must be rejected with the version error, and the original snapshot must still restore DEMO-001 in PAID)",
    );
  }
  lines.push(
    "",
    "Snapshot version envelope (SNAPSHOT_VERSION on the main task snapshot):",
    `  toJSON(): snapshot v is ${snapshotVersion} — equals SNAPSHOT_VERSION ${SNAPSHOT_VERSION} (the current snapshot schema version written on every export)`,
    `  future version: TaskLifecycle.fromJSON(snapshot with v: 2) rejected — ${snapshotVersionFutureError} (a future format is refused, not silently misread)`,
    `  original snapshot: TaskLifecycle.fromJSON(snapshot with v: ${snapshotVersion}) still restores ${snapshotVersionRestored.id} in state ${snapshotVersionRestoredState} (the rejection touched only the detached copy)`,
  );

  // Note length limit segment (closing): dispatch notes are
  // written verbatim into the append-only audit history and
  // serialized by every export, so `dispatch()` caps them at
  // MAX_NOTE_LENGTH (32768) — an oversized note would
  // permanently inflate the persisted log. That guard has
  // dedicated tests (see test/actorNoteHardening.test.ts,
  // which pins the contract this segment presents) but has
  // never been shown. A dedicated task (DEMO-017) is driven
  // under fixed timestamps (no network, no randomness, no
  // wall clock): a PUBLISH dispatch whose note is a fixed
  // filler string of exactly the limit length succeeds, and
  // only the note's length is printed — never the note
  // itself. A following ACCEPT dispatch whose note is one
  // character over is rejected before anything mutates.
  // Hand-written expectations — written out here from the
  // taskLifecycle source and the hardening tests, never
  // derived by calling dispatch itself:
  //   - MAX_NOTE_LENGTH is 32768;
  //   - the boundary dispatch succeeds: DEMO-017 lands in
  //     OPEN with exactly 1 history entry whose stored note
  //     length is 32768;
  //   - the over-limit dispatch is rejected with exactly
  //     "invalid dispatch options: note must be at most
  //     32768 characters, got 32769";
  //   - after the rejection the task is still in OPEN with
  //     1 history entry (no state change, no history entry,
  //     no seq gap).
  // The segment asserts all of this here, outside the
  // printed lines: a length guard that drifted would fail
  // the demo itself, not just a test.
  const noteLimitTask = new TaskLifecycle("DEMO-017");
  const noteLengthLimit = MAX_NOTE_LENGTH;
  const noteLimitBoundaryNote = "x".repeat(noteLengthLimit);
  const noteLimitBoundaryLength = noteLimitBoundaryNote.length;
  noteLimitTask.dispatch("PUBLISH", {
    actor: "researcher",
    note: noteLimitBoundaryNote,
    at: "2026-03-23T09:00:00.000Z",
  });
  const noteLimitBoundaryState = noteLimitTask.state;
  const noteLimitBoundaryHistoryLength = noteLimitTask.history.length;
  const noteLimitBoundaryStoredLength =
    noteLimitTask.history[0]?.note?.length ?? -1;
  const noteLimitOverLength = noteLengthLimit + 1;
  let noteLimitError = "";
  try {
    noteLimitTask.dispatch("ACCEPT", {
      actor: "contributor",
      note: "x".repeat(noteLimitOverLength),
      at: "2026-03-23T09:05:00.000Z",
    });
  } catch (err) {
    noteLimitError = err instanceof Error ? err.message : String(err);
  }
  const noteLimitStateAfter = noteLimitTask.state;
  const noteLimitHistoryLengthAfter = noteLimitTask.history.length;
  if (
    noteLengthLimit !== 32768 ||
    noteLimitBoundaryLength !== 32768 ||
    noteLimitBoundaryState !== "OPEN" ||
    noteLimitBoundaryHistoryLength !== 1 ||
    noteLimitBoundaryStoredLength !== 32768 ||
    noteLimitOverLength !== 32769 ||
    noteLimitError !==
      "invalid dispatch options: note must be at most 32768 characters, got 32769" ||
    noteLimitStateAfter !== "OPEN" ||
    noteLimitHistoryLengthAfter !== 1 ||
    noteLimitTask.history[0]?.seq !== 1
  ) {
    throw new Error(
      "demo fixture broken: MAX_NOTE_LENGTH guard does not match the hand-pinned contract (a 32768-character note must be accepted with one history entry, and a 32769-character note must be rejected with the length error and leave state and history untouched)",
    );
  }
  lines.push(
    "",
    "Note length limit (MAX_NOTE_LENGTH on dispatch notes):",
    `  limit: MAX_NOTE_LENGTH is ${noteLengthLimit} characters (a note is written verbatim into the append-only audit history, so an oversized note would permanently inflate every export)`,
    `  at the limit: dispatch PUBLISH with a ${noteLimitBoundaryLength}-character note succeeded — ${noteLimitTask.id} in state ${noteLimitBoundaryState}, history ${noteLimitBoundaryHistoryLength} entry, stored note length ${noteLimitBoundaryStoredLength} (the note itself is not printed, only its length)`,
    `  over the limit: dispatch ACCEPT with a ${noteLimitOverLength}-character note rejected — ${noteLimitError} (rejected before anything mutates)`,
    `  after the rejection: ${noteLimitTask.id} still in state ${noteLimitStateAfter} with ${noteLimitHistoryLengthAfter} history entry (the oversized dispatch left no trace — no state change, no history entry, no seq gap)`,
  );

  // Standalone overdue judgement segment (closing): the SLA
  // watchdog branches above show the batch screens built on
  // `isOverdue` (`expiredTasks` / `expireOverdueTasks`), and
  // the stale branch prints it only as an inline column, but
  // the predicate's own boundary semantics have never been
  // shown on their own (see test/sla.test.ts and the bench's
  // `checkIsOverdue`, which pin the contract this segment
  // presents). Three dedicated tasks are driven under fixed
  // timestamps (no network, no randomness, no wall clock):
  // DEMO-018 sits in ACCEPTED with an ACCEPTED-state deadline,
  // DEMO-019 sits in ACCEPTED with no deadline at all, and
  // DEMO-020 is ABANDONED (terminal) with an ABANDONED-state
  // deadline. Hand-written expectations — written out here
  // from the `isOverdue` source and the SLA tests, never
  // derived by calling isOverdue itself:
  //   - DEMO-018 one hour before its deadline -> false;
  //   - DEMO-018 exactly at its deadline -> true (the
  //     boundary is inclusive: `now >= deadline`);
  //   - DEMO-018 one hour after its deadline -> true;
  //   - DEMO-019 (no deadline) after that instant -> false;
  //   - DEMO-020 (terminal) after its deadline -> false.
  // The segment asserts all of this here, outside the
  // printed lines: a judgement that drifted would fail the
  // demo itself, not just a test. The predicate is advisory
  // and pure — no task is dispatched or mutated by it, so
  // DEMO-018 is still ACCEPTED when the segment ends.
  const overdueStandaloneDeadline = "2026-03-24T09:00:00.000Z";
  const overdueStandaloneTask = new TaskLifecycle("DEMO-018");
  overdueStandaloneTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-03-24T07:00:00.000Z",
  });
  overdueStandaloneTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-03-24T07:05:00.000Z",
  });
  overdueStandaloneTask.setSlaDeadline(overdueStandaloneDeadline);
  const overdueStandaloneNoDeadlineTask = new TaskLifecycle("DEMO-019");
  overdueStandaloneNoDeadlineTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-03-24T07:00:00.000Z",
  });
  overdueStandaloneNoDeadlineTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-03-24T07:05:00.000Z",
  });
  const overdueStandaloneTerminalTask = new TaskLifecycle("DEMO-020");
  overdueStandaloneTerminalTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-03-24T07:00:00.000Z",
  });
  overdueStandaloneTerminalTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-03-24T07:05:00.000Z",
  });
  overdueStandaloneTerminalTask.dispatch("ABANDON", {
    actor: "contributor",
    at: "2026-03-24T07:10:00.000Z",
  });
  overdueStandaloneTerminalTask.setSlaDeadline(
    overdueStandaloneDeadline,
    "ABANDONED",
  );
  const overdueBeforeAt = new Date("2026-03-24T08:00:00.000Z");
  const overdueAtAt = new Date(overdueStandaloneDeadline);
  const overdueAfterAt = new Date("2026-03-24T10:00:00.000Z");
  const overdueStandaloneVerdicts: boolean[] = [
    isOverdue(overdueStandaloneTask, overdueBeforeAt),
    isOverdue(overdueStandaloneTask, overdueAtAt),
    isOverdue(overdueStandaloneTask, overdueAfterAt),
    isOverdue(overdueStandaloneNoDeadlineTask, overdueAfterAt),
    isOverdue(overdueStandaloneTerminalTask, overdueAfterAt),
  ];
  if (
    overdueStandaloneTask.getSlaDeadline("ACCEPTED") !==
      overdueStandaloneDeadline ||
    overdueStandaloneNoDeadlineTask.getSlaDeadline("ACCEPTED") !==
      undefined ||
    overdueStandaloneTerminalTask.getSlaDeadline("ABANDONED") !==
      overdueStandaloneDeadline ||
    overdueStandaloneVerdicts.length !== 5 ||
    overdueStandaloneVerdicts[0] !== false ||
    overdueStandaloneVerdicts[1] !== true ||
    overdueStandaloneVerdicts[2] !== true ||
    overdueStandaloneVerdicts[3] !== false ||
    overdueStandaloneVerdicts[4] !== false ||
    overdueStandaloneTask.state !== "ACCEPTED" ||
    overdueStandaloneTask.history.length !== 2 ||
    overdueStandaloneNoDeadlineTask.state !== "ACCEPTED" ||
    overdueStandaloneTerminalTask.state !== "ABANDONED" ||
    overdueStandaloneTerminalTask.history.length !== 3
  ) {
    throw new Error(
      "demo fixture broken: isOverdue judgement does not match the hand-pinned contract (before the deadline must be false, exactly at and after it true, and no-deadline and terminal tasks false, with no task mutated by the judgement)",
    );
  }
  lines.push(
    "",
    "Standalone overdue judgement (isOverdue on fixed tasks):",
    `  before the deadline: ${overdueStandaloneTask.id} (ACCEPTED, deadline ${overdueStandaloneDeadline}) at ${overdueBeforeAt.toISOString()} -> isOverdue: ${overdueStandaloneVerdicts[0]} (the deadline has not yet been reached)`,
    `  exactly at the deadline: ${overdueStandaloneTask.id} at ${overdueAtAt.toISOString()} -> isOverdue: ${overdueStandaloneVerdicts[1]} (the boundary is inclusive — now >= deadline)`,
    `  after the deadline: ${overdueStandaloneTask.id} at ${overdueAfterAt.toISOString()} -> isOverdue: ${overdueStandaloneVerdicts[2]} (past the deadline and still non-terminal)`,
    `  no deadline set: ${overdueStandaloneNoDeadlineTask.id} (ACCEPTED, no SLA deadline) at ${overdueAfterAt.toISOString()} -> isOverdue: ${overdueStandaloneVerdicts[3]} (a task with no deadline is never overdue)`,
    `  terminal state: ${overdueStandaloneTerminalTask.id} (ABANDONED, deadline ${overdueStandaloneDeadline}) at ${overdueAfterAt.toISOString()} -> isOverdue: ${overdueStandaloneVerdicts[4]} (a finished task is no longer overdue, even past its deadline)`,
  );

  // Terminal-state judgement segment (closing): every branch
  // above shows terminality only as an aside — the instance
  // getter in a branch's `(terminal: …)` final line — and the
  // allowed-events listing shows its consequence (the empty
  // list) without ever naming the standalone predicate or
  // presenting the full terminal set at once. Here
  // `isTerminal(state)` is called over all 13 states in
  // transition-table declaration order (the `ALL_STATES` list
  // the allowed-events segment built) and every verdict is
  // printed with that state's outgoing-edge count. The
  // function is pure: no task instance, no dispatch, no
  // network, no randomness, no wall clock. Hand-written
  // expectations — written out here from the TERMINAL set in
  // src/taskLifecycle.ts and the isTerminal tests, never
  // derived by calling isTerminal itself:
  //   DRAFT          -> false (1 outgoing edge)
  //   OPEN           -> false (2 outgoing edges)
  //   ACCEPTED       -> false (3 outgoing edges)
  //   CAPTURING      -> false (3 outgoing edges)
  //   SUBMITTED      -> false (2 outgoing edges)
  //   IN_REVIEW      -> false (2 outgoing edges)
  //   APPROVED       -> false (1 outgoing edge)
  //   PAYOUT_PENDING -> false (1 outgoing edge)
  //   PAID           -> true  (terminal, 0 outgoing edges)
  //   REJECTED       -> false (2 outgoing edges)
  //   DISPUTED       -> false (2 outgoing edges)
  //   ABANDONED      -> true  (terminal, 0 outgoing edges)
  //   EXPIRED        -> true  (terminal, 0 outgoing edges)
  // The outgoing counts are the transition table's own shape
  // (19 edges in total), and the segment cross-checks the two
  // views against each other outside the printed lines: the
  // isTerminal set must equal, state for state, the set of
  // states with no outgoing edge in `transitionTable()`, and
  // the states enumerated from the table (every edge's from
  // and to) must be exactly the 13 listed. A judgement that
  // drifted from either view would fail the demo itself, not
  // just a test.
  const terminalExpected: Record<TaskState, boolean> = {
    DRAFT: false,
    OPEN: false,
    ACCEPTED: false,
    CAPTURING: false,
    SUBMITTED: false,
    IN_REVIEW: false,
    APPROVED: false,
    PAYOUT_PENDING: false,
    PAID: true,
    REJECTED: false,
    DISPUTED: false,
    ABANDONED: true,
    EXPIRED: true,
  };
  const outgoingExpected: Record<TaskState, number> = {
    DRAFT: 1,
    OPEN: 2,
    ACCEPTED: 3,
    CAPTURING: 3,
    SUBMITTED: 2,
    IN_REVIEW: 2,
    APPROVED: 1,
    PAYOUT_PENDING: 1,
    PAID: 0,
    REJECTED: 2,
    DISPUTED: 2,
    ABANDONED: 0,
    EXPIRED: 0,
  };
  const terminalEdges = transitionTable();
  const enumeratedStates = new Set<TaskState>();
  for (const edge of terminalEdges) {
    enumeratedStates.add(edge.from);
    enumeratedStates.add(edge.to);
  }
  const outgoingCounts = new Map<TaskState, number>(
    ALL_STATES.map((state) => [state, 0]),
  );
  for (const edge of terminalEdges) {
    outgoingCounts.set(edge.from, (outgoingCounts.get(edge.from) ?? 0) + 1);
  }
  const terminalByState = ALL_STATES.map((state) => ({
    state,
    terminal: isTerminal(state),
  }));
  const terminalStates = terminalByState
    .filter(({ terminal }) => terminal)
    .map(({ state }) => state);
  const noOutEdgeStates = ALL_STATES.filter(
    (state) => (outgoingCounts.get(state) ?? 0) === 0,
  );
  const terminalCrossCheckMatches =
    terminalStates.length === noOutEdgeStates.length &&
    terminalStates.every((state, i) => state === noOutEdgeStates[i]);
  if (
    ALL_STATES.length !== 13 ||
    enumeratedStates.size !== 13 ||
    !ALL_STATES.every((state) => enumeratedStates.has(state)) ||
    terminalEdges.length !== 19 ||
    terminalByState.length !== 13 ||
    !terminalByState.every(
      ({ state, terminal }) => terminal === terminalExpected[state],
    ) ||
    !ALL_STATES.every(
      (state) => outgoingCounts.get(state) === outgoingExpected[state],
    ) ||
    terminalStates.join(",") !== "PAID,ABANDONED,EXPIRED" ||
    !terminalCrossCheckMatches ||
    isTerminal(task.state) !== true ||
    task.isTerminal !== true
  ) {
    throw new Error(
      "demo fixture broken: isTerminal judgement does not match the hand-pinned contract (only PAID / ABANDONED / EXPIRED are terminal, the terminal set must equal the transition table's no-outgoing-edge set, and the main task's PAID state must read terminal both ways)",
    );
  }
  lines.push(
    "",
    "Terminal-state judgement (isTerminal over all 13 states):",
  );
  for (const { state, terminal } of terminalByState) {
    const outgoing = outgoingCounts.get(state) ?? 0;
    lines.push(
      terminal
        ? `  ${state.padEnd(15)} -> isTerminal: true (terminal — 0 outgoing edges in transitionTable())`
        : `  ${state.padEnd(15)} -> isTerminal: false (${outgoing} outgoing edge${outgoing === 1 ? "" : "s"} in transitionTable())`,
    );
  }
  lines.push(
    `  terminal states: ${terminalStates.join(", ")} (${terminalStates.length} of ${ALL_STATES.length} states)`,
    `  cross-check: the isTerminal set equals the transition table's no-outgoing-edge set (${noOutEdgeStates.join(", ")}): ${terminalCrossCheckMatches} (every terminal state has no outgoing edges, and every state with no outgoing edges is terminal)`,
    `  main task ${task.id} (${task.state}): isTerminal: ${isTerminal(task.state)} (the standalone function and the instance getter agree — a finished task offers no further events)`,
  );

  // SLA deadline clearing segment (closing): every SLA branch
  // above sets deadlines and judges overdue, but never shows a
  // deadline being revoked — yet `clearSlaDeadline` is the only
  // clearing entry point (per-state, or all states with no
  // argument), and a renegotiated / cancelled deadline is exactly
  // the case a watchdog must stop acting on. One dedicated task
  // is driven under fixed timestamps (no network, no randomness,
  // no wall clock): DEMO-021 sits in ACCEPTED carrying three
  // fixed deadlines — ACCEPTED 2026-03-25T09:00:00.000Z,
  // CAPTURING 2026-03-26T09:00:00.000Z, SUBMITTED
  // 2026-03-27T09:00:00.000Z — so at the fixed screening instant
  // 2026-03-25T10:00:00.000Z it is overdue on its current state.
  // Hand-written expectations — written out here from the
  // clearSlaDeadline source and the SLA tests, never derived by
  // calling the clearing methods themselves:
  //   - before clearing -> isOverdue true;
  //   - clearSlaDeadline("ACCEPTED") -> getSlaDeadline("ACCEPTED")
  //     is undefined and isOverdue at the same instant turns
  //     false, while CAPTURING / SUBMITTED read back untouched;
  //   - clearSlaDeadline() with no argument -> all three states
  //     read back undefined.
  // Clearing is configuration, not a dispatch: the task stays in
  // ACCEPTED with its 2 history entries throughout. The segment
  // asserts all of this here, outside the printed lines: a
  // clearing semantic that drifted would fail the demo itself,
  // not just a test.
  const slaClearDeadline = "2026-03-25T09:00:00.000Z";
  const slaClearOtherDeadlines = [
    "2026-03-26T09:00:00.000Z",
    "2026-03-27T09:00:00.000Z",
  ];
  const slaClearNow = new Date("2026-03-25T10:00:00.000Z");
  const slaClearTask = new TaskLifecycle("DEMO-021");
  slaClearTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-03-25T07:00:00.000Z",
  });
  slaClearTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-03-25T07:05:00.000Z",
  });
  slaClearTask.setSlaDeadline(slaClearDeadline);
  slaClearTask.setSlaDeadline(slaClearOtherDeadlines[0], "CAPTURING");
  slaClearTask.setSlaDeadline(slaClearOtherDeadlines[1], "SUBMITTED");
  const slaClearOverdueBefore = isOverdue(slaClearTask, slaClearNow);
  slaClearTask.clearSlaDeadline("ACCEPTED");
  const slaClearAcceptedAfterStateClear =
    slaClearTask.getSlaDeadline("ACCEPTED");
  const slaClearOverdueAfterStateClear = isOverdue(slaClearTask, slaClearNow);
  const slaClearOthersAfterStateClear: Array<string | undefined> = [
    slaClearTask.getSlaDeadline("CAPTURING"),
    slaClearTask.getSlaDeadline("SUBMITTED"),
  ];
  slaClearTask.clearSlaDeadline();
  const slaClearAfterAllClear: Array<string | undefined> = [
    slaClearTask.getSlaDeadline("ACCEPTED"),
    slaClearTask.getSlaDeadline("CAPTURING"),
    slaClearTask.getSlaDeadline("SUBMITTED"),
  ];
  if (
    slaClearOverdueBefore !== true ||
    slaClearAcceptedAfterStateClear !== undefined ||
    slaClearOverdueAfterStateClear !== false ||
    slaClearOthersAfterStateClear[0] !== slaClearOtherDeadlines[0] ||
    slaClearOthersAfterStateClear[1] !== slaClearOtherDeadlines[1] ||
    slaClearAfterAllClear.length !== 3 ||
    slaClearAfterAllClear.some((d) => d !== undefined) ||
    slaClearTask.state !== "ACCEPTED" ||
    slaClearTask.history.length !== 2
  ) {
    throw new Error(
      "demo fixture broken: clearSlaDeadline does not match the hand-pinned contract (before clearing the task must be overdue, clearing ACCEPTED must read back undefined and turn the verdict false while leaving the other states untouched, and clearing with no argument must clear every state, with no dispatch or history change)",
    );
  }
  lines.push(
    "",
    "SLA deadline clearing (clearSlaDeadline on a fixed task):",
    `  before clearing: ${slaClearTask.id} (ACCEPTED, ACCEPTED deadline ${slaClearDeadline}) at ${slaClearNow.toISOString()} -> isOverdue: ${slaClearOverdueBefore} (past its ACCEPTED deadline; CAPTURING and SUBMITTED also carry deadlines)`,
    `  clear one state: clearSlaDeadline("ACCEPTED") -> getSlaDeadline("ACCEPTED"): ${slaClearAcceptedAfterStateClear}, isOverdue at the same instant: ${slaClearOverdueAfterStateClear} (a renegotiated or cancelled deadline no longer makes the task overdue)`,
    `  other states untouched: getSlaDeadline("CAPTURING"): ${slaClearOthersAfterStateClear[0]}, getSlaDeadline("SUBMITTED"): ${slaClearOthersAfterStateClear[1]} (clearing one state leaves the other states' deadlines in place)`,
    `  clear all states: clearSlaDeadline() with no argument -> getSlaDeadline("ACCEPTED"): ${slaClearAfterAllClear[0]}, getSlaDeadline("CAPTURING"): ${slaClearAfterAllClear[1]}, getSlaDeadline("SUBMITTED"): ${slaClearAfterAllClear[2]} (every state's deadline is cleared)`,
  );

  // Single-target payout webhook delivery segment (closing):
  // every delivery shown so far fanned one event out to many
  // endpoints (`deliverPayoutWebhookToMany`); the single-endpoint
  // entry point `deliverPayoutWebhook` — the one a lone receiver
  // integration actually calls — has never appeared in the demo.
  // Here the main task's signed webhook (built and verified
  // above) is delivered on its own to one fixed endpoint through
  // an injected fake fetch scripted to answer 500 on the first
  // attempt and 200 on the retry — zero real network. An injected
  // no-op sleepImpl plus backoffMs 0 mean the retry never really
  // waits, so no wall clock is waited on either. Hand-written
  // expectations — written out here from the delivery source and
  // the delivery tests, never derived by calling
  // deliverPayoutWebhook itself:
  //   - the result is { ok: true, attempts: 2, status: 200 }
  //     with no error (a 500 is retryable, the retry succeeds);
  //   - the fake fetch sees exactly 2 POSTs to the fixed
  //     endpoint, with byte-identical bodies (a retry re-POSTs
  //     the same signed body under the same eventId) and the
  //     webhook's own signature on both;
  //   - the captured wire body verifies under the demo secret
  //     with verifyPayoutWebhook — the receiver-side check on
  //     exactly the bytes that crossed the wire.
  // Retry-After semantics: had the first answer been a 429 with
  // a Retry-After header, the parsed hint (clamped to
  // maxRetryDelayMs) would have set the retry's delay; a 500
  // falls back to exponential backoff — here backoffMs 0, so the
  // recorded sleep is 0 ms. The segment asserts all of this
  // here, outside the printed lines: a delivery semantic that
  // drifted would fail the demo itself, not just a test.
  const singleDeliveryEndpoint = "https://payouts.example.com/hooks/payout";
  const singleDeliveryCalls: FanoutCall[] = [];
  let singleDeliveryAttempt = 0;
  const singleDeliveryFetch: PayoutWebhookFetchImpl = async (url, init) => {
    singleDeliveryCalls.push({
      url,
      body: String(init.body ?? ""),
      signature: String(
        new Headers(init.headers).get("x-hub-signature-256") ?? "",
      ),
    });
    singleDeliveryAttempt += 1;
    return new Response("{}", {
      status: singleDeliveryAttempt === 1 ? 500 : 200,
    });
  };
  const singleDeliveryResult = await deliverPayoutWebhook(
    singleDeliveryEndpoint,
    webhook,
    {
      fetchImpl: singleDeliveryFetch,
      sleepImpl: async () => {},
      backoffMs: 0,
    },
  );
  const singleDeliveryBodyVerifies =
    singleDeliveryCalls.length > 0 &&
    verifyPayoutWebhook(
      singleDeliveryCalls[0].body,
      singleDeliveryCalls[0].signature,
      DEMO_WEBHOOK_SECRET,
    );
  if (
    singleDeliveryResult.ok !== true ||
    singleDeliveryResult.attempts !== 2 ||
    singleDeliveryResult.status !== 200 ||
    singleDeliveryResult.error !== undefined ||
    singleDeliveryCalls.length !== 2 ||
    singleDeliveryCalls.some((c) => c.url !== singleDeliveryEndpoint) ||
    singleDeliveryCalls[0].body !== singleDeliveryCalls[1].body ||
    singleDeliveryCalls[0].signature !== webhook.signature ||
    singleDeliveryCalls[1].signature !== webhook.signature ||
    singleDeliveryCalls[0].body !== JSON.stringify(webhook.payload) ||
    !singleDeliveryBodyVerifies
  ) {
    throw new Error(
      "demo fixture broken: deliverPayoutWebhook single-target delivery does not match the hand-pinned contract (a scripted 500 then 200 must report ok with 2 attempts and status 200, both wire calls must carry the byte-identical signed body and the webhook signature, and the captured wire body must verify under the demo secret)",
    );
  }
  lines.push(
    "",
    "Single-target payout webhook delivery (deliverPayoutWebhook to 1 endpoint, fake fetch — no real network):",
    `  endpoint: ${singleDeliveryEndpoint} (the main task's signed payout webhook, delivered on its own — no fan-out)`,
    `  delivery: ok attempts=${singleDeliveryResult.attempts} status=${singleDeliveryResult.status} (the first attempt answered 500 and the retry succeeded; a 429 Retry-After hint would have set that retry's delay, clamped to maxRetryDelayMs — the 500 fell back to exponential backoff, here backoffMs 0 with a no-op sleep, so nothing really waited)`,
    `  wire check: ${singleDeliveryCalls.length} POSTs captured with byte-identical bodies: ${singleDeliveryCalls[0].body === singleDeliveryCalls[1].body} (a retry re-POSTs the same signed body under the same eventId, so a receiver deduplicates it)`,
    `  signature check: verifyPayoutWebhook over the captured wire body: ${singleDeliveryBodyVerifies} (the X-Hub-Signature-256 header captured on the wire verifies under the demo secret)`,
  );

  // Subscribe onError error routing segment (closing): the
  // subscription branch near the middle showed a collecting
  // listener that never fails; a listener that DOES throw is
  // isolated by subscribe() — the error is swallowed so dispatch
  // and the audit trail are unaffected — but without an
  // `onError` hook that failure is silent. Here a dedicated task
  // carries a listener that throws a fixed error on every
  // notification, subscribed with a collecting `onError` hook,
  // and runs a short chain under fixed literals (2026-03-23; no
  // network, no randomness, no wall clock). Hand-written
  // expectations — written out here from the subscribe source
  // and the subscribeOnError tests, never derived by calling
  // the routing itself:
  //   - all 3 dispatches return normally (OPEN, ACCEPTED,
  //     CAPTURING) and the task lands in CAPTURING with all 3
  //     audit entries intact, in chain order;
  //   - `onError` receives exactly 3 reports, each carrying the
  //     thrown error's message ("demo listener failure") and
  //     the dispatch context (event / from / to) of the chain
  //     step that was being notified;
  //   - on a separate probe task (DEMO-023, verified here and
  //     not printed), an `onError` hook that itself throws is
  //     swallowed too: both its dispatches return normally and
  //     its history holds both entries.
  // The segment asserts all of this here, outside the printed
  // lines: a routing semantic that drifted would fail the demo
  // itself, not just a test.
  const onErrorTask = new TaskLifecycle("DEMO-022");
  const onErrorReports: ListenerErrorReport[] = [];
  onErrorTask.subscribe(
    () => {
      throw new Error("demo listener failure");
    },
    {
      onError: (err, ctx) => {
        onErrorReports.push({
          message: err instanceof Error ? err.message : String(err),
          event: ctx.event,
          from: ctx.from,
          to: ctx.to,
        });
      },
    },
  );
  const onErrorDispatchResults: TaskState[] = [];
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-03-23T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-03-23T09:05:00.000Z"],
    ["START_CAPTURE", "contributor", "2026-03-23T09:10:00.000Z"],
  ] as const) {
    onErrorDispatchResults.push(onErrorTask.dispatch(event, { actor, at }));
  }
  const onErrorProbeTask = new TaskLifecycle("DEMO-023");
  onErrorProbeTask.subscribe(
    () => {
      throw new Error("demo probe listener failure");
    },
    {
      onError: () => {
        throw new Error("demo probe onError failure");
      },
    },
  );
  const onErrorProbeResults: TaskState[] = [
    onErrorProbeTask.dispatch("PUBLISH", {
      actor: "researcher",
      at: "2026-03-23T10:00:00.000Z",
    }),
    onErrorProbeTask.dispatch("ACCEPT", {
      actor: "contributor",
      at: "2026-03-23T10:05:00.000Z",
    }),
  ];
  const ONERROR_EXPECTED: ListenerErrorReport[] = [
    { message: "demo listener failure", event: "PUBLISH", from: "DRAFT", to: "OPEN" },
    { message: "demo listener failure", event: "ACCEPT", from: "OPEN", to: "ACCEPTED" },
    { message: "demo listener failure", event: "START_CAPTURE", from: "ACCEPTED", to: "CAPTURING" },
  ];
  if (
    JSON.stringify(onErrorReports) !== JSON.stringify(ONERROR_EXPECTED) ||
    JSON.stringify(onErrorDispatchResults) !==
      JSON.stringify(["OPEN", "ACCEPTED", "CAPTURING"]) ||
    onErrorTask.state !== "CAPTURING" ||
    onErrorTask.history.length !== 3 ||
    onErrorTask.history.some(
      (h, i) =>
        h.event !== ONERROR_EXPECTED[i].event ||
        h.from !== ONERROR_EXPECTED[i].from ||
        h.to !== ONERROR_EXPECTED[i].to,
    ) ||
    JSON.stringify(onErrorProbeResults) !== JSON.stringify(["OPEN", "ACCEPTED"]) ||
    onErrorProbeTask.state !== "ACCEPTED" ||
    onErrorProbeTask.history.length !== 2
  ) {
    throw new Error(
      "demo fixture broken: subscribe onError routing does not match the hand-pinned contract (a throwing listener must route one report per dispatch with the dispatch context, every dispatch must return normally with the audit history intact, and a throwing onError hook on the probe task must be swallowed too)",
    );
  }
  lines.push(
    "",
    "Subscribe onError error routing (a throwing listener routed to onError):",
    `  listener: ${onErrorTask.id} carries 1 listener that throws Error("demo listener failure") on every notification, subscribed with a collecting onError hook`,
    `  routed errors: onError received ${onErrorReports.length} report(s); first report: event=${onErrorReports[0].event} from=${onErrorReports[0].from} to=${onErrorReports[0].to} error="${onErrorReports[0].message}" (the dispatch context handed to the hook)`,
    `  dispatch unaffected: all ${onErrorDispatchResults.length} dispatches returned normally (${onErrorDispatchResults.join(", ")}) and the audit history holds all ${onErrorTask.history.length} entries — a failing listener is isolated, never breaking dispatch`,
    `  final state: ${onErrorTask.state} (terminal: ${onErrorTask.isTerminal})`,
  );

  // Payout dedupe snapshot persistence segment (closing): the
  // receiver-side dedupe segment above ran entirely in memory:
  // a receiver restart would forget every id inside its TTL and
  // reopen exactly the double-payout window the store exists to
  // close — at deploy time. Here a FRESH dedupe under an
  // injected fixed clock (2026-03-24T09:00:00.000Z, the same
  // 60_000 ms demo TTL policy as the dedupe segment above)
  // records two fixed payout eventIds (each new on first sight,
  // a duplicate on immediate redelivery), exports them with
  // exportSnapshot(), round-trips the snapshot through JSON
  // text — the persistence channel a real receiver writes
  // before shutdown — and restores it with
  // PayoutEventDedupe.restore(): the restored store's
  // observability counters start at zero (captured before any
  // probe runs), yet both ids still read as duplicates, while
  // a never-seen id reads as new. A detached copy of the
  // snapshot with its version rewritten to 2 is then rejected
  // with the exact invalid-snapshot error, and the exported
  // snapshot object itself still reads v: 1. Hand-written
  // expectations — written out here from the snapshot docs in
  // src/settlementWebhook.ts and the payoutEventDedupeSnapshot
  // tests, never derived by calling the snapshot pair itself:
  //   - each fixed id's first checkAndRecord is false (new
  //     event) and its immediate second is true (duplicate);
  //   - exportSnapshot() is exactly
  //     { v: 1, entries: [[id1, startMs], [id2, startMs]] } —
  //     the original first-seen timestamps, so a restored id
  //     keeps counting down its original TTL;
  //   - the restored store's stats() read immediately after
  //     restore is exactly { size: 2, hits: 0, misses: 0,
  //     evictions: 0 } — counters do not travel with the
  //     snapshot;
  //   - on the restored store both fixed ids read true
  //     (duplicate) and the unseen id reads false (new),
  //     leaving its size at 3;
  //   - the v: 2 copy throws exactly
  //     "PayoutEventDedupe: invalid snapshot: unsupported
  //     snapshot version 2 (expected 1)".
  // Only the snapshot's version and entry count are printed —
  // never the full entries. The clock never advances, so zero
  // network, zero randomness, and no wall clock enter the
  // segment. The segment asserts all of this here, outside the
  // printed lines: a snapshot that dropped or re-stamped an
  // entry, a restore that reopened the window or carried the
  // counters across, or a tampered version that slipped
  // through would fail the demo itself, not just a test.
  const DEDUPE_SNAPSHOT_START_MS = Date.parse("2026-03-24T09:00:00.000Z");
  const DEDUPE_SNAPSHOT_TTL_MS = 60_000;
  const DEDUPE_SNAPSHOT_EVENT_IDS = [
    "evt_demo_payout_001",
    "evt_demo_payout_002",
  ];
  const DEDUPE_SNAPSHOT_UNSEEN_EVENT_ID = "evt_demo_payout_003";
  const dedupeSnapshotSource = new PayoutEventDedupe({
    ttlMs: DEDUPE_SNAPSHOT_TTL_MS,
    now: () => DEDUPE_SNAPSHOT_START_MS,
  });
  const dedupeSnapshotFirst = DEDUPE_SNAPSHOT_EVENT_IDS.map((eventId) =>
    dedupeSnapshotSource.checkAndRecord(eventId),
  );
  const dedupeSnapshotDuplicate = DEDUPE_SNAPSHOT_EVENT_IDS.map((eventId) =>
    dedupeSnapshotSource.checkAndRecord(eventId),
  );
  const dedupeSnapshot = dedupeSnapshotSource.exportSnapshot();
  const dedupeSnapshotRestored = PayoutEventDedupe.restore(
    JSON.parse(JSON.stringify(dedupeSnapshot)) as unknown,
    {
      ttlMs: DEDUPE_SNAPSHOT_TTL_MS,
      now: () => DEDUPE_SNAPSHOT_START_MS,
    },
  );
  const dedupeSnapshotStatsAfterRestore = dedupeSnapshotRestored.stats();
  const dedupeSnapshotRestoredSeen = DEDUPE_SNAPSHOT_EVENT_IDS.map(
    (eventId) => dedupeSnapshotRestored.checkAndRecord(eventId),
  );
  const dedupeSnapshotRestoredUnseen = dedupeSnapshotRestored.checkAndRecord(
    DEDUPE_SNAPSHOT_UNSEEN_EVENT_ID,
  );
  let dedupeSnapshotTamperedError = "";
  try {
    PayoutEventDedupe.restore(
      { ...dedupeSnapshot, v: 2 },
      {
        ttlMs: DEDUPE_SNAPSHOT_TTL_MS,
        now: () => DEDUPE_SNAPSHOT_START_MS,
      },
    );
  } catch (err) {
    dedupeSnapshotTamperedError =
      err instanceof Error ? err.message : String(err);
  }
  if (
    JSON.stringify(dedupeSnapshotFirst) !== JSON.stringify([false, false]) ||
    JSON.stringify(dedupeSnapshotDuplicate) !==
      JSON.stringify([true, true]) ||
    dedupeSnapshot.v !== 1 ||
    JSON.stringify(dedupeSnapshot.entries) !==
      JSON.stringify([
        [DEDUPE_SNAPSHOT_EVENT_IDS[0], DEDUPE_SNAPSHOT_START_MS],
        [DEDUPE_SNAPSHOT_EVENT_IDS[1], DEDUPE_SNAPSHOT_START_MS],
      ]) ||
    JSON.stringify(dedupeSnapshotStatsAfterRestore) !==
      JSON.stringify({ size: 2, hits: 0, misses: 0, evictions: 0 }) ||
    JSON.stringify(dedupeSnapshotRestoredSeen) !==
      JSON.stringify([true, true]) ||
    dedupeSnapshotRestoredUnseen !== false ||
    dedupeSnapshotRestored.size !== 3 ||
    dedupeSnapshotTamperedError !==
      "PayoutEventDedupe: invalid snapshot: unsupported snapshot version 2 (expected 1)"
  ) {
    throw new Error(
      "demo fixture broken: PayoutEventDedupe snapshot persistence does not match the hand-pinned contract (two ids new then duplicate, snapshot exactly the pinned v1 entries with their original first-seen timestamps, restored counters at zero, both ids still duplicates and the unseen id new after restore, the v:2 copy rejected with the pinned error)",
    );
  }
  lines.push(
    "",
    "Payout dedupe snapshot persistence (PayoutEventDedupe exportSnapshot / restore across a restart):",
    `  source dedupe (fixed clock ${new Date(DEDUPE_SNAPSHOT_START_MS).toISOString()}, TTL ${DEDUPE_SNAPSHOT_TTL_MS} ms): eventId ${DEDUPE_SNAPSHOT_EVENT_IDS[0]} — checkAndRecord: ${dedupeSnapshotFirst[0]} (new event), again: ${dedupeSnapshotDuplicate[0]} (duplicate); eventId ${DEDUPE_SNAPSHOT_EVENT_IDS[1]} — checkAndRecord: ${dedupeSnapshotFirst[1]} (new event), again: ${dedupeSnapshotDuplicate[1]} (duplicate)`,
    `  exportSnapshot(): v ${dedupeSnapshot.v}, ${dedupeSnapshot.entries.length} entries — only the version and entry count are printed, never the full entries (persist the JSON before shutdown)`,
    `  after JSON round-trip + PayoutEventDedupe.restore(): stats size ${dedupeSnapshotStatsAfterRestore.size}, hits ${dedupeSnapshotStatsAfterRestore.hits}, misses ${dedupeSnapshotStatsAfterRestore.misses}, evictions ${dedupeSnapshotStatsAfterRestore.evictions} — counters restart at zero, the recorded ids do not`,
    `  restored dedupe: eventId ${DEDUPE_SNAPSHOT_EVENT_IDS[0]} — checkAndRecord: ${dedupeSnapshotRestoredSeen[0]} (duplicate — the restart did not reopen the dedupe window); eventId ${DEDUPE_SNAPSHOT_EVENT_IDS[1]} — checkAndRecord: ${dedupeSnapshotRestoredSeen[1]} (duplicate); eventId ${DEDUPE_SNAPSHOT_UNSEEN_EVENT_ID} — checkAndRecord: ${dedupeSnapshotRestoredUnseen} (new event, recorded)`,
    `  tampered snapshot rejected: a detached copy with v changed to 2 throws "${dedupeSnapshotTamperedError}" — a corrupt snapshot fails loudly at startup instead of silently disabling deduplication`,
  );


  // Payout dedupe stats observability segment (closing): the
  // receiver-side dedupe segment above showed the duplicate
  // verdicts themselves and the snapshot segment showed the
  // ids surviving a restart, but neither showed the counters
  // a receiver operator watches while deliveries are flowing:
  // stats() returns { size, hits, misses, evictions } — size
  // the live entries, hits the deliveries judged duplicates,
  // misses the first sightings recorded, evictions the
  // entries dropped to make room. Here a FRESH dedupe under
  // an injected fixed clock (2026-03-25T09:00:00.000Z, the
  // same 60_000 ms demo TTL policy) with a small maxEntries
  // of 3 runs a pinned script — one new eventId, its
  // immediate redelivery, two more new ids that fill the
  // store, and a fourth new id that needs room — printing
  // stats() after every step. A stats object returned at the
  // end is then mutated (hits set to 999) and the store is
  // read again: the counters do not move, because stats()
  // hands out a detached copy, not a live view. Hand-written
  // expectations — written out here from the stats docs in
  // src/settlementWebhook.ts and the payoutEventDedupe stats
  // test, never derived by calling stats() itself:
  //   - the outcomes are exactly
  //     [false, true, false, false, false] (new, duplicate,
  //     new, new, new);
  //   - the stats readings (initial, then after each call)
  //     are exactly {0,0,0,0}, {1,0,1,0}, {1,1,1,0},
  //     {2,1,2,0}, {3,1,3,0}, {3,1,4,1} as
  //     { size, hits, misses, evictions }: the duplicate is
  //     the only hit, every first sighting is a miss, and
  //     the fourth new id evicts exactly one entry — the
  //     least recently seen evt_demo_stats_001 (its duplicate
  //     hit refreshed its recency while it was the only
  //     entry, so it is still the oldest once 002 and 003
  //     are recorded after it);
  //   - after the detached copy's hits are set to 999 the
  //     store still reads {3,1,4,1} and its size is 3.
  // The clock never advances, so zero network, zero
  // randomness, and no wall clock enter the segment. The
  // segment asserts all of this here, outside the printed
  // lines: a counter that miscounted a hit or an eviction,
  // or a stats() that leaked a live view, would fail the
  // demo itself, not just a test.
  const DEDUPE_STATS_START_MS = Date.parse("2026-03-25T09:00:00.000Z");
  const DEDUPE_STATS_TTL_MS = 60_000;
  const DEDUPE_STATS_MAX_ENTRIES = 3;
  const DEDUPE_STATS_EVENT_IDS = [
    "evt_demo_stats_001",
    "evt_demo_stats_002",
    "evt_demo_stats_003",
    "evt_demo_stats_004",
  ];
  const dedupeStatsDedupe = new PayoutEventDedupe({
    ttlMs: DEDUPE_STATS_TTL_MS,
    maxEntries: DEDUPE_STATS_MAX_ENTRIES,
    now: () => DEDUPE_STATS_START_MS,
  });
  const dedupeStatsSnapshots: PayoutEventDedupeStats[] = [
    dedupeStatsDedupe.stats(),
  ];
  const dedupeStatsOutcomes: boolean[] = [];
  dedupeStatsOutcomes.push(
    dedupeStatsDedupe.checkAndRecord(DEDUPE_STATS_EVENT_IDS[0]),
  );
  dedupeStatsSnapshots.push(dedupeStatsDedupe.stats());
  dedupeStatsOutcomes.push(
    dedupeStatsDedupe.checkAndRecord(DEDUPE_STATS_EVENT_IDS[0]),
  );
  dedupeStatsSnapshots.push(dedupeStatsDedupe.stats());
  for (const eventId of DEDUPE_STATS_EVENT_IDS.slice(1)) {
    dedupeStatsOutcomes.push(dedupeStatsDedupe.checkAndRecord(eventId));
    dedupeStatsSnapshots.push(dedupeStatsDedupe.stats());
  }
  const dedupeStatsDetached = dedupeStatsDedupe.stats();
  dedupeStatsDetached.hits = 999;
  const dedupeStatsAfterMutation = dedupeStatsDedupe.stats();
  if (
    JSON.stringify(dedupeStatsOutcomes) !==
      JSON.stringify([false, true, false, false, false]) ||
    JSON.stringify(dedupeStatsSnapshots) !==
      JSON.stringify([
        { size: 0, hits: 0, misses: 0, evictions: 0 },
        { size: 1, hits: 0, misses: 1, evictions: 0 },
        { size: 1, hits: 1, misses: 1, evictions: 0 },
        { size: 2, hits: 1, misses: 2, evictions: 0 },
        { size: 3, hits: 1, misses: 3, evictions: 0 },
        { size: 3, hits: 1, misses: 4, evictions: 1 },
      ]) ||
    JSON.stringify(dedupeStatsAfterMutation) !==
      JSON.stringify({ size: 3, hits: 1, misses: 4, evictions: 1 }) ||
    dedupeStatsDedupe.size !== 3
  ) {
    throw new Error(
      "demo fixture broken: PayoutEventDedupe stats observability does not match the hand-pinned contract (pinned script outcomes new/duplicate/new/new/new, per-step stats {0,0,0,0} {1,0,1,0} {1,1,1,0} {2,1,2,0} {3,1,3,0} {3,1,4,1}, one LRU eviction of the first id, and a mutated detached copy leaving the store at {3,1,4,1})",
    );
  }
  const fmtDedupeStats = (st: PayoutEventDedupeStats): string =>
    `size ${st.size}, hits ${st.hits}, misses ${st.misses}, evictions ${st.evictions}`;
  lines.push(
    "",
    "Payout dedupe stats observability (PayoutEventDedupe.stats() counters over a pinned script):",
    `  dedupe (fixed clock ${new Date(DEDUPE_STATS_START_MS).toISOString()}, TTL ${DEDUPE_STATS_TTL_MS} ms, maxEntries ${DEDUPE_STATS_MAX_ENTRIES}): initial stats ${fmtDedupeStats(dedupeStatsSnapshots[0])} — no delivery seen yet`,
    `  eventId ${DEDUPE_STATS_EVENT_IDS[0]} — checkAndRecord: ${dedupeStatsOutcomes[0]} (new event) -> stats ${fmtDedupeStats(dedupeStatsSnapshots[1])}; again: ${dedupeStatsOutcomes[1]} (duplicate) -> stats ${fmtDedupeStats(dedupeStatsSnapshots[2])}`,
    `  eventId ${DEDUPE_STATS_EVENT_IDS[1]} — checkAndRecord: ${dedupeStatsOutcomes[2]} (new event) -> stats ${fmtDedupeStats(dedupeStatsSnapshots[3])}; eventId ${DEDUPE_STATS_EVENT_IDS[2]} — checkAndRecord: ${dedupeStatsOutcomes[3]} (new event) -> stats ${fmtDedupeStats(dedupeStatsSnapshots[4])} (store full)`,
    `  eventId ${DEDUPE_STATS_EVENT_IDS[3]} — checkAndRecord: ${dedupeStatsOutcomes[4]} (new event, evicts least recently seen ${DEDUPE_STATS_EVENT_IDS[0]}) -> stats ${fmtDedupeStats(dedupeStatsSnapshots[5])}`,
    `  detached copy: mutating a returned stats() object (hits set to 999) leaves the store's stats unchanged at ${fmtDedupeStats(dedupeStatsAfterMutation)} — the snapshot is a copy, not a live view`,
  );

  // Payout dedupe clear reset segment (closing): the dedupe
  // segments above showed duplicates judged, ids surviving a
  // restart, and the counters watched live — but never the
  // one explicit way to forget everything at once: clear()
  // drops every tracked id and resets hits / misses /
  // evictions to zero. A receiver reaches for it on key
  // rotation, for test isolation, or to reset a dedupe
  // window deliberately; without it a reader could think the
  // recorded set only ever shrinks by TTL expiry. Here a
  // FRESH dedupe under an injected fixed clock
  // (2026-03-26T09:00:00.000Z, the same 60_000 ms demo TTL
  // policy) records one pinned eventId twice — new, then a
  // duplicate — is cleared, and then records the SAME id
  // again: it reads as a brand-new event and the counters
  // re-accumulate from zero. Hand-written expectations —
  // written out here from the clear() docs in
  // src/settlementWebhook.ts and the payoutEventDedupe
  // clear test, never derived by calling clear() itself:
  //   - the outcomes are exactly [false, true, false]
  //     (new, duplicate, new again after the clear);
  //   - the stats before the clear are exactly
  //     { size: 1, hits: 1, misses: 1, evictions: 0 };
  //   - right after clear() the size is 0 and the stats are
  //     exactly { size: 0, hits: 0, misses: 0, evictions: 0 };
  //   - after the same id is re-recorded the stats are
  //     exactly { size: 1, hits: 0, misses: 1, evictions: 0 }
  //     and the dedupe size is 1.
  // The clock never advances, so zero network, zero
  // randomness, and no wall clock enter the segment. The
  // segment asserts all of this here, outside the printed
  // lines: a clear() that left an id behind or a counter
  // un-reset would fail the demo itself, not just a test.
  const DEDUPE_CLEAR_START_MS = Date.parse("2026-03-26T09:00:00.000Z");
  const DEDUPE_CLEAR_TTL_MS = 60_000;
  const dedupeClearEventId = "evt_demo_clear_001";
  const dedupeClearDedupe = new PayoutEventDedupe({
    ttlMs: DEDUPE_CLEAR_TTL_MS,
    now: () => DEDUPE_CLEAR_START_MS,
  });
  const dedupeClearOutcomes: boolean[] = [];
  dedupeClearOutcomes.push(
    dedupeClearDedupe.checkAndRecord(dedupeClearEventId),
  );
  dedupeClearOutcomes.push(
    dedupeClearDedupe.checkAndRecord(dedupeClearEventId),
  );
  const dedupeClearStatsBefore = dedupeClearDedupe.stats();
  dedupeClearDedupe.clear();
  const dedupeClearSizeAfterClear = dedupeClearDedupe.size;
  const dedupeClearStatsAfterClear = dedupeClearDedupe.stats();
  dedupeClearOutcomes.push(
    dedupeClearDedupe.checkAndRecord(dedupeClearEventId),
  );
  const dedupeClearStatsAfterReRecord = dedupeClearDedupe.stats();
  if (
    JSON.stringify(dedupeClearOutcomes) !==
      JSON.stringify([false, true, false]) ||
    JSON.stringify(dedupeClearStatsBefore) !==
      JSON.stringify({ size: 1, hits: 1, misses: 1, evictions: 0 }) ||
    dedupeClearSizeAfterClear !== 0 ||
    JSON.stringify(dedupeClearStatsAfterClear) !==
      JSON.stringify({ size: 0, hits: 0, misses: 0, evictions: 0 }) ||
    JSON.stringify(dedupeClearStatsAfterReRecord) !==
      JSON.stringify({ size: 1, hits: 0, misses: 1, evictions: 0 }) ||
    dedupeClearDedupe.size !== 1
  ) {
    throw new Error(
      "demo fixture broken: PayoutEventDedupe clear reset does not match the hand-pinned contract (pinned outcomes new/duplicate/new-again, stats before {1,1,1,0}, size and stats all zero right after clear(), and stats {1,0,1,0} after the same id is re-recorded)",
    );
  }
  lines.push(
    "",
    "Payout dedupe clear reset (PayoutEventDedupe.clear() drops every id and zeroes the counters):",
    `  dedupe (fixed clock ${new Date(DEDUPE_CLEAR_START_MS).toISOString()}, TTL ${DEDUPE_CLEAR_TTL_MS} ms): eventId ${dedupeClearEventId} — checkAndRecord: ${dedupeClearOutcomes[0]} (new event); again: ${dedupeClearOutcomes[1]} (duplicate) -> stats ${fmtDedupeStats(dedupeClearStatsBefore)}`,
    `  clear(): size ${dedupeClearSizeAfterClear}, stats ${fmtDedupeStats(dedupeClearStatsAfterClear)} — every recorded id dropped and every counter reset in one call (the explicit reset for key rotation, test isolation, or a deliberate window reset)`,
    `  same eventId after clear — checkAndRecord: ${dedupeClearOutcomes[2]} (new event again — the clear forgot it, no TTL wait needed) -> stats ${fmtDedupeStats(dedupeClearStatsAfterReRecord)} (counters re-accumulate from zero)`,
  );

  // Payout webhook 429 Retry-After delivery segment (closing):
  // the Retry-After segment near the top only PARSED a fixed
  // corpus of hints with parsePayoutRetryAfter, and the
  // single-target segment above delivered through a scripted
  // 500 — whose retry fell back to exponential backoff. No
  // segment has ever driven the end-to-end path the parser
  // exists for: a first answer of 429 carrying a Retry-After
  // header, the wait decision in retryDelayMs (settlementWebhook
  // — the parsed hint wins over backoff and is clamped to
  // maxRetryDelayMs), and the retry that then succeeds. Here
  // the main task's signed webhook (built and verified above)
  // is delivered to one fixed endpoint through an injected
  // fake fetch scripted to answer 429 with a pinned
  // `Retry-After: 30` header on the first attempt and 200 on
  // the retry, and through a RECORDING fake sleep that captures
  // the delay it is asked to wait instead of really waiting —
  // zero real network, zero real wait. The hint is in
  // delay-seconds form, so no wall clock enters the parse
  // either. Hand-written expectations — written out here from
  // the delivery source and the delivery tests, never derived
  // by calling deliverPayoutWebhook itself:
  //   - the result is { ok: true, attempts: 2, status: 200 }
  //     with no error (a 429 is retryable, the retry succeeds);
  //   - the recording sleep receives exactly [5000]: the
  //     pinned hint parses to 30 s x 1,000 = 30000 ms and is
  //     clamped with Math.min(hinted, maxRetryDelayMs) to the
  //     segment's maxRetryDelayMs of 5000 — had the hint been
  //     ignored, the sleep would have been the exponential
  //     backoff backoffMs 100 x 2^0 = 100 instead;
  //   - the fake fetch sees exactly 2 POSTs to the fixed
  //     endpoint, with byte-identical bodies (a retry re-POSTs
  //     the same signed body under the same eventId) and the
  //     webhook's own signature on both;
  //   - the captured wire body verifies under the demo secret
  //     with verifyPayoutWebhook — the receiver-side check on
  //     exactly the bytes that crossed the wire.
  // The segment asserts all of this here, outside the printed
  // lines: a wait that drifted from the parsed-and-clamped
  // hint would fail the demo itself, not just a test.
  const retryAfterDeliveryEndpoint =
    "https://payouts.example.com/hooks/payout";
  const retryAfterDeliveryCalls: FanoutCall[] = [];
  const retryAfterDeliverySleeps: number[] = [];
  let retryAfterDeliveryAttempt = 0;
  const retryAfterDeliveryFetch: PayoutWebhookFetchImpl = async (
    url,
    init,
  ) => {
    retryAfterDeliveryCalls.push({
      url,
      body: String(init.body ?? ""),
      signature: String(
        new Headers(init.headers).get("x-hub-signature-256") ?? "",
      ),
    });
    retryAfterDeliveryAttempt += 1;
    return retryAfterDeliveryAttempt === 1
      ? new Response("{}", {
          status: 429,
          headers: { "retry-after": "30" },
        })
      : new Response("{}", { status: 200 });
  };
  const retryAfterDeliveryResult = await deliverPayoutWebhook(
    retryAfterDeliveryEndpoint,
    webhook,
    {
      fetchImpl: retryAfterDeliveryFetch,
      sleepImpl: async (ms: number) => {
        retryAfterDeliverySleeps.push(ms);
      },
      backoffMs: 100,
      maxRetryDelayMs: 5_000,
    },
  );
  const retryAfterDeliveryBodyVerifies =
    retryAfterDeliveryCalls.length > 0 &&
    verifyPayoutWebhook(
      retryAfterDeliveryCalls[0].body,
      retryAfterDeliveryCalls[0].signature,
      DEMO_WEBHOOK_SECRET,
    );
  if (
    retryAfterDeliveryResult.ok !== true ||
    retryAfterDeliveryResult.attempts !== 2 ||
    retryAfterDeliveryResult.status !== 200 ||
    retryAfterDeliveryResult.error !== undefined ||
    JSON.stringify(retryAfterDeliverySleeps) !== JSON.stringify([5_000]) ||
    retryAfterDeliveryCalls.length !== 2 ||
    retryAfterDeliveryCalls.some(
      (c) => c.url !== retryAfterDeliveryEndpoint,
    ) ||
    retryAfterDeliveryCalls[0].body !== retryAfterDeliveryCalls[1].body ||
    retryAfterDeliveryCalls[0].signature !== webhook.signature ||
    retryAfterDeliveryCalls[1].signature !== webhook.signature ||
    retryAfterDeliveryCalls[0].body !== JSON.stringify(webhook.payload) ||
    !retryAfterDeliveryBodyVerifies
  ) {
    throw new Error(
      "demo fixture broken: deliverPayoutWebhook 429 Retry-After delivery does not match the hand-pinned contract (a scripted 429 with Retry-After: 30 then 200 must report ok with 2 attempts and status 200, the recording sleep must receive exactly the parsed 30000 ms hint clamped to maxRetryDelayMs 5000, both wire calls must carry the byte-identical signed body and the webhook signature, and the captured wire body must verify under the demo secret)",
    );
  }
  lines.push(
    "",
    "Payout webhook 429 Retry-After delivery (deliverPayoutWebhook waits the clamped hint before retrying, fake fetch + recording fake sleep — no real network, no real wait):",
    `  endpoint: ${retryAfterDeliveryEndpoint} (the main task's signed payout webhook, delivered on its own — no fan-out)`,
    `  first answer: 429 with Retry-After: 30 (parsed hint 30000 ms, clamped to maxRetryDelayMs 5000) -> recorded sleep: [${retryAfterDeliverySleeps.join(", ")}] ms (the recording sleepImpl received exactly the clamped hint — exponential backoff, here backoffMs 100, never ran, and nothing really waited)`,
    `  delivery: ok attempts=${retryAfterDeliveryResult.attempts} status=${retryAfterDeliveryResult.status} (the retry after the clamped wait succeeded)`,
    `  wire check: ${retryAfterDeliveryCalls.length} POSTs captured with byte-identical bodies: ${retryAfterDeliveryCalls[0].body === retryAfterDeliveryCalls[1].body} (a retry re-POSTs the same signed body under the same eventId, so a receiver deduplicates it); signature check: verifyPayoutWebhook over the captured wire body: ${retryAfterDeliveryBodyVerifies} (the X-Hub-Signature-256 header captured on the wire verifies under the demo secret)`,
  );

  // Payout webhook secret rotation segment (closing): every
  // webhook segment above verifies with the single shared demo
  // secret — the one-secret world. A real receiver rotates its
  // signing secret without a flag day: for a window it must
  // accept BOTH the new and the old secret, because senders
  // migrate on their own schedule and notifications signed
  // before the rotation are still in flight. That window is
  // `verifyPayoutWebhook`'s `{ secrets: [new, old] }` shape
  // (settlementWebhook, unit-tested since the rotation tests
  // landed) — never shown in the demo until here. Two
  // notifications are built from the main PAID task under a
  // fixed signing time and fixed eventIds — one signed with
  // the new secret, one with the old — so the whole segment is
  // byte-identical on every run: fixed secrets, fixed
  // timestamp, zero network, zero randomness (the secrets are
  // demo placeholders printed in this source, never real
  // credentials, and the secrets themselves are never printed
  // in the lines). Hand-written expectations — written out
  // here from the VerifyPayoutWebhookOptions docs and the
  // secret-rotation tests, never derived by calling
  // verifyPayoutWebhook itself:
  //   - under `{ secrets: [new, old] }` BOTH notifications
  //     verify: any one matching candidate authenticates, so
  //     an in-flight old-signed notification still passes
  //     inside the window and a new-signed one passes as soon
  //     as the new secret is listed;
  //   - the new-signed notification under the old secret alone
  //     (the legacy positional shape) is false: a receiver
  //     that has not adopted the new secret yet rejects it;
  //   - both notifications under an unrelated secret list are
  //     false: all-mismatch fails closed as `false`, never a
  //     throw and never a pass;
  //   - passing the positional secret AND `secrets` together
  //     throws the pinned configuration error — the two shapes
  //     are mutually exclusive, so a misconfigured receiver
  //     fails loudly instead of silently picking one.
  // The segment asserts all of this here, outside the printed
  // lines: a rotation verdict that drifted would fail the demo
  // itself, not just a test.
  const ROTATION_FIXED_NOW = new Date("2026-03-27T09:00:00.000Z");
  const rotationNewWebhook = buildPayoutWebhook(
    task,
    DEMO_ROTATION_NEW_SECRET,
    { eventId: "evt_demo_rotation_new", now: ROTATION_FIXED_NOW },
  );
  const rotationOldWebhook = buildPayoutWebhook(
    task,
    DEMO_ROTATION_OLD_SECRET,
    { eventId: "evt_demo_rotation_old", now: ROTATION_FIXED_NOW },
  );
  const rotationNewUnderRotation = verifyPayoutWebhook(
    JSON.stringify(rotationNewWebhook.payload),
    rotationNewWebhook.signature,
    undefined,
    { secrets: [DEMO_ROTATION_NEW_SECRET, DEMO_ROTATION_OLD_SECRET] },
  );
  const rotationOldUnderRotation = verifyPayoutWebhook(
    JSON.stringify(rotationOldWebhook.payload),
    rotationOldWebhook.signature,
    undefined,
    { secrets: [DEMO_ROTATION_NEW_SECRET, DEMO_ROTATION_OLD_SECRET] },
  );
  const rotationNewUnderOldOnly = verifyPayoutWebhook(
    JSON.stringify(rotationNewWebhook.payload),
    rotationNewWebhook.signature,
    DEMO_ROTATION_OLD_SECRET,
  );
  const rotationUnderUnrelatedList = [
    verifyPayoutWebhook(
      JSON.stringify(rotationNewWebhook.payload),
      rotationNewWebhook.signature,
      undefined,
      { secrets: ["demo-payout-webhook-secret-unrelated"] },
    ),
    verifyPayoutWebhook(
      JSON.stringify(rotationOldWebhook.payload),
      rotationOldWebhook.signature,
      undefined,
      { secrets: ["demo-payout-webhook-secret-unrelated"] },
    ),
  ];
  let rotationBothError = "";
  try {
    verifyPayoutWebhook(
      JSON.stringify(rotationNewWebhook.payload),
      rotationNewWebhook.signature,
      DEMO_ROTATION_NEW_SECRET,
      { secrets: [DEMO_ROTATION_NEW_SECRET, DEMO_ROTATION_OLD_SECRET] },
    );
  } catch (err) {
    rotationBothError = err instanceof Error ? err.message : String(err);
  }
  if (
    rotationNewWebhook.payload.taskId !== "DEMO-001" ||
    rotationNewWebhook.payload.eventId !== "evt_demo_rotation_new" ||
    rotationNewWebhook.payload.at !== "2026-03-27T09:00:00.000Z" ||
    rotationOldWebhook.payload.taskId !== "DEMO-001" ||
    rotationOldWebhook.payload.eventId !== "evt_demo_rotation_old" ||
    rotationOldWebhook.payload.at !== "2026-03-27T09:00:00.000Z" ||
    rotationNewWebhook.signature === rotationOldWebhook.signature ||
    rotationNewUnderRotation !== true ||
    rotationOldUnderRotation !== true ||
    rotationNewUnderOldOnly !== false ||
    JSON.stringify(rotationUnderUnrelatedList) !==
      JSON.stringify([false, false]) ||
    rotationBothError !==
      "cannot verify payout webhook: pass either 'secret' or 'secrets', not both"
  ) {
    throw new Error(
      "demo fixture broken: verifyPayoutWebhook secret rotation does not match the hand-pinned contract (both fixed notifications must verify under { secrets: [new, old] }, the new-signed one must fail under the old secret alone, both must fail closed under an unrelated secret list, and passing the positional secret together with secrets must throw the pinned mutual-exclusion error)",
    );
  }
  lines.push(
    "",
    "Payout webhook secret rotation (verifyPayoutWebhook with { secrets: [new, old] } accepts either secret during the rotation window):",
    `  notifications (main task DEMO-001, fixed signing time ${rotationNewWebhook.payload.at}): eventId ${rotationNewWebhook.payload.eventId} signed with the new secret; eventId ${rotationOldWebhook.payload.eventId} signed with the old secret — the secrets themselves are never printed`,
    `  rotation window { secrets: [new, old] }: new-signed verifies: ${rotationNewUnderRotation}; old-signed verifies: ${rotationOldUnderRotation} (in-flight notifications signed before the rotation still pass, and new-signed ones pass as soon as the new secret is listed — any one matching secret authenticates)`,
    `  window edges fail closed: new-signed under the old secret alone: ${rotationNewUnderOldOnly} (a receiver that has not adopted the new secret yet rejects it); both under an unrelated secret list: ${rotationUnderUnrelatedList[0]}, ${rotationUnderUnrelatedList[1]} (no listed secret matches, so verification fails closed as false — never a throw, never a pass)`,
    `  configuration guard: passing the positional secret together with { secrets: [...] } throws "${rotationBothError}" (the two shapes are mutually exclusive, so a misconfigured receiver fails loudly instead of silently picking one)`,
  );


  // Payout webhook AbortSignal segment (closing): every
  // delivery segment above runs to a settled outcome — a
  // success, an exhausted retry budget, a clamped wait.
  // None of them shows the caller cancelling a delivery
  // through the external `signal` option of
  // `deliverPayoutWebhook` (settlementWebhook, unit-tested
  // since the abort-signal tests landed): the delivery the
  // caller no longer wants must stop — before it starts if
  // the signal is already aborted, and mid-wait if the
  // abort lands while a retry is pending — and, per this
  // module's report-don't-throw convention, the abort is
  // reported in the result, never thrown. Here the main
  // task's signed webhook (built and verified above) is
  // delivered to one fixed endpoint in two pinned forms,
  // both through counting fake fetches, so the whole
  // segment is deterministic: zero network, zero real
  // wait, no wall-clock trigger (the second form aborts
  // from inside the injected sleep itself — being invoked
  // at all proves the backoff wait has been entered, the
  // same deterministic trigger the abort-signal tests use).
  // Hand-written expectations — written out here from the
  // DeliverPayoutWebhookOptions signal docs and the
  // abort-signal tests, never derived by calling
  // deliverPayoutWebhook itself:
  //   - pre-aborted: the result is exactly
  //     { ok: false, attempts: 0,
  //       error: "payout webhook delivery aborted" }
  //     with no status, and the counting fetch is never
  //     called (0 calls) — the caller asked to stop before
  //     the delivery started;
  //   - abort during the backoff wait: the fake fetch
  //     answers 500 on its only call, the delivery enters
  //     the exponential backoff sleep (backoffMs 30000 x
  //     2^0 = 30000 ms, a wait that must never really run),
  //     the hanging sleep records the delay and aborts the
  //     signal from inside itself, and the result is
  //     exactly { ok: false, attempts: 1, status: 500,
  //     error: "payout webhook delivery aborted" } — the
  //     one attempt actually made stands with its status,
  //     and no second fetch is ever started.
  // The segment asserts all of this here, outside the
  // printed lines: an abort verdict that drifted would
  // fail the demo itself, not just a test.
  const abortDeliveryEndpoint =
    "https://payouts.example.com/hooks/payout";
  const abortPreController = new AbortController();
  abortPreController.abort();
  let abortPreFetchCalls = 0;
  const abortPreResult = await deliverPayoutWebhook(
    abortDeliveryEndpoint,
    webhook,
    {
      fetchImpl: async () => {
        abortPreFetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
      sleepImpl: async () => {},
      signal: abortPreController.signal,
    },
  );
  const abortWaitController = new AbortController();
  let abortWaitFetchCalls = 0;
  const abortWaitSleeps: number[] = [];
  const abortWaitResult = await deliverPayoutWebhook(
    abortDeliveryEndpoint,
    webhook,
    {
      fetchImpl: async () => {
        abortWaitFetchCalls += 1;
        return new Response("{}", { status: 500 });
      },
      sleepImpl: (ms: number) => {
        abortWaitSleeps.push(ms);
        abortWaitController.abort();
        return new Promise<void>(() => {});
      },
      backoffMs: 30_000,
      maxAttempts: 3,
      signal: abortWaitController.signal,
    },
  );
  if (
    abortPreResult.ok !== false ||
    abortPreResult.attempts !== 0 ||
    abortPreResult.status !== undefined ||
    abortPreResult.error !== "payout webhook delivery aborted" ||
    abortPreFetchCalls !== 0 ||
    abortWaitResult.ok !== false ||
    abortWaitResult.attempts !== 1 ||
    abortWaitResult.status !== 500 ||
    abortWaitResult.error !== "payout webhook delivery aborted" ||
    abortWaitFetchCalls !== 1 ||
    JSON.stringify(abortWaitSleeps) !== JSON.stringify([30_000])
  ) {
    throw new Error(
      "demo fixture broken: deliverPayoutWebhook AbortSignal abort does not match the hand-pinned contract (a pre-aborted signal must report { ok: false, attempts: 0, error: \"payout webhook delivery aborted\" } with zero fetch calls, and an abort inside the backoff sleep after a first 500 must report { ok: false, attempts: 1, status: 500, error: \"payout webhook delivery aborted\" } with exactly one fetch call and the entered sleep [30000])",
    );
  }
  lines.push(
    "",
    "Payout webhook AbortSignal abort (deliverPayoutWebhook honours an external AbortSignal, fake fetch + hanging fake sleep — no real network, no real wait):",
    `  endpoint: ${abortDeliveryEndpoint} (the main task's signed payout webhook, delivered on its own — no fan-out)`,
    `  pre-aborted signal: delivery ok=${abortPreResult.ok} attempts=${abortPreResult.attempts} error="${abortPreResult.error}"; fetch calls: ${abortPreFetchCalls} (the caller asked to stop before the delivery started, so no request was made and the abort is reported, not thrown)`,
    `  abort during the backoff wait: first answer 500 -> backoff sleep [${abortWaitSleeps.join(", ")}] ms entered, signal aborted inside the sleep; delivery ok=${abortWaitResult.ok} attempts=${abortWaitResult.attempts} status=${abortWaitResult.status} error="${abortWaitResult.error}"; fetch calls: ${abortWaitFetchCalls} (no second attempt was started — the pending wait was cut short, nothing really waited)`,
  );

  // Payout webhook freshness window segment (closing): every
  // webhook segment above verifies a signature — and a
  // signature has no expiry of its own, so a captured,
  // legitimately signed notification would verify forever.
  // The opt-in freshness window of `verifyPayoutWebhook`
  // (`{ maxAgeMs, maxFutureSkewMs, now }`, settlementWebhook,
  // unit-tested since the freshness and future-skew tests
  // landed) is the receiver's replay bound — never shown in
  // the demo until here. One notification is built from the
  // main PAID task under a fixed signing time and a fixed
  // eventId and signed with the shared demo secret, then the
  // SAME body and signature are verified under injected
  // receiver clocks, so the whole segment is byte-identical
  // on every run: fixed timestamp, injected clocks, zero
  // network, zero randomness. Hand-written expectations —
  // written out here from the VerifyPayoutWebhookOptions
  // docs and the freshness / future-skew tests, never
  // derived by calling verifyPayoutWebhook itself:
  //   - inside the window: receiver now 30 minutes after
  //     signing with maxAgeMs 3600000 (1 hour) verifies true;
  //   - boundary: receiver now exactly maxAgeMs after
  //     signing still verifies true — the boundary is
  //     inclusive, only `now - at > maxAgeMs` fails;
  //   - stale: receiver now 2 hours after signing returns
  //     false even though the same body and signature still
  //     verify true with no window configured — only the
  //     freshness gate rejects the stale replay;
  //   - future skew: a receiver now 2 hours BEFORE signing
  //     (the payload `at` lies 2 hours ahead of the
  //     receiver) with maxFutureSkewMs 3600000 returns
  //     false — a sender clock set too far ahead gains no
  //     unbounded replay window, and maxAgeMs alone never
  //     bounds that future direction.
  // The segment asserts all of this here, outside the
  // printed lines: a freshness verdict that drifted would
  // fail the demo itself, not just a test.
  const FRESHNESS_FIXED_AT = new Date("2026-03-28T09:00:00.000Z");
  const freshnessMaxAgeMs = 3_600_000;
  const freshnessMaxFutureSkewMs = 3_600_000;
  const freshnessWebhook = buildPayoutWebhook(task, DEMO_WEBHOOK_SECRET, {
    eventId: "evt_demo_freshness",
    now: FRESHNESS_FIXED_AT,
  });
  const freshnessBody = JSON.stringify(freshnessWebhook.payload);
  const freshnessWithinNow = new Date(
    FRESHNESS_FIXED_AT.getTime() + 30 * 60_000,
  );
  const freshnessBoundaryNow = new Date(
    FRESHNESS_FIXED_AT.getTime() + freshnessMaxAgeMs,
  );
  const freshnessBeyondNow = new Date(
    FRESHNESS_FIXED_AT.getTime() + 2 * freshnessMaxAgeMs,
  );
  const freshnessFutureNow = new Date(
    FRESHNESS_FIXED_AT.getTime() - 2 * freshnessMaxFutureSkewMs,
  );
  const freshnessWithinWindow = verifyPayoutWebhook(
    freshnessBody,
    freshnessWebhook.signature,
    DEMO_WEBHOOK_SECRET,
    { maxAgeMs: freshnessMaxAgeMs, now: freshnessWithinNow },
  );
  const freshnessAtBoundary = verifyPayoutWebhook(
    freshnessBody,
    freshnessWebhook.signature,
    DEMO_WEBHOOK_SECRET,
    { maxAgeMs: freshnessMaxAgeMs, now: freshnessBoundaryNow },
  );
  const freshnessBeyondWindow = verifyPayoutWebhook(
    freshnessBody,
    freshnessWebhook.signature,
    DEMO_WEBHOOK_SECRET,
    { maxAgeMs: freshnessMaxAgeMs, now: freshnessBeyondNow },
  );
  const freshnessBeyondWindowSignatureOnly = verifyPayoutWebhook(
    freshnessBody,
    freshnessWebhook.signature,
    DEMO_WEBHOOK_SECRET,
  );
  const freshnessFutureBeyondSkew = verifyPayoutWebhook(
    freshnessBody,
    freshnessWebhook.signature,
    DEMO_WEBHOOK_SECRET,
    { maxFutureSkewMs: freshnessMaxFutureSkewMs, now: freshnessFutureNow },
  );
  if (
    freshnessWebhook.payload.taskId !== "DEMO-001" ||
    freshnessWebhook.payload.eventId !== "evt_demo_freshness" ||
    freshnessWebhook.payload.at !== "2026-03-28T09:00:00.000Z" ||
    freshnessWithinWindow !== true ||
    freshnessAtBoundary !== true ||
    freshnessBeyondWindow !== false ||
    freshnessBeyondWindowSignatureOnly !== true ||
    freshnessFutureBeyondSkew !== false
  ) {
    throw new Error(
      "demo fixture broken: verifyPayoutWebhook freshness window does not match the hand-pinned contract (the fixed notification must verify inside the maxAgeMs window and exactly at its inclusive boundary, must fail closed past the window even though its signature alone still verifies, and must fail closed when its at lies beyond maxFutureSkewMs ahead of the receiver)",
    );
  }
  lines.push(
    "",
    "Payout webhook freshness window (verifyPayoutWebhook with { maxAgeMs } rejects a validly signed but stale notification):",
    `  notification (main task DEMO-001, fixed signing time ${freshnessWebhook.payload.at}): eventId ${freshnessWebhook.payload.eventId} signed with the demo secret; freshness window maxAgeMs ${freshnessMaxAgeMs} ms (1 hour) — the secret itself is never printed`,
    `  inside the window: receiver now ${freshnessWithinNow.toISOString()} (30 minutes after signing) with maxAgeMs ${freshnessMaxAgeMs} -> verifies: ${freshnessWithinWindow}; boundary: receiver now ${freshnessBoundaryNow.toISOString()} (exactly maxAgeMs after signing) -> verifies: ${freshnessAtBoundary} (the boundary is inclusive — only now - at > maxAgeMs fails)`,
    `  stale replay fails closed: receiver now ${freshnessBeyondNow.toISOString()} (2 hours after signing, same body and signature) -> verifies: ${freshnessBeyondWindow} (the signature alone still verifies: ${freshnessBeyondWindowSignatureOnly} — only the freshness gate rejects it, bounding replays of a legitimately signed old notification)`,
    `  future skew fails closed: receiver now ${freshnessFutureNow.toISOString()} (the payload at lies 2 hours ahead of the receiver) with maxFutureSkewMs ${freshnessMaxFutureSkewMs} -> verifies: ${freshnessFutureBeyondSkew} (a sender clock set too far ahead gains no unbounded replay window — maxAgeMs alone never bounds the future direction)`,
  );

  // Payout reference enforcement segment (closing): the
  // reconciliation branches above only ever FIND a settled
  // task whose PAYOUT_COMPLETE entry carries no payoutRef
  // after the fact (`unreconciledPayouts`). The opt-in
  // constructor switch `requirePayoutRef: true`
  // (taskLifecycle, unit-tested since the requirePayoutRef
  // tests landed) moves that check to dispatch time: a
  // PAYOUT_COMPLETE without a payoutRef throws
  // `payout reference required: …` and appends nothing, so
  // a settlement can never enter the audit trail without
  // naming the transfer it claims. Two dedicated tasks are
  // driven to PAYOUT_PENDING under fixed literal
  // timestamps — no network, no randomness, no wall clock:
  //   - DEMO-024 is constructed with
  //     `requirePayoutRef: true`; its ref-less
  //     PAYOUT_COMPLETE at 2026-03-29T09:35:00.000Z is
  //     rejected with the pinned error, its state stays
  //     PAYOUT_PENDING and its history stays at 7 entries;
  //     the same dispatch at 09:40 with the pinned
  //     payoutRef "xfer-demo-require-ref" then succeeds,
  //     and the history's last entry (seq 8) carries that
  //     reference verbatim;
  //   - DEMO-025 is constructed with the option unset
  //     (the advisory default); its ref-less
  //     PAYOUT_COMPLETE succeeds into PAID and its last
  //     entry carries no payoutRef — enforcement is
  //     opt-in and the default stays backward compatible.
  // Hand-written expectations — written out here from the
  // TaskLifecycleOptions docs and the requirePayoutRef
  // tests, never derived from the gate itself. The
  // segment asserts all of this here, outside the printed
  // lines: an enforcement verdict that drifted would fail
  // the demo itself, not just a test.
  const requirePayoutRefTask = new TaskLifecycle("DEMO-024", {
    requirePayoutRef: true,
  });
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-03-29T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-03-29T09:05:00.000Z"],
    ["START_CAPTURE", "contributor", "2026-03-29T09:10:00.000Z"],
    ["SUBMIT", "contributor", "2026-03-29T09:15:00.000Z"],
    ["BEGIN_REVIEW", "reviewer", "2026-03-29T09:20:00.000Z"],
    ["APPROVE", "reviewer", "2026-03-29T09:25:00.000Z"],
    ["REQUEST_PAYOUT", "contributor", "2026-03-29T09:30:00.000Z"],
  ] as const) {
    requirePayoutRefTask.dispatch(event, { actor, at });
  }
  let requirePayoutRefError = "";
  try {
    requirePayoutRefTask.dispatch("PAYOUT_COMPLETE", {
      actor: "system",
      at: "2026-03-29T09:35:00.000Z",
    });
  } catch (err) {
    requirePayoutRefError = err instanceof Error ? err.message : String(err);
  }
  const requirePayoutRefStateAfterReject = requirePayoutRefTask.state;
  const requirePayoutRefHistoryLengthAfterReject =
    requirePayoutRefTask.history.length;
  const requirePayoutRefPayoutRef = "xfer-demo-require-ref";
  requirePayoutRefTask.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    at: "2026-03-29T09:40:00.000Z",
    payoutRef: requirePayoutRefPayoutRef,
  });
  const requirePayoutRefDefaultTask = new TaskLifecycle("DEMO-025");
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-03-31T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-03-31T09:05:00.000Z"],
    ["START_CAPTURE", "contributor", "2026-03-31T09:10:00.000Z"],
    ["SUBMIT", "contributor", "2026-03-31T09:15:00.000Z"],
    ["BEGIN_REVIEW", "reviewer", "2026-03-31T09:20:00.000Z"],
    ["APPROVE", "reviewer", "2026-03-31T09:25:00.000Z"],
    ["REQUEST_PAYOUT", "contributor", "2026-03-31T09:30:00.000Z"],
  ] as const) {
    requirePayoutRefDefaultTask.dispatch(event, { actor, at });
  }
  requirePayoutRefDefaultTask.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    at: "2026-03-31T09:35:00.000Z",
  });
  const requirePayoutRefLastEntry =
    requirePayoutRefTask.history[requirePayoutRefTask.history.length - 1];
  const requirePayoutRefDefaultLastEntry =
    requirePayoutRefDefaultTask.history[
      requirePayoutRefDefaultTask.history.length - 1
    ];
  if (
    requirePayoutRefError !==
      "payout reference required: PAYOUT_COMPLETE must carry a non-empty payoutRef when requirePayoutRef is enabled" ||
    requirePayoutRefStateAfterReject !== "PAYOUT_PENDING" ||
    requirePayoutRefHistoryLengthAfterReject !== 7 ||
    requirePayoutRefTask.state !== "PAID" ||
    requirePayoutRefTask.history.length !== 8 ||
    requirePayoutRefLastEntry.event !== "PAYOUT_COMPLETE" ||
    requirePayoutRefLastEntry.seq !== 8 ||
    requirePayoutRefLastEntry.payoutRef !== "xfer-demo-require-ref" ||
    requirePayoutRefLastEntry.at !== "2026-03-29T09:40:00.000Z" ||
    requirePayoutRefDefaultTask.state !== "PAID" ||
    requirePayoutRefDefaultTask.history.length !== 8 ||
    requirePayoutRefDefaultLastEntry.event !== "PAYOUT_COMPLETE" ||
    requirePayoutRefDefaultLastEntry.payoutRef !== undefined
  ) {
    throw new Error(
      "demo fixture broken: requirePayoutRef enforcement does not match the hand-pinned contract (the enforced task must reject a ref-less PAYOUT_COMPLETE with the pinned error and leave state and history untouched, must then settle under the pinned payoutRef carried verbatim on its last history entry, and the default task must still settle without a reference)",
    );
  }
  lines.push(
    "",
    "Payout reference enforcement (requirePayoutRef: true rejects a PAYOUT_COMPLETE that carries no payoutRef):",
    `  enforced task DEMO-024 (constructed with requirePayoutRef: true, driven to PAYOUT_PENDING under fixed timestamps): PAYOUT_COMPLETE without a payoutRef -> rejected: "${requirePayoutRefError}"; state after rejection: ${requirePayoutRefStateAfterReject}, history entries: ${requirePayoutRefHistoryLengthAfterReject} (nothing was appended — the gate is fail-fast, checked before the audit entry is written)`,
    `  enforced task with the reference: PAYOUT_COMPLETE with payoutRef "${requirePayoutRefPayoutRef}" at 2026-03-29T09:40:00.000Z -> ${requirePayoutRefTask.state}; history last entry: seq ${requirePayoutRefLastEntry.seq} PAYOUT_COMPLETE payoutRef=${requirePayoutRefLastEntry.payoutRef} (the audit trail now names the transfer the settlement claims)`,
    `  default task DEMO-025 (requirePayoutRef unset — the advisory default): PAYOUT_COMPLETE without a payoutRef -> ${requirePayoutRefDefaultTask.state}; history last entry carries no payoutRef (backward compatible: enforcement is opt-in, so an unenforced task still settles on the advisory path)`,
  );

  // Dispatch idempotency key segment (closing): the payout
  // flows above are exactly the flows whose callers retry —
  // a webhook redelivery, a client timeout, a queue replay.
  // `dispatch(event, { idempotencyKey })` (taskLifecycle,
  // unit-tested since the idempotency key tests landed) is
  // the retry-safety valve: the task remembers every key it
  // has successfully consumed, and a dispatch repeating a
  // known key returns the current state as a complete
  // no-op — no audit entry appended, no listener notified,
  // and the transition not even validated, so a retry that
  // arrives after the task already moved on cannot throw
  // `invalid transition`. Keys are global to the task, not
  // per-event. A dispatch that fails any check consumes
  // nothing, so fixing a bad call and retrying under the
  // same key still executes. Two dedicated tasks are
  // driven under fixed literal timestamps — no network,
  // no randomness, no wall clock:
  //   - DEMO-026 carries a collecting listener. Its
  //     PUBLISH at 2026-04-02T09:00 under the pinned key
  //     "demo-idem-publish" lands OPEN with 1 history
  //     entry; the same event under the same key at
  //     09:01 returns OPEN and appends nothing (history
  //     stays 1, the listener is not notified again);
  //     its ACCEPT at 09:05 under a second pinned key
  //     moves it to ACCEPTED with 2 entries; a
  //     START_CAPTURE at 09:06 under the OLD publish key
  //     (a different, would-be legal event) still
  //     dedupes — it returns ACCEPTED and appends
  //     nothing; and the stale PUBLISH at 09:07 under
  //     that same old key (now an illegal transition)
  //     also returns ACCEPTED without throwing. The
  //     listener ends with exactly [PUBLISH, ACCEPT].
  //   - DEMO-027 first attempts ACCEPT from DRAFT at
  //     2026-04-03T09:00 under the pinned key
  //     "demo-idem-retry": the illegal transition throws
  //     the pinned `invalid transition: ACCEPT from
  //     DRAFT` error, appends nothing, and consumes no
  //     key; the corrected PUBLISH at 09:05 under the
  //     SAME key then succeeds into OPEN, and a final
  //     ACCEPT at 09:10 with no key at all appends
  //     normally into ACCEPTED — the keyless path keeps
  //     its exact pre-idempotency behavior.
  // Hand-written expectations — written out here from the
  // DispatchOptions docs and the idempotency key tests,
  // never derived from the dedupe itself. The segment
  // asserts all of this here, outside the printed lines:
  // a dedupe verdict that drifted would fail the demo
  // itself, not just a test.
  const idempotencyTask = new TaskLifecycle("DEMO-026");
  const idempotencyNotificationEvents: TaskEvent[] = [];
  idempotencyTask.subscribe((event) => {
    idempotencyNotificationEvents.push(event);
  });
  const idempotencyPublishKey = "demo-idem-publish";
  idempotencyTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-04-02T09:00:00.000Z",
    idempotencyKey: idempotencyPublishKey,
  });
  const idempotencyDuplicateReturn = idempotencyTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-04-02T09:01:00.000Z",
    idempotencyKey: idempotencyPublishKey,
  });
  const idempotencyHistoryLengthAfterDuplicate =
    idempotencyTask.history.length;
  idempotencyTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-04-02T09:05:00.000Z",
    idempotencyKey: "demo-idem-accept",
  });
  const idempotencyCrossEventReturn = idempotencyTask.dispatch(
    "START_CAPTURE",
    {
      actor: "contributor",
      at: "2026-04-02T09:06:00.000Z",
      idempotencyKey: idempotencyPublishKey,
    },
  );
  const idempotencyStaleReturn = idempotencyTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-04-02T09:07:00.000Z",
    idempotencyKey: idempotencyPublishKey,
  });
  const idempotencyHistoryLengthAfterRetries = idempotencyTask.history.length;
  const idempotencyRetryTask = new TaskLifecycle("DEMO-027");
  const idempotencyRetryKey = "demo-idem-retry";
  let idempotencyFailedError = "";
  try {
    idempotencyRetryTask.dispatch("ACCEPT", {
      actor: "contributor",
      at: "2026-04-03T09:00:00.000Z",
      idempotencyKey: idempotencyRetryKey,
    });
  } catch (err) {
    idempotencyFailedError = err instanceof Error ? err.message : String(err);
  }
  const idempotencyRetryHistoryLengthAfterFailure =
    idempotencyRetryTask.history.length;
  idempotencyRetryTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-04-03T09:05:00.000Z",
    idempotencyKey: idempotencyRetryKey,
  });
  idempotencyRetryTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-04-03T09:10:00.000Z",
  });
  if (
    idempotencyDuplicateReturn !== "OPEN" ||
    idempotencyHistoryLengthAfterDuplicate !== 1 ||
    idempotencyCrossEventReturn !== "ACCEPTED" ||
    idempotencyStaleReturn !== "ACCEPTED" ||
    idempotencyHistoryLengthAfterRetries !== 2 ||
    idempotencyTask.state !== "ACCEPTED" ||
    idempotencyTask.history.length !== 2 ||
    idempotencyTask.history[0].event !== "PUBLISH" ||
    idempotencyTask.history[0].at !== "2026-04-02T09:00:00.000Z" ||
    idempotencyTask.history[1].event !== "ACCEPT" ||
    idempotencyTask.history[1].at !== "2026-04-02T09:05:00.000Z" ||
    idempotencyNotificationEvents.length !== 2 ||
    idempotencyNotificationEvents[0] !== "PUBLISH" ||
    idempotencyNotificationEvents[1] !== "ACCEPT" ||
    idempotencyFailedError !== "invalid transition: ACCEPT from DRAFT" ||
    idempotencyRetryHistoryLengthAfterFailure !== 0 ||
    idempotencyRetryTask.state !== "ACCEPTED" ||
    idempotencyRetryTask.history.length !== 2 ||
    idempotencyRetryTask.history[0].event !== "PUBLISH" ||
    idempotencyRetryTask.history[0].at !== "2026-04-03T09:05:00.000Z" ||
    idempotencyRetryTask.history[1].event !== "ACCEPT"
  ) {
    throw new Error(
      "demo fixture broken: dispatch idempotency keys do not match the hand-pinned contract (a repeated key must return the current state with no history append and no listener notification, keys must dedupe globally across events and past task progress without validating the transition, a failed dispatch must consume no key so the corrected retry under the same key succeeds, and a keyless dispatch must append normally)",
    );
  }
  lines.push(
    "",
    "Dispatch idempotency keys (dispatch with { idempotencyKey } makes a retried dispatch a no-op):",
    `  same key, same event (DEMO-026): PUBLISH with idempotencyKey "${idempotencyPublishKey}" at 2026-04-02T09:00:00.000Z -> OPEN, history entries: 1; the same PUBLISH under the same key again -> returns ${idempotencyDuplicateReturn}, history entries: ${idempotencyHistoryLengthAfterDuplicate} (nothing was appended and the listener was not notified again — a redelivered request is answered from the consumed-key set, not re-executed)`,
    `  keys are global and survive progress (DEMO-026): ACCEPT under a second key -> ACCEPTED, history entries: 2; START_CAPTURE under the old key "${idempotencyPublishKey}" (a different, would-be legal event) -> returns ${idempotencyCrossEventReturn}, history entries: ${idempotencyHistoryLengthAfterRetries}; the stale PUBLISH under that same old key (now an illegal transition) -> returns ${idempotencyStaleReturn} without throwing (the transition is not even validated for a known key — a late retry is safe to replay); listener notifications: [${idempotencyNotificationEvents.join(", ")}] (only the two real dispatches ever notified)`,
    `  a failed dispatch consumes no key (DEMO-027): ACCEPT from DRAFT with idempotencyKey "${idempotencyRetryKey}" -> rejected: "${idempotencyFailedError}"; history entries after the failure: ${idempotencyRetryHistoryLengthAfterFailure}; the corrected PUBLISH under the same key -> OPEN (the key was still free, so the retry executed instead of deduping)`,
    `  no key, no change (DEMO-027): ACCEPT with no idempotencyKey -> ${idempotencyRetryTask.state}; history entries: ${idempotencyRetryTask.history.length} (omitting the key preserves the exact pre-idempotency behavior — every keyless dispatch still validates and appends normally)`,
  );

  // Keyed audit hash chain segment (closing): the audit
  // hash-chain segment near the top of this demo verifies
  // the main task's UNKEYED chain — every link there is a
  // plain SHA-256 anyone can recompute. A task constructed
  // with `auditSecret` (TaskLifecycleOptions, unit-tested
  // since the keyed hash-chain tests landed) upgrades
  // every link to HMAC-SHA256 keyed by that secret, so a
  // persisted log rewrite needs the secret as well as the
  // data, and verification is fail-closed across modes.
  // One dedicated task is driven under fixed literal
  // timestamps — no network, no randomness, no wall clock:
  //   - DEMO-028 is constructed with the pinned demo
  //     audit secret and driven PUBLISH -> ACCEPT ->
  //     START_CAPTURE -> SUBMIT at 2026-04-04T09:00 /
  //     09:05 / 09:10 / 09:15, landing in SUBMITTED with
  //     exactly 4 history entries, genesis-linked to
  //     GENESIS_PREV_HASH with every successor linking
  //     to its predecessor's hash;
  //   - `verifyHistoryChain(history, { auditSecret })`
  //     with the correct secret returns true;
  //   - the same history under the pinned wrong secret
  //     returns false (no throw — a verdict, fail-closed);
  //   - a detached copy whose middle entry (index 2,
  //     START_CAPTURE) gains a payoutAmount of 999 it
  //     never carried returns false under the correct
  //     secret, and the original history still verifies
  //     afterwards, proving the tamper copy was detached;
  //   - the same keyed history verified with no secret
  //     at all returns false — a keyed chain never
  //     verifies unkeyed, exactly as an unkeyed chain
  //     never verifies under a secret.
  // The secrets themselves are never printed.
  // Hand-written expectations — written out here from
  // the TaskLifecycleOptions docs and the keyed
  // hash-chain tests, never derived from
  // verifyHistoryChain itself. The segment asserts all
  // of this here, outside the printed lines: a keyed
  // verdict that drifted would fail the demo itself,
  // not just a test.
  const auditSecretTask = new TaskLifecycle("DEMO-028", {
    auditSecret: DEMO_AUDIT_SECRET,
  });
  for (const [event, actor, at] of [
    ["PUBLISH", "researcher", "2026-04-04T09:00:00.000Z"],
    ["ACCEPT", "contributor", "2026-04-04T09:05:00.000Z"],
    ["START_CAPTURE", "contributor", "2026-04-04T09:10:00.000Z"],
    ["SUBMIT", "contributor", "2026-04-04T09:15:00.000Z"],
  ] as const) {
    auditSecretTask.dispatch(event, { actor, at });
  }
  const auditSecretVerified = verifyHistoryChain(auditSecretTask.history, {
    auditSecret: DEMO_AUDIT_SECRET,
  });
  const auditSecretWrongVerified = verifyHistoryChain(
    auditSecretTask.history,
    { auditSecret: DEMO_AUDIT_WRONG_SECRET },
  );
  const auditSecretTamperedHistory = auditSecretTask.history.map(
    (entry) => ({ ...entry }),
  );
  auditSecretTamperedHistory[2] = {
    ...auditSecretTamperedHistory[2],
    payoutAmount: 999,
  };
  const auditSecretTamperedVerified = verifyHistoryChain(
    auditSecretTamperedHistory,
    { auditSecret: DEMO_AUDIT_SECRET },
  );
  const auditSecretUnkeyedVerified = verifyHistoryChain(
    auditSecretTask.history,
  );
  if (
    auditSecretTask.state !== "SUBMITTED" ||
    auditSecretTask.history.length !== 4 ||
    auditSecretTask.history[0].prevHash !== GENESIS_PREV_HASH ||
    auditSecretTask.history[1].prevHash !== auditSecretTask.history[0].hash ||
    auditSecretTask.history[2].prevHash !== auditSecretTask.history[1].hash ||
    auditSecretTask.history[3].prevHash !== auditSecretTask.history[2].hash ||
    auditSecretTask.history[0].event !== "PUBLISH" ||
    auditSecretTask.history[0].at !== "2026-04-04T09:00:00.000Z" ||
    auditSecretTask.history[3].event !== "SUBMIT" ||
    auditSecretTask.history[3].at !== "2026-04-04T09:15:00.000Z" ||
    auditSecretVerified !== true ||
    auditSecretWrongVerified !== false ||
    auditSecretTamperedVerified !== false ||
    auditSecretUnkeyedVerified !== false ||
    verifyHistoryChain(auditSecretTask.history, {
      auditSecret: DEMO_AUDIT_SECRET,
    }) !== true
  ) {
    throw new Error(
      "demo fixture broken: verifyHistoryChain auditSecret does not match the hand-pinned contract (the keyed history must verify under the correct secret with its genesis and successor links pinned, must return false under a wrong secret, must return false for a detached tampered copy under the correct secret while the original still verifies, and must return false with no secret at all)",
    );
  }
  lines.push(
    "",
    "Keyed audit hash chain (verifyHistoryChain with { auditSecret } verifies an HMAC-chained history only under its secret):",
    `  keyed task DEMO-028 (constructed with auditSecret, driven PUBLISH -> SUBMIT under fixed timestamps): history entries: 4; verifyHistoryChain with the correct secret: ${auditSecretVerified} (every link is HMAC-SHA256 keyed by the pinned secret — the secret itself is never printed)`,
    `  wrong secret: verifyHistoryChain: ${auditSecretWrongVerified} (the same history under a different secret recomputes no link — verification fails closed as false, never a throw)`,
    `  tampered copy: middle entry START_CAPTURE gains payoutAmount 999 — verifyHistoryChain with the correct secret: ${auditSecretTamperedVerified} (tamper detected: the stored HMAC no longer recomputes); original history after the tamper check: verifyHistoryChain: ${verifyHistoryChain(auditSecretTask.history, { auditSecret: DEMO_AUDIT_SECRET })} (detached copy — the keyed task's own history is untouched)`,
    `  no secret: verifyHistoryChain without a secret: ${auditSecretUnkeyedVerified} (a keyed chain never verifies unkeyed — fail-closed both ways, exactly as an unkeyed chain never verifies under a secret)`,
  );

  // Event-level RBAC segment (closing): every segment above
  // dispatches with named actors, but nothing ever checked
  // WHO may dispatch WHAT — the demo's actors were pure
  // audit decoration. The opt-in `rolePolicy`
  // (TaskLifecycleOptions, unit-tested since the RBAC tests
  // landed) maps covered events to an actor allowlist:
  // a covered dispatch whose actor is missing or outside
  // the list throws `actor not authorized for …` before
  // anything is appended; uncovered events skip the check
  // entirely; a task built without a policy skips it
  // everywhere. Two dedicated tasks are driven under fixed
  // literal timestamps — no network, no randomness, no
  // wall clock:
  //   - DEMO-029 carries the pinned DEMO_ROLE_POLICY
  //     (PUBLISH: [researcher], ACCEPT: [contributor],
  //     ARBITRATE_APPROVE / ARBITRATE_REJECT:
  //     [senior-moderator]). Its PUBLISH by contributor
  //     and its actor-less PUBLISH are both rejected with
  //     the pinned errors, leaving DRAFT / 0 entries; the
  //     allowlisted researcher then publishes and the
  //     allowlisted contributor accepts; the five
  //     uncovered events (START_CAPTURE, SUBMIT,
  //     BEGIN_REVIEW, REJECT, DISPUTE) run with no actor
  //     at all to DISPUTED / 7 entries; arbitration by
  //     contributor and actor-less arbitration are both
  //     rejected, leaving DISPUTED / 7 entries; the
  //     senior moderator then arbitrates to APPROVED.
  //   - DEMO-030 carries no policy: the same drive to
  //     DISPUTED and an actor-less ARBITRATE_APPROVE both
  //     succeed — the pre-policy behavior, unchanged.
  // Hand-written expectations — written out here from
  // the TaskLifecycleOptions docs and the RBAC tests,
  // never derived from the gate itself. The segment
  // asserts all of this here, outside the printed lines:
  // an authorization verdict that drifted would fail the
  // demo itself, not just a test. Honest limit: the
  // allowlist checks the actor NAME a dispatch carries;
  // authenticating that the caller really is that actor
  // is the caller's job, not this library's.
  const rolePolicyTask = new TaskLifecycle("DEMO-029", {
    rolePolicy: DEMO_ROLE_POLICY,
  });
  let rolePolicyPublishUnauthorizedError = "";
  try {
    rolePolicyTask.dispatch("PUBLISH", {
      actor: "contributor",
      at: "2026-04-06T09:00:00.000Z",
    });
  } catch (err) {
    rolePolicyPublishUnauthorizedError =
      err instanceof Error ? err.message : String(err);
  }
  let rolePolicyPublishMissingActorError = "";
  try {
    rolePolicyTask.dispatch("PUBLISH", {
      at: "2026-04-06T09:00:00.000Z",
    });
  } catch (err) {
    rolePolicyPublishMissingActorError =
      err instanceof Error ? err.message : String(err);
  }
  const rolePolicyStateAfterPublishRejects = rolePolicyTask.state;
  const rolePolicyHistoryLengthAfterPublishRejects =
    rolePolicyTask.history.length;
  rolePolicyTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-04-06T09:00:00.000Z",
  });
  rolePolicyTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-04-06T09:05:00.000Z",
  });
  for (const [event, at] of [
    ["START_CAPTURE", "2026-04-06T09:10:00.000Z"],
    ["SUBMIT", "2026-04-06T09:15:00.000Z"],
    ["BEGIN_REVIEW", "2026-04-06T09:20:00.000Z"],
    ["REJECT", "2026-04-06T09:25:00.000Z"],
    ["DISPUTE", "2026-04-06T09:30:00.000Z"],
  ] as const) {
    rolePolicyTask.dispatch(event, { at });
  }
  let rolePolicyArbitrateUnauthorizedError = "";
  try {
    rolePolicyTask.dispatch("ARBITRATE_APPROVE", {
      actor: "contributor",
      at: "2026-04-06T09:35:00.000Z",
    });
  } catch (err) {
    rolePolicyArbitrateUnauthorizedError =
      err instanceof Error ? err.message : String(err);
  }
  let rolePolicyArbitrateMissingActorError = "";
  try {
    rolePolicyTask.dispatch("ARBITRATE_APPROVE", {
      at: "2026-04-06T09:35:00.000Z",
    });
  } catch (err) {
    rolePolicyArbitrateMissingActorError =
      err instanceof Error ? err.message : String(err);
  }
  const rolePolicyStateAfterArbitrateRejects = rolePolicyTask.state;
  const rolePolicyHistoryLengthAfterArbitrateRejects =
    rolePolicyTask.history.length;
  rolePolicyTask.dispatch("ARBITRATE_APPROVE", {
    actor: "senior-moderator",
    at: "2026-04-06T09:40:00.000Z",
  });
  const rolePolicyDefaultTask = new TaskLifecycle("DEMO-030");
  for (const [event, at] of [
    ["PUBLISH", "2026-04-06T09:00:00.000Z"],
    ["ACCEPT", "2026-04-06T09:05:00.000Z"],
    ["START_CAPTURE", "2026-04-06T09:10:00.000Z"],
    ["SUBMIT", "2026-04-06T09:15:00.000Z"],
    ["BEGIN_REVIEW", "2026-04-06T09:20:00.000Z"],
    ["REJECT", "2026-04-06T09:25:00.000Z"],
    ["DISPUTE", "2026-04-06T09:30:00.000Z"],
    ["ARBITRATE_APPROVE", "2026-04-06T09:35:00.000Z"],
  ] as const) {
    rolePolicyDefaultTask.dispatch(event, { at });
  }
  if (
    rolePolicyPublishUnauthorizedError !==
      'actor not authorized for PUBLISH: "contributor" is not in [researcher]' ||
    rolePolicyPublishMissingActorError !==
      "actor not authorized for PUBLISH: policy requires an actor in [researcher]" ||
    rolePolicyStateAfterPublishRejects !== "DRAFT" ||
    rolePolicyHistoryLengthAfterPublishRejects !== 0 ||
    rolePolicyArbitrateUnauthorizedError !==
      'actor not authorized for ARBITRATE_APPROVE: "contributor" is not in [senior-moderator]' ||
    rolePolicyArbitrateMissingActorError !==
      "actor not authorized for ARBITRATE_APPROVE: policy requires an actor in [senior-moderator]" ||
    rolePolicyStateAfterArbitrateRejects !== "DISPUTED" ||
    rolePolicyHistoryLengthAfterArbitrateRejects !== 7 ||
    rolePolicyTask.state !== "APPROVED" ||
    rolePolicyTask.history.length !== 8 ||
    rolePolicyTask.history[0].event !== "PUBLISH" ||
    rolePolicyTask.history[0].actor !== "researcher" ||
    rolePolicyTask.history[0].at !== "2026-04-06T09:00:00.000Z" ||
    rolePolicyTask.history[2].actor !== undefined ||
    rolePolicyTask.history[7].event !== "ARBITRATE_APPROVE" ||
    rolePolicyTask.history[7].actor !== "senior-moderator" ||
    rolePolicyTask.history[7].at !== "2026-04-06T09:40:00.000Z" ||
    rolePolicyDefaultTask.state !== "APPROVED" ||
    rolePolicyDefaultTask.history.length !== 8 ||
    rolePolicyDefaultTask.history[7].event !== "ARBITRATE_APPROVE" ||
    rolePolicyDefaultTask.history[7].actor !== undefined
  ) {
    throw new Error(
      "demo fixture broken: rolePolicy does not match the hand-pinned contract (a covered event must reject an actor outside the allowlist and a missing actor with the pinned errors and no state or history change, an allowlisted actor must advance the task, uncovered events must run actor-less, and a task without a policy must arbitrate actor-less exactly as before)",
    );
  }
  lines.push(
    "",
    "Event-level RBAC (rolePolicy gates covered events to the listed actors):",
    `  policy task DEMO-029 (constructed with rolePolicy { PUBLISH: [researcher], ACCEPT: [contributor], ARBITRATE_APPROVE: [senior-moderator], ARBITRATE_REJECT: [senior-moderator] }): PUBLISH by researcher at 2026-04-06T09:00:00.000Z -> OPEN; ACCEPT by contributor -> ACCEPTED (the allowlist is an authorization check on the actor name, not identity authentication — a real deployment authenticates its actors itself)`,
    `  covered event, wrong or missing actor (DEMO-029): PUBLISH by contributor -> rejected: "${rolePolicyPublishUnauthorizedError}"; PUBLISH with no actor -> rejected: "${rolePolicyPublishMissingActorError}"; state after both rejections: ${rolePolicyStateAfterPublishRejects}, history entries: ${rolePolicyHistoryLengthAfterPublishRejects} (a rejected dispatch appends nothing — the check runs before the audit entry is written)`,
    `  uncovered events are unrestricted (DEMO-029): START_CAPTURE, SUBMIT, BEGIN_REVIEW, REJECT and DISPUTE with no actor at all -> DISPUTED, history entries: 7 (the policy lists only PUBLISH, ACCEPT and the two arbitration events — every other event skips the check entirely)`,
    `  arbitration is moderator-only (DEMO-029): ARBITRATE_APPROVE by contributor -> rejected: "${rolePolicyArbitrateUnauthorizedError}"; ARBITRATE_APPROVE with no actor -> rejected: "${rolePolicyArbitrateMissingActorError}"; state after both rejections: ${rolePolicyStateAfterArbitrateRejects}, history entries: ${rolePolicyHistoryLengthAfterArbitrateRejects}; ARBITRATE_APPROVE by senior-moderator -> ${rolePolicyTask.state}, history entries: ${rolePolicyTask.history.length}`,
    `  no policy, no check (DEMO-030): a task constructed without rolePolicy is driven to DISPUTED and arbitrated with no actor at all -> ${rolePolicyDefaultTask.state}, history entries: ${rolePolicyDefaultTask.history.length} (omitting the policy preserves the exact pre-policy behavior — no event requires an actor anywhere)`,
  );
  // Preseeded idempotency keys segment (closing): the
  // dispatch idempotency segment above shows keys consumed
  // by live dispatches, but a task rebuilt from its audit
  // log alone loses them — history entries carry no key
  // set (keys are dispatch configuration, not audit
  // data). The `idempotencyKeys` constructor option
  // (TaskLifecycleOptions, unit-tested since the
  // idempotency key snapshot tests landed) is the
  // re-attachment path `fromHistory()` documents: seed
  // the rebuilt task with the keys its predecessor had
  // already consumed, and their exactly-once effect
  // survives the rebuild. Two dedicated tasks are driven
  // under fixed literal timestamps — no network, no
  // randomness, no wall clock:
  //   - DEMO-031 is constructed with the seed list
  //     ["demo-seed-publish", "demo-seed-publish",
  //     "demo-seed-accept"]: the duplicate entry is
  //     deduped (first occurrence wins), so its snapshot
  //     carries exactly DEMO_SEEDED_IDEMPOTENCY_KEYS. It
  //     carries a collecting listener. Its ACCEPT at
  //     2026-04-07T09:00 under the seeded key
  //     "demo-seed-accept" is an event with no edge from
  //     DRAFT, yet it returns DRAFT without throwing —
  //     a consumed key is a complete no-op: the
  //     transition is not validated, nothing is
  //     appended, no listener is notified. Its PUBLISH
  //     at 09:05 under the fresh key "demo-fresh-publish"
  //     lands OPEN, and the same ACCEPT event at 09:10
  //     under the fresh key "demo-fresh-accept" lands
  //     ACCEPTED — each fresh key consumed by its
  //     successful dispatch, so the closing snapshot
  //     lists the two seed keys followed by the two
  //     fresh keys.
  //   - A construction attempt with seed [""] throws
  //     the pinned `invalid option: idempotencyKeys
  //     entries must be non-empty strings, got ""`
  //     before any task exists — the same bar dispatch
  //     applies to a single key.
  //   - DEMO-032 carries no seed: its keyless PUBLISH
  //     at 2026-04-07T09:00 lands OPEN with 1 entry and
  //     its snapshot omits `idempotencyKeys` entirely —
  //     the pre-seeding behavior, unchanged.
  // Hand-written expectations — written out here from
  // the TaskLifecycleOptions docs and the idempotency
  // key snapshot tests, never derived from the seeding
  // itself. The segment asserts all of this here,
  // outside the printed lines: a seeding verdict that
  // drifted would fail the demo itself, not just a test.
  const seededIdempotencyTask = new TaskLifecycle("DEMO-031", {
    idempotencyKeys: [
      "demo-seed-publish",
      "demo-seed-publish",
      "demo-seed-accept",
    ],
  });
  const seededIdempotencyNotificationEvents: TaskEvent[] = [];
  seededIdempotencyTask.subscribe((event) => {
    seededIdempotencyNotificationEvents.push(event);
  });
  const seededIdempotencySnapshotKeysAfterSeed =
    seededIdempotencyTask.toJSON().idempotencyKeys ?? [];
  const seededIdempotencyNoopReturn = seededIdempotencyTask.dispatch(
    "ACCEPT",
    {
      actor: "contributor",
      at: "2026-04-07T09:00:00.000Z",
      idempotencyKey: "demo-seed-accept",
    },
  );
  const seededIdempotencyStateAfterNoop = seededIdempotencyTask.state;
  const seededIdempotencyHistoryLengthAfterNoop =
    seededIdempotencyTask.history.length;
  const seededIdempotencyNotificationCountAfterNoop =
    seededIdempotencyNotificationEvents.length;
  seededIdempotencyTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-04-07T09:05:00.000Z",
    idempotencyKey: "demo-fresh-publish",
  });
  seededIdempotencyTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: "2026-04-07T09:10:00.000Z",
    idempotencyKey: "demo-fresh-accept",
  });
  const seededIdempotencySnapshotKeysAfterFreshKeys =
    seededIdempotencyTask.toJSON().idempotencyKeys ?? [];
  let seededIdempotencyEmptySeedError = "";
  try {
    new TaskLifecycle("DEMO-031-EMPTY-SEED", { idempotencyKeys: [""] });
  } catch (err) {
    seededIdempotencyEmptySeedError =
      err instanceof Error ? err.message : String(err);
  }
  const seededIdempotencyDefaultTask = new TaskLifecycle("DEMO-032");
  seededIdempotencyDefaultTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: "2026-04-07T09:00:00.000Z",
  });
  const seededIdempotencyDefaultSnapshotKeys =
    seededIdempotencyDefaultTask.toJSON().idempotencyKeys;
  if (
    JSON.stringify(seededIdempotencySnapshotKeysAfterSeed) !==
      JSON.stringify(["demo-seed-publish", "demo-seed-accept"]) ||
    seededIdempotencyNoopReturn !== "DRAFT" ||
    seededIdempotencyStateAfterNoop !== "DRAFT" ||
    seededIdempotencyHistoryLengthAfterNoop !== 0 ||
    seededIdempotencyNotificationCountAfterNoop !== 0 ||
    seededIdempotencyTask.state !== "ACCEPTED" ||
    seededIdempotencyTask.history.length !== 2 ||
    seededIdempotencyTask.history[0].event !== "PUBLISH" ||
    seededIdempotencyTask.history[0].at !== "2026-04-07T09:05:00.000Z" ||
    seededIdempotencyTask.history[1].event !== "ACCEPT" ||
    seededIdempotencyTask.history[1].at !== "2026-04-07T09:10:00.000Z" ||
    seededIdempotencyNotificationEvents.length !== 2 ||
    seededIdempotencyNotificationEvents[0] !== "PUBLISH" ||
    seededIdempotencyNotificationEvents[1] !== "ACCEPT" ||
    JSON.stringify(seededIdempotencySnapshotKeysAfterFreshKeys) !==
      JSON.stringify([
        "demo-seed-publish",
        "demo-seed-accept",
        "demo-fresh-publish",
        "demo-fresh-accept",
      ]) ||
    seededIdempotencyEmptySeedError !==
      'invalid option: idempotencyKeys entries must be non-empty strings, got ""' ||
    seededIdempotencyDefaultTask.state !== "OPEN" ||
    seededIdempotencyDefaultTask.history.length !== 1 ||
    seededIdempotencyDefaultTask.history[0].event !== "PUBLISH" ||
    seededIdempotencyDefaultTask.history[0].at !==
      "2026-04-07T09:00:00.000Z" ||
    seededIdempotencyDefaultSnapshotKeys !== undefined
  ) {
    throw new Error(
      "demo fixture broken: preseeded idempotencyKeys does not match the hand-pinned contract (duplicate seed entries must dedupe in order in the snapshot, a dispatch under a seeded key must be a complete no-op even for an illegal event — no validation, no append, no notification — the same event under a fresh key must advance and consume the key, an empty-string seed must throw the pinned construction error, and a seed-free task must keep the exact pre-seeding behavior with no snapshot key field)",
    );
  }
  lines.push(
    "",
    "Preseeded idempotency keys (idempotencyKeys seeds a task with already-consumed dispatch keys):",
    `  seeded task DEMO-031 (constructed with idempotencyKeys ["demo-seed-publish", "demo-seed-publish", "demo-seed-accept"]): duplicate seed entries are deduped, first occurrence wins — snapshot idempotencyKeys: ${JSON.stringify(seededIdempotencySnapshotKeysAfterSeed)} (the re-attachment path for fromHistory(), whose audit log cannot carry the key set — keys are dispatch configuration, not audit data)`,
    `  seeded key, illegal event (DEMO-031): ACCEPT with idempotencyKey "demo-seed-accept" from DRAFT (no ACCEPT edge leaves DRAFT) -> returns ${seededIdempotencyNoopReturn}; state after: ${seededIdempotencyStateAfterNoop}, history entries: ${seededIdempotencyHistoryLengthAfterNoop}, listener notifications: ${seededIdempotencyNotificationCountAfterNoop} (a consumed key is a complete no-op — the transition is not even validated, nothing is appended, no listener is notified)`,
    `  same event, fresh keys (DEMO-031): PUBLISH with idempotencyKey "demo-fresh-publish" -> OPEN; ACCEPT with idempotencyKey "demo-fresh-accept" -> ${seededIdempotencyTask.state}, history entries: ${seededIdempotencyTask.history.length}; snapshot idempotencyKeys after both: ${JSON.stringify(seededIdempotencySnapshotKeysAfterFreshKeys)} (each fresh key is consumed by its successful dispatch — a later retry under either is a no-op)`,
    `  invalid seed (construction): idempotencyKeys [""] -> rejected: "${seededIdempotencyEmptySeedError}" (every seed must be a non-empty string — the same bar dispatch applies to a single key, checked at construction before any task exists)`,
    `  no seed, no change (DEMO-032): a task constructed without idempotencyKeys dispatches PUBLISH with no key at all -> ${seededIdempotencyDefaultTask.state}, history entries: ${seededIdempotencyDefaultTask.history.length}; snapshot idempotencyKeys: ${seededIdempotencyDefaultSnapshotKeys} (omitting the seed preserves the exact pre-seeding behavior — the snapshot omits the field while the key set is empty)`,
  );

  // Payout webhook timeout segment (closing): every
  // delivery segment above settles through a response —
  // a success, a retry, a clamped wait, an abort the
  // caller asked for. None of them shows the per-attempt
  // deadline itself: `deliverPayoutWebhook`'s `timeoutMs`
  // option (settlementWebhook, unit-tested since the
  // delivery tests landed) arms an `AbortController` on
  // every attempt, so a receiver that never answers
  // cannot hang the delivery forever. Here the main
  // task's signed webhook (built and verified above) is
  // delivered to one fixed endpoint in three pinned
  // forms, all through injected fetches — zero real
  // network, zero randomness:
  //   - hanging receiver: the injected fetch never
  //     answers on its own and only settles when its
  //     `init.signal` aborts (exactly how the real
  //     fetch behaves), so the pinned `timeoutMs: 50`
  //     is the only thing that can end the attempt;
  //     with `maxAttempts: 1` the delivery reports
  //     exactly { ok: false, attempts: 1,
  //     error: "webhook delivery timed out after 50ms" }
  //     with no status, after exactly 1 fetch call —
  //     reported, never thrown, per this module's
  //     convention. The 50 ms wait is the behaviour
  //     under test itself, at its pinned short length;
  //     no elapsed wall-clock duration is asserted.
  //   - invalid timeout: `timeoutMs: 0` is a caller
  //     configuration error, so the call throws the
  //     pinned `cannot deliver payout webhook:
  //     timeoutMs must be a positive number, got 0`
  //     before any request — the counting fetch is
  //     never called (0 calls).
  //   - loose timeout: the same endpoint answering 200
  //     at once under `timeoutMs: 5000` reports exactly
  //     { ok: true, attempts: 1, status: 200 } after
  //     1 fetch call — a generous deadline changes
  //     nothing when the receiver is fast.
  // Hand-written expectations — written out here from
  // the DeliverPayoutWebhookOptions docs and the
  // delivery tests, never derived by calling
  // deliverPayoutWebhook itself. The segment asserts
  // all of this here, outside the printed lines: a
  // timeout verdict that drifted would fail the demo
  // itself, not just a test.
  const timeoutDeliveryEndpoint =
    "https://payouts.example.com/hooks/payout";
  const timeoutDeliveryTimeoutMs = 50;
  let timeoutDeliveryFetchCalls = 0;
  const timeoutDeliveryResult = await deliverPayoutWebhook(
    timeoutDeliveryEndpoint,
    webhook,
    {
      fetchImpl: (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          timeoutDeliveryFetchCalls += 1;
          init.signal?.addEventListener(
            "abort",
            () => reject(new Error("The operation was aborted")),
            { once: true },
          );
        }),
      timeoutMs: timeoutDeliveryTimeoutMs,
      maxAttempts: 1,
    },
  );
  let timeoutDeliveryInvalidFetchCalls = 0;
  let timeoutDeliveryInvalidError = "";
  try {
    await deliverPayoutWebhook(timeoutDeliveryEndpoint, webhook, {
      fetchImpl: async () => {
        timeoutDeliveryInvalidFetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
      timeoutMs: 0,
    });
  } catch (err) {
    timeoutDeliveryInvalidError =
      err instanceof Error ? err.message : String(err);
  }
  let timeoutDeliveryLooseFetchCalls = 0;
  const timeoutDeliveryLooseResult = await deliverPayoutWebhook(
    timeoutDeliveryEndpoint,
    webhook,
    {
      fetchImpl: async () => {
        timeoutDeliveryLooseFetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
      timeoutMs: 5000,
    },
  );
  if (
    timeoutDeliveryResult.ok !== false ||
    timeoutDeliveryResult.attempts !== 1 ||
    timeoutDeliveryResult.status !== undefined ||
    timeoutDeliveryResult.error !==
      "webhook delivery timed out after 50ms" ||
    timeoutDeliveryFetchCalls !== 1 ||
    timeoutDeliveryInvalidError !==
      "cannot deliver payout webhook: timeoutMs must be a positive number, got 0" ||
    timeoutDeliveryInvalidFetchCalls !== 0 ||
    timeoutDeliveryLooseResult.ok !== true ||
    timeoutDeliveryLooseResult.attempts !== 1 ||
    timeoutDeliveryLooseResult.status !== 200 ||
    timeoutDeliveryLooseResult.error !== undefined ||
    timeoutDeliveryLooseFetchCalls !== 1
  ) {
    throw new Error(
      "demo fixture broken: deliverPayoutWebhook timeoutMs does not match the hand-pinned contract (a hanging fetch under timeoutMs 50 with maxAttempts 1 must report { ok: false, attempts: 1, error: \"webhook delivery timed out after 50ms\" } with exactly one fetch call, timeoutMs 0 must throw the pinned configuration error with zero fetch calls, and an immediate 200 under timeoutMs 5000 must report { ok: true, attempts: 1, status: 200 } with exactly one fetch call)",
    );
  }
  lines.push(
    "",
    "Payout webhook timeout (deliverPayoutWebhook enforces a per-attempt timeoutMs, injected hanging fetch — no real network):",
    `  endpoint: ${timeoutDeliveryEndpoint} (the main task's signed payout webhook, delivered on its own — no fan-out)`,
    `  hanging receiver, pinned timeout: timeoutMs ${timeoutDeliveryTimeoutMs} with maxAttempts 1; the injected fetch never answers on its own and only settles when the per-attempt abort fires -> delivery ok=${timeoutDeliveryResult.ok} attempts=${timeoutDeliveryResult.attempts} error="${timeoutDeliveryResult.error}"; fetch calls: ${timeoutDeliveryFetchCalls} (the timeout is reported in the result, never thrown — the 50 ms wait is the behaviour under test itself, at its pinned short length, and no elapsed duration is asserted)`,
    `  invalid timeout (configuration): timeoutMs 0 -> rejected: "${timeoutDeliveryInvalidError}"; fetch calls: ${timeoutDeliveryInvalidFetchCalls} (an invalid timeout is a caller bug, so it throws before any request is made — a delivery outcome, by contrast, is only ever reported)`,
    `  loose timeout, immediate answer: timeoutMs 5000 and the endpoint answers 200 at once -> delivery ok=${timeoutDeliveryLooseResult.ok} attempts=${timeoutDeliveryLooseResult.attempts} status=${timeoutDeliveryLooseResult.status}; fetch calls: ${timeoutDeliveryLooseFetchCalls} (a generous deadline changes nothing when the receiver is fast — the success shape is exactly the untimed one)`,
  );

  // Payout webhook fan-out timeout override segment
  // (closing): the timeout segment above pins the
  // deadline on a single-endpoint delivery. The fan-out
  // delivery resolves `timeoutMs` PER ENDPOINT —
  // `endpoint.timeoutMs ?? opts.timeoutMs`
  // (settlementWebhook) — so one slow receiver can be
  // given a tight deadline without tightening the whole
  // fan-out, and a bad override is a per-endpoint
  // pre-flight failure that lands in that endpoint's
  // result instead of throwing for the call. Here the
  // main task's payout event is fanned out to the same
  // three fixed endpoints in three pinned forms — one
  // shared fixed `now` (2026-03-21T09:00:00.000Z) and
  // one shared fixed eventId ("evt_demo_fanout_timeout_001")
  // per call, each endpoint signed with its own demo
  // secret (placeholder values in this source, not real
  // credentials), all through injected fetches with an
  // injected no-op sleep and backoffMs 0 — zero real
  // network, zero randomness:
  //   - override: under a loose call-level
  //     `timeoutMs: 5000`, the slow endpoint pins its
  //     own `timeoutMs: 50` AND its own hanging fetch
  //     (per-endpoint `fetchImpl` override — it never
  //     answers on its own and only settles when the
  //     per-attempt abort fires). A timeout is a
  //     retryable failure, so the endpoint burns all
  //     3 default attempts at 50 ms each and reports
  //     exactly { ok: false, attempts: 3,
  //     error: "webhook delivery timed out after 50ms" }
  //     after exactly 3 fetch calls; billing and
  //     notifications (no override) answer 200 at once
  //     under the call-level deadline and report the
  //     unchanged success shape, and the results stay
  //     in input order — delivered 2, failed 1.
  //   - invalid override: the notifications endpoint
  //     pins `timeoutMs: 0`. That is a caller
  //     configuration error for that endpoint only, so
  //     the fan-out reports it as exactly
  //     { ok: false, attempts: 0,
  //     error: "cannot deliver payout webhook: timeoutMs must be a positive number, got 0" }
  //     and makes zero fetch calls to it, while billing
  //     and slow (answering 200 at once in this call)
  //     are unchanged — delivered 2, failed 1. (The
  //     same value at CALL level would throw for the
  //     whole call before any request, as the timeout
  //     segment's single-endpoint form showed.)
  //   - no override: no endpoint pins `timeoutMs` and
  //     the call does not set one either (the 5000 ms
  //     default applies) — all three endpoints report
  //     the unchanged success shape, delivered 3,
  //     failed 0: omitting the override preserves the
  //     exact fan-out behaviour of the segment above.
  // Hand-written expectations — written out here from
  // the PayoutWebhookEndpoint docs and the fan-out
  // tests, never derived by calling
  // deliverPayoutWebhookToMany itself. The segment
  // asserts all of this here, outside the printed
  // lines: an override verdict that drifted would fail
  // the demo itself, not just a test. Honest limit, as
  // in the timeout segment: the 50 ms waits are the
  // behaviour under test itself, at their pinned short
  // length; no elapsed wall-clock duration is asserted.
  const FANOUT_TIMEOUT_NOW = new Date("2026-03-21T09:00:00.000Z");
  const FANOUT_TIMEOUT_EVENT_ID = "evt_demo_fanout_timeout_001";
  const fanoutTimeoutCallTimeoutMs = 5000;
  const fanoutTimeoutOverrideMs = 50;
  const fanoutTimeoutEndpoints = [
    {
      name: "billing",
      url: "https://billing.example.com/hooks/payout",
      secret: ["demo-secret", "fanout-timeout", "billing"].join("-"),
    },
    {
      name: "slow",
      url: "https://slow.example.com/hooks/payout",
      secret: ["demo-secret", "fanout-timeout", "slow"].join("-"),
    },
    {
      name: "notifications",
      url: "https://notifications.example.com/hooks/payout",
      secret: ["demo-secret", "fanout-timeout", "notifications"].join("-"),
    },
  ] as const;
  const immediate200 = (count: (url: string) => void): PayoutWebhookFetchImpl =>
    async (url) => {
      count(url);
      return new Response("{}", { status: 200 });
    };
  // Override call: billing + notifications go through the
  // call-level counting fetch; slow goes through its own
  // per-endpoint hanging fetch.
  let fanoutTimeoutFastFetchCalls = 0;
  let fanoutTimeoutHangFetchCalls = 0;
  const fanoutTimeoutResult = await deliverPayoutWebhookToMany(
    task,
    fanoutTimeoutEndpoints.map((ep) =>
      ep.name === "slow"
        ? {
            url: ep.url,
            secret: ep.secret,
            timeoutMs: fanoutTimeoutOverrideMs,
            fetchImpl: ((_url: string, init: RequestInit) =>
              new Promise<Response>((_resolve, reject) => {
                fanoutTimeoutHangFetchCalls += 1;
                init.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("The operation was aborted")),
                  { once: true },
                );
              })) as PayoutWebhookFetchImpl,
          }
        : { url: ep.url, secret: ep.secret },
    ),
    {
      fetchImpl: immediate200(() => {
        fanoutTimeoutFastFetchCalls += 1;
      }),
      sleepImpl: async () => {},
      backoffMs: 0,
      timeoutMs: fanoutTimeoutCallTimeoutMs,
      now: FANOUT_TIMEOUT_NOW,
      eventId: FANOUT_TIMEOUT_EVENT_ID,
    },
  );
  // Invalid-override call: notifications pins timeoutMs 0;
  // every endpoint would go through the counting fetch,
  // so the invalid endpoint's zero fetch calls are
  // observable per URL.
  const fanoutTimeoutInvalidCallsByUrl = new Map<string, number>();
  const fanoutTimeoutInvalidResult = await deliverPayoutWebhookToMany(
    task,
    fanoutTimeoutEndpoints.map((ep) =>
      ep.name === "notifications"
        ? { url: ep.url, secret: ep.secret, timeoutMs: 0 }
        : { url: ep.url, secret: ep.secret },
    ),
    {
      fetchImpl: immediate200((url) => {
        fanoutTimeoutInvalidCallsByUrl.set(
          url,
          (fanoutTimeoutInvalidCallsByUrl.get(url) ?? 0) + 1,
        );
      }),
      sleepImpl: async () => {},
      backoffMs: 0,
      timeoutMs: fanoutTimeoutCallTimeoutMs,
      now: FANOUT_TIMEOUT_NOW,
      eventId: FANOUT_TIMEOUT_EVENT_ID,
    },
  );
  const fanoutTimeoutInvalidFetchCalls =
    fanoutTimeoutInvalidCallsByUrl.get(fanoutTimeoutEndpoints[2].url) ?? 0;
  // No-override call: no timeoutMs anywhere — neither on
  // an endpoint nor at call level.
  const fanoutTimeoutPlainResult = await deliverPayoutWebhookToMany(
    task,
    fanoutTimeoutEndpoints.map(({ url, secret }) => ({ url, secret })),
    {
      fetchImpl: immediate200(() => {}),
      sleepImpl: async () => {},
      backoffMs: 0,
      now: FANOUT_TIMEOUT_NOW,
      eventId: FANOUT_TIMEOUT_EVENT_ID,
    },
  );
  const fanoutTimeoutOkShape = { ok: true, attempts: 1, status: 200 };
  if (
    fanoutTimeoutResult.delivered !== 2 ||
    fanoutTimeoutResult.failed !== 1 ||
    fanoutTimeoutResult.results.length !== 3 ||
    fanoutTimeoutResult.results[0].ok !== fanoutTimeoutOkShape.ok ||
    fanoutTimeoutResult.results[0].attempts !== 1 ||
    fanoutTimeoutResult.results[0].status !== 200 ||
    fanoutTimeoutResult.results[0].error !== undefined ||
    fanoutTimeoutResult.results[1].ok !== false ||
    fanoutTimeoutResult.results[1].attempts !== 3 ||
    fanoutTimeoutResult.results[1].status !== undefined ||
    fanoutTimeoutResult.results[1].error !==
      "webhook delivery timed out after 50ms" ||
    fanoutTimeoutResult.results[2].ok !== fanoutTimeoutOkShape.ok ||
    fanoutTimeoutResult.results[2].attempts !== 1 ||
    fanoutTimeoutResult.results[2].status !== 200 ||
    fanoutTimeoutResult.results[2].error !== undefined ||
    fanoutTimeoutHangFetchCalls !== 3 ||
    fanoutTimeoutFastFetchCalls !== 2 ||
    fanoutTimeoutInvalidResult.delivered !== 2 ||
    fanoutTimeoutInvalidResult.failed !== 1 ||
    fanoutTimeoutInvalidResult.results[0].ok !== true ||
    fanoutTimeoutInvalidResult.results[0].attempts !== 1 ||
    fanoutTimeoutInvalidResult.results[0].status !== 200 ||
    fanoutTimeoutInvalidResult.results[1].ok !== true ||
    fanoutTimeoutInvalidResult.results[1].attempts !== 1 ||
    fanoutTimeoutInvalidResult.results[1].status !== 200 ||
    fanoutTimeoutInvalidResult.results[2].ok !== false ||
    fanoutTimeoutInvalidResult.results[2].attempts !== 0 ||
    fanoutTimeoutInvalidResult.results[2].status !== undefined ||
    fanoutTimeoutInvalidResult.results[2].error !==
      "cannot deliver payout webhook: timeoutMs must be a positive number, got 0" ||
    fanoutTimeoutInvalidFetchCalls !== 0 ||
    (fanoutTimeoutInvalidCallsByUrl.get(fanoutTimeoutEndpoints[0].url) ?? 0) !== 1 ||
    (fanoutTimeoutInvalidCallsByUrl.get(fanoutTimeoutEndpoints[1].url) ?? 0) !== 1 ||
    fanoutTimeoutPlainResult.delivered !== 3 ||
    fanoutTimeoutPlainResult.failed !== 0 ||
    fanoutTimeoutPlainResult.results.some(
      (r) => r.ok !== true || r.attempts !== 1 || r.status !== 200 || r.error !== undefined,
    )
  ) {
    throw new Error(
      "demo fixture broken: deliverPayoutWebhookToMany per-endpoint timeoutMs overrides do not match the hand-pinned contract (under a call-level timeoutMs 5000, the slow endpoint's timeoutMs 50 override with a hanging fetch must report { ok: false, attempts: 3, error: \"webhook delivery timed out after 50ms\" } after exactly 3 fetch calls while billing and notifications report { ok: true, attempts: 1, status: 200 } in input order; a timeoutMs 0 override must land as { ok: false, attempts: 0, error: \"cannot deliver payout webhook: timeoutMs must be a positive number, got 0\" } for that endpoint alone with zero fetch calls to it; and a fan-out with no override anywhere must deliver all three endpoints unchanged)",
    );
  }
  lines.push(
    "",
    "Payout webhook fan-out timeout overrides (deliverPayoutWebhookToMany resolves timeoutMs per endpoint — endpoint.timeoutMs ?? call-level timeoutMs, injected fetches — no real network):",
    `  shared eventId: ${FANOUT_TIMEOUT_EVENT_ID}, shared at: ${FANOUT_TIMEOUT_NOW.toISOString()} (one logical event for all three endpoints in each call, as in the fan-out segment above; every endpoint signed with its own secret)`,
    `  pinned override, hanging receiver (slow, ${fanoutTimeoutEndpoints[1].url}): per-endpoint timeoutMs ${fanoutTimeoutOverrideMs} overrides the call-level ${fanoutTimeoutCallTimeoutMs}; the endpoint's own injected fetch never answers on its own and only settles when the per-attempt abort fires -> ok=${fanoutTimeoutResult.results[1].ok} attempts=${fanoutTimeoutResult.results[1].attempts} error="${fanoutTimeoutResult.results[1].error}"; fetch calls: ${fanoutTimeoutHangFetchCalls} (a timeout is a retryable failure, so the endpoint burns all 3 attempts at 50 ms each — the waits are the behaviour under test itself, at their pinned short length, and no elapsed duration is asserted)`,
    `  no override, same call (billing + notifications): neither endpoint pins timeoutMs, so the call-level ${fanoutTimeoutCallTimeoutMs} applies and both answer 200 at once -> billing ok=${fanoutTimeoutResult.results[0].ok} attempts=${fanoutTimeoutResult.results[0].attempts} status=${fanoutTimeoutResult.results[0].status}, notifications ok=${fanoutTimeoutResult.results[2].ok} attempts=${fanoutTimeoutResult.results[2].attempts} status=${fanoutTimeoutResult.results[2].status}; fan-out: ${fanoutTimeoutResult.delivered} delivered, ${fanoutTimeoutResult.failed} failed — results stay in input order (billing, slow, notifications) and the timed-out endpoint did not block the others`,
    `  invalid override, isolated failure (notifications): per-endpoint timeoutMs 0 -> its result is exactly { ok: false, attempts: 0, error: "${fanoutTimeoutInvalidResult.results[2].error}" }; fetch calls to that endpoint: ${fanoutTimeoutInvalidFetchCalls}; billing and slow (answering 200 at once in this call) are unchanged at ok=true attempts=1 status=200 — a bad per-endpoint override is reported for its own endpoint only, where the same value at call level would throw for the whole call before any request`,
    `  no overrides anywhere: no endpoint pins timeoutMs and the call sets none either (the 5000 ms default applies) -> all three endpoints ok=true attempts=1 status=200; fan-out: ${fanoutTimeoutPlainResult.delivered} delivered, ${fanoutTimeoutPlainResult.failed} failed (omitting the override preserves the exact pre-override fan-out behaviour)`,
  );

  // Dispatch expectedSeq optimistic concurrency segment
  // (closing): every dispatch above moves its task
  // forward on the caller's word alone. None of them
  // shows the optimistic-concurrency guard —
  // `dispatch(event, { expectedSeq })`
  // (taskLifecycle, unit-tested since the expectedSeq
  // tests landed and timed by the benchmark) — under
  // which the caller pins the history length (the
  // last entry's `seq`; 0 for an empty history) it
  // based its decision on, and the guard runs before
  // every other dispatch check. Here five dedicated
  // tasks act it out under fixed timestamps — zero
  // network, zero randomness:
  //   - correct guard: DEMO-033 is driven PUBLISH ->
  //     ACCEPT (researcher / contributor, at the
  //     pinned base instant and base + 1s) to a pinned
  //     2-entry history in ACCEPTED, and
  //     `START_CAPTURE` with `expectedSeq: 2` at
  //     base + 2s advances it exactly one step: the
  //     dispatch returns CAPTURING, the history grows
  //     to exactly 3 entries, and the last entry is
  //     seq 3 / START_CAPTURE / ACCEPTED -> CAPTURING
  //     at base + 2s, carrying the pinned actor.
  //   - stale guard: DEMO-034, at the same pinned
  //     2-entry history, rejects the same dispatch
  //     with `expectedSeq: 1` with exactly
  //     `dispatch conflict: expected seq 1 but task is at seq 2`
  //     and changes nothing — the state stays
  //     ACCEPTED, the history stays at 2 entries and
  //     is byte-identical through the canonical
  //     NDJSON serializer.
  //   - empty history: a fresh DEMO-035 advances
  //     under `PUBLISH` with `expectedSeq: 0` to OPEN
  //     with exactly 1 entry — 0 is the guard for an
  //     empty history.
  //   - illegal guards: on a fresh DEMO-036 probe,
  //     `expectedSeq: -1` and `expectedSeq: 1.5` each
  //     throw exactly their pinned
  //     `invalid dispatch options: expectedSeq must be a non-negative integer, got …`
  //     configuration error and append nothing — the
  //     probe stays in DRAFT with 0 entries.
  //   - no guard: DEMO-037, at the same pinned
  //     2-entry history, advances under
  //     `START_CAPTURE` with no `expectedSeq` at all
  //     to CAPTURING with 3 entries — omitting the
  //     guard preserves the exact pre-guard behavior.
  // Hand-written expectations — written out here from
  // the DispatchOptions docs and cross-checked
  // against test/expectedSeq.test.ts, never derived
  // from the guard itself. The segment asserts all of
  // this here, outside the printed lines: a guard
  // verdict that drifted would fail the demo itself,
  // not just a test. Honest limit, as in the
  // DispatchOptions docs: this is a single-process
  // optimistic lock against the in-memory history;
  // cross-process writers still need compare-and-swap
  // in the durable store itself.
  const expectedSeqAt = (offsetSeconds: number): string =>
    new Date(
      Date.parse("2026-03-22T09:00:00.000Z") + offsetSeconds * 1000,
    ).toISOString();
  const buildExpectedSeqTask = (id: string): TaskLifecycle => {
    const pinned = new TaskLifecycle(id);
    pinned.dispatch("PUBLISH", {
      actor: "researcher",
      at: expectedSeqAt(0),
    });
    pinned.dispatch("ACCEPT", {
      actor: "contributor",
      at: expectedSeqAt(1),
    });
    return pinned;
  };
  const expectedSeqTask = buildExpectedSeqTask("DEMO-033");
  const expectedSeqGuardedReturn = expectedSeqTask.dispatch(
    "START_CAPTURE",
    {
      actor: "contributor",
      at: expectedSeqAt(2),
      expectedSeq: 2,
    },
  );
  const expectedSeqConflictTask = buildExpectedSeqTask("DEMO-034");
  const expectedSeqConflictHistoryBefore = historyToNdjson(
    expectedSeqConflictTask.history,
  );
  let expectedSeqConflictError = "";
  try {
    expectedSeqConflictTask.dispatch("START_CAPTURE", {
      actor: "contributor",
      at: expectedSeqAt(2),
      expectedSeq: 1,
    });
  } catch (err) {
    expectedSeqConflictError =
      err instanceof Error ? err.message : String(err);
  }
  const expectedSeqConflictStateAfter = expectedSeqConflictTask.state;
  const expectedSeqConflictHistoryLengthAfter =
    expectedSeqConflictTask.history.length;
  const expectedSeqEmptyTask = new TaskLifecycle("DEMO-035");
  const expectedSeqEmptyReturn = expectedSeqEmptyTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: expectedSeqAt(0),
    expectedSeq: 0,
  });
  const expectedSeqIllegalTask = new TaskLifecycle("DEMO-036");
  let expectedSeqNegativeError = "";
  try {
    expectedSeqIllegalTask.dispatch("PUBLISH", {
      actor: "researcher",
      at: expectedSeqAt(0),
      expectedSeq: -1,
    });
  } catch (err) {
    expectedSeqNegativeError =
      err instanceof Error ? err.message : String(err);
  }
  let expectedSeqFractionError = "";
  try {
    expectedSeqIllegalTask.dispatch("PUBLISH", {
      actor: "researcher",
      at: expectedSeqAt(0),
      expectedSeq: 1.5,
    });
  } catch (err) {
    expectedSeqFractionError =
      err instanceof Error ? err.message : String(err);
  }
  const expectedSeqUnguardedTask = buildExpectedSeqTask("DEMO-037");
  const expectedSeqUnguardedReturn = expectedSeqUnguardedTask.dispatch(
    "START_CAPTURE",
    {
      actor: "contributor",
      at: expectedSeqAt(2),
    },
  );
  const expectedSeqLast = expectedSeqTask.history[2];
  if (
    expectedSeqGuardedReturn !== "CAPTURING" ||
    expectedSeqTask.state !== "CAPTURING" ||
    expectedSeqTask.history.length !== 3 ||
    expectedSeqLast.seq !== 3 ||
    expectedSeqLast.event !== "START_CAPTURE" ||
    expectedSeqLast.from !== "ACCEPTED" ||
    expectedSeqLast.to !== "CAPTURING" ||
    expectedSeqLast.at !== expectedSeqAt(2) ||
    expectedSeqLast.actor !== "contributor" ||
    expectedSeqConflictError !==
      "dispatch conflict: expected seq 1 but task is at seq 2" ||
    expectedSeqConflictStateAfter !== "ACCEPTED" ||
    expectedSeqConflictHistoryLengthAfter !== 2 ||
    historyToNdjson(expectedSeqConflictTask.history) !==
      expectedSeqConflictHistoryBefore ||
    expectedSeqEmptyReturn !== "OPEN" ||
    expectedSeqEmptyTask.state !== "OPEN" ||
    expectedSeqEmptyTask.history.length !== 1 ||
    expectedSeqEmptyTask.history[0].seq !== 1 ||
    expectedSeqEmptyTask.history[0].event !== "PUBLISH" ||
    expectedSeqNegativeError !==
      "invalid dispatch options: expectedSeq must be a non-negative integer, got -1" ||
    expectedSeqFractionError !==
      "invalid dispatch options: expectedSeq must be a non-negative integer, got 1.5" ||
    expectedSeqIllegalTask.state !== "DRAFT" ||
    expectedSeqIllegalTask.history.length !== 0 ||
    expectedSeqUnguardedReturn !== "CAPTURING" ||
    expectedSeqUnguardedTask.state !== "CAPTURING" ||
    expectedSeqUnguardedTask.history.length !== 3
  ) {
    throw new Error(
      "demo fixture broken: dispatch expectedSeq does not match the hand-pinned contract (a task at seq 2 must advance exactly one step under START_CAPTURE with expectedSeq 2 to CAPTURING with a pinned seq-3 last entry; a stale expectedSeq 1 must throw the pinned dispatch-conflict error and leave state and history byte-identical; expectedSeq 0 must advance an empty history; -1 and 1.5 must throw their pinned configuration errors and append nothing; and dispatch without expectedSeq must behave unchanged)",
    );
  }
  lines.push(
    "",
    "Dispatch expectedSeq optimistic concurrency (dispatch pins the history length the caller read — fixed timestamps, no network):",
    `  correct guard (DEMO-033): driven PUBLISH -> ACCEPT under fixed timestamps to seq 2 (state ACCEPTED, history entries: 2); START_CAPTURE with expectedSeq 2 at ${expectedSeqAt(2)} -> ${expectedSeqGuardedReturn}, history entries: ${expectedSeqTask.history.length}; last entry: seq 3 START_CAPTURE ACCEPTED -> CAPTURING by contributor (the caller pinned the seq it based its decision on and the task was still there, so exactly one step advances)`,
    `  stale guard (DEMO-034): the same pinned 2-entry history; START_CAPTURE with expectedSeq 1 -> rejected: "${expectedSeqConflictError}"; state after: ${expectedSeqConflictStateAfter}, history entries: ${expectedSeqConflictHistoryLengthAfter} (the guard runs before every other dispatch check and changes nothing — no state move, no history entry — so a writer holding a stale snapshot fails loudly instead of advancing a state it never saw, and re-reading the task and retrying with the fresh seq works)`,
    `  empty history (DEMO-035): a fresh task (history entries: 0); PUBLISH with expectedSeq 0 -> ${expectedSeqEmptyReturn}, history entries: ${expectedSeqEmptyTask.history.length} (0 is the guard for an empty history — the seq is the history length, which is the last entry's seq once entries exist)`,
    `  illegal guards (DEMO-036): PUBLISH with expectedSeq -1 -> rejected: "${expectedSeqNegativeError}"; PUBLISH with expectedSeq 1.5 -> rejected: "${expectedSeqFractionError}"; state after both: ${expectedSeqIllegalTask.state}, history entries: ${expectedSeqIllegalTask.history.length} (a non-integer or negative expectedSeq is a caller configuration error, thrown up front before anything mutates)`,
    `  no guard (DEMO-037): the same pinned 2-entry history; START_CAPTURE with no expectedSeq -> ${expectedSeqUnguardedReturn}, history entries: ${expectedSeqUnguardedTask.history.length} (omitting expectedSeq preserves the exact pre-guard behavior)`,
  );

  // --- Stale patrol: staleTasks / maxAgeByState edge forms ---
  // A dedicated patrol over five further tasks on the same fixed
  // ---------------------------------------------------------------------------
  // Constructor id fail-fast segment. A live TaskLifecycle must never hold an
  // id its own snapshots could not restore, so the constructor rejects
  // empty/non-string ids before any state exists — the first door of the audit
  // chain; bad ids never even enter. It runs before the closing stale patrol
  // segment so the demo keeps closing on the patrol.
  // ---------------------------------------------------------------------------
  const constructorGuardInputs: Array<{ input: string; value: unknown }> = [
    { input: '""', value: "" },
    { input: "undefined", value: undefined },
    { input: "123", value: 123 },
  ];
  const constructorGuardChecks: Array<{ input: string; error: string }> = [];
  for (const { input, value } of constructorGuardInputs) {
    try {
      // @ts-expect-error intentional misuse under test — the guard must reject it
      new TaskLifecycle(value);
      throw new Error(`demo fixture broken: bad id ${input} was constructed`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (error !== DEMO_CONSTRUCTOR_ID_ERROR) {
        throw new Error(
          `demo fixture broken: bad id ${input} rejected with unexpected message: ${error}`,
        );
      }
      constructorGuardChecks.push({ input, error });
    }
  }
  const constructorGuardTask = new TaskLifecycle(DEMO_GUARD_TASK_ID);
  constructorGuardTask.dispatch("PUBLISH");
  lines.push(
    "",
    "Constructor id fail-fast (the first door of the audit chain):",
    ...constructorGuardChecks.map(
      (check) => `  new TaskLifecycle(${check.input}) throws: ${check.error}`,
    ),
    `  new TaskLifecycle("${DEMO_GUARD_TASK_ID}") constructs and dispatches PUBLISH → ${constructorGuardTask.state}`,
  );

  // ---------------------------------------------------------------------------
  // History getter immutability segment. The history getter returns an
  // array+entry double-frozen detached snapshot — dispatch() is the only
  // append path — so the audit trail cannot be rewritten at runtime, even
  // by an accidental caller (pinned by test/historyFreeze.test.ts). The
  // demo shows it instead of only asserting it: on DEMO-045, driven
  // PUBLISH -> ACCEPT under fixed timestamps, the segment takes a
  // snapshot and tries a push, a splice, and an entry.note rewrite — all
  // three throw TypeError while the internal history stays at exactly 2
  // entries and the first entry is byte-identical; two getter calls then
  // return deep-equal but reference-independent snapshots; and a later
  // START_CAPTURE dispatch leaves the earlier snapshot at 2 entries while
  // the live history grows to 3 (detached semantics — the snapshot is a
  // frozen copy of the past, never a live view). Fixed timestamps, zero
  // network, zero randomness. Hand-written expectations — written out here
  // from the historyFreeze tests' assertions and cross-checked against
  // them, never derived from the getter itself. The segment asserts all
  // of this here, outside the printed lines: a tamper probe that stopped
  // throwing would fail the demo itself, not just a test. Honest limit,
  // as in the getter's JSDoc: this is an in-process guard against
  // accidental rewrites; callers holding the process's memory can still
  // write through the live TaskLifecycle API, and durability across
  // processes needs the append-only store underneath.
  // ---------------------------------------------------------------------------
  const historyImmutabilityTask = new TaskLifecycle(DEMO_HISTORY_TASK_ID);
  historyImmutabilityTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: DEMO_HISTORY_BASE_AT,
  });
  historyImmutabilityTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: new Date(Date.parse(DEMO_HISTORY_BASE_AT) + 1000).toISOString(),
  });
  const historyImmutabilitySnapshot = historyImmutabilityTask.history as unknown as TaskHistoryEntry[];
  const forgedImmutabilityEntry: TaskHistoryEntry = {
    seq: 99,
    event: "PUBLISH",
    from: "DRAFT",
    to: "OPEN",
    at: DEMO_HISTORY_BASE_AT,
  };
  let historyPushError = "no error";
  try {
    historyImmutabilitySnapshot.push(forgedImmutabilityEntry);
  } catch (err) {
    historyPushError = err instanceof Error ? err.name : "non-error";
  }
  let historySpliceError = "no error";
  try {
    historyImmutabilitySnapshot.splice(0, 1);
  } catch (err) {
    historySpliceError = err instanceof Error ? err.name : "non-error";
  }
  let historyEntryWriteError = "no error";
  try {
    historyImmutabilitySnapshot[0].note = "forged";
  } catch (err) {
    historyEntryWriteError = err instanceof Error ? err.name : "non-error";
  }
  const historyInternalLengthAfterProbes =
    historyImmutabilityTask.history.length;
  const historyInternalEntryUnchanged =
    historyImmutabilityTask.history[0].to === "OPEN" &&
    historyImmutabilityTask.history[0].note === undefined;
  const historySnapshotA = historyImmutabilityTask.history;
  const historySnapshotB = historyImmutabilityTask.history;
  const historySnapshotsDeepEqualButIndependent =
    historySnapshotA !== historySnapshotB &&
    JSON.stringify(historySnapshotA) === JSON.stringify(historySnapshotB);
  const historySnapshotBeforeDispatch = historyImmutabilityTask.history;
  historyImmutabilityTask.dispatch("START_CAPTURE", {
    actor: "contributor",
    at: new Date(Date.parse(DEMO_HISTORY_BASE_AT) + 2000).toISOString(),
  });
  const historyDetachedSnapshotLength = historySnapshotBeforeDispatch.length;
  const historyLiveLength = historyImmutabilityTask.history.length;
  const historyImmutabilityChecks: HistoryImmutabilityChecks = {
    pushError: historyPushError,
    spliceError: historySpliceError,
    entryWriteError: historyEntryWriteError,
    internalLengthAfterProbes: historyInternalLengthAfterProbes,
    snapshotsDeepEqualButIndependent:
      historySnapshotsDeepEqualButIndependent,
    detachedSnapshotLengthAfterDispatch: historyDetachedSnapshotLength,
    liveLengthAfterDispatch: historyLiveLength,
  };
  if (
    historyPushError !== "TypeError" ||
    historySpliceError !== "TypeError" ||
    historyEntryWriteError !== "TypeError" ||
    historyInternalLengthAfterProbes !== 2 ||
    !historyInternalEntryUnchanged ||
    !historySnapshotsDeepEqualButIndependent ||
    historyDetachedSnapshotLength !== 2 ||
    historyLiveLength !== 3 ||
    historyImmutabilityTask.state !== "CAPTURING"
  ) {
    throw new Error(
      "demo fixture broken: history immutability segment does not match the pinned contract (push, splice and entry-field writes on the returned snapshot must each throw TypeError and leave the internal history at exactly 2 unchanged entries; two getter calls must return deep-equal but reference-independent snapshots; a later dispatch must leave the earlier snapshot at 2 entries while the live history grows to 3)",
    );
  }
  lines.push(
    "",
    "History getter immutability (the audit trail cannot be rewritten at runtime — fixed timestamps, no network):",
    `  push a forged entry onto the history snapshot (${DEMO_HISTORY_TASK_ID}): throws ${historyPushError}; internal history still 2 entries`,
    `  splice the history snapshot: throws ${historySpliceError}; internal history still 2 entries`,
    `  rewrite entry.note on the history snapshot: throws ${historyEntryWriteError}; internal entry unchanged`,
    "  two history getter calls return deep-equal but reference-independent snapshots (the array is never handed out twice)",
    "  dispatch START_CAPTURE after the snapshot: the old snapshot stays at 2 entries, the live history grows to 3 — a frozen detached copy; dispatch() is the only append path",
  );

  // `now` as the stale branches above, screened by `staleTasks`
  // ALONE under a patrol budget map — the `maxAgeByState`
  // parameter itself (DRAFT / OPEN / PAID at 7 days each;
  // IN_REVIEW deliberately absent), which the branches above
  // only ever passed under local names — see the fixture comment
  // above for the hand-computed expectations. Exactly one task
  // is stale; the other four are each excluded for a different
  // pinned reason (exactly at the budget, terminal, no history,
  // unmapped state). The disposition is a notify-only action
  // through actOnStaleTasks: it records the notified ids and
  // dispatches nothing, so the patrol changes no task. A
  // fail-fast check then pins the exact configuration error for
  // an unknown state name in the map.
  const patrolNow = new Date(DEMO_PATROL_NOW);
  const patrolNowMs = Date.parse(DEMO_PATROL_NOW);
  const patrolStaleTask = new TaskLifecycle(DEMO_PATROL_STALE_TASK_ID);
  patrolStaleTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: DEMO_PATROL_STALE_PUBLISH_AT,
  });
  const patrolExactTask = new TaskLifecycle(DEMO_PATROL_EXACT_TASK_ID);
  patrolExactTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: DEMO_PATROL_EXACT_PUBLISH_AT,
  });
  const patrolTerminalTask = new TaskLifecycle(DEMO_PATROL_TERMINAL_TASK_ID);
  patrolTerminalTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: DEMO_PATROL_TERMINAL_PUBLISH_AT,
  });
  patrolTerminalTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: DEMO_PATROL_TERMINAL_ACCEPT_AT,
  });
  patrolTerminalTask.dispatch("START_CAPTURE", {
    actor: "contributor",
    at: DEMO_PATROL_TERMINAL_CAPTURE_AT,
  });
  patrolTerminalTask.dispatch("SUBMIT", {
    actor: "contributor",
    at: DEMO_PATROL_TERMINAL_SUBMIT_AT,
  });
  patrolTerminalTask.dispatch("BEGIN_REVIEW", {
    actor: "reviewer",
    at: DEMO_PATROL_TERMINAL_REVIEW_AT,
  });
  patrolTerminalTask.dispatch("APPROVE", {
    actor: "reviewer",
    at: DEMO_PATROL_TERMINAL_APPROVE_AT,
  });
  patrolTerminalTask.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    at: DEMO_PATROL_TERMINAL_REQUEST_AT,
  });
  patrolTerminalTask.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    at: DEMO_PATROL_TERMINAL_COMPLETE_AT,
  });
  const patrolNoHistoryTask = new TaskLifecycle(DEMO_PATROL_NO_HISTORY_TASK_ID);
  const patrolUnmappedTask = new TaskLifecycle(DEMO_PATROL_UNMAPPED_TASK_ID);
  patrolUnmappedTask.dispatch("PUBLISH", {
    actor: "researcher",
    at: DEMO_PATROL_UNMAPPED_PUBLISH_AT,
  });
  patrolUnmappedTask.dispatch("ACCEPT", {
    actor: "contributor",
    at: DEMO_PATROL_UNMAPPED_ACCEPT_AT,
  });
  patrolUnmappedTask.dispatch("START_CAPTURE", {
    actor: "contributor",
    at: DEMO_PATROL_UNMAPPED_CAPTURE_AT,
  });
  patrolUnmappedTask.dispatch("SUBMIT", {
    actor: "contributor",
    at: DEMO_PATROL_UNMAPPED_SUBMIT_AT,
  });
  patrolUnmappedTask.dispatch("BEGIN_REVIEW", {
    actor: "reviewer",
    at: DEMO_PATROL_UNMAPPED_REVIEW_AT,
  });
  const patrolTasks = [
    patrolStaleTask,
    patrolExactTask,
    patrolTerminalTask,
    patrolNoHistoryTask,
    patrolUnmappedTask,
  ];
  const patrolMaxAgeByState = {
    DRAFT: DEMO_PATROL_MAX_AGE_MS,
    OPEN: DEMO_PATROL_MAX_AGE_MS,
    PAID: DEMO_PATROL_MAX_AGE_MS,
  };
  const patrolStaleSelected = staleTasks(
    patrolTasks,
    patrolMaxAgeByState,
    patrolNow,
  );
  const patrolStaleNotifiedIds: string[] = [];
  const patrolStaleActionResults = actOnStaleTasks(
    patrolTasks,
    (t) => {
      patrolStaleNotifiedIds.push(t.id);
    },
    patrolMaxAgeByState,
    patrolNow,
  );
  let patrolStaleConfigError = "";
  try {
    staleTasks(patrolTasks, { BOGUS: 1000 } as never, patrolNow);
  } catch (err) {
    patrolStaleConfigError = err instanceof Error ? err.message : String(err);
  }
  if (
    patrolStaleSelected.length !== 1 ||
    patrolStaleSelected[0] !== patrolStaleTask ||
    patrolStaleActionResults.length !== 1 ||
    patrolStaleActionResults[0].task !== patrolStaleTask ||
    patrolStaleActionResults[0].acted !== true ||
    patrolStaleActionResults[0].error !== undefined ||
    patrolStaleNotifiedIds.length !== 1 ||
    patrolStaleNotifiedIds[0] !== DEMO_PATROL_STALE_TASK_ID ||
    patrolStaleConfigError !== DEMO_PATROL_STALE_CONFIG_ERROR ||
    patrolTasks.map((t) => t.state).join(",") !==
      "OPEN,OPEN,PAID,DRAFT,IN_REVIEW" ||
    patrolTasks.map((t) => t.history.length).join(",") !== "1,1,8,0,5"
  ) {
    throw new Error(
      "demo fixture broken: stale patrol does not have the pinned shape (only the stale OPEN task selected and notified; exactly-at-budget, terminal, no-history and unmapped tasks excluded; unknown-state config error pinned)",
    );
  }
  const patrolSelectedIds = new Set(patrolStaleSelected.map((t) => t.id));
  lines.push(
    "",
    "Stale patrol (staleTasks / maxAgeByState screening, notify-only action):",
    `  fixed now: ${DEMO_PATROL_NOW} — patrol budgets: DRAFT 7 days, OPEN 7 days, PAID 7 days (IN_REVIEW has no budget; dwell from the last history entry, strictly past the budget)`,
  );
  for (const patrolTask of patrolTasks) {
    const lastEntry = patrolTask.history[patrolTask.history.length - 1];
    const dwellText =
      lastEntry === undefined
        ? "no history (no measurable dwell)"
        : `entered ${lastEntry.at}, dwell ${(patrolNowMs - Date.parse(lastEntry.at)) / DEMO_PATROL_DAY_MS} days`;
    lines.push(
      `  ${patrolTask.id}: state ${patrolTask.state}, ${dwellText} — stale: ${patrolSelectedIds.has(patrolTask.id)}`,
    );
  }
  lines.push(
    `  staleTasks selection: [${patrolStaleSelected.map((t) => t.id).join(", ")}] — exactly-at-budget (${DEMO_PATROL_EXACT_TASK_ID}), terminal (${DEMO_PATROL_TERMINAL_TASK_ID}), no-history (${DEMO_PATROL_NO_HISTORY_TASK_ID}) and unmapped-state (${DEMO_PATROL_UNMAPPED_TASK_ID}) tasks are not selected`,
    `  actOnStaleTasks (action: notify the assignee, dispatch nothing): ${patrolStaleActionResults.length} attempted`,
  );
  for (const result of patrolStaleActionResults) {
    lines.push(
      result.acted
        ? `  ${result.task.id}: acted true — notified, task unchanged at ${result.task.state}`
        : `  ${result.task.id}: acted false — error: ${result.error}`,
    );
  }
  lines.push(
    `  invalid patrol configuration fails fast: staleTasks with an unknown state name throws ${patrolStaleConfigError} before any task is read`,
  );

  return { task, historyChainVerified, tamperedChainVerified, tamperedPayoutAmount, overdueTask, overdueFound, disputeTask, webhook, webhookVerified, dedupeFirst, dedupeRedelivery, dedupeAfterTtl, batchResults, batchVerified, fanoutResult, fanoutCalls, singleDeliveryEndpoint, singleDeliveryResult, singleDeliveryCalls, singleDeliveryBodyVerifies, onErrorTask, onErrorReports, onErrorProbeTask, dedupeSnapshotSource, dedupeSnapshotFirst, dedupeSnapshotDuplicate, dedupeSnapshot, dedupeSnapshotRestored, dedupeSnapshotStatsAfterRestore, dedupeSnapshotRestoredSeen, dedupeSnapshotRestoredUnseen, dedupeSnapshotTamperedError, dedupeStatsDedupe, dedupeStatsOutcomes, dedupeStatsSnapshots, dedupeStatsAfterMutation, dedupeClearDedupe, dedupeClearEventId, dedupeClearOutcomes, dedupeClearStatsBefore, dedupeClearStatsAfterClear, dedupeClearStatsAfterReRecord, retryAfterDeliveryEndpoint, retryAfterDeliveryResult, retryAfterDeliveryCalls, retryAfterDeliverySleeps, retryAfterDeliveryBodyVerifies, rotationNewWebhook, rotationOldWebhook, rotationNewUnderRotation, rotationOldUnderRotation, rotationNewUnderOldOnly, rotationUnderUnrelatedList, rotationBothError, abortDeliveryEndpoint, abortPreResult, abortPreFetchCalls, abortWaitResult, abortWaitFetchCalls, abortWaitSleeps, freshnessWebhook, freshnessMaxAgeMs, freshnessMaxFutureSkewMs, freshnessWithinWindow, freshnessAtBoundary, freshnessBeyondWindow, freshnessBeyondWindowSignatureOnly, freshnessFutureBeyondSkew, requirePayoutRefTask, requirePayoutRefError, requirePayoutRefStateAfterReject, requirePayoutRefHistoryLengthAfterReject, requirePayoutRefPayoutRef, requirePayoutRefDefaultTask, idempotencyTask, idempotencyPublishKey, idempotencyDuplicateReturn, idempotencyHistoryLengthAfterDuplicate, idempotencyNotificationEvents, idempotencyCrossEventReturn, idempotencyStaleReturn, idempotencyHistoryLengthAfterRetries, idempotencyRetryTask, idempotencyFailedError, idempotencyRetryKey, auditSecretTask, auditSecretVerified, auditSecretWrongVerified, auditSecretTamperedVerified, auditSecretUnkeyedVerified, rolePolicyTask, rolePolicy: DEMO_ROLE_POLICY, rolePolicyPublishUnauthorizedError, rolePolicyPublishMissingActorError, rolePolicyStateAfterPublishRejects, rolePolicyHistoryLengthAfterPublishRejects, rolePolicyArbitrateUnauthorizedError, rolePolicyArbitrateMissingActorError, rolePolicyStateAfterArbitrateRejects, rolePolicyHistoryLengthAfterArbitrateRejects, rolePolicyDefaultTask, seededIdempotencyTask, seededIdempotencyKeys: DEMO_SEEDED_IDEMPOTENCY_KEYS, seededIdempotencySnapshotKeysAfterSeed, seededIdempotencyNoopReturn, seededIdempotencyStateAfterNoop, seededIdempotencyHistoryLengthAfterNoop, seededIdempotencyNotificationCountAfterNoop, seededIdempotencyNotificationEvents, seededIdempotencySnapshotKeysAfterFreshKeys, seededIdempotencyEmptySeedError, seededIdempotencyDefaultTask, seededIdempotencyDefaultSnapshotKeys, timeoutDeliveryEndpoint, timeoutDeliveryTimeoutMs, timeoutDeliveryResult, timeoutDeliveryFetchCalls, timeoutDeliveryInvalidError, timeoutDeliveryInvalidFetchCalls, timeoutDeliveryLooseResult, timeoutDeliveryLooseFetchCalls, fanoutTimeoutCallTimeoutMs, fanoutTimeoutOverrideMs, fanoutTimeoutResult, fanoutTimeoutHangFetchCalls, fanoutTimeoutFastFetchCalls, fanoutTimeoutInvalidResult, fanoutTimeoutInvalidFetchCalls, fanoutTimeoutPlainResult, expectedSeqTask, expectedSeqGuardedReturn, expectedSeqConflictTask, expectedSeqConflictError, expectedSeqConflictStateAfter, expectedSeqConflictHistoryLengthAfter, expectedSeqEmptyTask, expectedSeqEmptyReturn, expectedSeqIllegalTask, expectedSeqNegativeError, expectedSeqFractionError, expectedSeqUnguardedTask, expectedSeqUnguardedReturn, patrolTasks, patrolStaleSelected, patrolStaleActionResults, patrolStaleNotifiedIds, patrolStaleConfigError, constructorGuardChecks, constructorGuardTask, historyImmutabilityChecks, retryAfterParsed, unreconciledTask, mismatchedTask, unreconciledFound, mismatchedFound, totalPaid, subscriptionTask, subscriptionNotifications, subscriptionMatchesHistory, subscriptionCountAfterUnsubscribe, listenerCountTask, listenerCountTimeline, listenerCountKept, listenerCountDropped, staleDwellTasks, staleFound, staleExpiredFound, approachingTasks, approachingFound, approachingOverdueFound, staleActionTasks, staleActionResults, expireExecutionTasks, expireExecutionFound, expireExecutionResults, ndjsonText, replayedTask, replayDerivedState, allowedEventsByState, mainTaskAllowedEvents, parsedHistoryEntries, parsedHistoryMatchesMainPrefix, parsedHistoryInvalidRejected, parsedHistoryInvalidError, transitionTableJsonText, transitionTableEdges, stateDiagramText, stateDiagramEdgeCount, readmeDiagramInSync: readmeDiagramInSyncValue, snapshotJsonText, snapshotBytes, restoredTask, snapshotResubmitUsed, payoutMismatchDetail, payoutMismatchSettled, snapshotVersion, snapshotVersionFutureError, snapshotVersionRestoredState, noteLimitTask, noteLengthLimit, noteLimitBoundaryLength, noteLimitOverLength, noteLimitError, noteLimitStateAfter, noteLimitHistoryLengthAfter, overdueStandaloneTask, overdueStandaloneNoDeadlineTask, overdueStandaloneTerminalTask, overdueStandaloneDeadline, overdueStandaloneVerdicts, terminalByState, terminalStates, noOutEdgeStates, slaClearTask, slaClearDeadline, slaClearOtherDeadlines, slaClearOverdueBefore, slaClearOverdueAfterStateClear, slaClearAcceptedAfterStateClear, slaClearOthersAfterStateClear, slaClearAfterAllClear, lines };
}

async function main(): Promise<void> {
  console.log((await runDemo()).lines.join("\n"));
}

// Run only when executed directly (`node dist/src/demo.js`), not when
// imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
