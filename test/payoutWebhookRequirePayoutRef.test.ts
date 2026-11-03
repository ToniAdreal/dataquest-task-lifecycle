import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Opt-in `requirePayoutRef` gate (backlog #856): the webhook build side
 * previously had no counterpart to the dispatch-side `requirePayoutRef`
 * door, so a caller that wanted "no reference, no notification" could
 * only filter after the fact. Now the gate is opt-in on both the
 * single build and the batch path.
 *
 * Rules under test:
 * - gate on + PAYOUT_COMPLETE entry without payoutRef -> build throws
 *   a clear error (no reference-less notification is produced)
 * - gate on + entry with payoutRef -> builds normally, ref carried and
 *   signature verifies
 * - gate off (default, or explicit false) -> ref-less PAID tasks keep
 *   building exactly as before (advisory omission rule untouched)
 * - gate checks the reference only: a missing payoutAmount never
 *   blocks, and the gate never masks the non-PAID state error
 * - batch path: a gated task records a per-task error and never
 *   blocks the rest of the batch, in input order
 */

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(id: string, opts: { payoutRef?: string; payoutAmount?: number } = {}): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    ...(opts.payoutRef !== undefined ? { payoutRef: opts.payoutRef } : {}),
    ...(opts.payoutAmount !== undefined ? { payoutAmount: opts.payoutAmount } : {}),
  });
  assert.equal(t.state, "PAID");
  return t;
}

/** A task that has left DRAFT but is not PAID. */
function toOpen(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(t.state, "OPEN");
  return t;
}

test("gate on: ref-less PAID task throws, no notification produced", () => {
  const task = toPaid("task-no-ref");
  assert.throws(
    () => buildPayoutWebhook(task, "s3cr3t", { requirePayoutRef: true }),
    /cannot build payout webhook: task task-no-ref has no payoutRef/,
  );
});

test("gate on: task with a payoutRef builds and verifies", () => {
  const task = toPaid("task-with-ref", { payoutRef: "xfer-77", payoutAmount: 5000 });
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t", {
    requirePayoutRef: true,
  });
  assert.equal(payload.payoutRef, "xfer-77");
  assert.equal(payload.payoutAmount, 5000);
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
});

test("gate off (default): ref-less PAID task still builds, ref omitted", () => {
  const task = toPaid("task-legacy");
  const { payload, signature } = buildPayoutWebhook(task, "s3cr3t");
  assert.equal("payoutRef" in payload, false);
  assert.equal(verifyPayoutWebhook(JSON.stringify(payload), signature, "s3cr3t"), true);
});

test("gate explicitly false: ref-less PAID task still builds", () => {
  const task = toPaid("task-gate-false");
  const { payload } = buildPayoutWebhook(task, "s3cr3t", { requirePayoutRef: false });
  assert.equal("payoutRef" in payload, false);
});

test("gate checks the reference only: amount without ref still throws", () => {
  const task = toPaid("task-amount-only", { payoutAmount: 2500 });
  assert.throws(
    () => buildPayoutWebhook(task, "s3cr3t", { requirePayoutRef: true }),
    /has no payoutRef/,
  );
});

test("gate never masks the non-PAID state error", () => {
  const task = toOpen("task-open");
  assert.throws(
    () => buildPayoutWebhook(task, "s3cr3t", { requirePayoutRef: true }),
    /only PAID tasks have a completed settlement/,
  );
});

test("batch gate on: gated task errors per task, rest build, order kept", () => {
  const tasks = [
    toPaid("batch-no-ref"),
    toPaid("batch-with-ref", { payoutRef: "xfer-1" }),
    toOpen("batch-open"),
    toPaid("batch-second-ref", { payoutRef: "xfer-2" }),
  ];
  const results = buildPayoutWebhooks(tasks, "s3cr3t", {
    requirePayoutRef: true,
    eventIdFactory: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
  });
  assert.deepEqual(
    results.map((r) => r.taskId),
    ["batch-no-ref", "batch-with-ref", "batch-open", "batch-second-ref"],
  );
  assert.match(results[0].error ?? "", /has no payoutRef/);
  assert.equal(results[0].webhook, undefined);
  assert.equal(results[1].webhook?.payload.payoutRef, "xfer-1");
  assert.match(results[2].error ?? "", /only PAID tasks/);
  assert.equal(results[3].webhook?.payload.payoutRef, "xfer-2");
});

test("batch gate off: all PAID tasks build, ref-less included", () => {
  const tasks = [toPaid("batch-off-no-ref"), toPaid("batch-off-ref", { payoutRef: "xfer-9" })];
  const results = buildPayoutWebhooks(tasks, "s3cr3t");
  assert.equal(results[0].webhook?.payload.taskId, "batch-off-no-ref");
  assert.equal("payoutRef" in (results[0].webhook?.payload ?? {}), false);
  assert.equal(results[1].webhook?.payload.payoutRef, "xfer-9");
});
