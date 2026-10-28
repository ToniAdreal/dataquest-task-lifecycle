import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/taskLifecycle.js";

/**
 * RESUBMIT budget (maxResubmits) x payout-reference gate (requirePayoutRef).
 *
 * Each switch is covered on its own (resubmitBudget.test.ts,
 * requirePayoutRef.test.ts), but no test combined them: a task that has
 * spent its one RESUBMIT and then reaches payout must still have its
 * payout gate enforced, and a payout rejected by that gate must not
 * consume (or reset) the RESUBMIT budget — the budget is derived from
 * the append-only history, so a rejected dispatch appends nothing.
 */

const TO_REJECTED: Array<"PUBLISH" | "ACCEPT" | "START_CAPTURE" | "SUBMIT" | "BEGIN_REVIEW" | "REJECT"> = [
  "PUBLISH",
  "ACCEPT",
  "START_CAPTURE",
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
];

/** Drive a fresh task to REJECTED. */
function toRejected(task: TaskLifecycle): void {
  for (const event of TO_REJECTED) task.dispatch(event);
}

/**
 * One RESUBMIT round, then drive the resubmitted capture all the way to
 * payout: REJECTED -> CAPTURING -> APPROVED -> PAYOUT_PENDING.
 */
function resubmitToPayoutPending(task: TaskLifecycle): void {
  task.dispatch("RESUBMIT"); // REJECTED -> CAPTURING
  task.dispatch("SUBMIT");
  task.dispatch("BEGIN_REVIEW");
  task.dispatch("APPROVE");
  task.dispatch("REQUEST_PAYOUT");
}

function resubmitCount(task: TaskLifecycle): number {
  return task.history.filter((e) => e.event === "RESUBMIT").length;
}

const PAYOUT_REF_ERROR =
  "payout reference required: PAYOUT_COMPLETE must carry a non-empty payoutRef when requirePayoutRef is enabled";

describe("resubmit budget x payoutRef gate", () => {
  it("after one RESUBMIT round, payout without a ref is rejected and the budget is untouched", () => {
    const task = new TaskLifecycle("rp-1", {
      maxResubmits: 1,
      requirePayoutRef: true,
    });
    toRejected(task);
    resubmitToPayoutPending(task);
    assert.equal(task.state, "PAYOUT_PENDING");
    assert.equal(resubmitCount(task), 1);

    const before = task.history.length;
    const lastSeq = task.history[before - 1].seq;
    assert.throws(
      () => task.dispatch("PAYOUT_COMPLETE"),
      (err: unknown) => err instanceof Error && err.message === PAYOUT_REF_ERROR,
      "payout without a ref must be rejected even after a RESUBMIT round",
    );
    // Failed dispatch leaves no trace: no history entry, no seq gap, and
    // the RESUBMIT budget (derived from history) is unchanged.
    assert.equal(task.history.length, before);
    assert.equal(task.history[before - 1].seq, lastSeq);
    assert.equal(task.state, "PAYOUT_PENDING");
    assert.equal(resubmitCount(task), 1);

    // The corrected payout still goes through.
    task.dispatch("PAYOUT_COMPLETE", { payoutRef: "xfer-resubmit-1" });
    assert.equal(task.state, "PAID");
    assert.equal(task.history.length, before + 1);
    assert.equal(task.history[before].seq, lastSeq + 1);
    assert.equal(task.history[before].payoutRef, "xfer-resubmit-1");
    assert.equal(resubmitCount(task), 1);
  });

  it("a rejected payout consumes no idempotency key: retry with the same key and a ref passes", () => {
    const task = new TaskLifecycle("rp-2", {
      maxResubmits: 1,
      requirePayoutRef: true,
    });
    toRejected(task);
    resubmitToPayoutPending(task);
    const before = task.history.length;
    assert.throws(
      () =>
        task.dispatch("PAYOUT_COMPLETE", { idempotencyKey: "k-pay-resubmit" }),
      (err: unknown) => err instanceof Error && err.message === PAYOUT_REF_ERROR,
    );
    assert.equal(task.history.length, before);
    task.dispatch("PAYOUT_COMPLETE", {
      payoutRef: "xfer-resubmit-2",
      idempotencyKey: "k-pay-resubmit",
    });
    assert.equal(task.state, "PAID");
    assert.equal(task.history.length, before + 1);
    assert.equal(resubmitCount(task), 1);
  });

  it("the budget is still exhausted after the RESUBMIT round when the payout gate is also on", () => {
    const task = new TaskLifecycle("rp-3", {
      maxResubmits: 1,
      requirePayoutRef: true,
    });
    toRejected(task);
    task.dispatch("RESUBMIT");
    task.dispatch("SUBMIT");
    task.dispatch("BEGIN_REVIEW");
    task.dispatch("REJECT"); // back at REJECTED, budget spent
    const before = task.history.length;
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "resubmit budget exhausted: 1 of 1 RESUBMITs already used",
      "the payout gate must not reset the RESUBMIT budget",
    );
    assert.equal(task.history.length, before);
    assert.equal(task.state, "REJECTED");
  });

  it("control: the same RESUBMIT round without requirePayoutRef pays out without a ref", () => {
    const task = new TaskLifecycle("rp-4", { maxResubmits: 1 });
    toRejected(task);
    resubmitToPayoutPending(task);
    assert.equal(resubmitCount(task), 1);
    task.dispatch("PAYOUT_COMPLETE");
    assert.equal(task.state, "PAID");
  });

  it("fromHistory re-attaches both switches: budget derived from the log, gate enforced at payout", () => {
    const task = new TaskLifecycle("rp-5", {
      maxResubmits: 1,
      requirePayoutRef: true,
    });
    toRejected(task);
    resubmitToPayoutPending(task);
    const log = JSON.parse(JSON.stringify(task.history));

    const revived = TaskLifecycle.fromHistory("rp-5", log, {
      maxResubmits: 1,
      requirePayoutRef: true,
    });
    assert.equal(revived.state, "PAYOUT_PENDING");
    assert.equal(resubmitCount(revived), 1);
    const before = revived.history.length;
    assert.throws(
      () => revived.dispatch("PAYOUT_COMPLETE"),
      (err: unknown) => err instanceof Error && err.message === PAYOUT_REF_ERROR,
    );
    assert.equal(revived.history.length, before);
    assert.equal(resubmitCount(revived), 1);
    revived.dispatch("PAYOUT_COMPLETE", { payoutRef: "xfer-resubmit-5" });
    assert.equal(revived.state, "PAID");
  });
});
