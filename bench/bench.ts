/**
 * Local micro-benchmark for the dataquest-task-lifecycle state machine.
 *
 * Measures real, locally-observed throughput for the nine hot-path
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
 *   6. payout reconciliation screening — `mismatchedPayouts(tasks)` and
 *      `unreconciledPayouts(tasks)` over a fixed batch of 12 PAID tasks
 *      (each with the full 8-entry history), scanning every task's
 *      history for its `ACCEPT` quote / `PAYOUT_COMPLETE` settlement
 *      evidence. This is the batch pass finance reconciliation runs
 *      over a whole task set, as opposed to the per-task webhook paths
 *      above;
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
 *      loop). This is the receiver-side counterpart of the sender
 *      paths above: every delivered payout notification pays this
 *      check before it may be processed;
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
  buildPayoutWebhook,
  buildPayoutWebhooks,
  deliverPayoutWebhookToMany,
  historyFromNdjson,
  historyToNdjson,
  mismatchedPayouts,
  PayoutEventDedupe,
  replay,
  TaskLifecycle,
  unreconciledPayouts,
  verifyHistoryChain,
  verifyPayoutWebhook,
  type PayoutWebhookEndpoint,
  type PayoutWebhookFetchImpl,
  type TaskEvent,
  type TaskHistoryEntry,
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

function benchBuildPayoutWebhooks(): number {
  return measure(() => {
    runBatchBuild();
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
  "Fixture: one task, full DRAFT -> PAID lifecycle (8 hash-chained audit entries); payout webhook HMAC-SHA256 with fixed secret/timestamp/eventId; NDJSON text exported from the same 8-entry history; reconciliation screening over a fixed batch of 12 PAID tasks (4 exact+ref, 4 mismatched+ref, 2 exact without ref, 2 mismatched without ref); payout webhook fan-out to 4 endpoints through an injected fake fetch (immediate 200, no network); payout event dedupe duplicate hits cycling over 1,000 pre-recorded eventIds under a fixed injected clock; batch payout webhook building over a fixed batch of 12 PAID tasks (settled as quoted, each with a payoutRef) under one shared timestamp with deterministic per-task eventIds from an injected factory",
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
  { path: "deliverPayoutWebhookToMany (4 endpoints)", ops: await benchDeliverPayoutWebhookToMany() },
  { path: "PayoutEventDedupe checkAndRecord (hit, 1,000 recorded ids)", ops: benchPayoutEventDedupe() },
  { path: "buildPayoutWebhooks (batch of 12 PAID tasks)", ops: benchBuildPayoutWebhooks() },
];

console.log("path                                              throughput");
console.log("---------------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.path.padEnd(50)} ${fmt(r.ops)}`);
}
console.log("");
console.log("Numbers are machine-local measurements, not guarantees.");
