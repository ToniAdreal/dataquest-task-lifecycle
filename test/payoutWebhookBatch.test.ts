import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  buildPayoutWebhooks,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Batch payout webhook building (backlog #221): the dataquest-side
 * peer of escrow's buildSettlementReports (#209).
 *
 * Rules under test:
 *  - one result per input, in input order, as { taskId, webhook } or
 *    { taskId, error } — a non-PAID task fails only itself
 *  - a bad item first never blocks later items
 *  - every task gets a DISTINCT eventId (the batch shares the `now`
 *    timestamp and the eventId generation strategy, never the value),
 *    and each built webhook verifies under the batch secret
 *  - call-level configuration errors (empty secret, invalid shared
 *    `now`, non-function eventIdFactory, non-array tasks) throw for
 *    the whole batch instead of being recorded per task
 *  - a one-item batch is equivalent to the single build
 */

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(
  id: string,
  opts: { payoutRef?: string; payoutAmount?: number } = {},
): TaskLifecycle {
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
    ...(opts.payoutAmount !== undefined
      ? { payoutAmount: opts.payoutAmount }
      : {}),
  });
  assert.equal(t.state, "PAID");
  return t;
}

function toOpen(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(t.state, "OPEN");
  return t;
}

function toPayoutPending(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  assert.equal(t.state, "PAYOUT_PENDING");
  return t;
}

const NOW = new Date("2026-10-12T08:00:00.000Z");
const SECRET = "batch-secret";

test("mixed batch: per-task results are correct and input order is preserved", () => {
  const paid = toPaid("task-paid", { payoutRef: "xfer-1", payoutAmount: 42 });
  const open = toOpen("task-open");
  const pending = toPayoutPending("task-pending");
  const paid2 = toPaid("task-paid-2");

  const results = buildPayoutWebhooks([paid, open, pending, paid2], SECRET, {
    now: NOW,
  });

  assert.equal(results.length, 4);
  assert.deepEqual(
    results.map((r) => r.taskId),
    ["task-paid", "task-open", "task-pending", "task-paid-2"],
  );
  // PAID entries carry a webhook and no error.
  assert.ok(results[0].webhook);
  assert.equal(results[0].error, undefined);
  assert.equal(results[0].webhook.payload.taskId, "task-paid");
  assert.equal(results[0].webhook.payload.payoutRef, "xfer-1");
  assert.ok(results[3].webhook);
  // Non-PAID entries carry the single build's error and no webhook.
  assert.equal(results[1].webhook, undefined);
  assert.match(results[1].error ?? "", /task task-open is in state OPEN/);
  assert.equal(results[2].webhook, undefined);
  assert.match(
    results[2].error ?? "",
    /task task-pending is in state PAYOUT_PENDING/,
  );
});

test("a bad item first does not block later items", () => {
  const results = buildPayoutWebhooks(
    [toOpen("task-bad-first"), toPaid("task-good-1"), toPaid("task-good-2")],
    SECRET,
    { now: NOW },
  );
  assert.equal(results[0].webhook, undefined);
  assert.ok(results[0].error);
  assert.ok(results[1].webhook, "second item still built");
  assert.ok(results[2].webhook, "third item still built");
});

test("empty input returns an empty result array", () => {
  assert.deepEqual(buildPayoutWebhooks([], SECRET), []);
});

test("each task gets a distinct eventId and every webhook verifies; `now` is shared", () => {
  const tasks = [toPaid("task-a"), toPaid("task-b"), toPaid("task-c")];
  const results = buildPayoutWebhooks(tasks, SECRET, { now: NOW });

  const eventIds = results.map((r) => r.webhook?.payload.eventId);
  assert.equal(new Set(eventIds).size, 3, "eventIds are pairwise distinct");
  for (const r of results) {
    assert.ok(r.webhook);
    assert.equal(r.webhook.payload.at, NOW.toISOString(), "shared `at`");
    assert.equal(
      verifyPayoutWebhook(
        JSON.stringify(r.webhook.payload),
        r.webhook.signature,
        SECRET,
      ),
      true,
    );
    assert.equal(
      verifyPayoutWebhook(
        JSON.stringify(r.webhook.payload),
        r.webhook.signature,
        "wrong-secret",
      ),
      false,
    );
  }
});

test("an injected eventIdFactory is called once per task, in order", () => {
  let n = 0;
  const results = buildPayoutWebhooks(
    [toPaid("task-f1"), toPaid("task-f2")],
    SECRET,
    { now: NOW, eventIdFactory: () => `evt-${++n}` },
  );
  assert.deepEqual(
    results.map((r) => r.webhook?.payload.eventId),
    ["evt-1", "evt-2"],
  );
  assert.equal(n, 2);
  for (const r of results) {
    assert.ok(r.webhook);
    assert.equal(
      verifyPayoutWebhook(r.webhook.payload, r.webhook.signature, SECRET),
      true,
    );
  }
});

test("a factory returning an empty eventId fails only that task", () => {
  let n = 0;
  const results = buildPayoutWebhooks(
    [toPaid("task-bad-id"), toPaid("task-good-id")],
    SECRET,
    {
      now: NOW,
      eventIdFactory: () => (++n === 1 ? "" : `evt-${n}`),
    },
  );
  assert.equal(results[0].webhook, undefined);
  assert.match(results[0].error ?? "", /'eventId' must be a non-empty string/);
  assert.equal(results[1].webhook?.payload.eventId, "evt-2");
});

test("empty secret throws for the whole batch, never per task", () => {
  const tasks = [toPaid("task-s1"), toPaid("task-s2")];
  assert.throws(
    () => buildPayoutWebhooks(tasks, ""),
    /signing secret must not be empty/,
  );
  assert.throws(
    () => buildPayoutWebhooks(tasks, Buffer.alloc(0)),
    /signing secret must not be empty/,
  );
  // Even an empty batch validates the secret first: configuration
  // errors are caller bugs, not per-task outcomes.
  assert.throws(
    () => buildPayoutWebhooks([], ""),
    /signing secret must not be empty/,
  );
});

test("invalid shared options throw for the whole batch", () => {
  const tasks = [toPaid("task-o1")];
  assert.throws(
    () => buildPayoutWebhooks(tasks, SECRET, { now: "not-a-date" }),
    /cannot build payout webhooks: invalid 'now' timestamp/,
  );
  assert.throws(
    () =>
      buildPayoutWebhooks(tasks, SECRET, {
        eventIdFactory: "evt" as unknown as () => string,
      }),
    /cannot build payout webhooks: 'eventIdFactory' must be a function/,
  );
  assert.throws(
    () =>
      buildPayoutWebhooks(
        "nope" as unknown as TaskLifecycle[],
        SECRET,
      ),
    /cannot build payout webhooks: tasks must be an array/,
  );
});

test("a one-item batch equals the single build under the same inputs", () => {
  const task = toPaid("task-solo", { payoutRef: "xfer-9", payoutAmount: 7 });
  const [result] = buildPayoutWebhooks([task], SECRET, {
    now: NOW,
    eventIdFactory: () => "evt-solo",
  });
  const single = buildPayoutWebhook(task, SECRET, {
    now: NOW,
    eventId: "evt-solo",
  });
  assert.deepEqual(result.webhook, single);
});

test("building a batch does not mutate the tasks or the input list", () => {
  const paid = toPaid("task-pure");
  const open = toOpen("task-pure-open");
  const tasks = [paid, open];
  const historyLengths = tasks.map((t) => t.history.length);
  buildPayoutWebhooks(tasks, SECRET, { now: NOW });
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((t) => t.history.length),
    historyLengths,
  );
  assert.equal(paid.state, "PAID");
  assert.equal(open.state, "OPEN");
});
