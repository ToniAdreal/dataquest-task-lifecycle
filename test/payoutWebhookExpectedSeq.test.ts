import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Payout webhook x `expectedSeq` optimistic-concurrency guard
 * (backlog #813).
 *
 * `expectedSeq` and payout webhooks only ever met in `demo.test.ts`:
 * no dedicated file pinned what happens when a concurrent writer
 * submits PAYOUT_COMPLETE with a stale sequence number. The danger
 * the combination guards against is a settlement announced from a
 * superseded view of the task — a webhook built for a payout that
 * the guard refused, or a payout that silently landed anyway.
 *
 * What the implementation actually says (read before writing, not
 * assumed): `dispatch` checks `expectedSeq` before every other
 * validation and before any mutation, so a mismatch throws
 * `dispatch conflict: expected seq <n> but task is at seq <m>` and
 * consumes no idempotency key; `buildPayoutWebhook` refuses any
 * task whose state is not PAID. The testable form of the backlog
 * clause is therefore: stale (or ahead) seq + PAYOUT_COMPLETE
 * leaves the task in PAYOUT_PENDING with its history untouched,
 * and `buildPayoutWebhook` on that task throws the only-PAID
 * error — no webhook is produced from the refused settlement.
 * A retry with the fresh seq then settles for real, and the
 * webhook built from that settlement verifies.
 *
 * Rules pinned here:
 *  - a stale `expectedSeq` PAYOUT_COMPLETE throws a dispatch
 *    conflict, leaves state PAYOUT_PENDING and history untouched
 *    (length and last entry), and no payout webhook can be built
 *  - an ahead `expectedSeq` conflicts the same way — the guard is
 *    an equality check, not a "not older than" check
 *  - a retry with the fresh seq reaches PAID, and the webhook
 *    built from it carries the settlement's payoutRef /
 *    payoutAmount and the ACCEPT quote, and verifies; a tampered
 *    body and a wrong secret both fail (so the pass is not vacuous)
 *  - a conflict consumes no idempotency key: the same key retries
 *    successfully with the fresh seq, and only then is it consumed
 *    (a bare retry afterwards is a no-op, with no history gap)
 */

const SECRET = "whsec_test_payout_expected_seq_20261102";
const NOW = new Date("2026-11-02T00:00:00.000Z");
const EVENT_ID = "evt-expected-seq-1";

/** Drive a task from DRAFT to PAYOUT_PENDING (one step short of PAID). */
function payoutPendingTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 4500 });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  assert.equal(t.state, "PAYOUT_PENDING");
  assert.equal(t.history.length, 7);
  assert.equal(t.history[6].seq, 7);
  assert.equal(t.history[6].event, "REQUEST_PAYOUT");
  return t;
}

function payoutCompleteOptions(extra: Record<string, unknown> = {}) {
  return {
    actor: "system",
    payoutRef: "xfer-expected-seq-1",
    payoutAmount: 4200,
    ...extra,
  };
}

describe("payout webhook x expectedSeq", () => {
  it("stale expectedSeq blocks settlement and no webhook can be built", () => {
    const task = payoutPendingTask("task-expected-seq-1");
    assert.throws(
      () =>
        task.dispatch("PAYOUT_COMPLETE", {
          ...payoutCompleteOptions(),
          expectedSeq: 6,
        }),
      /dispatch conflict: expected seq 6 but task is at seq 7/,
    );
    assert.equal(task.state, "PAYOUT_PENDING");
    assert.equal(task.history.length, 7);
    assert.equal(task.history[6].event, "REQUEST_PAYOUT");
    assert.deepEqual(
      task.history.map((e) => e.seq),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.throws(
      () =>
        buildPayoutWebhook(task, SECRET, {
          eventId: EVENT_ID,
          now: NOW,
        }),
      /only PAID tasks have a completed settlement/,
    );
  });

  it("an ahead expectedSeq conflicts the same way, with no webhook", () => {
    const task = payoutPendingTask("task-expected-seq-2");
    assert.throws(
      () =>
        task.dispatch("PAYOUT_COMPLETE", {
          ...payoutCompleteOptions(),
          expectedSeq: 99,
        }),
      /dispatch conflict: expected seq 99 but task is at seq 7/,
    );
    assert.equal(task.state, "PAYOUT_PENDING");
    assert.equal(task.history.length, 7);
    assert.throws(
      () =>
        buildPayoutWebhook(task, SECRET, {
          eventId: EVENT_ID,
          now: NOW,
        }),
      /only PAID tasks have a completed settlement/,
    );
  });

  it("fresh-seq retry settles to PAID and its webhook verifies", () => {
    const task = payoutPendingTask("task-expected-seq-3");
    assert.throws(
      () =>
        task.dispatch("PAYOUT_COMPLETE", {
          ...payoutCompleteOptions(),
          expectedSeq: 6,
        }),
      /dispatch conflict: expected seq 6 but task is at seq 7/,
    );
    assert.equal(
      task.dispatch("PAYOUT_COMPLETE", {
        ...payoutCompleteOptions(),
        expectedSeq: 7,
      }),
      "PAID",
    );
    assert.equal(task.history.length, 8);
    assert.deepEqual(
      task.history.map((e) => e.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(task.history[7].event, "PAYOUT_COMPLETE");
    assert.equal(task.history[7].payoutRef, "xfer-expected-seq-1");
    assert.equal(task.history[7].payoutAmount, 4200);

    const webhook = buildPayoutWebhook(task, SECRET, {
      eventId: EVENT_ID,
      now: NOW,
    });
    assert.equal(webhook.payload.event, "PAYOUT_COMPLETE");
    assert.equal(webhook.payload.taskId, "task-expected-seq-3");
    assert.equal(webhook.payload.payoutRef, "xfer-expected-seq-1");
    assert.equal(webhook.payload.payoutAmount, 4200);
    assert.equal(webhook.payload.quotedAmount, 4500);
    const raw = JSON.stringify(webhook.payload);
    assert.equal(verifyPayoutWebhook(raw, webhook.signature, SECRET), true);
    const tampered = JSON.stringify({
      ...webhook.payload,
      payoutAmount: 4201,
    });
    assert.equal(verifyPayoutWebhook(tampered, webhook.signature, SECRET), false);
    assert.equal(
      verifyPayoutWebhook(raw, webhook.signature, "whsec_wrong_secret"),
      false,
    );
  });

  it("a conflict consumes no idempotency key: the same key retries successfully", () => {
    const task = payoutPendingTask("task-expected-seq-4");
    assert.throws(
      () =>
        task.dispatch("PAYOUT_COMPLETE", {
          ...payoutCompleteOptions(),
          idempotencyKey: "payout-1",
          expectedSeq: 6,
        }),
      /dispatch conflict: expected seq 6 but task is at seq 7/,
    );
    assert.equal(task.state, "PAYOUT_PENDING");
    assert.equal(task.history.length, 7);
    assert.deepEqual(task.toJSON().idempotencyKeys, undefined);
    assert.equal(
      task.dispatch("PAYOUT_COMPLETE", {
        ...payoutCompleteOptions(),
        idempotencyKey: "payout-1",
        expectedSeq: 7,
      }),
      "PAID",
    );
    assert.equal(task.history.length, 8);
    assert.deepEqual(task.toJSON().idempotencyKeys, ["payout-1"]);
    // Only now is the key consumed: a bare retry is a no-op.
    assert.equal(
      task.dispatch("PAYOUT_COMPLETE", { idempotencyKey: "payout-1" }),
      "PAID",
    );
    assert.equal(task.history.length, 8);
  });
});
