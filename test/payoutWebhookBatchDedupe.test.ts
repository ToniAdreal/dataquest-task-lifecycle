import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhooks,
  verifyPayoutWebhook,
  PayoutEventDedupe,
} from "../src/index.js";

/**
 * Batch payout webhooks at the receiver: `buildPayoutWebhooks` x
 * `PayoutEventDedupe` (backlog #816).
 *
 * `payoutWebhookBatch.test.ts` never mentions dedupe (grep count 0), so
 * a batch's receiver-side behaviour was unbacked: a batch rebuilds the
 * same payout events under the same `eventId`s, and the receiver must
 * treat that rebuild as a redelivery, not as fresh payouts, while still
 * accepting a genuinely new `eventId` for one task without disturbing
 * the others. The receiver order is verify-then-record throughout
 * (see #726): a webhook is fed to `checkAndRecord` only after
 * `verifyPayoutWebhook` returns true, so a forged delivery can never
 * poison the store. The verify-before-record poisoning case itself is
 * pinned by #726 and is not re-pinned here.
 *
 * Rules under test:
 *  - a 3-task batch built with fixed `eventId`s verifies per task and
 *    is first-seen for every task at a fresh receiver
 *  - rebuilding the same batch with the same `eventId`s and redelivering
 *    it reports every task as a duplicate, with the store size unchanged
 *  - rebuilding with exactly one fresh `eventId` reports only that task
 *    as first-seen; the other two stay duplicates, and the store grows
 *    by exactly the one new id
 */

/** Drive a task from DRAFT all the way to PAID. */
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

const NOW = new Date("2026-10-12T08:00:00.000Z");
const BATCH_SECRET = "batch-dedupe-secret";
const EVENT_IDS = ["evt-batch-1", "evt-batch-2", "evt-batch-3"];

function tasks(): TaskLifecycle[] {
  return [toPaid("task-batch-a"), toPaid("task-batch-b"), toPaid("task-batch-c")];
}

/** Build a 3-task batch with the given eventIds, in input order. */
function buildBatch(eventIds: string[]) {
  let n = 0;
  const results = buildPayoutWebhooks(tasks(), BATCH_SECRET, {
    now: NOW,
    eventIdFactory: () => eventIds[n++],
  });
  assert.equal(n, 3, "factory called once per task");
  assert.deepEqual(
    results.map((r) => r.webhook?.payload.eventId),
    eventIds,
  );
  assert.deepEqual(
    results.map((r) => r.taskId),
    ["task-batch-a", "task-batch-b", "task-batch-c"],
  );
  return results;
}

/**
 * Receive a built batch the documented way: verify the signed payload
 * first, then record its eventId. Returns one boolean per task, in
 * input order: false = first sighting (process it), true = duplicate
 * (acknowledge it, do not pay out twice).
 */
function receiveBatch(
  results: ReturnType<typeof buildPayoutWebhooks>,
  dedupe: PayoutEventDedupe,
): boolean[] {
  return results.map((r) => {
    assert.ok(r.webhook, `task ${r.taskId} must carry a webhook`);
    assert.equal(
      verifyPayoutWebhook(
        JSON.stringify(r.webhook.payload),
        r.webhook.signature,
        BATCH_SECRET,
      ),
      true,
      `task ${r.taskId} must verify under the batch secret`,
    );
    return dedupe.checkAndRecord(r.webhook.payload.eventId);
  });
}

test("three-task batch: every webhook verifies and is first-seen", () => {
  const dedupe = new PayoutEventDedupe();
  const outcomes = receiveBatch(buildBatch(EVENT_IDS), dedupe);
  assert.deepEqual(outcomes, [false, false, false]);
  assert.equal(dedupe.size, 3);
  assert.deepEqual(dedupe.stats(), {
    size: 3,
    hits: 0,
    misses: 3,
    evictions: 0,
  });
});

test("same eventIds rebuilt and redelivered: every task is a duplicate", () => {
  const dedupe = new PayoutEventDedupe();
  assert.deepEqual(receiveBatch(buildBatch(EVENT_IDS), dedupe), [
    false,
    false,
    false,
  ]);
  // The rebuild is byte-identical (same tasks, same `at`, same ids),
  // exactly what a sender retry re-POSTs.
  const rebuilt = buildBatch(EVENT_IDS);
  assert.deepEqual(receiveBatch(rebuilt, dedupe), [true, true, true]);
  assert.equal(dedupe.size, 3, "redelivery adds no new entries");
  assert.deepEqual(dedupe.stats(), {
    size: 3,
    hits: 3,
    misses: 3,
    evictions: 0,
  });
});

test("one fresh eventId: only that task is first-seen, the rest stay duplicates", () => {
  const dedupe = new PayoutEventDedupe();
  assert.deepEqual(receiveBatch(buildBatch(EVENT_IDS), dedupe), [
    false,
    false,
    false,
  ]);
  const rotated = ["evt-batch-1", "evt-batch-2-new", "evt-batch-3"];
  const outcomes = receiveBatch(buildBatch(rotated), dedupe);
  assert.deepEqual(outcomes, [true, false, true]);
  assert.equal(
    dedupe.size,
    4,
    "only the fresh id grows the store; duplicates refresh recency, not size",
  );
  assert.deepEqual(dedupe.stats(), {
    size: 4,
    hits: 2,
    misses: 4,
    evictions: 0,
  });
});
