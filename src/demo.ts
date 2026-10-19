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
 * seen with a collecting listener so far.
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
 * task, plus the exact `lines` the CLI prints — so tests assert on structured values
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
  historyFromNdjson,
  historyToNdjson,
  isOverdue,
  isTerminal,
  MAX_NOTE_LENGTH,
  mismatchedPayouts,
  parseHistory,
  parsePayoutRetryAfter,
  payoutMismatch,
  SNAPSHOT_VERSION,
  staleTasks,
  stateDiagram,
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
  type PayoutMismatch,
  type PayoutWebhook,
  type PayoutWebhookFetchImpl,
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
  staleDwellTasks: TaskLifecycle[];
  staleFound: TaskLifecycle[];
  staleExpiredFound: TaskLifecycle[];
  staleActionTasks: TaskLifecycle[];
  staleActionResults: StaleActionResult[];
  expireExecutionTasks: TaskLifecycle[];
  expireExecutionFound: TaskLifecycle[];
  expireExecutionResults: ExpireOverdueResult[];
  ndjsonText: string;
  replayedTask: TaskLifecycle;
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
 * to afterwards, and the exact lines
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
  // callback, so its EXPIRE dispatches carry the library defaults
  // (no actor, a wall-clock audit timestamp) — this segment
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

  return { task, historyChainVerified, tamperedChainVerified, tamperedPayoutAmount, overdueTask, overdueFound, disputeTask, webhook, webhookVerified, dedupeFirst, dedupeRedelivery, dedupeAfterTtl, batchResults, batchVerified, fanoutResult, fanoutCalls, singleDeliveryEndpoint, singleDeliveryResult, singleDeliveryCalls, singleDeliveryBodyVerifies, onErrorTask, onErrorReports, onErrorProbeTask, retryAfterParsed, unreconciledTask, mismatchedTask, unreconciledFound, mismatchedFound, totalPaid, subscriptionTask, subscriptionNotifications, subscriptionMatchesHistory, subscriptionCountAfterUnsubscribe, staleDwellTasks, staleFound, staleExpiredFound, staleActionTasks, staleActionResults, expireExecutionTasks, expireExecutionFound, expireExecutionResults, ndjsonText, replayedTask, allowedEventsByState, mainTaskAllowedEvents, parsedHistoryEntries, parsedHistoryMatchesMainPrefix, parsedHistoryInvalidRejected, parsedHistoryInvalidError, transitionTableJsonText, transitionTableEdges, stateDiagramText, stateDiagramEdgeCount, readmeDiagramInSync: readmeDiagramInSyncValue, snapshotJsonText, snapshotBytes, restoredTask, snapshotResubmitUsed, payoutMismatchDetail, payoutMismatchSettled, snapshotVersion, snapshotVersionFutureError, snapshotVersionRestoredState, noteLimitTask, noteLengthLimit, noteLimitBoundaryLength, noteLimitOverLength, noteLimitError, noteLimitStateAfter, noteLimitHistoryLengthAfter, overdueStandaloneTask, overdueStandaloneNoDeadlineTask, overdueStandaloneTerminalTask, overdueStandaloneDeadline, overdueStandaloneVerdicts, terminalByState, terminalStates, noOutEdgeStates, slaClearTask, slaClearDeadline, slaClearOtherDeadlines, slaClearOverdueBefore, slaClearOverdueAfterStateClear, slaClearAcceptedAfterStateClear, slaClearOthersAfterStateClear, slaClearAfterAllClear, lines };
}

async function main(): Promise<void> {
  console.log((await runDemo()).lines.join("\n"));
}

// Run only when executed directly (`node dist/src/demo.js`), not when
// imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
