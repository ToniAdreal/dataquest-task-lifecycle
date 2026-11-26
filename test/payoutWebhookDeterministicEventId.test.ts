import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  MAX_EVENT_ID_LENGTH,
  MAX_TASK_ID_LENGTH,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  verifyPayoutWebhook,
  PayoutEventDedupe,
} from "../src/index.js";

/**
 * Deterministic default payout webhook `eventId` (backlog #1426):
 * rebuilding the same settlement must produce the same deduplication
 * key — `payout-<taskId>-<completionSeq>-<hash-prefix>` from the
 * PAYOUT_COMPLETE entry — instead of a fresh UUID per build, which a
 * receiver deduplicating on `eventId` could not tell apart from a
 * second, independent payout.
 *
 * Rules under test:
 *  - the same PAID task built twice (same fixed `now`) yields the same
 *    `eventId` and the same signature; with a different `now` the
 *    `eventId` still matches while `at` and the signature change
 *  - two different PAID tasks, and the same task id settled by a
 *    different completion entry (different `seq`/`hash`), get
 *    different `eventId`s
 *  - an explicit `eventId` still overrides the deterministic default
 *  - feeding two rebuilds to `PayoutEventDedupe` reports the second
 *    as a duplicate (`true`)
 *  - the batch build without a factory reissues the same `eventId`s
 *    across rebuilds, and a factory returning a conflicting id is
 *    still rejected per task
 *  - a 256-character task id never pushes the derived id past
 *    `MAX_EVENT_ID_LENGTH` (the digest form, never truncation) and
 *    stays deterministic
 *  - restoring a task from a hash-stripped snapshot re-chains the
 *    history deterministically, so the rebuild carries the same
 *    `eventId` as the original
 */

/** Drive a task from DRAFT all the way to PAID (8 entries). */
function toPaid(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(t.state, "PAID");
  return t;
}

/** Same id as `toPaid`, but settled after a reject/resubmit loop (10 entries). */
function toPaidWithResubmit(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("REJECT", { actor: "reviewer" });
  t.dispatch("RESUBMIT", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(t.state, "PAID");
  return t;
}

const NOW = new Date("2026-11-26T10:00:00.000Z");
const LATER = new Date("2026-11-26T11:00:00.000Z");
const SECRET = "s3cr3t";

test("same settlement rebuilt with the same now reuses its eventId and signature", () => {
  const task = toPaid("task-det-1");
  const a = buildPayoutWebhook(task, SECRET, { now: NOW });
  const b = buildPayoutWebhook(task, SECRET, { now: NOW });
  assert.equal(a.payload.eventId, b.payload.eventId);
  assert.match(a.payload.eventId, /^payout-task-det-1-8-[0-9a-f]{12}$/);
  assert.equal(a.signature, b.signature);
  assert.equal(
    verifyPayoutWebhook(JSON.stringify(a.payload), a.signature, SECRET),
    true,
  );
});

test("same settlement rebuilt at a different now keeps its eventId, only at and signature change", () => {
  const task = toPaid("task-det-2");
  const a = buildPayoutWebhook(task, SECRET, { now: NOW });
  const b = buildPayoutWebhook(task, SECRET, { now: LATER });
  assert.equal(a.payload.eventId, b.payload.eventId);
  assert.notEqual(a.payload.at, b.payload.at);
  assert.notEqual(a.signature, b.signature);
});

test("two different PAID tasks get different eventIds", () => {
  const a = buildPayoutWebhook(toPaid("task-det-a"), SECRET, { now: NOW });
  const b = buildPayoutWebhook(toPaid("task-det-b"), SECRET, { now: NOW });
  assert.notEqual(a.payload.eventId, b.payload.eventId);
});

test("same taskId settled by a different completion entry gets a different eventId", () => {
  const a = buildPayoutWebhook(toPaid("task-det-same"), SECRET, { now: NOW });
  const b = buildPayoutWebhook(toPaidWithResubmit("task-det-same"), SECRET, {
    now: NOW,
  });
  assert.match(a.payload.eventId, /^payout-task-det-same-8-[0-9a-f]{12}$/);
  assert.match(b.payload.eventId, /^payout-task-det-same-12-[0-9a-f]{12}$/);
  assert.notEqual(a.payload.eventId, b.payload.eventId);
});

test("an explicit eventId still overrides the deterministic default", () => {
  const task = toPaid("task-det-3");
  const { payload } = buildPayoutWebhook(task, SECRET, {
    eventId: "evt-override",
    now: NOW,
  });
  assert.equal(payload.eventId, "evt-override");
});

test("feeding two rebuilds to PayoutEventDedupe reports the second as a duplicate", () => {
  const task = toPaid("task-det-4");
  const first = buildPayoutWebhook(task, SECRET, { now: NOW });
  const second = buildPayoutWebhook(task, SECRET, { now: LATER });
  const dedupe = new PayoutEventDedupe();
  assert.equal(dedupe.checkAndRecord(first.payload.eventId), false);
  assert.equal(dedupe.checkAndRecord(second.payload.eventId), true);
});

test("batch rebuilds without a factory reissue the same eventIds", () => {
  const tasks = [toPaid("task-det-batch-1"), toPaid("task-det-batch-2")];
  const first = buildPayoutWebhooks(tasks, SECRET, { now: NOW });
  const second = buildPayoutWebhooks(tasks, SECRET, { now: NOW });
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  for (let i = 0; i < first.length; i++) {
    assert.equal(first[i].error, undefined);
    assert.equal(second[i].error, undefined);
    assert.equal(
      first[i].webhook?.payload.eventId,
      second[i].webhook?.payload.eventId,
    );
  }
  assert.notEqual(
    first[0].webhook?.payload.eventId,
    first[1].webhook?.payload.eventId,
  );
});

test("batch still rejects a factory returning a conflicting eventId", () => {
  const tasks = [toPaid("task-det-batch-3"), toPaid("task-det-batch-4")];
  const results = buildPayoutWebhooks(tasks, SECRET, {
    now: NOW,
    eventIdFactory: () => "evt-batch-fixed",
  });
  assert.equal(results[0].error, undefined);
  assert.equal(
    results[1].error,
    'duplicate eventId "evt-batch-fixed" in batch: eventIds must be unique within a batch',
  );
});

test("a 256-character task id stays within the eventId cap and stays deterministic", () => {
  const longId = "t".repeat(MAX_TASK_ID_LENGTH);
  const task = toPaid(longId);
  const a = buildPayoutWebhook(task, SECRET, { now: NOW });
  const b = buildPayoutWebhook(task, SECRET, { now: LATER });
  assert.equal(a.payload.eventId, b.payload.eventId);
  assert.ok(a.payload.eventId.length <= MAX_EVENT_ID_LENGTH);
  assert.match(a.payload.eventId, /^payout-[0-9a-f]{32}$/);
  const other = buildPayoutWebhook(toPaid("u".repeat(MAX_TASK_ID_LENGTH)), SECRET, {
    now: NOW,
  });
  assert.notEqual(a.payload.eventId, other.payload.eventId);
});

test("restoring from a hash-stripped snapshot rebuilds the same eventId", () => {
  const task = toPaid("task-det-5");
  const original = buildPayoutWebhook(task, SECRET, { now: NOW });
  const snapshot = JSON.parse(JSON.stringify(task.toJSON())) as {
    history: Record<string, unknown>[];
  };
  for (const entry of snapshot.history) {
    delete entry.hash;
    delete entry.prevHash;
  }
  const restored = TaskLifecycle.fromJSON(snapshot);
  const rebuilt = buildPayoutWebhook(restored, SECRET, { now: NOW });
  assert.equal(rebuilt.payload.eventId, original.payload.eventId);
  assert.equal(rebuilt.signature, original.signature);
});
