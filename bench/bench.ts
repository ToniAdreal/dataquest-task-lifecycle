/**
 * Local micro-benchmark for the dataquest-task-lifecycle state machine.
 *
 * Measures real, locally-observed throughput for the fifteen hot-path
 * groups a watchdog / reconciliation deployment actually hammers:
 *
 *   1. dispatch — one full DRAFT -> PAID lifecycle (8 dispatches, each
 *      appending a hash-chained audit entry) on a fresh task;
 *   2. event-sourced replay / rehydration — `replay(history)` deriving
 *      the final state, and `TaskLifecycle.fromHistory(...)` rebuilding
 *      the task, both over a fixed 8-entry chained history;
 *   3. `verifyHistoryChain(history)` — full SHA-256 hash-chain
 *      re-verification of that same history;
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
  deliverPayoutWebhookToMany,
  expiredTasks,
  expireOverdueTasks,
  historyFromNdjson,
  historyToNdjson,
  mismatchedPayouts,
  parseHistory,
  parsePayoutRetryAfter,
  payoutMismatch,
  PayoutEventDedupe,
  replay,
  staleTasks,
  TaskLifecycle,
  totalPaidOut,
  unreconciledPayouts,
  verifyHistoryChain,
  verifyPayoutWebhook,
  type PayoutMismatch,
  type PayoutWebhookEndpoint,
  type PayoutWebhookFetchImpl,
  type TaskEvent,
  type TaskHistoryEntry,
  type TaskState,
} from "../src/index.js";

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
    const task = TaskLifecycle.fromHistory("BENCH-001", historyFixture);
    if (task.state !== "PAID") {
      throw new Error("benchmark self-check failed: fromHistory");
    }
  }, ITERATIONS);
}

function benchVerifyHistoryChain(): number {
  return measure(() => {
    if (!verifyHistoryChain(historyFixture)) {
      throw new Error("benchmark self-check failed: verifyHistoryChain");
    }
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
  "Fixture: one task, full DRAFT -> PAID lifecycle (8 hash-chained audit entries); payout webhook HMAC-SHA256 with fixed secret/timestamp/eventId; NDJSON text exported from the same 8-entry history; reconciliation screening and totalPaidOut summary over a fixed batch of 12 PAID tasks (4 exact+ref, 4 mismatched+ref, 2 exact without ref, 2 mismatched without ref); payout webhook fan-out to 4 endpoints through an injected fake fetch (immediate 200, no network); payout event dedupe duplicate hits cycling over 1,000 pre-recorded eventIds under a fixed injected clock; payout event dedupe restore from a 1,000-entry JSON-round-tripped snapshot under the same fixed clock (all entries live at load, default TTL and capacity, observability counters restarting at zero); batch payout webhook building over a fixed batch of 12 PAID tasks (settled as quoted, each with a payoutRef) under one shared timestamp with deterministic per-task eventIds from an injected factory; watchdog screening (expiredTasks / staleTasks) over a fixed batch of 12 mixed-state tasks (4 hand-counted expired, 4 hand-counted stale) under one injected fixed now with per-state dwell budgets; watchdog execution (expireOverdueTasks / actOnStaleTasks with the default ABANDON action) over the same batch, rebuilt fresh on every iteration because the executors mutate their inputs (3 of 4 expire, 1 of 4 stale actions succeed, the rest fail in isolation); payout Retry-After parsing (parsePayoutRetryAfter) over a fixed 11-value corpus (delay-seconds, future/past HTTP-dates, signed and garbage values, and absent values) under an injected fixed nowMs; payout mismatch judgement (payoutMismatch) over a fixed set of 5 tasks (settled exactly as quoted, settled for a different amount, missing quote, missing settled amount, and one non-PAID task) with fixed dispatch timestamps; allowed-events query (allowedEvents) over all 13 states with hand-written per-state expectations (terminal states PAID / ABANDONED / EXPIRED returning an empty list); standalone history parsing (parseHistory) over the same fixed 8-entry chained history (full validation — unknown-field fail-closed, gapless seq, from/to chain and hash-chain re-verification — without per-line JSON parsing, with a detached tampered copy rejected outside the timed loop)",
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
  { path: "PayoutEventDedupe checkAndRecord (hit, 1,000 recorded ids)", ops: benchPayoutEventDedupe() },
  { path: "PayoutEventDedupe.restore (1,000-entry snapshot)", ops: benchPayoutEventDedupeRestore() },
  { path: "buildPayoutWebhooks (batch of 12 PAID tasks)", ops: benchBuildPayoutWebhooks() },
  { path: "expiredTasks (12 mixed-state tasks)", ops: benchExpiredTasks() },
  { path: "staleTasks (12 mixed-state tasks)", ops: benchStaleTasks() },
  { path: "expireOverdueTasks (12 mixed-state tasks, fresh fixture)", ops: benchExpireOverdueTasks() },
  { path: "actOnStaleTasks (12 mixed-state tasks, fresh fixture)", ops: benchActOnStaleTasks() },
  { path: "parsePayoutRetryAfter (11-value corpus)", ops: benchParsePayoutRetryAfter() },
  { path: "payoutMismatch (5-task set)", ops: benchPayoutMismatch() },
  { path: "allowedEvents (13 states)", ops: benchAllowedEvents() },
  { path: "parseHistory (8-entry history)", ops: benchParseHistory() },
];

console.log("path                                              throughput");
console.log("---------------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.path.padEnd(50)} ${fmt(r.ops)}`);
}
console.log("");
console.log("Numbers are machine-local measurements, not guarantees.");
