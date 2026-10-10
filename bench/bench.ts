/**
 * Local micro-benchmark for the dataquest-task-lifecycle state machine.
 *
 * Measures real, locally-observed throughput for the four hot paths a
 * watchdog / reconciliation deployment actually hammers:
 *
 *   1. dispatch — one full DRAFT -> PAID lifecycle (8 dispatches, each
 *      appending a hash-chained audit entry) on a fresh task;
 *   2. event-sourced replay / rehydration — `replay(history)` deriving
 *      the final state, and `TaskLifecycle.fromHistory(...)` rebuilding
 *      the task, both over a fixed 8-entry chained history;
 *   3. `verifyHistoryChain(history)` — full SHA-256 hash-chain
 *      re-verification of that same history;
 *   4. payout webhook build / verify — `buildPayoutWebhook` (HMAC-SHA256
 *      signing) and `verifyPayoutWebhook` over the signed body.
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
  replay,
  TaskLifecycle,
  verifyHistoryChain,
  verifyPayoutWebhook,
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

function measure(fn: () => void, iterations: number): number {
  for (let i = 0; i < WARMUP; i++) fn(); // warmup: JIT, module caches
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
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

console.log("dataquest-task-lifecycle benchmark");
console.log(`Node: ${process.version} on ${process.platform}/${process.arch}`);
console.log(`CPU: ${cpus()[0]?.model ?? "unknown"}`);
console.log(
  "Fixture: one task, full DRAFT -> PAID lifecycle (8 hash-chained audit entries); payout webhook HMAC-SHA256 with fixed secret/timestamp/eventId",
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
];

console.log("path                                      throughput");
console.log("-------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.path.padEnd(42)} ${fmt(r.ops)}`);
}
console.log("");
console.log("Numbers are machine-local measurements, not guarantees.");
